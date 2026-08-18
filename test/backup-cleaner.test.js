const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const backupCleaner = require('../src/services/BackupCleaner');

const DAY = 24 * 60 * 60 * 1000;

function createFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const backupRoot = path.join(root, 'backups');
  fs.mkdirSync(backupRoot);
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE upgrade_tasks (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component TEXT,
      version TEXT,
      backup_path TEXT,
      size_bytes INTEGER DEFAULT 0,
      task_id TEXT,
      created_at TEXT
    );
  `);
  return { root, backupRoot, db };
}

function addBackup(fixture, component, name, ageDays, now, physicalPath = null) {
  const target = physicalPath || path.join(fixture.backupRoot, component, name);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'payload.txt'), name);
  }
  return fixture.db.prepare('INSERT INTO backups (component, version, backup_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(component, name, target, 100, new Date(now - ageDays * DAY).toISOString()).lastInsertRowid;
}

function cleanupFixture(fixture) {
  fixture.db.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('backup cleanup requires both 90 days and exclusion from the five newest usable groups', () => {
  const fixture = createFixture('gaiop-backup-policy-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    const oldPaths = [];
    for (let index = 0; index < 6; index += 1) {
      addBackup(fixture, 'old-component', `old-${index}`, 100 + index, now);
      oldPaths.push(path.join(fixture.backupRoot, 'old-component', `old-${index}`));
    }
    for (const age of [1, 2, 3, 4, 5, 89]) addBackup(fixture, 'fresh-component', `age-${age}`, age, now);

    const result = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 10 });
    assert.equal(result.success, 1);
    assert.equal(fs.existsSync(oldPaths[5]), false);
    for (let index = 0; index < 5; index += 1) assert.equal(fs.existsSync(oldPaths[index]), true);
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, 'fresh-component', 'age-89')), true);
    assert.ok(result.reasons.protected_recent_group >= 10);
    assert.equal(result.reasons.not_expired, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('backup retention treats the exact 90-day boundary as protected', () => {
  const fixture = createFixture('gaiop-backup-boundary-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    for (const age of [1, 2, 3, 4, 5, 90]) addBackup(fixture, 'component', `boundary-${age}`, age, now);
    const result = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 10 });
    assert.equal(result.success, 0);
    assert.equal(result.reasons.not_expired, 1);
    assert.equal(fs.existsSync(path.join(fixture.backupRoot, 'component', 'boundary-90')), true);
  } finally {
    cleanupFixture(fixture);
  }
});

test('shared physical backup is deleted only when every reference is old and unprotected', () => {
  const fixture = createFixture('gaiop-backup-shared-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    const shared = path.join(fixture.backupRoot, 'shared', 'old-group');
    addBackup(fixture, 'component-a', 'shared-a', 120, now, shared);
    addBackup(fixture, 'component-b', 'shared-b', 120, now, shared);
    for (let index = 0; index < 5; index += 1) {
      addBackup(fixture, 'component-a', `a-new-${index}`, 10 + index, now);
      addBackup(fixture, 'component-b', `b-new-${index}`, 10 + index, now);
    }
    const result = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 10 });
    assert.equal(result.success, 1);
    assert.equal(fs.existsSync(shared), false);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups WHERE backup_path = ?').get(shared).count, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('a newer shared reference prevents physical and database deletion', () => {
  const fixture = createFixture('gaiop-backup-shared-fresh-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    const shared = path.join(fixture.backupRoot, 'shared', 'mixed-age');
    addBackup(fixture, 'component-a', 'old', 120, now, shared);
    addBackup(fixture, 'component-b', 'new', 30, now, shared);
    for (let index = 0; index < 5; index += 1) {
      addBackup(fixture, 'component-a', `a-new-${index}`, index + 1, now);
      addBackup(fixture, 'component-b', `b-new-${index}`, index + 1, now);
    }
    const result = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 10 });
    assert.equal(result.success, 0);
    assert.equal(result.reasons.not_expired, 1);
    assert.equal(fs.existsSync(shared), true);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups WHERE backup_path = ?').get(shared).count, 2);
  } finally {
    cleanupFixture(fixture);
  }
});

test('physical deletion failure preserves database rows and remains retryable', () => {
  const fixture = createFixture('gaiop-backup-retry-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    for (let index = 0; index < 6; index += 1) addBackup(fixture, 'component', `group-${index}`, 100 + index, now);
    const oldest = path.join(fixture.backupRoot, 'component', 'group-5');
    const failed = backupCleaner.run({
      db: fixture.db,
      backupRoot: fixture.backupRoot,
      now,
      maxItems: 1,
      fs: { rmSync: () => { throw new Error('simulated'); } },
    });
    assert.equal(failed.failed, 1);
    assert.equal(failed.reasons.delete_failed, 1);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups WHERE backup_path = ?').get(oldest).count, 1);
    const retried = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 1 });
    assert.equal(retried.success, 1);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups WHERE backup_path = ?').get(oldest).count, 0);
    const repeated = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 1 });
    assert.equal(repeated.success, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('backup cleanup refuses root, traversal, missing paths and symbolic links without deleting records', () => {
  const fixture = createFixture('gaiop-backup-safety-');
  const now = Date.UTC(2026, 7, 9, 12);
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'payload.txt'), 'outside');
  const realTarget = path.join(fixture.backupRoot, 'real-target');
  fs.mkdirSync(realTarget);
  fs.writeFileSync(path.join(realTarget, 'payload.txt'), 'real');
  const link = path.join(fixture.backupRoot, 'linked-target');
  fs.symlinkSync(realTarget, link, 'junction');
  try {
    const insert = fixture.db.prepare('INSERT INTO backups (component, version, backup_path, size_bytes, created_at) VALUES (?, ?, ?, 100, ?)');
    const old = new Date(now - 120 * DAY).toISOString();
    insert.run('unsafe-root', '1', fixture.backupRoot, old);
    insert.run('outside', '1', outside, old);
    insert.run('missing', '1', path.join(fixture.backupRoot, 'missing'), old);
    insert.run('direct', '1', realTarget, old);
    insert.run('symlink', '1', link, old);
    const result = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 10 });
    assert.equal(result.success, 0);
    assert.equal(result.reasons.path_outside_root, 2);
    assert.equal(result.reasons.missing_directory, 1);
    assert.equal(result.reasons.symbolic_link, 2);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 5);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.existsSync(realTarget), true);
  } finally {
    cleanupFixture(fixture);
  }
});

test('active upgrade or rollback task skips the entire backup cleanup batch', () => {
  const fixture = createFixture('gaiop-backup-active-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    for (let index = 0; index < 6; index += 1) addBackup(fixture, 'component', `group-${index}`, 100 + index, now);
    fixture.db.prepare("INSERT INTO upgrade_tasks (id, status) VALUES ('task-1', 'rolling_back')").run();
    const result = backupCleaner.run({ db: fixture.db, backupRoot: fixture.backupRoot, now, maxItems: 10 });
    assert.equal(result.success, 0);
    assert.equal(result.reasons.active_task, 1);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 6);
  } finally {
    cleanupFixture(fixture);
  }
});

test('manual safe deletion reuses group semantics and removes all shared database references after the directory', () => {
  const fixture = createFixture('gaiop-backup-manual-');
  const now = Date.UTC(2026, 7, 9, 12);
  try {
    const shared = path.join(fixture.backupRoot, 'shared', 'manual');
    const requestedId = addBackup(fixture, 'component-a', 'a', 1, now, shared);
    addBackup(fixture, 'component-b', 'b', 1, now, shared);
    const result = backupCleaner.deleteBackupGroup({ db: fixture.db, backupRoot: fixture.backupRoot, backupId: requestedId });
    assert.equal(result.ok, true);
    assert.equal(result.removedRecords, 2);
    assert.equal(fs.existsSync(shared), false);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM backups').get().count, 0);
  } finally {
    cleanupFixture(fixture);
  }
});
