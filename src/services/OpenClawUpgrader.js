/**
 * OpenClaw 平台升级器。
 *
 * 实现设计文档 §9.3:
 *   维护模式 → backup → replace → systemctl restart → 健康轮询 → smoke → 退出维护 → finalize
 *
 * 与 Skill 升级的本质区别：
 * - 需要重启服务（systemctl restart openclaw）
 * - 需要进入/退出维护模式
 * - 备份/替换 npm 全局包目录
 * - 配置合并（用户值优先）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getDb } = require('../database/connection');
const config = require('../config');
const maintenance = require('./MaintenanceMode');
const { applyOwnership } = require('./Ownership');

class OpenClawUpgrader {
  constructor(zipBuffer, opts = {}) {
    this.zip = new AdmZip(zipBuffer);
    this.manifest = this._readManifest();
    this.db = opts.db || getDb();
    this.cfg = opts.config || config;
    this._backupPath = null;
    this._wasMaintenance = false;
  }

  // ──────────────────────────────────────────────────────────
  // Upgrader 接口
  // ──────────────────────────────────────────────────────────

  preCheck(ctx) {
    // 1. 磁盘空间（>500MB）
    this._checkDiskSpace(500 * 1024 * 1024);

    // 2. 验证 OpenClaw 安装目录
    const targetPath = this.cfg.openclawRoot;
    if (!fs.existsSync(targetPath)) {
      throw new Error(`OpenClaw 安装目录不存在: ${targetPath}`);
    }

    // 3. 验证受控重启入口（Linux 生产环境）
    this._checkRestartHelper();

    // 4. 验证组件已注册
    const component = this.db.prepare(
      "SELECT * FROM components WHERE name = 'openclaw'"
    ).get();
    if (!component) {
      throw new Error('OpenClaw 组件未在数据库中注册');
    }

    ctx.state.targetPath = targetPath;
    ctx.state.component = component;
    ctx.state.oldVersion = component.version;

    return { message: `预检查通过 (OpenClaw ${component.version}, ${targetPath})` };
  }

  backup(ctx) {
    const targetPath = ctx.state.targetPath;
    const version = ctx.state.component.version;
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDirName = `openclaw_${version}_${dateStr}`;
    const backupRoot = path.join(this.cfg.backupRoot, 'openclaw');
    const backupPath = path.join(backupRoot, backupDirName);

    fs.mkdirSync(backupRoot, { recursive: true });

    // 备份整个 openclaw 目录
    this._copyDir(targetPath, backupPath);

    // 备份配置文件
    const configBackups = [];
    const configDir = path.join(path.dirname(targetPath), '..', '.openclaw');
    const configFiles = ['config.yaml', 'openclaw.json'];
    for (const f of configFiles) {
      const src = path.join(configDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupPath, f));
        configBackups.push(f);
      }
    }

    const sizeBytes = this._dirSize(backupPath);

    this.db.prepare(`
      INSERT INTO backups (component, version, backup_path, size_bytes, task_id)
      VALUES ('openclaw', ?, ?, ?, ?)
    `).run(version, backupPath, sizeBytes, ctx.task.id);

    this._backupPath = backupPath;
    ctx.state.backupPath = backupPath;

    return {
      message: `备份完成 (${backupPath}, ${this._formatSize(sizeBytes)}, 配置: ${configBackups.join(', ') || '无'})`,
      backupPath,
      sizeBytes,
    };
  }

  replace(ctx) {
    const targetPath = ctx.state.targetPath;

    // 进入维护模式
    maintenance.enter('OpenClaw 平台升级中');
    this._wasMaintenance = true;

    // 解压新版本
    const distEntries = this.zip.getEntries().filter((e) =>
      e.entryName.startsWith('dist/') && !e.isDirectory
    );

    if (distEntries.length === 0) {
      // 回退维护模式
      maintenance.exit();
      this._wasMaintenance = false;
      throw new Error('升级包中未找到 dist/ 目录');
    }

    // 原子替换
    const newPath = targetPath + '.new';
    const oldPath = targetPath + '.old';
    this._removeDir(newPath);
    this._removeDir(oldPath);

    // 复制当前 → .new
    this._copyDir(targetPath, newPath);

    // 用包内文件覆盖 .new
    for (const entry of this.zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName;

      // 跳过 manifest
      if (name === 'upgrade-manifest.json') continue;

      // 处理 dist/ → 直接映射
      let destRel = name;
      if (destRel.startsWith('dist/')) {
        destRel = destRel.replace(/^dist\//, '');
      }

      const destPath = path.join(newPath, destRel);

      // config/ 目录下的文件做合并，不直接覆盖
      if (name.startsWith('config/')) {
        this._mergeConfig(destPath, entry.getData().toString('utf8'));
        continue;
      }

      // package.json 直接覆盖
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
    }

    // 原子交换
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, oldPath);
    }
    try {
      fs.renameSync(newPath, targetPath);
      this._removeDir(oldPath);
    } catch (err) {
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, targetPath);
      }
      maintenance.exit();
      this._wasMaintenance = false;
      throw new Error(`原子替换失败: ${err.message}`);
    }

    // npm install（如 package.json 有变化）
    this._tryNpmInstall(targetPath);
    applyOwnership(targetPath, this.cfg.runtimeOwner, this.cfg.runtimeGroup);

    return { message: `文件替换完成 (${distEntries.length} 个文件)` };
  }

  reload(ctx) {
    try {
      this._restartOpenClaw();
    } catch (err) {
      throw new Error(`OpenClaw Gateway 重启失败: ${err.message}`);
    }

    return { message: 'OpenClaw Gateway 受控重启已执行' };
  }

  smokeTest(ctx) {
    // 轮询健康检查（最多 60s，每 2s 一次）
    const maxWaitMs = this.cfg.openclawRestartTimeoutMs || 60000;
    const intervalMs = 2000;
    const startTime = Date.now();

    let lastError = null;
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const ok = this._httpHealthCheck();
        if (ok) {
          return { message: `健康检查通过 (${Date.now() - startTime}ms)` };
        }
      } catch (err) {
        lastError = err.message;
      }
      this._sleepSync(intervalMs);
    }

    throw new Error(`健康检查超时 (${maxWaitMs}ms): ${lastError || '无响应'}`);
  }

  finalize(ctx) {
    const newVersion = this.manifest.version;

    this.db.prepare(`
      UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
      WHERE name = 'openclaw'
    `).run(newVersion);

    // 退出维护模式
    if (this._wasMaintenance) {
      maintenance.exit();
      this._wasMaintenance = false;
    }

    return { message: `OpenClaw 版本已更新为 ${newVersion}` };
  }

  rollback(ctx) {
    const targetPath = ctx.state.targetPath || this.cfg.openclawRoot;
    const backupPath = ctx.state.backupPath || this._backupPath;

    // 退出维护模式（如果还在）
    if (this._wasMaintenance) {
      maintenance.exit();
      this._wasMaintenance = false;
    }

    if (!backupPath || !fs.existsSync(backupPath)) {
      // 即使没有备份，也要尝试保持服务运行
      try { this._restartOpenClaw(); } catch (_) {}
      throw new Error('回滚失败: 备份目录不存在或未执行备份步骤');
    }

    // 恢复 openclaw 目录
    const brokenPath = targetPath + '.broken';
    this._removeDir(brokenPath);

    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, brokenPath);
    }

    try {
      this._copyDir(backupPath, targetPath);
      this._removeDir(brokenPath);
    } catch (err) {
      if (fs.existsSync(brokenPath)) {
        fs.renameSync(brokenPath, targetPath);
      }
      throw new Error(`回滚恢复失败: ${err.message}`);
    }
    applyOwnership(targetPath, this.cfg.runtimeOwner, this.cfg.runtimeGroup);

    // 恢复配置文件
    const configDir = path.join(path.dirname(targetPath), '..', '.openclaw');
    for (const f of ['config.yaml', 'openclaw.json']) {
      const backupFile = path.join(backupPath, f);
      if (fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, path.join(configDir, f));
      }
    }

    // 重启
    try {
      this._restartOpenClaw();
    } catch (err) {
      throw new Error(`回滚后重启失败: ${err.message}`);
    }

    // 等待健康检查
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      try {
        if (this._httpHealthCheck()) break;
      } catch (_) {}
      this._sleepSync(2000);
    }

    // 恢复 DB 版本
    const component = ctx.state.component;
    if (component) {
      this.db.prepare(`
        UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
        WHERE name = 'openclaw'
      `).run(component.version);
    }

    return { message: `已回滚到备份 ${backupPath}` };
  }

  // ──────────────────────────────────────────────────────────
  // 内部辅助
  // ──────────────────────────────────────────────────────────

  _readManifest() {
    const entry = this.zip.getEntry('upgrade-manifest.json');
    if (!entry) throw new Error('升级包缺少 upgrade-manifest.json');
    return JSON.parse(entry.getData().toString('utf8'));
  }

  _checkDiskSpace(minBytes) {
    try {
      const dfOutput = execSync(
        `df -k "${this.cfg.openclawRoot}" | tail -1`,
        { encoding: 'utf8', timeout: 5000 },
      );
      const parts = dfOutput.trim().split(/\s+/);
      const availableKb = parseInt(parts[3], 10);
      if (availableKb && availableKb * 1024 < minBytes) {
        throw new Error(`磁盘空间不足: ${this._formatSize(availableKb * 1024)} < ${this._formatSize(minBytes)}`);
      }
    } catch (err) {
      if (err.message.includes('磁盘空间不足')) throw err;
    }
  }

  _checkRestartHelper() {
    if (process.platform !== 'linux') return;
    const helper = this.cfg.openclawRestartHelper;
    if (!helper || !path.isAbsolute(helper) || !fs.existsSync(helper)) {
      throw new Error(`OpenClaw 受控重启入口不存在: ${helper || '未配置'}`);
    }
    fs.accessSync(helper, fs.constants.X_OK);
  }

  _restartOpenClaw() {
    const helper = this.cfg.openclawRestartHelper;
    if (!helper || !path.isAbsolute(helper)) {
      throw new Error('OpenClaw 受控重启入口未配置');
    }
    execFileSync(helper, [], { encoding: 'utf8', timeout: 30000 });
  }

  _httpHealthCheck() {
    const result = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', '5', this.cfg.openclawHealthUrl,
    ], { encoding: 'utf8', timeout: 10000 }).trim();
    return result === '200';
  }

  /**
   * 配置合并：保留用户已有键，只追加新键。
   */
  _mergeConfig(configPath, newContent) {
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });

    // 如果用户配置不存在 → 直接写新配置
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, newContent);
      return;
    }

    // 对于 YAML 和 JSON 做不同处理
    const ext = path.extname(configPath);
    if (ext === '.json') {
      try {
        const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const newConfig = JSON.parse(newContent);
        // 深度合并：用户值优先
        const merged = deepMerge(newConfig, userConfig);
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
      } catch (_) {
        // JSON 解析失败，保留用户原配置
      }
    }
    // YAML 和纯文本：保留用户配置，新配置写入 .new 文件供参考
    if (ext === '.yaml' || ext === '.yml') {
      fs.writeFileSync(configPath + '.new', newContent);
    }
  }

  _tryNpmInstall(dirPath) {
    const pkgPath = path.join(dirPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    try {
      execSync('npm install --production', { cwd: dirPath, encoding: 'utf8', timeout: 120000 });
    } catch (_) {
      // npm install 失败不阻止升级（依赖可能已预装）
    }
  }

  // ── 文件操作 ──────────────────────────────────────────

  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) this._copyDir(s, d);
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
      else fs.copyFileSync(s, d);
    }
  }

  _removeDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  _dirSize(dirPath) {
    let size = 0;
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dirPath, entry.name);
      size += entry.isDirectory() ? this._dirSize(p) : fs.statSync(p).size;
    }
    return size;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  _sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait */ }
  }
}

/**
 * 深度合并：defaults 提供默认值，overrides 的值优先。
 */
function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (
      typeof overrides[key] === 'object' &&
      overrides[key] !== null &&
      !Array.isArray(overrides[key]) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

module.exports = { OpenClawUpgrader };
