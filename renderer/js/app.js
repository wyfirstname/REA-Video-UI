'use strict';
/* 渲染层逻辑：向导、任务进度、结果渲染、环境与设置页。无框架，纯 DOM。 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const API = window.api;
const S = {
  info: null,
  status: null,
  settings: null,
  video: null,
  probe: null,
  step: 1,
  running: false,
  result: null,
  envBusy: false,
};

const PHASES = [
  { key: 'probe', label: '读取视频' },
  { key: 'shots', label: '切镜' },
  { key: 'stems', label: '音轨分离' },
  { key: 'packaging', label: '包装层' },
  { key: 'classify', label: '逐镜判定' },
  { key: 'vlm', label: '模型复核' },
  { key: 'report', label: '生成报告' },
];

const PALETTE = ['#5b8cff', '#35d399', '#f5b544', '#a78bfa', '#22d3ee', '#fb7185', '#94a3b8', '#facc15'];

/* ------------------------------------------------------------------ utils */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDur(sec) {
  if (!sec && sec !== 0) return '-';
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} 分 ${String(r).padStart(2, '0')} 秒`;
}

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
}

function fmtBytes(n) {
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fileUrl(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  return 'file:///' + norm.split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '');
}

function toast(msg, type = 'info', ms = 3600) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'info' ? '' : type);
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function setStep(n) {
  S.step = n;
  $$('.steps .step').forEach((el) => {
    const k = Number(el.dataset.step);
    el.classList.toggle('active', k === n);
    el.classList.toggle('done', k < n);
  });
  $$('.page-step').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === n));
}

function goPage(p) {
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === 'page-' + p));
  if (p === 'history') loadHistory();
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  if (!API) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:sans-serif;color:#e7eaf1;background:#0c0f14;height:100vh">' +
      '<h2>初始化失败</h2><p style="color:#8b95a8">渲染层没有拿到主进程接口（preload 未加载）。请重新安装完整版本，或联系维护者。</p></div>';
    return;
  }
  bindEvents();
  try {
    S.info = await API.app.info();
    $('#railVersion').textContent = 'v' + S.info.version;
    $('#aboutVer').textContent = `版本 ${S.info.version} · Electron ${S.info.electron} · ${S.info.packaged ? '安装版' : '开发模式'}`;
  } catch (e) {
    toast('读取应用信息失败：' + e.message, 'err');
  }
  await loadSettings();
  await refreshEnv();
  renderRunOpts();
  setStep(1);
  API.task.onEvent(onTaskEvent);
  API.env.onLog(({ line }) => appendEnvLog(line));
  API.env.onModelProgress(onModelProgress);
  API.engine.onLog(({ line }) => appendEnvLog(line));
  API.engine.onProgress(onEngineProgress);
  API.updater.onEvent(onUpdateEvent);
}

/* --------------------------------------------------------------- settings */
async function loadSettings() {
  const r = await API.settings.get();
  S.settings = r.settings;
  S.paths = r.paths;
  renderSettings();
}

function renderSettings() {
  const s = S.settings;
  if (!s) return;
  $('#setBaseUrl').value = s.vlm.baseUrl || '';
  $('#setModels').value = s.vlm.models || '';
  $('#setMedia').value = s.vlm.media || 'both';
  $('#setTimeout').value = s.vlm.timeout || 180;
  $('#keyState').textContent = s.vlm.hasKey ? '已保存密钥（加密存储）' : '未配置密钥';
  $('#setPip').value = s.pipIndex || '';
  $('#setMirror').value = s.mirrorPrefix || '';
  $('#setOut').value = s.outputDir || '';
  $('#setOcr').checked = !!s.installOcr;
  $('#setCheckStart').checked = !!s.updates.checkOnStart;
  $('#setAutoDownload').checked = !!s.updates.autoDownload;
  $('#setFeed').value = s.updates.feedUrl || '';
  $('#outPath').textContent = s.outputDir || (S.paths ? S.paths.worksDir : '');
  $('#dataPaths').innerHTML = [
    ['数据目录', S.paths.dataDir],
    ['引擎', S.paths.engineDir],
    ['运行环境', S.paths.venvDir],
    ['模型', S.paths.modelsDir],
    ['输出', s.outputDir || S.paths.worksDir],
    ['日志', S.paths.mainLog],
  ]
    .map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`)
    .join('');
  if ($('#optVlm')) $('#optVlm').checked = !!s.opts.useVlm;
  if ($('#optPackaging')) $('#optPackaging').checked = !!s.opts.packaging;
  if ($('#optStems')) $('#optStems').checked = !!s.opts.stems;
  if ($('#optOcrLang')) $('#optOcrLang').value = s.opts.ocrLang || 'zh';
  if ($('#optWorkers')) $('#optWorkers').value = s.opts.workers || 3;
  if ($('#optEngine')) $('#optEngine').value = s.opts.engine || '';
}

