/**
 * 升级任务引擎。
 *
 * 职责：
 * 1. 任务状态机（pending → running → success/failed/rolling_back/rolled_back）
 * 2. 步骤追踪（JSON steps 字段，每步独立时间戳 + 消息）
 * 3. 并发控制（proper-lockfile 文件锁，按组件粒度）
 * 4. 通用执行编排（runSteps + 失败自动回滚）
 * 5. 回滚执行
 *
 * Upgrader 接口约定：
 *   preCheck(ctx)    → { message }
 *   backup(ctx)      → { message, backupPath?, sizeBytes? }
 *   replace(ctx)     → { message }
 *   reload(ctx)      → { message }
 *   smokeTest(ctx)   → { message }
 *   rollback(ctx)    → { message }
 *   finalize(ctx)    → { message }
 *
 *   ctx = { task, db, config, ...upgrader 自定义字段 }
 */
const path = require('path');
const { getDb } = require('../database/connection');
const config = require('../config');
const { checkReportAttributionGuard } = require('./ReportAttributionGuard');

// ── 步骤定义 ──────────────────────────────────────────────
const STEPS = ['pre_check', 'backup', 'replace', 'reload', 'smoke_test', 'finalize'];

const VALID_STATUSES = ['pending', 'running', 'success', 'failed', 'rolling_back', 'rolled_back'];

class UpgradeEngine {
  constructor({ db } = {}) {
    this.db = db || getDb();
  }

  // ──────────────────────────────────────────────────────────
  // 公开 API
  // ──────────────────────────────────────────────────────────

  /**
   * 执行升级任务。运行完所有步骤，失败时自动回滚。
   *
   * @param {string} taskId
   * @param {object} upgrader  实现了 upgrader 接口的对象
   * @returns {object} 最终任务记录
   */
  async executeTask(taskId, upgrader) {
    const task = this._getTask(taskId);
    if (!task) {
      throw Object.assign(new Error(`任务 ${taskId} 不存在`), { statusCode: 404 });
    }
    if (task.status !== 'pending') {
      throw Object.assign(new Error(`任务状态为 ${task.status}，无法执行（需要 pending）`), { statusCode: 409 });
    }

    // 获取分布式锁
    const lockName = this._lockName(task);
    let release;
    try {
      // proper-lockfile 在 Windows 上可能不可用，降级为跳过
      release = await this._tryLock(lockName);
    } catch (err) {
      throw Object.assign(
        new Error(`无法获取升级锁: ${err.message}。可能有另一个升级任务正在进行中。`),
        { statusCode: 423 },
      );
    }

    try {
      return await this._runSteps(task, upgrader);
    } finally {
      await this._tryRelease(release);
    }
  }

  /**
   * 执行手动回滚。
   *
   * @param {string} taskId   原始升级任务的 ID（用于审计关联）
   * @param {object} upgrader 实现了 rollback 方法的对象
   * @param {string} operator 操作人
   * @returns {object} 最终回滚任务记录
   */
  async executeRollback(taskId, component, targetVersion, upgrader, operator, suppliedRollbackTaskId = null) {
    const { v4: uuidv4 } = require('uuid');

    // 查找对应的组件
    const componentRow = this.db.prepare(
      'SELECT * FROM components WHERE name = ?'
    ).get(component);
    if (!componentRow) {
      throw Object.assign(new Error(`组件 ${component} 不存在`), { statusCode: 404 });
    }

    const rollbackTaskId = suppliedRollbackTaskId || uuidv4();
    const currentVersion = componentRow.version;

    // 创建回滚任务
    this.db.prepare(`
      INSERT INTO upgrade_tasks (id, type, component, old_version, new_version, status, operator)
      VALUES (?, 'skill-single', ?, ?, ?, 'pending', ?)
    `).run(rollbackTaskId, component, currentVersion, targetVersion, operator);

    // 记录审计
    this._audit('rollback_request', component, rollbackTaskId, operator, {
      from_version: currentVersion,
      to_version: targetVersion,
      original_task_id: taskId,
    });

    const rollbackTask = this._getTask(rollbackTaskId);

    // 获取锁
    const lockName = `UPGRADE_LOCK:${component}`;
    let release;
    try {
      release = await this._tryLock(lockName);
    } catch (err) {
      throw Object.assign(
        new Error(`无法获取回滚锁: ${err.message}`),
        { statusCode: 423 },
      );
    }

    try {
      return await this._runRollbackSteps(rollbackTask, upgrader, targetVersion, operator);
    } finally {
      await this._tryRelease(release);
    }
  }

