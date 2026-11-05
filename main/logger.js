'use strict';
/** 统一日志：控制台 + 单个文件。排障时只看 data/logs/main.log 就够。 */
const fs = require('fs');
const path = require('path');

let stream = null;
let filePath = null;

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function init(logFile) {
  filePath = logFile;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // 超过 4MB 就滚一次，避免长期使用把盘吃满
    try {
      const st = fs.statSync(logFile);
      if (st.size > 4 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
    } catch (_) {}
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (e) {
    console.error('log init failed', e);
  }
}

function write(level, args) {
  const msg = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch (_) {
        return String(a);
      }
    })
    .join(' ');
  const line = `${stamp()} ${level.toUpperCase()} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (stream) {
    try {
      stream.write(line + '\n');
    } catch (_) {}
  }
}

module.exports = {
  init,
  path: () => filePath,
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};
