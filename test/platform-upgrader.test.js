/**
 * OpenClawUpgrader + FrontendUpgrader 测试。
 *
 * 覆盖：
 * - Frontend: 首次部署、正常升级、rollback
 * - OpenClaw: pre_check、backup（跳过 systemctl 操作）
 * - 两种类型通过 UpgradeEngine 编排
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { UpgradeEngine } = require('../src/services/UpgradeEngine');
const { FrontendUpgrader } = require('../src/services/FrontendUpgrader');
const { buildFrontendPackage } = require('./helpers');

// ── Fixtures ───────────────────────────────────────────────
let db, engine, tmpDir, testConfig;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-platform-test-'));
  for (const d of ['data', 'backups', 'locks', 'frontend', 'openclaw']) {
    fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
  }

  testConfig = {
    port: 18900,
    dbPath: path.join(tmpDir, 'data', 'napm-upgrade.db'),
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
    openclawRestartTimeoutMs: 5000,
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
  insert.run('openclaw', 'openclaw', '2026.5.4', testConfig.openclawRoot);
  insert.run('frontend', 'frontend', '2.1.0', testConfig.frontendRoot);

  // 创建前端目录及旧文件
  const fe = testConfig.frontendRoot;
  if (fs.existsSync(fe)) fs.rmSync(fe, { recursive: true, force: true });
  fs.mkdirSync(fe, { recursive: true });
  fs.writeFileSync(path.join(fe, 'index.html'), '<html><body>v2.1.0</body></html>\n');
  fs.mkdirSync(path.join(fe, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(fe, 'assets', 'app.js'), '// v2.1.0\n');

  // 创建 OpenClaw 目录及模拟文件
  const oc = testConfig.openclawRoot;
  if (fs.existsSync(oc)) fs.rmSync(oc, { recursive: true, force: true });
  fs.mkdirSync(oc, { recursive: true });
  fs.writeFileSync(path.join(oc, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.5.4' }));
  fs.mkdirSync(path.join(oc, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(oc, 'dist', 'index.js'), '// openclaw v2026.5.4\n');
});

function createTask(type, component, oldVer, newVer) {
  const id = uuidv4();
  db.prepare("INSERT INTO upgrade_tasks (id, type, component, old_version, new_version, status, operator) VALUES (?, ?, ?, ?, ?, 'pending', 'test')")
    .run(id, type, component, oldVer, newVer);
  return id;
}

// ════════════════════════════════════════════════════════════
// FrontendUpgrader
// ════════════════════════════════════════════════════════════

describe('FrontendUpgrader', () => {
  it('应成功升级前端到新版本', async () => {
    const taskId = createTask('frontend', 'frontend', '2.1.0', '2.2.0');
    const upgrader = new FrontendUpgrader(buildFrontendPackage(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'success');

    // 验证文件已替换
    const indexHtml = fs.readFileSync(path.join(testConfig.frontendRoot, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('NAPM Admin'), 'index.html 应为新版本');

    const css = fs.readFileSync(path.join(testConfig.frontendRoot, 'assets', 'style.css'), 'utf8');
    assert.ok(css.includes('margin: 0'), '新文件 style.css 应存在');

    // 验证 DB 版本
    const comp = db.prepare("SELECT * FROM components WHERE name = 'frontend'").get();
    assert.strictEqual(comp.version, '2.2.0');
  });

  it('首次部署应成功（frontend 目录为空）', async () => {
    // 清空前端目录 + 删除 DB 记录
    db.exec("DELETE FROM components WHERE name = 'frontend'");
    const fe = testConfig.frontendRoot;
    fs.rmSync(fe, { recursive: true, force: true });
    fs.mkdirSync(fe, { recursive: true });

    const taskId = createTask('frontend', 'frontend', null, '2.2.0');
    const upgrader = new FrontendUpgrader(buildFrontendPackage(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'success');

    // 验证组件已注册
    const comp = db.prepare("SELECT * FROM components WHERE name = 'frontend'").get();
    assert.strictEqual(comp.version, '2.2.0');
    assert.ok(fs.existsSync(path.join(fe, 'index.html')));
  });

  it('smoke_test 失败（无 index.html）应触发回滚', async () => {
    // 构建一个不含 index.html 的前端包
    const badPackage = require('./helpers').buildSignedPackage(
      { type: 'frontend', component: 'frontend', version: '2.2.0', compatibility: { min_openclaw_version: '2026.5.0' } },
      { 'dist/assets/app.js': '// v2.2.0\n' },
    );

    const taskId = createTask('frontend', 'frontend', '2.1.0', '2.2.0');
    const upgrader = new FrontendUpgrader(badPackage, { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    // 冒烟失败 → 自动回滚
    assert.ok(['rolled_back', 'failed'].includes(task.status), `期望回滚，实际: ${task.status}`);

    // 验证版本已恢复
    if (task.status === 'rolled_back') {
      const comp = db.prepare("SELECT * FROM components WHERE name = 'frontend'").get();
      assert.strictEqual(comp.version, '2.1.0');
    }
  });
});

// ════════════════════════════════════════════════════════════
// OpenClawUpgrader（有限测试——跳过 systemctl）
// ════════════════════════════════════════════════════════════

describe('OpenClawUpgrader', () => {
  it('pre_check 应验证 OpenClaw 目录和 DB 注册', async () => {
    const upgrader = new (require('../src/services/OpenClawUpgrader').OpenClawUpgrader)(
      require('./helpers').buildOpenClawPackage(),
      { db, config: testConfig },
    );

    const ctx = { task: { id: 'test', component: 'openclaw' }, state: {} };
    const result = await upgrader.preCheck(ctx);
    assert.ok(result.message.includes('2026.5.4'));
    assert.strictEqual(ctx.state.targetPath, testConfig.openclawRoot);
  });

  it('OpenClaw 目录不存在时 pre_check 应失败', async () => {
    fs.rmSync(testConfig.openclawRoot, { recursive: true, force: true });

    const upgrader = new (require('../src/services/OpenClawUpgrader').OpenClawUpgrader)(
      require('./helpers').buildOpenClawPackage(),
      { db, config: testConfig },
    );

    assert.throws(
      () => upgrader.preCheck({ task: {}, state: {} }),
      /目录不存在/,
    );
  });

  it('未注册时 pre_check 应失败', async () => {
    db.exec("DELETE FROM components WHERE name = 'openclaw'");

    const upgrader = new (require('../src/services/OpenClawUpgrader').OpenClawUpgrader)(
      require('./helpers').buildOpenClawPackage(),
      { db, config: testConfig },
    );

    assert.throws(
      () => upgrader.preCheck({ task: {}, state: {} }),
      /未在数据库中注册/,
    );
  });

  it('backup 应备份 openclaw 目录并记录', async () => {
    const upgrader = new (require('../src/services/OpenClawUpgrader').OpenClawUpgrader)(
      require('./helpers').buildOpenClawPackage(),
      { db, config: testConfig },
    );

    const ctx = { task: { id: 'test', component: 'openclaw' }, state: { component: { version: '2026.5.4' }, targetPath: testConfig.openclawRoot } };
    const result = await upgrader.backup(ctx);

    assert.ok(result.backupPath);
    assert.ok(fs.existsSync(result.backupPath));
    assert.ok(result.sizeBytes > 0);

    // 验证备份记录
    const record = db.prepare('SELECT * FROM backups WHERE component = ?').get('openclaw');
    assert.ok(record);
  });
});
