'use strict';
/**
 * 客户端自身的升级：electron-updater + generic/GitHub feed。
 * 没有打包（开发模式）或没配 feed 时安静地跳过，不弹错误。
 */
const { app, dialog } = require('electron');
const store = require('./store');
const log = require('./logger');

let autoUpdater = null;
let win = null;
let state = { status: 'idle', info: null, progress: null, error: null };

function send() {
  if (win && !win.isDestroyed()) win.webContents.send('update:event', state);
}

function feedUrl() {
  const s = store.get();
  return (s.updates.feedUrl || '').trim();
}

function ensureUpdater() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    log.warn('electron-updater 不可用', e.message);
    return null;
  }
  autoUpdater.autoDownload = !!store.get().updates.autoDownload;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log.info('[updater]', m),
    warn: (m) => log.warn('[updater]', m),
    error: (m) => log.error('[updater]', m),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => {
    state = { ...state, status: 'checking', error: null };
    send();
  });
  autoUpdater.on('update-available', (info) => {
    state = { ...state, status: 'available', info: { version: info.version, notes: info.releaseNotes, date: info.releaseDate } };
    send();
  });
  autoUpdater.on('update-not-available', (info) => {
    state = { ...state, status: 'none', info: { version: info && info.version } };
    send();
  });
  autoUpdater.on('error', (e) => {
    state = { ...state, status: 'error', error: (e && e.message) || String(e) };
    send();
  });
  autoUpdater.on('download-progress', (p) => {
    state = { ...state, status: 'downloading', progress: { percent: p.percent, bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total } };
    send();
  });
  autoUpdater.on('update-downloaded', (info) => {
    state = { ...state, status: 'downloaded', info: { version: info.version } };
    send();
  });
  return autoUpdater;
}

function init(mainWindow) {
  win = mainWindow;
  if (!app.isPackaged) {
    log.info('开发模式，跳过自动更新');
    return;
  }
  const u = ensureUpdater();
  if (!u) return;
  const url = feedUrl();
  if (url) {
    try {
      u.setFeedURL({ provider: 'generic', url });
      log.info('更新源', url);
    } catch (e) {
      log.warn('设置更新源失败', e.message);
    }
  }
  if (store.get().updates.checkOnStart) {
    setTimeout(() => check(true), 4000);
  }
}

async function check(silent = false) {
  if (!app.isPackaged) {
    state = { status: 'unsupported', error: '开发模式不支持自动更新' };
    send();
    return state;
  }
  const u = ensureUpdater();
  if (!u) {
    state = { status: 'unsupported', error: '缺少 electron-updater' };
    send();
    return state;
  }
  const url = feedUrl();
  if (url) {
    try {
      u.setFeedURL({ provider: 'generic', url });
    } catch (_) {}
  }
  try {
    await u.checkForUpdates();
  } catch (e) {
    state = { status: 'error', error: e.message };
    send();
    if (!silent) log.warn('检查更新失败', e.message);
  }
  return state;
}

async function download() {
  const u = ensureUpdater();
  if (!u) return { ok: false, error: '不可用' };
  try {
    await u.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function install() {
  const u = ensureUpdater();
  if (!u) return { ok: false, error: '不可用' };
  setImmediate(() => u.quitAndInstall(false, true));
  return { ok: true };
}

module.exports = { init, check, download, install, getState: () => state };
