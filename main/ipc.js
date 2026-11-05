'use strict';
/** 主进程与渲染层之间的全部通道。渲染层只能通过 preload 暴露的这些方法动作。 */
const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { P, venvPython } = require('./paths');
const store = require('./store');
const env = require('./env');
const engine = require('./engine');
const status = require('./status');
const updater = require('./updater');
const { Runner } = require('./runner');
const log = require('./logger');

let runner = null;

function emitTo(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function register({ win }) {
  // Windows 上不弹「文件不存在」以外的异常
  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      log.error('IPC 失败', e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };

  ipcMain.handle('app:info', () =>
    ({
      ok: true,
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      dataDir: P.dataDir,
      logFile: log.path(),
      updateState: updater.getState(),
    })
  );

  ipcMain.handle('env:detect', guard(async (e, force) => status.detect(!!force)));

  ipcMain.handle(
    'env:setup',
    guard(async (e, opts) => {
      const r = await env.setup({
        forceManaged: !!(opts && opts.forceManaged),
        onLog: (line) => emitTo(win, 'env:log', { line }),
      });
      status.invalidate();
      const st = await status.detect(true);
      return { ...r, status: st };
    })
  );

  ipcMain.handle(
    'env:download-model',
    guard(async () => {
      const r = await env.downloadStemModel((p) => emitTo(win, 'env:model-progress', p));
      status.invalidate();
      return r;
    })
  );

  ipcMain.handle('settings:get', () => ({ ok: true, settings: store.publicView(), paths: P }));
  ipcMain.handle(
    'settings:patch',
    guard(async (e, patchObj) => {
      store.patch(patchObj);
      status.invalidate();
      return { ok: true, settings: store.publicView() };
    })
  );
  ipcMain.handle(
    'settings:set-key',
    guard(async (e, key) => {
      store.setApiKey(key || '');
      status.invalidate();
      return { ok: true, hasKey: !!key, vlm: status.vlmStatus() };
    })
  );

  ipcMain.handle(
    'dialog:pick-video',
    guard(async () => {
      const s = store.get();
      const r = await dialog.showOpenDialog(win, {
        title: '选择要拆解的视频',
        defaultPath: s.lastVideoDir || app.getPath('videos'),
        properties: ['openFile'],
        filters: [
          { name: '视频', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'ts', 'mts', 'mpg', 'mpeg'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      store.patch({ lastVideoDir: path.dirname(r.filePaths[0]) });
      return { ok: true, path: r.filePaths[0] };
    })
  );

  ipcMain.handle(
    'dialog:pick-dir',
    guard(async (e, opts) => {
      const r = await dialog.showOpenDialog(win, {
        title: (opts && opts.title) || '选择目录',
        defaultPath: (opts && opts.defaultPath) || undefined,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
    })
  );

  ipcMain.handle(
    'dialog:pick-file',
    guard(async (e, opts) => {
      const r = await dialog.showOpenDialog(win, {
        title: (opts && opts.title) || '选择文件',
        properties: ['openFile'],
        filters: opts && opts.filters ? opts.filters : undefined,
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
    })
  );

  ipcMain.handle('media:probe', guard(async (e, file) => status.probeVideo(file)));

  ipcMain.handle(
    'task:start',
    guard(async (e, payload) => {
      if (runner && runner.child) return { ok: false, error: '已有任务在运行，请先等待或取消' };
      const st = await status.detect();
      if (!st.engineReady) return { ok: false, error: '引擎未就绪，请先到「环境」页修复' };
      if (!st.python || !st.python.ok) return { ok: false, error: '没有可用的 Python 3.10+，请先到「环境」页安装' };
      if (!st.python.depsComplete) return { ok: false, error: 'Python 依赖不完整，请到「环境」页点「安装 / 修复依赖」' };
      if (!st.ffmpeg.ok) return { ok: false, error: '没有找到 ffmpeg，请到「环境」页指定路径' };
      if (!fs.existsSync(payload.video)) return { ok: false, error: '视频文件不存在' };

      runner = new Runner((channel, data) => emitTo(win, channel, data));
      const s = store.get();
      const vlm = {
        baseUrl: s.vlm.baseUrl,
        models: s.vlm.models,
        media: s.vlm.media,
        timeout: s.vlm.timeout,
        apiKey: store.apiKey(),
      };
      const r = runner.start({
        video: payload.video,
        python: st.python.path,
        ffmpeg: st.ffmpeg,
        vlm,
        options: { ...s.opts, ...(payload.options || {}) },
      });
      return r;
    })
  );

  ipcMain.handle('task:cancel', () => ({ ok: !!(runner && runner.cancel()) }));

  ipcMain.handle('history:list', () => ({ ok: true, items: status.listHistory() }));

  ipcMain.handle(
    'report:open',
    guard(async (e, file) => {
      if (!file || !fs.existsSync(file)) return { ok: false, error: '报告文件不存在' };
      const w = new BrowserWindow({
        width: 1180,
        height: 900,
        title: '拆解报告 — ' + path.basename(path.dirname(file)),
        backgroundColor: '#ffffff',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      w.setMenuBarVisibility(false);
      await w.loadURL(pathToFileURL(file).toString());
      return { ok: true };
    })
  );

  ipcMain.handle(
    'shell:open-path',
    guard(async (e, p) => {
      if (!p) return { ok: false };
      const target = fs.existsSync(p) ? p : path.dirname(p);
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true };
    })
  );
  ipcMain.handle('shell:show-item', (e, p) => {
    try {
      shell.showItemInFolder(p);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('shell:open-external', guard(async (e, url) => {
    await shell.openExternal(url);
    return { ok: true };
  }));

  ipcMain.handle('engine:check', guard(async () => engine.checkUpstream()));
  ipcMain.handle(
    'engine:update',
    guard(async () => {
      const r = await engine.updateUpstream({
        onLog: (line) => emitTo(win, 'engine:log', { line }),
        onProgress: (p) => emitTo(win, 'engine:progress', p),
      });
      status.invalidate();
      return r;
    })
  );
  ipcMain.handle('engine:restore', guard(async () => {
    const r = engine.restoreBundled();
    status.invalidate();
    return r;
  }));

  ipcMain.handle('update:check', guard(async () => ({ ok: true, state: await updater.check(false) })));
  ipcMain.handle('update:download', guard(async () => updater.download()));
  ipcMain.handle('update:install', guard(async () => updater.install()));
}

module.exports = { register };
