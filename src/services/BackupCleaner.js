const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/connection');
const config = require('../config');

const BACKUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_USABLE_BACKUP_GROUPS = 5;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set(['running', 'rolling_back']);

function createIo(overrides = {}) {
  return {
    existsSync: overrides.existsSync || fs.existsSync,
    lstatSync: overrides.lstatSync || fs.lstatSync,
    realpathSync: overrides.realpathSync || fs.realpathSync,
    readdirSync: overrides.readdirSync || fs.readdirSync,
    rmSync: overrides.rmSync || fs.rmSync,
  };
}

function createResult(cutoffMs) {
  return {
    category: 'upgrade_rollback_backup',
    cutoffTime: Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString() : null,
    success: 0,
    skipped: 0,
    failed: 0,
    freedBytes: 0,
    reasons: {},
  };
}

function addReason(result, outcome, reason, count = 1) {
  result[outcome] += count;
  result.reasons[reason] = (result.reasons[reason] || 0) + count;
}

function parseCreatedAt(value, nowMs) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > nowMs + MAX_CLOCK_SKEW_MS) return null;
  return timestamp;
}

function inspectBackupDirectory(backupRoot, backupPath, fsOverrides = {}) {
  const io = createIo(fsOverrides);
  const root = path.resolve(String(backupRoot || ''));
  const target = path.resolve(String(backupPath || ''));
  if (!backupRoot || !backupPath || target === root || !target.startsWith(root + path.sep)) {
    return { ok: false, code: 'path_outside_root', root, target };
  }
  let rootStat;
  try {
    rootStat = io.lstatSync(root);
  } catch (_) {
    return { ok: false, code: 'backup_root_unavailable', root, target };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ok: false, code: 'unsafe_backup_root', root, target };
  if (!io.existsSync(target)) return { ok: false, code: 'missing_directory', root, target };

  let targetStat;
  try {
    targetStat = io.lstatSync(target);
  } catch (_) {
    return { ok: false, code: 'directory_stat_failed', root, target };
  }
  if (targetStat.isSymbolicLink()) return { ok: false, code: 'symbolic_link', root, target };
  if (!targetStat.isDirectory()) return { ok: false, code: 'not_directory', root, target };

  let realRoot;
  let realTarget;
  try {
    realRoot = io.realpathSync(root);
    realTarget = io.realpathSync(target);
  } catch (_) {
    return { ok: false, code: 'realpath_failed', root, target };
  }
  if (realTarget === realRoot || !realTarget.startsWith(realRoot + path.sep)) return { ok: false, code: 'path_outside_root', root, target };
  try {
    if (io.readdirSync(target).length === 0) return { ok: false, code: 'unusable_empty_backup', root, target };
  } catch (_) {
    return { ok: false, code: 'directory_read_failed', root, target };
  }
  return { ok: true, root, target, realRoot, realTarget, stat: targetStat };
}

function deleteRows(db, records) {
  const remove = db.prepare('DELETE FROM backups WHERE id = ?');
  const execute = db.transaction((rows) => {
    for (const row of rows) remove.run(row.id);
  });
  execute(records);
}

function rowsForPhysicalPath(db, backupRoot, inspectedTarget, fsOverrides) {
  const io = createIo(fsOverrides);
  const records = [];
  let unsafeReference = false;
  for (const row of db.prepare('SELECT * FROM backups').all()) {
    let resolved;
    try {
      resolved = path.resolve(String(row.backup_path || ''));
    } catch (_) {
      continue;
    }
    let samePhysical = resolved === inspectedTarget.target;
    if (!samePhysical && io.existsSync(resolved)) {
      try {
        samePhysical = io.realpathSync(resolved) === inspectedTarget.realTarget;
      } catch (_) {}
    }
    if (!samePhysical) continue;
    const inspectedReference = inspectBackupDirectory(backupRoot, row.backup_path, fsOverrides);
    if (!inspectedReference.ok) unsafeReference = true;
    records.push(row);
  }
  return { records, unsafeReference };
}

function deleteBackupGroup({ db, backupRoot, backupId = null, backupPath = null, fs: fsOverrides = {} } = {}) {
  if (!db) return { ok: false, code: 'database_required', removedRecords: 0, freedBytes: 0 };
  let requested = null;
  if (backupId != null) requested = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId);
  if (backupId != null && !requested) return { ok: false, code: 'backup_not_found', removedRecords: 0, freedBytes: 0 };
  const rawPath = requested?.backup_path || backupPath;
  const inspected = inspectBackupDirectory(backupRoot, rawPath, fsOverrides);
  if (!inspected.ok) return { ok: false, code: inspected.code, removedRecords: 0, freedBytes: 0 };
  const references = rowsForPhysicalPath(db, backupRoot, inspected, fsOverrides);
  if (references.unsafeReference) return { ok: false, code: 'unsafe_shared_reference', removedRecords: 0, freedBytes: 0 };
  const records = references.records;
  if (records.length === 0) return { ok: false, code: 'backup_not_found', removedRecords: 0, freedBytes: 0 };
  const freedBytes = Math.max(0, ...records.map((row) => Number(row.size_bytes) || 0));
  const io = createIo(fsOverrides);
  try {
    io.rmSync(inspected.target, { recursive: true, force: false });
  } catch (_) {
    return { ok: false, code: 'delete_failed', removedRecords: 0, freedBytes: 0 };
  }
  try {
    deleteRows(db, records);
  } catch (_) {
    return { ok: false, code: 'database_delete_failed', removedRecords: 0, freedBytes };
  }
  return { ok: true, code: 'deleted', removedRecords: records.length, freedBytes };
}

