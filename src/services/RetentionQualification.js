const fs = require('fs');
const path = require('path');

const QUALIFICATION_POLICY_VERSION = 'gaiop_retention_qualification.v1';
const FAILED_PACKAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const UUID_V4_ZIP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i;
const ACTIVE_STATUSES = new Set(['pending', 'running', 'rolling_back']);
const TERMINAL_STATUSES = new Set(['failed', 'rolled_back']);

function summary(category) {
  return {
    category,
    safe_candidate: { count: 0, bytes: 0, earliestUtc: null, latestUtc: null },
    protected: { count: 0, reasons: {} },
    unknown_or_error: { count: 0, reasons: {} },
  };
}

function addReason(bucket, reason, count = 1) {
  bucket.count += count;
  bucket.reasons[reason] = (bucket.reasons[reason] || 0) + count;
}

function addCandidate(result, bytes, timeMs) {
  const item = result.safe_candidate;
  item.count += 1;
  item.bytes += Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (Number.isFinite(timeMs)) {
    const value = new Date(timeMs).toISOString();
    if (!item.earliestUtc || value < item.earliestUtc) item.earliestUtc = value;
    if (!item.latestUtc || value > item.latestUtc) item.latestUtc = value;
  }
}

function createIo(overrides = {}) {
  return {
    existsSync: overrides.existsSync || fs.existsSync,
    lstatSync: overrides.lstatSync || fs.lstatSync,
    readdirSync: overrides.readdirSync || fs.readdirSync,
    realpathSync: overrides.realpathSync || fs.realpathSync,
  };
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readManagedRoot(rootDirectory, expectedName, io, result) {
  const root = path.resolve(String(rootDirectory || ''));
  if (path.basename(root) !== expectedName) {
    addReason(result.unknown_or_error, 'unexpected_root_name');
    return null;
  }
  if (!rootDirectory || !io.existsSync(root)) {
    addReason(result.unknown_or_error, 'managed_root_not_found');
    return null;
  }
  let stat;
  try {
    stat = io.lstatSync(root);
  } catch (_) {
    addReason(result.unknown_or_error, 'managed_root_stat_failed');
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    addReason(result.unknown_or_error, 'managed_root_unsafe');
    return null;
  }
  try {
    return { root, entries: io.readdirSync(root, { withFileTypes: true }) };
  } catch (_) {
    addReason(result.unknown_or_error, 'managed_root_read_failed');
    return null;
  }
}

function parseTime(value, nowMs) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= nowMs + MAX_CLOCK_SKEW_MS ? parsed : null;
}

function readTasks(db) {
  if (!db) throw new Error('database_required');
  return db.prepare('SELECT id, status, created_at, finished_at FROM upgrade_tasks').all();
}

function classifyPackageEntry(result, entry, managed, taskById, nowMs, io) {
  const target = path.resolve(managed.root, entry.name);
  if (!isInsideRoot(managed.root, target)) {
    addReason(result.protected, 'path_outside_root');
    return;
  }
  let stat;
  try {
    stat = io.lstatSync(target);
  } catch (_) {
    addReason(result.unknown_or_error, 'entry_stat_failed');
    return;
  }
  if (stat.isSymbolicLink()) {
    addReason(result.protected, 'symbolic_link');
    return;
  }
  if (!stat.isFile()) {
    addReason(result.protected, entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type');
    return;
  }
  if (!UUID_V4_ZIP_PATTERN.test(entry.name)) {
    addReason(result.protected, 'unknown_filename');
    return;
  }
  if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0 || stat.mtimeMs > nowMs + MAX_CLOCK_SKEW_MS) {
    addReason(result.protected, 'invalid_timestamp');
    return;
  }
  const taskId = entry.name.slice(0, -4).toLowerCase();
  const task = taskById.get(taskId);
  if (!task) {
    addReason(result.protected, 'unknown_package');
    return;
  }
  if (ACTIVE_STATUSES.has(task.status)) {
    addReason(result.protected, 'active_task');
    return;
  }
  const taskTime = parseTime(task.finished_at || task.created_at, nowMs);
  if (!taskTime) {
    addReason(result.protected, 'invalid_timestamp');
    return;
  }
  if (task.status === 'success') {
    addCandidate(result, stat.size, Math.max(taskTime, stat.mtimeMs));
    return;
  }
  if (!TERMINAL_STATUSES.has(task.status)) {
    addReason(result.protected, 'unknown_task_status');
    return;
  }
  const cutoff = nowMs - FAILED_PACKAGE_RETENTION_MS;
  if (taskTime >= cutoff || stat.mtimeMs >= cutoff) {
    addReason(result.protected, 'not_expired');
    return;
  }
  addCandidate(result, stat.size, Math.max(taskTime, stat.mtimeMs));
}

