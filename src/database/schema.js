const { getDb } = require('./connection');

/**
 * 初始化数据库 schema（建表 + 索引）。
 * 幂等操作：所有 DDL 使用 IF NOT EXISTS。
 */
function initSchema() {
  const db = getDb();

  db.exec(`
    -- ============================================================
    -- 组件当前状态表
    -- ============================================================
    CREATE TABLE IF NOT EXISTS components (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    UNIQUE NOT NULL,
        type        TEXT    NOT NULL CHECK(type IN ('openclaw', 'frontend', 'skill')),
        version     TEXT    NOT NULL,
        status      TEXT    DEFAULT 'active' CHECK(status IN ('active', 'upgrading', 'degraded')),
        install_path TEXT   NOT NULL,
        updated_at  TEXT    DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 升级任务表
    -- ============================================================
    CREATE TABLE IF NOT EXISTS upgrade_tasks (
        id          TEXT    PRIMARY KEY,
        type        TEXT    NOT NULL CHECK(type IN ('skill-single', 'skill-bundle', 'openclaw', 'frontend', 'full-stack')),
        component   TEXT    NOT NULL,
        old_version TEXT,
        new_version TEXT,
        status      TEXT    DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'success', 'failed', 'rolling_back', 'rolled_back')),
        steps       TEXT    DEFAULT '[]',
        started_at  TEXT,
        finished_at TEXT,
        operator    TEXT,
        error       TEXT,
        created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 备份记录表
    -- ============================================================
    CREATE TABLE IF NOT EXISTS backups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        component   TEXT    NOT NULL,
        version     TEXT    NOT NULL,
        backup_path TEXT    NOT NULL,
        size_bytes  INTEGER DEFAULT 0,
        task_id     TEXT,
        created_at  TEXT    DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES upgrade_tasks(id) ON DELETE SET NULL
    );

    -- ============================================================
    -- 审计日志表
    -- ============================================================
    CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        action      TEXT    NOT NULL,
        component   TEXT,
        task_id     TEXT,
        operator    TEXT,
        ip          TEXT,
        detail      TEXT    DEFAULT '{}',
        created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- Schema 版本表
    -- ============================================================
    CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT    DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 索引
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_tasks_status     ON upgrade_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_component  ON upgrade_tasks(component);
    CREATE INDEX IF NOT EXISTS idx_tasks_created    ON upgrade_tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backups_component ON backups(component);
    CREATE INDEX IF NOT EXISTS idx_backups_created  ON backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_log(created_at DESC);
  `);

  // 记录 schema 版本
  const existing = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
  if (!existing || existing.v < 1) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (1)').run();
  }
}

module.exports = { initSchema };
