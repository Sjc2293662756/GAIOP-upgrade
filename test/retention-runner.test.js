const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireSingleInstanceLock, runRetentionCleanup } = require('../src/services/RetentionRunner');

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

test('Upgrade retention defaults to disabled and writes only the protected audit summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-upgrade-retention-disabled-'));
  const cfg = configFor(directory);
  try {
    const result = runRetentionCleanup({ config: cfg, now: Date.UTC(2026, 7, 9, 12) });
    assert.equal(result.acquired, true);
    assert.equal(result.records.length, 1);
    assert.deepEqual(Object.keys(result.records[0]).sort(), [
      'category', 'completedAt', 'cutoffTime', 'failed', 'failureReasons', 'freedBytes',
      'policyVersion', 'skipped', 'startedAt', 'success',
    ].sort());
    assert.equal(result.records[0].success, 0);
    assert.equal(result.records[0].failureReasons.auto_delete_disabled, 1);
    assert.equal(fs.readFileSync(cfg.retentionAuditLog, 'utf8').includes('token'), false);
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
    assert.equal(calls.length, 3);
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
