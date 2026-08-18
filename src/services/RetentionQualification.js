const { createRequire } = require('module');
const { cleanupTaskPackages, cleanupStagingPackages } = require('./PackageCleaner');
const backupCleaner = require('./BackupCleaner');

const QUALIFICATION_POLICY_VERSION = 'gaiop_retention_qualification.v1';

function summaryFromResult(result) {
  const reasons = (value) => Object.fromEntries(Object.entries(value || {}).filter(([key, count]) => /^[a-z0-9_]{1,80}$/.test(key) && Number.isInteger(count) && count > 0));
  return {
    category: result.category,
    safe_candidate: {
      count: Math.max(0, Number(result.candidateCount) || 0),
      bytes: Math.max(0, Number(result.candidateBytes) || 0),
      earliestUtc: result.earliestCandidateTime || null,
      latestUtc: result.latestCandidateTime || null,
    },
    protected: { count: Math.max(0, Number(result.skipped) || 0), reasons: reasons(result.reasons) },
    unknown_or_error: { count: Math.max(0, Number(result.failed) || 0), reasons: reasons(result.reasons) },
  };
}

function openReadonlyUpgradeDatabase(dbPath, DatabaseClass) {
  const Database = DatabaseClass || createRequire(__filename)('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function qualifyPackages(options = {}) {
  return summaryFromResult(cleanupTaskPackages({ ...options, dryRun: true }));
}

function qualifyStaging(options = {}) {
  return summaryFromResult(cleanupStagingPackages({ ...options, dryRun: true }));
}

function qualifyBackups(options = {}) {
  return summaryFromResult(backupCleaner.run({ ...options, dryRun: true }));
}

function qualifyUpgradeRetention({ db, packagesRoot, stagingRoot, backupRoot, now = Date.now(), retentionMs, stagingRetentionMs, backupRetentionMs, keepCount, maxItems = 100, fs: fsOverrides = {} } = {}) {
  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    categories: {
      packages: qualifyPackages({ db, packagesRoot, now, retentionMs, maxItems, fs: fsOverrides }),
      staging: qualifyStaging({ stagingRoot, now, retentionMs: stagingRetentionMs, maxItems, fs: fsOverrides }),
      rollbackBackups: qualifyBackups({ db, backupRoot, now, retentionMs: backupRetentionMs, keepCount, maxItems, fs: fsOverrides }),
    },
  };
}

module.exports = {
  QUALIFICATION_POLICY_VERSION,
  qualifyPackages,
  qualifyStaging,
  qualifyBackups,
  qualifyUpgradeRetention,
  openReadonlyUpgradeDatabase,
};
