#!/usr/bin/env node
/**
 * NAPM 升级包签名打包工具。
 *
 * 用法:
 *   node tools/package.js skill <name> <version> <source-dir> [output-dir]
 *   node tools/package.js bundle <version> <skills-dir> [output-dir]
 *   node tools/package.js openclaw <version> <source-dir> [output-dir]
 *   node tools/package.js frontend <version> <dist-dir> [output-dir]
 *
 * 输出: <name>-<version>.zip（已签名）
 *
 * 依赖: config/private.pem（RSA 私钥）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

// ── 私钥加载 ──────────────────────────────────────────────
const PRIVATE_KEY_PATH = path.join(__dirname, '..', 'config', 'private.pem');
function loadPrivateKey() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(`私钥文件不存在: ${PRIVATE_KEY_PATH}`);
  }
  return fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
}

// ════════════════════════════════════════════════════════════
// CLI 入口（仅在直接运行时执行）
// ════════════════════════════════════════════════════════════
if (require.main === module) {
  const [,, type, arg1, arg2, arg3, arg4] = process.argv;

  if (!type || type === '--help' || type === '-h') {
    console.log(`
NAPM 升级包打包工具

用法:
  node tools/package.js skill <component-name> <version> <source-dir> [output-dir]
  node tools/package.js bundle <version> <skills-dir> [output-dir]
  node tools/package.js openclaw <version> <source-dir> [output-dir]
  node tools/package.js frontend <version> <dist-dir> [output-dir]

示例:
  node tools/package.js skill napm-diag 2.1.0 ./skills/napm-diag ./out
  node tools/package.js bundle 3.0.0 ./skills ./out
`);
    process.exit(0);
  }

  let result;
  switch (type) {
    case 'skill': {
      const [component, version, sourceDir, outputDir = './out'] = [arg1, arg2, arg3, arg4];
      if (!component || !version || !sourceDir) {
        console.error('用法: node tools/package.js skill <component-name> <version> <source-dir> [output-dir]');
        process.exit(1);
      }
      result = packageSkill(component, version, sourceDir, outputDir);
      break;
    }
    case 'bundle': {
      const [version, skillsDir, outputDir = './out'] = [arg1, arg2, arg3];
      if (!version || !skillsDir) {
        console.error('用法: node tools/package.js bundle <version> <skills-dir> [output-dir]');
        process.exit(1);
      }
      result = packageBundle(version, skillsDir, outputDir);
      break;
    }
    case 'openclaw': {
      const [version, sourceDir, outputDir = './out'] = [arg1, arg2, arg3];
      if (!version || !sourceDir) {
        console.error('用法: node tools/package.js openclaw <version> <source-dir> [output-dir]');
        process.exit(1);
      }
      result = packageOpenClaw(version, sourceDir, outputDir);
      break;
    }
    case 'frontend': {
      const [version, distDir, outputDir = './out'] = [arg1, arg2, arg3];
      if (!version || !distDir) {
        console.error('用法: node tools/package.js frontend <version> <dist-dir> [output-dir]');
        process.exit(1);
      }
      result = packageFrontend(version, distDir, outputDir);
      break;
    }
    default:
      console.error(`未知包类型: ${type}。有效值: skill, bundle, openclaw, frontend`);
      process.exit(1);
  }

  console.log(`✅ 已生成: ${result.outputPath}`);
  console.log(`   类型: ${result.type} | 版本: ${result.version}`);
  console.log(`   文件: ${result.fileCount} 个 | 签名: RSA-SHA256${result.encrypted ? ' | 加密: AES-256-GCM' : ' | 未加密'}`);
}

// ── 打包逻辑 ──────────────────────────────────────────────

function packageSkill(component, version, sourceDir, outputDir) {
  const manifest = {
    type: 'skill-single',
    component,
    version,
    display_name: `${component} Skill`,
    changelog: `v${version}`,
    compatibility: {
      min_openclaw_version: '2026.5.0',
      napm_api_version: 'v2',
    },
  };

  const files = {};
  collectFiles(sourceDir, `skills/${component}`, files);
  return buildAndSign(manifest, files, outputDir, `${component}-${version}.zip`);
}

function packageBundle(version, skillsDir, outputDir) {
  const manifest = {
    type: 'skill-bundle',
    component: 'skills',
    version,
    display_name: 'NAPM Skills Bundle',
    changelog: `v${version}`,
    compatibility: {
      min_openclaw_version: '2026.5.0',
      napm_api_version: 'v2',
    },
  };

  const files = {};
  collectFiles(skillsDir, 'skills', files);
  return buildAndSign(manifest, files, outputDir, `napm-skills-${version}.zip`);
}

function packageOpenClaw(version, sourceDir, outputDir) {
  const manifest = {
    type: 'openclaw',
    component: 'openclaw',
    version,
    display_name: 'OpenClaw Gateway',
    changelog: `v${version}`,
    compatibility: {
      min_frontend_version: '2.0.0',
      napm_api_version: 'v2',
    },
  };

  const files = {};
  collectFiles(sourceDir, '', files);
  return buildAndSign(manifest, files, outputDir, `openclaw-${version}.zip`);
}

function packageFrontend(version, distDir, outputDir) {
  const manifest = {
    type: 'frontend',
    component: 'frontend',
    version,
    display_name: 'NAPM Admin Frontend',
    changelog: `v${version}`,
    compatibility: {
      min_openclaw_version: '2026.5.0',
    },
  };

  const files = {};
  collectFiles(distDir, 'dist', files);
  return buildAndSign(manifest, files, outputDir, `napm-frontend-${version}.zip`);
}

// ── 通用：构建 + 签名 ─────────────────────────────────────

function buildAndSign(manifest, files, outputDir, fileName) {
  const privateKey = loadPrivateKey();

  // 1. 计算 SHA256
  const entries = {};
  const sortedPaths = Object.keys(files).sort();
  for (const fp of sortedPaths) {
    entries[fp] = crypto.createHash('sha256').update(files[fp]).digest('hex');
  }

  // 2. 构建规范摘要并签名
  const digest = sortedPaths.map((p) => `${p}:${entries[p]}`).join('\n');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(digest);
  sign.end();
  const sigValue = sign.sign(privateKey, 'base64');

  manifest.signature = {
    algorithm: 'RSA-SHA256',
    value: sigValue,
    signed_by: 'NAPM CI',
    signed_at: new Date().toISOString(),
  };
  manifest.files_checksum = { algorithm: 'sha256', entries };

  // 3. 打包为 ZIP
  fs.mkdirSync(outputDir, { recursive: true });
  const zip = new AdmZip();
  zip.addFile('upgrade-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  for (const [fp, content] of Object.entries(files)) {
    zip.addFile(fp, Buffer.from(content, 'utf8'));
  }

  const outputPath = path.join(outputDir, fileName);
  const zipBuffer = zip.toBuffer();

  // 4. 加密（可选）
  const encryptionKey = process.env.NAPM_PACKAGE_ENCRYPTION_KEY;
  let finalBuffer = zipBuffer;
  let encrypted = false;

  if (encryptionKey) {
    const key = Buffer.from(encryptionKey, 'hex');
    if (key.length !== 32) {
      throw new Error(`NAPM_PACKAGE_ENCRYPTION_KEY 必须是 64 位 hex（32 字节），当前 ${key.length} 字节`);
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encryptedData = Buffer.concat([cipher.update(zipBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    finalBuffer = Buffer.concat([
      Buffer.from('NAPE', 'utf8'),
      iv,
      encryptedData,
      authTag,
    ]);
    encrypted = true;
  }

  fs.writeFileSync(outputPath, finalBuffer);

  return {
    outputPath,
    type: manifest.type,
    version: manifest.version,
    fileCount: Object.keys(files).length,
    signed: true,
    encrypted,
    sizeBytes: finalBuffer.length,
    manifest,
  };
}

function collectFiles(dir, prefix, files) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(fullPath, relPath, files);
    } else {
      files[relPath] = fs.readFileSync(fullPath, 'utf8');
    }
  }
}

module.exports = {
  packageSkill,
  packageBundle,
  packageOpenClaw,
  packageFrontend,
  buildAndSign,
  collectFiles,
};
