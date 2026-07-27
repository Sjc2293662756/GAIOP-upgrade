const fs = require('fs');
const { execFileSync } = require('child_process');

function applyOwnership(targetPath, owner, group) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  if (!targetPath || !fs.existsSync(targetPath)) return;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(owner || '')
    || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(group || '')) {
    throw new Error('文件所有者配置无效');
  }
  execFileSync('chown', ['-R', '--', `${owner}:${group}`, targetPath], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

module.exports = { applyOwnership };
