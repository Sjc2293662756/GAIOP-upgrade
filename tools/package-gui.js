#!/usr/bin/env node
/**
 * NAPM 升级包打包工具 — 可视化界面。
 *
 * 启动本地 Web 服务 → 浏览器打开表单 → 填参打包。
 *
 * 用法:
 *   node tools/package-gui.js
 *   NAPM_PACKAGE_GUI_PORT=18902 node tools/package-gui.js
 *   node tools/package-gui.js --no-open
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const { packageSkill, packageBundle, packageOpenClaw, packageFrontend } = require('./package');

// ── 配置 ──────────────────────────────────────────────────
const PORT = parseInt(process.env.NAPM_PACKAGE_GUI_PORT || '18901', 10);
const AUTO_OPEN = !process.argv.includes('--no-open');

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── 路由 ──────────────────────────────────────────────────

/** 返回打包管理页面 */
app.get('/', (_req, res) => {
  res.type('html').send(PAGE_HTML);
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

  // 临时设置加密密钥（仅在本次请求中生效）
  if (encryptionKey) {
    process.env.NAPM_PACKAGE_ENCRYPTION_KEY = encryptionKey;
  } else {
    delete process.env.NAPM_PACKAGE_ENCRYPTION_KEY;
  }

  // 输出目录
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

// ── 启动 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n🧰 NAPM 升级包打包工具\n`);
  console.log(`   本地访问: ${url}`);
  console.log(`   按 Ctrl+C 停止\n`);

  if (AUTO_OPEN) {
    // 尝试用系统默认浏览器打开
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

// ════════════════════════════════════════════════════════════
// 内嵌 HTML 页面
// ════════════════════════════════════════════════════════════

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NAPM 升级包打包工具</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f0f2f5;
    color: #1a1a2e;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 40px 16px;
  }
  .container { max-width: 640px; width: 100%; }

  /* ── 头部 ── */
  .header {
    text-align: center; margin-bottom: 32px;
  }
  .header h1 {
    font-size: 24px; font-weight: 700; color: #16213e;
    display: flex; align-items: center; justify-content: center; gap: 10px;
  }
  .header p { color: #666; margin-top: 6px; font-size: 14px; }
  .badge {
    display: inline-block; font-size: 12px; padding: 3px 8px; border-radius: 4px;
    font-weight: 600;
  }
  .badge-sign   { background: #e8f5e9; color: #2e7d32; }
  .badge-crypto { background: #e3f2fd; color: #1565c0; }

  /* ── 卡片 ── */
  .card {
    background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.06);
    padding: 28px; margin-bottom: 20px;
  }
  .card-title {
    font-size: 16px; font-weight: 600; color: #16213e; margin-bottom: 20px;
    display: flex; align-items: center; gap: 8px;
  }
  .card-title::before { content: ''; display: inline-block; width: 4px; height: 18px; background: #0f3460; border-radius: 2px; }

  /* ── 类型选择 ── */
  .type-selector { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .type-option { position: relative; }
  .type-option input { position: absolute; opacity: 0; }
  .type-option label {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 14px 8px; border: 2px solid #e0e0e0; border-radius: 10px;
    cursor: pointer; transition: all 0.2s; text-align: center; font-size: 13px;
    font-weight: 500; color: #555;
  }
  .type-option label .icon { font-size: 22px; }
  .type-option input:checked + label {
    border-color: #0f3460; background: #f0f4ff; color: #0f3460; font-weight: 600;
  }
  .type-option label:hover { border-color: #0f3460; }

  /* ── 表单 ── */
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 5px; }
  .form-group input {
    width: 100%; padding: 10px 12px; border: 1.5px solid #d0d0d0; border-radius: 8px;
    font-size: 14px; transition: border-color 0.2s; outline: none;
  }
  .form-group input:focus { border-color: #0f3460; box-shadow: 0 0 0 3px rgba(15,52,96,0.08); }
  .form-hint { font-size: 12px; color: #999; margin-top: 3px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  #bundleFields, #openclawFields, #frontendFields { display: none; }

  /* ── 加密区域 ── */
  .encrypt-toggle {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px; cursor: pointer;
    font-size: 14px; font-weight: 500;
  }
  .encrypt-toggle input[type=checkbox] { width: 18px; height: 18px; accent-color: #0f3460; }
  #encryptKeyGroup { display: none; }

  /* ── 按钮 ── */
  .btn-row { display: flex; gap: 12px; }
  .btn {
    flex: 1; padding: 12px 20px; border: none; border-radius: 8px; font-size: 15px;
    font-weight: 600; cursor: pointer; transition: all 0.2s;
  }
  .btn-primary { background: #0f3460; color: #fff; }
  .btn-primary:hover { background: #16213e; }
  .btn-primary:disabled { background: #b0b0b0; cursor: not-allowed; }

  /* ── 结果 ── */
  #resultArea { display: none; }
  .result { border-radius: 8px; padding: 18px; font-size: 14px; }
  .result-success { background: #e8f5e9; border: 1px solid #a5d6a7; color: #2e7d32; }
  .result-error   { background: #fbe9e7; border: 1px solid #ef9a9a; color: #c62828; }
  .result-title { font-weight: 700; font-size: 15px; margin-bottom: 8px; }
  .result-info { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; }
  .result-info dt { color: #666; font-weight: 500; }
  .result-info dd { font-family: monospace; font-size: 13px; word-break: break-all; }

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
    <h1>🧰 NAPM 升级包打包工具</h1>
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
        <label for="tSkill"><span class="icon">📦</span> Skill</label>
      </div>
      <div class="type-option">
        <input type="radio" name="pkgType" value="bundle" id="tBundle" onchange="switchType()">
        <label for="tBundle"><span class="icon">📚</span> Bundle</label>
      </div>
      <div class="type-option">
        <input type="radio" name="pkgType" value="openclaw" id="tOpenClaw" onchange="switchType()">
        <label for="tOpenClaw"><span class="icon">⚙️</span> OpenClaw</label>
      </div>
      <div class="type-option">
        <input type="radio" name="pkgType" value="frontend" id="tFrontend" onchange="switchType()">
        <label for="tFrontend"><span class="icon">🌐</span> Frontend</label>
      </div>
    </div>
  </div>

  <!-- ── 参数表单 ── -->
  <div class="card">
    <div class="card-title">打包参数</div>

    <!-- Skill 字段 -->
    <div id="skillFields">
      <div class="form-group">
        <label for="fComponent">组件名</label>
        <input type="text" id="fComponent" placeholder="如: napm-diag">
        <div class="form-hint">Skill 的目录名，必须与服务器上注册的名称一致</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="fVersion">版本号</label>
          <input type="text" id="fVersion" placeholder="如: 2.1.0（SemVer 格式）">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="fSourceDir">源目录</label>
          <input type="text" id="fSourceDir" placeholder="如: ./skills/napm-diag">
          <div class="form-hint">Skill 代码所在目录（包含 SKILL.md）</div>
        </div>
        <div class="form-group">
          <label for="fOutputDir">输出目录</label>
          <input type="text" id="fOutputDir" placeholder="默认: ./out">
        </div>
      </div>
    </div>

    <!-- Bundle 字段 -->
    <div id="bundleFields">
      <div class="form-group">
        <label for="fBundleVersion">版本号</label>
        <input type="text" id="fBundleVersion" placeholder="如: 3.0.0（SemVer 格式）">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="fBundleSourceDir">Skills 根目录</label>
          <input type="text" id="fBundleSourceDir" placeholder="如: ./skills（包含多个 Skill 子目录）">
          <div class="form-hint">目录下每个子目录视为一个 Skill</div>
        </div>
        <div class="form-group">
          <label for="fBundleOutputDir">输出目录</label>
          <input type="text" id="fBundleOutputDir" placeholder="默认: ./out">
        </div>
      </div>
    </div>

    <!-- OpenClaw 字段 -->
    <div id="openclawFields">
      <div class="form-group">
        <label for="fOpenClawVersion">版本号</label>
        <input type="text" id="fOpenClawVersion" placeholder="如: 2026.6.0">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="fOpenClawSourceDir">源目录</label>
          <input type="text" id="fOpenClawSourceDir" placeholder="如: ./openclaw-dist">
        </div>
        <div class="form-group">
          <label for="fOpenClawOutputDir">输出目录</label>
          <input type="text" id="fOpenClawOutputDir" placeholder="默认: ./out">
        </div>
      </div>
    </div>

    <!-- Frontend 字段 -->
    <div id="frontendFields">
      <div class="form-group">
        <label for="fFrontendVersion">版本号</label>
        <input type="text" id="fFrontendVersion" placeholder="如: 2.2.0（SemVer 格式）">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label for="fFrontendSourceDir">dist 目录</label>
          <input type="text" id="fFrontendSourceDir" placeholder="如: ./dist（Vite 构建产物）">
          <div class="form-hint">Vite/Webpack build 输出的 dist/ 目录</div>
        </div>
        <div class="form-group">
          <label for="fFrontendOutputDir">输出目录</label>
          <input type="text" id="fFrontendOutputDir" placeholder="默认: ./out">
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

<script>
// ── 类型切换 ───────────────────────────────────────────────
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

// ── 打包 ───────────────────────────────────────────────────
async function doBuild() {
  const type = getType();
  const btn = document.getElementById('buildBtn');
  const resultArea = document.getElementById('resultArea');
  const resultContent = document.getElementById('resultContent');

  btn.disabled = true;
  btn.textContent = '⏳ 打包中...';
  resultArea.style.display = 'none';

  // 收集参数
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

  // 加密密钥
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
        <p style="margin-top:6px;font-size:12px;color:#999;">请确认服务已启动: node tools/package-gui.js</p>
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
</script>
</body>
</html>`;
