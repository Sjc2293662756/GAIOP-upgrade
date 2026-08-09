const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { runSqliteBackup, verifyBackupRestore } = require('../src/services/SqliteBackupService');

const NOW = Date.parse('2026-08-10T03:00:00.000Z');

function setup(databaseName = 'upgrade.db') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-sqlite-backup-'));
  const databasePath = path.join(root, databaseName);
  const backupRoot = path.join(root, 'backups');
  const temporaryRoot = path.join(root, 'restore-tests');
  const lockPath = path.join(root, 'run', 'backup.lock');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('user_version = 9');
  db.exec('CREATE TABLE upgrade_tasks (id TEXT PRIMARY KEY, status TEXT, private_note TEXT)');
  db.prepare('INSERT INTO upgrade_tasks VALUES (?, ?, ?)').run('task-1', 'success', 'SECRET-UPGRADE-CONTENT');
  db.close();
  return {
    root, databasePath, backupRoot, temporaryRoot, lockPath,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function options(context, now, extra = {}) {
  return {
    component: 'upgrade',
    allowedDatabaseNames: ['upgrade.db', 'napm-upgrade.db'],
    databasePath: context.databasePath,
    backupRoot: context.backupRoot,
    lockPath: context.lockPath,
    createEnabled: true,
    cleanupEnabled: false,
    now,
    ...extra,
  };
}

test('upgrade database uses an online verified snapshot and safe manifest projection', async () => {
  const context = setup();
  try {
    const result = await runSqliteBackup(options(context, NOW));
    assert.equal(result.ok, true);
    assert.deepEqual(result.created.map((item) => item.tier), ['daily', 'weekly', 'monthly']);
    const manifests = fs.readdirSync(context.backupRoot).filter((name) => name.endsWith('.manifest.json'));
    assert.equal(manifests.length, 3);
    for (const name of manifests) {
      const text = fs.readFileSync(path.join(context.backupRoot, name), 'utf8');
      assert.doesNotMatch(text, /SECRET-UPGRADE-CONTENT/);
      const manifest = JSON.parse(text);
      assert.equal(manifest.component, 'upgrade');
      assert.equal(manifest.databaseVersion.userVersion, 9);
      assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    }
  } finally { context.close(); }
});

test('upgrade restore verification stays in its temporary directory and passes integrity check', async () => {
  const context = setup();
  try {
    await runSqliteBackup(options(context, NOW));
    const backupFile = path.join(context.backupRoot, 'upgrade-daily-2026-08-10.sqlite3');
    const before = fs.readFileSync(backupFile);
    const productionBefore = fs.readFileSync(context.databasePath);
    const result = await verifyBackupRestore({ backupFile, backupRoot: context.backupRoot, temporaryRoot: context.temporaryRoot, component: 'upgrade' });
    assert.equal(result.status, 'verified');
    assert.deepEqual(fs.readFileSync(backupFile), before);
    assert.deepEqual(fs.readFileSync(context.databasePath), productionBefore);
    assert.deepEqual(fs.readdirSync(context.temporaryRoot), []);
    fs.writeFileSync(backupFile, Buffer.concat([before, Buffer.from('damaged')]));
    await assert.rejects(
      verifyBackupRestore({ backupFile, backupRoot: context.backupRoot, temporaryRoot: context.temporaryRoot, component: 'upgrade' }),
      (error) => error.code === 'manifest_mismatch',
    );
  } finally { context.close(); }
});

test('daily, weekly and monthly expiry boundaries are independent', async () => {
  const context = setup();
  try {
    for (const time of [
      Date.parse('2025-07-01T03:00:00Z'),
      Date.parse('2026-05-11T03:00:00Z'),
      Date.parse('2026-07-11T03:00:00Z'),
      Date.parse('2026-07-12T03:00:00Z'),
    ]) await runSqliteBackup(options(context, time));
    const result = await runSqliteBackup(options(context, NOW, { cleanupEnabled: true }));
    assert.equal(result.cleanup.status, 'completed');
    assert.equal(fs.existsSync(path.join(context.backupRoot, 'upgrade-daily-2026-07-11.sqlite3')), false);
    assert.equal(fs.existsSync(path.join(context.backupRoot, 'upgrade-daily-2026-07-12.sqlite3')), true);
    assert.equal(fs.existsSync(path.join(context.backupRoot, 'upgrade-weekly-2026-W20.sqlite3')), false);
    assert.equal(fs.existsSync(path.join(context.backupRoot, 'upgrade-monthly-2026-05.sqlite3')), true);
    assert.equal(fs.existsSync(path.join(context.backupRoot, 'upgrade-monthly-2025-07.sqlite3')), false);
  } finally { context.close(); }
});

test('failed new backup preserves every old backup and supports retry', async () => {
  const context = setup();
  try {
    await runSqliteBackup(options(context, Date.parse('2025-07-01T03:00:00Z')));
    const oldBackup = path.join(context.backupRoot, 'upgrade-daily-2025-07-01.sqlite3');
    const failed = await runSqliteBackup(options(context, NOW, {
      cleanupEnabled: true,
      snapshot: async () => { const error = new Error('private'); error.code = 'snapshot_failed'; throw error; },
    }));
    assert.equal(failed.ok, false);
    assert.equal(failed.cleanup.status, 'not_run');
    assert.equal(fs.existsSync(oldBackup), true);
    assert.equal((await runSqliteBackup(options(context, NOW, { cleanupEnabled: true }))).ok, true);
    assert.equal(fs.existsSync(oldBackup), false);
  } finally { context.close(); }
});

test('cleanup defaults off, corrupt pairs remain protected, and Admin database names are rejected', async () => {
  const context = setup();
  try {
    await runSqliteBackup(options(context, Date.parse('2025-07-01T03:00:00Z')));
    const oldBackup = path.join(context.backupRoot, 'upgrade-daily-2025-07-01.sqlite3');
    const disabled = await runSqliteBackup(options(context, NOW));
    assert.equal(disabled.cleanup.status, 'disabled');
    assert.equal(fs.existsSync(oldBackup), true);
    fs.writeFileSync(path.join(context.backupRoot, 'upgrade-daily-2025-07-01.manifest.json'), '{"damaged":true}');
    const cleanup = await runSqliteBackup(options(context, NOW + 86400000, { cleanupEnabled: true }));
    assert.equal(cleanup.cleanup.failed, 1);
    assert.equal(fs.existsSync(oldBackup), true);
  } finally { context.close(); }

  const rejected = setup('wizard.db');
  try {
    const result = await runSqliteBackup(options(rejected, NOW));
    assert.equal(result.code, 'database_name_rejected');
    assert.equal(fs.existsSync(rejected.backupRoot), false);
  } finally { rejected.close(); }
});

test('create switch disables all database access and cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-sqlite-disabled-'));
  try {
    const result = await runSqliteBackup({
      component: 'upgrade', allowedDatabaseNames: ['upgrade.db'], databasePath: path.join(root, 'upgrade.db'),
      backupRoot: path.join(root, 'backups'), lockPath: path.join(root, 'lock'), createEnabled: false, cleanupEnabled: true,
    });
    assert.equal(result.status, 'create_disabled');
    assert.equal(fs.existsSync(path.join(root, 'upgrade.db')), false);
    assert.equal(fs.existsSync(path.join(root, 'backups')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('single-instance lock and deployment templates stay upgrade-owned and default off', async () => {
  const context = setup();
  try {
    fs.mkdirSync(path.dirname(context.lockPath), { recursive: true });
    fs.writeFileSync(context.lockPath, 'held');
    const result = await runSqliteBackup(options(context, NOW));
    assert.equal(result.status, 'lock_held');
    assert.equal(fs.existsSync(context.backupRoot), false);
  } finally { context.close(); }

  const env = fs.readFileSync(path.join(process.cwd(), 'deploy', 'env', 'gaiop-upgrade.env.example'), 'utf8');
  const service = fs.readFileSync(path.join(process.cwd(), 'deploy', 'systemd', 'gaiop-upgrade-sqlite-backup.service'), 'utf8');
  const timer = fs.readFileSync(path.join(process.cwd(), 'deploy', 'systemd', 'gaiop-upgrade-sqlite-backup.timer'), 'utf8');
  assert.match(env, /^GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=false$/m);
  assert.match(env, /^GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED=false$/m);
  assert.match(service, /^UMask=0077$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/gaiop\/upgrade\/sqlite-backups$/m);
  assert.match(service, /^InaccessiblePaths=-\/var\/lib\/gaiop\/admin$/m);
  assert.match(service, /^InaccessiblePaths=-\/var\/lib\/gaiop\/alerts$/m);
  assert.doesNotMatch(service, /wizard\.db/);
  assert.doesNotMatch(service, /^ReadWritePaths=.*\/var\/lib\/gaiop\/admin/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 01:35:00 UTC$/m);
  assert.match(timer, /^Persistent=true$/m);
});
