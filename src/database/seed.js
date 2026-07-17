const fs = require('fs');
const path = require('path');
const { getDb } = require('./connection');
const config = require('../config');

/**
 * 自动扫描现有组件并注册到 components 表。
 * 仅当 components 表为空时执行（幂等）。
 */
function seedComponents() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as cnt FROM components').get();
  if (count.cnt > 0) {
    return; // 已有数据，跳过
  }

  const components = [];

  // 1. OpenClaw
  const openclawVersion = readVersionFile(config.openclawRoot) || '2026.5.4';
  components.push({
    name: 'openclaw',
    type: 'openclaw',
    version: openclawVersion,
    install_path: config.openclawRoot,
  });

  // 2. 前端
  const frontendVersion = readVersionFile(config.frontendRoot) || '0.0.0';
  components.push({
    name: 'frontend',
    type: 'frontend',
    version: frontendVersion,
    install_path: config.frontendRoot,
  });

  // 3. Skills（自动发现 workspace/skills/ 下的所有目录）
  if (fs.existsSync(config.skillsRoot)) {
    const skillDirs = fs.readdirSync(config.skillsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of skillDirs) {
      const skillPath = path.join(config.skillsRoot, dir.name);
      const skillName = skillNameFromDir(dir.name);
      const version = readSkillVersion(skillPath) || '0.0.0';
      components.push({
        name: skillName,
        type: 'skill',
        version,
        install_path: skillPath,
      });
    }
  }

  const insert = db.prepare(
    'INSERT INTO components (name, type, version, install_path) VALUES (?, ?, ?, ?)'
  );

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insert.run(item.name, item.type, item.version, item.install_path);
    }
  });

  insertMany(components);
  console.log(`[seed] 已注册 ${components.length} 个组件`);
  return components;
}

/**
 * 从 openclaw- 前缀的目录名中提取简洁 Skill 名。
 */
function skillNameFromDir(dirName) {
  return dirName.replace(/^openclaw-napm-/, 'napm-').replace(/^echarts-/, 'echarts-');
}

/**
 * 读取组件根目录的 VERSION 文件。
 */
function readVersionFile(rootPath) {
  const versionFile = path.join(rootPath, 'VERSION');
  if (fs.existsSync(versionFile)) {
    return fs.readFileSync(versionFile, 'utf8').trim();
  }
  // 尝试从 package.json 读取
  const pkgFile = path.join(rootPath, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      return pkg.version || null;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * 读取 Skill 的版本（从 manifest.json 或 VERSION 文件）。
 */
function readSkillVersion(skillPath) {
  return readVersionFile(skillPath);
}

module.exports = { seedComponents };
