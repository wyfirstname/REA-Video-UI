'use strict';
/**
 * 拆解引擎（上游 rea-video 的 Python 代码 + skill 文档）的落地与升级。
 *
 * 引擎放在可写的数据目录，而不是安装目录：绿色版/Program Files 下都能升级，
 * 也不需要管理员权限。安装包里带的是只读副本，首次启动时复制过去。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { P, bundledEngineDir } = require('./paths');
const store = require('./store');
const log = require('./logger');

const REPO = 'JuneYaooo/rea-video';
const TARBALL = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
const API_COMMIT = `https://api.github.com/repos/${REPO}/commits?per_page=1`;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(P.engineStateFile, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(P.engineStateFile), { recursive: true });
    fs.writeFileSync(P.engineStateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log.warn('写入引擎状态失败', e.message);
  }
}

function engineReady() {
  return fs.existsSync(path.join(P.engineDir, 'rea_video', 'cli.py'));
}

/** 首次运行：把安装包内的引擎复制到数据目录 */
function ensureEngine() {
  if (engineReady()) return { ok: true, copied: false };
  const src = bundledEngineDir();
  if (!fs.existsSync(path.join(src, 'rea_video', 'cli.py'))) {
    return { ok: false, error: `找不到内置引擎：${src}` };
  }
  try {
    fs.rmSync(P.engineDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(P.engineDir), { recursive: true });
    fs.cpSync(src, P.engineDir, { recursive: true });
    writeState({ ...readState(), source: 'bundled', updatedAt: new Date().toISOString(), version: readState().version || 'bundled' });
    log.info('已把内置引擎复制到', P.engineDir);
    return { ok: true, copied: true };
  } catch (e) {
    log.error('复制引擎失败', e);
    return { ok: false, error: e.message };
  }
}

function engineInfo() {
  const st = readState();
  return {
    dir: P.engineDir,
    ready: engineReady(),
    version: st.version || (st.sha ? String(st.sha).slice(0, 7) : 'bundled'),
    sha: st.sha || '',
    updatedAt: st.updatedAt || '',
    source: st.source || 'bundled',
    bundledDir: bundledEngineDir(),
  };
}

function getJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'rea-video-desktop', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 查上游最新提交，判断要不要升级 */
async function checkUpstream() {
  try {
    const arr = await getJson(API_COMMIT);
    const c = Array.isArray(arr) ? arr[0] : null;
    if (!c) throw new Error('返回格式异常');
    const sha = c.sha;
    const cur = readState();
    return {
      ok: true,
      latest: {
        sha,
        short: String(sha).slice(0, 7),
        date: c.commit && c.commit.committer ? c.commit.committer.date : '',
        message: c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '',
      },
      current: { sha: cur.sha || '', version: cur.version || 'bundled', updatedAt: cur.updatedAt || '' },
      hasUpdate: !cur.sha || cur.sha !== sha,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: opts.env || process.env });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const go = (u, redirects) => {
      if (redirects > 6) return reject(new Error('重定向过多'));
      https
        .get(u, { timeout: 60000, headers: { 'User-Agent': 'rea-video-desktop' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const total = Number(res.headers['content-length'] || 0);
          let got = 0;
          const ws = fs.createWriteStream(dest);
          res.on('data', (c) => {
            got += c.length;
            if (onProgress) onProgress(got, total);
          });
          res.pipe(ws);
          ws.on('finish', () => ws.close(() => resolve({ bytes: got, total })));
          ws.on('error', reject);
        })
        .on('error', reject);
    };
    go(url, 0);
  });
}

function throttle(fn, everyMs = 400) {
  let last = 0;
  let lastPct = -1;
  return (got, total) => {
    const now = Date.now();
    const pct = total ? Math.round((got / total) * 100) : -1;
    if (now - last < everyMs && pct !== 100 && pct !== lastPct) return;
    last = now;
    lastPct = pct;
    fn(got, total);
  };
}

/**
 * 从上游拉最新代码替换本地引擎。先下到临时目录、解压校验通过再替换，
 * 中途失败不会破坏正在用的引擎。
 */
async function updateUpstream({ onLog = () => {}, onProgress = () => {} } = {}) {
  const prefix = (store.get().mirrorPrefix || '').trim();
  const urls = [prefix ? prefix.replace(/\/?$/, '/') + TARBALL : TARBALL, TARBALL, 'https://gh-proxy.com/' + TARBALL, 'https://ghfast.top/' + TARBALL];
  const tmpDir = path.join(P.tmpDir, 'engine-update');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const pkg = path.join(tmpDir, 'engine.tar.gz');

  let lastErr = null;
  let ok = false;
  for (const url of urls) {
    try {
      onLog(`下载引擎：${url}`);
      await download(url, pkg, throttle((got, total) => onProgress({ got, total })));
      const size = fs.statSync(pkg).size;
      if (size < 200 * 1024) throw new Error(`下载内容异常（${size} 字节）`);
      ok = true;
      break;
    } catch (e) {
      lastErr = e;
      onLog(`下载失败：${e.message}，换下一个地址`);
    }
  }
  if (!ok) return { ok: false, error: `下载失败：${lastErr ? lastErr.message : '未知错误'}` };

  onLog('解压…');
  const staging = path.join(tmpDir, 'out');
  fs.mkdirSync(staging, { recursive: true });
  // 传相对路径 + cwd：GNU tar 会把带冒号的 Windows 绝对路径当成远程主机名
  const tar = await run('tar', ['-xzf', 'engine.tar.gz', '-C', 'out', '--strip-components=1'], { cwd: tmpDir });
  if (tar.code !== 0) return { ok: false, error: '解压失败：' + tar.out.slice(-400) };
  if (!fs.existsSync(path.join(staging, 'rea_video', 'cli.py'))) {
    return { ok: false, error: '解压后没有找到 rea_video/cli.py，包结构可能变了' };
  }
  // 案例图片有 80MB+，客户端用不到
  fs.rmSync(path.join(staging, 'docs', 'cases'), { recursive: true, force: true });

  onLog('切换引擎…');
  const backup = path.join(P.tmpDir, 'engine-backup');
  fs.rmSync(backup, { recursive: true, force: true });
  try {
    if (fs.existsSync(P.engineDir)) fs.renameSync(P.engineDir, backup);
  } catch (e) {
    fs.cpSync(P.engineDir, backup, { recursive: true });
    fs.rmSync(P.engineDir, { recursive: true, force: true });
  }
  try {
    fs.renameSync(staging, P.engineDir);
  } catch (e) {
    fs.cpSync(staging, P.engineDir, { recursive: true });
  }

  const check = await checkUpstream();
  const sha = check.ok ? check.latest.sha : '';
  writeState({
    version: sha ? sha.slice(0, 7) : 'custom',
    sha,
    source: 'upstream',
    updatedAt: new Date().toISOString(),
    message: check.ok ? check.latest.message : '',
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  onLog('引擎已更新到最新版本');
  return { ok: true, info: engineInfo() };
}

/** 出问题时回到安装包自带的版本 */
function restoreBundled() {
  const src = bundledEngineDir();
  if (!fs.existsSync(path.join(src, 'rea_video', 'cli.py'))) return { ok: false, error: '安装包内没有内置引擎' };
  try {
    fs.rmSync(P.engineDir, { recursive: true, force: true });
    fs.cpSync(src, P.engineDir, { recursive: true });
    writeState({ version: 'bundled', sha: '', source: 'bundled', updatedAt: new Date().toISOString() });
    return { ok: true, info: engineInfo() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { ensureEngine, engineInfo, checkUpstream, updateUpstream, restoreBundled };
