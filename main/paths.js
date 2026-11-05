'use strict';
/**
 * 所有路径推导集中在这里。代码里不出现任何写死的盘符。
 *
 * 数据根目录优先级：
 *   1. 环境变量 REA_VIDEO_DESKTOP_HOME（高级用户 / 绿色包可自定义）
 *   2. 可执行文件同目录存在 portable.marker → <exeDir>/data（绿色版：不写系统盘）
 *   3. 系统用户数据目录（安装版）
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function exeDir() {
  return path.dirname(process.execPath);
}

function resolveDataDir() {
  const fromEnv = process.env.REA_VIDEO_DESKTOP_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  try {
    if (fs.existsSync(path.join(exeDir(), 'portable.marker'))) {
      return path.join(exeDir(), 'data');
    }
  } catch (_) {}
  return app.getPath('userData');
}

const DATA_DIR = resolveDataDir();

const P = {
  dataDir: DATA_DIR,
  settingsFile: path.join(DATA_DIR, 'settings.json'),
  logDir: path.join(DATA_DIR, 'logs'),
  mainLog: path.join(DATA_DIR, 'logs', 'main.log'),
  engineDir: path.join(DATA_DIR, 'engine'),
  engineStateFile: path.join(DATA_DIR, 'engine', '.engine.json'),
  venvDir: path.join(DATA_DIR, 'venv'),
  modelsDir: path.join(DATA_DIR, 'models'),
  memoryDir: path.join(DATA_DIR, 'memory'),
  worksDir: path.join(DATA_DIR, 'output'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  cacheDir: path.join(DATA_DIR, 'cache'),
};

/** 随安装包一起分发的引擎（只读）。打包后在 resources/engine，开发时在 vendor/rea-video */
function bundledEngineDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'engine');
  return path.join(app.getAppPath(), 'vendor', 'rea-video');
}

function venvPython() {
  return path.join(P.venvDir, 'Scripts', 'python.exe');
}

function ensureDirs() {
  for (const d of [P.dataDir, P.logDir, P.engineDir, P.modelsDir, P.memoryDir, P.worksDir, P.tmpDir, P.cacheDir]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (_) {}
  }
}

module.exports = { P, ensureDirs, bundledEngineDir, venvPython, exeDir, resolveDataDir };
