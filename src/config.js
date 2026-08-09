require('dotenv').config();

const config = {
  port: parseInt(process.env.NAPM_UPGRADE_PORT || '18900', 10),
  dbPath: process.env.NAPM_UPGRADE_DB_PATH || './data/napm-upgrade.db',
  backupRoot: process.env.NAPM_UPGRADE_BACKUP_ROOT || '/var/backups/napm',
  skillsRoot: process.env.NAPM_UPGRADE_SKILLS_ROOT || '/home/netinside/.openclaw/workspace/skills',
  pluginRoot: process.env.NAPM_UPGRADE_PLUGIN_ROOT || '/home/netinside/.openclaw/extensions/napm-openclaw-plugin',
  openclawRoot: process.env.NAPM_UPGRADE_OPENCLAW_ROOT || '/home/netinside/.npm-global/lib/node_modules/openclaw',
  // Only the built frontend directory may be replaced. Pointing this at the
  // GAIOP-Admin application root would also replace the BFF and runtime files.
  frontendRoot: process.env.NAPM_UPGRADE_FRONTEND_ROOT || '/opt/gaiop/admin/dist',
  frontendHealthUrl: process.env.NAPM_UPGRADE_FRONTEND_HEALTH_URL || 'http://127.0.0.1:3000/api/health',
  openclawHealthUrl: process.env.NAPM_UPGRADE_OPENCLAW_HEALTH_URL || 'http://127.0.0.1:18789/health',
  openclawRestartHelper: process.env.NAPM_UPGRADE_OPENCLAW_RESTART_HELPER || '/usr/local/libexec/gaiop-upgrade-restart-openclaw',
  runtimeOwner: process.env.NAPM_UPGRADE_RUNTIME_OWNER || 'netinside',
  runtimeGroup: process.env.NAPM_UPGRADE_RUNTIME_GROUP || 'netinside',
  frontendOwner: process.env.NAPM_UPGRADE_FRONTEND_OWNER || 'gaiop',
  frontendGroup: process.env.NAPM_UPGRADE_FRONTEND_GROUP || 'gaiop',
  publicKeyPath: process.env.NAPM_UPGRADE_PUBLIC_KEY_PATH || './config/public.pem',
  backupRetention: parseInt(process.env.NAPM_UPGRADE_BACKUP_RETENTION || '5', 10),
  lockDir: process.env.NAPM_UPGRADE_LOCK_DIR || '/tmp',
  smokeTimeoutMs: parseInt(process.env.NAPM_UPGRADE_SMOKE_TIMEOUT_MS || '30000', 10),
  openclawRestartTimeoutMs: parseInt(process.env.NAPM_UPGRADE_OPENCLAW_RESTART_TIMEOUT_MS || '60000', 10),
  logLevel: process.env.NAPM_UPGRADE_LOG_LEVEL || 'info',
  encryptionKey: process.env.NAPM_PACKAGE_ENCRYPTION_KEY || null,  // 64 位 hex → 32 字节 AES-256 密钥
  // ISO 内部网络中由 GAIOP Admin BFF 调用时使用；生产部署应配置此值。
  internalAuthToken: process.env.GAIOP_UPGRADE_INTERNAL_TOKEN || '',
  packageStagingRoot: process.env.NAPM_UPGRADE_PACKAGE_STAGING_ROOT || './data/staging',
  reportAttributionRequired: process.env.GAIOP_REPORT_ATTRIBUTION_REQUIRED === 'true',
  reportAttributionIndexPath: process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH || '/var/lib/gaiop/report-attribution/index.json',
  reportAttributionMaxAgeMs: parseInt(process.env.GAIOP_REPORT_ATTRIBUTION_MAX_AGE_MS || '30000', 10),
  retentionAutoDelete: process.env.GAIOP_UPGRADE_RETENTION_AUTO_DELETE === 'true',
  retentionMaxItems: parseInt(process.env.GAIOP_UPGRADE_RETENTION_MAX_ITEMS || '100', 10),
  retentionAuditLog: process.env.GAIOP_UPGRADE_RETENTION_AUDIT_LOG || '/var/lib/gaiop/upgrade/retention-cleanup-audit.jsonl',
  retentionLockPath: process.env.GAIOP_UPGRADE_RETENTION_LOCK_PATH || '/run/gaiop-upgrade-retention/cleanup.lock',
  failedPackageRetentionDays: Math.max(7, parseInt(process.env.GAIOP_UPGRADE_FAILED_PACKAGE_RETENTION_DAYS || '7', 10)),
  stagingRetentionHours: Math.max(24, parseInt(process.env.GAIOP_UPGRADE_STAGING_RETENTION_HOURS || '24', 10)),
  backupRetentionDays: Math.max(90, parseInt(process.env.GAIOP_UPGRADE_BACKUP_RETENTION_DAYS || '90', 10)),
  backupMinUsableGroups: Math.max(5, parseInt(process.env.GAIOP_UPGRADE_BACKUP_MIN_USABLE_GROUPS || '5', 10)),
};

module.exports = config;
