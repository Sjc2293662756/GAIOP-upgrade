const config = require('./config');
const { verifyBackupRestore } = require('./services/SqliteBackupService');

async function runUpgradeRestoreTest(backupFile = process.argv[2], overrides = {}) {
  return verifyBackupRestore({
    component: 'upgrade',
    backupFile,
    backupRoot: config.sqliteBackupRoot,
    temporaryRoot: config.sqliteRestoreTestRoot,
    ...overrides,
  });
}

if (require.main === module) {
  runUpgradeRestoreTest().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'failed', reasonCode: String(error?.code || 'restore_test_failed') })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runUpgradeRestoreTest };
