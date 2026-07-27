/**
 * Skill 集合包升级器（skill-bundle）。
 *
 * 实现设计文档 §9.2 的批量 Skill 升级流程:
 *   pre_check → backup → replace → reload → smoke_test → finalize
 *
 * 与 SkillUpgrader 的关键差异:
 * - 预检阶段遍历所有 Skill，全量通过才继续
 * - 备份整个 workspace/skills/ 目录
 * - 替换时整体交换 skills 目录
 * - 冒烟测试并行执行（每 Skill 独立检查）
 * - finalize 批量更新 DB 版本
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { getDb } = require('../database/connection');
const config = require('../config');
const { applyOwnership } = require('./Ownership');

class BundleUpgrader {
  /**
   * @param {Buffer} zipBuffer  升级包 ZIP 的二进制内容
   * @param {object} [opts]
   * @param {object} [opts.db]
   * @param {object} [opts.config]
   */
  constructor(zipBuffer, opts = {}) {
    this.zip = new AdmZip(zipBuffer);
    this.manifest = this._readManifest();
    this.db = opts.db || getDb();
    this.cfg = opts.config || config;
    this._backupPath = null;
    this._skillNames = []; // 包内所有 Skill 名称列表
  }

  // ──────────────────────────────────────────────────────────
  // Upgrader 接口
  // ──────────────────────────────────────────────────────────

  /**
   * 步骤 1: 批量预检查。
   * 遍历包内每个 Skill，全部通过才继续。
   */
  preCheck(ctx) {
    const skillNames = this._discoverSkills();
    this._skillNames = skillNames;

    if (skillNames.length === 0) {
      throw new Error('升级包中未找到任何 Skill 目录 (skills/*/)');
    }

    // 1. 磁盘空间（>200MB，批量升级需要更多空间）
    this._checkDiskSpace(200 * 1024 * 1024);

    // 2. 验证每个 Skill 的目标目录 + DB 注册
    const errors = [];
    const skillInfos = [];

    for (const skillName of skillNames) {
      const targetPath = this._skillTargetPath(skillName);
      const component = this.db.prepare(
        'SELECT * FROM components WHERE name = ?'
      ).get(skillName);

      if (!fs.existsSync(targetPath)) {
        errors.push(`Skill "${skillName}": 目录不存在 ${targetPath}`);
        continue;
      }

      if (!component) {
        // 新 Skill，允许安装
        skillInfos.push({ name: skillName, targetPath, oldVersion: null, isNew: true });
      } else {
        skillInfos.push({
          name: skillName,
          targetPath,
          oldVersion: component.version,
          isNew: false,
          component,
        });
      }
    }

    if (errors.length > 0) {
      throw new Error(`预检查失败:\n${errors.join('\n')}`);
    }

    ctx.state.skillInfos = skillInfos;
    ctx.state.skillNames = skillNames;

    return {
      message: `预检查通过 (${skillNames.length} 个 Skill: ${skillNames.join(', ')})`,
    };
  }

  /**
   * 步骤 2: 备份整个 skills 目录。
   */
  backup(ctx) {
    const skillsRoot = this.cfg.skillsRoot;
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDirName = `skills_full_${dateStr}`;
    const backupRoot = path.join(this.cfg.backupRoot, 'skills');
    const backupPath = path.join(backupRoot, backupDirName);

    fs.mkdirSync(backupRoot, { recursive: true });

    // 复制整个 skills 目录
    this._copyDir(skillsRoot, backupPath);

    const sizeBytes = this._dirSize(backupPath);

    // 为每个 Skill 记录备份
    for (const info of ctx.state.skillInfos) {
      if (info.isNew) continue;
      this.db.prepare(`
        INSERT INTO backups (component, version, backup_path, size_bytes, task_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(info.name, info.oldVersion, backupPath, Math.floor(sizeBytes / ctx.state.skillInfos.length), ctx.task.id);
    }

    this._backupPath = backupPath;
    ctx.state.backupPath = backupPath;

    return {
      message: `备份完成 (${backupPath}, ${this._formatSize(sizeBytes)})`,
      backupPath,
      sizeBytes,
    };
  }

  /**
   * 步骤 3: 整体原子替换 skills 目录。
   */
  replace(ctx) {
    const skillsRoot = this.cfg.skillsRoot;
    const skillEntries = this.zip.getEntries().filter((e) =>
      e.entryName.startsWith('skills/') && !e.isDirectory,
    );

    if (skillEntries.length === 0) {
      throw new Error('升级包中未找到 skills/ 目录下的文件');
    }

    // 写到临时目录
    const newRoot = skillsRoot + '.new';
    const oldRoot = skillsRoot + '.old';
    this._removeDir(newRoot);
    this._removeDir(oldRoot);

    // 先保留当前所有 Skill 中未被替换的目录（不在包内的 Skill 保持不变）
    // 1. 复制当前全部到 .new
    if (fs.existsSync(skillsRoot)) {
      this._copyDir(skillsRoot, newRoot);
    }

    // 2. 用包内文件覆盖 .new 中的对应 Skill
    for (const entry of skillEntries) {
      const relPath = entry.entryName.replace(/^skills\//, '');
      const destPath = path.join(newRoot, relPath);
      const destDir = path.dirname(destPath);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
    }

    // 3. 原子交换
    if (fs.existsSync(skillsRoot)) {
      fs.renameSync(skillsRoot, oldRoot);
    }
    try {
      fs.renameSync(newRoot, skillsRoot);
      this._removeDir(oldRoot);
    } catch (err) {
      // 还原
      if (fs.existsSync(oldRoot)) {
        fs.renameSync(oldRoot, skillsRoot);
      }
      throw new Error(`原子替换失败: ${err.message}`);
    }
    applyOwnership(skillsRoot, this.cfg.runtimeOwner, this.cfg.runtimeGroup);

    return { message: `文件替换完成 (${skillEntries.length} 个文件, ${ctx.state.skillNames.length} 个 Skill)` };
  }

  /**
   * 步骤 4: 批量触发热加载。
   */
  reload(ctx) {
    const skillsRoot = this.cfg.skillsRoot;
    const results = [];

    for (const skillName of ctx.state.skillNames) {
      const skillMdPath = path.join(skillsRoot, skillName, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        const now = new Date();
        fs.utimesSync(skillMdPath, now, now);
        results.push(`touched ${skillName}/SKILL.md`);
      }

      // Plugin 目录同步
      const pluginPath = this._pluginSkillPath(skillName);
      if (pluginPath && fs.existsSync(pluginPath)) {
        const now = new Date();
        fs.utimesSync(pluginPath, now, now);
      }
    }

    this._sleepSync(3000);

    return { message: `已触发热加载 (${results.length} 个 Skill)` };
  }

  /**
   * 步骤 5: 并行冒烟测试。
   */
  smokeTest(ctx) {
    const skillsRoot = this.cfg.skillsRoot;
    const results = { passed: [], failed: [] };

    for (const skillName of ctx.state.skillNames) {
      const skillPath = path.join(skillsRoot, skillName);
      const missing = [];

      // 检查 SKILL.md
      if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
        missing.push('SKILL.md');
      }

      // 检查 scripts/ 下的 JS 文件可读取
      const scriptsDir = path.join(skillPath, 'scripts');
      if (fs.existsSync(scriptsDir)) {
        const jsFiles = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js'));
        for (const f of jsFiles) {
          try {
            fs.readFileSync(path.join(scriptsDir, f), 'utf8');
          } catch (_) {
            missing.push(`scripts/${f} (不可读)`);
          }
        }
      }

      if (missing.length > 0) {
        results.failed.push({ skill: skillName, missing });
      } else {
        results.passed.push(skillName);
      }
    }

    if (results.failed.length > 0) {
      const failedList = results.failed
        .map((f) => `  ${f.skill}: 缺少 ${f.missing.join(', ')}`)
        .join('\n');
      throw new Error(`冒烟测试失败 (${results.failed.length}/${ctx.state.skillNames.length}):\n${failedList}`);
    }

    return { message: `冒烟测试通过 (${results.passed.length} 个 Skill 全部正常)` };
  }

  /**
   * 步骤 6: 批量更新 DB 版本。
   */
  finalize(ctx) {
    const newVersion = this.manifest.version;
    let updated = 0;
    let inserted = 0;

    for (const info of ctx.state.skillInfos) {
      if (info.isNew) {
        // 注册新 Skill
        const installPath = path.join(this.cfg.skillsRoot, info.name);
        try {
          this.db.prepare(`
            INSERT INTO components (name, type, version, install_path)
            VALUES (?, 'skill', ?, ?)
          `).run(info.name, newVersion, installPath);
          inserted++;
        } catch (_) { /* 已存在则忽略 */ }
      } else {
        this.db.prepare(`
          UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
          WHERE name = ?
        `).run(newVersion, info.name);
        updated++;
      }
    }

    return { message: `版本已更新: ${updated} 个升级, ${inserted} 个新注册 → ${newVersion}` };
  }

  /**
   * 回滚：从备份整体恢复。
   */
  rollback(ctx) {
    const skillsRoot = this.cfg.skillsRoot;
    const backupPath = ctx.state.backupPath || this._backupPath;

    if (!backupPath || !fs.existsSync(backupPath)) {
      throw new Error('回滚失败: 备份目录不存在或未执行备份步骤');
    }

    const brokenPath = skillsRoot + '.broken';
    this._removeDir(brokenPath);

    if (fs.existsSync(skillsRoot)) {
      fs.renameSync(skillsRoot, brokenPath);
    }

    try {
      this._copyDir(backupPath, skillsRoot);
      this._removeDir(brokenPath);
    } catch (err) {
      if (fs.existsSync(brokenPath)) {
        fs.renameSync(brokenPath, skillsRoot);
      }
      throw new Error(`回滚恢复失败: ${err.message}`);
    }
    applyOwnership(skillsRoot, this.cfg.runtimeOwner, this.cfg.runtimeGroup);

    // 批量 touch
    const skillInfos = ctx.state.skillInfos || [];
    for (const info of skillInfos) {
      const skillMd = path.join(skillsRoot, info.name, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const now = new Date();
        fs.utimesSync(skillMd, now, now);
      }
    }
    this._sleepSync(3000);

    // 恢复 DB 版本
    for (const info of skillInfos) {
      if (info.oldVersion) {
        this.db.prepare(`
          UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active'
          WHERE name = ?
        `).run(info.oldVersion, info.name);
      }
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

  /**
   * 从 ZIP 包中扫描 skills/ 下的所有一级子目录。
   */
  _discoverSkills() {
    const dirs = new Set();
    const entries = this.zip.getEntries();
    for (const entry of entries) {
      const match = entry.entryName.match(/^skills\/([^/]+)\//);
      if (match) {
        dirs.add(match[1]);
      }
    }
    return Array.from(dirs).sort();
  }

  _skillTargetPath(skillName) {
    // 尝试匹配目录名
    const candidates = [
      skillName,
      `openclaw-${skillName}`,
      skillName.replace(/^napm-/, 'openclaw-napm-'),
    ];
    for (const c of candidates) {
      const p = path.join(this.cfg.skillsRoot, c);
      if (fs.existsSync(p)) return p;
    }
    return path.join(this.cfg.skillsRoot, skillName);
  }

  _pluginSkillPath(skillName) {
    if (!this.cfg.pluginRoot) return null;
    const p = path.join(this.cfg.pluginRoot, 'skills', skillName);
    return fs.existsSync(p) ? p : null;
  }

  _checkDiskSpace(minBytes) {
    try {
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
      if (err.message.includes('磁盘空间不足')) throw err;
    }
  }

  _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this._copyDir(s, d);
      } else if (entry.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(s), d);
      } else {
        fs.copyFileSync(s, d);
      }
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
      if (entry.isDirectory()) {
        size += this._dirSize(p);
      } else {
        size += fs.statSync(p).size;
      }
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

module.exports = { BundleUpgrader };
