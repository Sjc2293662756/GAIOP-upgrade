/**
 * UpgradeValidator 单元测试。
 *
 * 覆盖：
 * - 正常包校验通过
 * - manifest 缺失 / 格式错误
 * - RSA 签名验证（签名不匹配 / 被篡改）
 * - SHA256 文件校验不匹配
 * - 版本方向检查
 * - 兼容性检查（OpenClaw、前端、NAPM API、Skill 依赖）
 * - 影响范围评估
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { UpgradeValidator } = require('../src/services/UpgradeValidator');
const {
  buildSkillPackage,
  buildTamperedPackage,
  buildChecksumMismatchPackage,
  buildNoManifestPackage,
  buildOpenClawPackage,
  buildSignedPackage,
  encryptPackage,
  TEST_ENCRYPTION_KEY_PATH,
  getTestPublicKey,
} = require('./helpers');

// ── 测试 Fixture ───────────────────────────────────────────
const PUBLIC_KEY = getTestPublicKey();
let db;
let validator;

before(() => {
  // 使用内存数据库
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 建表（与 src/database/schema.js 一致）
  db.exec(`
    CREATE TABLE IF NOT EXISTS components (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    UNIQUE NOT NULL,
        type        TEXT    NOT NULL CHECK(type IN ('openclaw', 'frontend', 'skill')),
        version     TEXT    NOT NULL,
        status      TEXT    DEFAULT 'active' CHECK(status IN ('active', 'upgrading', 'degraded')),
        install_path TEXT   NOT NULL,
        updated_at  TEXT    DEFAULT (datetime('now'))
    );
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
  `);

  // 插入模拟环境数据：OpenClaw 2026.5.4, 前端 2.1.0, 多个 Skills
  const insert = db.prepare(
    'INSERT INTO components (name, type, version, install_path) VALUES (?, ?, ?, ?)'
  );
  insert.run('openclaw', 'openclaw', '2026.5.4', '/opt/openclaw');
  insert.run('frontend', 'frontend', '2.1.0', '/var/www/napm-admin');
  insert.run('napm-diag', 'skill', '2.0.1', '/opt/skills/napm-diag');
  insert.run('napm-alert', 'skill', '1.2.0', '/opt/skills/napm-alert');
  insert.run('napm-report', 'skill', '1.0.0', '/opt/skills/napm-report');

  validator = new UpgradeValidator({ publicKey: PUBLIC_KEY, db });
});

after(() => {
  if (db) db.close();
});

// ══════════════════════════════════════════════════════════════
// 正常包校验
// ══════════════════════════════════════════════════════════════

describe('正常包校验', () => {
  it('合法的 skill-single 包应通过所有校验', () => {
    const zip = buildSkillPackage();
    const result = validator.validate(zip);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.type, 'skill-single');
    assert.strictEqual(result.component, 'napm-diag');
    assert.strictEqual(result.current_version, '2.0.1');
    assert.strictEqual(result.new_version, '2.1.0');
    assert.strictEqual(result.display_name, 'NAPM 网络诊断 Skill');
    // 影响范围
    assert.strictEqual(result.impact.requires_restart, false);
    assert.strictEqual(result.impact.requires_maintenance, false);
    assert.strictEqual(result.impact.estimated_downtime_seconds, 0);
    assert.deepStrictEqual(result.impact.affected_components, ['napm-diag']);
    // 兼容性检查
    assert.strictEqual(result.compatibility_check.openclaw.ok, true);
    assert.strictEqual(result.compatibility_check.frontend.ok, true);
    assert.strictEqual(result.compatibility_check.napm_api.ok, true);
    assert.strictEqual(result.compatibility_check.dependencies['napm-alert'].ok, true);
  });

  it('合法的 openclaw 包应通过校验', () => {
    const zip = buildOpenClawPackage();
    const result = validator.validate(zip);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.type, 'openclaw');
    // 影响范围
    assert.strictEqual(result.impact.requires_restart, true);
    assert.strictEqual(result.impact.requires_maintenance, true);
    assert.strictEqual(result.impact.estimated_downtime_seconds, 30);
    assert.deepStrictEqual(result.impact.affected_components, ['openclaw']);
  });
});

// ══════════════════════════════════════════════════════════════
// Manifest 校验
// ══════════════════════════════════════════════════════════════

describe('Manifest 校验', () => {
  it('缺少 upgrade-manifest.json 应失败', () => {
    const zip = buildNoManifestPackage();
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'manifest'));
  });

  it('manifest 缺少必填字段 type 应失败', () => {
    // 直接构造一个缺少 type 的包
    const zip = buildSkillPackage();
    // 解压、删掉 type 字段、重新打包（签名会坏，但 manifest 字段检查在签名之前）
    const AdmZip = require('adm-zip');
    const zipObj = new AdmZip(zip);
    const manifestEntry = zipObj.getEntry('upgrade-manifest.json');
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    delete manifest.type;
    zipObj.updateFile(manifestEntry, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const badZip = zipObj.toBuffer();

    const result = validator.validate(badZip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'type'));
  });

  it('type 值无效应失败', () => {
    const zip = buildSkillPackage({ type: 'invalid-type' });
    // 因为 type 变了，但包里文件路径还是 skill-single 格式
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'type'));
  });

  it('version 格式无效应失败', () => {
    const zip = buildSkillPackage({ version: 'not-a-version' });
    // coerce 失败
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'version'));
  });
});

// ══════════════════════════════════════════════════════════════
// 签名验证
// ══════════════════════════════════════════════════════════════

describe('RSA 签名验证', () => {
  it('签名被篡改应失败', () => {
    const zip = buildTamperedPackage();
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'signature'));
  });

  it('使用错误公钥应验签失败', () => {
    // 生成一个不匹配的密钥对
    const crypto = require('crypto');
    const wrongKey = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const wrongValidator = new UpgradeValidator({
      publicKey: wrongKey.publicKey,
      db,
    });

    const zip = buildSkillPackage();
    const result = wrongValidator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'signature'));
  });
});

// ══════════════════════════════════════════════════════════════
// SHA256 文件校验
// ══════════════════════════════════════════════════════════════

describe('SHA256 文件校验', () => {
  it('文件内容被篡改（哈希不匹配）应失败', () => {
    const zip = buildChecksumMismatchPackage();
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'files_checksum'));
  });

  it('包含路径片段的 component 应失败', () => {
    const zip = buildSkillPackage({ component: '../../escape', version: '3.0.0' });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'component'));
  });

  it('已签名但包含类型外文件的包应失败', () => {
    const zip = buildSignedPackage({
      type: 'frontend',
      component: 'frontend',
      version: '2.2.0',
      compatibility: {},
    }, {
      'dist/index.html': '<!doctype html><title>ok</title>',
      'server/replace.js': 'module.exports = true',
    });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'archive_layout'));
  });

  it('路径穿越文件名应在执行前被拒绝', () => {
    const fakeZip = {
      getEntries: () => [{ entryName: 'dist/../../escape.txt', isDirectory: false }],
    };
    const errors = [];
    validator._validateArchiveLayout(fakeZip, {
      type: 'frontend',
      files_checksum: { entries: { 'dist/../../escape.txt': '0'.repeat(64) } },
    }, errors);
    assert.ok(errors.some((e) => e.field === 'archive_path'));
  });
});

// ══════════════════════════════════════════════════════════════
// 版本方向检查
// ══════════════════════════════════════════════════════════════

describe('版本方向检查', () => {
  it('新版本低于当前版本应失败', () => {
    // 当前 napm-diag = 2.0.1，上传 1.0.0
    const zip = buildSkillPackage({ version: '1.0.0' });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'version'));
  });

  it('新版本等于当前版本应失败', () => {
    // 当前 napm-diag = 2.0.1，上传 2.0.1
    const zip = buildSkillPackage({ version: '2.0.1' });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'version'));
  });

  it('未知组件（首次安装）应跳过版本方向检查', () => {
    const zip = buildSkillPackage({ component: 'napm-new-skill', version: '1.0.0' });
    const result = validator.validate(zip);
    // 签名和哈希应该通过，没有当前版本记录
    // 但兼容性检查仍然会运行（依赖 Skill 的约束要满足）
    assert.strictEqual(result.current_version, null);
    // 合法性取决于签名和兼容性是否通过
  });
});

// ══════════════════════════════════════════════════════════════
// 兼容性检查
// ══════════════════════════════════════════════════════════════

describe('兼容性检查', () => {
  it('OpenClaw 版本不满足最低要求应失败', () => {
    // 要求 >=2027.0.0，当前 2026.5.4
    const zip = buildSkillPackage({
      compatibility: {
        min_openclaw_version: '2027.0.0',
        napm_api_version: 'v2',
      },
    });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'compatibility.openclaw'));
    assert.strictEqual(result.compatibility_check.openclaw.ok, false);
  });

  it('前端版本不满足最低要求应失败', () => {
    // 要求 >=3.0.0，当前 2.1.0
    const zip = buildSkillPackage({
      compatibility: {
        min_frontend_version: '3.0.0',
        napm_api_version: 'v2',
      },
    });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'compatibility.frontend'));
  });

  it('NAPM API 版本不匹配应失败', () => {
    const zip = buildSkillPackage({
      compatibility: {
        napm_api_version: 'v3',
      },
    });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'compatibility.napm_api'));
  });

  it('Skill 依赖版本不满足约束应失败', () => {
    // napm-alert 要求 >=2.0.0，当前 1.2.0
    const zip = buildSkillPackage({
      compatibility: {
        min_openclaw_version: '2026.5.0',
        napm_api_version: 'v2',
      },
      dependencies: {
        skills: {
          'napm-alert': '>=2.0.0',
        },
      },
    });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'dependencies.skills.napm-alert'));
    assert.strictEqual(result.compatibility_check.dependencies['napm-alert'].ok, false);
  });

  it('缺少依赖 Skill 应失败', () => {
    const zip = buildSkillPackage({
      compatibility: {
        min_openclaw_version: '2026.5.0',
        napm_api_version: 'v2',
      },
      dependencies: {
        skills: {
          'napm-nonexistent': '>=1.0.0',
        },
      },
    });
    const result = validator.validate(zip);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.compatibility_check.dependencies['napm-nonexistent'].current, null);
    assert.strictEqual(result.compatibility_check.dependencies['napm-nonexistent'].ok, false);
  });

  it('无兼容性问题应全部通过', () => {
    const zip = buildSkillPackage({
      compatibility: {
        min_openclaw_version: '2026.5.0',
        min_frontend_version: '2.0.0',
        napm_api_version: 'v2',
      },
      dependencies: {
        skills: {
          'napm-alert': '>=1.0.0',
        },
      },
    });
    const result = validator.validate(zip);
    // 当前 openclaw=2026.5.4 >= 2026.5.0 ✓
    // 当前 frontend=2.1.0 >= 2.0.0 ✓
    // napm-alert=1.2.0 satisfies >=1.0.0 ✓
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.compatibility_check.openclaw.ok, true);
    assert.strictEqual(result.compatibility_check.frontend.ok, true);
    assert.strictEqual(result.compatibility_check.dependencies['napm-alert'].ok, true);
  });
});

// ══════════════════════════════════════════════════════════════
// 边界情况
// ══════════════════════════════════════════════════════════════

describe('边界情况', () => {
  it('空 ZIP 应失败', () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    const result = validator.validate(zip.toBuffer());
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'manifest'));
  });

  it('损坏的 ZIP 应失败', () => {
    const badBuffer = Buffer.from('this is not a zip file');
    const result = validator.validate(badBuffer);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'zip'));
  });
});

// ══════════════════════════════════════════════════════════════
// 加密包（AES-256-GCM）
// ══════════════════════════════════════════════════════════════

describe('加密包', () => {
  // 创建带加密能力的 validator（读取测试密钥）
  const testKey = fs.readFileSync(TEST_ENCRYPTION_KEY_PATH, 'utf8').trim();
  const encryptDb = new Database(':memory:');
  encryptDb.pragma('journal_mode = WAL');
  encryptDb.pragma('foreign_keys = ON');
  encryptDb.exec(`
    CREATE TABLE IF NOT EXISTS components (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    UNIQUE NOT NULL,
        type        TEXT    NOT NULL CHECK(type IN ('openclaw', 'frontend', 'skill')),
        version     TEXT    NOT NULL,
        status      TEXT    DEFAULT 'active' CHECK(status IN ('active', 'upgrading', 'degraded')),
        install_path TEXT   NOT NULL,
        updated_at  TEXT    DEFAULT (datetime('now'))
    );
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
  `);
  // 播种组件数据供兼容性检查
  encryptDb.prepare(`INSERT INTO components (name, type, version, install_path) VALUES (?, 'openclaw', '2026.5.4', '/fake/openclaw')`).run('openclaw');
  encryptDb.prepare(`INSERT INTO components (name, type, version, install_path) VALUES (?, 'frontend', '2.0.0', '/fake/frontend')`).run('frontend');
  encryptDb.prepare(`INSERT INTO components (name, type, version, install_path) VALUES (?, 'skill', '1.2.0', '/fake/skills/napm-alert')`).run('napm-alert');
  encryptDb.prepare(`INSERT INTO components (name, type, version, install_path) VALUES (?, 'skill', '2.0.1', '/fake/skills/napm-diag')`).run('napm-diag');

  const encryptValidator = new UpgradeValidator({
    publicKey: PUBLIC_KEY,
    db: encryptDb,
    config: { encryptionKey: testKey },
  });

  it('合法加密包应解密并通过全部校验', () => {
    // 构建一个合法签名包 → 加密 → 传给带密钥的 validator
    const plainZip = buildSkillPackage();
    const encrypted = encryptPackage(plainZip, testKey);
    // 确认加密后的数据不是合法 ZIP（魔数被替换为 NAPE）
    assert.strictEqual(encrypted.subarray(0, 4).toString('utf8'), 'NAPE');

    const result = encryptValidator.validate(encrypted);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.type, 'skill-single');
    assert.strictEqual(result.component, 'napm-diag');
    assert.strictEqual(result.new_version, '2.1.0');
  });

  it('明文包（无 NAPE 魔数）仍可正常校验', () => {
    // 即使 validator 配置了密钥，明文包也应正常工作
    const plainZip = buildSkillPackage();
    const result = encryptValidator.validate(plainZip);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.type, 'skill-single');
  });

  it('加密包使用错误密钥应拒绝', () => {
    const plainZip = buildSkillPackage();
    const encrypted = encryptPackage(plainZip, testKey);

    // 用另一个随机密钥创建的 validator 应该解密失败
    const wrongKey = 'a'.repeat(62) + 'b' + 'c';  // 63 个 a + bc = 64 hex = 32 bytes
    const wrongDb = new Database(':memory:');
    wrongDb.pragma('journal_mode = WAL');
    wrongDb.exec(`CREATE TABLE IF NOT EXISTS components (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL, version TEXT NOT NULL, status TEXT DEFAULT 'active', install_path TEXT NOT NULL, updated_at TEXT)`);
    const wrongValidator = new UpgradeValidator({
      publicKey: PUBLIC_KEY,
      db: wrongDb,
      config: { encryptionKey: wrongKey },
    });

    const result = wrongValidator.validate(encrypted);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'encryption'));
    assert.ok(result.errors.some((e) => e.message.includes('解密失败')));
  });

  it('篡改加密包密文应拒绝（GCM 认证失效）', () => {
    const plainZip = buildSkillPackage();
    const encrypted = encryptPackage(plainZip, testKey);

    // 翻转密文区域的第 20 个字节（跳过 MAGIC+IV = 16 字节，修改第 36 字节）
    const pos = 16 + 20;  // 密文中的第 20 字节
    encrypted[pos] = encrypted[pos] ^ 0xFF;

    const result = encryptValidator.validate(encrypted);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === 'encryption'));
    assert.ok(result.errors.some((e) => e.message.includes('解密失败')));
  });

  it('非加密包但无配置密钥 → 正常校验', () => {
    // validator 未配置密钥 → 明文包正常通过
    const plainZip = buildSkillPackage();
    const result = validator.validate(plainZip);
    assert.strictEqual(result.valid, true);
  });
});