  /**
   * 查询任务（单条）。
   */
  getTask(taskId) {
    return this._getTask(taskId);
  }

  /**
   * 查询任务列表。
   */
  listTasks({ status, component, limit = 20, offset = 0 } = {}) {
    let sql = 'SELECT * FROM upgrade_tasks WHERE 1=1';
    const params = [];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (component) {
      sql += ' AND component = ?';
      params.push(component);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const tasks = this.db.prepare(sql).all(...params);
    const total = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM upgrade_tasks'
    ).get().cnt;

    // 解析 steps JSON
    return {
      tasks: tasks.map((t) => ({
        ...t,
        steps: JSON.parse(t.steps || '[]'),
      })),
      total,
      limit,
      offset,
    };
  }

  // ──────────────────────────────────────────────────────────
  // 内部：步骤执行
  // ──────────────────────────────────────────────────────────

  async _runSteps(task, upgrader) {
    const ctx = {
      task,
      db: this.db,
      config,
      // 供 upgrader 写入自定义状态（如备份路径）
      state: {},
    };

    // 标记开始
    this._updateTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    let failedStep = null;

    for (const step of STEPS) {
      this._updateStep(task.id, step, 'running');

      let result;
      try {
        result = await this._invokeStep(step, upgrader, ctx);
        this._updateStep(task.id, step, 'completed', result?.message || '完成');
      } catch (err) {
        this._updateStep(task.id, step, 'failed', err.message);
        failedStep = step;
        break;
      }
    }

    if (failedStep) {
      // 如果失败发生在 backup 之后 → 自动回滚
      const failedIndex = STEPS.indexOf(failedStep);
      const backupIndex = STEPS.indexOf('backup');

      if (failedIndex > backupIndex) {
        await this._autoRollback(task, upgrader, ctx);
      } else {
        this._updateTask(task.id, {
          status: 'failed',
          error: `步骤 ${failedStep} 失败`,
          finished_at: new Date().toISOString(),
        });
        this._audit('upgrade_failed', task.component, task.id, task.operator, {
          failed_step: failedStep,
        });
      }
    } else {
      // 全部成功
      this._updateTask(task.id, {
        status: 'success',
        finished_at: new Date().toISOString(),
      });
      this._audit('upgrade_success', task.component, task.id, task.operator, {
        old_version: task.old_version,
        new_version: task.new_version,
      });
    }

    return this._getTask(task.id);
  }

