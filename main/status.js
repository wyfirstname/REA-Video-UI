'use strict';
/** 环境状态聚合（带缓存，避免每次点按钮都重新扫盘探测）。 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { P } = require('./paths');
const env = require('./env');
const engine = require('./engine');
const store = require('./store');

let cache = null;
let at = 0;
let inflight = null;

function vlmStatus() {
  const s = store.get();
  const key = store.apiKey();
  const configured = !!(s.vlm.baseUrl && key && s.vlm.models);
  let host = '';
  try {
    host = new URL(s.vlm.baseUrl).host;
  } catch (_) {}
  return { configured, host, models: s.vlm.models || '', media: s.vlm.media };
}

async function build() {
  const pythons = await env.detectPythons();
  const python = env.pickPython(pythons);
  const ffmpeg = await env.detectFfmpeg();
  const eng = engine.engineInfo();
  return {
    ok: true,
    app: { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged },
    dataDir: P.dataDir,
    venvDir: P.venvDir,
    engine: eng,
    engineReady: eng.ready,
    python,
    pythons: pythons.map((p) => ({
      path: p.path,
      version: p.version || '',
      ok: p.ok,
      depsComplete: !!p.depsComplete,
      missing: p.missing || [],
      isManaged: !!p.isManaged,
      error: p.error || '',
    })),
    ffmpeg,
    models: env.modelsReady(),
    vlm: vlmStatus(),
    outputDir: store.get().outputDir || P.worksDir,
    ready: !!(python && python.depsComplete && ffmpeg.ok && eng.ready),
  };
}

async function detect(force = false) {
  if (!force && cache && Date.now() - at < 20000) return cache;
  if (inflight) return inflight;
  inflight = build()
    .then((r) => {
      cache = r;
      at = Date.now();
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function invalidate() {
  at = 0;
}

/* --------------------------------------------------- 视频信息（不依赖 Python） */

const { execFile } = require('child_process');

function probeVideo(file) {
  return new Promise((resolve) => {
    const s = store.get();
    let ffprobe = 'ffprobe';
    if (s.ffmpegDir) {
      const d = path.resolve(s.ffmpegDir);
      for (const c of [path.join(d, 'ffprobe.exe'), path.join(d, 'bin', 'ffprobe.exe')]) {
        if (fs.existsSync(c)) {
          ffprobe = c;
          break;
        }
      }
    }
    if (ffprobe === 'ffprobe' && cache && cache.ffmpeg && cache.ffmpeg.dir) {
      const c = path.join(cache.ffmpeg.dir, 'ffprobe.exe');
      if (fs.existsSync(c)) ffprobe = c;
    }
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
    execFile(ffprobe, args, { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      try {
        const j = JSON.parse(stdout);
        const v = (j.streams || []).find((x) => x.codec_type === 'video') || {};
        const a = (j.streams || []).find((x) => x.codec_type === 'audio') || {};
        const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
        resolve({
          ok: true,
          duration: Number(j.format && j.format.duration) || 0,
          size: Number(j.format && j.format.size) || 0,
          width: v.width || 0,
          height: v.height || 0,
          fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
          vcodec: v.codec_name || '',
          acodec: a.codec_name || '',
          hasAudio: !!a.codec_name,
          bitrate: Number(j.format && j.format.bit_rate) || 0,
          format: (j.format && j.format.format_name) || '',
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

/* ------------------------------------------------------------------- 历史 */

function listHistory() {
  const base = store.get().outputDir && store.get().outputDir.trim() ? store.get().outputDir.trim() : P.worksDir;
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    return [];
  }
  for (const name of dirs) {
    const dir = path.join(base, name);
    const bd = path.join(dir, 'breakdown.json');
    if (!fs.existsSync(bd)) continue;
    try {
      const st = fs.statSync(bd);
      let verdict = '';
      let shots = 0;
      let dur = 0;
      let video = name;
      try {
        const j = JSON.parse(fs.readFileSync(bd, 'utf8'));
        verdict = (j.summary && j.summary.verdict) || '';
        shots = (j.summary && j.summary.shots) || (j.shots || []).length;
        dur = (j.source && j.source.duration) || 0;
        video = (j.source && j.source.filename) || name;
      } catch (_) {}
      out.push({
        dir,
        name,
        video,
        verdict,
        shots,
        duration: dur,
        mtime: st.mtimeMs,
        report: fs.existsSync(path.join(dir, 'report.html')) ? path.join(dir, 'report.html') : '',
      });
    } catch (_) {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 100);
}

module.exports = { detect, invalidate, probeVideo, listHistory, vlmStatus };