function buildGroups(backups, backupRoot, nowMs, fsOverrides, result) {
  const groups = new Map();
  const io = createIo(fsOverrides);
  let realRoot = null;
  try {
    realRoot = io.realpathSync(path.resolve(String(backupRoot || '')));
  } catch (_) {}
  for (const backup of backups) {
    const inspected = inspectBackupDirectory(backupRoot, backup.backup_path, fsOverrides);
    if (!inspected.ok) {
      addReason(result, inspected.code === 'missing_directory' ? 'failed' : 'skipped', inspected.code);
      if (realRoot) {
        try {
          const resolved = path.resolve(String(backup.backup_path || ''));
          const realTarget = io.realpathSync(resolved);
          if (realTarget !== realRoot && realTarget.startsWith(realRoot + path.sep)) {
            if (!groups.has(realTarget)) groups.set(realTarget, { key: realTarget, records: [], inspected: null, usable: false });
            const group = groups.get(realTarget);
            group.usable = false;
            group.records.push({ ...backup, createdAtMs: parseCreatedAt(backup.created_at, nowMs) });
          }
        } catch (_) {}
      }
      continue;
    }
    const key = inspected.realTarget;
    if (!groups.has(key)) groups.set(key, { key, records: [], inspected, usable: true });
    const group = groups.get(key);
    group.inspected = group.inspected || inspected;
    group.records.push({ ...backup, createdAtMs: parseCreatedAt(backup.created_at, nowMs) });
  }
  return groups;
}

function protectedUsableGroups(groups, keepCount) {
  const byComponent = new Map();
  for (const group of groups.values()) {
    if (!group.usable) continue;
    const newestByComponent = new Map();
    for (const record of group.records) {
      if (!record.createdAtMs) continue;
      const current = newestByComponent.get(record.component);
      if (!current || record.createdAtMs > current) newestByComponent.set(record.component, record.createdAtMs);
    }
    for (const [component, createdAtMs] of newestByComponent) {
      if (!byComponent.has(component)) byComponent.set(component, []);
      byComponent.get(component).push({ key: group.key, createdAtMs });
    }
  }
  const protectedKeys = new Set();
  for (const items of byComponent.values()) {
    items.sort((left, right) => right.createdAtMs - left.createdAtMs || left.key.localeCompare(right.key));
    for (const item of items.slice(0, keepCount)) protectedKeys.add(item.key);
  }
  return protectedKeys;
}

function run(options = {}) {
  const db = options.db || getDb();
  const backupRoot = options.backupRoot || config.backupRoot;
  const nowMs = Number(options.now ?? Date.now());
  const retentionMs = Number(options.retentionMs ?? BACKUP_RETENTION_MS);
  const keepCount = Math.max(MIN_USABLE_BACKUP_GROUPS, Math.floor(Number(options.keepCount) || MIN_USABLE_BACKUP_GROUPS));
  const maxItems = options.maxItems == null ? 100 : Math.max(0, Math.floor(Number(options.maxItems) || 0));
  const result = createResult(nowMs - retentionMs);
  if (!db || !Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    addReason(result, 'failed', 'invalid_policy');
    return result;
  }

  const active = db.prepare(`SELECT COUNT(*) AS count FROM upgrade_tasks WHERE status IN ('running', 'rolling_back')`).get();
  if (Number(active?.count) > 0) {
    addReason(result, 'skipped', 'active_task');
    return result;
  }

  const backups = db.prepare('SELECT * FROM backups ORDER BY created_at DESC, id DESC').all();
  const groups = buildGroups(backups, backupRoot, nowMs, options.fs, result);
  const protectedKeys = protectedUsableGroups(groups, keepCount);
  const cutoffMs = nowMs - retentionMs;
  const candidates = [];

  for (const group of groups.values()) {
    if (!group.usable) continue;
    if (protectedKeys.has(group.key)) {
      addReason(result, 'skipped', 'protected_recent_group');
      continue;
    }
    if (group.records.some((record) => !record.createdAtMs)) {
      addReason(result, 'skipped', 'invalid_timestamp');
      continue;
    }
    if (group.records.some((record) => record.createdAtMs > cutoffMs)) {
      addReason(result, 'skipped', 'not_expired');
      continue;
    }
    candidates.push({
      key: group.key,
      sortTime: Math.max(...group.records.map((record) => record.createdAtMs)),
    });
  }

  candidates.sort((left, right) => left.sortTime - right.sortTime || left.key.localeCompare(right.key));
  for (const candidate of candidates.slice(0, maxItems)) {
    const deletion = deleteBackupGroup({ db, backupRoot, backupPath: candidate.key, fs: options.fs });
    if (!deletion.ok) {
      addReason(result, 'failed', deletion.code);
      continue;
    }
    result.success += 1;
    result.freedBytes += deletion.freedBytes;
  }
  for (let index = maxItems; index < candidates.length; index += 1) addReason(result, 'skipped', 'batch_limit');
  return result;
}

module.exports = {
  run,
  deleteBackupGroup,
  inspectBackupDirectory,
  BACKUP_RETENTION_MS,
  MIN_USABLE_BACKUP_GROUPS,
  ACTIVE_TASK_STATUSES,
};
