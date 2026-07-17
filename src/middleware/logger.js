/**
 * HTTP 请求日志中间件。
 * 输出结构化 JSON 日志到 stdout。
 */
function loggerMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      operator: req.operator || '-',
      ip: req.clientIp || '-',
    };
    console.log(JSON.stringify(logEntry));
  });

  next();
}

module.exports = loggerMiddleware;
