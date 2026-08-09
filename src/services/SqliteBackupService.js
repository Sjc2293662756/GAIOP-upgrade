const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLICY_VERSION = 'gaiop_sqlite_backup.v1';
const TIERS = Object.freeze(['daily', 'weekly', 'monthly']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function safeReason(error, fallback = 'backup_failed') {
  const code = String(error?.code || '');
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code.toLowerCase() : fallback;
}

function inside(root, candidate) {
  const child = path.relative(root, candidate);
  return Boolean(child && child !== '..' && !child.startsWith(`..${path.sep}`) && !path.isAbsolute(child));
}

function controlledDirectory(directoryPath, { create = false } = {}) {
  const target = path.resolve(String(directoryPath || ''));
  if (!directoryPath) fail('directory_required');
  if (!fs.existsSync(target)) {
    if (!create) fail('directory_missing');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  const entry = fs.lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('directory_not_controlled');
  fs.chmodSync(target, 0o700);
  return { path: target, real: fs.realpathSync(target) };
}

function strictFile(root, name) {
  const target = path.resolve(root.path, name);
  if (!inside(root.path, target) || !fs.existsSync(target)) fail('backup_file_missing');
  const entry = fs.lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isFile()) fail('backup_file_not_regular');
  if (!inside(root.real, fs.realpathSync(target))) fail('backup_file_outside_root');
  return { path: target, stat: entry };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function utcMonth(now) {
  return new Date(now).toISOString().slice(0, 7);
}

function utcWeek(now) {
  const date = new Date(now);
  const day = date.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function periodFor(tier, now) {
  if (tier === 'daily') return utcDay(now);
  if (tier === 'weekly') return utcWeek(now);
  if (tier === 'monthly') return utcMonth(now);
  fail('backup_tier_invalid');
}

function retentionCutoff(tier, now) {
  const date = new Date(now);
  if (tier === 'daily') return utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 29));
  if (tier === 'weekly') {
    const day = date.getUTCDay() || 7;
    const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1);
    return utcWeek(monday - 11 * 7 * 86400000);
  }
  if (tier === 'monthly') return utcMonth(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 11, 1));
  fail('backup_tier_invalid');
}

function backupNames(component, tier, period) {
  const base = `${component}-${tier}-${period}`;
  return { database: `${base}.sqlite3`, manifest: `${base}.manifest.json` };
}

function backupPattern(component, tier) {
  const period = tier === 'daily' ? '(\\d{4}-\\d{2}-\\d{2})' : tier === 'weekly' ? '(\\d{4}-W\\d{2})' : '(\\d{4}-\\d{2})';
  return new RegExp(`^${component}-${tier}-${period}\\.sqlite3$`);
}

function readManifest(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest_invalid');
    return value;
  } catch (error) {
    if (error?.code === 'manifest_invalid') throw error;
    fail('manifest_invalid');
  }
}

function sqliteIntegrity(filePath, DatabaseClass = Database) {
  const connection = new DatabaseClass(filePath, { readonly: true, fileMustExist: true });
  try {
    const rows = connection.pragma('integrity_check');
    return Array.isArray(rows) && rows.length === 1 && rows[0]?.integrity_check === 'ok';
  } finally {
    connection.close();
  }
}

function normalizeStandalone(filePath, DatabaseClass = Database) {
  const connection = new DatabaseClass(filePath);
  try {
    connection.pragma('journal_mode = DELETE');
  } finally {
    connection.close();
  }
}

async function sqliteSnapshot(sourcePath, destinationPath, DatabaseClass = Database) {
  const source = new DatabaseClass(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const userVersion = Number(source.pragma('user_version', { simple: true })) || 0;
    const sqliteVersion = String(source.prepare('SELECT sqlite_version() AS version').get().version);
    await source.backup(destinationPath);
    normalizeStandalone(destinationPath, DatabaseClass);
    return { userVersion, sqliteVersion };
  } finally {
    source.close();
  }
}

function validateManifest(manifest, { component, tier, period, databaseName, databasePath, integrityCheck, DatabaseClass }) {
  const stat = fs.lstatSync(databasePath);
  if (
    manifest.policyVersion !== POLICY_VERSION
    || manifest.component !== component
    || manifest.tier !== tier
    || manifest.period !== period
    || manifest.fileName !== databaseName
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || periodFor(tier, Date.parse(manifest.createdAt)) !== period
    || !Number.isInteger(manifest.databaseVersion?.userVersion)
    || typeof manifest.databaseVersion?.sqliteVersion !== 'string'
    || manifest.sizeBytes !== stat.size
    || !HASH_PATTERN.test(String(manifest.sha256 || ''))
    || manifest.sha256 !== sha256(databasePath)
  ) fail('manifest_mismatch');
  if (!integrityCheck(databasePath, DatabaseClass)) fail('integrity_check_failed');
  return manifest;
}

