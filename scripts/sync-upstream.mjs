#!/usr/bin/env node
/**
 * 把上游 rea-video 拉下来放到 vendor/rea-video，打包时整体塞进安装包。
 * 只保留运行时真正需要的部分（docs/cases 有 80MB+ 的案例图，客户端用不到）。
 *
 *   node scripts/sync-upstream.mjs [--ref main]
 *   GITHUB_MIRROR=https://gh-proxy.com/ node scripts/sync-upstream.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor', 'rea-video');
const cache = path.join(root, 'vendor', '.cache');

const REPO = 'JuneYaooo/rea-video';
const ref = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : 'main';
const mirror = process.env.GITHUB_MIRROR || '';
const urls = [
  `${mirror}https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}`,
  `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${ref}`,
  `https://gh-proxy.com/https://github.com/${REPO}/archive/refs/heads/${ref}.tar.gz`,
  `https://ghfast.top/https://github.com/${REPO}/archive/refs/heads/${ref}.tar.gz`,
].filter(Boolean);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

async function download() {
  fs.mkdirSync(cache, { recursive: true });
  const out = path.join(cache, 'upstream.tar.gz');
  for (const url of urls) {
    try {
      process.stdout.write(`下载 ${url}\n`);
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'rea-video-desktop' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200 * 1024) throw new Error('内容过小：' + buf.length);
      fs.writeFileSync(out, buf);
      console.log(`已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
      return out;
    } catch (e) {
      console.warn(`  失败：${e.message}`);
    }
  }
  throw new Error('所有下载地址都失败了，可以用 GITHUB_MIRROR 指定加速前缀');
}

const tarFile = await download();
rmrf(vendor);
fs.mkdirSync(vendor, { recursive: true });
execFileSync('tar', ['-xzf', 'vendor/.cache/upstream.tar.gz', '-C', 'vendor/rea-video', '--strip-components=1'], {
  cwd: root,
  stdio: 'inherit',
});
rmrf(path.join(vendor, 'docs', 'cases'));
rmrf(path.join(vendor, 'eval'));
rmrf(path.join(vendor, 'tests'));
rmrf(path.join(vendor, '.github'));
for (const junk of ['AGENTS.md', 'CLAUDE.md', 'README_en.md', 'README_ja.md']) {
  rmrf(path.join(vendor, junk));
}

const cli = path.join(vendor, 'rea_video', 'cli.py');
if (!fs.existsSync(cli)) {
  console.error('解压后没有 rea_video/cli.py，包结构可能变了');
  process.exit(1);
}
/** 拿当前提交号：优先用 GitHub API（国内可通），git ls-remote 兜底，都没有就留空 */
async function resolveSha() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=1`, {
      headers: { 'User-Agent': 'rea-video-desktop', Accept: 'application/vnd.github+json' },
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j[0] && j[0].sha) return j[0].sha;
    }
  } catch (_) {}
  try {
    return execFileSync('git', ['ls-remote', `https://github.com/${REPO}`, `refs/heads/${ref}`], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)[0];
  } catch (_) {
    return '';
  }
}

const sha = await resolveSha();
fs.writeFileSync(
  path.join(vendor, '.upstream.json'),
  JSON.stringify({ repo: REPO, ref, sha: sha || '', syncedAt: new Date().toISOString() }, null, 2)
);
let bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
};
walk(vendor);
console.log(`vendor/rea-video 就绪：${(bytes / 1024 / 1024).toFixed(2)} MB，提交 ${sha ? sha.slice(0, 7) : '未知'}`);
