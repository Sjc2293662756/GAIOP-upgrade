const express = require('express');
const router = express.Router();

/**
 * GET /health
 * 升级服务自身健康检查。
 */
router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'napm-upgrade',
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
