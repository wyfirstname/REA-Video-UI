'use strict';
/**
 * 运行环境探测与准备：Python 解释器、ffmpeg、依赖、音轨分离模型。
 *
 * Python 探测是分层的（用户机器上常有多个解释器，IDE 内置的、商店版的、绿色的）：
 *   设置里指定的 → 本应用托管 venv → py 启动器注册的 → PATH → 各盘常见目录
 * 每个候选项都真跑一次 import，优先选依赖齐全的。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { P, venvPython, ensureDirs } = require('./paths');
const store = require('./store');
const log = require('./logger');

const DEPS = ['numpy', 'cv2', 'PIL', 'yaml', 'onnxruntime'];
const OPT_DEPS = ['rapidocr_onnxruntime'];

const PROBE_SCRIPT = [
  'import sys,json',
  'd={"ver":"%d.%d.%d"%sys.version_info[:3],"exe":sys.executable,"deps":{}}',
  'mods=' + JSON.stringify(DEPS.concat(OPT_DEPS)).replace(/"/g, "'"),
  'for m in mods:',
  '    try:',
  '        __import__(m)',
  '        d["deps"][m]=True',
  '    except Exception:',
  '        d["deps"][m]=False',
  'print(json.dumps(d))',
].join('\n');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd || undefined,
        env: opts.env || process.env,
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message) });
    }
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        try {
          child.kill();
        } catch (_) {}
        finish(-2, out, err + '\n[timeout]');
      }
    }, opts.timeout || 20000);
    function finish(code, o, e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: o, stderr: e });
    }
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
      if (opts.onStderr) opts.onStderr(d.toString('utf8'));
    });
    child.on('error', (e) => finish(-1, out, err + String(e.message)));
    child.on('close', (code) => finish(code, out, err));
  });
}

/* ------------------------------------------------------------------ Python */

function listDirs(parent) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name));
  } catch (_) {
    return [];
  }
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function collectCandidates() {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const full = path.resolve(String(p).replace(/^"|"$/g, '').trim());
    if (!/python(\.exe)?$/i.test(full)) return;
    if (!exists(full)) return;
    if (out.some((x) => x.toLowerCase() === full.toLowerCase())) return;
    out.push(full);
  };

  // 1. 设置里指定的
  push(store.get().pythonPath);
  // 2. 本应用托管的 venv
  push(venvPython());
  // 3. 常见安装位置
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Python'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Anaconda3'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'miniconda3'),
    path.join(process.env.USERPROFILE || '', 'anaconda3'),
    path.join(process.env.USERPROFILE || '', 'miniconda3'),
    path.join(process.env.USERPROFILE || '', 'miniforge3'),
    'C:\\', 'D:\\Python', 'E:\\Python', 'D:\\', 'E:\\',
  ];
  for (const root of roots) {
    if (!root || !exists(root)) continue;
    push(path.join(root, 'python.exe'));
    for (const dir of listDirs(root)) {
      const base = path.basename(dir).toLowerCase();
      if (!/^(python|anaconda|miniconda|miniforge)/.test(base)) continue;
      push(path.join(dir, 'python.exe'));
      for (const sub of listDirs(dir)) {
        push(path.join(sub, 'python.exe'));
      }
    }
  }
  return out;
}