function renderRunOpts() {
  const s = S.settings;
  if (!s) return;
  const vlmOk = s.vlm.hasKey && s.vlm.baseUrl && s.vlm.models;
  const vlmBox = $('#optVlm');
  vlmBox.checked = !!s.opts.useVlm && !!vlmOk;
  vlmBox.disabled = !vlmOk;
  $('#vlmDesc').textContent = vlmOk
    ? `已配置 ${s.vlm.models} @ ${hostOf(s.vlm.baseUrl)}。开启后每镜送片段+关键帧，判定更准。`
    : '还没配置模型接口，无法开启。去「设置」填接口地址、密钥和模型名后再回来。';
  const stemReady = S.status && S.status.models && S.status.models.stem;
  $('#optStems').checked = !!s.opts.stems && !!stemReady;
  $('#stemsDesc').textContent = stemReady
    ? '已就绪：分离原声 / 干声 / 配乐，用来判断唱还是说、BGM 来源。'
    : '模型未下载（67MB）。可以先去「运行环境」下载，或关掉这一项直接跑。';
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch (_) {
    return u;
  }
}

/* -------------------------------------------------------------------- env */
function setPill(k, state, text) {
  const el = $(`.pill[data-k="${k}"]`);
  if (!el) return;
  el.classList.remove('ok', 'warn', 'err');
  if (state) el.classList.add(state);
  el.innerHTML = `<i></i>${esc(text)}`;
}

async function refreshEnv(force) {
  try {
    const st = await API.env.detect(!!force);
    S.status = st;
    renderEnv();
  } catch (e) {
    toast('环境检测失败：' + e.message, 'err');
  }
}

