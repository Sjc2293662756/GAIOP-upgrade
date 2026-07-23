/**
 * Electron preload — 安全隔离层。
 * 当前不需要向渲染进程暴露任何 API。
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
});
