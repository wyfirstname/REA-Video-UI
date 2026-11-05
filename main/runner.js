'use strict';
/**
 * 任务调度：把 rea-video 的 Python 流水线当子进程跑，实时解析 stderr 的进度日志，
 * 翻译成界面上的阶段进度，结束后回读 breakdown.json 给界面渲染结论。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { P } = require('./paths');
const store = require('./store');
const log = require('./logger');

const PHASES = [
  { key: 'probe', label: '读取视频与元数据', weight: 5 },
  { key: 'shots', label: '切镜与镜头边界', weight: 10 },
  { key: 'stems', label: '人声 / 配乐分离', weight: 18 },
  { key: 'packaging', label: '剪辑包装层（字幕 / 花字 / 贴纸）', weight: 15 },
  { key: 'classify', label: '逐镜画面判定', weight: 30 },
  { key: 'vlm', label: '多模态模型复核', weight: 15 },
  { key: 'report', label: '生成报告', weight: 7 },
];

const BIN = process.platform === 'win32' ? { py: 'python.exe' } : { py: 'bin/python' };

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

function uniqueOutDir(base, stem) {
  let dir = path.join(base, safeName(stem));
  let i = 2;
  while (fs.existsSync(path.join(dir, 'breakdown.json'))) {
    dir = path.join(base, `${safeName(stem)}-${i++}`);
  }
  return dir;
}

function buildEnv({ ffmpeg, vlm }) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONUNBUFFERED = '1';
  env.REA_VIDEO_HOME = P.memoryDir;
  env.REA_VIDEO_MODELS = P.modelsDir;
  if (ffmpeg && ffmpeg.dir) {
    env.PATH = ffmpeg.dir + path.delimiter + (env.PATH || env.Path || '');
  }
  if (vlm && vlm.baseUrl && vlm.apiKey && vlm.models) {
    env.REA_VLM_BASE_URL = vlm.baseUrl;
    env.REA_VLM_API_KEY = vlm.apiKey;
    env.REA_VLM_MODEL = vlm.models;
    if (vlm.media) env.REA_VLM_MEDIA = vlm.media;
    if (vlm.timeout) env.REA_VLM_TIMEOUT = String(vlm.timeout);
  }
  return env;
}

class Runner {
  constructor(emit) {
    this.emit = emit; // (channel, payload) => void
    this.child = null;
    this.runId = null;
    this.cancelled = false;
  }

  cancel() {
    if (!this.child) return false;
    this.cancelled = true;
    const pid = this.child.pid;
    log.info('取消任务', pid);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGKILL');
      }
    } catch (e) {
      log.warn('取消失败', e.message);
    }
    return true;
  }

  /**
   * @param {object} p {video, python, ffmpeg, vlm, options}
   */
  start(p) {
    const s = store.get();
    const outBase = s.outputDir && s.outputDir.trim() ? s.outputDir.trim() : P.worksDir;
    const stem = path.basename(p.video, path.extname(p.video));
    const outDir = uniqueOutDir(outBase, stem);
    fs.mkdirSync(outDir, { recursive: true });

    const opts = p.options || {};
    const args = ['-m', 'rea_video', 'decompose', p.video, '-o', outDir];
    const vlmOn = !!opts.useVlm && !!(p.vlm && p.vlm.baseUrl && p.vlm.apiKey && p.vlm.models);
    if (vlmOn) {
      args.push('--vlm');
      if (opts.wholeVlm === false) args.push('--no-whole');
    } else args.push('--no-vlm');
    if (opts.ocrLang && opts.ocrLang !== 'zh') args.push('--ocr-lang', opts.ocrLang);
    if (opts.ocr === false) args.push('--no-ocr');
    if (opts.packaging === false) args.push('--no-packaging');
    if (opts.stems === false) args.push('--no-stems');
    if (opts.workers) args.push('--workers', String(opts.workers));
    if (opts.engine) args.push('--engine', String(opts.engine));

    const env = buildEnv({ ffmpeg: p.ffmpeg, vlm: p.vlm });
    const runId = `${Date.now().toString(36)}`;
    this.runId = runId;

    const runLog = path.join(P.logDir, `run-${safeName(stem)}-${runId}.log`);
    let logStream = null;
    try {
      logStream = fs.createWriteStream(runLog, { flags: 'a' });
    } catch (_) {}

    const state = {
      runId,
      outDir,
      video: p.video,
      phase: 'probe',
      shotsDone: 0,
      shotsTotal: 0,
      percent: 0,
      startedAt: Date.now(),
      finished: false,
      cancelled: false,
      vlmOn,
    };
    log.info('启动任务', { video: p.video, outDir, vlmOn });
    log.info('命令', [p.python, ...args].join(' '));

    this.emit('task:event', { type: 'start', state });

    let stdout = '';
    let stderrBuf = '';
    let tick = null;
    let child;
    try {
      child = spawn(p.python, args, {
        cwd: P.engineDir,
        env: { ...env, PYTHONPATH: P.engineDir },
        windowsHide: true,
      });
    } catch (e) {
      this.emit('task:event', { type: 'error', state, error: '无法启动 Python：' + e.message });
      return { ok: false, runId, error: e.message };
    }
    this.child = child;

    const setPercent = () => {
      const idx = PHASES.findIndex((x) => x.key === state.phase);
      let done = 0;
      for (let i = 0; i < idx; i++) done += PHASES[i].weight;
      let within = 0;
      const cur = PHASES[idx];
      if (cur && cur.key === 'classify' && state.shotsTotal) {
        within = cur.weight * Math.min(1, state.shotsDone / state.shotsTotal);
      }
      state.percent = Math.min(99, Math.round(done + within));
    };
    const bump = (phaseKey) => {
      if (state.phase === phaseKey) return;
      state.phase = phaseKey;
      setPercent();
      this.emit('task:event', { type: 'phase', state: { ...state } });
    };

    const handleLine = (line) => {
      if (!line) return;
      const m = /^\d{2}:\d{2}:\d{2}\s+(INFO|WARNING|ERROR|DEBUG|CRITICAL)\s+(.*)$/.exec(line);
      const level = m ? m[1] : 'INFO';
      const msg = m ? m[2] : line;

      if (/^video\s/.test(msg)) {
        bump('shots');
        const v = /^video\s+(\S+)\s+(\d+)x(\d+)\s+([\d.]+)fps\s+([\d.]+)s/.exec(msg);
        if (v) {
          state.width = Number(v[2]);
          state.height = Number(v[3]);
          state.fps = Number(v[4]);
          state.duration = Number(v[5]);
        }
      }
      let mm;
      if ((mm = /^detected\s+(\d+)\s+shots/.exec(msg))) {
        state.shotsTotal = Number(mm[1]);
        bump('stems');
      }
      if (/^separating stems/.test(msg)) bump('stems');
      if (/^packaging layer/.test(msg)) bump('packaging');
      if ((mm = /^(shot_\d+)\s+([\d:.]+)-([\d:.]+)\s+det=(\w+)\((\d+)%\)\s*(.*)$/.exec(msg))) {
        if (state.phase !== 'classify') bump('classify');
        state.shotsDone += 1;
        this.emit('task:event', {
          type: 'shot',
          state: { ...state },
          shot: { id: mm[1], start: mm[2], end: mm[3], label: mm[4], conf: Number(mm[5]) / 100, note: mm[6] },
        });
      }
      if (/^done in\s+([\d.]+)s/.test(msg)) bump('report');
      if (level === 'WARNING' || level === 'ERROR' || level === 'CRITICAL') {
        state.lastWarning = msg;
      }
      setPercent();
      this.emit('task:event', { type: 'log', state: { ...state }, level, text: msg });
      if (logStream) logStream.write(`${line}\n`);
    };

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
      const parts = stderrBuf.split(/\r?\n/);
      stderrBuf = parts.pop();
      for (const line of parts) handleLine(line);
    });

    child.on('error', (e) => {
      this.emit('task:event', { type: 'error', state, error: `进程启动失败：${e.message}` });
    });

    child.on('close', async (code) => {
      if (tick) clearInterval(tick);
      if (stderrBuf) handleLine(stderrBuf);
      this.child = null;
      state.finished = true;
      state.code = code;
      state.cancelled = this.cancelled;
      if (logStream) {
        logStream.end();
      }
      if (this.cancelled) {
        this.emit('task:event', { type: 'cancelled', state });
        return;
      }
      if (code !== 0) {
        const tail = stderrBuf.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
        this.emit('task:event', {
          type: 'error',
          state,
          error: `拆解失败（退出码 ${code}）`,
          detail: tail || stdout.slice(-800),
          logFile: runLog,
        });
        return;
      }
      state.percent = 100;
      // stdout 最后是 pretty-print 的 JSON
      let summary = null;
      try {
        const start = stdout.indexOf('{');
        if (start >= 0) summary = JSON.parse(stdout.slice(start));
      } catch (e) {
        log.warn('解析 stdout JSON 失败', e.message);
      }
      const result = this.collect(outDir, summary, state);
      if (!result.ok) {
        this.emit('task:event', { type: 'error', state, error: result.error, logFile: runLog });
        return;
      }
      this.emit('task:event', { type: 'done', state, result });
    });

    tick = setInterval(() => {
      if (state.finished) return;
      this.emit('task:event', { type: 'tick', state: { ...state, elapsed: Math.round((Date.now() - state.startedAt) / 1000) } });
    }, 1000);
    if (tick.unref) tick.unref();

    return { ok: true, runId, outDir };
  }

  /** 把 breakdown.json 提炼成界面要用的紧凑结构 */
  collect(outDir, summary, state) {
    const bdPath = path.join(outDir, 'breakdown.json');
    if (!fs.existsSync(bdPath)) return { ok: false, error: '没有生成 breakdown.json' };
    let bd;
    try {
      bd = JSON.parse(fs.readFileSync(bdPath, 'utf8'));
    } catch (e) {
      return { ok: false, error: 'breakdown.json 解析失败：' + e.message };
    }
    const s = bd.summary || {};
    const shots = (bd.shots || []).map((s2) => {
      const base = s2.base || {};
      return {
        id: s2.id,
        index: s2.index,
        start: s2.start,
        end: s2.end,
        duration: s2.duration,
        label: base.label || '',
        labelZh: base.label_zh || base.label || '',
        confidence: base.confidence != null ? base.confidence : null,
        verdict: s2.verdict || '',
        rule: (s2.replication && s2.replication.rule) || '',
        route: (s2.replication && s2.replication.route) || [],
        candidates: ((s2.replication && s2.replication.candidates) || []).map((c) => c.name).slice(0, 4),
        note: (s2.replication && s2.replication.note) || '',
        evidence: (base.evidence || []).slice(0, 3),
        vlm: s2.vlm ? { label: s2.vlm.label || '', note: s2.vlm.note || s2.vlm.reason || '' } : null,
        thumb: `shots/${s2.id}.jpg`,
        firstFrame: `shots/${s2.id}_first.jpg`,
      };
    });
    return {
      ok: true,
      runId: state.runId,
      outDir,
      video: bd.source ? bd.source.filename : '',
      source: bd.source || {},
      verdict: s.verdict || (summary && summary.verdict) || '',
      confidence: s.confidence != null ? s.confidence : null,
      shotCount: s.shots || shots.length,
      duration: s.duration || (bd.source && bd.source.duration) || 0,
      mix: (s.production_mix || []).map((m) => ({ label: m.label, labelZh: m.label_zh, seconds: m.seconds, ratio: m.ratio })),
      overlays: s.overlay_kinds || [],
      transitions: s.transitions || {},
      avgShot: s.avg_shot_s || 0,
      realMaterial: s.real_material || {},
      vlmNote: s.vlm || '',
      vlmInfo: (bd.analysis && bd.analysis.vlm) || {},
      audio: {
        bpm: bd.audio && bd.audio.bpm,
        note: (bd.audio && (bd.audio.summary || bd.audio.note)) || '',
        stems: bd.stems || {},
      },
      soundSources: (bd.sound_sources && bd.sound_sources.items) || bd.sound_sources || [],
      packaging: bd.packaging
        ? {
            subtitleLines: (bd.packaging.subtitles && bd.packaging.subtitles.lines && bd.packaging.subtitles.lines.length) || 0,
            stickers: (bd.packaging.stickers && bd.packaging.stickers.length) || 0,
          }
        : null,
      productionPlan: bd.production_plan || null,
      shots,
      reportPath: path.join(outDir, 'report.html'),
      reportMd: path.join(outDir, 'report.md'),
      breakdownPath: bdPath,
      storyboard: fs.existsSync(path.join(outDir, 'storyboard.jpg')) ? path.join(outDir, 'storyboard.jpg') : '',
      seconds: (bd.analysis && bd.analysis.seconds) || 0,
    };
  }
}

module.exports = { Runner, PHASES, buildEnv };
