const { runRetentionCleanup, POLICY_VERSION } = require('./services/RetentionRunner');

const result = runRetentionCleanup();
for (const record of result.records) process.stdout.write(JSON.stringify(record) + '\n');
if (!result.acquired) {
  process.stdout.write(JSON.stringify({
    policyVersion: POLICY_VERSION,
    category: 'upgrade_retention_lock',
    cutoffTime: null,
    success: 0,
    skipped: 1,
    failed: 0,
    freedBytes: 0,
    failureReasons: { lock_held: 1 },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }) + '\n');
}
