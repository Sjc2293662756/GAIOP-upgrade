#!/usr/bin/env node
/**
 * 数据库初始化脚本（可单独运行）。
 * 用法: node src/database/init.js
 */
const { initSchema } = require('./schema');
const { seedComponents } = require('./seed');

console.log('[db:init] 初始化数据库 schema...');
initSchema();
console.log('[db:init] Schema 初始化完成');

console.log('[db:init] 扫描并注册已有组件...');
seedComponents();
console.log('[db:init] 组件注册完成');

process.exit(0);