function renderEnv() {
  const st = S.status;
  if (!st) return;

  // 顶部状态
  const py = st.python;
  setPill('python', py && py.ok ? 'ok' : 'err', py ? `Python ${py.version || ''}` : 'Python 缺失');
  setPill('deps', py && py.depsComplete ? 'ok' : 'warn', py && py.depsComplete ? '依赖就绪' : '依赖待装');
  setPill('ffmpeg', st.ffmpeg.ok ? 'ok' : 'err', st.ffmpeg.ok ? `FFmpeg ${st.ffmpeg.version || ''}`.trim() : 'FFmpeg 缺失');
  setPill('vlm', st.vlm.configured ? 'ok' : 'warn', st.vlm.configured ? 'VLM 已配置' : 'VLM 未配置');
  setPill('engine', st.engineReady ? 'ok' : 'err', '引擎 ' + (st.engine && st.engine.version ? st.engine.version : ''));

  // Python 卡片
  const pyState = $('#pyState');
  if (!py) {
    pyState.className = 'env-state err';
    pyState.textContent = '未找到 Python 3.10+';
    $('#pyDetail').textContent = '请安装 Python 3.10 或更高版本（安装时勾选 Add python.exe to PATH），然后点「安装 / 修复依赖」。';
  } else {
    pyState.className = 'env-state ' + (py.depsComplete ? 'ok' : py.ok ? 'warn' : 'err');
    pyState.textContent = py.depsComplete ? `就绪 · ${py.version}` : py.ok ? `缺依赖 · ${py.version}` : py.error || '不可用';
    const missing = (py.missing || []).join(', ');
    $('#pyDetail').innerHTML =
      esc(py.path) +
      (py.isManaged ? '  <span class="badge">本应用托管</span>' : '') +
      (missing ? `<br>缺少模块：${esc(missing)}` : '');
  }
  const sel = $('#pySelect');
  const cur = py ? py.path : '';
  sel.innerHTML = (st.pythons || [])
    .map((p) => {
      const tag = `${p.version || '?'}${p.depsComplete ? ' · 依赖齐' : p.ok ? ' · 缺依赖' : ' · 不可用'}${p.isManaged ? ' · 托管' : ''}`;
      return `<option value="${esc(p.path)}" ${p.path === cur ? 'selected' : ''}>${esc(tag)} — ${esc(p.path)}</option>`;
    })
    .join('');
  if (!st.pythons || !st.pythons.length) sel.innerHTML = '<option>没有探测到解释器</option>';

  // FFmpeg
  const ff = st.ffmpeg;
  $('#ffState').className = 'env-state ' + (ff.ok ? 'ok' : 'err');
  $('#ffState').textContent = ff.ok ? `就绪 · ${ff.version || ''} · ${ff.source === 'path' ? '来自 PATH' : '自定义目录'}`.trim() : '未找到';
  $('#ffDetail').textContent = ff.ok ? ff.dir || ff.path : '把 ffmpeg.exe 所在目录指过来，或把 ffmpeg 加入系统 PATH。（Windows 构建可从 gyan.dev 或 BtbN 的 releases 下载 zip 版）';

  // 引擎
  const eng = st.engine || {};
  $('#engState').className = 'env-state ' + (st.engineReady ? 'ok' : 'err');
  $('#engState').textContent = st.engineReady ? `就绪 · ${eng.version || ''} · ${eng.source === 'bundled' ? '内置' : '已更新'}` : '未就绪';
  const when = eng.updatedAt ? new Date(eng.updatedAt).toLocaleString() : '';
  $('#engDetail').innerHTML = `${esc(eng.dir || '')}${when ? ' · 更新于 ' + esc(when) : ''}`;

  // 模型
  const md = $('#mdState');
  const mm = (st.models || {});
  if (mm.stem && mm.face) {
    md.className = 'env-state ok';
    md.textContent = '已就绪（人声分离 + 人脸检测）';
  } else if (mm.stem || mm.face) {
    md.className = 'env-state warn';
    md.textContent = '部分就绪' + (mm.stem ? '' : ' · 缺人声分离模型') + (mm.face ? '' : ' · 缺人脸模型');
  } else {
    md.className = 'env-state warn';
    md.textContent = '未下载';
  }
  $('#mdDetail').textContent = `人声分离 UVR MDX-Net 67MB（${mm.stem ? '已就绪' : '缺失'}）· 人脸检测 YuNet 227KB（${mm.face ? '已就绪' : '缺失'}）。上游会用 GitHub 原址下载，国内容易失败，这里走加速镜像。`;

  renderRunOpts();
}

function appendEnvLog(line) {
  const box = $('#envLog');
  if (!box) return;
  box.textContent += (box.textContent ? '\n' : '') + line;
  if (box.textContent.length > 40000) box.textContent = box.textContent.slice(-30000);
  const parent = box.parentElement;
  parent.scrollTop = parent.scrollHeight;
}

let modelProg = null;
function onModelProgress(p) {
  const md = $('#mdState');
  if (!md) return;
  const tag = p.label ? p.label + ' ' : '';
  if (p.phase === 'progress') {
    const pct = p.total ? Math.round((p.got / p.total) * 100) : 0;
    md.className = 'env-state warn';
    md.textContent = `下载 ${tag}${pct}% · ${fmtBytes(p.got)} / ${fmtBytes(p.total)}`;
  } else if (p.phase === 'file-done') {
    appendEnvLog(`模型就绪：${p.label || p.key}`);
  } else if (p.phase === 'done') {
    md.className = 'env-state ' + (p.ok ? 'ok' : 'err');
    md.textContent = p.ok ? '已就绪' : '下载未完成';
    appendEnvLog(p.ok ? '全部模型已就绪' : '部分模型下载失败');
  } else if (p.phase === 'start') {
    appendEnvLog('开始下载：' + p.url);
  }
}

let engProgTimer = null;
function onEngineProgress(p) {
  const el = $('#engState');
  if (!el || !p.total) return;
  const pct = Math.round((p.got / p.total) * 100);
  el.className = 'env-state warn';
  el.textContent = `下载中 ${pct}% · ${fmtBytes(p.got)}`;
  clearTimeout(engProgTimer);
  engProgTimer = setTimeout(() => refreshEnv(true), 800);
}

