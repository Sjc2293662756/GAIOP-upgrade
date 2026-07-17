#!/usr/bin/env node
/**
 * 将 PNG 图标转换为 Windows ICO 格式。
 *
 * 用法:
 *   node tools/make-icon.js <input.png> [output.ico]
 *
 * 默认输出: tools/package-gui.ico
 *
 * ICO 格式（PNG 编码）:
 *   ICO 头 (6 字节) + 目录项 (16 字节) + PNG 原始数据
 */

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || path.join(__dirname, '..', 'docs', '图标.png');
const outputPath = process.argv[3] || path.join(__dirname, 'package-gui.ico');

if (!fs.existsSync(inputPath)) {
  console.error(`❌ 输入文件不存在: ${inputPath}`);
  process.exit(1);
}

// 读取 PNG 数据
const pngBuffer = fs.readFileSync(inputPath);

// 验证 PNG 签名
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
if (!pngBuffer.slice(0, 8).equals(PNG_MAGIC)) {
  console.error('❌ 输入文件不是有效的 PNG 格式');
  process.exit(1);
}

// 从 PNG IHDR chunk 读取图像尺寸
const width = pngBuffer.readUInt32BE(16);   // IHDR 偏移: 8(sig) + 4(len) + 4(type) = 16
const height = pngBuffer.readUInt32BE(20);

console.log(`📐 PNG 尺寸: ${width}×${height} px`);
console.log(`📦 PNG 大小: ${(pngBuffer.length / 1024).toFixed(1)} KB`);

// ICO 头 (6 字节)
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);   // reserved, must be 0
icoHeader.writeUInt16LE(1, 2);   // type: 1 = icon
icoHeader.writeUInt16LE(1, 4);   // count: 1 image

// 目录项 (16 字节)
const dirEntry = Buffer.alloc(16);
dirEntry.writeUInt8(width >= 256 ? 0 : width, 0);     // width (0 = 256px)
dirEntry.writeUInt8(height >= 256 ? 0 : height, 1);    // height (0 = 256px)
dirEntry.writeUInt8(0, 2);          // color palette count
dirEntry.writeUInt8(0, 3);          // reserved
dirEntry.writeUInt16LE(1, 4);       // color planes
dirEntry.writeUInt16LE(32, 6);      // bits per pixel
dirEntry.writeUInt32LE(pngBuffer.length, 8);   // image size
dirEntry.writeUInt32LE(22, 12);     // image offset = 6 (header) + 16 (entry)

// 组装 ICO
const icoBuffer = Buffer.concat([icoHeader, dirEntry, pngBuffer]);

fs.writeFileSync(outputPath, icoBuffer);
console.log(`✅ 已生成: ${outputPath}`);
console.log(`   格式: ICO (PNG-compressed) | 大小: ${(icoBuffer.length / 1024).toFixed(1)} KB`);
