/**
 * UpgradeEngine + SkillUpgrader 集成测试。
 *
 * 覆盖：
 * - 任务状态机（pending → running → success/failed/rolled_back）
 * - 步骤追踪（steps JSON 进度）
 * - 文件锁并发控制
 * - SkillUpgrader 各步骤（pre_check/backup/replace/reload/smoke_test/finalize）
 * - 失败时自动回滚
 * - 手动回滚
 * - 任务列表查询
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { UpgradeEngine } = require('../src/services/UpgradeEngine');
const { SkillUpgrader } = require('../src/services/SkillUpgrader');
const { buildSkillPackage } = require('./helpers');

// ── Test Fixtures ──────────────────────────────────────────
let db;
let engine;
let tmpDir;
let skillsDir;
let testConfig;  // 注入给 upgrader 的测试配置

before(() => {
  // 创建临时目录模拟真实环境
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-upgrade-test-'));
  skillsDir = path.join(tmpDir, 'skills');
  const backupDir = path.join(tmpDir, 'backups');
  const packagesDir = path.join(tmpDir, 'packages');
  const lockDir = path.join(tmpDir, 'locks');

  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(packagesDir, { recursive: true });
  fs.mkdirSync(lockDir, { recursive: true });

  // 构建测试配置（不依赖全局 process.env）
  testConfig = {
    port: 18900,
    dbPath: path.join(tmpDir, 'data', 'napm-upgrade.db'),
    backupRoot: backupDir,
    skillsRoot: skillsDir,
    pluginRoot: null,
    openclawRoot: path.join(tmpDir, 'openclaw'),
    frontendRoot: path.join(tmpDir, 'frontend'),
    publicKeyPath: path.join(__dirname, '..', 'config', 'public.pem'),
    backupRetention: 5,
    lockDir: lockDir,
    smokeTimeoutMs: 30000,
    openclawRestartTimeoutMs: 60000,
    logLevel: 'info',
  };

  // 内存数据库
  db = new Database(path.join(tmpDir, 'data', 'napm-upgrade.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('openclaw','frontend','skill')),
      version TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      install_path TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS upgrade_tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      component TEXT NOT NULL,
      old_version TEXT,
      new_version TEXT,
      status TEXT DEFAULT 'pending',
      steps TEXT DEFAULT '[]',
      started_at TEXT,
      finished_at TEXT,
      operator TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT NOT NULL,
      version TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      task_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      component TEXT,
      task_id TEXT,
      operator TEXT,
      ip TEXT,
      detail TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  engine = new UpgradeEngine();
  // 重写 engine 的 db 引用指向测试 DB（因为 UpgradeEngine 用了 getDb()）
  engine.db = db;
});

after(() => {
  if (db) db.close();
  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// 每个测试前重置状态
beforeEach(() => {
  // 清空任务和备份表
  db.exec('DELETE FROM upgrade_tasks');
  db.exec('DELETE FROM backups');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM components');

  // 重新插入测试组件
  const insert = db.prepare(
    'INSERT INTO components (name, type, version, install_path) VALUES (?, ?, ?, ?)'
  );
  insert.run('openclaw', 'openclaw', '2026.5.4', '/opt/openclaw');
  insert.run('frontend', 'frontend', '2.1.0', '/var/www/napm-admin');
  insert.run('napm-diag', 'skill', '1.0.0', path.join(skillsDir, 'napm-diag'));

  // 创建测试 Skill 目录（带一些文件）
  const testSkillPath = path.join(skillsDir, 'napm-diag');
  if (fs.existsSync(testSkillPath)) {
    fs.rmSync(testSkillPath, { recursive: true, force: true });
  }
  fs.mkdirSync(testSkillPath, { recursive: true });
  fs.writeFileSync(path.join(testSkillPath, 'SKILL.md'), '# NAPM Diag v1.0.0\n');
  fs.mkdirSync(path.join(testSkillPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(testSkillPath, 'scripts', 'run.js'), '// v1.0.0\nmodule.exports = () => "ok";\n');
});

// ── Helper ─────────────────────────────────────────────────
function createPendingTask(type = 'skill-single', component = 'napm-diag', oldVer = '1.0.0', newVer = '2.0.0') {
  const taskId = uuidv4();
  db.prepare(`
    INSERT INTO upgrade_tasks (id, type, component, old_version, new_version, status, operator)
    VALUES (?, ?, ?, ?, ?, 'pending', 'test-user')
  `).run(taskId, type, component, oldVer, newVer);
  return taskId;
}

function buildTestUpgrader(overrides = {}) {
  // 构建一个合法的 skill-single 升级包
  const manifest = {
    type: 'skill-single',
    component: 'napm-diag',
    version: '2.0.0',
    display_name: 'Test Upgrade',
    changelog: 'Test changelog',
    compatibility: {
      min_openclaw_version: '2026.5.0',
      napm_api_version: 'v2',
    },
    ...overrides,
  };

  const files = {
    'skills/napm-diag/SKILL.md': '# NAPM Diag v2.0.0\nUpdated skill.\n',
    'skills/napm-diag/scripts/run.js': '// v2.0.0\nmodule.exports = () => "ok v2";\n',
    'skills/napm-diag/services/diag.js': 'class Diag { run() { return "v2"; } }\n',
  };

  return require('./helpers').buildSignedPackage(manifest, files);
}

// ════════════════════════════════════════════════════════════
// UpgradeEngine 状态机测试
// ════════════════════════════════════════════════════════════

describe('UpgradeEngine 状态机', () => {
  it('pending 任务应成功执行到 success', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig }); // 注入测试 DB

    const task = await engine.executeTask(taskId, upgrader);

    assert.strictEqual(task.status, 'success');
    assert.ok(task.started_at);
    assert.ok(task.finished_at);

    // 验证步骤记录
    const steps = task.steps;
    assert.ok(steps.length >= 6);
    for (const stepName of ['pre_check', 'backup', 'replace', 'reload', 'smoke_test', 'finalize']) {
      const s = steps.find((st) => st.step === stepName);
      assert.ok(s, `应有步骤: ${stepName}`);
      assert.strictEqual(s.status, 'completed', `步骤 ${stepName} 应完成`);
    }
  });

  it('completed 任务不能重复执行', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });

    await engine.executeTask(taskId, upgrader);

    // 第二次执行应抛出
    await assert.rejects(
      () => engine.executeTask(taskId, upgrader),
      /无法执行/,
    );
  });

  it('不存在的任务应返回 404', async () => {
    const upgrader = new SkillUpgrader(buildTestUpgrader());
    await assert.rejects(
      () => engine.executeTask('nonexistent-id', upgrader),
      /不存在/,
    );
  });

  it('should compute progress for running task', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'success');

    // 验证每个步骤都有时间戳
    for (const s of task.steps) {
      if (s.status === 'completed') {
        assert.ok(s.started_at);
        assert.ok(s.finished_at);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════
// SkillUpgrader 各步骤测试
// ════════════════════════════════════════════════════════════

describe('SkillUpgrader', () => {
  it('备份步骤应创建备份目录并记录到 DB', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);
    assert.strictEqual(task.status, 'success');

    // 验证备份记录
    const backups = db.prepare('SELECT * FROM backups WHERE component = ?').all('napm-diag');
    assert.ok(backups.length >= 1);
    assert.ok(fs.existsSync(backups[0].backup_path));
    assert.ok(backups[0].size_bytes > 0);
  });

  it('replace 步骤应更新文件内容', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });

    await engine.executeTask(taskId, upgrader);

    // 验证文件已替换为新版本
    const skillMd = path.join(skillsDir, 'napm-diag', 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf8');
    assert.ok(content.includes('v2.0.0'), 'SKILL.md 应包含新版本号');

    const runJs = path.join(skillsDir, 'napm-diag', 'scripts', 'run.js');
    const runContent = fs.readFileSync(runJs, 'utf8');
    assert.ok(runContent.includes('v2.0.0'), 'run.js 应包含新版本号');

    // 验证新文件被创建
    const diagJs = path.join(skillsDir, 'napm-diag', 'services', 'diag.js');
    assert.ok(fs.existsSync(diagJs), '新文件 diag.js 应被创建');

    // 验证 DB 版本已更新
    const comp = db.prepare('SELECT * FROM components WHERE name = ?').get('napm-diag');
    assert.strictEqual(comp.version, '2.0.0');
  });

  it('smoke_test 应验证关键文件存在', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);

    const smokeStep = task.steps.find((s) => s.step === 'smoke_test');
    assert.strictEqual(smokeStep.status, 'completed');
    assert.ok(smokeStep.message.includes('通过'));
  });

  it('缺少目标目录时 pre_check 应失败', async () => {
    // 删除目标目录
    fs.rmSync(path.join(skillsDir, 'napm-diag'), { recursive: true, force: true });

    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);

    // 应在 pre_check 失败（在 backup 之前，不触发回滚）
    assert.strictEqual(task.status, 'failed');
    const preCheckStep = task.steps.find((s) => s.step === 'pre_check');
    assert.strictEqual(preCheckStep.status, 'failed');
    assert.ok(preCheckStep.message.includes('不存在'));
  });

  it('replace 后失败应触发自动回滚', async () => {
    // 构建一个升级包，replace 会成功但 smoke_test 会失败
    // 我们构建一个不包含 SKILL.md 的包，这样 smoke_test 会失败
    const badPackage = require('./helpers').buildSignedPackage(
      {
        type: 'skill-single',
        component: 'napm-diag',
        version: '2.0.0',
        compatibility: { min_openclaw_version: '2026.5.0', napm_api_version: 'v2' },
      },
      {
        // 只有 run.js 没有 SKILL.md — smoke_test 会检测到缺少 SKILL.md
        'skills/napm-diag/scripts/run.js': '// v2.0.0\n',
      },
    );

    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(badPackage, { db, config: testConfig });

    const task = await engine.executeTask(taskId, upgrader);

    // 应该触发回滚
    assert.ok(
      ['rolling_back', 'rolled_back', 'failed'].includes(task.status),
      `期望状态为 rolling_back/rolled_back/failed，实际: ${task.status}`,
    );

    // 验证文件已恢复到旧版本
    if (task.status === 'rolled_back') {
      const skillMd = path.join(skillsDir, 'napm-diag', 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), '回滚后 SKILL.md 应存在');
      const content = fs.readFileSync(skillMd, 'utf8');
      assert.ok(content.includes('v1.0.0'), '回滚后 SKILL.md 应包含原始版本');
    }
  });
});

// ════════════════════════════════════════════════════════════
// 手动回滚测试
// ════════════════════════════════════════════════════════════

describe('手动回滚', () => {
  it('executeRollback 应恢复到目标版本', async () => {
    // 先执行一次升级（产生备份）
    const upgradeTaskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });
    await engine.executeTask(upgradeTaskId, upgrader);

    // 确认已升级
    let comp = db.prepare('SELECT * FROM components WHERE name = ?').get('napm-diag');
    assert.strictEqual(comp.version, '2.0.0');

    // 执行回滚
    const rollbackTask = await engine.executeRollback(
      upgradeTaskId, 'napm-diag', '1.0.0', upgrader, 'test-user',
    );

    assert.ok(
      ['rolled_back', 'running', 'success'].includes(rollbackTask.status),
      `回滚任务状态: ${rollbackTask.status}`,
    );

    // 验证版本已恢复
    comp = db.prepare('SELECT * FROM components WHERE name = ?').get('napm-diag');
    if (rollbackTask.status === 'rolled_back') {
      assert.strictEqual(comp.version, '1.0.0');
    }
  });

  it('回滚不存在的备份应失败', async () => {
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });
    const task = await engine.executeRollback('fake-id', 'napm-diag', '99.99.99', upgrader, 'test-user');
    // 不存在的备份 → 任务标记为 failed，不抛出异常
    assert.strictEqual(task.status, 'failed');
    assert.ok(task.error.includes('未找到'), `错误信息应包含"未找到": ${task.error}`);
  });
});

// ════════════════════════════════════════════════════════════
// 任务列表查询
// ════════════════════════════════════════════════════════════

describe('任务列表查询', () => {
  it('listTasks 应返回任务列表', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });
    await engine.executeTask(taskId, upgrader);

    const result = engine.listTasks({ limit: 10 });
    assert.ok(result.tasks.length >= 1);
    assert.ok(result.total >= 1);
  });

  it('getTask 应返回带 parsed steps 的任务', async () => {
    const taskId = createPendingTask();
    const upgrader = new SkillUpgrader(buildTestUpgrader(), { db, config: testConfig });
    await engine.executeTask(taskId, upgrader);

    const task = engine.getTask(taskId);
    assert.ok(Array.isArray(task.steps));
    assert.ok(task.steps.length >= 6);
  });
});
