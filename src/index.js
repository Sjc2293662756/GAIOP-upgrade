const express = require('express');
const config = require('./config');
const { initSchema } = require('./database/schema');
const { seedComponents } = require('./database/seed');
const authMiddleware = require('./middleware/auth');
const loggerMiddleware = require('./middleware/logger');
const { errorHandler } = require('./middleware/errorHandler');

const healthRouter = require('./routes/health');
const statusRouter = require('./routes/status');
const validateRouter = require('./routes/validate');
const upgradeRouter = require('./routes/upgrade');

const backupCleaner = require('./services/BackupCleaner');
const { assertProductionSafety } = require('./runtime-safety');

// ── 数据库初始化 ──────────────────────────────────────────────
assertProductionSafety();
initSchema();
seedComponents();
backupCleaner.start();

// ── Express 应用 ──────────────────────────────────────────────
const app = express();

// 基础中间件
app.use(express.json());
app.use(authMiddleware);
app.use(loggerMiddleware);

// 路由挂载
app.use('/health', healthRouter);
app.use('/api/v1/upgrade/status', statusRouter);
app.use('/api/v1/upgrade/validate', validateRouter);
app.use('/api/v1/upgrade', upgradeRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: true, message: 'Not Found' });
});

// 全局错误处理
app.use(errorHandler);

// ── 启动服务 ──────────────────────────────────────────────────
app.listen(config.port, process.env.GAIOP_UPGRADE_HOST || '127.0.0.1', () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: `NAPM 升级服务已启动`,
    port: config.port,
    dbPath: config.dbPath,
  }));
});

module.exports = app;
