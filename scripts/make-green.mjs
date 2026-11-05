#!/usr/bin/env node
/**
 * 生成绿色版：把 dist/win-unpacked 复制成独立目录，写入 portable.marker 和说明，
 * 再打成一个 zip。带 marker 时应用会把数据写在 <程序目录>/data，不碰系统盘。
 *
 * 先跑一次 npm run pack 或 npm run dist。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = path.join(root, 'dist', 'win-unpacked');
if (!fs.existsSync(src)) {
  console.error('找不到 dist/win-unpacked，先执行 npm run pack');
  process.exit(1);
}

const name = `REA-Video-Desktop-${pkg.version}`;
const stage = path.join(root, 'dist', 'green', name);
fs.rmSync(path.join(root, 'dist', 'green'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(src, stage, { recursive: true });

fs.writeFileSync(
  path.join(stage, 'portable.marker'),
  '这个文件存在时，REA Video Desktop 会把引擎、Python 环境、模型、输出全部放在本目录的 data/ 下，不写系统盘。\n'
);

fs.writeFileSync(
  path.join(stage, '使用说明.txt'),
  [
    'REA Video Desktop 绿色版',
    '',
    '1) 双击 REA Video Desktop.exe 启动。',
    '2) 首次启动会自检环境，右上角状态条显示 Python / 依赖 / FFmpeg / VLM / 引擎。',
    '3) 缺 Python：装 3.10+（勾选 Add to PATH），再在「运行环境」页点「安装 / 修复依赖」，',
    '   程序会建一个独立 venv（在本目录 data/venv），不影响系统 Python。',
    '4) 缺 FFmpeg：下载 zip 版解压，在「运行环境」页指定 bin 目录。',
    '5) 想用多模态模型：到「设置」填接口地址、API Key、模型名（OpenAI 兼容）。',
    '',
    '数据全部在本目录：',
    '  data/engine   拆解引擎（可在「运行环境」页一键更新到上游最新）',
    '  data/venv     Python 运行环境',
    '  data/models   人声分离等模型',
    '  data/output   拆解结果（report.html 在这里）',
    '  data/logs     日志',
    '',
    '换机器时把整个目录拷走即可；删掉 data/ 等于恢复出厂。',
  ].join('\r\n')
);

const zip = path.join(root, 'dist', `${name}-green.zip`);
fs.rmSync(zip, { force: true });
// 相对路径 + cwd：GNU tar 会把 "E:\..." 当成远程主机
execFileSync('tar', ['-a', '-c', '-f', `dist/${name}-green.zip`, '-C', 'dist/green', name], {
  cwd: root,
  stdio: 'inherit',
});

let bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
};
walk(stage);
console.log(`绿色版目录：${stage}（${(bytes / 1024 / 1024).toFixed(0)} MB）`);
console.log(`绿色版压缩包：${zip}`);