async function probePython(p) {
  if (!p || !exists(p)) return null;
  const r = await run(p, ['-c', PROBE_SCRIPT], { timeout: 30000 });
  if (r.code !== 0) {
    return { path: p, ok: false, error: (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || '无法执行' };
  }
  const line = r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{'))
    .pop();
  if (!line) return { path: p, ok: false, error: '无输出' };
  let info;
  try {
    info = JSON.parse(line);
  } catch (_) {
    return { path: p, ok: false, error: '解析失败' };
  }
  const [maj, min] = info.ver.split('.').map(Number);
  const versionOk = maj > 3 || (maj === 3 && min >= 10);
  const missing = DEPS.filter((d) => !info.deps[d]);
  const isManaged = path.resolve(p).toLowerCase() === path.resolve(venvPython()).toLowerCase();
  return {
    path: p,
    ok: versionOk,
    version: info.ver,
    deps: info.deps,
    missing,
    depsComplete: versionOk && missing.length === 0,
    isManaged,
    error: versionOk ? '' : '需要 Python 3.10 或更高版本',
  };
}

async function detectPythons() {
  const cands = collectCandidates().slice(0, 12);
  // 并行探测：每个候选都要真跑一次 import，串行太慢
  const results = await Promise.all(cands.map((c) => probePython(c)));
  return results.filter(Boolean);
}

function pickPython(list) {
  const setting = store.get().pythonPath;
  const byPath = (p) => list.find((x) => x.path.toLowerCase() === String(p || '').toLowerCase());
  if (setting && byPath(setting) && byPath(setting).ok) return byPath(setting);
  const managed = list.find((x) => x.isManaged && x.depsComplete);
  if (managed) return managed;
  const completeNonManaged = list.find((x) => x.depsComplete && !x.isManaged);
  if (completeNonManaged) return completeNonManaged;
  const managedAny = list.find((x) => x.isManaged && x.ok);
  if (managedAny) return managedAny;
  const anyOk = list
    .filter((x) => x.ok)
    .sort((a, b) => (b.version || '').localeCompare(a.version || '', undefined, { numeric: true }))[0];
  return anyOk || null;
}

/* ------------------------------------------------------------------ FFmpeg */

async function detectFfmpeg() {
  const s = store.get();
  const cands = [];
  const dirOk = (d) => exists(path.join(d, 'ffmpeg.exe')) || exists(path.join(d, 'ffmpeg'));
  if (s.ffmpegDir) {
    const d = path.resolve(s.ffmpegDir);
    if (dirOk(d)) cands.push(d);
    else if (dirOk(path.join(d, 'bin'))) cands.push(path.join(d, 'bin'));
  }
  for (const d of ['C:\\ffmpeg\\bin', 'D:\\ffmpeg\\bin', 'E:\\ffmpeg\\bin', 'C:\\tools\\ffmpeg\\bin', path.join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin')]) {
    if (dirOk(d)) cands.push(d);
  }
  for (const d of cands) {
    const exe = path.join(d, 'ffmpeg.exe');
    const r = await run(exists(exe) ? exe : path.join(d, 'ffmpeg'), ['-version'], { timeout: 10000 });
    if (r.code === 0) {
      const m = /ffmpeg version n?(\S+)/.exec(r.stdout);
      return { ok: true, dir: d, path: exe, version: m ? m[1] : '', source: 'dir' };
    }
  }
  const r = await run('ffmpeg', ['-version'], { timeout: 10000 });
  if (r.code === 0) {
    const m = /ffmpeg version n?(\S+)/.exec(r.stdout);
    return { ok: true, dir: '', path: 'ffmpeg', version: m ? m[1] : '', source: 'path' };
  }
  return { ok: false, dir: '', path: '', version: '', source: 'none', error: (r.stderr || '未找到 ffmpeg').trim().split('\n')[0] };
}

/* ------------------------------------------------------------------- 模型 */

/**
 * 上游首次运行时会自己从 GitHub 下载模型，国内网络经常失败（TLS 被拦、超时），
 * 失败后只会静默降级（没有人脸检测 / 没有音轨分离）。所以客户端自己先把模型备好，
 * 走加速镜像下载到 REA_VIDEO_MODELS，上游就会直接用缓存。
 */
const MODELS = [
  {
    key: 'stem',
    name: 'UVR-MDX-NET-Inst_HQ_3.onnx',
    bytes: 66759214,
    label: '人声分离（UVR MDX-Net Inst HQ 3）',
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx',
  },
  {
    key: 'face',
    name: 'face_detection_yunet_2023mar.onnx',
    bytes: 232589,
    label: '人脸检测（YuNet）',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  },
];

const STEM_MODEL = MODELS[0];

function mirrors() {
  const custom = (store.get().mirrorPrefix || '').trim();
  const list = [];
  if (custom) list.push(custom.endsWith('/') ? custom : custom + '/');
  list.push('https://gh-proxy.com/');
  list.push('https://ghfast.top/');
  list.push('https://ghproxy.net/');
  list.push('');
  return list;
}

function modelPath(m) {
  return path.join(P.modelsDir, m.name);
}

function modelReady(m) {
  try {
    return fs.statSync(modelPath(m)).size === m.bytes;
  } catch (_) {
    return false;
  }
}

function modelsReady() {
  return { stem: modelReady(MODELS[0]), face: modelReady(MODELS[1]) };
}

function stemModelReady() {
  return modelReady(STEM_MODEL);
}

function follow(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向过多'));
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(
      url,
      {
        timeout: 60000,
        headers: { 'User-Agent': 'rea-video-desktop' },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return follow(next, dest, onProgress, redirects + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const tmp = dest + '.part';
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const ws = fs.createWriteStream(tmp);
        res.on('data', (c) => {
          got += c.length;
          if (onProgress) onProgress(got, total);
        });
        res.pipe(ws);
        ws.on('finish', () => {
          ws.close(() => {
            try {
              fs.renameSync(tmp, dest);
              resolve({ bytes: got, total });
            } catch (e) {
              reject(e);
            }
          });
        });
        ws.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('下载超时'));
    });
    req.on('error', reject);
  });
}

async function downloadStemModel(onProgress) {
  ensureDirs();
  const results = {};
  for (const m of MODELS) {
    if (modelReady(m)) {
      results[m.key] = true;
      continue;
    }
    const dest = modelPath(m);
    const errors = [];
    let done = false;
    for (const prefix of mirrors()) {
      const url = `${prefix}${m.url}`;
      try {
        log.info('下载模型', url);
        if (onProgress) onProgress({ phase: 'start', key: m.key, label: m.label, url, got: 0, total: m.bytes });
        let lastSent = 0;
        await follow(url, dest, (got, total) => {
          const now = Date.now();
          if (now - lastSent < 400) return;
          lastSent = now;
          onProgress({ phase: 'progress', key: m.key, label: m.label, got, total: total || m.bytes });
        });
        const size = fs.statSync(dest).size;
        if (size !== m.bytes) throw new Error(`文件大小不符（${size} / ${m.bytes}）`);
        if (onProgress) onProgress({ phase: 'file-done', key: m.key, label: m.label });
        done = true;
        break;
      } catch (e) {
        errors.push(`${prefix || 'github'} → ${e.message}`);
        try {
          fs.unlinkSync(dest);
        } catch (_) {}
      }
    }
    results[m.key] = done;
    if (!done) log.error('模型下载失败', m.name, errors.join('；'));
  }
  const ok = Object.values(results).every(Boolean);
  if (onProgress) onProgress({ phase: 'done', ok });
  return ok ? { ok: true, models: modelsReady() } : { ok: false, error: '部分模型下载失败，可稍后重试或手动放进模型目录' };
}

/* ------------------------------------------------------------ 托管环境准备 */

async function createVenv(basePython, onLog) {
  if (exists(venvPython())) return { ok: true, created: false };
  ensureDirs();
  onLog('创建独立运行环境（venv）…');
  const r = await run(basePython, ['-m', 'venv', P.venvDir], { timeout: 180000 });
  if (r.code !== 0 || !exists(venvPython())) {
    return { ok: false, error: (r.stderr || r.stdout || 'venv 创建失败').trim().split('\n').slice(-3).join(' ') };
  }
  return { ok: true, created: true };
}

async function pipInstall(python, onLog) {
  const s = store.get();
  const pkgs = ['numpy', 'opencv-python-headless', 'Pillow', 'PyYAML', 'onnxruntime'];
  if (s.installOcr) pkgs.push('rapidocr-onnxruntime');
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location'];
  if (s.pipIndex) args.push('-i', s.pipIndex);
  args.push(...pkgs);
  onLog(`安装依赖：${pkgs.join(' ')}`);
  onLog(`使用镜像：${s.pipIndex || '官方源'}`);
  const r = await new Promise((resolve) => {
    const child = spawn(python, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let tail = [];
    child.stdout.on('data', (d) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        onLog(line);
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        onLog(line);
      }
    });
    child.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
    child.on('close', (code) => resolve({ code, out: tail.join('\n') }));
  });
  return { ok: r.code === 0, output: r.out };
}

