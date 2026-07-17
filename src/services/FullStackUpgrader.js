/**
 * 全栈升级器。
 *
 * 实现设计文档 §9.5:
 *   维护模式 → OpenClaw → Skills → Frontend → 全栈冒烟 → 退出维护 → finalize
 *
 * 关键设计：
 * - 委派模式：内部复用 OpenClawUpgrader / BundleUpgrader / FrontendUpgrader
 * - 级联回滚：按升级顺序逆序回滚已成功的组件
 * - 维护模式全程开启
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { getDb } = require('../database/connection');
const config = require('../config');
const maintenance = require('./MaintenanceMode');
const { OpenClawUpgrader } = require('./OpenClawUpgrader');
const { BundleUpgrader } = require('./BundleUpgrader');
const { FrontendUpgrader } = require('./FrontendUpgrader');

class FullStackUpgrader {
  constructor(zipBuffer, opts = {}) {
    this.zip = new AdmZip(zipBuffer);
    this.manifest = this._readManifest();
    this.db = opts.db || getDb();
    this.cfg = opts.config || config;
    this._upgraded = {};     // 追踪已成功的组件: { openclaw: true, skills: true, frontend: true }
    this._ctx = null;        // 共享上下文
    this._subUpgraders = {}; // 子升级器实例
  }

  // ──────────────────────────────────────────────────────────
  // Upgrader 接口
  // ──────────────────────────────────────────────────────────

  preCheck(ctx) {
    this._ctx = ctx;

    // 1. 磁盘空间（>1GB）
    this._checkDiskSpace(1024 * 1024 * 1024);

    // 2. 解析子包 manifest
    this._validateSubPackages();

    // 3. 验证目标目录
    const checks = [
      { name: 'openclaw', path: this.cfg.openclawRoot },
      { name: 'skills', path: this.cfg.skillsRoot },
      { name: 'frontend', path: this.cfg.frontendRoot },
    ];

    const missing = checks.filter((c) => !fs.existsSync(c.path));
    if (missing.length > 0) {
      throw new Error(`目录缺失: ${missing.map((c) => c.name).join(', ')}`);
    }

    ctx.state.components = { openclaw: null, frontend: null, skills: [] };
    for (const row of this.db.prepare('SELECT * FROM components').all()) {
      if (row.type === 'openclaw') ctx.state.components.openclaw = row;
      else if (row.type === 'frontend') ctx.state.components.frontend = row;
    }

    return { message: '全栈预检查通过 (磁盘充足，所有目标目录存在)' };
  }

  backup(ctx) {
    // 为子升级器初始化上下文
    this._initSubContext(ctx);

    const results = [];
    const { openclaw, skills, frontend } = this._getSubUpgraders();

    if (openclaw) {
      const r = openclaw.backup(ctx);
      results.push(`openclaw: ${r.message}`);
    }

    if (skills) {
      skills._skillNames = ctx.state.skillNames || this._discoverAllSkills();
      ctx.state.skillInfos = ctx.state.skillInfos || this._buildSkillInfos();
      const r = skills.backup(ctx);
      results.push(`skills: ${r.message}`);
    }

    if (frontend) {
      const r = frontend.backup(ctx);
      results.push(`frontend: ${r.message}`);
    }

    return { message: results.join(' | ') };
  }

  /** 填充 ctx.state 供子升级器使用 */
  _initSubContext(ctx) {
    if (!ctx.state.targetPath) {
      ctx.state.targetPath = this.cfg.openclawRoot;
    }
    if (!ctx.state.component) {
      ctx.state.component = ctx.state.components?.openclaw || { version: 'unknown' };
    }
    if (!ctx.state.skillNames) {
      ctx.state.skillNames = this._discoverAllSkills();
    }
    if (!ctx.state.skillInfos) {
      ctx.state.skillInfos = this._buildSkillInfos();
    }
  }

  replace(ctx) {
    this._initSubContext(ctx);
    maintenance.enter('全栈升级中 (OpenClaw + Skills + Frontend)');

    const results = [];
    const { openclaw, skills, frontend } = this._getSubUpgraders();

    // 1. OpenClaw
    if (openclaw) {
      try {
        const r = openclaw.replace(ctx);
        this._upgraded.openclaw = true;
        results.push(`openclaw: ${r.message}`);
      } catch (err) {
        // OpenClaw 失败 → 级联回滚只回滚 OpenClaw
        this._rollbackComponents(['openclaw'], ctx);
        maintenance.exit();
        throw new Error(`OpenClaw 升级失败 (已回滚): ${err.message}`);
      }
    }

    // 2. Skills
    if (skills) {
      try {
        skills._skillNames = ctx.state.skillNames || this._discoverAllSkills();
        ctx.state.skillInfos = ctx.state.skillInfos || this._buildSkillInfos();
        const r = skills.replace(ctx);
        this._upgraded.skills = true;
        results.push(`skills: ${r.message}`);
      } catch (err) {
        this._rollbackComponents(['skills', 'openclaw'], ctx);
        maintenance.exit();
        throw new Error(`Skills 升级失败 (已回滚): ${err.message}`);
      }
    }

    // 3. Frontend
    if (frontend) {
      try {
        const r = frontend.replace(ctx);
        this._upgraded.frontend = true;
        results.push(`frontend: ${r.message}`);
      } catch (err) {
        // 前端失败只回滚前端，不回滚其他
        this._rollbackComponents(['frontend'], ctx);
        maintenance.exit();
        throw new Error(`Frontend 升级失败 (已回滚): ${err.message}`);
      }
    }

    return { message: results.join(' | ') };
  }

  reload(ctx) {
    this._initSubContext(ctx);
    const results = [];
    const { openclaw, skills } = this._getSubUpgraders();

    if (openclaw) {
      try {
        const r = openclaw.reload(ctx);
        results.push(`openclaw: ${r.message}`);
      } catch (err) {
        this._rollbackComponents(['openclaw'], ctx);
        maintenance.exit();
        throw new Error(`OpenClaw 重启失败: ${err.message}`);
      }
    }

    if (skills) {
      const r = skills.reload(ctx);
      results.push(`skills: ${r.message}`);
    }

    return { message: results.join(' | ') };
  }

  smokeTest(ctx) {
    this._initSubContext(ctx);
    const { openclaw, skills, frontend } = this._getSubUpgraders();
    const results = [];

    // 1. OpenClaw 健康检查
    if (openclaw && this._upgraded.openclaw) {
      try {
        const r = openclaw.smokeTest(ctx);
        results.push(`openclaw: ${r.message}`);
      } catch (err) {
        this._rollbackComponents(['openclaw'], ctx);
        maintenance.exit();
        throw new Error(`OpenClaw 冒烟失败: ${err.message}`);
      }
    }

    // 2. Skills 冒烟
    if (skills && this._upgraded.skills) {
      try {
        const r = skills.smokeTest(ctx);
        results.push(`skills: ${r.message}`);
      } catch (err) {
        this._rollbackComponents(['skills', 'openclaw'], ctx);
        maintenance.exit();
        throw new Error(`Skills 冒烟失败: ${err.message}`);
      }
    }

    // 3. Frontend 冒烟
    if (frontend && this._upgraded.frontend) {
      try {
        const r = frontend.smokeTest(ctx);
        results.push(`frontend: ${r.message}`);
      } catch (err) {
        this._rollbackComponents(['frontend'], ctx);
        maintenance.exit();
        throw new Error(`Frontend 冒烟失败: ${err.message}`);
      }
    }

    return { message: `全栈冒烟通过 (${results.join(', ')})` };
  }

  finalize(ctx) {
    const newVersion = this.manifest.version;
    const { openclaw, skills, frontend } = this._getSubUpgraders();

    if (openclaw) openclaw.finalize(ctx);
    if (skills) skills.finalize(ctx);
    if (frontend) frontend.finalize(ctx);

    maintenance.exit();

    return { message: `全栈升级完成 → ${newVersion}` };
  }

  rollback(ctx) {
    const { openclaw, skills, frontend } = this._getSubUpgraders();

    // 逆序回滚所有已升级的组件
    if (frontend && this._upgraded.frontend) {
      try { frontend.rollback(ctx); } catch (_) {}
    }
    if (skills && this._upgraded.skills) {
      try { skills.rollback(ctx); } catch (_) {}
    }
    if (openclaw && this._upgraded.openclaw) {
      try { openclaw.rollback(ctx); } catch (_) {}
    }

    maintenance.exit();
    return { message: '全栈已回滚' };
  }

  // ──────────────────────────────────────────────────────────
  // 级联回滚
  // ──────────────────────────────────────────────────────────

  _rollbackComponents(names, ctx) {
    for (const name of names) {
      if (!this._upgraded[name]) continue;
      try {
        const { openclaw, skills, frontend } = this._getSubUpgraders();
        const map = { openclaw, skills, frontend };
        if (map[name]) map[name].rollback(ctx);
        this._upgraded[name] = false;
      } catch (_) { /* 回滚失败也不阻止后续回滚 */ }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 子包管理
  // ──────────────────────────────────────────────────────────

  _validateSubPackages() {
    // 验证每个子包至少有一个文件
    const hasOpenClaw = this.zip.getEntries().some((e) => e.entryName.startsWith('openclaw/') && !e.isDirectory);
    const hasSkills = this.zip.getEntries().some((e) => e.entryName.startsWith('skills/') && !e.isDirectory);
    const hasFrontend = this.zip.getEntries().some((e) => e.entryName.startsWith('frontend/dist/') && !e.isDirectory);

    if (!hasOpenClaw && !hasSkills && !hasFrontend) {
      throw new Error('全栈包中未找到任何子包 (openclaw/ | skills/ | frontend/dist/)');
    }

    this._hasOpenClaw = hasOpenClaw;
    this._hasSkills = hasSkills;
    this._hasFrontend = hasFrontend;
  }

  _getSubUpgraders() {
    if (Object.keys(this._subUpgraders).length > 0) return this._subUpgraders;

    const result = { openclaw: null, skills: null, frontend: null };

    if (this._hasOpenClaw) {
      result.openclaw = new OpenClawUpgrader(this._extractSubZip('openclaw'), { db: this.db, config: this.cfg });
    }
    if (this._hasSkills) {
      result.skills = new BundleUpgrader(this._extractSubZip('skills'), { db: this.db, config: this.cfg });
    }
    if (this._hasFrontend) {
      result.frontend = new FrontendUpgrader(this._extractSubZip('frontend'), { db: this.db, config: this.cfg });
    }

    this._subUpgraders = result;
    return result;
  }

  /**
   * 从全栈 ZIP 中提取子包内容，打包为独立的 ZIP Buffer。
   */
  _extractSubZip(subDir) {
    const subZip = new AdmZip();

    // 找到子目录的 manifest
    const manifestEntry = this.zip.getEntry(`${subDir}/upgrade-manifest.json`);

    // 复制子目录下的所有文件
    for (const entry of this.zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.startsWith(`${subDir}/`)) continue;

      let relPath = entry.entryName.replace(`${subDir}/`, '');

      // 如果是 skills 子包，文件路径已经是 skills/xxx/...，保持不变
      // 如果是 openclaw 子包，manifest 在最外层
      // 如果是 frontend 子包，manifest 在最外层

      subZip.addFile(relPath, entry.getData());
    }

    // 确保有 upgrade-manifest.json
    if (!manifestEntry && subDir === 'skills') {
      // 用顶层 manifest 创建一个子 manifest
      subZip.addFile('upgrade-manifest.json', Buffer.from(JSON.stringify({
        type: 'skill-bundle',
        component: 'skills',
        version: this.manifest.version,
        compatibility: this.manifest.compatibility || {},
      }), 'utf8'));
    }

    return subZip.toBuffer();
  }

  // ──────────────────────────────────────────────────────────
  // 辅助
  // ──────────────────────────────────────────────────────────

  _readManifest() {
    const entry = this.zip.getEntry('upgrade-manifest.json');
    if (!entry) throw new Error('升级包缺少 upgrade-manifest.json');
    return JSON.parse(entry.getData().toString('utf8'));
  }

  _discoverAllSkills() {
    const dirs = new Set();
    for (const entry of this.zip.getEntries()) {
      // 匹配 skills/skills/<name>/ 或 skills/<name>/ 路径
      const m = entry.entryName.match(/^skills\/skills\/([^/]+)\//) ||
                entry.entryName.match(/^skills\/([^/]+)\//);
      if (m && m[1] !== 'upgrade-manifest.json') dirs.add(m[1]);
    }
    return Array.from(dirs).sort();
  }

  _buildSkillInfos() {
    const names = this._discoverAllSkills();
    return names.map((name) => {
      const comp = this.db.prepare('SELECT * FROM components WHERE name = ?').get(name);
      return {
        name,
        targetPath: path.join(this.cfg.skillsRoot, name),
        oldVersion: comp?.version || null,
        isNew: !comp,
        component: comp || null,
      };
    });
  }

  _checkDiskSpace(minBytes) {
    try {
      const { execSync } = require('child_process');
      const df = execSync(`df -k "${this.cfg.skillsRoot}" | tail -1`, { encoding: 'utf8', timeout: 5000 });
      const kb = parseInt(df.trim().split(/\s+/)[3], 10);
      if (kb && kb * 1024 < minBytes) {
        throw new Error(`磁盘空间不足: ${kb * 1024} < ${minBytes}`);
      }
    } catch (err) {
      if (err.message.includes('磁盘空间不足')) throw err;
    }
  }
}

module.exports = { FullStackUpgrader };
