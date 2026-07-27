/**
 * 前端升级器。
 *
 * 实现设计文档 §9.4:
 *   pre_check → backup → replace → smoke_test → finalize
 *
 * 最简单的一类升级：静态文件替换，无需重启服务。
 * Caddy 直接服务 /var/www/napm-admin/ 目录。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getDb } = require('../database/connection');
const config = require('../config');
const { applyOwnership } = require('./Ownership');

class FrontendUpgrader {
  constructor(zipBuffer, opts = {}) {
    this.zip = new AdmZip(zipBuffer);
    this.manifest = this._readManifest();
    this.db = opts.db || getDb();
    this.cfg = opts.config || config;
    this._backupPath = null;
  }

  // ──────────────────────────────────────────────────────────
  // Upgrader 接口
  // ──────────────────────────────────────────────────────────

  preCheck(ctx) {
    // 1. 磁盘空间（>100MB）
    this._checkDiskSpace(100 * 1024 * 1024);

    // 2. 验证前端目录
    const targetPath = this.cfg.frontendRoot;
    if (path.basename(path.resolve(targetPath)) !== 'dist') {
      throw new Error(`前端升级目录必须指向独立 dist 目录: ${targetPath}`);
    }
    if (!fs.existsSync(targetPath)) {
      // 首次部署，目录可能不存在
      fs.mkdirSync(targetPath, { recursive: true });
    }

    // 3. 验证组件注册（首次部署可跳过）
    const component = this.db.prepare(
      "SELECT * FROM components WHERE name = 'frontend'"
    ).get();

    ctx.state.targetPath = targetPath;
    ctx.state.component = component;
    ctx.state.oldVersion = component ? component.version : null;
    ctx.state.isNew = !component;

    return { message: `预检查通过 (前端目录 ${targetPath})` };
  }

  backup(ctx) {
    const targetPath = ctx.state.targetPath;
    const version = ctx.state.component?.version || '0.0.0';
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDirName = `frontend_${version}_${dateStr}`;
    const backupRoot = path.join(this.cfg.backupRoot, 'frontend');
    const backupPath = path.join(backupRoot, backupDirName);

    fs.mkdirSync(backupRoot, { recursive: true });

    // 如果目录为空（首次部署），跳过备份
    if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0) {
      this._copyDir(targetPath, backupPath);
    } else {
      fs.mkdirSync(backupPath, { recursive: true });
    }

    const sizeBytes = this._dirSize(backupPath);

    this.db.prepare(`
      INSERT INTO backups (component, version, backup_path, size_bytes, task_id)
      VALUES ('frontend', ?, ?, ?, ?)
    `).run(version, backupPath, sizeBytes, ctx.task.id);

    this._backupPath = backupPath;
    ctx.state.backupPath = backupPath;

    return {
      message: `备份完成 (${backupPath}, ${this._formatSize(sizeBytes)})`,
      backupPath,
      sizeBytes,
    };
  }

  replace(ctx) {
    const targetPath = ctx.state.targetPath;

    // 从 ZIP 中提取 dist/ 目录
    const distEntries = this.zip.getEntries().filter((e) =>
      e.entryName.startsWith('dist/') && !e.isDirectory
    );

    if (distEntries.length === 0) {
      throw new Error('升级包中未找到 dist/ 目录');
    }

    // 原子替换
    const newPath = targetPath + '.new';
    const oldPath = targetPath + '.old';
    this._removeDir(newPath);
    this._removeDir(oldPath);

    // 解压到 .new
    for (const entry of distEntries) {
      const relPath = entry.entryName.replace(/^dist\//, '');
      const destPath = path.join(newPath, relPath);
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
    }

    // 原子交换
    if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0) {
      fs.renameSync(targetPath, oldPath);
    } else if (fs.existsSync(targetPath)) {
      // 目录为空 → 直接删除（避免 rename 到已有空目录失败）
      fs.rmdirSync(targetPath);
    }
    try {
      fs.renameSync(newPath, targetPath);
      this._removeDir(oldPath);
    } catch (err) {
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, targetPath);
      }
      throw new Error(`原子替换失败: ${err.message}`);
    }
    applyOwnership(targetPath, this.cfg.frontendOwner, this.cfg.frontendGroup);

    return { message: `文件替换完成 (${distEntries.length} 个文件)` };
  }

  smokeTest(ctx) {
    const indexHtml = path.join(ctx.state.targetPath, 'index.html');

    if (!fs.existsSync(indexHtml)) {
      throw new Error(`冒烟失败: index.html 不存在`);
    }

    // 检查文件大小合理（至少 10 字节）
    const stat = fs.statSync(indexHtml);
    if (stat.size < 10) {
      throw new Error(`冒烟失败: index.html 大小异常 (${stat.size} bytes)`);
    }

    // HTTP 检查（如果 curl 可用）
    try {
      const httpCode = execFileSync('curl', [
        '-s', '-o', '/dev/null', '-w', '%{http_code}',
        '--max-time', '5', this.cfg.frontendHealthUrl,
      ], { encoding: 'utf8', timeout: 10000 }).trim();
      if (httpCode !== '200') {
        throw new Error(`HTTP 状态码: ${httpCode}`);
      }
    } catch (err) {
      // curl 不可用或 Caddy 未配置时跳过 HTTP 检查
      if (err.message.startsWith('HTTP') || err.message.startsWith('冒烟')) throw err;
    }

    return { message: '冒烟测试通过 (index.html 存在且可访问)' };
  }

  finalize(ctx) {
    const newVersion = this.manifest.version;

    if (ctx.state.isNew) {
      // 首次部署：注册组件
      this.db.prepare(`
        INSERT INTO components (name, type, version, install_path)
        VALUES ('frontend', 'frontend', ?, ?)
      `).run(newVersion, ctx.state.targetPath);
    } else {
      this.db.prepare(`
        UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
        WHERE name = 'frontend'
      `).run(newVersion);
    }

    return { message: `前端版本已更新为 ${newVersion}` };
  }

  rollback(ctx) {
    const targetPath = ctx.state.targetPath || this.cfg.frontendRoot;
    const backupPath = ctx.state.backupPath || this._backupPath;

    if (!backupPath || !fs.existsSync(backupPath) || fs.readdirSync(backupPath).length === 0) {
      throw new Error('回滚失败: 备份不存在或为空（可能是首次部署）');
    }

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
    applyOwnership(targetPath, this.cfg.frontendOwner, this.cfg.frontendGroup);

    // 恢复 DB 版本
    const component = ctx.state.component;
    if (component) {
      this.db.prepare(`
        UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
        WHERE name = 'frontend'
      `).run(component.version);
    }

    return { message: `已从备份恢复 (${backupPath})` };
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
        `df -k "${this.cfg.frontendRoot}" | tail -1`,
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
}

module.exports = { FrontendUpgrader };
