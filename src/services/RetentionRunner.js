const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../database/connection');
const { cleanupTaskPackages, cleanupStagingPackages } = require('./PackageCleaner');
const backupCleaner = require('./BackupCleaner');

const POLICY_VERSION = 'gaiop_upgrade_retention.v1';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function auditProjection(result, startedAt, completedAt) {
  const failureReasons = {};
  for (const [reason, count] of Object.entries(result.reasons || {})) {
    if (/^[a-z0-9_]{1,80}$/.test(reason) && Number.isInteger(count) && count > 0) failureReasons[reason] = count;
  }
  return {
    policyVersion: POLICY_VERSION,
    category: String(result.category || 'unknown').slice(0, 80),
    cutoffTime: typeof result.cutoffTime === 'string' ? result.cutoffTime : null,
    success: Math.max(0, Number(result.success) || 0),
    skipped: Math.max(0, Number(result.skipped) || 0),
    failed: Math.max(0, Number(result.failed) || 0),
    freedBytes: Math.max(0, Number(result.freedBytes) || 0),
    failureReasons,
    startedAt,
    completedAt,
  };
}

function appendCleanupAudit(auditLogPath, records, append = fs.appendFileSync) {
  const target = path.resolve(String(auditLogPath || ''));
  if (!auditLogPath) throw new Error('audit_log_path_required');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
  append(target, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8', mode: 0o640 });
}

function acquireSingleInstanceLock(lockPath) {
  const target = path.resolve(String(lockPath || ''));
  if (!lockPath) throw new Error('lock_path_required');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
  try {
    const fd = fs.openSync(target, 'wx', 0o600);
    return () => {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(target); } catch (_) {}
    };
  } catch (error) {
    if (error && error.code === 'EEXIST') return null;
    throw error;
  }
}

function runRetentionCleanup(options = {}) {
  const cfg = options.config || config;
  const releaseLock = acquireSingleInstanceLock(options.lockPath || cfg.retentionLockPath);
  if (!releaseLock) return { acquired: false, records: [] };
  const now = Number(options.now ?? Date.now());
  const startedAt = new Date(now).toISOString();
  try {
    let results;
    if (options.enabled ?? cfg.retentionAutoDelete) {
      const db = options.db || getDb();
      const maxItems = positiveInteger(options.maxItems ?? cfg.retentionMaxItems, 100);
      const packagesRoot = path.resolve(cfg.dbPath, '..', 'packages');
      results = [
        (options.cleanupTaskPackages || cleanupTaskPackages)({
          db,
          packagesRoot,
          now,
          retentionMs: Math.max(7, positiveInteger(cfg.failedPackageRetentionDays, 7)) * 24 * 60 * 60 * 1000,
          maxItems,
        }),
        (options.cleanupStagingPackages || cleanupStagingPackages)({
          stagingRoot: path.resolve(cfg.packageStagingRoot),
          now,
          retentionMs: Math.max(24, positiveInteger(cfg.stagingRetentionHours, 24)) * 60 * 60 * 1000,
          maxItems,
        }),
        (options.cleanupBackups || backupCleaner.run)({
          db,
          backupRoot: cfg.backupRoot,
          now,
          retentionMs: Math.max(90, positiveInteger(cfg.backupRetentionDays, 90)) * 24 * 60 * 60 * 1000,
          keepCount: Math.max(5, positiveInteger(cfg.backupMinUsableGroups, 5)),
          maxItems,
        }),
      ];
    } else {
      results = [{
        category: 'upgrade_retention_all',
        cutoffTime: null,
        success: 0,
        skipped: 1,
        failed: 0,
        freedBytes: 0,
        reasons: { auto_delete_disabled: 1 },
      }];
    }
    const completedAt = new Date().toISOString();
    const records = results.map((result) => auditProjection(result, startedAt, completedAt));
    (options.appendAudit || appendCleanupAudit)(options.auditLogPath || cfg.retentionAuditLog, records);
    return { acquired: true, records };
  } finally {
    releaseLock();
  }
}

module.exports = {
  runRetentionCleanup,
  appendCleanupAudit,
  acquireSingleInstanceLock,
  POLICY_VERSION,
  __test__: { auditProjection, positiveInteger },
};
