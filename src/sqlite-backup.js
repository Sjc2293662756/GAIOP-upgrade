const config = require('./config');
const { runSqliteBackup } = require('./services/SqliteBackupService');

async function runUpgradeSqliteBackup(overrides = {}) {
  return runSqliteBackup({
    component: 'upgrade',
    allowedDatabaseNames: ['upgrade.db', 'napm-upgrade.db'],
    databasePath: config.dbPath,
    backupRoot: config.sqliteBackupRoot,
    lockPath: config.sqliteBackupLockPath,
    createEnabled: config.sqliteBackupCreateEnabled,
    cleanupEnabled: config.sqliteBackupCleanupEnabled,
    ...overrides,
  });
}

if (require.main === module) {
  runUpgradeSqliteBackup().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  });
}

module.exports = { runUpgradeSqliteBackup };
