const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { qualifyPackages, qualifyStaging, qualifyBackups } = require('../src/services/RetentionQualification');

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const UUID = '00000000-0000-4000-8000-000000000001';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-retention-qualification-'));
  const packages = path.join(root, 'packages');
  const staging = path.join(root, 'staging');
  const backups = path.join(root, 'upgrade');
  fs.mkdirSync(packages); fs.mkdirSync(staging); fs.mkdirSync(backups);
  const tasks = [];
  const backupsRows = [];
  const db = {
    prepare(sql) {
      return { all: () => sql.includes('upgrade_tasks') ? tasks : backupsRows };
    },
  };
  db.tasks = tasks;
  db.backups = backupsRows;
  return { root, packages, staging, backups, db };
}

function close(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('package qualification applies success residual and strict seven-day terminal boundaries without deleting', () => {
  const f = fixture();
  const old = NOW - 8 * 24 * 60 * 60 * 1000;
  const candidate = path.join(f.packages, `${UUID}.zip`);
  fs.writeFileSync(candidate, 'package');
  fs.utimesSync(candidate, old / 1000, old / 1000);
  f.db.tasks.push({ id: UUID, status: 'failed', created_at: new Date(old).toISOString(), finished_at: new Date(old).toISOString() });
  const before = fs.readdirSync(f.packages);
  try {
    const result = require('../src/services/RetentionQualification').qualifyPackages({ db: f.db, packagesRoot: f.packages, now: NOW });
    assert.equal(result.safe_candidate.count, 1);
    assert.equal(result.safe_candidate.bytes, 7);
    assert.deepEqual(fs.readdirSync(f.packages), before);
  } finally { close(f); }
});

test('staging qualification fails closed without known activity and protects active task', () => {
  const f = fixture();
  const old = NOW - 25 * 60 * 60 * 1000;
  const target = path.join(f.staging, `${UUID}.zip`);
  fs.writeFileSync(target, 'staging');
  fs.utimesSync(target, old / 1000, old / 1000);
  try {
    let result = qualifyStaging({ db: f.db, stagingRoot: f.staging, now: NOW });
    assert.equal(result.unknown_or_error.reasons.activity_unknown, 1);
    result = qualifyStaging({ db: f.db, stagingRoot: f.staging, now: NOW, activityResolver: () => ({ known: true, active: true }) });
    assert.equal(result.protected.reasons.active_or_pending_reference, 1);
    result = qualifyStaging({ db: f.db, stagingRoot: f.staging, now: NOW, activityResolver: () => ({ known: true, active: false }) });
    assert.equal(result.safe_candidate.count, 1);
  } finally { close(f); }
});

test('rollback qualification protects recent, shared, incomplete and database-unowned groups', () => {
  const f = fixture();
  const old = NOW - 100 * 24 * 60 * 60 * 1000;
  const oldPath = path.join(f.backups, 'old');
  fs.mkdirSync(oldPath);
  fs.writeFileSync(path.join(oldPath, 'payload'), 'x');
  fs.writeFileSync(path.join(oldPath, 'manifest.json'), '{}');
  f.db.tasks.push({ id: UUID, status: 'success', created_at: new Date(old).toISOString(), finished_at: new Date(old).toISOString() });
  f.db.backups.push({ id: 1, component: 'frontend', version: '1.0.0', backup_path: oldPath, size_bytes: 1, task_id: UUID, created_at: new Date(old).toISOString() });
  const incomplete = path.join(f.backups, 'incomplete');
  fs.mkdirSync(incomplete); fs.writeFileSync(path.join(incomplete, 'payload'), 'x');
  f.db.backups.push({ id: 2, component: 'openclaw', version: '1.0.0', backup_path: incomplete, size_bytes: 1, task_id: UUID, created_at: new Date(old).toISOString() });
  try {
    const result = qualifyBackups({ db: f.db, backupRoot: f.backups, now: NOW });
    assert.equal(result.safe_candidate.count, 0);
    assert.equal(result.protected.reasons.protected_recent_group >= 1, true);
    assert.equal(result.protected.reasons.manifest_missing, 1);
  } finally { close(f); }
});