  async _runRollbackSteps(task, upgrader, targetVersion, operator) {
    this._updateTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    this._updateStep(task.id, 'verify', 'running');
    try {
      // 验证备份存在
      const backup = this.db.prepare(
        'SELECT * FROM backups WHERE component = ? AND version = ? ORDER BY created_at DESC LIMIT 1'
      ).get(task.component, targetVersion);

      if (!backup) {
        throw new Error(`未找到组件 ${task.component} 版本 ${targetVersion} 的备份`);
      }

      this._updateStep(task.id, 'verify', 'completed', `备份路径: ${backup.backup_path}`);
    } catch (err) {
      this._updateStep(task.id, 'verify', 'failed', err.message);
      this._updateTask(task.id, {
        status: 'failed',
        error: err.message,
        finished_at: new Date().toISOString(),
      });
      return this._getTask(task.id);
    }

    // 执行回滚
    this._updateStep(task.id, 'rollback', 'running');
    try {
      // 将备份路径传给 upgrader
      const backup = this.db.prepare(
        'SELECT * FROM backups WHERE component = ? AND version = ? ORDER BY created_at DESC LIMIT 1'
      ).get(task.component, targetVersion);
      const ctx = { task, db: this.db, config, state: { targetVersion, backupPath: backup?.backup_path } };
      const result = await upgrader.rollback(ctx);
      this._updateStep(task.id, 'rollback', 'completed', result?.message || '回滚完成');
    } catch (err) {
      this._updateStep(task.id, 'rollback', 'failed', err.message);
      this._updateTask(task.id, {
        status: 'failed',
        error: `回滚失败: ${err.message}，需要人工介入`,
        finished_at: new Date().toISOString(),
      });

      // 标记组件为 degraded
      this.db.prepare(
        "UPDATE components SET status = 'degraded' WHERE name = ?"
      ).run(task.component);

      this._audit('rollback_failed', task.component, task.id, operator, {
        error: err.message,
      });
      return this._getTask(task.id);
    }

    // 冒烟
    this._updateStep(task.id, 'smoke_test', 'running');
    try {
      // 获取组件路径用于冒烟测试
      const componentRow = this.db.prepare(
        'SELECT install_path FROM components WHERE name = ?'
      ).get(task.component);
      const smokeCtx = {
        task,
        db: this.db,
        config,
        state: {
          targetPath: componentRow?.install_path,
          skillName: task.component,
        },
      };
      const result = await upgrader.smokeTest(smokeCtx);
      this._updateStep(task.id, 'smoke_test', 'completed', result?.message || '回滚后冒烟通过');
    } catch (err) {
      this._updateStep(task.id, 'smoke_test', 'failed', err.message);
      this._updateTask(task.id, {
        status: 'failed',
        error: `回滚后冒烟测试失败: ${err.message}`,
        finished_at: new Date().toISOString(),
      });
      this.db.prepare(
        "UPDATE components SET status = 'degraded' WHERE name = ?"
      ).run(task.component);
      return this._getTask(task.id);
    }

    // 成功
    this._updateTask(task.id, {
      status: 'rolled_back',
      finished_at: new Date().toISOString(),
    });

    // 更新组件版本
    this.db.prepare(
      "UPDATE components SET version = ?, updated_at = datetime('now'), status = 'active' WHERE name = ?"
    ).run(targetVersion, task.component);

    this._audit('rollback_success', task.component, task.id, operator, {
      from_version: task.old_version,
      to_version: targetVersion,
    });

    return this._getTask(task.id);
  }

  // ──────────────────────────────────────────────────────────
  // 内部：自动回滚
  // ──────────────────────────────────────────────────────────

