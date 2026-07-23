/**
 * Electron 主进程 — GAIOP 打包工具。
 *
 * 启动 Express 服务 → 创建原生窗口 → 加载 Web UI。
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { startServer } = require('../tools/package-gui');

const PORT = 18901;
const isPackaged = app.isPackaged;

let mainWindow = null;
let server = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 750,
    minWidth: 660,
    minHeight: 600,
    title: 'GAIOP 打包工具',
    icon: path.join(__dirname, '..', 'tools', 'package-gui.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
    show: false,
  });

  // 去掉菜单栏
  mainWindow.setMenuBarVisibility(false);

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(async () => {
  try {
    // 启动 Express 服务
    server = await startServer(PORT, false);

    // 创建窗口
    createWindow();

  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (server) {
    server.close();
  }
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