/* ---------------------------------------------------------------- 任务事件 */
function onTaskEvent(ev) {
  const st = ev.state || {};
  if (ev.type === 'start') {
    S.running = true;
    setStep(3);
    $('#runTitle').textContent = '正在拆解…';
    $('#runSub').textContent = `${st.video || ''} → ${st.outDir || ''}`;
    $('#barFill').style.width = '2%';
    $('#logbox').textContent = '';
    renderPhases(st);
    $('#btnCancel').disabled = false;
  } else if (ev.type === 'phase') {
    renderPhases(st);
    $('#barFill').style.width = Math.max(2, st.percent || 0) + '%';
  } else if (ev.type === 'shot') {
    renderPhases(st);
    $('#barFill').style.width = Math.max(2, st.percent || 0) + '%';
  } else if (ev.type === 'log') {
    appendRunLog(ev.text, ev.level);
    if (st.percent != null) $('#barFill').style.width = Math.max(2, st.percent) + '%';
  } else if (ev.type === 'tick') {
    $('#runSub').textContent = `已用时 ${ev.state.elapsed}s · ${ev.state.phase || ''}`;
  } else if (ev.type === 'done') {
    S.running = false;
    S.result = ev.result;
    $('#barFill').style.width = '100%';
    renderPhases({ ...st, phase: 'report', finished: true });
    renderResult(ev.result);
    setStep(4);
  } else if (ev.type === 'error') {
    S.running = false;
    $('#btnCancel').disabled = true;
    appendRunLog(ev.error + (ev.detail ? '\n' + ev.detail : ''), 'ERROR');
    $('#runTitle').textContent = '拆解失败';
    $('#runSub').textContent = ev.error;
    toast(ev.error, 'err', 6000);
    if (ev.logFile) appendRunLog('完整日志：' + ev.logFile, 'WARNING');
  } else if (ev.type === 'cancelled') {
    S.running = false;
    toast('已取消', 'warn');
    setStep(2);
  }
}

function renderPhases(st) {
  const idx = PHASES.findIndex((p) => p.key === st.phase);
  const vlmOn = st.vlmOn !== false;
  $('#phases').innerHTML = PHASES.map((p, i) => {
    let cls = 'phase';
    if (i < idx || (st.finished && i <= idx)) cls += ' done';
    else if (i === idx) cls += ' active';
    if (p.key === 'vlm' && !vlmOn) return `<span class="phase"><i></i>${p.label}（未启用）</span>`;
    const extra = p.key === 'classify' && st.shotsTotal ? ` ${Math.min(st.shotsDone || 0, st.shotsTotal)}/${st.shotsTotal}` : '';
    return `<span class="${cls}"><i></i>${p.label}${extra}</span>`;
  }).join('');
}

function appendRunLog(text, level) {
  const box = $('#logbox');
  if (!box) return;
  const cls = level === 'ERROR' || level === 'CRITICAL' ? 'l-err' : level === 'WARNING' ? 'l-warn' : '';
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = (text || '') + '\n';
  box.appendChild(span);
  while (box.childNodes.length > 600) box.removeChild(box.firstChild);
  const parent = box.parentElement;
  parent.scrollTop = parent.scrollHeight;
}

