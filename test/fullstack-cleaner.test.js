/**
 * FullStackUpgrader + BackupCleaner 测试。
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { UpgradeEngine } = require('../src/services/UpgradeEngine');
const { FullStackUpgrader } = require('../src/services/FullStackUpgrader');
const backupCleaner = require('../src/services/BackupCleaner');
const { buildFullStackPackage } = require('./helpers');

// ── Fixtures ───────────────────────────────────────────────
let db, engine, tmpDir, testConfig;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-fullstack-test-'));
  for (const d of ['data', 'backups', 'locks', 'frontend', 'openclaw', 'skills']) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
  }

  testConfig = {
    port: 18900, dbPath: path.join(tmpDir, 'data', 'db'),
    backupRoot: path.join(tmpDir, 'backups'),
    skillsRoot: path.join(tmpDir, 'skills'),
    pluginRoot: null,
    openclawRoot: path.join(tmpDir, 'openclaw'),
    frontendRoot: path.join(tmpDir, 'frontend', 'dist'),
    frontendHealthUrl: 'http://127.0.0.1:9/health',
    openclawHealthUrl: 'http://127.0.0.1:9/health',
    openclawRestartHelper: process.execPath,
    publicKeyPath: path.join(__dirname, '..', 'config', 'public.pem'),
    lockDir: path.join(tmpDir, 'locks'),
    openclawRestartTimeoutMs: 2000,
    backupRetention: 3,
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
  for (const t of ['upgrade_tasks', 'backups', 'audit_log', 'components']) {
    db.exec(`DELETE FROM ${t}`);
  }

  const insert = db.prepare('INSERT INTO components (name, type, version, install_path) VALUES (?, ?, ?, ?)');
  insert.run('openclaw', 'openclaw', '2026.5.4', testConfig.openclawRoot);
  insert.run('frontend', 'frontend', '3.0.0', testConfig.frontendRoot);
  insert.run('napm-diag', 'skill', '3.0.0', path.join(testConfig.skillsRoot, 'napm-diag'));
  insert.run('napm-alert', 'skill', '3.0.0', path.join(testConfig.skillsRoot, 'napm-alert'));

  // 创建测试目录和文件
  for (const [dir, files] of [
    [testConfig.openclawRoot, ['dist/index.js', 'package.json']],
    [testConfig.frontendRoot, ['index.html', 'assets/app.js']],
  ]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const fp = path.join(dir, f);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, `// old version\n`);
    }
  }

  for (const name of ['napm-diag', 'napm-alert']) {
    const p = path.join(testConfig.skillsRoot, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'SKILL.md'), `# ${name} v3.0.0\n`);
    fs.mkdirSync(path.join(p, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(p, 'scripts', 'main.js'), '// v3.0.0\n');
  }
});

function createTask() {
  const id = uuidv4();
  db.prepare("INSERT INTO upgrade_tasks (id, type, component, old_version, new_version, status, operator) VALUES (?, 'full-stack', 'all', '3.0.0', '4.0.0', 'pending', 'test')").run(id);
  return id;
}

// ════════════════════════════════════════════════════════════

describe('FullStackUpgrader', () => {
  it('pre_check 应验证所有目标目录', async () => {
    const upgrader = new FullStackUpgrader(buildFullStackPackage(), { db, config: testConfig });
    const ctx = { task: { id: 'test' }, state: {} };
    const result = await upgrader.preCheck(ctx);
    assert.ok(result.message.includes('全栈预检查通过'));
  });

  it('pre_check 应检测缺失目录', () => {
    fs.rmSync(testConfig.openclawRoot, { recursive: true, force: true });
    const upgrader = new FullStackUpgrader(buildFullStackPackage(), { db, config: testConfig });
    assert.throws(
      () => upgrader.preCheck({ task: {}, state: {} }),
      /目录缺失/,
    );
  });

  it('backup 应为所有组件创建备份', async () => {
    const upgrader = new FullStackUpgrader(buildFullStackPackage(), { db, config: testConfig });
    const ctx = { task: { id: 'test' }, state: { components: {} } };

    // 先预检以初始化状态
    await upgrader.preCheck(ctx);
    const result = await upgrader.backup(ctx);
    assert.ok(result.message.includes('openclaw'));
    assert.ok(result.message.includes('frontend'));

    // 验证备份记录
    const backups = db.prepare('SELECT DISTINCT component FROM backups').all();
    assert.ok(backups.length >= 2, `期望 >=2 个组件有备份，实际: ${backups.length}`);
  });
});

// ════════════════════════════════════════════════════════════

describe('BackupCleaner', () => {
  it('应保留最近 N 个备份，删除多余的', () => {
    // 创建 5 个备份
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      const backupDir = path.join(testConfig.backupRoot, 'test', `backup_${i}`);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'data.txt'), `backup ${i}`);
      const t = new Date(now.getTime() - i * 86400000).toISOString(); // 每天一个
      db.prepare("INSERT INTO backups (component, version, backup_path, size_bytes, created_at) VALUES ('test-skill', ?, ?, 100, ?)")
        .run(`1.${i}.0`, backupDir, t);
    }

    // 执行清理（保留最近 3 个）
    const result = backupCleaner.run(3, db);
    assert.strictEqual(result.removed, 2);

    // 验证只剩 3 个
    const remaining = db.prepare("SELECT * FROM backups WHERE component = 'test-skill' ORDER BY created_at DESC").all();
    assert.strictEqual(remaining.length, 3);
    // 最近的是 backup_0（今天）
    assert.ok(remaining[0].backup_path.includes('backup_0'));
  });

  it('备份数 <= 保留数时不删除', () => {
    const backupDir = path.join(testConfig.backupRoot, 'test2', 'only');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'data.txt'), 'only one');
    db.prepare("INSERT INTO backups (component, version, backup_path, size_bytes) VALUES ('test-skill2', '1.0.0', ?, 100)")
      .run(backupDir);

    const result = backupCleaner.run(null, db);
    assert.strictEqual(result.removed, 0);
  });
});

// ════════════════════════════════════════════════════════════

describe('CLI 打包工具', () => {
  it('tools/package.js --help 应输出帮助信息', () => {
    const { execSync } = require('child_process');
    const out = execSync('node tools/package.js --help', { encoding: 'utf8' });
    assert.ok(out.includes('NAPM 升级包打包工具'));
    assert.ok(out.includes('skill'));
    assert.ok(out.includes('bundle'));
  });
});