function qualifyPackages({ db, packagesRoot, now = Date.now(), fs: fsOverrides = {} } = {}) {
  const result = summary('upgrade_packages');
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) {
    addReason(result.unknown_or_error, 'invalid_now');
    return result;
  }
  const io = createIo(fsOverrides);
  const managed = readManagedRoot(packagesRoot, 'packages', io, result);
  if (!managed) return result;
  let tasks;
  try {
    tasks = readTasks(db);
  } catch (_) {
    addReason(result.unknown_or_error, 'database_read_failed');
    return result;
  }
  const taskById = new Map(tasks.filter((row) => typeof row.id === 'string').map((row) => [row.id.toLowerCase(), row]));
  for (const entry of managed.entries) classifyPackageEntry(result, entry, managed, taskById, nowMs, io);
  return result;
}

function activityState(resolver, value) {
  if (typeof resolver !== 'function') return { known: false };
  try {
    const state = resolver(value);
    return { known: state?.known === true, active: state?.active === true, locked: state?.locked === true };
  } catch (_) {
    return { known: false };
  }
}

function qualifyStaging({ db, stagingRoot, now = Date.now(), activityResolver, fs: fsOverrides = {} } = {}) {
  const result = summary('upgrade_staging');
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) {
    addReason(result.unknown_or_error, 'invalid_now');
    return result;
  }
  const io = createIo(fsOverrides);
  const managed = readManagedRoot(stagingRoot, 'staging', io, result);
  if (!managed) return result;
  let tasks;
  try {
    tasks = readTasks(db);
  } catch (_) {
    addReason(result.unknown_or_error, 'database_read_failed');
    return result;
  }
  const taskById = new Map(tasks.filter((row) => typeof row.id === 'string').map((row) => [row.id.toLowerCase(), row]));
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  for (const entry of managed.entries) {
    const target = path.resolve(managed.root, entry.name);
    if (!isInsideRoot(managed.root, target)) {
      addReason(result.protected, 'path_outside_root');
      continue;
    }
    let stat;
    try {
      stat = io.lstatSync(target);
    } catch (_) {
      addReason(result.unknown_or_error, 'entry_stat_failed');
      continue;
    }
    if (stat.isSymbolicLink()) {
      addReason(result.protected, 'symbolic_link');
      continue;
    }
    if (!stat.isFile()) {
      addReason(result.protected, entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type');
      continue;
    }
    if (!UUID_V4_ZIP_PATTERN.test(entry.name)) {
      addReason(result.protected, 'unknown_filename');
      continue;
    }
    if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0 || stat.mtimeMs > nowMs + MAX_CLOCK_SKEW_MS) {
      addReason(result.protected, 'invalid_timestamp');
      continue;
    }
    if (stat.mtimeMs >= cutoff) {
      addReason(result.protected, 'not_expired');
      continue;
    }
    const id = entry.name.slice(0, -4).toLowerCase();
    const task = taskById.get(id);
    if (task && ACTIVE_STATUSES.has(task.status)) {
      addReason(result.protected, 'active_task');
      continue;
    }
    const activity = activityState(activityResolver, id);
    if (!activity.known) {
      addReason(result.unknown_or_error, 'activity_unknown');
      continue;
    }
    if (activity.active) {
      addReason(result.protected, activity.locked ? 'active_lock' : 'active_or_pending_reference');
      continue;
    }
    addCandidate(result, stat.size, stat.mtimeMs);
  }
  return result;
}

function inspectBackupGroup(rootDirectory, rawPath, io) {
  const root = path.resolve(String(rootDirectory || ''));
  const target = path.resolve(String(rawPath || ''));
  if (!rootDirectory || !rawPath || !isInsideRoot(root, target)) return { ok: false, code: 'path_outside_root' };
  let rootStat;
  try {
    rootStat = io.lstatSync(root);
  } catch (_) {
    return { ok: false, code: 'backup_root_unavailable' };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, code: 'unsafe_backup_root' };
  let targetStat;
  try {
    targetStat = io.lstatSync(target);
  } catch (_) {
    return { ok: false, code: 'backup_directory_unavailable' };
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) return { ok: false, code: 'unsafe_backup_directory' };
  let realRoot;
  let realTarget;
  try {
    realRoot = io.realpathSync(root);
    realTarget = io.realpathSync(target);
  } catch (_) {
    return { ok: false, code: 'realpath_failed' };
  }
  if (!isInsideRoot(realRoot, realTarget)) return { ok: false, code: 'path_outside_root' };
  let entries;
  try {
    entries = io.readdirSync(target, { withFileTypes: true });
  } catch (_) {
    return { ok: false, code: 'backup_directory_read_failed' };
  }
  const manifest = entries.find((entry) => /manifest/i.test(entry.name));
  if (!manifest) return { ok: false, code: 'manifest_missing' };
  let manifestStat;
  try {
    manifestStat = io.lstatSync(path.join(target, manifest.name));
  } catch (_) {
    return { ok: false, code: 'manifest_stat_failed' };
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size <= 0) return { ok: false, code: 'manifest_invalid' };
  if (entries.filter((entry) => !entry.isSymbolicLink()).length < 2) return { ok: false, code: 'backup_files_incomplete' };
  return { ok: true, key: realTarget, target, stat: targetStat };
}

