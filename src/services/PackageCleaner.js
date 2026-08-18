const fs = require('fs');
const path = require('path');

const UUID_ZIP_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.zip$/i;
const FAILED_PACKAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['pending', 'running', 'rolling_back']);
const RETAINED_TERMINAL_STATUSES = new Set(['failed', 'rolled_back']);

function createResult(category, cutoffMs) {
  return {
    category,
    cutoffTime: Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null,
    success: 0,
    skipped: 0,
    failed: 0,
    freedBytes: 0,
    candidateCount: 0,
    candidateBytes: 0,
    earliestCandidateTime: null,
    latestCandidateTime: null,
    reasons: {},
  };
}

function addReason(result, outcome, reason) {
  result[outcome] += 1;
  result.reasons[reason] = (result.reasons[reason] || 0) + 1;
}

function isInsideRoot(root, target) {
  return target !== root && target.startsWith(root + path.sep);
}

function readManagedRoot(rootDirectory, expectedName, io, result) {
  const root = path.resolve(String(rootDirectory || ''));
  if (path.basename(root) !== expectedName) {
    addReason(result, 'failed', 'unexpected_root_name');
    return null;
  }
  if (!rootDirectory || !io.existsSync(root)) return { root, entries: [] };
  let stat;
  try {
    stat = io.lstatSync(root);
  } catch (_) {
    addReason(result, 'failed', 'root_stat_failed');
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    addReason(result, 'failed', 'unsafe_root');
    return null;
  }
  try {
    return { root, entries: io.readdirSync(root, { withFileTypes: true }) };
  } catch (_) {
    addReason(result, 'failed', 'root_read_failed');
    return null;
  }
}

function recordCandidate(result, candidate) {
  result.candidateCount += 1;
  result.candidateBytes += Number.isFinite(candidate.stat.size) ? Math.max(0, candidate.stat.size) : 0;
  const timestamp = new Date(candidate.sortTime).toISOString();
  if (!result.earliestCandidateTime || timestamp < result.earliestCandidateTime) result.earliestCandidateTime = timestamp;
  if (!result.latestCandidateTime || timestamp > result.latestCandidateTime) result.latestCandidateTime = timestamp;
}

function attachPlan(result, candidates) {
  Object.defineProperty(result, '_candidatePlan', { value: candidates, enumerable: false, configurable: true, writable: true });
  return result;
}

function revalidateFileCandidate(candidate, options, io) {
  const root = path.resolve(String(options.root || ''));
  const cutoffMs = Number(options.now) - Number(options.retentionMs);
  if (candidate.target === root || !isInsideRoot(root, candidate.target)) return false;
  try {
    const current = io.lstatSync(candidate.target);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== candidate.stat.dev || current.ino !== candidate.stat.ino || !Number.isFinite(current.mtimeMs) || (candidate.requiresExpiry && current.mtimeMs >= cutoffMs) || !UUID_ZIP_PATTERN.test(path.basename(candidate.target))) return false;
    if (!options.db) return true;
    if (!candidate.taskId) return false;
    const task = options.db.prepare('SELECT id, status, created_at, finished_at FROM upgrade_tasks WHERE id = ?').get(candidate.taskId);
    if (!task || String(task.id).toLowerCase() !== path.basename(candidate.target).slice(0, -4).toLowerCase()) return false;
    if (candidate.requiresExpiry) {
      const taskTime = parseTaskTime(task);
      return RETAINED_TERMINAL_STATUSES.has(task.status) && Number.isFinite(taskTime) && taskTime < cutoffMs;
    }
    return task.status === 'success';
  } catch (_) {
    return false;
  }
}

function deleteCandidates(candidates, options, io, result) {
  const ordered = [...candidates].sort((left, right) => left.sortTime - right.sortTime || left.target.localeCompare(right.target));
  const limit = Math.max(0, Math.floor(Number(options.maxItems) || 0));
  for (const candidate of ordered.slice(0, limit)) {
    try {
      if (!revalidateFileCandidate(candidate, options, io)) {
        addReason(result, 'skipped', 'entry_changed');
        continue;
      }
      io.unlinkSync(candidate.target);
      result.success += 1;
      result.freedBytes += Number.isFinite(candidate.stat.size) ? candidate.stat.size : 0;
    } catch (_) {
      addReason(result, 'failed', 'delete_failed');
    }
  }
  for (let index = limit; index < ordered.length; index += 1) addReason(result, 'skipped', 'batch_limit');
}

