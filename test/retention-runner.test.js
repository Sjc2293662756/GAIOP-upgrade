const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { acquireSingleInstanceLock, runRetentionCleanup } = require('../src/services/RetentionRunner');
const { openReadonlyUpgradeDatabase } = require('../src/services/RetentionQualification');

function configFor(directory) {
  return {
    dbPath: path.join(directory, 'upgrade.db'),
    packageStagingRoot: path.join(directory, 'staging'),
    backupRoot: path.join(directory, 'backups'),
    retentionAutoDelete: false,
    retentionMaxItems: 100,
    retentionAuditLog: path.join(directory, 'audit.jsonl'),
    retentionLockPath: path.join(directory, 'cleanup.lock'),
    failedPackageRetentionDays: 7,
    stagingRetentionHours: 24,
    backupRetentionDays: 90,
    backupMinUsableGroups: 5,
  };
}

test('Upgrade retention defaults to a complete read-only dry-run without audit writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-retention-disabled-'));
  const cfg = configFor(directory);
  const db = {
    prepare(sql) {
      return {
        all: () => [],
        get: () => sql.includes('COUNT') ? { count: 0 } : undefined,
      };
    },
  };
  try {
    const result = runRetentionCleanup({ config: cfg, db, now: Date.UTC(2026, 7, 9, 12) });
    assert.equal(result.acquired, true);
    assert.equal(result.records.length, 3);
    assert.deepEqual(result.records.map((record) => record.category), [
      'upgrade_task_package', 'upgrade_staging_package', 'upgrade_rollback_backup',
    ]);
    assert.deepEqual(Object.keys(result.records[0]).sort(), [
      'candidateBytes', 'candidateCount', 'category', 'completedAt', 'cutoffTime',
      'earliestCandidateTime', 'failed', 'failureReasons', 'freedBytes',
      'latestCandidateTime', 'phase', 'policyVersion', 'skipped', 'startedAt', 'success',
    ].sort());
    assert.equal(result.records[0].success, 0);
    assert.equal(result.dryRun, true);
    assert.equal(fs.existsSync(cfg.retentionAuditLog), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Upgrade retention is single-instance and invokes owned cleaners with enforced minimum protections', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-retention-lock-'));
  const cfg = { ...configFor(directory), retentionAutoDelete: true, failedPackageRetentionDays: 1, stagingRetentionHours: 1, backupRetentionDays: 1, backupMinUsableGroups: 1 };
  try {
    const release = acquireSingleInstanceLock(cfg.retentionLockPath);
    assert.equal(typeof release, 'function');
    const blocked = runRetentionCleanup({ config: cfg, enabled: true, db: {}, now: Date.UTC(2026, 7, 9, 12) });
    assert.equal(blocked.acquired, false);
    release();

    const calls = [];
    const result = runRetentionCleanup({
      config: cfg,
      enabled: true,
      db: {},
      now: Date.UTC(2026, 7, 9, 12),
      maxItems: 7,
      cleanupTaskPackages: (options) => {
        calls.push(options);
        return { category: 'upgrade_task_package', cutoffTime: '2026-08-02T12:00:00.000Z', success: 1, skipped: 0, failed: 0, freedBytes: 10, reasons: { 'token=do-not-log': 1 } };
      },
      cleanupStagingPackages: (options) => {
        calls.push(options);
        return { category: 'upgrade_staging_package', cutoffTime: '2026-08-08T12:00:00.000Z', success: 0, skipped: 1, failed: 0, freedBytes: 0, reasons: { unknown_filename: 1 } };
      },
      cleanupBackups: (options) => {
        calls.push(options);
        return { category: 'upgrade_rollback_backup', cutoffTime: '2026-05-11T12:00:00.000Z', success: 0, skipped: 1, failed: 0, freedBytes: 0, reasons: { protected_recent_group: 1 } };
      },
    });
    assert.equal(result.acquired, true);
    assert.equal(calls.length, 6);
    assert.deepEqual(calls.slice(0, 3).map((options) => options.dryRun), [true, true, true]);
    assert.deepEqual(calls.slice(3).map((options) => options.dryRun), [false, false, false]);
    assert.equal(calls[0].maxItems, 7);
    assert.equal(calls[0].retentionMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(calls[1].retentionMs, 24 * 60 * 60 * 1000);
    assert.equal(calls[2].retentionMs, 90 * 24 * 60 * 60 * 1000);
    assert.equal(calls[2].keepCount, 5);
    const audit = fs.readFileSync(cfg.retentionAuditLog, 'utf8');
    assert.equal(audit.includes('do-not-log'), false);
    assert.equal(audit.includes('token='), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Upgrade audit reservation failure prevents the execution phase', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-retention-reservation-'));
  const cfg = configFor(directory);
  const db = { prepare: () => ({ all: () => [], get: () => ({ count: 0 }) }) };
  const calls = [];
  try {
    const result = runRetentionCleanup({
      config: cfg,
      enabled: true,
      db,
      appendAudit: () => { throw new Error('reservation_failed'); },
      cleanupTaskPackages: (options) => { calls.push(options); return { category: 'upgrade_task_package', reasons: {}, _candidatePlan: [] }; },
      cleanupStagingPackages: (options) => { calls.push(options); return { category: 'upgrade_staging_package', reasons: {}, _candidatePlan: [] }; },
      cleanupBackups: (options) => { calls.push(options); return { category: 'upgrade_rollback_backup', reasons: {}, _candidatePlan: [] }; },
    });
    assert.equal(result.auditReserved, false);
    assert.equal(calls.length, 3);
    assert.equal(calls.every((options) => options.dryRun === true), true);
    assert.equal(result.records.every((record) => record.failureReasons.audit_reservation_failed === 1), true);
    assert.equal(fs.existsSync(cfg.retentionAuditLog), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Upgrade readonly database helper calls the supplied constructor with readonly options', () => {
  const calls = [];
  class FakeDatabase {
    constructor(...args) { calls.push(args); }
    pragma(value) { assert.equal(value, 'query_only = ON'); }
  }
  const db = openReadonlyUpgradeDatabase('temporary-upgrade.db', FakeDatabase);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['temporary-upgrade.db', { readonly: true, fileMustExist: true }]);
  assert.ok(db);
});

test('Upgrade readonly database helper opens a real database through its default constructor', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-readonly-db-'));
  const databasePath = path.join(directory, 'upgrade.db');
  try {
    const writable = new Database(databasePath);
    writable.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    writable.close();
    const readonly = openReadonlyUpgradeDatabase(databasePath);
    assert.equal(readonly.pragma('query_only', { simple: true }), 1);
    assert.throws(() => readonly.exec('INSERT INTO sample DEFAULT VALUES'), /readonly/i);
    readonly.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
