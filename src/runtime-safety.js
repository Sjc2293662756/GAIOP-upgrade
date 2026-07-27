function assertProductionSafety(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (!String(env.GAIOP_UPGRADE_INTERNAL_TOKEN || '').trim()) {
    throw new Error('GAIOP_UPGRADE_INTERNAL_TOKEN is required in production');
  }
}

module.exports = { assertProductionSafety };