function createIo(overrides = {}) {
  return {
    existsSync: overrides.existsSync || fs.existsSync,
    lstatSync: overrides.lstatSync || fs.lstatSync,
    readdirSync: overrides.readdirSync || fs.readdirSync,
    unlinkSync: overrides.unlinkSync || fs.unlinkSync,
  };
}

function parseTaskTime(task) {
  const value = task.finished_at || task.created_at;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cleanupSuccessfulPackage(finalTask, packagePath, options = {}) {
  if (!finalTask || finalTask.status !== 'success') return false;
  const legacyUnlink = typeof options === 'function' ? options : null;
  if (legacyUnlink) {
    try {
      legacyUnlink(packagePath);
      return true;
    } catch (_) {
      return false;
    }
  }

  const io = createIo(options.fs);
  const packagesRoot = path.resolve(options.packagesRoot || path.dirname(packagePath));
  const target = path.resolve(String(packagePath || ''));
  if (path.basename(packagesRoot) !== 'packages' || !isInsideRoot(packagesRoot, target) || !UUID_ZIP_PATTERN.test(path.basename(target))) return false;
  try {
    const rootStat = io.lstatSync(packagesRoot);
    const fileStat = io.lstatSync(target);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) return false;
    io.unlinkSync(target);
    return true;
  } catch (_) {
    return false;
  }
}

function discoverTaskPackageCandidates({ db, packagesRoot, now = Date.now(), retentionMs = FAILED_PACKAGE_RETENTION_MS, fs: fsOverrides = {} } = {}) {
  const nowMs = Number(now);
  const cutoffMs = nowMs - retentionMs;
  const result = createResult('upgrade_task_package', cutoffMs);
  if (!db || !Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    addReason(result, 'failed', 'invalid_policy');
    return { result: attachPlan(result, []), candidates: [] };
  }
  const io = createIo(fsOverrides);
  const managed = readManagedRoot(packagesRoot, 'packages', io, result);
  if (!managed) return { result: attachPlan(result, []), candidates: [] };
  const tasks = db.prepare('SELECT id, status, created_at, finished_at FROM upgrade_tasks').all();
  const taskById = new Map(tasks.filter((task) => typeof task.id === 'string').map((task) => [task.id.toLowerCase(), task]));
  const candidates = [];

  for (const entry of managed.entries) {
    const target = path.resolve(managed.root, entry.name);
    if (!isInsideRoot(managed.root, target)) {
      addReason(result, 'skipped', 'path_outside_root');
      continue;
    }
    let stat;
    try {
      stat = io.lstatSync(target);
    } catch (_) {
      addReason(result, 'failed', 'entry_stat_failed');
      continue;
    }
    if (stat.isSymbolicLink()) {
      addReason(result, 'skipped', 'symbolic_link');
      continue;
    }
    if (!stat.isFile()) {
      addReason(result, 'skipped', entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type');
      continue;
    }
    const match = UUID_ZIP_PATTERN.exec(entry.name);
    if (!match) {
      addReason(result, 'skipped', 'unknown_filename');
      continue;
    }
    if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0 || stat.mtimeMs > nowMs + MAX_CLOCK_SKEW_MS) {
      addReason(result, 'skipped', 'invalid_timestamp');
      continue;
    }
    const task = taskById.get(match[1].toLowerCase());
    if (!task) {
      addReason(result, 'skipped', 'unknown_package');
      continue;
    }
    if (ACTIVE_STATUSES.has(task.status)) {
      addReason(result, 'skipped', 'active_task');
      continue;
    }
    if (task.status === 'success') {
      const candidate = { target, stat, sortTime: stat.mtimeMs, requiresExpiry: false, taskId: task.id };
      candidates.push(candidate);
      recordCandidate(result, candidate);
      continue;
    }
    if (!RETAINED_TERMINAL_STATUSES.has(task.status)) {
      addReason(result, 'skipped', 'unknown_task_status');
      continue;
    }
    const taskTime = parseTaskTime(task);
    if (!Number.isFinite(taskTime) || taskTime <= 0 || taskTime > nowMs + MAX_CLOCK_SKEW_MS) {
      addReason(result, 'skipped', 'invalid_timestamp');
      continue;
    }
    if (taskTime >= cutoffMs || stat.mtimeMs >= cutoffMs) {
      addReason(result, 'skipped', 'not_expired');
      continue;
    }
    const candidate = { target, stat, sortTime: Math.max(taskTime, stat.mtimeMs), requiresExpiry: true, taskId: task.id };
    candidates.push(candidate);
    recordCandidate(result, candidate);
  }

  return { result: attachPlan(result, candidates), candidates };
}

