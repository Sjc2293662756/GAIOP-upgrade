const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  cleanupSuccessfulPackage,
  cleanupTaskPackages,
  cleanupStagingPackages,
} = require('../src/services/PackageCleaner');

function createFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const packagesRoot = path.join(root, 'packages');
  const stagingRoot = path.join(root, 'staging');
  fs.mkdirSync(packagesRoot);
  fs.mkdirSync(stagingRoot);
  const db = new Database(':memory:');
  db.exec('CREATE TABLE upgrade_tasks (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, finished_at TEXT)');
  return { root, packagesRoot, stagingRoot, db };
}

function writeAgedFile(target, mtimeMs, content = 'zip') {
  fs.writeFileSync(target, content);
  fs.utimesSync(target, mtimeMs / 1000, mtimeMs / 1000);
}

function insertTask(db, id, status, timeMs) {
  db.prepare('INSERT INTO upgrade_tasks (id, status, created_at, finished_at) VALUES (?, ?, ?, ?)')
    .run(id, status, new Date(timeMs).toISOString(), new Date(timeMs).toISOString());
}

test('successful package immediate cleanup requires an owned UUID zip inside the packages root', () => {
  const fixture = createFixture('gaiop-package-immediate-');
  const id = '00000000-0000-4000-8000-000000000001';
  const target = path.join(fixture.packagesRoot, `${id}.zip`);
  try {
    fs.writeFileSync(target, 'zip');
    assert.equal(cleanupSuccessfulPackage({ status: 'success' }, target, { packagesRoot: fixture.packagesRoot }), true);
    assert.equal(fs.existsSync(target), false);
    fs.writeFileSync(target, 'zip');
    assert.equal(cleanupSuccessfulPackage({ status: 'failed' }, target, { packagesRoot: fixture.packagesRoot }), false);
    assert.equal(cleanupSuccessfulPackage({ status: 'success' }, path.join(fixture.packagesRoot, 'unknown.zip'), { packagesRoot: fixture.packagesRoot }), false);
    assert.equal(cleanupSuccessfulPackage({ status: 'success' }, path.join(fixture.root, `${id}.zip`), { packagesRoot: fixture.packagesRoot }), false);
  } finally {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task package cleanup removes residual success packages immediately and terminal packages only after seven days', () => {
  const fixture = createFixture('gaiop-package-retention-');
  const now = Date.UTC(2026, 7, 9, 12);
  const ids = {
    success: '00000000-0000-4000-8000-000000000010',
    failedBoundary: '00000000-0000-4000-8000-000000000011',
    failedFresh: '00000000-0000-4000-8000-000000000012',
    rolledBackOld: '00000000-0000-4000-8000-000000000013',
    pending: '00000000-0000-4000-8000-000000000014',
    running: '00000000-0000-4000-8000-000000000015',
    rollingBack: '00000000-0000-4000-8000-000000000016',
  };
  try {
    insertTask(fixture.db, ids.success, 'success', now - 60 * 60 * 1000);
    insertTask(fixture.db, ids.failedBoundary, 'failed', now - 7 * 24 * 60 * 60 * 1000);
    insertTask(fixture.db, ids.failedFresh, 'failed', now - 7 * 24 * 60 * 60 * 1000 + 1);
    insertTask(fixture.db, ids.rolledBackOld, 'rolled_back', now - 8 * 24 * 60 * 60 * 1000);
    insertTask(fixture.db, ids.pending, 'pending', now - 30 * 24 * 60 * 60 * 1000);
    insertTask(fixture.db, ids.running, 'running', now - 30 * 24 * 60 * 60 * 1000);
    insertTask(fixture.db, ids.rollingBack, 'rolling_back', now - 30 * 24 * 60 * 60 * 1000);
    for (const id of Object.values(ids)) {
      writeAgedFile(path.join(fixture.packagesRoot, `${id}.zip`), id === ids.failedFresh ? now - 8 * 24 * 60 * 60 * 1000 : now - 10 * 24 * 60 * 60 * 1000);
    }
    const result = cleanupTaskPackages({ db: fixture.db, packagesRoot: fixture.packagesRoot, now, maxItems: 10 });
    assert.equal(result.success, 3);
    assert.equal(result.reasons.not_expired, 1);
    assert.equal(result.reasons.active_task, 3);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${ids.success}.zip`)), false);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${ids.failedBoundary}.zip`)), false);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${ids.rolledBackOld}.zip`)), false);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${ids.failedFresh}.zip`)), true);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${ids.running}.zip`)), true);
  } finally {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('unknown packages, directories, symlinks and invalid task times are recorded and never deleted', () => {
  const fixture = createFixture('gaiop-package-safety-');
  const now = Date.UTC(2026, 7, 9, 12);
  const invalidTimeId = '00000000-0000-4000-8000-000000000020';
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  try {
    fixture.db.prepare('INSERT INTO upgrade_tasks (id, status, created_at, finished_at) VALUES (?, ?, ?, ?)')
      .run(invalidTimeId, 'failed', 'invalid', 'invalid');
    writeAgedFile(path.join(fixture.packagesRoot, `${invalidTimeId}.zip`), now - 10 * 24 * 60 * 60 * 1000);
    writeAgedFile(path.join(fixture.packagesRoot, '00000000-0000-4000-8000-000000000021.zip'), now - 10 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(path.join(fixture.packagesRoot, 'wizard.db'), 'protected');
    fs.mkdirSync(path.join(fixture.packagesRoot, 'unknown-directory'));
    fs.symlinkSync(outside, path.join(fixture.packagesRoot, '00000000-0000-4000-8000-000000000022.zip'), 'junction');

    const result = cleanupTaskPackages({ db: fixture.db, packagesRoot: fixture.packagesRoot, now });
    assert.equal(result.success, 0);
    assert.equal(result.reasons.invalid_timestamp, 1);
    assert.equal(result.reasons.unknown_package, 1);
    assert.equal(result.reasons.unknown_filename, 1);
    assert.equal(result.reasons.unknown_directory, 1);
    assert.equal(result.reasons.symbolic_link, 1);
    assert.equal(fs.readdirSync(fixture.packagesRoot).length, 5);
  } finally {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('task package deletion failures stay retryable and batches are oldest-first and idempotent', () => {
  const fixture = createFixture('gaiop-package-retry-');
  const now = Date.UTC(2026, 7, 9, 12);
  const oldest = '00000000-0000-4000-8000-000000000030';
  const newer = '00000000-0000-4000-8000-000000000031';
  try {
    insertTask(fixture.db, oldest, 'success', now - 2 * 60 * 60 * 1000);
    insertTask(fixture.db, newer, 'success', now - 60 * 60 * 1000);
    writeAgedFile(path.join(fixture.packagesRoot, `${oldest}.zip`), now - 2 * 60 * 60 * 1000);
    writeAgedFile(path.join(fixture.packagesRoot, `${newer}.zip`), now - 60 * 60 * 1000);
    const failed = cleanupTaskPackages({
      db: fixture.db,
      packagesRoot: fixture.packagesRoot,
      now,
      maxItems: 1,
      fs: { unlinkSync: () => { throw new Error('simulated'); } },
    });
    assert.equal(failed.failed, 1);
    assert.equal(failed.reasons.batch_limit, 1);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${oldest}.zip`)), true);

    const retried = cleanupTaskPackages({ db: fixture.db, packagesRoot: fixture.packagesRoot, now, maxItems: 1 });
    assert.equal(retried.success, 1);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${oldest}.zip`)), false);
    assert.equal(fs.existsSync(path.join(fixture.packagesRoot, `${newer}.zip`)), true);
    const final = cleanupTaskPackages({ db: fixture.db, packagesRoot: fixture.packagesRoot, now, maxItems: 10 });
    assert.equal(final.success, 1);
    const repeated = cleanupTaskPackages({ db: fixture.db, packagesRoot: fixture.packagesRoot, now, maxItems: 10 });
    assert.equal(repeated.success, 0);
  } finally {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('staging cleanup removes only strict UUID zip orphans older than 24 hours', () => {
  const fixture = createFixture('gaiop-staging-retention-');
  const now = Date.UTC(2026, 7, 9, 12);
  const expired = path.join(fixture.stagingRoot, '00000000-0000-4000-8000-000000000040.zip');
  const boundary = path.join(fixture.stagingRoot, '00000000-0000-4000-8000-000000000041.zip');
  const fresh = path.join(fixture.stagingRoot, '00000000-0000-4000-8000-000000000042.zip');
  try {
    writeAgedFile(expired, now - 48 * 60 * 60 * 1000);
    writeAgedFile(boundary, now - 24 * 60 * 60 * 1000);
    writeAgedFile(fresh, now - 24 * 60 * 60 * 1000 + 1);
    fs.writeFileSync(path.join(fixture.stagingRoot, 'unknown.zip'), 'keep');
    fs.mkdirSync(path.join(fixture.stagingRoot, 'unknown-directory'));
    const first = cleanupStagingPackages({ stagingRoot: fixture.stagingRoot, now, maxItems: 1 });
    assert.equal(first.success, 1);
    assert.equal(first.reasons.batch_limit, 1);
    assert.equal(first.reasons.not_expired, 1);
    assert.equal(first.reasons.unknown_filename, 1);
    assert.equal(first.reasons.unknown_directory, 1);
    const second = cleanupStagingPackages({ stagingRoot: fixture.stagingRoot, now, maxItems: 10 });
    assert.equal(second.success, 1);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fixture.db.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
