'use strict';
/**
 * 渲染层唯一入口。contextIsolation 开启，页面拿不到 Node，只能调这些方法。
 * 注意：这个文件必须出现在 package.json 的 build.files 白名单里，否则打包后界面会永远停在「检测中」。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
  env: {
    detect: (force) => ipcRenderer.invoke('env:detect', force),
    setup: (opts) => ipcRenderer.invoke('env:setup', opts),
    downloadModel: () => ipcRenderer.invoke('env:download-model'),
    onLog: on('env:log'),
    onModelProgress: on('env:model-progress'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (p) => ipcRenderer.invoke('settings:patch', p),
    setKey: (k) => ipcRenderer.invoke('settings:set-key', k),
  },
  media: {
    probe: (file) => ipcRenderer.invoke('media:probe', file),
  },
  dialog: {
    pickVideo: () => ipcRenderer.invoke('dialog:pick-video'),
    pickDir: (o) => ipcRenderer.invoke('dialog:pick-dir', o),
    pickFile: (o) => ipcRenderer.invoke('dialog:pick-file', o),
  },
  task: {
    start: (payload) => ipcRenderer.invoke('task:start', payload),
    cancel: () => ipcRenderer.invoke('task:cancel'),
    onEvent: on('task:event'),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
  },
  report: {
    open: (p) => ipcRenderer.invoke('report:open', p),
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
    showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
    openExternal: (u) => ipcRenderer.invoke('shell:open-external', u),
  },
  engine: {
    check: () => ipcRenderer.invoke('engine:check'),
    update: () => ipcRenderer.invoke('engine:update'),
    restore: () => ipcRenderer.invoke('engine:restore'),
    onLog: on('engine:log'),
    onProgress: on('engine:progress'),
  },
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: on('update:event'),
  },
  /** 拖拽文件时取真实路径（Electron 32+ 移除了 File.path） */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return '';
    }
  },
});