/**
 * 准备一套可用的运行环境：优先复用依赖齐全的解释器；否则建 venv 并装依赖。
 */
async function setup({ forceManaged = false, onLog = () => {} } = {}) {
  const list = await detectPythons();
  let target = null;

  if (!forceManaged) {
    const complete = list.find((x) => x.depsComplete && !x.isManaged);
    if (complete) {
      onLog(`复用已有 Python ${complete.version}：${complete.path}`);
      onLog('依赖已齐全，无需安装。');
      return { ok: true, python: complete, reused: true };
    }
  }

  const base =
    list.find((x) => x.ok && !x.isManaged && /^3\.(1[0-2])\./.test(x.version || '')) ||
    list.find((x) => x.ok && !x.isManaged) ||
    list.find((x) => x.ok);
  if (!base) {
    return { ok: false, error: '未找到 Python 3.10+。请先安装 Python（https://www.python.org/downloads/），安装时勾选 Add to PATH。' };
  }
  onLog(`基准解释器：${base.path}（${base.version}）`);

  const v = await createVenv(base.path, onLog);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.created) onLog('运行环境已创建：' + P.venvDir);

  const pip = await pipInstall(venvPython(), onLog);
  if (!pip.ok) return { ok: false, error: '依赖安装失败，请查看日志' };

  const probed = await probePython(venvPython());
  if (!probed || !probed.ok) return { ok: false, error: '运行环境自检失败：' + ((probed && probed.error) || '未知错误') };
  onLog(`完成：Python ${probed.version}，依赖齐全`);
  return { ok: true, python: probed, reused: false };
}

module.exports = {
  run,
  detectPythons,
  probePython,
  pickPython,
  detectFfmpeg,
  setup,
  downloadStemModel,
  stemModelReady,
  modelsReady,
  MODELS,
  STEM_MODEL,
};
