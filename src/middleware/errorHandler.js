/**
 * 全局错误处理中间件。
 * 统一 API 错误响应格式。
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    method: req.method,
    path: req.originalUrl,
    status: statusCode,
    error: message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  }));

  res.status(statusCode).json({
    error: true,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * 创建带状态码的业务错误。
 */
function createError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { errorHandler, createError };
