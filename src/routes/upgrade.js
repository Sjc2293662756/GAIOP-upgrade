/**
 * 升级执行相关路由。
 *
 * POST   /api/v1/upgrade/execute      执行升级任务
 * GET    /api/v1/upgrade/tasks         任务列表
 * GET    /api/v1/upgrade/tasks/:id     任务详情（含步骤进度）
 * POST   /api/v1/upgrade/rollback      手动回滚
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/connection');
const config = require('../config');
const { UpgradeEngine } = require('../services/UpgradeEngine');
const { SkillUpgrader } = require('../services/SkillUpgrader');
const { BundleUpgrader } = require('../services/BundleUpgrader');
const { OpenClawUpgrader } = require('../services/OpenClawUpgrader');
const { FrontendUpgrader } = require('../services/FrontendUpgrader');
const { FullStackUpgrader } = require('../services/FullStackUpgrader');
const { cleanupSuccessfulPackage } = require('../services/PackageCleaner');
const { createError } = require('../middleware/errorHandler');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

function isManagedBackupPath(value) {
  if (typeof value !== 'string' || !value) return false;
  const root = path.resolve(config.backupRoot);
  const target = path.resolve(value);
  return target.startsWith(root + path.sep);
}

// ── 懒加载引擎 ─────────────────────────────────────────────
let engine = null;
function getEngine() {
  if (!engine) {
    engine = new UpgradeEngine();
  }
  return engine;
}

// ════════════════════════════════════════════════════════════
// POST /execute — 执行升级
// ════════════════════════════════════════════════════════════
router.post('/execute', (req, res, next) => {
  const { task_id, force } = req.body || {};
  const operator = req.operator || 'admin';

  if (!task_id) {
    return next(createError(400, '缺少必填参数: task_id'));
  }

  const db = getDb();
  const task = db.prepare('SELECT * FROM upgrade_tasks WHERE id = ?').get(task_id);

  if (!task) {
    return next(createError(404, `任务 ${task_id} 不存在`));
  }
  if (task.status !== 'pending') {
    return next(createError(409, `任务状态为 ${task.status}，无法执行（需要 pending）`));
  }

  // 读取之前保存的升级包
  const packagePath = path.join(config.dbPath, '..', 'packages', `${task_id}.zip`);
  if (!fs.existsSync(packagePath)) {
    return next(createError(400, `升级包文件不存在，请重新上传校验`));
  }

  const zipBuffer = fs.readFileSync(packagePath);

  // 根据任务类型选择 upgrader
  let upgrader;
  try {
    upgrader = _createUpgrader(task.type, zipBuffer);
  } catch (err) {
    return next(createError(400, `无法创建升级器: ${err.message}`));
  }

  // 异步执行升级（不阻塞响应）
  res.status(202).json({
    task_id,
    status: 'accepted',
    tracking_url: `/api/v1/upgrade/tasks/${task_id}`,
  });

  // 后台执行
  getEngine().executeTask(task_id, upgrader).then((finalTask) => {
    // 升级成功 → 清理包文件，失败/回滚的包保留供排查
    cleanupSuccessfulPackage(finalTask, packagePath);
  }).catch((err) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      task_id,
      message: '后台升级任务异常',
      error: err.message,
    }));
  });
});

// ════════════════════════════════════════════════════════════
// GET /tasks — 任务列表
// ════════════════════════════════════════════════════════════
router.get('/tasks', (req, res) => {
  const { status, component, limit, offset } = req.query;
  const result = getEngine().listTasks({
    status,
    component,
    limit: parseInt(limit, 10) || 20,
    offset: parseInt(offset, 10) || 0,
  });
  res.json(result);
});

// ════════════════════════════════════════════════════════════
// GET /tasks/:id — 任务详情（含步骤进度）
// ════════════════════════════════════════════════════════════
router.get('/tasks/:id', (req, res, next) => {
  const task = getEngine().getTask(req.params.id);
  if (!task) {
    return next(createError(404, `任务 ${req.params.id} 不存在`));
  }

  // 计算进度百分比
  const stepOrder = ['pre_check', 'backup', 'replace', 'reload', 'smoke_test', 'finalize'];
  const steps = task.steps || [];
  let progressPercent = 0;

  if (['success', 'rolled_back'].includes(task.status)) {
    progressPercent = 100;
  } else if (['failed', 'rolling_back'].includes(task.status)) {
    // 根据最后完成的步骤计算
    const completedCount = steps.filter((s) => s.status === 'completed').length;
    progressPercent = Math.floor((completedCount / stepOrder.length) * 100);
  } else if (task.status === 'running') {
    const runningIndex = steps.findIndex((s) => s.status === 'running');
    if (runningIndex >= 0) {
      progressPercent = Math.floor(((runningIndex + 0.5) / stepOrder.length) * 100);
    } else {
      const completedCount = steps.filter((s) => s.status === 'completed').length;
      progressPercent = Math.floor((completedCount / stepOrder.length) * 100);
    }
  }

  // 补齐未开始的步骤（status = 'waiting'）
  for (const stepName of stepOrder) {
    if (!steps.find((s) => s.step === stepName)) {
      steps.push({ step: stepName, status: 'waiting', message: '等待中' });
    }
  }

  res.json({
    ...task,
    steps,
    progress_percent: progressPercent,
    current_step: steps.find((s) => s.status === 'running')?.step || null,
    estimated_remaining_seconds: _estimateRemaining(task.status, progressPercent),
  });
});

// ════════════════════════════════════════════════════════════
// POST /rollback — 手动回滚
// ════════════════════════════════════════════════════════════
router.post('/rollback', (req, res, next) => {
  const { component, target_version, task_id } = req.body || {};
  const operator = req.operator || 'admin';

  if (!component) {
    return next(createError(400, '缺少必填参数: component'));
  }

  const db = getDb();
  const rollbackComponent = db.prepare('SELECT type FROM components WHERE name = ?').get(component);
  if (!rollbackComponent) {
    return next(createError(404, 'Component not found'));
  }
  if (rollbackComponent.type !== 'skill') {
    return next(createError(400, 'Manual rollback is currently supported for Skill components only'));
  }

  // 确定目标版本
  let targetVersion = target_version;
  if (!targetVersion) {
    // 查找上一个版本
    const backups = db.prepare(
      'SELECT version FROM backups WHERE component = ? ORDER BY created_at DESC LIMIT 2'
    ).all(component);

    if (backups.length < 2) {
      return next(createError(400, `未找到组件 ${component} 的历史备份版本，请指定 target_version`));
    }

    // 最近的一个是当前版本的备份，次近的是上一个版本
    targetVersion = backups[1].version;
  }

  // 验证备份存在
  const backup = db.prepare(
    'SELECT * FROM backups WHERE component = ? AND version = ? LIMIT 1'
  ).get(component, targetVersion);

  if (!backup) {
    return next(createError(404, `未找到组件 ${component} 版本 ${targetVersion} 的备份`));
  }

  // 创建回滚 upgrader（简化的，只需要 rollback + smokeTest 方法）
  if (!isManagedBackupPath(backup.backup_path)) {
    return next(createError(400, 'Rollback backup is outside the managed backup directory'));
  }
  const upgrader = _createRollbackUpgrader(component, backup.backup_path);
  const rollbackTaskId = uuidv4();

  // 异步执行
  res.status(202).json({
    component,
    target_version: targetVersion,
    task_id: rollbackTaskId,
    status: 'accepted',
    message: `正在回滚 ${component} 到版本 ${targetVersion}`,
  });

  getEngine().executeRollback(task_id || '-', component, targetVersion, upgrader, operator, rollbackTaskId)
    .catch((err) => {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        component,
        message: '后台回滚任务异常',
        error: err.message,
      }));
    });
});

// ════════════════════════════════════════════════════════════
// GET /backups — 备份列表
// ════════════════════════════════════════════════════════════
router.get('/backups', (req, res) => {
  const db = getDb();
  const { component } = req.query;

  let sql = 'SELECT * FROM backups';
  const params = [];

  if (component) {
    sql += ' WHERE component = ?';
    params.push(component);
  }

  sql += ' ORDER BY created_at DESC LIMIT 50';
  const backups = db.prepare(sql).all(...params);

  res.json({ backups });
});

// ════════════════════════════════════════════════════════════
// DELETE /backups/:id — 删除指定备份
// ════════════════════════════════════════════════════════════
router.delete('/backups/:id', (req, res, next) => {
  const db = getDb();
  const operator = req.operator || 'admin';
  const backupId = req.params.id;

  const backup = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId);
  if (!backup) {
    return next(createError(404, `备份 ${backupId} 不存在`));
  }

  // 物理删除备份目录
  const backupPath = backup.backup_path;
  if (!isManagedBackupPath(backupPath)) {
    return next(createError(400, 'Backup is outside the managed backup directory'));
  }
  if (backupPath && fs.existsSync(backupPath)) {
    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
    } catch (err) {
      return next(createError(500, `删除备份目录失败: ${err.message}`));
    }
  }

  // 删除数据库记录
  db.prepare('DELETE FROM backups WHERE id = ?').run(backupId);

  // 审计日志
  db.prepare(`
    INSERT INTO audit_log (action, component, operator, ip, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'backup_delete',
    backup.component,
    operator,
    req.ip,
    JSON.stringify({
      backup_id: backup.id,
      version: backup.version,
      size_bytes: backup.size_bytes,
    }),
  );

  res.json({
    ok: true,
    message: `已删除备份: ${backup.component} v${backup.version}`,
    deleted: {
      id: backup.id,
      component: backup.component,
      version: backup.version,
    },
  });
});

// ════════════════════════════════════════════════════════════
// 内部辅助
// ════════════════════════════════════════════════════════════

/**
 * 根据任务类型创建对应的 upgrader。
 */
