# REA Video Desktop

把 [rea-video](https://github.com/JuneYaooo/rea-video)（逆向拆解视频：逐镜头判断实拍 / AI 生成 / 3D / 代码渲染，并给出复刻方案）包成 Windows 桌面客户端。

不需要会用命令行：选视频 → 点拆解 → 看报告。拆解计算全部在本机完成，只有开启 VLM 时才把镜头片段发给你自己配置的模型接口。

> 本项目是上游的第三方壳，与上游无隶属关系。上游 Apache-2.0，本客户端同样遵循。

---

## 安装

| 方式 | 适合 | 说明 |
|---|---|---|
| 安装包 `REA-Video-Desktop-Setup-x.y.z.exe` | 普通用户 | 下一步下一步装完，数据在用户目录 |
| 绿色包 `REA-Video-Desktop-x.y.z-green.zip` | 免安装 / 多机拷贝 | 解压即用，数据在程序目录 `data/`，不写系统盘 |
| 源码 | 开发者 | `git clone` 后 `npm install && npm run sync:upstream && npm start` |

无论哪种方式都需要本机有：

- **Python 3.10+**（官方安装包勾选 *Add python.exe to PATH*）。客户端会自动探测，并在「运行环境」页一键建独立 venv 装依赖，不污染系统 Python
- **FFmpeg**（在 PATH 里，或在「运行环境」页指定 bin 目录）
- 可选：一个 OpenAI 兼容的多模态模型（Gemini / GPT-4o / 豆包 / Qwen-VL…），用于逐镜画面复核，不开也能跑，只是实拍/AI/3D 的区分变弱

---

## 界面

- **拆解视频**：四步向导（选视频 → 选项 → 运行 → 结果）。运行页实时翻译 Python 流水线的进度（切镜 / 音轨分离 / 包装层 / 逐镜判定 / 模型复核 / 报告），结束后展示结论、制作构成、逐镜判定表，一键打开 `report.html`
- **历史记录**：数据目录下所有拆解过的视频，可回看报告
- **运行环境**：Python / FFmpeg / 依赖 / 拆解引擎 / 模型 五张卡片，缺什么点什么
- **设置**：VLM 接口（密钥用系统凭据加密存储）、pip 镜像、GitHub 加速前缀、输出目录、更新源
- **关于与更新**：客户端自检、检查更新

## 升级

两条升级线互不依赖：

1. **拆解引擎升级**（上游 rea-video 的新能力）：「运行环境 → 拆解引擎 → 更新到最新」。从 GitHub 拉最新代码替换本地引擎（支持加速前缀），失败自动回滚，随时可「恢复内置版本」
2. **客户端升级**：内置 electron-updater。默认读 `package.json` 里 `build.publish` 的 generic feed（指向 GitHub Releases），也可以在「设置 → 升级 → 更新源」改成任意托管地址

发新版：

```bash
# 1. 改 package.json 的 version
# 2. 配置 GitHub Token（需要 repo 写权限）
set GH_TOKEN=ghp_xxx
npm run publish        # 产物 *.exe / latest.yml / *.blockmap 全部上传
```

老客户端启动时（若开了「启动时检查更新」）会收到提示，一键升级。**latest.yml 和 *.blockmap 必须一起上传**，否则旧版本无法校验和增量下载。

---

## 开发

```bash
npm install              # Electron 38 + electron-builder + electron-updater
npm run sync:upstream    # 拉上游 rea-video 到 vendor/rea-video（打包时进 resources/engine）
npm start                # 开发模式
```

自检工具（发版前跑一遍）：

```bash
# 1) 界面与 preload 打包自检：加载窗口 → 检查 window.api → 打印环境状态
set RVD_SELFTEST=1 && npx electron .

# 2) 端到端：建 venv 装依赖 → 真拆一条视频 → 回读报告
set RVD_E2E=1
set RVD_E2E_VIDEO=E:\path\to\video.mp4
npx electron .

# 3) 界面截图：所有页面渲染成 png 到 <data>/shots
set RVD_SHOT=1
npx electron .
```

打包：

```bash
npm run pack         # 只出 win-unpacked
npm run dist         # NSIS 安装包
npm run dist:green   # 从 win-unpacked 生成绿色 zip（自动加 portable.marker 与使用说明）
npm run dist:all     # 两个都要
```

## 已知坑（都已在代码里处理，改代码前先看）

- **`ELECTRON_RUN_AS_NODE` 污染**：部分终端（尤其是基于 Electron 的 IDE）带这个变量，Electron 会退化成纯 Node。入口第一行已 `delete`，但从这类终端里 `npm start` 仍会在生效前退化——升级 npm 依赖时建议换普通终端跑
- **preload 必须在 `build.files` 白名单里**：漏了它，打包后界面永远停在初始化。主进程已加兜底（弹错误框而不是白屏）
- **GNU tar 把 `E:\...` 当远程主机**：所有 tar 调用统一用「相对路径 + cwd」，不要传盘符绝对路径
- **国内网络**：Electron 二进制走 npmmirror（.npmrc 已配置）；pip 默认清华镜像；上游的模型下载（GitHub 直链经常 TLS 失败）由客户端先用加速镜像备好，跑拆解时上游直接命中缓存；GitHub 加速前缀可在设置里改
- **Python 探测**：用户机器上常有 N 个解释器。探测顺序：设置指定 → 托管 venv → 各盘常见目录，每个候选都真跑一次 `import`，优先选依赖齐全的；IDE 内置解释器不作首选
- **路径全部参数化**：数据根目录 = `REA_VIDEO_DESKTOP_HOME` 环境变量 > 绿色版 `portable.marker`（程序目录 `data/`）> 系统用户目录。代码里没有写死的盘符

## 目录结构

```
main/
  main.js       应用入口：窗口、菜单、IPC 注册、启动自检
  ipc.js        全部 IPC 通道
  runner.js     子进程调度拆解流水线，解析 stderr 进度，回读 breakdown.json
  env.js        Python / FFmpeg 探测、venv 与依赖安装、模型镜像下载
  engine.js     引擎落地与升级（首次复制内置 → 可在线更新 → 可回滚）
  store.js      设置持久化（API Key 走 safeStorage 加密）
  paths.js      所有路径推导（REA_VIDEO_DESKTOP_HOME / portable.marker）
  status.js     环境状态聚合 + ffprobe 视频信息 + 历史记录
  updater.js    electron-updater
  e2e.js        端到端自检（RVD_E2E=1）
  shot.js       界面截图（RVD_SHOT=1）
renderer/       原生 JS 界面（无框架）
preload.js      contextBridge 唯一通道
scripts/        sync-upstream / make-green / make-icon
vendor/rea-video/  上游引擎（sync:upstream 生成，不手改）
```

## 许可

- 上游 rea-video：Apache-2.0（含 NOTICE）
- 本客户端：Apache-2.0
- 请仅对你拥有或已获授权分析的视频使用