function qualifyBackups({ db, backupRoot, now = Date.now(), fs: fsOverrides = {} } = {}) {
  const result = summary('upgrade_rollback_backup');
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) {
    addReason(result.unknown_or_error, 'invalid_now');
    return result;
  }
  if (!db) {
    addReason(result.unknown_or_error, 'database_required');
    return result;
  }
  const io = createIo(fsOverrides);
  const root = path.resolve(String(backupRoot || ''));
  if (path.basename(root) !== 'upgrade') {
    addReason(result.unknown_or_error, 'unexpected_root_name');
    return result;
  }
  let backups;
  let tasks;
  try {
    backups = db.prepare('SELECT id, component, version, backup_path, size_bytes, task_id, created_at FROM backups').all();
    tasks = readTasks(db);
  } catch (_) {
    addReason(result.unknown_or_error, 'database_read_failed');
    return result;
  }
  const taskById = new Map(tasks.filter((row) => typeof row.id === 'string').map((row) => [row.id, row]));
  const activeTask = tasks.some((task) => ACTIVE_STATUSES.has(task.status));
  const groups = new Map();
  for (const row of backups) {
    if (!row.task_id || !taskById.has(row.task_id)) {
      addReason(result.protected, 'database_ownership_missing');
      continue;
    }
    const inspected = inspectBackupGroup(root, row.backup_path, io);
    if (!inspected.ok) {
      addReason(result.protected, inspected.code);
      continue;
    }
    const createdAt = parseTime(row.created_at, nowMs);
    if (!createdAt) {
      addReason(result.protected, 'invalid_timestamp');
      continue;
    }
    const group = groups.get(inspected.key) || { key: inspected.key, inspected, records: [] };
    group.records.push({ ...row, createdAt });
    groups.set(inspected.key, group);
  }
  const recent = new Set();
  const byComponent = new Map();
  for (const group of groups.values()) {
    for (const record of group.records) {
      const list = byComponent.get(record.component) || [];
      list.push({ key: group.key, createdAt: record.createdAt });
      byComponent.set(record.component, list);
    }
  }
  for (const list of byComponent.values()) {
    list.sort((left, right) => right.createdAt - left.createdAt || left.key.localeCompare(right.key));
    for (const row of list.slice(0, 5)) recent.add(row.key);
  }
  const cutoff = nowMs - BACKUP_RETENTION_MS;
  for (const group of groups.values()) {
    if (activeTask) {
      addReason(result.protected, 'active_task');
      continue;
    }
    if (group.records.length !== 1) {
      addReason(result.protected, 'shared_physical_directory');
      continue;
    }
    if (recent.has(group.key)) {
      addReason(result.protected, 'protected_recent_group');
      continue;
    }
    const record = group.records[0];
    if (record.createdAt >= cutoff) {
      addReason(result.protected, 'not_expired');
      continue;
    }
    addCandidate(result, Number(record.size_bytes) || 0, record.createdAt);
  }
  return result;
}

function openReadonlyUpgradeDatabase(dbPath, DatabaseClass) {
  const Database = DatabaseClass || require('better-sqlite3');
  const db = new DatabaseClass(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function qualifyUpgradeRetention({ db, packagesRoot, stagingRoot, backupRoot, now = Date.now(), stagingActivityResolver, fs: fsOverrides = {} } = {}) {
  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    sideEffects: { deletes: 0, moves: 0, writes: 0, cleanersCalled: 0 },
    categories: {
      packages: qualifyPackages({ db, packagesRoot, now, fs: fsOverrides }),
      staging: qualifyStaging({ db, stagingRoot, now, activityResolver: stagingActivityResolver, fs: fsOverrides }),
      rollbackBackups: qualifyBackups({ db, backupRoot, now, fs: fsOverrides }),
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
