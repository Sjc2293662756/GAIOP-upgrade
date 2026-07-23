#!/usr/bin/env node
/**
 * GAIOP 升级包打包工具 — 可视化界面。
 *
 * 启动本地 Web 服务 → 浏览器打开表单 → 浏览目录 → 填参打包。
 *
 * 用法:
 *   node tools/package-gui.js
 *   GAIOP_PACKAGE_GUI_PORT=18902 node tools/package-gui.js
 *   node tools/package-gui.js --no-open
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { packageSkill, packageBundle, packageOpenClaw, packageFrontend } = require('./package');

// ── 配置 ──────────────────────────────────────────────────
const PORT = parseInt(process.env.GAIOP_PACKAGE_GUI_PORT || '18901', 10);
const AUTO_OPEN = !process.argv.includes('--no-open');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── 路由 ──────────────────────────────────────────────────

/** 返回打包管理页面 */
app.get('/', (_req, res) => {
  res.type('html').send(PAGE_HTML);
});

/** 浏览目录 —— 供前端目录选择器使用 */
app.get('/api/browse', (req, res) => {
  try {
    let dirPath = req.query.path || '';

    // 规范化路径
    if (!dirPath) {
      // 默认展示盘符列表（Windows）或根目录
      if (process.platform === 'win32') {
        return listDrives(res);
      }
      dirPath = '/';
    }

    dirPath = path.resolve(dirPath);

    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ ok: false, error: `目录不存在: ${dirPath}` });
    }

    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ ok: false, error: '路径不是目录' });
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = [];
    const files = [];

    for (const entry of entries) {
      // 跳过隐藏文件/目录
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      if (entry.name === 'node_modules') continue;

      try {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          dirs.push({
            name: entry.name,
            path: fullPath,
          });
        } else {
          files.push({
            name: entry.name,
            path: fullPath,
            size: fs.statSync(fullPath).size,
          });
        }
      } catch {
        // 跳过无权限的条目
      }
    }

    // 排序：目录在前，字母序
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(dirPath);

    res.json({
      ok: true,
      path: dirPath,
      parent: parent !== dirPath ? parent : null,
      dirs,
      files,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** 列出 Windows 盘符 */
function listDrives(res) {
  const drives = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:/`;
    try {
      if (fs.existsSync(root)) {
        drives.push(root);
      }
    } catch {
      // skip
    }
  }
  res.json({ ok: true, path: '', parent: null, dirs: drives.map(d => ({ name: d, path: d })), files: [] });
}

/** 获取盘符列表（初始调用） */
app.get('/api/drives', (_req, res) => {
  listDrives(res);
});

/** 执行打包 */
app.post('/api/package', (req, res) => {
  const { type, component, version, sourceDir, outputDir, encryptionKey } = req.body || {};

  // 参数校验
  if (!type || !['skill', 'bundle', 'openclaw', 'frontend'].includes(type)) {
    return res.status(400).json({ ok: false, error: `无效包类型: ${type}` });
  }
  if (!version) {
    return res.status(400).json({ ok: false, error: '版本号不能为空' });
  }
  if (!sourceDir) {
    return res.status(400).json({ ok: false, error: '源目录不能为空' });
  }

  // 临时设置加密密钥
  if (encryptionKey) {
    process.env.NAPM_PACKAGE_ENCRYPTION_KEY = encryptionKey;
  } else {
    delete process.env.NAPM_PACKAGE_ENCRYPTION_KEY;
  }

  const outDir = outputDir || './out';

  try {
    let result;
    switch (type) {
      case 'skill': {
        if (!component) {
          return res.status(400).json({ ok: false, error: 'Skill 包需要填写组件名' });
        }
        result = packageSkill(component, version, sourceDir, outDir);
        break;
      }
      case 'bundle':
        result = packageBundle(version, sourceDir, outDir);
        break;
      case 'openclaw':
        result = packageOpenClaw(version, sourceDir, outDir);
        break;
      case 'frontend':
        result = packageFrontend(version, sourceDir, outDir);
        break;
    }

    res.json({
      ok: true,
      outputPath: result.outputPath,
      type: result.type,
      version: result.version,
      fileCount: result.fileCount,
      encrypted: result.encrypted,
      sizeBytes: result.sizeBytes,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 辅助：打开浏览器 ────────────────────────────────────
function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ── 启动（导出 + 直接运行两用）──────────────────────────
function startServer(port = PORT, autoOpen = AUTO_OPEN) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`\n🧰 GAIOP 升级包打包工具\n`);
      console.log(`   本地访问: ${url}`);
      console.log(`   按 Ctrl+C 停止\n`);

      if (autoOpen) {
        openBrowser(url);
      }
      resolve(srv);
    });

    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const url = `http://localhost:${port}`;
        console.log(`\n🧰 GAIOP 打包工具 — 已在运行\n`);
        console.log(`   端口 ${port} 已被占用 → 直接打开浏览器\n`);
        if (autoOpen) {
          openBrowser(url);
        }
        resolve(null); // 不 crash，返回 null 表示已有实例
      } else {
        reject(err);
      }
    });
  });
}

