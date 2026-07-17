/**
 * 维护模式管理。
 *
 * 在升级 OpenClaw 或全栈时，需要进入维护模式：
 * - 前端显示 Banner 提示用户
 * - 新请求可能失败（OpenClaw 重启中）
 * - 升级服务自身不受影响
 *
 * 实现：内存标志 + DB 持久化 + JSON 日志
 */
const { getDb } = require('../database/connection');

let _maintenance = false;

/**
 * 进入维护模式。
 * @param {string} reason  原因描述（如 "OpenClaw 平台升级中"）
 */
function enter(reason = '系统升级维护中') {
  if (_maintenance) return; // 已在维护中

  _maintenance = true;
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO components (name, type, version, install_path, status) VALUES ('__maintenance__', 'meta', ?, '', 'active')"
  ).run(reason);

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    action: 'maintenance_enter',
    reason,
  }));
}

/**
 * 退出维护模式。
 */
function exit() {
  if (!_maintenance) return;

  _maintenance = false;
  const db = getDb();
  db.prepare("DELETE FROM components WHERE name = '__maintenance__'").run();

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    action: 'maintenance_exit',
  }));
}

/**
 * 查询当前是否处于维护模式。
 */
function isActive() {
  return _maintenance;
}

/**
 * 从 DB 恢复维护状态（服务重启后调用）。
 */
function restore() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM components WHERE name = '__maintenance__'").get();
  if (row) {
    _maintenance = true;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      action: 'maintenance_restored',
      reason: row.version,
    }));
  }
}

module.exports = { enter, exit, isActive, restore };
