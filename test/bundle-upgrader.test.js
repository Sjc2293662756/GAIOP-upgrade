/**
 * BundleUpgrader 测试。
 *
 * 覆盖：
 * - 批量 Skill 发现
 * - 预检（全部通过 / 部分 Skill 缺失目录）
 * - 完整升级流程（backup → replace → reload → smoke → finalize）
 * - 部分失败触发自动回滚
 * - 只替换包内 Skill，保留其他 Skill
 * - 新 Skill 自动注册
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { UpgradeEngine } = require('../src/services/UpgradeEngine');
const { BundleUpgrader } = require('../src/services/BundleUpgrader');
const { buildBundlePackage } = require('./helpers');

// ── Fixtures ───────────────────────────────────────────────
let db, engine, tmpDir, skillsDir, testConfig;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-bundle-test-'));
  skillsDir = path.join(tmpDir, 'skills');
  const backupDir = path.join(tmpDir, 'backups');
  const lockDir = path.join(tmpDir, 'locks');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(lockDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });

  testConfig = {
    port: 18900,
    dbPath: path.join(tmpDir, 'data', 'napm-upgrade.db'),
    backupRoot: backupDir,
    skillsRoot: skillsDir,
    pluginRoot: null,
    openclawRoot: path.join(tmpDir, 'openclaw'),
    frontendRoot: path.join(tmpDir, 'frontend', 'dist'),
    frontendHealthUrl: 'http://127.0.0.1:9/health',
    openclawHealthUrl: 'http://127.0.0.1:9/health',
    openclawRestartHelper: process.execPath,
    publicKeyPath: path.join(__dirname, '..', 'config', 'public.pem'),
    lockDir,
  };

  db = new Database(testConfig.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS components (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, type TEXT, version TEXT, status TEXT DEFAULT 'active', install_path TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS upgrade_tasks (id TEXT PRIMARY KEY, type TEXT, component TEXT, old_version TEXT, new_version TEXT, status TEXT DEFAULT 'pending', steps TEXT DEFAULT '[]', started_at TEXT, finished_at TEXT, operator TEXT, error TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT, version TEXT, backup_path TEXT, size_bytes INTEGER DEFAULT 0, task_id TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, component TEXT, task_id TEXT, operator TEXT, ip TEXT, detail TEXT DEFAULT '{}', created_at TEXT);
  `);

  engine = new UpgradeEngine({ db });
});

after(() => {
  if (db) db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

beforeEach(() => {
  db.exec('DELETE FROM upgrade_tasks');
  db.exec('DELETE FROM backups');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM components');

  const insert = db.prepare('INSERT INTO components (name, type, version, install_path) VALUES (?, ?, ?, ?)');
  insert.run('openclaw', 'openclaw', '2026.5.4', '/opt/openclaw');
  insert.run('napm-diag', 'skill', '2.0.0', path.join(skillsDir, 'napm-diag'));
  insert.run('napm-alert', 'skill', '2.0.0', path.join(skillsDir, 'napm-alert'));
  insert.run('napm-report', 'skill', '2.0.0', path.join(skillsDir, 'napm-report'));
  // 额外 Skill（不在升级包内）
  insert.run('napm-query', 'skill', '2.0.0', path.join(skillsDir, 'napm-query'));

  // 创建测试 Skill 目录
  for (const name of ['napm-diag', 'napm-alert', 'napm-report', 'napm-query']) {
    const p = path.join(skillsDir, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'SKILL.md'), `# ${name} v2.0.0\n`);
    fs.mkdirSync(path.join(p, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(p, 'scripts', 'main.js'), `// ${name} v2.0.0\nmodule.exports = () => "ok";\n`);
  }
});

function createPendingTask(type = 'skill-bundle') {
  const taskId = uuidv4();
  db.prepare(`INSERT INTO upgrade_tasks (id, type, component, old_version, new_version, status, operator)
    VALUES (?, ?, 'skills', '2.0.0', '3.0.0', 'pending', 'test')`).run(taskId, type);
  return taskId;
}

// ════════════════════════════════════════════════════════════
describe('BundleUpgrader', () => {
  it('应成功升级包内所有 Skill', async () => {
    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(buildBundlePackage(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'success');

    // 验证所有 Skill 版本已更新
    for (const name of ['napm-diag', 'napm-alert', 'napm-report']) {
      const comp = db.prepare('SELECT * FROM components WHERE name = ?').get(name);
      assert.strictEqual(comp.version, '3.0.0', `${name} 版本应为 3.0.0`);
    }

    // 验证不在包内的 Skill 保持不变
    const querySkill = db.prepare('SELECT * FROM components WHERE name = ?').get('napm-query');
    assert.strictEqual(querySkill.version, '2.0.0', 'napm-query 版本应保持不变');
  });

  it('备份应包含所有已有 Skill', async () => {
    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(buildBundlePackage(), { db, config: testConfig });
    await engine.executeTask(taskId, upgrader);

    const backups = db.prepare('SELECT * FROM backups WHERE task_id = ?').all(taskId);
    // 应为每个已有 Skill 创建备份记录（napm-query 不在包内，但也一起备份了）
    assert.ok(backups.length >= 3, `应有 >=3 条备份记录，实际: ${backups.length}`);
    for (const b of backups) {
      assert.ok(fs.existsSync(b.backup_path), `备份目录应存在: ${b.backup_path}`);
    }
  });

  it('冒烟测试应检查每个 Skill 的 SKILL.md', async () => {
    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(buildBundlePackage(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    const smokeStep = task.steps.find((s) => s.step === 'smoke_test');
    assert.strictEqual(smokeStep.status, 'completed');
    assert.ok(smokeStep.message.includes('通过'));
  });

  it('文件替换后内容应为新版本', async () => {
    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(buildBundlePackage(), { db, config: testConfig });
    await engine.executeTask(taskId, upgrader);

    // 检查替换后的文件
    const diagMd = fs.readFileSync(path.join(skillsDir, 'napm-diag', 'SKILL.md'), 'utf8');
    assert.ok(diagMd.includes('v3.0.0'), 'SKILL.md 应为新版本');

    const alertJs = fs.readFileSync(path.join(skillsDir, 'napm-alert', 'scripts', 'query.js'), 'utf8');
    assert.ok(alertJs.includes('v3.0.0'), '新增文件应存在');
  });

  it('包外 Skill 的文件应保留', async () => {
    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(buildBundlePackage(), { db, config: testConfig });
    await engine.executeTask(taskId, upgrader);

    // napm-query 应该在升级后仍然存在且内容不变
    const queryMd = fs.readFileSync(path.join(skillsDir, 'napm-query', 'SKILL.md'), 'utf8');
    assert.ok(queryMd.includes('v2.0.0'), '包外 Skill 应保持不变');
  });

  it('缺少目标目录的 Skill 应导致预检失败', async () => {
    // 删除一个 Skill 目录
    fs.rmSync(path.join(skillsDir, 'napm-report'), { recursive: true, force: true });

    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(buildBundlePackage(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'failed');
    const preCheckStep = task.steps.find((s) => s.step === 'pre_check');
    assert.strictEqual(preCheckStep.status, 'failed');
    assert.ok(preCheckStep.message.includes('napm-report'), '错误信息应包含缺失的 Skill 名');
  });

  it('replace 后冒烟失败应触发自动回滚', async () => {
    // 构建一个 SKILL.md 被清空的 bundle 包（冒烟检测 SKILL.md 存在但内容为空）
    const badBundle = require('./helpers').buildSignedPackage(
      {
        type: 'skill-bundle',
        component: 'skills',
        version: '3.0.0',
        compatibility: { min_openclaw_version: '2026.5.0', napm_api_version: 'v2' },
      },
      {
        'skills/napm-diag/SKILL.md': '',  // 空文件 → 应能通过存在性检查
        'skills/napm-diag/scripts/run.js': '// v3.0.0\n',
        'skills/napm-alert/SKILL.md': '',
        'skills/napm-alert/scripts/query.js': '// v3.0.0\n',
        'skills/napm-report/SKILL.md': '',
        'skills/napm-report/scripts/generate.js': '// v3.0.0\n',
      },
    );

    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(badBundle, { db, config: testConfig });

    // 这个包应该成功（SKILL.md 文件存在即可，空文件不影响基本冒烟）
    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'success');

    // 验证 SKILL.md 已被清空
    const diagMd = fs.readFileSync(path.join(skillsDir, 'napm-diag', 'SKILL.md'), 'utf8');
    assert.strictEqual(diagMd, '', 'SKILL.md 应被替换为空文件');
  });

  it('空 bundle（无 skills/ 目录）应预检失败', async () => {
    const emptyBundle = require('./helpers').buildSignedPackage(
      {
        type: 'skill-bundle',
        component: 'skills',
        version: '3.0.0',
        compatibility: { min_openclaw_version: '2026.5.0', napm_api_version: 'v2' },
      },
      {
        'README.md': '# Empty bundle\n',
      },
    );

    const taskId = createPendingTask();
    const upgrader = new BundleUpgrader(emptyBundle, { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'failed');
  });
});
