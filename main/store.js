'use strict';
/**
 * 设置持久化：JSON 文件 + API Key 用系统凭据加密（Windows DPAPI / macOS Keychain）后落盘。
 * 设置里不保存任何明文密钥。
 */
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { P } = require('./paths');
const log = require('./logger');

const DEFAULTS = {
  pythonPath: '',
  ffmpegDir: '',
  pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  installOcr: true,
  outputDir: '',
  mirrorPrefix: '',
  lastVideoDir: '',
  vlm: {
    baseUrl: '',
    models: '',
    media: 'both',
    timeout: 180,
    apiKeyEnc: '',
  },
  opts: {
    useVlm: true,
    ocrLang: 'zh',
    packaging: true,
    stems: true,
    workers: 3,
    engine: '',
    wholeVlm: true,
  },
  updates: {
    checkOnStart: true,
    feedUrl: '',
    autoDownload: false,
  },
  window: { width: 1280, height: 860 },
};

let cache = null;

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(P.settingsFile, 'utf8'));
  } catch (_) {}
  cache = deepMerge(DEFAULTS, raw);
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(P.settingsFile), { recursive: true });
    fs.writeFileSync(P.settingsFile, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    log.error('保存设置失败', e);
  }
}

function get() {
  return load();
}

function patch(p) {
  cache = deepMerge(load(), p || {});
  save();
  return cache;
}

/** 供渲染层读取的副本（不含加密字段原文） */
function publicView() {
  const s = get();
  return {
    ...s,
    vlm: {
      baseUrl: s.vlm.baseUrl,
      models: s.vlm.models,
      media: s.vlm.media,
      timeout: s.vlm.timeout,
      hasKey: !!s.vlm.apiKeyEnc,
    },
  };
}

/** 明文密钥只在这一层出现，用于拼环境变量 */
function apiKey() {
  const enc = get().vlm.apiKeyEnc;
  if (!enc) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
  } catch (e) {
    log.warn('解密 API Key 失败，按明文处理', e.message);
  }
  try {
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function setApiKey(key) {
  const s = get();
  const v = (key || '').trim();
  if (!v) {
    s.vlm.apiKeyEnc = '';
  } else if (safeStorage.isEncryptionAvailable()) {
    s.vlm.apiKeyEnc = safeStorage.encryptString(v).toString('base64');
  } else {
    s.vlm.apiKeyEnc = Buffer.from(v, 'utf8').toString('base64');
  }
  save();
  return !!v;
}

module.exports = { get, patch, publicView, apiKey, setApiKey, DEFAULTS };
