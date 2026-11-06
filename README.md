# LinguaGacha-Termux

在 Android 的 Termux 中运行 LinguaGacha，通过浏览器翻译小说、字幕和游戏文本。

本项目基于 [neavo/LinguaGacha](https://github.com/neavo/LinguaGacha)，使用 Termux 原生 Node.js 后端与 React 页面，复用上游的工程、翻译、校对和 Agent 能力。日常运行无需 Electron 或桌面环境，模型使用你配置的在线或本机 API。

## 当前可用能力

- 创建与打开 `.lg` 工程，追加导入，生成工程副本。
- 配置模型、批量翻译、查看进度、取消任务及查看异常中断状态。
- 管理术语表、文本规则与提示词，校对和编辑译文。
- 使用 Agent 对话、工作区脚本与工程写入审批。
- 通过应用内文件选择器浏览 Termux 可访问目录、上传文件或文件夹，下载生成的译文。
- 按需接入本机 Chromium，提供图片处理与 PDF 打印宿主。

|内容|格式|
|---|---|
|小说与文档|TXT、Markdown、EPUB、PDF|
|字幕|SRT、ASS / SSA、VTT、LRC|
|游戏文本|RenPy、KVJSON / MESSAGEJSON、TRANS / WOLF TRANS、XLSX / WOLFXLSX|
|原生游戏目录|RPG Maker MV/MZ、XP/VX/VXAce（RGSS）|

格式支持与验证范围有区别：RGSS 服务级完整闭环、目标平台游戏启动和 Android 系统交互仍有未验项。详细进度、测试结果及边界以 [HANDOFF.md](HANDOFF.md) 为准。

## 安装与启动

以下流程面向 Android ARM64 的 Termux。已有运行证据使用 Node.js `24.18.0`；其它版本尚不据此保证兼容。浏览器构建目标为 Chromium 144，建议使用较新的 Chromium 系浏览器。

在 Termux 中准备 Node.js 与 Git：

```sh
pkg update
pkg install nodejs-lts git
node --version
```

确认 Node.js 为 24 系列后获取源码并构建。以下命令要求所用分支已包含 Web 改造；若克隆后 `package.json` 没有 `build:web`，需先取得包含该实现的分支或源码，不能直接运行上游桌面构建代替：

```sh
git clone --branch termux-port https://github.com/breakyuna/LinguaGacha-Termux.git
cd LinguaGacha-Termux
npm ci
npm run build:web
npm run start:web
```

Android 安装时会自动跳过 Electron 二进制下载，无需使用 `--ignore-scripts`。安装与首次构建需要联网，构建期间需预留内存和磁盘空间。

启动后，终端会打印带一次性凭据的访问地址。在本机浏览器中打开完整地址建立会话；不要分享该链接。默认只监听 `127.0.0.1`，端口随机分配。需要固定端口或数据目录时：

```sh
npm run start:web -- --port=3000 --data-root="$HOME/LinguaGacha"
```

日常启动只需 `npm run start:web`。源码更新后重新构建；`npm run dev:web` 等同于构建后启动，没有热更新开发服务器。前台运行时按 `Ctrl+C` 停止服务，关闭浏览器页面不会停止后端。服务重启后使用终端新打印的地址进入。

### 共享存储

需要从应用内选择器浏览手机共享存储时，先运行并授予系统权限：

```sh
termux-setup-storage
```

也可以直接使用浏览器上传文件。工程打开使用服务端可访问的 `.lg` 路径；浏览器上传源文件不等同于上传并打开工程。文件夹上传依赖浏览器及 Android 文件选择器支持，真机行为仍待完整验收。

### 可选图片与 PDF 宿主

基本文本流程不需要 Chromium。图片处理与 PDF 打印需要本机可执行的 Chromium；服务会查找 `chromium-headless`、`chromium-browser` 等既定位置，也可显式指定：

```sh
LINGUAGACHA_CHROMIUM_PATH=/absolute/path/to/chromium npm run start:web
```

未找到可执行文件时，对应宿主能力按不可用报告。Chromium 的安装方式取决于你的 Termux 软件源；发现可执行文件并不代表已验证该设备上的打印与图片输出。PDF 与图片处理耗用内存较多，低内存设备应先用小样例确认。

## 使用流程

1. 打开启动地址，在模型页面配置 API 地址、凭据与模型。
2. 创建工程，选择或上传源文件，并选择 `.lg` 保存位置。
3. 设置原文和译文语言，按需要配置术语表、文本规则及提示词。
4. 在工作台启动翻译，或让 Agent 协助提取术语、翻译和审校；涉及工程写入时按界面审批。
5. 检查译文后生成输出，从下载清单保存文件。

建议先用一小段材料验证模型和输出。翻译速度与质量取决于模型、网络、材料和设置。

## 数据、备份与更新

默认数据根为 `$HOME/LinguaGacha`，可用 `--data-root` 或环境变量 `LINGUAGACHA_DATA_ROOT` 指定；命令行参数优先。主要内容包括：

|位置|内容|
|---|---|
|`userdata/`|配置、用户预设、技能、Agent 工作区等|
|`userdata/web-imports/`|上传与导出交付暂存|
|`userdata/project-copies/`|生成的工程副本|
|`log/`|运行日志|
|创建工程时选定的位置|`.lg` 工程文件，可能位于数据根之外|

应用提供工程副本，不提供整个数据根的一键备份。运行中需要工程快照时使用工程副本；完整备份前先停止服务，再复制数据根、数据根外的 `.lg` 工程及需要保留的输出。备份可能包含模型凭据和会话材料，应自行妥善保存。

更新代码前结束任务并停止服务、备份数据，确认本地改动已保存，再更新源码、运行 `npm ci` 和 `npm run build:web`，最后启动。`build/web/` 是构建产物，会整体重建，不要把用户数据存入其中。目前没有经过完整验收的 Termux 自动更新流程；旧程序能否读取新版本迁移后的工程需另行确认，回退应保留升级前备份。

## 使用边界

- 本项目面向单用户本机使用；没有多用户隔离或公开部署方案。
- Android 可能回收 Termux 进程。浏览器重连和中断状态恢复不能保证后台任务一直运行，也不代表任务会自动续跑。
- 暂存材料最多同时驻留 64 个，单文件上限 512 MiB，暂存总量上限 2 GiB；这些限制不代表同等规模材料都能在手机内存中完成解析。
- 大 EPUB/PDF 或整目录导入可能因解析内存不足退出，优先选择实际需要的文件并从小样例开始。
- 同数据根多实例会提示冲突，但不会阻止启动；避免同时操作同一数据。
- Android 软键盘、系统文件选择器、下载落地、后台回收和完整工作区权限矩阵仍有待验项，见 [当前交接](HANDOFF.md#7-下一步)。

## 开发与文档

- [开发工作流](docs/WORKFLOW.md)：源码入口、构建和按改动选择验证。
- [架构与专题文档](docs/ARCHITECTURE.md)：后端、前端、CLI、Agent 的设计意图。
- [改造方案](docs/TERMUX_WEB_PLAN.md)：范围、依赖与验收条件。
- [交接与进度](HANDOFF.md)：当前状态与历史验证证据。
- [改造操作标准](docs/TERMUX_WEB_OPERATIONS.md)：专项实施和验收方法。
- [开发 Agent 协作规则](AGENTS.md)。

`npm run dev` 与 `npm run build` 仍是 Electron 桌面入口。Android 类型检查首次需要 Go 1.26 或更新版本，准备方法见 [开发工作流](docs/WORKFLOW.md#termux-web-运行)；运行 Web 产物无需 Go。

其它语言 README 保留上游桌面版本说明，尚未同步本文的 Termux 流程：[English](README_EN.md)、[日本語](README_JA.md)、[한국어](README_KO.md)、[Deutsch](README_DE.md)。

## 上游与反馈

感谢 [LinguaGacha 上游项目](https://github.com/neavo/LinguaGacha)。通用功能教程可参考 [上游 Wiki](https://github.com/neavo/LinguaGacha/wiki)；其中桌面安装、文件操作和更新步骤可能与本项目不同。

沿用上游使用要求：使用 LinguaGacha 的翻译作品，请在作品信息或发布页面注明；涉及商业行为或商业收益，请先联系上游作者获得授权。

Termux 适配问题请提交到 [本项目 Issues](https://github.com/breakyuna/LinguaGacha-Termux/issues)，附 Node.js、Android 和浏览器版本、复现步骤及脱敏日志。不要提交 API 凭据、访问链接或私有原稿。
