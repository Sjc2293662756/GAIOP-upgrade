const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const semver = require('semver');
const { v4: uuidv4 } = require('uuid');

/**
 * 升级包校验器。
 *
 * 职责：
 * 1. 解压 ZIP 并解析 upgrade-manifest.json
 * 2. 逐文件 SHA256 校验
 * 3. RSA 签名验证
 * 4. 兼容性检查（版本方向 + 组件依赖 + API 版本）
 * 5. 返回结构化校验结果
 */
class UpgradeValidator {
  /**
   * @param {object} opts
   * @param {Buffer|string} opts.publicKey  RSA 公钥内容（PEM 格式）
   * @param {object} opts.db               better-sqlite3 数据库实例
   * @param {object} [opts.config]         可选的配置覆盖（含 encryptionKey）
   */
  constructor(opts) {
    this.publicKey = typeof opts.publicKey === 'string'
      ? Buffer.from(opts.publicKey)
      : opts.publicKey;
    this.db = opts.db;
    this.config = opts.config || {};
  }

  // ──────────────────────────────────────────────────────────
  // 公开方法
  // ──────────────────────────────────────────────────────────

  /**
   * 校验升级包。返回结构化结果，与设计文档 7.3.1 节对齐。
   *
   * @param {Buffer} zipBuffer   ZIP 文件的二进制内容
   * @param {object} [options]   可选参数
   * @param {boolean} [options.force=false]  跳过非关键警告
   * @returns {object} 校验结果
   */
  validate(zipBuffer, options = {}) {
    const force = options.force || false;
    const taskId = uuidv4();
    const errors = [];
    const warnings = [];

    // ── 阶段 0: 解密（如果是加密包）─────────────────────────
    let zipBufferToProcess = zipBuffer;
    if (this.config.encryptionKey) {
      const decrypted = this._decryptPackage(zipBuffer);
      if (decrypted.error) {
        return this._reject(taskId, [decrypted.error]);
      }
      zipBufferToProcess = decrypted.buffer;
    }

    // ── 阶段 1: 解压 & 解析 manifest ─────────────────────
    let zip, manifest, extractDir;
    try {
      zip = new AdmZip(zipBufferToProcess);
    } catch (err) {
      return this._reject(taskId, [{
        field: 'zip',
        message: `无法解析 ZIP 文件: ${err.message}`,
      }]);
    }

    try {
      manifest = this._readManifest(zip);
    } catch (err) {
      return this._reject(taskId, [{
        field: 'manifest',
        message: err.message,
      }]);
    }

    // ── 阶段 2: 校验 manifest 字段 ────────────────────────
    this._validateManifestFields(manifest, errors);

    // ── 阶段 3: SHA256 文件校验 ───────────────────────────
    if (manifest.files_checksum) {
      this._verifyChecksums(zip, manifest, errors);
    }

    // ── 阶段 4: RSA 签名验证 ──────────────────────────────
    if (manifest.signature) {
      this._verifySignature(zip, manifest, errors);
    }

    // ── 阶段 5: 版本方向检查 ──────────────────────────────
    let currentVersion = null;
    const componentRecord = this._getComponentRecord(manifest);
    if (componentRecord) {
      currentVersion = componentRecord.version;
      const versionCheck = this._checkVersionDirection(
        currentVersion,
        manifest.version,
        manifest.component || manifest.type,
      );
      if (!versionCheck.ok) {
        errors.push(versionCheck.error);
      }
    }

    // ── 阶段 6: 兼容性检查 ────────────────────────────────
    let compatibilityResult = {};
    if (!errors.length || force) {
      // 只在前面没有硬错误时做兼容性检查（签名/哈希失败已致命）
      compatibilityResult = this._checkCompatibility(manifest, errors);
    }

    // ── 阶段 7: 影响范围评估 ──────────────────────────────
    const impact = this._assessImpact(manifest);

    // ── 汇总结果 ──────────────────────────────────────────
    const baseResult = {
      task_id: taskId,
      type: manifest.type,
      component: manifest.component || null,
      current_version: currentVersion,
      new_version: manifest.version,
      display_name: manifest.display_name || null,
      changelog: manifest.changelog || null,
      compatibility_check: compatibilityResult,
      impact,
      warnings,
    };

    if (errors.length > 0) {
      return {
        ...baseResult,
        valid: false,
        errors,
      };
    }

    return {
      ...baseResult,
      valid: true,
    };
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — Manifest 解析
  // ──────────────────────────────────────────────────────────

  /**
   * 从 ZIP 中读取并解析 upgrade-manifest.json。
   */
  _readManifest(zip) {
    const manifestEntry = zip.getEntry('upgrade-manifest.json');
    if (!manifestEntry) {
      throw new Error('升级包缺少 upgrade-manifest.json 文件');
    }
    try {
      const raw = manifestEntry.getData().toString('utf8');
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`upgrade-manifest.json 解析失败: ${err.message}`);
    }
  }