function writeManifest(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

function acquireLock(lockPath) {
  const target = path.resolve(String(lockPath || ''));
  if (!lockPath) fail('lock_path_required');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  return () => {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(target); } catch {}
  };
}

function validateExisting(root, component, tier, period, integrityCheck, DatabaseClass) {
  const names = backupNames(component, tier, period);
  const databaseExists = fs.existsSync(path.join(root.path, names.database));
  const manifestExists = fs.existsSync(path.join(root.path, names.manifest));
  if (!databaseExists && !manifestExists) return null;
  if (!databaseExists || !manifestExists) fail('current_period_pair_incomplete');
  const database = strictFile(root, names.database);
  const manifest = strictFile(root, names.manifest);
  validateManifest(readManifest(manifest.path), {
    component, tier, period, databaseName: names.database, databasePath: database.path, integrityCheck, DatabaseClass,
  });
  return { names, databasePath: database.path };
}

function createTier({ snapshotPath, root, component, tier, period, createdAt, databaseVersion, integrityCheck, DatabaseClass }) {
  const names = backupNames(component, tier, period);
  const temporary = path.join(root.path, `.${names.database}.tmp-${process.pid}-${crypto.randomUUID()}`);
  fs.copyFileSync(snapshotPath, temporary);
  fs.chmodSync(temporary, 0o600);
  if (!integrityCheck(temporary, DatabaseClass)) {
    fs.rmSync(temporary, { force: true });
    fail('integrity_check_failed');
  }
  const sizeBytes = fs.lstatSync(temporary).size;
  const digest = sha256(temporary);
  fs.renameSync(temporary, path.join(root.path, names.database));
  writeManifest(path.join(root.path, names.manifest), {
    policyVersion: POLICY_VERSION,
    component,
    tier,
    period,
    createdAt,
    databaseVersion,
    fileName: names.database,
    sizeBytes,
    sha256: digest,
  });
  return { tier, period, sizeBytes };
}

function cleanupExpired({ root, component, now, integrityCheck, DatabaseClass }) {
  const result = { deleted: 0, skipped: 0, failed: 0, bytes: 0, reasons: {} };
  const reason = (code) => { result.reasons[code] = (result.reasons[code] || 0) + 1; };
  for (const tier of TIERS) {
    const cutoff = retentionCutoff(tier, now);
    const pattern = backupPattern(component, tier);
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        result.skipped += 1;
        reason(entry.isSymbolicLink() ? 'symbolic_link' : 'unknown_directory');
        continue;
      }
      const match = pattern.exec(entry.name);
      if (!match || match[1] >= cutoff) continue;
      try {
        const period = match[1];
        const names = backupNames(component, tier, period);
        const database = strictFile(root, names.database);
        const manifest = strictFile(root, names.manifest);
        validateManifest(readManifest(manifest.path), {
          component, tier, period, databaseName: names.database, databasePath: database.path, integrityCheck, DatabaseClass,
        });
        const size = database.stat.size;
        fs.unlinkSync(database.path);
        fs.unlinkSync(manifest.path);
        result.deleted += 1;
        result.bytes += size;
      } catch (error) {
        result.failed += 1;
        reason(safeReason(error, 'cleanup_failed'));
      }
    }
  }
  return result;
}