/* ------------------------------------------------------------------ 结果页 */
function renderResult(r) {
  const mix = r.mix || [];
  const total = mix.reduce((a, b) => a + (b.seconds || 0), 0) || 1;
  const mixBar = mix
    .map((m, i) => `<span style="width:${((m.seconds || 0) / total) * 100}%;background:${PALETTE[i % PALETTE.length]}"></span>`)
    .join('');
  const legend = mix
    .map(
      (m, i) =>
        `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(m.labelZh || m.label)} ${Math.round((m.ratio || 0) * 100)}%</span>`
    )
    .join('');

  const vlmStatus = (r.vlmInfo && r.vlmInfo.status) || 'off';
  const vlmText =
    vlmStatus === 'ok' ? '已生效' : vlmStatus === 'partial' ? '部分镜头生效' : vlmStatus === 'failed' ? '调用失败（等同未开）' : vlmStatus === 'not_configured' ? '未配置' : '未启用';

  const shots = (r.shots || [])
    .map(
      (s) => `
    <div class="shot">
      <img class="shot-thumb" src="${fileUrl(r.outDir + '/' + s.thumb)}" alt="${esc(s.id)}" loading="lazy" />
      <div class="shot-main">
        <div class="shot-line1">
          <span class="shot-id">#${s.index}</span>
          <span class="shot-label">${esc(s.labelZh)}</span>
          ${s.rule ? `<span class="badge rule">${esc(s.rule)}</span>` : ''}
          <span class="shot-time">${fmtTime(s.start)} – ${fmtTime(s.end)}（${(s.duration || 0).toFixed(2)}s）</span>
        </div>
        <div class="shot-note">${esc(s.verdict || '')}${s.note ? ' · ' + esc(s.note) : ''}</div>
      </div>
      <div class="conf"><b>${s.confidence != null ? Math.round(s.confidence * 100) + '%' : '-'}</b>置信</div>
    </div>`
    )
    .join('');

  const side = [
    ['视频', `${r.source.width || '?'}×${r.source.height || '?'} · ${r.source.fps || '?'}fps · ${fmtDur(r.duration)}`],
    ['镜头', `${r.shotCount} 个 · 平均 ${(r.avgShot || 0).toFixed(2)}s`],
    ['VLM', vlmText],
    ['声音', r.audio && r.audio.bpm ? `${r.audio.bpm} BPM` : r.audio && r.audio.note ? r.audio.note.slice(0, 40) : '—'],
    ['包装', r.packaging ? `字幕 ${r.packaging.subtitleLines} 行 · 贴纸 ${r.packaging.stickers} 处` : '未分析'],
    ['耗时', `${r.seconds}s`],
  ]
    .map(([k, v]) => `<div class="kvrow"><b>${esc(k)}</b><span>${esc(v)}</span></div>`)
    .join('');

  $('#resultRoot').innerHTML = `
    <div class="res-top">
      <div class="res-verdict">
        <div class="label">结论</div>
        <div class="text">${esc(r.verdict || '（无结论）')}</div>
        <div class="mixbar">${mixBar}</div>
        <div class="mix-legend">${legend}</div>
        <div class="res-stats">
          <div class="stat"><div class="v">${r.shotCount}</div><div class="k">镜头</div></div>
          <div class="stat"><div class="v">${r.confidence != null ? Math.round(r.confidence * 100) + '%' : '-'}</div><div class="k">总体置信</div></div>
          <div class="stat"><div class="v">${fmtDur(r.duration)}</div><div class="k">时长</div></div>
        </div>
      </div>
      <div class="res-side">${side}</div>
    </div>

    <div class="actions">
      <button class="btn primary" id="btnOpenReport">打开完整报告</button>
      <button class="btn ghost" id="btnOpenDir">打开输出目录</button>
      <button class="btn ghost" id="btnCopyVerdict">复制结论</button>
      <button class="btn ghost" id="btnNewTask">再拆一条</button>
    </div>
    ${r.vlmNote ? `<div class="hint" style="margin-bottom:6px"><b>复核提示</b>${esc(r.vlmNote)}</div>` : ''}

    <div class="shots-head"><h3>逐镜判定</h3><span class="muted">${rawLink(r)}</span></div>
    <div class="shot-list">${shots || '<div class="empty">没有镜头数据</div>'}</div>
  `;

  $('#btnOpenReport').onclick = async () => {
    const res = await API.report.open(r.reportPath);
    if (!res.ok) toast(res.error || '打开失败', 'err');
  };
  $('#btnOpenDir').onclick = () => API.shell.openPath(r.outDir);
  $('#btnCopyVerdict').onclick = async () => {
    try {
      await navigator.clipboard.writeText(r.verdict + '\n\n' + (r.shots || []).map((s) => `#${s.index} ${fmtTime(s.start)} ${s.labelZh} → ${s.rule}`).join('\n'));
      toast('已复制', 'ok');
    } catch (e) {
      toast('复制失败', 'err');
    }
  };
  $('#btnNewTask').onclick = () => {
    S.video = null;
    S.probe = null;
    $('#filecard').classList.add('hidden');
    $('#dropzone').classList.remove('hidden');
    setStep(1);
  };
}

