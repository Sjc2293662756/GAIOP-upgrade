/**
 * Skill 升级器。
 *
 * 实现设计文档 §9.1 的 Skill 升级流程:
 *   pre_check → backup → replace → reload → smoke_test → finalize
 *   失败时自动 rollback（恢复备份 + 冒烟）
 *
 * 零停机：利用 OpenClaw 的热加载机制（touch SKILL.md → delete require.cache）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getDb } = require('../database/connection');
const config = require('../config');
const { applyOwnership } = require('./Ownership');

class SkillUpgrader {
  /**
   * @param {Buffer} zipBuffer       升级包 ZIP 的二进制内容
   * @param {object} [opts]          可选配置覆盖
   * @param {object} [opts.db]       数据库实例（默认 getDb()）
   * @param {object} [opts.config]   配置覆盖（默认全局 config）
   */
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

  /**
   * 步骤 1: 预检查。
   */
  preCheck(ctx) {
    const skillName = this.manifest.component;
    const targetPath = this._skillTargetPath(skillName);

    // 1. 磁盘空间检查（>100MB）
    this._checkDiskSpace(100 * 1024 * 1024);

    // 2. 验证目标目录存在
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Skill 目录不存在: ${targetPath}`);
    }

    // 3. 验证组件已在 DB 注册
    const component = this.db.prepare(
      'SELECT * FROM components WHERE name = ?'
    ).get(skillName);

    if (!component) {
      throw new Error(`组件 "${skillName}" 未在数据库中注册`);
    }

    // 将组件信息存入 ctx
    ctx.state.component = component;
    ctx.state.skillName = skillName;
    ctx.state.targetPath = targetPath;
    ctx.state.pluginSkillsPath = this._pluginSkillsPath(skillName);

    return { message: `预检查通过 (磁盘充足，目录 ${targetPath} 存在)` };
  }

  /**
   * 步骤 2: 备份当前版本。
   */
  backup(ctx) {
    const skillName = ctx.state.skillName;
    const targetPath = ctx.state.targetPath;
    const version = ctx.state.component.version;
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDirName = `${skillName}_${version}_${dateStr}`;
    const backupRoot = path.join(this.cfg.backupRoot, 'skills');
    const backupPath = path.join(backupRoot, backupDirName);

    // 确保备份目录存在
    fs.mkdirSync(backupRoot, { recursive: true });

    // cp -a (递归复制)
    this._copyDir(targetPath, backupPath);

    // 计算大小
    const sizeBytes = this._dirSize(backupPath);

    // 记录到数据库
    this.db.prepare(`
      INSERT INTO backups (component, version, backup_path, size_bytes, task_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(skillName, version, backupPath, sizeBytes, ctx.task.id);

    // 存储备份路径供回滚使用
    this._backupPath = backupPath;
    ctx.state.backupPath = backupPath;
    ctx.state.backupSizeBytes = sizeBytes;

    return {
      message: `备份完成 (${backupPath}, ${this._formatSize(sizeBytes)})`,
      backupPath,
      sizeBytes,
    };
  }

  /**
   * 步骤 3: 原子替换文件。
   */
  replace(ctx) {
    const skillName = ctx.state.skillName;
    const targetPath = ctx.state.targetPath;
    const pluginSkillsPath = ctx.state.pluginSkillsPath;

    // 从 ZIP 中提取 skills/<skillName>/ 下的所有文件
    const skillEntries = this.zip.getEntries().filter((entry) => {
      const name = entry.entryName;
      return name.startsWith(`skills/${skillName}/`) && !entry.isDirectory;
    });

    if (skillEntries.length === 0) {
      throw new Error(`升级包中未找到 skills/${skillName}/ 目录下的文件`);
    }

    // 写到临时目录 .new
    const newPath = targetPath + '.new';
    const oldPath = targetPath + '.old';

    // 清理可能残留的临时目录
    this._removeDir(newPath);
    this._removeDir(oldPath);

    // 解压到 .new
    fs.mkdirSync(newPath, { recursive: true });
    for (const entry of skillEntries) {
      const relativePath = entry.entryName.replace(`skills/${skillName}/`, '');
      const destPath = path.join(newPath, relativePath);
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
    }

    // 原子替换: mv target → .old, mv .new → target
    fs.renameSync(targetPath, oldPath);
    try {
      fs.renameSync(newPath, targetPath);
      // 成功后清理 .old
      this._removeDir(oldPath);
    } catch (err) {
      // 还原!
      fs.renameSync(oldPath, targetPath);
      throw new Error(`原子替换失败: ${err.message}`);
    }

    // 同步到 Plugin 目录（如果存在）
    if (pluginSkillsPath && fs.existsSync(path.dirname(pluginSkillsPath))) {
      this._removeDir(pluginSkillsPath + '.old');
      if (fs.existsSync(pluginSkillsPath)) {
        fs.renameSync(pluginSkillsPath, pluginSkillsPath + '.old');
      }
      this._copyDir(targetPath, pluginSkillsPath);
      this._removeDir(pluginSkillsPath + '.old');
    }
    applyOwnership(targetPath, this.cfg.runtimeOwner, this.cfg.runtimeGroup);
    if (pluginSkillsPath) applyOwnership(pluginSkillsPath, this.cfg.runtimeOwner, this.cfg.runtimeGroup);

    return { message: `文件替换完成 (${skillEntries.length} 个文件)` };
  }

  /**
   * 步骤 4: 触发热加载。
   */
  reload(ctx) {
    const targetPath = ctx.state.targetPath;
    const pluginSkillsPath = ctx.state.pluginSkillsPath;

    // touch SKILL.md → 触发 OpenClaw 文件监控 + delete require.cache
    const skillMdPath = path.join(targetPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const now = new Date();
      fs.utimesSync(skillMdPath, now, now);
    }

    // 同步触发 Plugin 目录
    if (pluginSkillsPath && fs.existsSync(pluginSkillsPath)) {
      const pluginSkillMd = path.join(pluginSkillsPath, 'SKILL.md');
      if (fs.existsSync(pluginSkillMd)) {
        const now = new Date();
        fs.utimesSync(pluginSkillMd, now, now);
      }
    }

    // 等待 3 秒让文件监控检测到变化
    this._sleepSync(3000);

    return { message: '已触发热加载 (touch SKILL.md, 等待 3s)' };
  }

  /**
   * 步骤 5: 冒烟测试。
   */
  smokeTest(ctx) {
    const targetPath = ctx.state.targetPath;

    // 基础检查：验证关键文件存在
    const checks = ['SKILL.md'];
    const scriptsDir = path.join(targetPath, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const files = fs.readdirSync(scriptsDir);
      checks.push(...files.map((f) => `scripts/${f}`));
    }

    const missing = [];
    for (const check of checks) {
      if (!fs.existsSync(path.join(targetPath, check))) {
        missing.push(check);
      }
    }

    if (missing.length > 0) {
      throw new Error(`冒烟测试失败: 缺少文件 ${missing.join(', ')}`);
    }

    // TODO: 后续可增加 OpenClaw 内部 API 调用 health_check

    return { message: `冒烟测试通过 (${checks.length} 个文件检查正常)` };
  }

  /**
   * 步骤 6: 最终确认（更新 DB + 审计）。
   */
  finalize(ctx) {
    const skillName = ctx.state.skillName;
    const newVersion = this.manifest.version;

    this.db.prepare(`
      UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
      WHERE name = ?
    `).run(newVersion, skillName);

    return { message: `组件 ${skillName} 版本已更新为 ${newVersion}` };
  }

  /**
   * 回滚：从备份恢复。
   */
  rollback(ctx) {
    const skillName = ctx.state.skillName || this.manifest.component;
    const targetPath = ctx.state.targetPath || this._skillTargetPath(skillName);
    const backupPath = ctx.state.backupPath || this._backupPath;

    if (!backupPath || !fs.existsSync(backupPath)) {
      throw new Error('回滚失败: 备份目录不存在或未执行备份步骤');
    }

    // 恢复：mv current → .broken, cp backup → current
    const brokenPath = targetPath + '.broken';
    this._removeDir(brokenPath);

    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, brokenPath);
    }

    try {
      this._copyDir(backupPath, targetPath);
      this._removeDir(brokenPath);
    } catch (err) {
      // 还原
      if (fs.existsSync(brokenPath)) {
        fs.renameSync(brokenPath, targetPath);
      }
      throw new Error(`回滚恢复失败: ${err.message}`);
    }

    // 同步到 Plugin 目录
    const pluginSkillsPath = this._pluginSkillsPath(skillName);
    if (pluginSkillsPath) {
      this._removeDir(pluginSkillsPath + '.broken');
      if (fs.existsSync(pluginSkillsPath)) {
        fs.renameSync(pluginSkillsPath, pluginSkillsPath + '.broken');
      }
      this._copyDir(targetPath, pluginSkillsPath);
      this._removeDir(pluginSkillsPath + '.broken');
    }
    applyOwnership(targetPath, this.cfg.runtimeOwner, this.cfg.runtimeGroup);
    if (pluginSkillsPath) applyOwnership(pluginSkillsPath, this.cfg.runtimeOwner, this.cfg.runtimeGroup);

    // 触发热加载
    const skillMdPath = path.join(targetPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const now = new Date();
      fs.utimesSync(skillMdPath, now, now);
    }
    this._sleepSync(3000);

    // 恢复 DB 版本
    const component = ctx.state.component;
    if (component) {
      this.db.prepare(`
        UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
        WHERE name = ?
      `).run(component.version, skillName);
    }

    return { message: `已回滚到备份 ${backupPath}` };
  }

  // ──────────────────────────────────────────────────────────
  // 内部辅助
  // ──────────────────────────────────────────────────────────

  _readManifest() {
    const manifestEntry = this.zip.getEntry('upgrade-manifest.json');
    if (!manifestEntry) {
      throw new Error('升级包缺少 upgrade-manifest.json');
    }
    return JSON.parse(manifestEntry.getData().toString('utf8'));
  }

  /**
   * Skill 在 workspace/skills/ 下的目标路径。
   */
  _skillTargetPath(skillName) {
    // 尝试匹配目录名（可能有 openclaw-napm- 前缀或 echarts- 前缀）
    const candidates = [
      skillName,
      `openclaw-${skillName}`,
      skillName.replace(/^napm-/, 'openclaw-napm-'),
    ];

    for (const candidate of candidates) {
      const p = path.join(this.cfg.skillsRoot, candidate);
      if (fs.existsSync(p)) return p;
    }

    // 都不存在则返回默认路径
    return path.join(this.cfg.skillsRoot, skillName);
  }

  /**
   * Skill 在 Plugin 扩展目录下的目标路径。
   */
  _pluginSkillsPath(skillName) {
    if (!this.cfg.pluginRoot) return null;
    const p = path.join(this.cfg.pluginRoot, 'skills', skillName);
    return p;
  }

  /**
   * 检查磁盘剩余空间。
   */
  _checkDiskSpace(minBytes) {
    try {
      // 使用 df 命令检查（Linux）
      const dfOutput = execSync(
        `df -k "${this.cfg.skillsRoot}" | tail -1`,
        { encoding: 'utf8', timeout: 5000 },
      );
      const parts = dfOutput.trim().split(/\s+/);
      const availableKb = parseInt(parts[3], 10);
      if (availableKb && availableKb * 1024 < minBytes) {
        throw new Error(
          `磁盘空间不足: 剩余 ${this._formatSize(availableKb * 1024)}，需要至少 ${this._formatSize(minBytes)}`,
        );
      }
    } catch (err) {
      // df 不可用时跳过（Windows 开发环境）
      if (err.message.includes('磁盘空间不足')) throw err;
      // 静默跳过
    }
  }

  /**
   * 递归复制目录。
   */
  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDir(srcPath, destPath);
      } else if (entry.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(srcPath);
        fs.symlinkSync(linkTarget, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * 递归删除目录。
   */
  _removeDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  /**
   * 计算目录大小。
   */
  _dirSize(dirPath) {
    let size = 0;
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += this._dirSize(p);
      } else {
        size += fs.statSync(p).size;
      }
    }
    return size;
  }

  /**
   * 格式化字节。
   */
  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * 同步等待。
   */
  _sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait */ }
  }
}

module.exports = { SkillUpgrader };