async function runSqliteBackup({
  component,
  allowedDatabaseNames,
  databasePath,
  backupRoot,
  lockPath,
  createEnabled = false,
  cleanupEnabled = false,
  now = Date.now(),
  DatabaseClass = Database,
  snapshot = sqliteSnapshot,
  integrityCheck = sqliteIntegrity,
} = {}) {
  const startedAt = new Date(now).toISOString();
  const databaseName = path.basename(path.resolve(String(databasePath || '')));
  if (component !== 'upgrade') return { ok: false, code: 'component_invalid', startedAt };
  if (!new Set(allowedDatabaseNames || []).has(databaseName)) return { ok: false, code: 'database_name_rejected', startedAt };
  if (!createEnabled) return { ok: true, status: 'create_disabled', cleanup: { status: 'not_run' }, startedAt, completedAt: new Date().toISOString() };
  const release = acquireLock(lockPath);
  if (!release) return { ok: true, status: 'lock_held', cleanup: { status: 'not_run' }, startedAt, completedAt: new Date().toISOString() };
  let stagingPath = null;
  try {
    const sourcePath = path.resolve(databasePath);
    const sourceEntry = fs.lstatSync(sourcePath);
    if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) fail('database_not_regular');
    const root = controlledDirectory(backupRoot, { create: true });
    if (inside(root.real, fs.realpathSync(sourcePath))) fail('database_inside_backup_root');
    const periods = TIERS.map((tier) => ({ tier, period: periodFor(tier, now) }));
    const missing = [];
    for (const item of periods) {
      if (!validateExisting(root, component, item.tier, item.period, integrityCheck, DatabaseClass)) missing.push(item);
    }
    const created = [];
    if (missing.length) {
      stagingPath = path.join(root.path, `.consistent-snapshot-${process.pid}-${crypto.randomUUID()}.sqlite3`);
      const databaseVersion = await snapshot(sourcePath, stagingPath, DatabaseClass);
      fs.chmodSync(stagingPath, 0o600);
      if (!integrityCheck(stagingPath, DatabaseClass)) fail('integrity_check_failed');
      const createdAt = new Date(now).toISOString();
      for (const item of missing) created.push(createTier({
        snapshotPath: stagingPath, root, component, ...item, createdAt, databaseVersion, integrityCheck, DatabaseClass,
      }));
    }
    if (stagingPath) fs.rmSync(stagingPath, { force: true });
    stagingPath = null;
    const cleanup = cleanupEnabled && created.length
      ? { status: 'completed', ...cleanupExpired({ root, component, now, integrityCheck, DatabaseClass }) }
      : { status: cleanupEnabled ? 'no_new_verified_backup' : 'disabled' };
    return { ok: true, status: 'completed', component, created, cleanup, startedAt, completedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, status: 'failed', code: safeReason(error), cleanup: { status: 'not_run' }, startedAt, completedAt: new Date().toISOString() };
  } finally {
    if (stagingPath) {
      try { fs.rmSync(stagingPath, { force: true }); } catch {}
    }
    release();
  }
}

async function verifyBackupRestore({ backupFile, backupRoot, temporaryRoot, component, DatabaseClass = Database, integrityCheck = sqliteIntegrity } = {}) {
  const root = controlledDirectory(backupRoot);
  const temporary = controlledDirectory(temporaryRoot, { create: true });
  if (root.real === temporary.real || inside(root.real, temporary.real) || inside(temporary.real, root.real)) fail('restore_roots_overlap');
  const name = path.basename(String(backupFile || ''));
  let tier = null;
  let period = null;
  for (const candidateTier of TIERS) {
    const match = backupPattern(component, candidateTier).exec(name);
    if (match) {
      tier = candidateTier;
      period = match[1];
      break;
    }
  }
  if (!tier || path.resolve(backupFile) !== path.resolve(root.path, name)) fail('backup_path_rejected');
  const source = strictFile(root, name);
  const manifest = strictFile(root, name.replace(/\.sqlite3$/, '.manifest.json'));
  validateManifest(readManifest(manifest.path), {
    component, tier, period, databaseName: name, databasePath: source.path, integrityCheck, DatabaseClass,
  });
  const destination = path.join(temporary.path, `${component}-restore-test-${crypto.randomUUID()}.sqlite3`);
  const backup = new DatabaseClass(source.path, { readonly: true, fileMustExist: true });
  try {
    await backup.backup(destination);
  } finally {
    backup.close();
  }
  try {
    normalizeStandalone(destination, DatabaseClass);
    if (!integrityCheck(destination, DatabaseClass)) fail('restore_integrity_failed');
    return { ok: true, status: 'verified', component, sourceSizeBytes: source.stat.size };
  } finally {
    fs.rmSync(destination, { force: true });
    fs.rmSync(`${destination}-wal`, { force: true });
    fs.rmSync(`${destination}-shm`, { force: true });
  }
}

module.exports = {
  POLICY_VERSION,
  TIERS,
  runSqliteBackup,
  sqliteIntegrity,
  verifyBackupRestore,
  __test__: { backupNames, periodFor, retentionCutoff, validateManifest },
};