function rawLink(r) {
  return `<button class="link" id="btnOpenRaw" style="padding:2px 8px;font-size:11px">breakdown.json</button>`;
}

/* ----------------------------------------------------------------- 历史页 */
async function loadHistory() {
  const box = $('#historyList');
  box.innerHTML = '<div class="empty">读取中…</div>';
  const r = await API.history.list();
  const items = r.items || [];
  if (!items.length) {
    box.innerHTML = '<div class="empty">还没有拆解记录。去「拆解视频」跑一条。</div>';
    return;
  }
  box.innerHTML = items
    .map(
      (it) => `
    <div class="hitem">
      <div>
        <div class="h-name">${esc(it.video)}</div>
        <div class="h-verdict">${esc(it.verdict || '（无结论）')}</div>
        <div class="h-meta">${new Date(it.mtime).toLocaleString()} · ${it.shots} 镜 · ${fmtDur(it.duration)}</div>
      </div>
      <div class="h-actions">
        <button class="btn ghost sm" data-act="report" data-p="${esc(it.report)}">报告</button>
        <button class="btn ghost sm" data-act="dir" data-p="${esc(it.dir)}">目录</button>
      </div>
    </div>`
    )
    .join('');
  $$('.hitem button', box).forEach((b) => {
    b.onclick = async () => {
      if (!b.dataset.p) return toast('没有报告文件', 'warn');
      if (b.dataset.act === 'report') {
        const res = await API.report.open(b.dataset.p);
        if (!res.ok) toast(res.error || '打开失败', 'err');
      } else {
        API.shell.openPath(b.dataset.p);
      }
    };
  });
}

