const express = require('express');
const router = express.Router();
const { getDb } = require('../database/connection');

/**
 * GET /api/v1/upgrade/status
 * 查询所有组件当前状态。
 */
router.get('/', (_req, res) => {
  const db = getDb();
  const components = db.prepare(
    'SELECT name, type, version, status, install_path, updated_at FROM components ORDER BY type, name'
  ).all();

  // 构造结构化响应
  const result = {
    openclaw: null,
    frontend: null,
    skills: {},
    maintenance_mode: false,
  };

  for (const comp of components) {
    const info = { version: comp.version, status: comp.status };
    if (comp.type === 'openclaw') {
      result.openclaw = info;
    } else if (comp.type === 'frontend') {
      result.frontend = info;
    } else if (comp.type === 'skill') {
      result.skills[comp.name] = info;
    }
  }

  res.json(result);
});

module.exports = router;