  async _autoRollback(task, upgrader, ctx) {
    this._updateTask(task.id, { status: 'rolling_back' });
    this._audit('auto_rollback_start', task.component, task.id, task.operator, {});

    this._updateStep(task.id, 'rollback', 'running');
    try {
      const result = await upgrader.rollback(ctx);
      this._updateStep(task.id, 'rollback', 'completed', result?.message || '自动回滚完成');

      // 回滚后冒烟（ctx 中已有 targetPath 和 skillName）
      this._updateStep(task.id, 'smoke_test', 'running');
      try {
        // 确保 ctx 中有组件路径
        if (!ctx.state.targetPath) {
          const componentRow = this.db.prepare(
            'SELECT install_path FROM components WHERE name = ?'
          ).get(task.component);
          ctx.state.targetPath = componentRow?.install_path;
        }
        const smoke = await upgrader.smokeTest(ctx);
        this._updateStep(task.id, 'smoke_test', 'completed', smoke?.message || '回滚后冒烟通过');
        this._updateTask(task.id, {
          status: 'rolled_back',
          finished_at: new Date().toISOString(),
        });
        this._audit('auto_rollback_success', task.component, task.id, task.operator, {});
      } catch (smokeErr) {
        this._updateStep(task.id, 'smoke_test', 'failed', smokeErr.message);
        this._updateTask(task.id, {
          status: 'failed',
          error: `自动回滚后冒烟失败: ${smokeErr.message}`,
          finished_at: new Date().toISOString(),
        });
        this.db.prepare(
          "UPDATE components SET status = 'degraded' WHERE name = ?"
        ).run(task.component);
        this._audit('auto_rollback_smoke_failed', task.component, task.id, task.operator, {
          error: smokeErr.message,
        });
      }
    } catch (rollbackErr) {
      this._updateStep(task.id, 'rollback', 'failed', rollbackErr.message);
      this._updateTask(task.id, {
        status: 'failed',
        error: `自动回滚失败: ${rollbackErr.message}，需要人工介入`,
        finished_at: new Date().toISOString(),
      });
      this.db.prepare(
        "UPDATE components SET status = 'degraded' WHERE name = ?"
      ).run(task.component);
      this._audit('auto_rollback_failed', task.component, task.id, task.operator, {
        error: rollbackErr.message,
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  // 内部：锁管理
  // ──────────────────────────────────────────────────────────

  _lockName(task) {
    switch (task.type) {
      case 'skill-single':
        return `UPGRADE_LOCK:${task.component}`;
      case 'skill-bundle':
        return 'UPGRADE_LOCK:skills';
      case 'openclaw':
        return 'UPGRADE_LOCK:openclaw';
      case 'frontend':
        return 'UPGRADE_LOCK:frontend';
      case 'full-stack':
        return 'UPGRADE_LOCK:full-stack';
      default:
        return `UPGRADE_LOCK:${task.component || 'global'}`;
    }
  }

  async _tryLock(lockName) {
    try {
      const lockfile = require('proper-lockfile');
      const lockPath = path.join(config.lockDir, `${lockName}.lock`);
      return await lockfile.lock(lockPath, {
        retries: 0,
        stale: 300000, // 5 min stale
      });
    } catch (err) {
      // Windows 上 proper-lockfile 可能不可用 → 降级跳过锁
      if (err.code === 'ENOENT' || err.code === 'ENOTSUP' || err.code === 'ENOSYS') {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          message: `文件锁不可用（${err.code}），跳过并发控制`,
          lockName,
        }));
        return () => {}; // no-op release
      }
      throw err;
    }
  }

  async _tryRelease(release) {
    if (typeof release === 'function') {
      try {
        await release();
      } catch (_) { /* 静默 */ }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 内部：步骤映射
  // ──────────────────────────────────────────────────────────

  async _invokeStep(step, upgrader, ctx) {
    switch (step) {
      case 'pre_check':  return upgrader.preCheck ? upgrader.preCheck(ctx) : { message: '跳过' };
      case 'backup':     return upgrader.backup ? upgrader.backup(ctx) : { message: '跳过' };
      case 'replace':    return upgrader.replace ? upgrader.replace(ctx) : { message: '跳过' };
      case 'reload':     return upgrader.reload ? upgrader.reload(ctx) : { message: '跳过' };
      case 'smoke_test': {
        const result = upgrader.smokeTest ? await upgrader.smokeTest(ctx) : { message: '跳过' };
        const guard = checkReportAttributionGuard(ctx.config || config);
        if (!guard.enabled) return result;
        return { message: `${result?.message || '冒烟测试通过'}；报告归属适配索引正常 (${guard.entries} 条)` };
      }
      case 'finalize':   return upgrader.finalize ? upgrader.finalize(ctx) : { message: '跳过' };
      default:           return { message: '未知步骤' };
    }
  }

  // ──────────────────────────────────────────────────────────
  // 内部：数据库操作
  // ──────────────────────────────────────────────────────────

  _getTask(taskId) {
    const task = this.db.prepare('SELECT * FROM upgrade_tasks WHERE id = ?').get(taskId);
    if (task) {
      task.steps = JSON.parse(task.steps || '[]');
    }
    return task || null;
  }

  _updateTask(taskId, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    vals.push(taskId);
    this.db.prepare(`UPDATE upgrade_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  _updateStep(taskId, stepName, status, message = '') {
    const task = this._getTask(taskId);
    if (!task) return;

    const steps = task.steps;
    const existing = steps.find((s) => s.step === stepName);
    const now = new Date().toISOString();

    if (existing) {
      existing.status = status;
      existing.message = message || existing.message;
      if (status === 'running' && !existing.started_at) {
        existing.started_at = now;
      }
      if (['completed', 'failed'].includes(status)) {
        existing.finished_at = now;
      }
    } else {
      steps.push({
        step: stepName,
        status,
        message,
        started_at: status === 'running' ? now : null,
        finished_at: ['completed', 'failed'].includes(status) ? now : null,
      });
    }

    this.db.prepare('UPDATE upgrade_tasks SET steps = ? WHERE id = ?')
      .run(JSON.stringify(steps), taskId);
  }

  _audit(action, component, taskId, operator, detail = {}) {
    this.db.prepare(`
      INSERT INTO audit_log (action, component, task_id, operator, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(action, component, taskId, operator, JSON.stringify(detail));
  }
}

module.exports = { UpgradeEngine, STEPS };