function _createUpgrader(type, zipBuffer) {
  switch (type) {
    case 'skill-single':
      return new SkillUpgrader(zipBuffer);
    case 'skill-bundle':
      return new BundleUpgrader(zipBuffer);
    case 'openclaw':
      return new OpenClawUpgrader(zipBuffer);
    case 'frontend':
      return new FrontendUpgrader(zipBuffer);
    case 'full-stack':
      return new FullStackUpgrader(zipBuffer);
    default:
      throw new Error(`暂不支持的升级类型: ${type}`);
  }
}

/**
 * 创建仅用于回滚的 upgrader（最小实现）。
 */
function _createRollbackUpgrader(component, backupPath) {
  const fs = require('fs');
  const path = require('path');
  const config = require('../config');
  if (!isManagedBackupPath(backupPath)) {
    throw new Error('Rollback backup is outside the managed backup directory');
  }

  return {
    async rollback(ctx) {
      const targetPath = _findComponentPath(component);
      if (!targetPath || !fs.existsSync(backupPath)) {
        throw new Error(`回滚路径无效: target=${targetPath}, backup=${backupPath}`);
      }

      const { execSync } = require('child_process');
      // 原子恢复
      const brokenPath = targetPath + '.broken';
      if (fs.existsSync(brokenPath)) {
        fs.rmSync(brokenPath, { recursive: true, force: true });
      }
      fs.renameSync(targetPath, brokenPath);

      try {
        // cp -a backup → target
        _copyDirSync(backupPath, targetPath);
        fs.rmSync(brokenPath, { recursive: true, force: true });
      } catch (err) {
        fs.renameSync(brokenPath, targetPath);
        throw err;
      }

      // 更新 DB
      const db = require('../database/connection').getDb();
      db.prepare(
        "UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active' WHERE name = ?"
      ).run(ctx.state.targetVersion || 'unknown', component);

      return { message: `已从 ${backupPath} 恢复` };
    },

    async smokeTest(ctx) {
      const targetPath = _findComponentPath(component);
      if (!targetPath) throw new Error('组件路径不存在');
      const skillMd = path.join(targetPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) throw new Error('SKILL.md 不存在，冒烟失败');
      return { message: '冒烟通过' };
    },
  };
}

function _findComponentPath(component) {
  const db = getDb();
  const row = db.prepare('SELECT install_path FROM components WHERE name = ?').get(component);
  return row ? row.install_path : null;
}

function _copyDirSync(src, dest) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDirSync(s, d);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function _estimateRemaining(status, percent) {
  if (['success', 'failed', 'rolled_back'].includes(status)) return 0;
  const remaining = 100 - percent;
  // 粗略估算：每 10% 约 3 秒（Skill）或 10 秒（OpenClaw）
  return Math.ceil((remaining / 10) * 3);
}

module.exports = router;
