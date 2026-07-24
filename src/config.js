require('dotenv').config();

const config = {
  port: parseInt(process.env.NAPM_UPGRADE_PORT || '18900', 10),
  dbPath: process.env.NAPM_UPGRADE_DB_PATH || './data/napm-upgrade.db',
  backupRoot: process.env.NAPM_UPGRADE_BACKUP_ROOT || '/var/backups/napm',
  skillsRoot: process.env.NAPM_UPGRADE_SKILLS_ROOT || '/home/netinside/.openclaw/workspace/skills',
  pluginRoot: process.env.NAPM_UPGRADE_PLUGIN_ROOT || '/home/netinside/.openclaw/extensions/napm-openclaw-plugin',
  openclawRoot: process.env.NAPM_UPGRADE_OPENCLAW_ROOT || '/home/netinside/.npm-global/lib/node_modules/openclaw',
  frontendRoot: process.env.NAPM_UPGRADE_FRONTEND_ROOT || '/var/www/napm-admin',
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
};

module.exports = config;
