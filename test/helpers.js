/**
 * 测试辅助工具 —— 构建合法签名的升级包。
 *
 * 用于测试 UpgradeValidator 的各种场景：
 * - 正常包（签名 + 哈希正确）
 * - 签名错误的包
 * - 哈希不匹配的包
 * - manifest 缺少字段的包
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

let _testKeyPair = null;
function getTestKeyPair() {
  if (!_testKeyPair) {
    _testKeyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  return _testKeyPair;
}

function getPrivateKey() {
  return getTestKeyPair().privateKey;
}

function getTestPublicKey() {
  return getTestKeyPair().publicKey;
}

/**
 * 构建一个合法的、已签名的升级包 ZIP Buffer。
 *
 * @param {object} manifestBase   manifest JSON 的基础部分（不含 signature 和 files_checksum）
 * @param {object} files          要打入包的文件 { 'relative/path.js': 'file content string' }
 * @returns {Buffer} ZIP 文件 Buffer
 */
function buildSignedPackage(manifestBase, files = {}) {
  // 1. 计算每个文件的 SHA256
  const entries = {};
  const sortedPaths = Object.keys(files).sort();

  for (const filePath of sortedPaths) {
    const hash = crypto.createHash('sha256').update(files[filePath]).digest('hex');
    entries[filePath] = hash;
  }

  // 2. 构建规范摘要并签名
  const digest = sortedPaths
    .map((p) => `${p}:${entries[p]}`)
    .join('\n');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(digest);
  sign.end();
  const signatureValue = sign.sign(getPrivateKey(), 'base64');

  // 3. 组装完整 manifest
  const manifest = {
    ...manifestBase,
    signature: {
      algorithm: 'RSA-SHA256',
      value: signatureValue,
      signed_by: 'Test Builder',
      signed_at: new Date().toISOString(),
    },
    files_checksum: {
      algorithm: 'sha256',
      entries,
    },
  };

  // 4. 创建 ZIP
  const zip = new AdmZip();

  // 先加 manifest
  zip.addFile('upgrade-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  // 再加其他文件
  for (const [filePath, content] of Object.entries(files)) {
    zip.addFile(filePath, Buffer.from(content, 'utf8'));
  }

  return zip.toBuffer();
}

/**
 * 创建一个合法的 skill-single 测试包。
 */
function buildSkillPackage(overrides = {}) {
  const manifest = {
    type: 'skill-single',
    component: 'napm-diag',
    version: '2.1.0',
    display_name: 'NAPM 网络诊断 Skill',
    description: '测试用 Skill 包',
    changelog: 'v2.1.0:\n- 测试变更',
    compatibility: {
      min_openclaw_version: '2026.5.0',
      min_frontend_version: '2.0.0',
      napm_api_version: 'v2',
    },
    dependencies: {
      skills: {
        'napm-alert': '>=1.2.0, <2.0.0',
      },
    },
    ...overrides,
  };

  const files = {
    'skills/napm-diag/SKILL.md': '# NAPM Diag Skill\n\n网络诊断能力。\n',
    'skills/napm-diag/scripts/run_diag.js': 'module.exports = function runDiag() { return "ok"; };\n',
    'skills/napm-diag/services/DiagService.js': 'class DiagService { diagnose() { return {}; } }\nmodule.exports = DiagService;\n',
  };

  return buildSignedPackage(manifest, files);
}

/**
 * 创建一个签名被篡改的包（修改 signature.value，但文件不变）。
 */
function buildTamperedPackage(overrides = {}) {
  const good = buildSkillPackage(overrides);

  const zip = new AdmZip(good);
  const manifestEntry = zip.getEntry('upgrade-manifest.json');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  // 篡改签名值 —— 文件没变，所以 files_checksum 仍正确，但签名不匹配
  manifest.signature.value = Buffer.from('tampered-signature-value').toString('base64');
  zip.updateFile(manifestEntry, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  return zip.toBuffer();
}

/**
 * 创建一个文件哈希不匹配的包（修改文件内容但不更新 manifest）。
 */
function buildChecksumMismatchPackage(overrides = {}) {
  const good = buildSkillPackage(overrides);

  const zip = new AdmZip(good);
  // 修改一个 skill 文件的内容，但不更新 manifest.files_checksum
  const skillEntry = zip.getEntry('skills/napm-diag/SKILL.md');
  zip.updateFile(skillEntry, Buffer.from('# Tampered content\n', 'utf8'));

  return zip.toBuffer();
}

/**
 * 创建一个不带 manifest 的 ZIP。
 */
function buildNoManifestPackage() {
  const zip = new AdmZip();
  zip.addFile('skills/napm-diag/SKILL.md', Buffer.from('# Just a skill\n', 'utf8'));
  return zip.toBuffer();
}

/**
 * 创建一个 openclaw 类型的测试包。
 */
function buildOpenClawPackage(overrides = {}) {
  const manifest = {
    type: 'openclaw',
    component: 'openclaw',
    version: '2026.6.0',
    display_name: 'OpenClaw Gateway',
    description: 'OpenClaw 平台升级包',
    changelog: 'v2026.6.0:\n- 性能优化',
    compatibility: {
      min_frontend_version: '2.0.0',
      napm_api_version: 'v2',
    },
    ...overrides,
  };

  const files = {
    'dist/index.js': '// OpenClaw core\nmodule.exports = {};\n',
    'package.json': JSON.stringify({ name: 'openclaw', version: '2026.6.0' }, null, 2),
  };

  return buildSignedPackage(manifest, files);
}

/**
 * 创建一个合法的 skill-bundle 测试包（包含多个 Skill）。
 */
function buildBundlePackage(overrides = {}) {
  const manifest = {
    type: 'skill-bundle',
    component: 'skills',
    version: '3.0.0',
    display_name: 'NAPM Skills Bundle',
    description: '批量 Skill 升级包',
    changelog: 'v3.0.0:\n- 全部 Skill 升级',
    compatibility: {
      min_openclaw_version: '2026.5.0',
      napm_api_version: 'v2',
    },
    ...overrides,
  };

  const files = {
    'skills/napm-diag/SKILL.md': '# NAPM Diag v3.0.0\nBundle upgrade.\n',
    'skills/napm-diag/scripts/run.js': '// v3.0.0\nmodule.exports = () => "ok";\n',
    'skills/napm-alert/SKILL.md': '# NAPM Alert v3.0.0\nBundle upgrade.\n',
    'skills/napm-alert/scripts/query.js': '// v3.0.0\nmodule.exports = () => [];\n',
    'skills/napm-report/SKILL.md': '# NAPM Report v3.0.0\nBundle upgrade.\n',
    'skills/napm-report/scripts/generate.js': '// v3.0.0\nmodule.exports = () => ({});\n',
  };

  return buildSignedPackage(manifest, files);
}

/**
 * 创建一个合法的 frontend 测试包。
 */
function buildFrontendPackage(overrides = {}) {
  const manifest = {
    type: 'frontend',
    component: 'frontend',
    version: '2.2.0',
    display_name: 'NAPM Admin Frontend',
    changelog: 'v2.2.0:\n- UI 改进',
    compatibility: {
      min_openclaw_version: '2026.5.0',
    },
    ...overrides,
  };

  const files = {
    'dist/index.html': '<!DOCTYPE html>\n<html><head><title>NAPM Admin</title></head><body><div id="app"></div></body></html>\n',
    'dist/assets/index.js': '// app bundle\nconsole.log("v2.2.0");\n',
    'dist/assets/style.css': 'body { margin: 0; }\n',
    'dist/favicon.ico': 'FAKE_ICO',
  };

  return buildSignedPackage(manifest, files);
}

/**
 * 创建一个合法的 full-stack 测试包。
 */
function buildFullStackPackage(overrides = {}) {
  const manifest = {
    type: 'full-stack',
    version: '4.0.0',
    display_name: 'NAPM Full Stack',
    changelog: 'v4.0.0:\n- 全栈升级',
    compatibility: {
      min_openclaw_version: '2026.5.0',
      min_frontend_version: '2.0.0',
      napm_api_version: 'v2',
    },
    ...overrides,
  };

  const files = {
    // ── OpenClaw 子包 ──
    'openclaw/upgrade-manifest.json': JSON.stringify({
      type: 'openclaw', component: 'openclaw', version: '2026.6.0',
      compatibility: { napm_api_version: 'v2' },
    }),
    'openclaw/dist/index.js': '// openclaw v2026.6.0\n',
    'openclaw/package.json': JSON.stringify({ name: 'openclaw', version: '2026.6.0' }),

    // ── Skills 子包 ──
    'skills/upgrade-manifest.json': JSON.stringify({
      type: 'skill-bundle', component: 'skills', version: '4.0.0',
      compatibility: { min_openclaw_version: '2026.5.0', napm_api_version: 'v2' },
    }),
    'skills/skills/napm-diag/SKILL.md': '# NAPM Diag v4.0.0\n',
    'skills/skills/napm-diag/scripts/run.js': '// v4.0.0\n',
    'skills/skills/napm-alert/SKILL.md': '# NAPM Alert v4.0.0\n',
    'skills/skills/napm-alert/scripts/query.js': '// v4.0.0\n',

    // ── Frontend 子包 ──
    'frontend/upgrade-manifest.json': JSON.stringify({
      type: 'frontend', component: 'frontend', version: '4.0.0',
    }),
    'frontend/dist/index.html': '<!DOCTYPE html>\n<html><head><title>NAPM v4</title></head><body><div id="app"></div></body></html>\n',
    'frontend/dist/assets/app.js': '// v4.0.0\n',
  };

  return buildSignedPackage(manifest, files);
}

/**
 * 测试加密密钥文件路径。
 * 密钥值可在没有配置 NAPM_PACKAGE_ENCRYPTION_KEY 时由测试读取。
 */
const TEST_ENCRYPTION_KEY_PATH = path.join(__dirname, 'test-encryption.key');

/**
 * 将 ZIP Buffer 加密为带 NAPE 魔数的 AES-256-GCM 密文。
 *
 * 格式与 tools/package.js 的加密输出完全一致:
 *   MAGIC(4B "NAPE") + IV(12B) + CIPHERTEXT + AUTH_TAG(16B)
 *
 * @param {Buffer} zipBuffer  明文的 ZIP 内容
 * @param {string} [encryptionKey]  hex 格式的 256-bit 密钥；默认从 test-encryption.key 读取
 * @returns {Buffer} 加密后的包 Buffer
 */
function encryptPackage(zipBuffer, encryptionKey) {
  let keyHex = encryptionKey;
  if (!keyHex) {
    keyHex = fs.readFileSync(TEST_ENCRYPTION_KEY_PATH, 'utf8').trim();
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`加密密钥必须是 32 字节，当前 ${key.length} 字节`);
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(zipBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from('NAPE', 'utf8'),
    iv,
    encrypted,
    authTag,
  ]);
}

module.exports = {
  buildSignedPackage,
  buildSkillPackage,
  buildBundlePackage,
  buildFrontendPackage,
  buildFullStackPackage,
  buildTamperedPackage,
  buildChecksumMismatchPackage,
  buildNoManifestPackage,
  buildOpenClawPackage,
  encryptPackage,
  TEST_ENCRYPTION_KEY_PATH,
  getTestPublicKey,
};
