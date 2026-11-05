'use strict';
/**
 * 端到端自检（只在 RVD_E2E=1 时加载）：
 * 依次跑「准备运行环境 → 拆解一条视频 → 回读结果」，把过程打到控制台。
 * 用于发版前验证打包产物 / 改动是否真的能用，不依赖人手点界面。
 *
 *   set RVD_E2E=1 & set RVD_E2E_VIDEO=D:\x.mp4 & npm start
 */
const fs = require('fs');
const env = require('./env');
const status = require('./status');
const { Runner } = require('./runner');
const engine = require('./engine');
const store = require('./store');
const log = require('./logger');

async function runE2E(app) {
  const video = process.env.RVD_E2E_VIDEO;
  const out = [];
  const say = (s) => {
    out.push(s);
    console.log('[E2E] ' + s);
  };

  if (process.env.RVD_E2E_MODEL === '1') {
    const r = await env.downloadStemModel((p) => {
      if (p.phase === 'progress') console.log(`[model] ${p.key || p.label} ${Math.round((p.got / (p.total || 1)) * 100)}%`);
      else console.log('[model] ' + p.phase + ' ' + (p.url || p.label || ''));
    });
    say('models: ' + JSON.stringify(r));
    app.exit(r.ok ? 0 : 5);
    return;
  }

  if (process.env.RVD_E2E_ENGINE === '1') {
    const check = await engine.checkUpstream();
    say('check: ' + JSON.stringify(check));
    const r = await engine.updateUpstream({
      onLog: (l) => console.log('[engine] ' + l),
      onProgress: (p) => console.log('[engine] ' + Math.round((p.got / (p.total || 1)) * 100) + '%'),
    });
    say('update: ' + JSON.stringify(r));
    app.exit(r.ok ? 0 : 6);
    return;
  }

  say('engine: ' + JSON.stringify(engine.engineInfo()));

  const st0 = await status.detect(true);
  say('before: python=' + (st0.python && st0.python.path) + ' deps=' + (st0.python && st0.python.depsComplete));

  if (!st0.python || !st0.python.depsComplete) {
    say('准备运行环境…');
    const r = await env.setup({ onLog: (line) => console.log('[pip] ' + line) });
    say('setup: ' + JSON.stringify({ ok: r.ok, error: r.error || '', python: r.python && r.python.path }));
    if (!r.ok) {
      app.exit(2);
      return;
    }
    status.invalidate();
  }

  if (!video) {
    say('没有指定 RVD_E2E_VIDEO，跳过拆解');
    app.exit(0);
    return;
  }

  const st = await status.detect(true);
  say('python=' + st.python.path + ' ver=' + st.python.version + ' ffmpeg=' + st.ffmpeg.ok);

  let finished = false;
  const runner = new Runner((channel, ev) => {
    if (ev.type === 'log') {
      console.log('[run] ' + ev.level + ' ' + ev.text);
    } else if (ev.type === 'phase') {
      console.log('[phase] ' + ev.state.phase + ' ' + ev.state.percent + '%');
    } else if (ev.type === 'error') {
      finished = true;
      say('run error: ' + ev.error + ' | ' + (ev.detail || ''));
      app.exit(3);
    } else if (ev.type === 'done') {
      finished = true;
      const r = ev.result;
      say(
        'done: ' +
          JSON.stringify(
            {
              verdict: r.verdict,
              confidence: r.confidence,
              shots: r.shotCount,
              mix: r.mix,
              report: r.reportPath,
              reportExists: fs.existsSync(r.reportPath),
              seconds: r.seconds,
              vlm: r.vlmInfo && r.vlmInfo.status,
            },
            null,
            2
          )
      );
      say('outDir: ' + r.outDir);
      app.exit(0);
    }
  });

  const s = store.get();
  const r = runner.start({
    video,
    python: st.python.path,
    ffmpeg: st.ffmpeg,
    vlm: { baseUrl: s.vlm.baseUrl, models: s.vlm.models, media: s.vlm.media, apiKey: store.apiKey() },
    options: { ...s.opts, useVlm: process.env.RVD_E2E_VLM === '1' },
  });
  say('started: ' + JSON.stringify(r));

  setTimeout(() => {
    if (!finished) {
      say('超时，取消任务');
      runner.cancel();
      app.exit(4);
    }
  }, Number(process.env.RVD_E2E_TIMEOUT || 15 * 60 * 1000));
}

module.exports = { runE2E };
