#!/usr/bin/env node
/**
 * 为 NAPM 打包工具创建桌面快捷方式（带自定义图标）。
 *
 * 用法:
 *   node tools/create-shortcut.js
 *
 * 输出: 桌面快捷方式 → "NAPM 打包工具.lnk"
 *
 * 原理: 生成 VBScript 临时文件 (UTF-16LE) → cscript 执行 → 删除临时文件。
 *       避开 PowerShell 在 Git Bash 下的编码问题。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ── 路径计算 ──────────────────────────────────────────────
const projectRoot = path.resolve(__dirname, '..');
const batFile = path.join(projectRoot, 'tools', 'package-gui.bat');
const iconFile = path.join(projectRoot, 'tools', 'package-gui.ico');
const desktop = path.join(os.homedir(), 'Desktop');
const shortcutPath = path.join(desktop, 'NAPM 打包工具.lnk');

console.log('项目根目录:', projectRoot);
console.log('启动脚本:  ', batFile);
console.log('图标文件:  ', iconFile);
console.log('桌面路径:  ', desktop);

// ── 前置检查 ──────────────────────────────────────────────
if (!fs.existsSync(batFile)) {
  console.error('❌ 找不到启动脚本:', batFile);
  process.exit(1);
}
if (!fs.existsSync(iconFile)) {
  console.warn('⚠️  找不到图标文件，快捷方式将使用默认图标');
  console.warn('   请先运行: node tools/make-icon.js');
}

// ── 生成 VBScript ─────────────────────────────────────────
// VBS 文件用 UTF-16LE 编码，完美支持中文路径
const vbsLines = [
  'Set WshShell = WScript.CreateObject("WScript.Shell")',
  `Set lnk = WshShell.CreateShortcut("${shortcutPath}")`,
  `lnk.TargetPath = "${batFile}"`,
  `lnk.WorkingDirectory = "${projectRoot}"`,
  'lnk.WindowStyle = 7',
  'lnk.Description = "NAPM 升级包打包工具 — 可视化界面"',
  `lnk.IconLocation = "${iconFile}"`,
  'lnk.Save',
];

const vbsContent = vbsLines.join('\r\n');
const vbsPath = path.join(__dirname, '_tmp_create_shortcut.vbs');

try {
  // 写 UTF-16LE (BOM) — VBScript 标准编码
  const BOM = Buffer.from([0xFF, 0xFE]);
  const utf16le = Buffer.concat([BOM, Buffer.from(vbsContent, 'utf16le')]);
  fs.writeFileSync(vbsPath, utf16le);

  console.log('\n执行 VBScript...');
  execSync(`cscript //Nologo "${vbsPath}"`, { stdio: 'inherit', cwd: projectRoot });

  console.log(`\n✅ 桌面快捷方式已创建: ${shortcutPath}`);
} catch (err) {
  console.error('❌ 创建快捷方式失败:', err.message);
  process.exit(1);
} finally {
  // 清理临时文件
  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
  }
}
