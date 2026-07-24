const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/connection');
const config = require('../config');
const { UpgradeValidator } = require('../services/UpgradeValidator');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();
const stagingDir = path.resolve(config.packageStagingRoot);

function removeStagedFile(file) {
  if (file?.path) fs.rmSync(file.path, { force: true });
}

// ── Multer 配置 ────────────────────────────────────────────
// 使用内存存储，避免在磁盘上留下未校验的包
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
      cb(null, stagingDir);
    },
    filename: (_req, _file, cb) => cb(null, uuidv4() + '.zip'),
  }),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB 上限
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    if (ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') {
      cb(null, true);
    } else {
      cb(createError(400, '仅支持 ZIP 格式的升级包'));
    }
  },
});

// ── 懒加载 Validator ───────────────────────────────────────
let validator = null;
function getValidator() {
  if (!validator) {
    const publicKey = fs.readFileSync(config.publicKeyPath, 'utf8');
    validator = new UpgradeValidator({
      publicKey,
      db: getDb(),
      config,
    });
  }
  return validator;
}

/**
 * POST /api/v1/upgrade/validate
 *
 * 上传升级包并进行校验（不执行升级）。
 * 校验通过后创建一条 pending 状态的 upgrade_task，
 * 返回 task_id 供后续 POST /execute 使用。
 */
router.post('/', upload.single('file'), (req, res, next) => {
  // ── 文件存在性检查 ────────────────────────────────────
  if (!req.file) {
    return next(createError(400, '请上传升级包文件（表单字段名: file）'));
  }

  const force = req.body?.force === 'true' || req.body?.force === true;

  // ── 执行校验 ──────────────────────────────────────────
  let result;
  try {
    result = getValidator().validate(req.file.path, { force });
  } catch (err) {
    removeStagedFile(req.file);
    return next(createError(500, `校验过程异常: ${err.message}`));
  }

  // ── 记录审计日志 ──────────────────────────────────────
  const operator = req.operator || 'admin';
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (action, component, task_id, operator, ip, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'validate',
    result.component || null,
    result.task_id,
    operator,
    req.ip,
    JSON.stringify({
      valid: result.valid,
      type: result.type,
      new_version: result.new_version,
      current_version: result.current_version,
    }),
  );

  // ── 校验通过 → 创建 pending 任务 + 保存包文件 ────────
  if (result.valid) {
    // 保存 ZIP 到磁盘，供后续 execute 使用
    const packageDir = path.join(config.dbPath, '..', 'packages');
    fs.mkdirSync(packageDir, { recursive: true });
    const packagePath = path.join(packageDir, `${result.task_id}.zip`);
    try {
      fs.copyFileSync(req.file.path, packagePath);
    } catch (err) {
      removeStagedFile(req.file);
      return next(createError(500, 'Unable to persist the validated upgrade package: ' + err.message));
    }

    db.prepare(`
      INSERT INTO upgrade_tasks (id, type, component, old_version, new_version, status, operator)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      result.task_id,
      result.type,
      result.component || null,
      result.current_version,
      result.new_version,
      operator,
    );

    // 获取任务详情用于响应
    const task = db.prepare('SELECT * FROM upgrade_tasks WHERE id = ?').get(result.task_id);
    removeStagedFile(req.file);
    return res.status(200).json({
      ...result,
      task,
    });
  }

  // ── 校验失败 → 只返回结果，不创建任务 ──────────────────
  removeStagedFile(req.file);
  return res.status(422).json(result);
});

// ── Multer 错误处理 ───────────────────────────────────────
router.use((err, req, _res, next) => {
  removeStagedFile(req.file);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(createError(413, '升级包大小超过限制（最大 500 MB）'));
    }
    return next(createError(400, `文件上传错误: ${err.message}`));
  }
  next(err);
});

module.exports = router;