  /**
   * 校验 manifest 必填字段。
   */
  _validateManifestFields(manifest, errors) {
    const requiredFields = [
      ['type', 'string'],
      ['version', 'string'],
      ['compatibility', 'object'],
      ['signature', 'object'],
      ['files_checksum', 'object'],
    ];

    for (const [field, expectedType] of requiredFields) {
      if (manifest[field] == null) {
        errors.push({
          field,
          message: `缺少必填字段: ${field}`,
        });
      } else if (typeof manifest[field] !== expectedType) {
        errors.push({
          field,
          message: `字段 ${field} 类型错误: 期望 ${expectedType}，实际 ${typeof manifest[field]}`,
        });
      }
    }

    // type 值校验
    const validTypes = ['skill-single', 'skill-bundle', 'openclaw', 'frontend', 'full-stack'];
    if (manifest.type && !validTypes.includes(manifest.type)) {
      errors.push({
        field: 'type',
        message: `无效的包类型: ${manifest.type}，有效值: ${validTypes.join(', ')}`,
      });
    }

    // skill-single 必须有 component
    if (manifest.type === 'skill-single' && !manifest.component) {
      errors.push({
        field: 'component',
        message: 'skill-single 类型必须指定 component 字段',
      });
    }

    // version 必须是合法 semver
    if (manifest.version && !semver.valid(manifest.version)) {
      // 尝试 coerce，比如 "2026.5.4" 这样的格式
      const coerced = semver.coerce(manifest.version);
      if (!coerced) {
        errors.push({
          field: 'version',
          message: `版本号 "${manifest.version}" 不符合 SemVer 2.0 规范`,
        });
      }
    }

    // signature 子字段
    if (manifest.signature) {
      if (!manifest.signature.value) {
        errors.push({ field: 'signature.value', message: '缺少签名值' });
      }
      if (!manifest.signature.algorithm) {
        errors.push({ field: 'signature.algorithm', message: '缺少签名算法' });
      }
    }

    // files_checksum 子字段
    if (manifest.files_checksum) {
      if (!manifest.files_checksum.entries || typeof manifest.files_checksum.entries !== 'object') {
        errors.push({ field: 'files_checksum.entries', message: '缺少文件校验和列表' });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — SHA256 校验
  // ──────────────────────────────────────────────────────────

  /**
   * 逐文件计算 SHA256 并与 manifest 中的值比对。
   */
  _verifyChecksums(zip, manifest, errors) {
    const entries = manifest.files_checksum.entries;

    for (const [filePath, expectedHash] of Object.entries(entries)) {
      const entry = zip.getEntry(filePath);
      if (!entry) {
        errors.push({
          field: 'files_checksum',
          message: `文件 "${filePath}" 在 ZIP 中不存在，但 manifest 声明了其校验和`,
        });
        continue;
      }

      const actualHash = crypto
        .createHash('sha256')
        .update(entry.getData())
        .digest('hex');

      if (actualHash !== expectedHash) {
        errors.push({
          field: 'files_checksum',
          message: `文件 "${filePath}" 的 SHA256 不匹配: 期望 ${expectedHash}，实际 ${actualHash}`,
        });
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — RSA 签名验证
  // ──────────────────────────────────────────────────────────

  /**
   * 验证 RSA 签名。
   *
   * 签名流程（设计文档 5.5 节）:
   * 1. 按字典序排列文件路径
   * 2. 构造规范摘要: "{path1}:{sha256_1}\n{path2}:{sha256_2}\n..."
   * 3. 用公钥验证 signature.value
   */
  _verifySignature(zip, manifest, errors) {
    const sig = manifest.signature;

    // 构造规范化摘要字符串
    const digest = this._buildCanonicalDigest(manifest);

    try {
      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(digest);
      verify.end();

      const signatureBuffer = Buffer.from(sig.value, 'base64');
      const isValid = verify.verify(this.publicKey, signatureBuffer);

      if (!isValid) {
        errors.push({
          field: 'signature',
          message: '签名验证失败：签名不匹配，包可能被篡改或使用错误的密钥签名',
        });
      }
    } catch (err) {
      errors.push({
        field: 'signature',
        message: `签名验证异常: ${err.message}`,
      });
    }
  }

  /**
   * 构建规范化摘要字符串（用于签名验证）。
   *
   * 格式: 按文件路径字典序排列，每行 "路径:SHA256"
   */
  _buildCanonicalDigest(manifest) {
    const entries = manifest.files_checksum.entries;
    const sortedPaths = Object.keys(entries).sort();

    return sortedPaths
      .map((filePath) => `${filePath}:${entries[filePath]}`)
      .join('\n');
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — 兼容性检查
  // ──────────────────────────────────────────────────────────

  /**
   * 检查升级包的兼容性要求是否满足当前环境。
   * 返回设计文档 7.3.1 节定义的 compatibility_check 结构。
   */
  _checkCompatibility(manifest, errors) {
    const result = {};
    const env = this._getEnvironmentVersions();
    let allOk = true;

    const compat = manifest.compatibility || {};

    // 1. OpenClaw 版本检查
    if (compat.min_openclaw_version) {
      const current = env.openclaw;
      const required = `>=${compat.min_openclaw_version}`;
      const currentVersion = semver.coerce(current);
      const requiredVersion = semver.coerce(compat.min_openclaw_version);

      let ok = false;
      if (currentVersion && requiredVersion) {
        ok = semver.gte(currentVersion, requiredVersion);
      }

      result.openclaw = { current, required, ok };
      if (!ok) {
        allOk = false;
        errors.push({
          field: 'compatibility.openclaw',
          message: `当前 OpenClaw ${current} 不满足最低要求 ${compat.min_openclaw_version}，请先升级 OpenClaw`,
        });
      }
    }

    // 2. 前端版本检查
    if (compat.min_frontend_version) {
      const current = env.frontend;
      const required = `>=${compat.min_frontend_version}`;
      const currentVersion = semver.coerce(current);
      const requiredVersion = semver.coerce(compat.min_frontend_version);

      let ok = false;
      if (currentVersion && requiredVersion) {
        ok = semver.gte(currentVersion, requiredVersion);
      }

      result.frontend = { current, required, ok };
      if (!ok) {
        allOk = false;
        errors.push({
          field: 'compatibility.frontend',
          message: `当前前端 ${current} 不满足最低要求 ${compat.min_frontend_version}，请先升级前端`,
        });
      }
    }

    // 3. NAPM API 版本检查（精确匹配）
    if (compat.napm_api_version) {
      const current = env.napm_api || 'v2';
      const required = compat.napm_api_version;
      const ok = (current === required);

      result.napm_api = { current, required, ok };
      if (!ok) {
        allOk = false;
        errors.push({
          field: 'compatibility.napm_api',
          message: `当前 NAPM API ${current} 不满足要求 ${required}`,
        });
      }
    }

    // 4. 依赖 Skills 检查
    if (manifest.dependencies && manifest.dependencies.skills) {
      result.dependencies = {};
      for (const [skillName, constraint] of Object.entries(manifest.dependencies.skills)) {
        const current = env.skills[skillName] || null;

        let ok = false;
        if (!current) {
          ok = false;
        } else {
          try {
            const currentVersion = semver.coerce(current);
            // 规范化约束字符串：逗号 → 空格（semver 库不支持逗号分隔的 AND）
            const normalizedConstraint = constraint.replace(/,/g, ' ');
            ok = currentVersion ? semver.satisfies(currentVersion, normalizedConstraint) : false;
          } catch (_) {
            ok = false;
          }
        }

        result.dependencies[skillName] = {
          current,
          required: constraint,
          ok,
        };

        if (!ok) {
          allOk = false;
          if (!current) {
            errors.push({
              field: `dependencies.skills.${skillName}`,
              message: `缺少依赖 Skill "${skillName}"，但升级包声明了依赖约束 ${constraint}`,
            });
          } else {
            errors.push({
              field: `dependencies.skills.${skillName}`,
              message: `Skill "${skillName}" 当前版本 ${current} 不满足依赖约束 ${constraint}`,
            });
          }
        }
      }
    }

    return result;
  }

  /**
   * 从数据库获取当前环境各组件的版本快照。
   */
  _getEnvironmentVersions() {
    const rows = this.db.prepare(
      'SELECT name, type, version FROM components'
    ).all();

    const env = { skills: {} };
    for (const row of rows) {
      if (row.type === 'openclaw') {
        env.openclaw = row.version;
      } else if (row.type === 'frontend') {
        env.frontend = row.version;
      } else if (row.type === 'skill') {
        env.skills[row.name] = row.version;
      }
    }

    // NAPM API 版本暂从环境读取，默认 v2
    env.napm_api = process.env.NAPM_API_VERSION || 'v2';

    return env;
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — 版本方向检查
  // ──────────────────────────────────────────────────────────

  /**
   * 新版本必须高于当前版本（降级场景请走回滚流程）。
   */
  _checkVersionDirection(currentVersion, newVersion, component) {
    const cur = semver.coerce(currentVersion);
    const nxt = semver.coerce(newVersion);

    if (!cur || !nxt) {
      // 无法解析版本号时跳过（如 "0.0.0" 初始版本）
      return { ok: true };
    }

    if (semver.lt(nxt, cur)) {
      return {
        ok: false,
        error: {
          field: 'version',
          message: `新版本 ${newVersion} 低于当前版本 ${currentVersion}。降级请使用回滚功能。`,
        },
      };
    }

    if (semver.eq(nxt, cur)) {
      return {
        ok: false,
        error: {
          field: 'version',
          message: `新版本 ${newVersion} 与当前版本相同，无需升级。`,
        },
      };
    }

    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — 影响范围评估
  // ──────────────────────────────────────────────────────────

  /**
   * 评估升级操作的影响范围。
   */
  _assessImpact(manifest) {
    const type = manifest.type;

    const impactMap = {
      'skill-single': {
        requires_restart: false,
        requires_maintenance: false,
        affected_components: manifest.component ? [manifest.component] : [],
        estimated_downtime_seconds: 0,
      },
      'skill-bundle': {
        requires_restart: false,
        requires_maintenance: false,
        affected_components: this._listBundleSkills(manifest),
        estimated_downtime_seconds: 0,
      },
      'openclaw': {
        requires_restart: true,
        requires_maintenance: true,
        affected_components: ['openclaw'],
        estimated_downtime_seconds: 30,
      },
      'frontend': {
        requires_restart: false,
        requires_maintenance: false,
        affected_components: ['frontend'],
        estimated_downtime_seconds: 0,
      },
      'full-stack': {
        requires_restart: true,
        requires_maintenance: true,
        affected_components: ['openclaw', 'frontend', 'all-skills'],
        estimated_downtime_seconds: 60,
      },
    };

    return impactMap[type] || {
      requires_restart: false,
      requires_maintenance: false,
      affected_components: [],
      estimated_downtime_seconds: 0,
    };
  }

  /**
   * 从 manifest 的 files_checksum 中提取 bundle 内的 skill 列表。
   */
  _listBundleSkills(manifest) {
    const entries = manifest.files_checksum?.entries || {};
    const skillSet = new Set();

    for (const filePath of Object.keys(entries)) {
      // skills/<skill-name>/...
      const match = filePath.match(/^skills\/([^/]+)\//);
      if (match) {
        skillSet.add(match[1]);
      }
    }

    return Array.from(skillSet).sort();
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — 数据库查询
  // ──────────────────────────────────────────────────────────

  /**
   * 从数据库获取组件当前记录。
   */
  _getComponentRecord(manifest) {
    const componentName = manifest.component;
    if (!componentName) return null;

    return this.db.prepare(
      'SELECT * FROM components WHERE name = ?'
    ).get(componentName) || null;
  }

  /**
   * 构造校验失败响应。
   */
  _reject(taskId, errors) {
    return {
      task_id: taskId,
      valid: false,
      errors,
    };
  }

  // ──────────────────────────────────────────────────────────
  // 私有方法 — AES-256-GCM 解密
  // ──────────────────────────────────────────────────────────

  /**
   * 尝试解密加密的升级包。
   *
   * 加密格式（tools/package.js 输出）:
   *   4 bytes  "NAPE" 魔数
   *   12 bytes 随机 IV (nonce)
   *   N  bytes 密文 (不含 GCM auth tag)
   *   16 bytes GCM 认证标签（位于密文末尾）
   *
   * 注: GCM auth tag 是 ciphertext 的最后 16 字节，
   * Node.js 的 decipher 会自动读取末尾的 auth tag。
   *
   * @param {Buffer} buffer  可能是加密或明文的 ZIP 内容
   * @returns {{ buffer: Buffer, error?: undefined } | { error: object }}
   *   解密成功返回 { buffer }，非加密包返回 { buffer: 原 buffer }，失败返回 { error }
   */
  _decryptPackage(buffer) {
    // 检查魔数——非加密包直接放行
    const magic = buffer.subarray(0, 4).toString('utf8');
    if (magic !== 'NAPE') {
      return { buffer };  // 明文包，不解密
    }

    if (!this.config.encryptionKey) {
      return {
        error: {
          field: 'encryption',
          message: '收到加密升级包，但服务端未配置 NAPM_PACKAGE_ENCRYPTION_KEY',
        },
      };
    }

    // 解析结构: MAGIC(4) + IV(12) + CIPHERTEXT(n-16) + AUTH_TAG(16)
    const iv = buffer.subarray(4, 16);
    const authTag = buffer.subarray(buffer.length - 16);
    const encrypted = buffer.subarray(16, buffer.length - 16);

    // 格式检查
    if (iv.length !== 12) {
      return {
        error: {
          field: 'encryption',
          message: `加密包格式错误: IV 长度 ${iv.length}，期望 12 字节`,
        },
      };
    }

    let key;
    try {
      key = Buffer.from(this.config.encryptionKey, 'hex');
    } catch (_) {
      return {
        error: {
          field: 'encryption',
          message: 'NAPM_PACKAGE_ENCRYPTION_KEY 格式无效，必须为 hex（64 位）',
        },
      };
    }

    if (key.length !== 32) {
      return {
        error: {
          field: 'encryption',
          message: `AES-256 需要 32 字节密钥，当前 ${key.length} 字节`,
        },
      };
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return { buffer: decrypted };
    } catch (err) {
      return {
        error: {
          field: 'encryption',
          message: `解密失败: ${err.message}。密钥可能不匹配或包已被篡改。`,
        },
      };
    }
  }
}

module.exports = { UpgradeValidator };
