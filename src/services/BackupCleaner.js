/**
 * 备份定时清理。
 *
 * 设计文档 §14.2:
 * - 每个组件保留最近 5 个成功版本的备份
 * - 每天 02:00 自动清理
 * - 物理删除备份目录 + DB 记录
 */
const fs = require('fs');
const cron = require('node-cron');
const { getDb } = require('../database/connection');
const config = require('../config');

/**
 * 启动定时清理任务。
 * @returns {object} cron task 实例
 */
function start() {
  const task = cron.schedule('0 2 * * *', () => {
    run();
  });

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: '备份定时清理已启动 (每天 02:00)',
  }));

  return task;
}

/**
 * 立即执行一次清理。
 */
function run(retentionOverride, dbOverride) {
  const db = dbOverride || getDb();
  const retention = (retentionOverride != null) ? retentionOverride : (config.backupRetention || 5);

  // 获取所有有备份的组件
  const components = db.prepare(
    'SELECT DISTINCT component FROM backups'
  ).all();

  let totalRemoved = 0;
  let totalFreed = 0;

  for (const { component } of components) {
    // 查询该组件的所有备份，按时间倒序
    const backups = db.prepare(
      'SELECT * FROM backups WHERE component = ? ORDER BY created_at DESC'
    ).all(component);

    // 保留前 N 个，删除其余的
    const toRemove = backups.slice(retention);

    for (const backup of toRemove) {
      // 物理删除备份目录
      if (backup.backup_path && fs.existsSync(backup.backup_path)) {
        try {
          fs.rmSync(backup.backup_path, { recursive: true, force: true });
          totalFreed += backup.size_bytes || 0;
        } catch (err) {
          console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'error',
            action: 'backup_cleanup',
            component,
            backup_path: backup.backup_path,
            error: err.message,
          }));
        }
      }

      // 删除 DB 记录
      db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
      totalRemoved++;
    }
  }

  if (totalRemoved > 0) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      action: 'backup_cleanup',
      removed: totalRemoved,
      freed_bytes: totalFreed,
    }));
  }

  return { removed: totalRemoved, freedBytes: totalFreed };
}

module.exports = { start, run };