/* ------------------------------------------------------------------ 事件绑定 */
function bindEvents() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) goPage(b.dataset.page);
  });

  $('#btnRefreshEnv').onclick = () => refreshEnv(true);
  $('#btnRecheck').onclick = () => refreshEnv(true);

  // 选择视频
  const dz = $('#dropzone');
  dz.onclick = () => pickVideo();
  $('#btnPickVideo').onclick = (e) => {
    e.stopPropagation();
    pickVideo();
  };
  $('#btnChangeVideo').onclick = () => pickVideo();
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = API.pathForFile(f);
    if (!p) return toast('无法读取文件路径，请用「选择视频文件」', 'err');
    setVideo(p);
  });

  $('#btnToStep2').onclick = () => {
    renderRunOpts();
    setStep(2);
  };
  $('#btnBack1').onclick = () => setStep(1);
  $('#btnPickOut').onclick = async () => {
    const r = await API.dialog.pickDir({ title: '选择输出目录', defaultPath: S.settings.outputDir || S.paths.worksDir });
    if (r.ok) {
      await API.settings.patch({ outputDir: r.path });
      await loadSettings();
      toast('输出目录已更新：' + r.path, 'ok');
    }
  };
  $('#btnRun').onclick = startRun;
  $('#btnCancel').onclick = async () => {
    const r = await API.task.cancel();
    if (r.ok) toast('正在取消…', 'warn');
  };

  // 环境页
  $('#btnUsePython').onclick = async () => {
    const p = $('#pySelect').value;
    if (!p) return;
    await API.settings.patch({ pythonPath: p });
    toast('已切换解释器', 'ok');
    await refreshEnv(true);
  };
  $('#btnSetupEnv').onclick = async () => {
    if (S.envBusy) return;
    S.envBusy = true;
    const btn = $('#btnSetupEnv');
    btn.disabled = true;
    btn.textContent = '处理中…';
    appendEnvLog('—— 开始准备运行环境 ——');
    const r = await API.env.setup({ forceManaged: false });
    S.envBusy = false;
    btn.disabled = false;
    btn.textContent = '安装 / 修复依赖';
    if (r.ok) {
      toast('运行环境就绪', 'ok');
      S.status = r.status;
      renderEnv();
    } else {
      toast(r.error || '准备失败', 'err', 7000);
      appendEnvLog('失败：' + (r.error || ''));
    }
  };
  $('#btnPickFfmpeg').onclick = async () => {
    const r = await API.dialog.pickDir({ title: '选择 ffmpeg.exe 所在目录' });
    if (r.ok) {
      await API.settings.patch({ ffmpegDir: r.path });
      await refreshEnv(true);
    }
  };
  $('#btnClearFfmpeg').onclick = async () => {
    await API.settings.patch({ ffmpegDir: '' });
    await refreshEnv(true);
  };
  $('#btnCheckEngine').onclick = async () => {
    const el = $('#engState');
    el.className = 'env-state';
    el.textContent = '检查中…';
    const r = await API.engine.check();
    if (!r.ok) {
      el.className = 'env-state err';
      el.textContent = '检查失败：' + r.error;
      return;
    }
    el.className = 'env-state ' + (r.hasUpdate ? 'warn' : 'ok');
    el.textContent = r.hasUpdate ? `有新版本 ${r.latest.short}（${r.latest.message || ''}）` : '已是最新';
  };
  $('#btnUpdateEngine').onclick = async () => {
    const btn = $('#btnUpdateEngine');
    btn.disabled = true;
    btn.textContent = '更新中…';
    const r = await API.engine.update();
    btn.disabled = false;
    btn.textContent = '更新到最新';
    if (r.ok) {
      toast('引擎已更新', 'ok');
      await refreshEnv(true);
    } else {
      toast(r.error || '更新失败', 'err', 7000);
    }
  };
  $('#btnRestoreEngine').onclick = async () => {
    const r = await API.engine.restore();
    if (r.ok) {
      toast('已恢复内置版本', 'ok');
      await refreshEnv(true);
    } else toast(r.error || '失败', 'err');
  };
  $('#btnModel').onclick = async () => {
    const btn = $('#btnModel');
    btn.disabled = true;
    btn.textContent = '下载中…';
    appendEnvLog('—— 开始下载人声分离模型 ——');
    const r = await API.env.downloadModel();
    btn.disabled = false;
    btn.textContent = '下载模型';
    if (r.ok) {
      toast('模型已就绪', 'ok');
      await refreshEnv(true);
    } else {
      toast('下载失败：' + r.error, 'err', 8000);
    }
  };

  // 设置页
  $('#btnSaveVlm').onclick = async () => {
    const patch = {
      vlm: {
        baseUrl: $('#setBaseUrl').value.trim(),
        models: $('#setModels').value.trim(),
        media: $('#setMedia').value,
        timeout: Number($('#setTimeout').value) || 180,
      },
    };
    await API.settings.patch(patch);
    const key = $('#setKey').value.trim();
    if (key) {
      await API.settings.setKey(key);
      $('#setKey').value = '';
    }
    await loadSettings();
    await refreshEnv(true);
    toast('模型配置已保存', 'ok');
  };
  $('#btnSaveRun').onclick = async () => {
    await API.settings.patch({
      pipIndex: $('#setPip').value.trim(),
      mirrorPrefix: $('#setMirror').value.trim(),
      outputDir: $('#setOut').value.trim(),
      installOcr: $('#setOcr').checked,
    });
    await loadSettings();
    toast('已保存', 'ok');
  };
  $('#btnPickOut2').onclick = async () => {
    const r = await API.dialog.pickDir({ title: '选择输出目录', defaultPath: S.settings.outputDir || S.paths.worksDir });
    if (r.ok) {
      $('#setOut').value = r.path;
      await API.settings.patch({ outputDir: r.path });
      await loadSettings();
    }
  };
  $('#btnSaveUpdate').onclick = async () => {
    await API.settings.patch({
      updates: {
        checkOnStart: $('#setCheckStart').checked,
        autoDownload: $('#setAutoDownload').checked,
        feedUrl: $('#setFeed').value.trim(),
      },
    });
    await loadSettings();
    toast('已保存', 'ok');
  };
  $('#btnOpenData').onclick = () => API.shell.openPath(S.paths.dataDir);

  // 关于页
  $('#btnUpdCheck').onclick = async () => {
    $('#updState').textContent = '检查中…';
    await API.updater.check();
  };
  $('#btnUpdDownload').onclick = async () => {
    const r = await API.updater.download();
    if (!r.ok) toast(r.error || '下载失败', 'err');
  };
  $('#btnUpdInstall').onclick = () => API.updater.install();
  $$('.link[data-url]').forEach((b) => (b.onclick = () => API.shell.openExternal(b.dataset.url)));

  // 结果页的 breakdown.json 快捷键（事件委托）
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'btnOpenRaw' && S.result) {
      API.shell.showItem(S.result.breakdownPath);
    }
  });

  $('#btnRefreshHistory').onclick = loadHistory;
}