function cleanupTaskPackages({ db, packagesRoot, now = Date.now(), retentionMs = FAILED_PACKAGE_RETENTION_MS, maxItems = 100, fs: fsOverrides = {}, dryRun = false, plan } = {}) {
  const io = createIo(fsOverrides);
  const discovered = plan || discoverTaskPackageCandidates({ db, packagesRoot, now, retentionMs, fs: fsOverrides });
  const result = discovered.result;
  const candidates = discovered.candidates;
  if (!dryRun) deleteCandidates(candidates, { root: packagesRoot, db, now, retentionMs, maxItems }, io, result);
  else for (let index = Math.max(0, Math.floor(Number(maxItems) || 0)); index < candidates.length; index += 1) addReason(result, 'skipped', 'batch_limit');
  attachPlan(result, candidates);
  return result;
}

function discoverStagingCandidates({ stagingRoot, now = Date.now(), retentionMs = STAGING_RETENTION_MS, fs: fsOverrides = {} } = {}) {
  const nowMs = Number(now);
  const cutoffMs = nowMs - retentionMs;
  const result = createResult('upgrade_staging_package', cutoffMs);
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    addReason(result, 'failed', 'invalid_policy');
    return { result: attachPlan(result, []), candidates: [] };
  }
  const io = createIo(fsOverrides);
  const managed = readManagedRoot(stagingRoot, 'staging', io, result);
  if (!managed) return { result: attachPlan(result, []), candidates: [] };
  const candidates = [];
  for (const entry of managed.entries) {
    const target = path.resolve(managed.root, entry.name);
    if (!isInsideRoot(managed.root, target)) {
      addReason(result, 'skipped', 'path_outside_root');
      continue;
    }
    let stat;
    try {
      stat = io.lstatSync(target);
    } catch (_) {
      addReason(result, 'failed', 'entry_stat_failed');
      continue;
    }
    if (stat.isSymbolicLink()) {
      addReason(result, 'skipped', 'symbolic_link');
      continue;
    }
    if (!stat.isFile()) {
      addReason(result, 'skipped', entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type');
      continue;
    }
    if (!UUID_ZIP_PATTERN.test(entry.name)) {
      addReason(result, 'skipped', 'unknown_filename');
      continue;
    }
    if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0 || stat.mtimeMs > nowMs + MAX_CLOCK_SKEW_MS) {
      addReason(result, 'skipped', 'invalid_timestamp');
      continue;
    }
    if (stat.mtimeMs >= cutoffMs) {
      addReason(result, 'skipped', 'not_expired');
      continue;
    }
    const candidate = { target, stat, sortTime: stat.mtimeMs, requiresExpiry: true };
    candidates.push(candidate);
    recordCandidate(result, candidate);
  }
  return { result: attachPlan(result, candidates), candidates };
}

function cleanupStagingPackages({ stagingRoot, now = Date.now(), retentionMs = STAGING_RETENTION_MS, maxItems = 100, fs: fsOverrides = {}, dryRun = false, plan } = {}) {
  const io = createIo(fsOverrides);
  const discovered = plan || discoverStagingCandidates({ stagingRoot, now, retentionMs, fs: fsOverrides });
  const result = discovered.result;
  const candidates = discovered.candidates;
  if (!dryRun) deleteCandidates(candidates, { root: stagingRoot, now, retentionMs, maxItems }, io, result);
  else for (let index = Math.max(0, Math.floor(Number(maxItems) || 0)); index < candidates.length; index += 1) addReason(result, 'skipped', 'batch_limit');
  attachPlan(result, candidates);
  return result;
}

module.exports = {
  cleanupSuccessfulPackage,
  cleanupTaskPackages,
  cleanupStagingPackages,
  discoverTaskPackageCandidates,
  discoverStagingCandidates,
  UUID_ZIP_PATTERN,
  FAILED_PACKAGE_RETENTION_MS,
  STAGING_RETENTION_MS,
};