// 直接运行时自动启动
if (require.main === module) {
  startServer();
}

module.exports = { startServer };

// ════════════════════════════════════════════════════════════
// 内嵌 HTML 页面
// ════════════════════════════════════════════════════════════

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GAIOP 打包工具</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #F2F4F7;
    color: #2C3E50;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 40px 16px;
  }
  .container { max-width: 660px; width: 100%; }

  /* ── 头部 ── */
  .header {
    text-align: center; margin-bottom: 32px;
  }
  .header h1 {
    font-size: 24px; font-weight: 700; color: #2C3E50;
    display: flex; align-items: center; justify-content: center; gap: 10px;
  }
  .header p { color: #7B8A9B; margin-top: 6px; font-size: 14px; }
  .badge {
    display: inline-block; font-size: 12px; padding: 3px 8px; border-radius: 4px;
    font-weight: 600;
  }
  .badge-sign   { background: #E6F7EE; color: #5DAB8A; }
  .badge-crypto { background: #E6F4F9; color: #4DB8D8; }

  /* ── 卡片 ── */
  .card {
    background: #fff; border-radius: 12px; box-shadow: 0 1px 8px rgba(44,62,80,0.06);
    padding: 28px; margin-bottom: 20px;
  }
  .card-title {
    font-size: 16px; font-weight: 600; color: #2C3E50; margin-bottom: 20px;
    display: flex; align-items: center; gap: 8px;
  }
  .card-title::before { content: ''; display: inline-block; width: 4px; height: 18px; background: #7B9EBF; border-radius: 2px; }

  /* ── 类型选择 ── */
  .type-selector { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .type-option { position: relative; }
  .type-option input { position: absolute; opacity: 0; }
  .type-option label {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 14px 8px; border: 2px solid #E0E4E8; border-radius: 10px;
    cursor: pointer; transition: all 0.2s; text-align: center; font-size: 13px;
    font-weight: 500; color: #7B8A9B;
  }
  .type-option label .icon { font-size: 22px; }
  .type-option input:checked + label {
    border-color: #7B9EBF; background: #EDF2F7; color: #5A7D9E; font-weight: 600;
  }
  .type-option label:hover { border-color: #7B9EBF; }
  .type-desc {
    font-size: 11px; font-weight: 400; color: #B0BEC5; margin-top: -2px;
  }
  .type-option input:checked + label .type-desc { color: #7B9EBF; }

  /* ── 表单 ── */
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 13px; font-weight: 600; color: #2C3E50; margin-bottom: 5px; }
  .input-row { display: flex; gap: 8px; }
  .input-row input {
    flex: 1; padding: 10px 12px; border: 1.5px solid #E0E4E8; border-radius: 8px;
    font-size: 14px; transition: border-color 0.2s; outline: none; font-family: monospace;
  }
  .input-row input:focus { border-color: #7B9EBF; box-shadow: 0 0 0 3px rgba(123,158,191,0.12); }
  .btn-browse {
    padding: 10px 14px; border: 1.5px solid #7B9EBF; border-radius: 8px;
    background: #fff; color: #5A7D9E; font-size: 13px; font-weight: 600;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .btn-browse:hover { background: #7B9EBF; color: #fff; }
  .form-group input:not(.input-row input) {
    width: 100%; padding: 10px 12px; border: 1.5px solid #E0E4E8; border-radius: 8px;
    font-size: 14px; transition: border-color 0.2s; outline: none;
  }
  .form-group input:focus { border-color: #7B9EBF; box-shadow: 0 0 0 3px rgba(123,158,191,0.12); }
  .form-hint { font-size: 12px; color: #7B8A9B; margin-top: 3px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  #bundleFields, #openclawFields, #frontendFields { display: none; }

  /* ── 加密区域 ── */
  .encrypt-toggle {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px; cursor: pointer;
    font-size: 14px; font-weight: 500;
  }
  .encrypt-toggle input[type=checkbox] { width: 18px; height: 18px; accent-color: #7B9EBF; }

  /* ── 按钮 ── */
  .btn-row { display: flex; gap: 12px; }
  .btn {
    flex: 1; padding: 12px 20px; border: none; border-radius: 8px; font-size: 15px;
    font-weight: 600; cursor: pointer; transition: all 0.2s;
  }
  .btn-primary { background: #7B9EBF; color: #fff; }
  .btn-primary:hover { background: #5A7D9E; }
  .btn-primary:disabled { background: #C8D6E5; cursor: not-allowed; }

  /* ── 结果 ── */
  #resultArea { display: none; }
  .result { border-radius: 8px; padding: 18px; font-size: 14px; }
  .result-success { background: #E6F7EE; border: 1px solid #7ECBA1; color: #3D7A5C; }
  .result-error   { background: #FDF0EE; border: 1px solid #E07060; color: #B84040; }
  .result-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; }
  .result-info { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; }
  .result-info dt { color: #7B8A9B; font-weight: 500; }
  .result-info dd { font-family: monospace; font-size: 13px; word-break: break-all; }

  /* ── 目录选择器弹窗 ── */
  .modal-overlay {
    display: none; position: fixed; inset: 0; background: rgba(44,62,80,0.35);
    z-index: 1000; justify-content: center; align-items: center;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: #fff; border-radius: 14px; width: 90%; max-width: 600px;
    max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 40px rgba(44,62,80,0.18);
  }
  .modal-header {
    padding: 16px 20px; border-bottom: 1px solid #E0E4E8;
    display: flex; align-items: center; justify-content: space-between;
  }
  .modal-header h3 { font-size: 16px; color: #2C3E50; }
  .modal-close {
    width: 32px; height: 32px; border: none; background: #F2F4F7; border-radius: 8px;
    font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    color: #7B8A9B;
  }
  .modal-close:hover { background: #E0E4E8; color: #2C3E50; }

  /* 跳转栏 */
  .modal-jump {
    padding: 10px 20px; display: flex; gap: 8px; border-bottom: 1px solid #F2F4F7;
  }
  .modal-jump input {
    flex: 1; padding: 8px 10px; border: 1.5px solid #E0E4E8; border-radius: 6px;
    font-size: 13px; font-family: monospace; outline: none;
  }
  .modal-jump input:focus { border-color: #7B9EBF; }
  .modal-jump button {
    padding: 8px 14px; border: none; background: #7B9EBF; color: #fff;
    border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .modal-jump button:hover { background: #5A7D9E; }

  /* 面包屑 */
  .breadcrumb {
    padding: 8px 20px; background: #F8F9FB; border-bottom: 1px solid #E0E4E8;
    display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 13px;
    min-height: 36px; overflow-x: auto;
  }
  .breadcrumb span { color: #B0BEC5; }
  .breadcrumb a { color: #7B9EBF; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .breadcrumb a:hover { text-decoration: underline; color: #5A7D9E; }

  /* 目录列表 */
  .dir-list {
    flex: 1; overflow-y: auto; padding: 8px 0; min-height: 200px; max-height: 350px;
  }
  .dir-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 20px;
    cursor: pointer; transition: background 0.1s; border: none; width: 100%;
    background: none; font-size: 14px; text-align: left; color: #2C3E50;
  }
  .dir-item:hover { background: #EDF2F7; }
  .dir-item.selected { background: #E0EBF5; }
  .dir-item .folder-icon { font-size: 18px; flex-shrink: 0; }
  .dir-item .item-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dir-item.up-level { color: #7B8A9B; font-weight: 500; }
  .dir-empty { padding: 40px 20px; text-align: center; color: #7B8A9B; font-size: 14px; }

  /* 底部 */
  .modal-footer {
    padding: 14px 20px; border-top: 1px solid #E0E4E8;
    display: flex; align-items: center; justify-content: space-between;
  }
  .modal-footer .current-path {
    font-size: 12px; color: #7B8A9B; font-family: monospace;
    max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .modal-footer button {
    padding: 10px 24px; border: none; background: #7ECBA1; color: #fff;
    border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .modal-footer button:hover { background: #5DAB8A; }

  /* ── 响应式 ── */
  @media (max-width: 520px) {
    .type-selector { grid-template-columns: repeat(2, 1fr); }
    .form-row { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>🧰 GAIOP 打包工具</h1>
    <p>
      <span class="badge badge-sign">RSA-SHA256 签名</span>
      &nbsp;
      <span class="badge badge-crypto">AES-256-GCM 可选加密</span>
    </p>
  </div>

  <!-- ── 包类型选择 ── -->
  <div class="card">
    <div class="card-title">选择包类型</div>
    <div class="type-selector">
      <div class="type-option">
        <input type="radio" name="pkgType" value="skill" id="tSkill" checked onchange="switchType()">
        <label for="tSkill"><span class="icon">📦</span> Skill<span class="type-desc">单个技能插件</span></label>
      </div>
      <div class="type-option">
        <input type="radio" name="pkgType" value="bundle" id="tBundle" onchange="switchType()">
        <label for="tBundle"><span class="icon">📚</span> Bundle<span class="type-desc">批量技能合集</span></label>
      </div>
      <div class="type-option">
        <input type="radio" name="pkgType" value="openclaw" id="tOpenClaw" onchange="switchType()">
        <label for="tOpenClaw"><span class="icon">⚙️</span> OpenClaw<span class="type-desc">CLI / AI 运行时</span></label>
      </div>
      <div class="type-option">
        <input type="radio" name="pkgType" value="frontend" id="tFrontend" onchange="switchType()">
        <label for="tFrontend"><span class="icon">🌐</span> Frontend<span class="type-desc">Web 管理后台</span></label>
      </div>
    </div>
  </div>

  <!-- ── 参数表单 ── -->
  <div class="card">
    <div class="card-title">打包参数</div>

    <!-- Skill 字段 -->
    <div id="skillFields">
      <p style="font-size:13px;color:#666;margin-bottom:16px;padding:8px 12px;background:#f8f9fa;border-radius:6px;">📦 <b>Skill 包</b> — 打包<b>单个技能插件</b>目录。适用于更新某个 Skill（如 napm-diag），替换后 touch SKILL.md 热加载生效。</p>
      <div class="form-group">
        <label for="fComponent">组件名</label>
        <input type="text" id="fComponent" placeholder="如: napm-diag">
        <div class="form-hint">Skill 的目录名，必须与服务器上注册的名称一致</div>
      </div>
      <div class="form-group">
        <label for="fVersion">版本号</label>
        <input type="text" id="fVersion" placeholder="如: 2.1.0（SemVer 格式）">
      </div>
      <div class="form-group">
        <label for="fSourceDir">源目录</label>
        <div class="input-row">
          <input type="text" id="fSourceDir" placeholder="如: ./skills/napm-diag">
          <button class="btn-browse" onclick="openBrowser('fSourceDir')">📁 浏览</button>
        </div>
        <div class="form-hint">Skill 代码所在目录（包含 SKILL.md）</div>
      </div>
      <div class="form-group">
        <label for="fOutputDir">输出目录</label>
        <div class="input-row">
          <input type="text" id="fOutputDir" placeholder="默认: ./out">
          <button class="btn-browse" onclick="openBrowser('fOutputDir')">📁 浏览</button>
        </div>
      </div>
    </div>

    <!-- Bundle 字段 -->
    <div id="bundleFields">
      <p style="font-size:13px;color:#666;margin-bottom:16px;padding:8px 12px;background:#f8f9fa;border-radius:6px;">📚 <b>Bundle 包</b> — 打包<b>整个 skills/ 目录下所有 Skill</b>。适用于批量升级，合并替换 + 自动注册新 Skill。</p>
      <div class="form-group">
        <label for="fBundleVersion">合集版本号</label>
        <input type="text" id="fBundleVersion" placeholder="整套 Skills 的版本，如: 2026.7.0">
        <div class="form-hint">作为整个 Skill 集合的版本标识，打包后生成 napm-skills-{version}.zip</div>
      </div>
      <div class="form-group">
        <label for="fBundleSourceDir">Skills 根目录</label>
        <div class="input-row">
          <input type="text" id="fBundleSourceDir" placeholder="包含所有 Skill 子目录的父目录，如: ./skills">
          <button class="btn-browse" onclick="openBrowser('fBundleSourceDir')">📁 浏览</button>
        </div>
        <div class="form-hint">该目录下每个子目录（如 napm-diag/、napm-monitor/）会被打包为一个独立 Skill</div>
      </div>
      <div class="form-group">
        <label for="fBundleOutputDir">输出目录</label>
        <div class="input-row">
          <input type="text" id="fBundleOutputDir" placeholder="ZIP 文件输出位置，默认: ./out">
          <button class="btn-browse" onclick="openBrowser('fBundleOutputDir')">📁 浏览</button>
        </div>
      </div>
    </div>

    <!-- OpenClaw 字段 -->
    <div id="openclawFields">
      <p style="font-size:13px;color:#666;margin-bottom:16px;padding:8px 12px;background:#f8f9fa;border-radius:6px;">⚙️ <b>OpenClaw 包</b> — 打包 <b>OpenClaw CLI / AI 运行时</b>。升级时自动进入维护模式 → systemctl restart → 健康轮询（60s）。</p>
      <div class="form-group">
        <label for="fOpenClawVersion">OpenClaw 版本号</label>
        <input type="text" id="fOpenClawVersion" placeholder="OpenClaw 发版版本，如: 2026.6.0">
        <div class="form-hint">建议与 OpenClaw 官方发版号保持一致，打包后生成 openclaw-{version}.zip</div>
      </div>
      <div class="form-group">
        <label for="fOpenClawSourceDir">OpenClaw 发行目录</label>
        <div class="input-row">
          <input type="text" id="fOpenClawSourceDir" placeholder="OpenClaw 构建/安装后的根目录">
          <button class="btn-browse" onclick="openBrowser('fOpenClawSourceDir')">📁 浏览</button>
        </div>
        <div class="form-hint">该目录下所有文件（包括 node_modules/、dist/ 等）都会被纳入升级包</div>
      </div>
      <div class="form-group">
        <label for="fOpenClawOutputDir">输出目录</label>
        <div class="input-row">
          <input type="text" id="fOpenClawOutputDir" placeholder="ZIP 文件输出位置，默认: ./out">
          <button class="btn-browse" onclick="openBrowser('fOpenClawOutputDir')">📁 浏览</button>
        </div>
      </div>
    </div>

    <!-- Frontend 字段 -->
    <div id="frontendFields">
      <p style="font-size:13px;color:#666;margin-bottom:16px;padding:8px 12px;background:#f8f9fa;border-radius:6px;">🌐 <b>Frontend 包</b> — 打包 <b>Web 管理后台前端</b>（Vite/Webpack 构建产物 dist/）。静态文件原子替换 + HTTP 冒烟测试。</p>
      <div class="form-group">
        <label for="fFrontendVersion">前端版本号</label>
        <input type="text" id="fFrontendVersion" placeholder="前端发版版本，如: 2.2.0（SemVer 格式）">
        <div class="form-hint">建议与前端 package.json 中的版本号一致，打包后生成 napm-frontend-{version}.zip</div>
      </div>
      <div class="form-group">
        <label for="fFrontendSourceDir">前端构建产物目录</label>
        <div class="input-row">
          <input type="text" id="fFrontendSourceDir" placeholder="npm run build 后的 dist/ 目录路径">
          <button class="btn-browse" onclick="openBrowser('fFrontendSourceDir')">📁 浏览</button>
        </div>
        <div class="form-hint">Vite/Webpack build 输出的 dist/ 目录</div>
      </div>
      <div class="form-group">
        <label for="fFrontendOutputDir">输出目录</label>
        <div class="input-row">
          <input type="text" id="fFrontendOutputDir" placeholder="ZIP 文件输出位置，默认: ./out">
          <button class="btn-browse" onclick="openBrowser('fFrontendOutputDir')">📁 浏览</button>
        </div>
      </div>
    </div>

    <!-- ── 加密选项 ── -->
    <div style="margin-top: 8px; padding-top: 16px; border-top: 1px solid #eee;">
      <label class="encrypt-toggle">
        <input type="checkbox" id="fEncrypt" onchange="switchEncrypt()">
        <span>启用 AES-256-GCM 加密</span>
      </label>
      <div id="encryptKeyGroup" class="form-group">
        <label for="fEncryptKey">加密密钥（64 位 hex，32 字节）</label>
        <input type="password" id="fEncryptKey" placeholder="从 .env 或管理员处获取密钥">
        <div class="form-hint">留空则不加密，生成明文 ZIP 包</div>
      </div>
    </div>

    <!-- ── 按钮 ── -->
    <div class="btn-row" style="margin-top: 20px;">
      <button class="btn btn-primary" id="buildBtn" onclick="doBuild()">
        🚀 打包并签名
      </button>
    </div>
  </div>

  <!-- ── 结果区域 ── -->
  <div id="resultArea">
    <div class="card">
      <div class="card-title">打包结果</div>
      <div id="resultContent"></div>
    </div>
  </div>

</div>

<!-- ── 目录选择器弹窗 ── -->
<div class="modal-overlay" id="browserModal">
  <div class="modal">
    <div class="modal-header">
      <h3>📁 选择目录</h3>
      <button class="modal-close" onclick="closeBrowser()">&times;</button>
    </div>
    <div class="modal-jump">
      <input type="text" id="browserJumpInput" placeholder="输入路径后回车跳转...">
      <button onclick="jumpToPath()">跳转</button>
    </div>
    <div class="breadcrumb" id="browserBreadcrumb"></div>
    <div class="dir-list" id="browserList"></div>
    <div class="modal-footer">
      <span class="current-path" id="browserCurrentPath"></span>
      <button onclick="selectCurrentDir()">✅ 选择此目录</button>
    </div>
  </div>
</div>

<script>
// ════════════════════════════════════════════════════════════
// 目录选择器
// ════════════════════════════════════════════════════════════
let browserTargetInput = null;   // 当前正在为哪个 input 选择目录
let browserCurrentPath = '';     // 当前浏览的路径
let browserSelectedDir = '';     // 当前选中的子目录（高亮）

async function openBrowser(inputId) {
  try {
    browserTargetInput = inputId;
    document.getElementById('browserModal').classList.add('active');

    // 从 input 当前值作为起始路径
    const currentVal = document.getElementById(inputId).value.trim();
    if (currentVal) {
      await navigateTo(currentVal);
    } else {
      await navigateTo('');
    }
  } catch (err) {
    alert('目录选择器出错: ' + err.message);
  }
}

function closeBrowser() {
  document.getElementById('browserModal').classList.remove('active');
  browserTargetInput = null;
}

// 点击遮罩关闭
document.getElementById('browserModal').addEventListener('click', function(e) {
  if (e.target === this) closeBrowser();
});

async function navigateTo(dirPath) {
  try {
    const resp = await fetch('/api/browse?path=' + encodeURIComponent(dirPath));
    const data = await resp.json();

    if (!data.ok) {
      alert('无法访问目录: ' + (data.error || '未知错误'));
      return;
    }

    browserCurrentPath = data.path;
    browserSelectedDir = '';

    // 更新当前路径显示
    document.getElementById('browserCurrentPath').textContent = data.path || '选择盘符';

    // 渲染面包屑
    renderBreadcrumb(data.path);

    // 渲染目录列表
    renderDirList(data);

    // 更新跳转输入框
    document.getElementById('browserJumpInput').value = data.path || '';

  } catch (err) {
    alert('请求失败: ' + err.message);
  }
}

function renderBreadcrumb(dirPath) {
  const bc = document.getElementById('browserBreadcrumb');
  if (!dirPath) {
    bc.innerHTML = '<span>计算机</span>';
    return;
  }

  // 拆分路径为层级
  let parts;
  if (dirPath.includes(':/')) {
    // Windows: G:/a/b/c — normalize backslashes
    parts = dirPath.replace(/\\\\/g, '/').split('/').filter(Boolean);
  } else {
    // Unix: /a/b/c
    parts = dirPath.split('/').filter(Boolean);
    if (dirPath.startsWith('/')) parts.unshift('/');
  }

  let html = '';
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) html += '<span> / </span>';
    if (parts[i] === '/') {
      accumulated = '/';
      html += '<a href="#" data-nav="' + escAttr('/') + '">/</a>';
    } else {
      if (accumulated && !accumulated.endsWith('/')) {
        accumulated += '/';
      }
      accumulated += parts[i];
      html += '<a href="#" data-nav="' + escAttr(accumulated) + '">' + escapeHtml(parts[i]) + '</a>';
    }
  }

  bc.innerHTML = html;
}

function renderDirList(data) {
  const list = document.getElementById('browserList');

  let html = '';
  // ".." 返回上级
  if (data.parent !== null && data.parent !== data.path) {
    html += '<button class="dir-item up-level" data-nav="' + escAttr(data.parent) + '">';
    html += '<span class="folder-icon">📂</span>';
    html += '<span class="item-name">.. (上级目录)</span>';
    html += '</button>';
  }

  if (data.dirs.length === 0 && (data.parent === null || data.parent === data.path)) {
    html += '<div class="dir-empty">此目录下没有子目录</div>';
  }

  for (const d of data.dirs) {
    html += '<button class="dir-item" data-nav="' + escAttr(d.path) + '">';
    html += '<span class="folder-icon">📁</span>';
    html += '<span class="item-name">' + escapeHtml(d.name) + '</span>';
    html += '</button>';
  }

  list.innerHTML = html;
}

// 事件委托：目录列表点击（单击选中，双击进入）
let dirListClickTimer = null;
document.getElementById('browserList').addEventListener('click', function(e) {
  const btn = e.target.closest('.dir-item');
  if (!btn) return;

  const dirPath = btn.getAttribute('data-nav');
  if (!dirPath) return;

  // 高亮选中
  document.querySelectorAll('.dir-item.selected').forEach(el => el.classList.remove('selected'));
  btn.classList.add('selected');
  browserSelectedDir = dirPath;
  document.getElementById('browserCurrentPath').textContent = dirPath;
  document.getElementById('browserJumpInput').value = dirPath;

  // 双击检测 → 进入目录
  if (dirListClickTimer) {
    clearTimeout(dirListClickTimer);
    dirListClickTimer = null;
    navigateTo(dirPath);
  } else {
    dirListClickTimer = setTimeout(function() { dirListClickTimer = null; }, 300);
  }
});

// 事件委托：面包屑点击
document.getElementById('browserBreadcrumb').addEventListener('click', function(e) {
  e.preventDefault();
  const a = e.target.closest('a');
  if (!a) return;
  const dirPath = a.getAttribute('data-nav');
  if (dirPath) navigateTo(dirPath);
});

function selectCurrentDir() {
  if (!browserTargetInput) return;
  const pathToUse = browserSelectedDir || browserCurrentPath;
  if (pathToUse) {
    document.getElementById(browserTargetInput).value = pathToUse;
  }
  closeBrowser();
}

function jumpToPath() {
  const p = document.getElementById('browserJumpInput').value.trim();
  if (p) navigateTo(p);
}

// 回车跳转（script 在 body 末尾，DOM 已就绪，直接绑定）
document.getElementById('browserJumpInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') jumpToPath();
});

function escAttr(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ════════════════════════════════════════════════════════════
// 类型切换
// ════════════════════════════════════════════════════════════
function switchType() {
  const type = getType();
  document.getElementById('skillFields').style.display    = type === 'skill'    ? '' : 'none';
  document.getElementById('bundleFields').style.display   = type === 'bundle'   ? '' : 'none';
  document.getElementById('openclawFields').style.display = type === 'openclaw' ? '' : 'none';
  document.getElementById('frontendFields').style.display = type === 'frontend' ? '' : 'none';
  document.getElementById('resultArea').style.display = 'none';
}

function switchEncrypt() {
  const checked = document.getElementById('fEncrypt').checked;
  document.getElementById('encryptKeyGroup').style.display = checked ? '' : 'none';
}

function getType() {
  return document.querySelector('input[name="pkgType"]:checked').value;
}

// ════════════════════════════════════════════════════════════
// 打包
// ════════════════════════════════════════════════════════════
async function doBuild() {
  const type = getType();
  const btn = document.getElementById('buildBtn');
  const resultArea = document.getElementById('resultArea');
  const resultContent = document.getElementById('resultContent');

  btn.disabled = true;
  btn.textContent = '⏳ 打包中...';
  resultArea.style.display = 'none';

  const body = { type };

  if (type === 'skill') {
    body.component = document.getElementById('fComponent').value.trim();
    body.version   = document.getElementById('fVersion').value.trim();
    body.sourceDir = document.getElementById('fSourceDir').value.trim();
    body.outputDir = document.getElementById('fOutputDir').value.trim();
  } else if (type === 'bundle') {
    body.version   = document.getElementById('fBundleVersion').value.trim();
    body.sourceDir = document.getElementById('fBundleSourceDir').value.trim();
    body.outputDir = document.getElementById('fBundleOutputDir').value.trim();
  } else if (type === 'openclaw') {
    body.version   = document.getElementById('fOpenClawVersion').value.trim();
    body.sourceDir = document.getElementById('fOpenClawSourceDir').value.trim();
    body.outputDir = document.getElementById('fOpenClawOutputDir').value.trim();
  } else if (type === 'frontend') {
    body.version   = document.getElementById('fFrontendVersion').value.trim();
    body.sourceDir = document.getElementById('fFrontendSourceDir').value.trim();
    body.outputDir = document.getElementById('fFrontendOutputDir').value.trim();
  }

  if (document.getElementById('fEncrypt').checked) {
    body.encryptionKey = document.getElementById('fEncryptKey').value.trim();
  }

  try {
    const resp = await fetch('/api/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    resultArea.style.display = '';

    if (data.ok) {
      const sizeKB = (data.sizeBytes / 1024).toFixed(1);
      resultContent.innerHTML = \`
        <div class="result result-success">
          <div class="result-title">✅ 打包成功</div>
          <dl class="result-info">
            <dt>输出路径</dt><dd>\${escapeHtml(data.outputPath)}</dd>
            <dt>包类型</dt><dd>\${escapeHtml(data.type)}</dd>
            <dt>版本号</dt><dd>\${escapeHtml(data.version)}</dd>
            <dt>文件数</dt><dd>\${data.fileCount} 个</dd>
            <dt>加密</dt><dd>\${data.encrypted ? '✅ AES-256-GCM' : '❌ 未加密'}</dd>
            <dt>大小</dt><dd>\${sizeKB} KB</dd>
          </dl>
        </div>
      \`;
    } else {
      resultContent.innerHTML = \`
        <div class="result result-error">
          <div class="result-title">❌ 打包失败</div>
          <p>\${escapeHtml(data.error)}</p>
        </div>
      \`;
    }
  } catch (err) {
    resultArea.style.display = '';
    resultContent.innerHTML = \`
      <div class="result result-error">
        <div class="result-title">❌ 请求失败</div>
        <p>无法连接到打包服务: \${escapeHtml(err.message)}</p>
        <p style="margin-top:6px;font-size:12px;color:#999;">请确认服务已启动</p>
      </div>
    \`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 打包并签名';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 页面初始化
switchType();
</script>
</body>
</html>`;
