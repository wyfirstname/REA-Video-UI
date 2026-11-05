'use strict';
// Electron 在某些终端环境下会被 ELECTRON_RUN_AS_NODE 污染，退化成纯 Node，
// 此时 require('electron') 拿到的是路径字符串而不是 API。必须在最前面清掉。
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { P, ensureDirs } = require('./paths');
const log = require('./logger');
const store = require('./store');
const engine = require('./engine');
const ipc = require('./ipc');
const updater = require('./updater');

let mainWindow = null;
const SELFTEST = process.env.RVD_SELFTEST === '1';
/** preload 是渲染层的唯一通道，漏打包会导致界面永远停在「检测中」。这里做兜底提示。 */
let preloadOk = false;
try {
  preloadOk = fs.existsSync(path.join(__dirname, '..', 'preload.js'));
} catch (_) {}

function createWindow() {
  const s = store.get();
  const bounds = s.window || {};
  mainWindow = new BrowserWindow({
    width: Math.max(1024, bounds.width || 1280),
    height: Math.max(720, bounds.height || 860),
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1016',
    title: 'REA Video Desktop',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!SELFTEST) mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', () => {
    try {
      const b = mainWindow.getBounds();
      store.patch({ window: { width: b.width, height: b.height, x: b.x, y: b.y } });
    } catch (_) {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (e, d) => {
    log.error('渲染进程崩溃', d);
  });

  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) log.warn('[renderer]', `${sourceId}:${line}`, message);
    else log.info('[renderer]', message);
  });

  return mainWindow;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开日志文件夹',
          click: () => shell.openPath(P.logDir),
        },
        {
          label: '打开数据目录',
          click: () => shell.openPath(P.dataDir),
        },
        {
          label: '上游项目 rea-video',
          click: () => shell.openExternal('https://github.com/JuneYaooo/rea-video'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  process.on('uncaughtException', (e) => log.error('未捕获异常', e));
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise', e));

  app.whenReady().then(() => {
    ensureDirs();
    log.init(P.mainLog);
    log.info('启动', { version: app.getVersion(), electron: process.versions.electron, dataDir: P.dataDir, packaged: app.isPackaged });

    const eng = engine.ensureEngine();
    if (!eng.ok) log.error('引擎不可用', eng.error);

    buildMenu();
    createWindow();
    ipc.register({ win: mainWindow });

    if (!preloadOk) {
      log.error('preload.js 缺失：渲染层将无法与主进程通信');
      dialog.showErrorBox('初始化失败', 'preload.js 没有打进安装包，界面无法工作。请重新安装完整版本。');
    }

    updater.init(mainWindow);

    if (process.env.RVD_SHOT === '1') {
      mainWindow.webContents.once('did-finish-load', () => {
        require('./shot')
          .capture(mainWindow)
          .catch((e) => log.error('截图失败', e))
          .finally(() => setTimeout(() => app.exit(0), 500));
      });
    }

    if (process.env.RVD_E2E === '1') {
      mainWindow.webContents.once('did-finish-load', () => {
        require('./e2e')
          .runE2E(app)
          .catch((e) => {
            log.error('E2E 失败', e);
            app.exit(9);
          });
      });
    }

    if (SELFTEST) {
      mainWindow.webContents.once('did-finish-load', async () => {
        const checks = await mainWindow.webContents.executeJavaScript(`(() => ({
          api: typeof window.api,
          apiKeys: window.api ? Object.keys(window.api) : [],
          title: document.title,
          bodyLen: document.body.innerHTML.length
        }))()`);
        const st = await require('./status').detect(true);
        const report = {
          preload: checks.api,
          apiKeys: checks.apiKeys,
          title: checks.title,
          bodyLen: checks.bodyLen,
          engineReady: st.engineReady,
          python: st.python ? st.python.path + ' ' + (st.python.version || '') : null,
          deps: st.python ? st.python.depsComplete : false,
          ffmpeg: st.ffmpeg.ok,
          dataDir: st.dataDir,
        };
        console.log('SELFTEST ' + JSON.stringify(report));
        setTimeout(() => app.exit(checks.api === 'object' && st.engineReady ? 0 : 1), 300);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
