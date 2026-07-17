/**
 * 认证中间件。
 *
 * 升级服务信任 Caddy 的反向代理认证：
 * Caddy 验证 Basic Auth 后在请求头中添加 X-Authenticated-User。
 * 升级服务从该头读取操作人信息。
 *
 * 本地开发时（无 Caddy），默认用户为 "admin"。
 */
function authMiddleware(req, res, next) {
  const authenticatedUser = req.headers['x-authenticated-user'] || 'admin';
  req.operator = authenticatedUser;
  req.clientIp = req.headers['x-forwarded-for'] || req.ip || '127.0.0.1';
  next();
}

module.exports = authMiddleware;