/* ------------------------------------------------------------- 选择与启动 */
async function pickVideo() {
  const r = await API.dialog.pickVideo();
  if (r.ok) setVideo(r.path);
}

async function setVideo(p) {
  S.video = p;
  $('#dropzone').classList.add('hidden');
  $('#filecard').classList.remove('hidden');
  $('#fcName').textContent = p.split(/[\\/]/).pop();
  $('#fcPath').textContent = p;
  $('#fcMeta').innerHTML = '<span class="tag">读取信息…</span>';
  const info = await API.media.probe(p);
  S.probe = info;
  if (!info.ok) {
    $('#fcMeta').innerHTML = `<span class="tag" style="color:#f87171">无法读取视频信息：${esc(info.error || '')}</span>`;
    return;
  }
  $('#fcMeta').innerHTML = [
    `${info.width}×${info.height}`,
    `${info.fps} fps`,
    fmtDur(info.duration),
    fmtBytes(info.size),
    info.vcodec,
    info.hasAudio ? info.acodec || '有音轨' : '无音轨',
  ]
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('');
}

async function startRun() {
  if (!S.video) return toast('先选一条视频', 'warn');
  const st = S.status || {};
  if (!st.ready) {
    toast('环境没就绪，去「运行环境」页处理', 'err', 6000);
    goPage('env');
    return;
  }
  const options = {
    useVlm: $('#optVlm').checked,
    packaging: $('#optPackaging').checked,
    stems: $('#optStems').checked,
    ocrLang: $('#optOcrLang').value,
    workers: Number($('#optWorkers').value) || 3,
    engine: $('#optEngine').value.trim(),
    wholeVlm: true,
  };
  await API.settings.patch({
    opts: {
      useVlm: options.useVlm,
      packaging: options.packaging,
      stems: options.stems,
      ocrLang: options.ocrLang,
      workers: options.workers,
      engine: options.engine,
    },
  });
  const r = await API.task.start({ video: S.video, options });
  if (!r.ok) {
    toast(r.error || '启动失败', 'err', 7000);
    return;
  }
  setStep(3);
}

/* ------------------------------------------------------------------ 更新 */
function onUpdateEvent(st) {
  const el = $('#updState');
  if (!el) return;
  el.className = 'upd-state';
  const dl = $('#btnUpdDownload');
  const inst = $('#btnUpdInstall');
  dl.classList.add('hidden');
  inst.classList.add('hidden');
  switch (st.status) {
    case 'checking':
      el.textContent = '检查中…';
      break;
    case 'available':
      el.className = 'upd-state ok';
      el.textContent = `发现新版本 ${st.info.version}，可以下载。`;
      dl.classList.remove('hidden');
      if (S.settings && S.settings.updates.autoDownload) el.textContent += '（已设置为自动下载）';
      break;
    case 'downloading':
      el.textContent = `下载中 ${st.progress ? Math.round(st.progress.percent) : 0}%`;
      break;
    case 'downloaded':
      el.className = 'upd-state ok';
      el.textContent = `新版本 ${st.info.version} 已下载完成，重启即可安装。`;
      inst.classList.remove('hidden');
      break;
    case 'none':
      el.textContent = '已是最新版本。';
      break;
    case 'unsupported':
      el.className = 'upd-state err';
      el.textContent = st.error || '当前环境不支持自动更新。';
      break;
    case 'error':
      el.className = 'upd-state err';
      el.textContent = '更新失败：' + (st.error || '未知错误') + '（国内网络可先设置加速前缀或改用镜像更新源）';
      break;
    default:
      el.textContent = '未检查';
  }
}

document.addEventListener('DOMContentLoaded', boot);

/* 调试/自检用：把内部函数挂到 window，方便截图脚本构造各种状态 */
window.__rvd = {
  S,
  setStep,
  goPage,
  renderResult,
  renderPhases,
  onTaskEvent,
  renderEnv: () => renderEnv(),
};
