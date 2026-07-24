/**
 * 认证中间件。
 *
 * 升级服务信任 Caddy 的反向代理认证：
 * Caddy 验证 Basic Auth 后在请求头中添加 X-Authenticated-User。
 * 升级服务从该头读取操作人信息。
 *
 * 本地开发时（无 Caddy），默认用户为 "admin"。
 */
const crypto = require('crypto');

function hasMatchingInternalToken(value) {
  const token = process.env.GAIOP_UPGRADE_INTERNAL_TOKEN || '';
  if (!token || typeof value !== 'string') return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(value);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function authMiddleware(req, res, next) {
  // Health remains available to an ISO-local liveness probe. Every other
  // production request is authenticated by the BFF internal token when set.
  if (req.path !== '/health' && process.env.GAIOP_UPGRADE_INTERNAL_TOKEN) {
    if (!hasMatchingInternalToken(req.headers['x-gaiop-upgrade-token'])) {
      return res.status(401).json({ error: true, code: 'UPGRADE_INTERNAL_AUTH_REQUIRED', message: 'Unauthorized' });
    }
    const actor = String(req.headers['x-gaiop-upgrade-actor'] || '').trim();
    if (!actor) {
      return res.status(400).json({ error: true, code: 'UPGRADE_ACTOR_REQUIRED', message: 'Operator is required' });
    }
    req.operator = actor;
  } else {
    req.operator = req.headers['x-authenticated-user'] || 'admin';
  }
  req.clientIp = req.headers['x-forwarded-for'] || req.ip || '127.0.0.1';
  next();
}

module.exports = authMiddleware;
