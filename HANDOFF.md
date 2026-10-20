# Termux Web 改造交接与进度

最后更新：2026-10-20（文档整理：重写 Termux README，合并当前结论，修正过期风险与操作入口；未重新运行产品验证，见 `V-028`）。

- 目标与验收：[完整修改方案](docs/TERMUX_WEB_PLAN.md)。
- 实施与验证：[操作标准](docs/TERMUX_WEB_OPERATIONS.md)。
- 仓库规则：[AGENTS](AGENTS.md)。

本文是本次改造进度的唯一记录入口。新一轮开始先核对代码和工作区，再更新状态；日期、环境与旧验证结果不能作为未来运行环境的保证。

## 1. 当前交接结论

- 方向：单用户本地 Web 应用，Termux 原生 Node.js 后端，同源 React 页面、HTTP API 与 SSE。Web 是独立入口，共享既有后端业务能力；当前设计见 [ARCHITECTURE](docs/ARCHITECTURE.md)，用户操作见 [README](README.md)。
- 范围：以小说翻译为核心；游戏文本与字幕已于 2026-10-19 解除冻结，适用格式闭环见 `V-027`。RGSS 服务级完整闭环及目标平台游戏启动仍为范围外，精确边界见方案 1.1。
- 已落地：Web 构建与仓库外运行、访问会话与同源门禁、浏览器宿主桥、文件上传与目录浏览、工程及副本、翻译受理与下载、Agent 工作区及审批、手机布局、Chromium 图片/PDF 宿主。任务状态统一见第 3 节，不以局部验证代替整项完成。
- 主要运行证据：文件与任务恢复 `V-009` / `V-011`；Agent 工具链 `V-016`；Android 类型检查 `V-017`；宿主输出、视觉与异常收尾 `V-018` 至 `V-020`；仓库外依赖加载 `V-021`；EPUB 与保存桥接 `V-022` / `V-023`；真实供应商有界样例、工程副本恢复与多实例提示 `V-024`；长任务、worker 部署、安全修复与移动端选择器 `V-025`；字幕与游戏文本闭环 `V-027`。
- 长任务证据（`V-025`）：整体探针 31/31，12000 条翻译完成并逐行核对，翻译段约 21.5 分钟，work-unit 与 planning worker 从仓库外加载。该结果不保证 Android 锁屏与后台长期存活。
- 全量测试基线（`V-025`）：node 2883 通过 / 9 失败 / 2 跳过；renderer 1179 通过 / 2 失败。环境依赖与单独复跑通过的负载抖动分别记录于原验证项，不能称为全量测试全绿；后续 `V-027` 为相关范围回归。
- 主要未决：Android 系统交互与后台回收、Agent 完整权限拒绝矩阵及长任务恢复、真实网络下代理与认证回调、Termux 更新流程。完整下一步见第 7 节。
- 当前里程碑：`M1` 技术路径成立，`M2` 核心业务闭环已有证据；`M3` 与 `M4` 尚未完整验收。文档整理不改变任务完成状态。

## 2. 基线与已知证据

2026-10-20 本地核对：`HEAD` 为 `2a36b113`；工作区仍有后续产品代码、测试、验证脚本与文档的未提交改动。`origin` 指向本 fork，本地 `origin/main` 引用为 `6f2c40c9`；本轮未 fetch，不据此声明远端即时状态。开始工作先运行 `git status --short`，保留无关改动；未获提交或推送指令时不创建提交或推送。

|项目|2026-10-17 至 18 的观察|边界|
|---|---|---|
|当前工作区|`/data/data/com.termux/files/home/LinguaGacha-Termux`|本机路径，不写入产品运行配置|
|Node|`v24.18.0`，`android / arm64`，`sqlite 3.53.4`|后续安装前重新核对|
|仓库依赖|`npm install --ignore-scripts` 装入 1154 包；`mupdf`、`@ruby/prism`、`oxc-parser`、`hono`、`vite`、`vitest`、`jszip`、`exceljs`、`undici` 等全部加载成功|未验证真实工程迁移与完整 Agent 边界|
|TypeScript|官方 npm 包仍无 Android 预编译程序；本机已从 `7.0.2` 对应源码构建 Android 原生编译器，全部引用项目通过（`V-017`）|首次需要 Go 1.26 或更新版本；源码版本、SHA256 与平台补丁由 `buildtools/typecheck.mjs` 固定|
|构建|`npm run build:web` 通过：Node 服务入口、4 个 worker 入口、渲染产物、工作区运行目录、`builtin` 与 `version.txt` 全部落盘|仓库外干净目录启动与运行依赖真实加载已于 `V-021` 验证|
|浏览器工具|`chromium-headless` 与 `html-screenshot` 可用；Playwright Core 已实际驱动产品页面|图片/PDF 宿主另见 `V-018` 至 `V-020`；不代替 Android 系统交互|

上表汇总历史环境证据，不能作为新环境保证。Web 当前使用同源门禁、`read_host_bridge()` 与 Chromium 宿主；Electron 桌面入口仍保留。设计意图与源码入口分别见 [ARCHITECTURE](docs/ARCHITECTURE.md) 和 [WORKFLOW](docs/WORKFLOW.md)。

## 3. 任务总表

状态含义遵循操作标准。子项未全部验收时，不把整项标为完成。

|任务|范围|状态|证据 / 剩余工作|
|---|---|---|---|
|`TW-00`|执行材料与规则入口|完成|三文档和 `AGENTS.md` 已写入，文档验收见 `V-002`|
|`TW-01`|依赖与运行环境|完成|安装与模块加载见 `V-003`；Android 原生 TypeScript 7 本机全量检查见 `V-017`，R-01 已解除|
|`TW-02`|Web 服务与组合根|完成|干净目录启动、端口冲突、重型计算压测（翻译期间 API 同量级响应）已验（`V-009`、`V-011`）；仓库外部署与运行依赖真实加载（`V-021`）；同数据根多开冲突被检测、终态一致（`V-021`）；**同数据根第二实例提示（R-13 决策 B）已实现并经真实双实例验证 11/11（`V-024`）**|
|`TW-03`|同源服务与访问会话|进行中|下载鉴权边界已验（`V-008`、`V-009`）；Node 代理不影响回环服务已验；代理对真实模型认证回调的影响未验|
|`TW-04`|浏览器启动与桌面能力迁移|进行中|启动、设置、模型、日志与刷新恢复见 `V-005`；文件选择类能力已由选择器接线（`TW-05`）；更新源已改指本 fork；`V-024` 记录 fork 无 releases 时检查为空，Web 更新桥回退发布页；完整更新流程及真实浏览器新标签行为仍未验|
|`TW-05`|工程库与文件流程|进行中|上传→建工程、副本下载、术语表导出→导入、工作台追加导入、**文件夹上传保留相对结构**均 PASS（`V-009`、`V-011`）；**EPUB 经浏览器走完导入到导出闭环并校验下载内容**（`V-022`）；**R-12 决策 C 已实现并经浏览器复验（切语言后清单含各语言文件、旧语言目录 HTTP 200，`V-024`、`V-025`）**；**字幕浏览器级翻译闭环完成（SRT/VTT 经选择器上传→翻译→下载，22/22，`V-027`）**；R-15 决策维持 64 上限（小说一本一本上传，64 绰绰有余）；单批 >64 文件需分批|
|`TW-06`|任务与恢复|进行中|命令身份去重、崩溃恢复、受理与页面分离、**多标签页 SSE 同步**已验（`V-009`、`V-011`）|
|`TW-07`|文本 Agent|进行中|保存位置桥接已验（`V-012`）；R-17 已解除，真实本地 HTTP 模型驱动的材料/附件上传、受限脚本、写入审批、取消与 SSE 重连已验（`V-016`）；宿主能力对模型可见说明的如实投影已落地（`V-019`）；无浏览器时的保存位置驻留、领取与断线恢复已浏览器级取证（`V-023`）；**真实供应商（StepFun coding plan）有界样例通过：翻译 6/6 行 + 真实 Agent 对话（`V-024`）**；完整工作区权限矩阵与长任务恢复仍未验证|
|`TW-08`|手机界面|进行中|布局、抽屉、表格滚动、安全区、15 页矩阵、**触屏热区细节（移除按钮/行操作/共享控件/队列重排）**已验（`V-008`、`V-009`、`V-011`）；Android 真机未验|
|`TW-09`|图片与 PDF|进行中|Chromium 宿主实现与运行态能力报告已验（`V-014`）；`emitImage`（`image/webp` 24×16）与 `host({kind:"print_pdf"})`（`%PDF-` 57753 字节）经 Agent 工作区端到端已验（`V-018`）；**PDF 版面与图片输出的人工视觉查看已完成，并修复 `data:` 内嵌资源被网络拦截清单一并拦掉的缺陷**（`V-019`）；**崩溃 / 超时 / 取消的真实 Chromium 证据已补齐，含进程与 profile 回收**（`V-020`）；**宿主峰值资源已记录（R-07 解除：图片任务峰值 RSS ~1135MB / PDF ~1750-1880MB，PSS 口径 ~359 / ~701MB，停止零残留，`V-024`）**；Android 真机未验|
|`TW-10`|格式兼容回归|进行中|全格式导入矩阵已建并 PASS（`V-013`）；**旧 `.lg` 小说工程副本回归已完成（`V-024`）**；**冻结解除后：字幕 5 格式、MV/MZ 游戏目录（含导出容器回灌）、RenPy / KVJSON / MESSAGEJSON / TRANS / WOLF TRANS / XLSX / WOLFXLSX 的服务级翻译闭环全部完成（51/51 × 2，`V-027`）**；RGSS 服务级闭环仍为范围外（Marshal 夹具复杂度，导入 `V-013` + 导出写回格式层测试已覆盖）；目标平台游戏启动以导出容器回灌替代|
|`TW-11`|部署与运行验收|进行中|干净安装已验（`V-009`）；**备份恢复已验证：产品无数据根整包备份（仅工程副本），副本恢复与运维等价流程均一致（24/24×3，`V-024`）**；**30 分钟长任务 + 翻译 worker 仓库外加载已完成（31/31 PASS，`V-025`）**；更新流程未做（Termux 无发布产物的产品决策）|

## 4. 各轮完成内容与修改范围

规划轮产物：

|文件|作用|
|---|---|
|`docs/TERMUX_WEB_PLAN.md`|完整目标、责任边界、12 项任务及里程碑验收|
|`docs/TERMUX_WEB_OPERATIONS.md`|实施步骤、命令状态、验证矩阵与交接标准|
|`HANDOFF.md`|基线、任务状态、证据、未决事项和下一步|
|`AGENTS.md`|要求改造工作按三份文档执行及同步更新|

实现轮新增（后端与传输）：

|文件|作用|
|---|---|
|`src/web/web-entry.ts`、`src/web/web-server-main.ts`|Termux Node 入口：参数解析、路径注入、宿主端口、信号接管|
|`src/backend/api/web-access-session.ts`|一次性启动凭据换 HttpOnly 会话 Cookie，服务停止即失效|
|`src/backend/api/web-static-assets.ts`|同源静态资源、MIME、缓存与 SPA 回退，路径收敛在资源根内|
|`src/backend/api/api-gateway-server.ts`|Web 传输选项：显式端口、Host / Origin 校验、会话门禁、静态资源、启动配置内联|
|`src/backend/api/api-routes.ts`|`/api/web/session`、`/api/web/bootstrap`|
|`src/backend/network/node-system-proxy-resolver.ts`|Node 运行态按环境变量解析系统代理|
|`src/backend/app/app-path-service.ts`、`backend-resources.ts`、`gui-backend-bootstrap.ts`|显式数据根与 Web 传输配置注入|
|`src/shared/backend-api.ts`、`src/shared/error/app-error.ts`|会话 Cookie 名契约；`request.unauthorized`、`request.forbidden_origin` 错误码|
|`buildtools/build-web.mjs`、`buildtools/install-electron.mjs`|Web 构建编排；Android 与显式开关跳过 Electron 二进制下载|
|`src/backend/file/web-file-service.ts`|Web 文件能力：允许根浏览、流式上传暂存、受控下载、材料生命周期|
|`src/backend/api/api-routes.ts`|`/api/web/files/*` 六个路径，桌面入口按能力缺失回答|
|`package.json`|`build:web`、`start:web`、`dev:web` 脚本|

第三轮新增（后端文件闭环与手机布局）：

|文件|作用|
|---|---|
|`src/backend/file/web-import-materials.ts`|暂存材料解析为导入路径/命令、导出交付（`stage_existing_file`）、批量释放|
|`src/backend/file/path-boundary.ts`|受控下载边界的路径包含判断，Web 文件服务与译文生成共用|
|`src/backend/project/project-copy-service.ts`|工程副本：`VACUUM INTO` 一致性快照落入 `<userdata>/project-copies/`|
|`src/backend/api/api-routes.ts`|`material_ids` / `materials` / `material_id` / `material` 契约；`/api/session/project/copy`、`/api/translation/files/download`|
|`src/backend/api/api-gateway-server.ts`|Web 启动配置标题栏高度改报 40（与桌面契约一致）|
|`src/backend/database/database-operations.ts`|`copy_snapshot_to`：只读源连接的一致性快照复制|
|`src/frontend/app/shell/use-narrow-viewport.ts`|窄视口判定 hook（767px 断点，抽屉与并排共用）|
|`src/frontend/app/shell/app-sidebar.tsx` 等壳层文件|窄视口 Sheet 抽屉、`min-width: 0`、dvh 视口单位、根侧栏宽度 token|

第三轮后半程新增（前端闭环、TW-06 与矩阵收尾）：

|文件|作用|
|---|---|
|`src/frontend/features/web-file-picker/`（8 文件）|选择器请求总线、三模式对话框（浏览/上传/保存命名）、宿主组件、受控下载助手|
|`src/frontend/app/session/batch-translation/batch-translation-start-command.ts`|翻译受理命令身份生成与重试复用|
|`src/frontend/widgets/app-table` 改动|表格最小宽度下发与自身容器横向滚动、表头偏移同步|
|`src/backend/worker/worker-execution.ts`|worker 入口扩展名参数（桌面 `.js` / Web `.mjs`）|
|`src/frontend/index.html`、`index.css`|`viewport-fit=cover` 与安全区 token|
|工作台命令栏副本动作|工程副本下载入口（Web 浏览器下载 / 桌面路径提示）|

第四轮新增（游戏目录上传与触屏细节）：

|文件|作用|
|---|---|
|`src/backend/file/structured-upload-import.test.ts`|自建 EPUB/SRT 经暂存走解析流水线的结构保留集成测试|
|`src/backend/file/web-file-service.ts`（改动）|上传名支持相对目录、空批次目录回收、失败分支目标文件清理|
|`src/frontend/features/web-file-picker/web-file-picker-dialog.tsx`（改动）|“上传文件夹”（`webkitdirectory`）与批次目录交付|
|`src/frontend/pages/agent-page/agent-input-queue.tsx`（改动）|队列上移/下移按钮（5 语言 i18n）|
|`src/frontend/widgets/command-bar`、`search-bar`、页面级 CSS（改动）|触屏 40px 热区与窄视口常驻移除按钮|

实现轮新增（前端宿主）：

|文件|作用|
|---|---|
|`src/frontend/app/host/host-bridge.ts`|宿主能力唯一读取入口，Web 桥安装点|
|`src/frontend/app/host/web-host-bridge.ts`|Web 宿主桥实现与访问会话建立|
|`src/frontend/app/host/web-access-gate.tsx`|访问凭据录入视图|
|`src/frontend/app/host/web-host-startup.ts`|会话建立与宿主桥安装顺序|
|`src/frontend/app/desktop/web-host-api.ts`|启动期凭据片段键名|
|`src/frontend/index.tsx`|Web 宿主就绪后才渲染应用|
|`src/frontend/vite-env.d.ts`|宿主全局改为可选，读取统一经 host-bridge|

已迁移约 20 处 `window.desktopApp` 消费点到 `read_host_bridge()`；`src/gui/**` 与 preload 未改动，桌面路径行为不变。长期架构文档待对应实现稳定后同步。

第七轮新增（Chromium 宿主，TW-09）：

|文件|作用|
|---|---|
|`src/native/chromium-browser.ts`|CDP 页面来源：可执行文件解析、独立 profile 与回环调试端口、按需启动进程、target/session 管理、`Runtime.evaluate` / `Page.printToPDF` / `Page.navigate`+`loadEventFired`、每调用超时、进程退出即让在途调用失败|
|`src/native/chromium-page-task.ts`|单次任务独占页面，与 `window-task.ts` 同构：外部取消、超时都收敛为同一次页面释放|
|`src/native/chromium-image-host.ts`|`AgentImageHost` 的 Chromium 实现：内嵌 CSP 数据文档 + 页面内编码，返回值形状与字节预算不信赖宿主|
|`src/native/chromium-pdf-host.ts`|`PDFHost` 的 Chromium 实现：串行队列、排队取消、CSP、字体与数学样式内嵌、图注测量后打印|
|`src/native/pdf-print-shared.ts`|打印字体清单、CSP、样式生成、文档写入、资源就绪与图注测量脚本；Electron 与 Chromium 两个宿主共用|
|`src/native/agent-image-encode.ts`|图片像素与字节预算策略；Electron 与 Chromium 两个宿主共用同一份序列化函数|
|`src/native/agent-image-host.ts`、`pdf-host.ts`（改动）|改用上述共用件，行为不变|
|`src/web/web-entry.ts`（改动）|解析 Chromium 可执行文件（`LINGUAGACHA_CHROMIUM_PATH` 或常见位置/PATH），图片与 PDF 共用同一浏览器进程，缺失时图片宿主按能力缺失回答且不注入 PDF 宿主；`stop()` 结束后端后再 dispose 浏览器|
|`src/backend/api/api-gateway-server.ts`（改动）|`WebGatewayOptions` 新增 `imageHost`；启动配置的能力标志改为反映真实注入而非写死|
|`buildtools/build-web.mjs`、`build-pdf-print.mjs`（改动）|Web 构建补生成 `resources/pdf-print.css`；`build-pdf-print.mjs` 支持显式输出目录|
|`src/native/chromium-{browser,image-host,pdf-host}.test.ts`|21 个用例：可执行文件解析与启动参数、图片宿主请求/形状异常/字节超限/取消、PDF 宿主阶段顺序、样式只生成一次、串行队列、排队与活动取消、dispose|

第七轮新增（Agent 链路验证工具，TW-07）：

|文件|作用|
|---|---|
|`buildtools/agent-mock-model-server.mjs`|OpenAI Chat Completions 兼容的脚本化模拟模型服务（仅 Node 标准库），按已发生工具轮次推进：`workspace_run` → `workspace_apply` → 纯文本；`--script host` 时脚本另输出工作区图片并请求 HTML 打印|
|`buildtools/agent-mock-model-server.test.mjs`|5 个用例：三轮状态机、流式 chunk 合法性、未知请求不挂起、`/models` 与 `/health`、请求日志按序|
|`buildtools/web-agent-chain-probe.mjs`|对真实运行中的 Web 服务驱动 Agent 全链路、取消与 SSE 重连三个场景并断言|
|`buildtools/web-agent-chain-verify.mjs`|编排脚本：临时数据根启动真实服务与模拟模型、经模型接口配置 Agent 模型、固定审批模式、跑探针、核对宿主证据与进程回收；`--script glossary\|host`、`--keep`|

第十一轮新增（宿主能力投影与 Chromium 打印缺陷，TW-07 / TW-09）：

|文件|作用|
|---|---|
|`src/backend/agent/agent-image-service.ts`（改动）|宿主可缺省；新增 `available` 能力事实；未注入宿主时按 `runtime.capability_missing`（`image_host_unavailable`）回答，与宿主内部拒绝同一分类|
|`src/backend/agent/agent-image-service.test.ts`（改动）|补无宿主能力缺失用例；注释改为 Electron / Chromium 双宿主表述|
|`src/backend/agent/workspace/service.ts`（改动）|新增 `AgentWorkspaceHostCapabilities` 与 `host_capabilities` getter，纳入 `AgentWorkspacePort`；`images` 选项扩展到 `available`|
|`src/backend/agent/workspace/service.test.ts`（改动）|夹具支持注入 `pdfHost` / 图片可用性；新增宿主能力按注入报告用例|
|`src/backend/agent/workspace/runtime/api-description.ts`（改动）|按能力过滤模型可见成员：缺失时不声明 `emitImage` 与 `host`|
|`src/backend/agent/workspace/runtime/api-description.test.ts`（改动）|能力齐备声明可用；缺失时不声明且 TypeScript 反例成立|
|`src/backend/agent/tools/workspace-run.ts`（改动）|工具说明新增「宿主能力」段，按真实注入说明可用性与原因|
|`src/backend/agent/tools/workspace-run.test.ts`（改动）|补能力齐备 / 缺失两种说明投影用例|
|`src/backend/agent/agent-service.ts`（改动）|`workspace_run` 工具改从工作区端口读取宿主能力，不另建第二事实源|
|`src/backend/agent/agent-service.test.ts`（改动）|假工作区补 `host_capabilities`|
|`src/web/web-entry.ts`（改动）|未找到 Chromium 时不注入图片宿主，能力按缺失传递；移除必然失败的主机工厂|
|`src/backend/bootstrap/gui-backend-bootstrap.ts`（改动）|`imageHost` 改为可缺省|
|`src/backend/agent/workspace/runtime/bootstrap.test.ts`（改动）|`images` 夹具补 `available`|
|`src/native/chromium-browser.ts`（改动）|`Network.setBlockedURLs` 由通配 `*` 改为按可外联协议拦截，`data:` / `blob:` 内嵌资源不再被拦|
|`src/native/chromium-browser.test.ts`（改动）|新增拦截清单用例：不拦进程内数据、覆盖全部外联协议|
|`docs/ARCHITECTURE.md`（改动）|Chromium 宿主小节更正为桌面 Electron 隐藏窗口与 Web 按需 Chromium 双入口，并记录资源边界不得使用通配拦截|

第十二轮新增（真实浏览器弹性证据，TW-09）：

|文件|作用|
|---|---|
|`src/native/chromium-host-resilience.test.ts`|真实 Chromium 进程上的宿主弹性证据：取消（图片编码与打印途中）、任务级超时（图片编码与 900 页打印途中）、宿主进程崩溃（进程组杀死后的失败语义与资源回收）；找不到可执行文件时整组跳过，不用假页面伪装通过。测试自有合成 PNG（确定性噪声行，压缩快、编码成本高）与多页文档，按 `ps` profile 标记识别产品进程，只触碰本文件创建的实例|

第十三轮新增（范围收敛、部署验证与多开证据）：

| 文件 | 作用 |
|---|---|
| `docs/TERMUX_WEB_PLAN.md`（改动）|新增 1.1 范围调整：移植目标收敛为小说翻译，游戏文本与字幕形式冻结（保持实现与既有覆盖，不再投入迁移验收） |
| `buildtools/build-web.mjs`（改动）|Web 构建移除 `backend-runtime-worker-entry`：该入口只由桌面产品入口 `src/index.ts` 加载，Web 服务进程自持组合根，不再产出无调用方的部署文件 |
| `buildtools/web-deploy-verify.mjs`|仓库外部署验证（R-02）：复制 `build/web` 到仓库外目录并以该目录为 cwd、全新数据根启动；小说格式上传 / 解析 / 建工程 / 副本 / 统计回读，MV/MZ 上传只作 prepare worker 部署加载检查；核对产物完整、无浏览器启动与退出码 |
| `buildtools/web-multi-instance-verify.mjs`|同数据根多实例验证（R-13）：双实例启动、跨进程打开、过期修订被 409 拒绝、重读后可用、终态一致、数据库完好与停止顺序 |

第十四轮新增（EPUB 浏览器闭环、多语言下载边界与一处契约缺陷修复）：

|文件|作用|
|---|---|
|`buildtools/web-novel-loop-verify.mjs`|小说闭环浏览器验证：Playwright 驱动上传 EPUB → 摘要 → 保存选择器（切到应用数据根）→ 创建工程 → 工作台文件与条目 → 生成译文 → 捕获浏览器下载并校验内容；侧栏切换英文后再次生成下载；REST 直查旧语言目录边界；核对控制台零错误、进程与 profile 回收|
|`src/frontend/features/web-file-picker/agent-save-path-bridge.ts`（改动）|pending 领取由 `api_get` 改为 POST：后端路由只注册 POST，GET 会被判为不存在，迟连接窗口的保存位置请求永远领不到|
|`src/frontend/features/web-file-picker/web-file-picker-host.test.tsx`（改动）|mock 记录 pending 领取方法并断言为 POST，防止同类前后端方法错配再次漏过|

第十五轮新增（Agent 保存位置驻留与迟连接领取验证）：

|文件|作用|
|---|---|
|`buildtools/web-agent-save-path-verify.mjs`|R-06 浏览器级验证：无浏览器在线触发 `activate-path` 后核对驻留事实（SSE 事件、pending 列表、调用不返回）；浏览器 #1 领取后关闭不应答，核对请求仍驻留；浏览器 #2 再次领取并切到应用数据根应答，核对 `saved` 收尾、pending 清空与目标文件内容|

第十六轮新增（C 类决策落地、A 类收尾与冻结功能检查，2026-10-18 深夜；**全部未提交**）：

C 类（用户决策与授权）：

| 文件 | 作用 |
|---|---|
| `buildtools/web-stepfun-provider-verify.mjs` | C1：StepFun 真实供应商有界验证（自建构建、临时数据根、模型三用途配置、翻译批次、译文下载校验、真实 Agent 对话） |
| `src/frontend/app/desktop/desktop-api.ts`、`src/frontend/app/index.tsx`、`src/backend/app/app-metadata-service.ts`（改动） | C2：更新检查 URL、仓库入口与 LLM User-Agent 改指本地仓库 `breakyuna/LinguaGacha-Termux`（wiki 文档链接保留上游） |
| `src/backend/file/translation-file-generation-service.ts`（改动） | C3：受控下载边界从当前语言放宽到全部语言输出目录；新增 `read_output_files()` 供下载清单取数 |
| `src/backend/api/api-routes.ts`（改动） | C3：新增 `POST /api/translation/files/outputs`（前端无法自行计算本地化目录名） |
| `src/frontend/features/translation-generation/use-translation-generation-flow.ts`（改动） | C3：生成成功后将各语言输出目录清单合并进下载清单，列举失败降级不阻断 |
| `src/backend/api/web-instance-marker.ts`（新增） | C4：数据根实例标记唯一写入口（wx 排他创建、pid 存活判定、陈旧重建、按 pid 删除） |
| `src/web/web-entry.ts`、`src/backend/api/api-gateway-server.ts`、`src/shared/backend-api.ts`（改动） | C4：启动占位与冲突警告、bootstrap 新增 `anotherInstance`、前后端契约类型 |
| `src/frontend/app/host/web-instance-conflict-toast.tsx`（新增）、`src/frontend/app/index.tsx`（改动）、5 个 i18n 资源（改动） | C4：可关闭的多实例提示（复用 toast 体系） |
| `buildtools/web-instance-conflict-verify.mjs` | C4 真实验证：单实例 null、第二实例不被阻止且报告对方 pid/端口、警告打印、互不删标记、陈旧标记重建（11/11） |
| `buildtools/web-novel-loop-verify.mjs`（改动） | C3 连带：旧语言目录断言从“403 预期”改为“可下载 + 清单含 2 个语言文件”（浏览器复验未跑） |

A 类收尾：

| 文件 | 作用 |
|---|---|
| `buildtools/web-chromium-host-resource-probe.mjs` | A1：Chromium 宿主峰值资源采样（图片/PDF 任务 RSS、PSS、CPU，200ms 间隔，3 次稳定） |
| `buildtools/web-lg-copy-regression.mjs` | A2：旧 `.lg` 副本在全新数据根打开的一致性回归（REST 全流程 + 数据库级比对提示） |
| `buildtools/web-backup-restore-verify.mjs` | A4：备份恢复验证（产品工程副本 + 运维等价流程，24/24×3） |
| `src/backend/log/log-file-store.test.ts`、`src/backend/file/shared/rpgmaker-prepare.test.ts`（改动） | A5：修复 Android 时间戳粒度与 readdir 顺序两类测试假设问题（28/28） |

第十七轮新增（2026-10-19，全部未提交）：

| 文件 | 作用 |
|---|---|
| `buildtools/web-long-task-verify.mjs`、`buildtools/web-chromium-host-resource-probe.mjs`（改动） | A3/A1 脚本收尾：异常文本英文化、死代码与未用导入清理、ANSI 正则行内禁用 |
| `src/backend/api/api-gateway-server.ts`（改动） | 安全修复一：内联启动配置 `<` 转义 `\u003c`，关闭数据根字符串突破脚本标签的注入面 |
| `src/backend/file/web-file-service.ts`（改动） | 安全修复二/三：受控下载与目录浏览的符号链接逃逸拒绝（词法界内但真实路径逃逸即拒绝） |
| `src/frontend/features/web-file-picker/web-file-picker-dialog.css`（新增）、`web-file-picker-dialog.tsx`（改动） | 移动端适配：触屏/窄视口下列实行 40px、小按钮 40px 触摸目标 |
| `buildtools/web-mobile-picker-probe.mjs`（新增） | 390×844 触屏探针：溢出、视口、行高、按钮尺寸、上传、保存选择器 |
| `buildtools/web-novel-loop-verify.mjs`（改动） | 决策 C 断言（旧语言目录可下载）+ GitHub 404 按 URL 容忍 |
| 相关测试文件（改动） | bootstrap 转义、符号链接逃逸两方向，均经非空验证 |

A3（未完成，今天中止）：

| 文件 | 作用 |
|---|---|
| `buildtools/web-long-task-verify.mjs`、`buildtools/web-long-task-mock-model.mjs` | A3：30 分钟长任务 + 翻译 worker 仓库外加载验证；第 2 轮已取得可用证据，第 3 轮被用户中止；脚本有 3 处中文异常文本待修（213/560/837 行） |

第十九轮新增（2026-10-19 解除冻结，全部未提交）：

| 文件 | 作用 |
|---|---|
| `docs/TERMUX_WEB_PLAN.md`（改动） | 1.1 节修订：游戏文本与字幕解除冻结，登记新验收边界（RGSS 服务级闭环与目标平台启动仍范围外） |
| `buildtools/web-frozen-formats-loop-verify.mjs`（新增） | 解除冻结格式的服务级翻译闭环：字幕 5 格式 + MV/MZ 游戏目录（含导出容器回灌）+ 7 种文件型格式，51 项断言 |
| `buildtools/web-subtitle-browser-loop-verify.mjs`（新增） | 字幕浏览器级闭环：Playwright 经选择器上传 → 翻译 → 捕获浏览器下载并校验内容，22 项断言 |
| `src/backend/file/translation-file-generation-service.ts`（改动） | **产品缺陷修复**：译文清单改为递归列举（修复前目录导入的嵌套输出在下载清单中完全不可见） |
| `src/backend/proofreading/proofreading-query-service.ts`（改动） | **健壮性修复**：`list` 查询不再把缺失筛选实体化成空集（修复后未传筛选的调用方按缺省筛选得到行） |

## 5. 验证记录

### V-001：环境与基础运行能力

- 日期：2026-10-17；关联任务：`TW-01` 前置调查；代码基线：`6f2c40c9`。
- 方法：`node --input-type=module` 标准输入脚本执行内存 `DatabaseSync` 建表/写入/读取、Zstd 往返、模块钩子注册注销、工作线程消息及异步资源释放。
- 权限探针：`node --permission --input-type=module -e 'console.log("fs.write granted:",process.permission.has("fs.write"))'`，输出 `false`。
- 结果：以上基础探针通过；读取锁文件获得平台包线索；浏览器工具路径可定位。
- 未运行：依赖安装、实际原生包/WASM 加载、项目测试、构建、完整 Agent、产品页面和 Android 系统交互。
- 适用边界：证明本机 Node 基础能力，不证明 `TW-01` 完成或应用能运行。

### V-002：文档交付检查

- 日期：2026-10-17；关联任务：`TW-00`。
- 代码基线：`6f2c40c9` 加本轮四份文档变更。
- 方法：Python 只读脚本检查四份文档的本地链接目标、代码围栏和任务 ID；核对方案的 12 个任务定义与交接表逐项对应；检查新增文件的空白和差异。
- 结果：通过。54 个相对链接目标有效，`TW-00` 至 `TW-11` 定义与进度表一致；`git diff --check` 通过，新增文档另行检查。
- 代表任务走查：仅文档任务不会触发产品构建；`TW-02` 需同步新增 Web 验证入口；`TW-09` 必须验收真实宿主和视觉结果；环境失败不能将任务标记为完成。
- 状态核对：只有 `TW-00` 完成；目标 npm 脚本明确标为未实现；风险与已发生阻塞分开记录。
- 适用边界：只验证规划与执行材料，不证明产品功能。

### V-003：依赖安装与工具链

- 日期：2026-10-17；关联任务：`TW-01`；代码基线：`6f2c40c9`。
- 方法：`npm install --ignore-scripts --no-audit --no-fund`；随后以 `node --input-type=module` 逐个 `import()` 关键模块；查询 npm registry 确认 TypeScript 平台包清单。
- 结果：安装成功（1154 包，59 秒）；`mupdf`、`@ruby/prism`、`oxc-parser`、`hono`、`@hono/node-server`、`vite`、`vitest`、`typescript`、`jszip`、`iconv-lite`、`chardet`、`exceljs`、`undici`、`proper-lockfile`、`yaml`、`jose` 全部加载成功；`@oxc-parser/binding-android-arm64`、`@tailwindcss/oxide-android-arm64` 已安装。
- 失败项：`node node_modules/typescript/bin/tsc --version` 报 `Unable to resolve @typescript/typescript-android-arm64`；registry 查询确认 `7.0.2` 与 `7.1.0-dev.*` 均无 Android 构建。
- 未运行：工程迁移、完整 Agent、真实模型调用。
- 适用边界：证明本机可安装并加载运行依赖；类型检查仍须在受支持平台执行。`postinstall` 已改为平台感知，Termux 不再尝试下载 Electron。

### V-004：Web 服务启动、同源传输与访问边界

- 日期：2026-10-17；关联任务：`TW-02`、`TW-03`；代码基线：`6f2c40c9` 加本轮实现。
- 方法：`npm run build:web` 后以 `node build/web/index.mjs --port=<n> --data-root=<tmp>` 仓库外启动；Node `fetch` 探针与裸 socket 探针覆盖健康检查、静态资源、深链接、会话建立、SSE、Host 与 Origin 边界；`SIGTERM` 验证停止。
- 结果：启动打印访问地址与一次性凭据；`/api/health` 200；`/` 返回内联启动配置的入口文档；`/assets/*` 200 且 `immutable`；深链接 200 回退入口文档；编码穿越 404；错误 Host 403；错误 Origin 403；未授权 API 与 SSE 401；错误凭据 401；凭据换取 Cookie 204 且 `HttpOnly; SameSite=Strict`；授权后 API 与 SSE 200；`SIGTERM` 后进程退出、端口释放、无残留进程。
- 未运行：仓库外干净目录安装、端口冲突与同数据根重复启动、重型计算下的服务响应、Node 代理设置对模型认证回调的影响。
- 适用边界：证明本机 Node 可承载完整后端并提供同源受控访问；不证明部署与更新验收。

### V-005：浏览器启动与页面数据

- 日期：2026-10-18；关联任务：`TW-04`；代码基线：`6f2c40c9` 加本轮实现。
- 方法：Playwright Core 驱动本机 Chromium，`390 × 844` 与 `1280 × 900` 视口；先无凭据访问，再以完整链接（含凭据片段）进入，随后逐页点击侧栏项并读取页面文本，最后刷新与日志窗口模式。
- 结果：无凭据时停在访问凭据录入视图；带凭据进入后 URL 片段被清理，应用外壳与侧栏渲染；模型管理、AGENT、基础设置、日志四页均读到后端真实数据且无失败文案；`?window=logs` 独立窗口读到真实日志条目；刷新后不回落凭据页；控制台零错误。
- 未通过项：`390 × 844` 下侧栏与内容并排导致整体横向溢出，属 `TW-08` 范围；文件与目录选择按能力缺失反馈，上传下载流程属 `TW-05`。
- 适用边界：证明无 preload 的普通浏览器可完成启动与主要页面读取；不证明手机交互与文件流程。

### V-006：受影响范围测试与静态检查

- 日期：2026-10-18；关联任务：`TW-02`、`TW-03`、`TW-04`；代码基线：`6f2c40c9` 加本轮实现。
- 方法：`npm run check`、`npm run lint`、`npm run format -- --check <改动文件>`；`vitest --project node` 运行 `src/backend/api`、`src/backend/network`、`src/backend/app`、`src/backend/bootstrap`、`src/shared/error`；`vitest --project renderer` 运行 `src/frontend/app`。
- 结果：架构检查、lint、格式检查全部通过；node 目标 26 个文件 156 个测试通过；renderer 目标 56 个文件 256 个测试通过。
- 全量 node 套件：14 个测试失败，全部落在依赖真实 Electron、Chromium、ASAR 或 `tsc` 的文件（`src/index.test.ts`、`src/native/pdf-host.test.ts`、`agent-image-host.test.ts`、`bootstrap.test.ts`、`ruby.test.ts`、`javascript.test.ts`、`vtt-format.test.ts`、`renderer-runtime-reload.test.mjs`、`contract.test.ts`、`api-description.test.ts`、`schema-description.test.ts`、`rpgmaker-prepare.test.ts`、`native-fs.test.ts` 及 preload 测试）。已在干净基线复跑其中 5 个文件，失败一致，确认与本次改动无关。
- 未运行：全量 renderer 套件在高压下出现过两次与本次改动无关的偶发失败（单独复跑通过），完整结论待资源充足时确认。
- 适用边界：证明本次改动的受影响范围通过既有静态门禁与行为测试；不证明依赖桌面宿主的既有测试在本机可运行。

### V-007：Web 文件能力后端

- 日期：2026-10-18；关联任务：`TW-05`；代码基线：`6f2c40c9` 加本轮实现。
- 方法：`src/backend/file/web-file-service.test.ts` 单元测试（临时目录 + 合成文件）；`npm run build:web` 后真实启动，用 Node `fetch` 建立会话并调用文件接口。
- 结果：6 个单元测试通过（允许根列举、隐藏项过滤、越界与穿越拒绝、上传落盘与释放、取消清理半成品、下载边界、dispose 清理）；真实启动后 `/api/web/files/roots` 返回 4 个根（Termux 主目录、共享存储、SD 卡、应用数据），`/lg-web-source` 列举出合成文件及大小，`/../..` 穿越返回 400；未授权调用返回 401。
- 未验收：浏览器选择器界面（已回退，代码未保留）；工程创建、追加导入、工程副本与译文下载的完整闭环。
- 适用边界：证明后端文件能力与边界控制可用；不证明前端导入导出闭环。

### V-008：Web 文件闭环、材料接入与手机布局（第三轮）

- 日期：2026-10-18；关联任务：`TW-05`、`TW-08`、`TW-03`；代码基线：`6f2c40c9` 加本轮实现。
- 方法一（单元与静态）：`npx vitest run --project node src/backend/file src/backend/api`（604 个测试，598 通过，6 个失败为 V-006 已登记的环境失败）；`src/backend/project src/backend/quality` 215 全通过；`src/backend/database src/backend/app src/backend/bootstrap` 97 通过；`src/shared` 420 通过；renderer `src/frontend/app` 57 文件 260 测试通过；`npm run check`、`npm run lint`、受影响文件 `npm run format -- --check` 全部通过。
- 方法二（真实启动探针）：`npm run build:web` 后以 `--port=8466` 与临时数据根仓库外启动；Node `fetch` 全链路探针 13/13 通过：会话建立、未授权 401、四个允许根、目录列举、穿越 400、上传暂存、材料下载、根外下载 403、材料释放后 404、译文下载越界 403、无工程时副本与翻译受理均返回 `project.not_loaded`。
- 方法三（浏览器布局验收）：Playwright Core 驱动 `390 × 844`、`844 × 390`、`1280 × 900` 三视口，逐页（工程/模型/AGENT/设置/日志）测量 `scrollWidth` 与点击路径。结果：三视口四页面均无整体横向溢出；`390 × 844` 菜单按钮可打开抽屉（16 个导航项）；宽视口并排侧栏 16 项；截图已实际查看（标题栏、工程页、抽屉）。
- 本轮修复的两个真 bug：① Web 启动配置 `titleBarHeight: 0` 使应用壳标题栏塌缩、标题栏开关被工作区遮挡（改报与桌面契约一致的 40）；② 窄视口抽屉默认展开遮挡首屏（侧栏折叠态在窄视口初始为收起，且窄视口不写回本地偏好）。
- 暂存落盘命名改为“无竞争用清洗原名、重名才追加身份后缀”（串行化落盘队列防并发覆盖），导入预览目标名不再带暂存身份后缀；导出材料模式支持 `material_name` 指定交付文件名。
- 未运行：`npm run typecheck`（R-01）；仓库外干净目录安装；重型计算压测；Android 真机（软键盘、系统文件选择器、下载、切后台）。
- 适用边界：证明 Web 文件闭环的机器契约、下载边界与手机布局根因修复；不证明端到端导入导出体验（选择器界面属下一阶段）与真机系统行为。

### V-009：Web 闭环端到端、TW-06 恢复与部署探针（第三轮完整）

- 日期：2026-10-18；关联任务：`TW-05`、`TW-06`、`TW-08`、`TW-02`、`TW-03`、`TW-11`；代码基线：`6f2c40c9` 加本轮全部实现。
- 方法一（全量测试）：`vitest --project node` 全量 362 文件 2821 测试，2805 通过、14 失败、2 跳过；13 个失败文件全部落在 V-006 已登记的环境依赖集合（真实 Electron/Chromium/ASAR/tsc/preload 平台差异），无新增失败。`vitest --project renderer` 全量 206 文件 1163 测试，1161 通过；2 个失败为 `src/gui/preload/index.test.ts`（`process.platform === "android"` 时标题栏 overlay 不发送 IPC，平台依赖的既有失败）与 agent-conversation 一例超时（单独复跑通过，高压偶发）。
- 方法二（选择器端到端，Playwright + 真实后端）：上传合成 TXT → 源文件摘要 → MANUAL 保存选择器（目录浏览+命名）→ 工程创建成功；工作台"下载工程副本"→ 下载文件为有效 SQLite（`SQLite format 3` 文件头校验）；术语表导出（材料下载 `application/octet-stream`）→ 导入合成条目（页内可见）→ 工作台追加导入（继承确认与同名冲突对话框均走到）；全部 console 零错误。
- 方法三（TW-06 契约与崩溃恢复）：Node 探针 7/7——同 `command_id` 重复提交回放终态快照（`duplicate: true`）、不同命令不误判、快照查询正常；无浏览器参与即受理并进入 running（受理与页面分离）。崩溃恢复：模拟 LLM 服务（20~60s 抖动）配置为翻译模型 → 启动真实翻译 → 运行中 `kill -9` → 重启 → 打开工程 → 快照状态 `interrupted`，重启后数据库可重开且已提交术语保留。
- 方法四（TW-02/TW-03/TW-11 部署探针）：同端口第二实例退出码 1 且日志含 `EADDRINUSE`；复制 `build/web/` 到仓库外目录以全新数据根启动，健康检查 200 且提供入口文档；设置 `HTTP_PROXY`/`HTTPS_PROXY` 后回环服务正常；同数据根第二实例可启动（SQLite WAL 多进程，无跨进程互斥，登记为已知缺口）。
- 方法五（布局复验）：三视口 × 四页面无整体横向溢出；抽屉可开合；390 宽术语表表格在自身容器内横向滚动（`tableContainerScrolls=true`），截图已实际查看。
- 本轮修复的真 bug（均在 P1.5/P2.5 记录）：标题栏高度契约误报 0、抽屉默认展开、副本按钮死放置、材料下载双重 URL 前缀、Web worker 入口 `.js`/`.mjs` 命名不一致。
- 未运行：Android 真机系统行为；多标签页并发同步的浏览器级验证；重型计算压测；30 分钟长任务。
- 适用边界：证明 Web 文件闭环、任务恢复与部署路径在本机可端到端运行；不证明真机系统行为与完整格式矩阵。

### V-010：第三轮复查（文档一致性与全链路复验）

- 日期：2026-10-18；关联任务：`TW-00`、`TW-02`、`TW-03`、`TW-05`、`TW-08`；代码基线：`6f2c40c9` 加本轮全部实现。
- 方法一（文档一致性）：只读脚本校验三份文档——37 个相对链接目标全部有效；`TW-00` 至 `TW-11` 在方案与交接表逐项对应；任务表 12 行状态词全部合法（完成/进行中/待开始）；验证记录 V-001 至 V-009 连续；`git diff --check` 通过。修正两处过期表述：基线表“未做仓库外干净目录安装验证”（`V-009` 已验）、`R-03`“选择器界面接线属下一阶段”（已实现并验证）；重排第 4 节修改范围表格顺序。
- 方法二（静态门禁）：`npm run check` 五项检查全部通过；`npm run lint` 通过。
- 方法三（构建与全新数据根复验）：`npm run build:web` 通过（入口、5 个 worker 入口、渲染产物、`builtin`、`version.txt` 落盘）；以**全新数据根**仓库外启动，全链路探针 13/13 通过（会话、未授权 401、四允许根、列举、穿越 400、上传、材料下载、根外 403、释放后 404、译文越界 403、无工程副本/翻译受理均 `project.not_loaded`）。
- 方法四（浏览器复验）：三视口 × 四页面无整体横向溢出、抽屉可开合、并排侧栏在场（LAYOUT ALL PASS）；上传→摘要→保存选择→**工程创建**主链路通过；工作台副本下载得到有效 SQLite（196608 字节）；截图已实际查看。
- 适用边界：证明第三轮成果在全新数据根下仍可复现；不改变 V-009 的各项未验范围。

### V-011：游戏目录上传、触屏细节与恢复验证（第四轮）

- 日期：2026-10-18；关联任务：`TW-05`、`TW-08`、`TW-02`、`TW-06`；代码基线：`6f2c40c9` 加本轮全部实现。
- 实现一轮（目录上传）：后端 `stage_upload` 的上传名扩展为可含相对目录（逐段清洗，拒绝空段/`.`/`..`/盘符），落盘 `web-imports/<dir>/<name>`，材料显示名带完整相对路径；新增 `remove_staged_file` 回收空批次目录，并修复 `write_upload` 失败分支引用 try 内变量的 ReferenceError。前端选择器新增“上传文件夹”（`webkitdirectory`，ref 设置属性），串行上传、失败全释放、批次目录经既有目录导入流程消费。工程页补摘要为空/异常时的材料释放（原先泄漏，批次上传会耗尽 64 材料上限）。
- 实现二轮（触屏细节）：最近工程移除按钮在 `(hover: none)` 与 ≤767px 常驻可见并补 40px 热区；工作台行操作、命令栏与搜索栏主要操作补 40px 热区；agent 输入队列新增上移/下移按钮（5 语言 i18n）与拖拽并存。
- 验证一（静态与单元）：`npm run check` 五项、`npm run lint` 通过；node 目标 4 文件 42 通过；renderer 目标 5 目录 68 通过；两个实现 agent 各自全量目录测试通过（project-page+workbench+widgets 29 文件 166、agent-page 30 文件 248、web-file-picker 15）。
- 验证二（文件夹上传端到端）：Playwright 注入带 `webkitRelativePath` 的 4 个合成文件（`readme.txt`、`chapters/ch01.txt`、`chapters/ch02.txt`、`notes/debug.txt`）→ 批次暂存（上传 200，相对路径正确）→ 摘要“已选择 4 个源文件” → 创建工程 → 工作台文件表显示 `chapters/` 与 `notes/` 嵌套结构，**相对结构保留 ALL PASS**。
- 验证三（TW-06 收尾）：多标签页双上下文，A 页启动翻译，B 页 1 秒内经 SSE 同步显示“翻译中”（PASS）；重型计算压测：翻译运行期间健康检查 36~49ms、静态资源 52~70ms、快照查询 avg 33~40ms，与空闲同量级（PASS）。
- 验证四（触屏视觉）：390 宽工程首页最近工程移除按钮 `opacity:1`、`pointer-events:auto`、28×28 带隐形热区，无横向溢出（PASS）。
- 新增测试：`structured-upload-import.test.ts`（自建最小 EPUB 与合成 SRT 经暂存走解析流水线，断言格式识别、条目数与结构保留）；`command-bar.test.tsx`；agent-input-queue 2 例；project-page 移除按钮双态 2 例。
- 未运行：Android 真机；`webkitdirectory` 在真实 Android 文件选择器的行为；超过 64 文件单批上传（触发 `runtime.busy`，需分批，已登记风险）；`npm run typecheck`（R-01）。
- 适用边界：证明游戏/素材目录上传的结构保留、触屏主要操作可达性与任务期间服务响应；不证明真机文件选择器与超大批次。

### V-012：Agent 工作区保存位置桥接（第五轮，TW-07 核心）

- 日期：2026-10-18；关联任务：`TW-07`；代码基线：`6f2c40c9` 加本轮实现。
- 实现：新增 `src/backend/api/web-agent-save-path-host.ts`（驻留请求 + pending 领取 + 应答 + dispose，30 分钟超时按取消收尾）；`gui-backend-bootstrap.ts` 的 `pickSavePath` 改为可选，Web 传输时组合根创建桥接宿主并传入工作区与 Gateway，dispose 时释放全部驻留请求；`web-entry.ts` 移除不可用的 save-path 宿主工厂；新增路由 `POST /api/agent/save-path/pending`（迟连接领取）与 `POST /api/agent/save-path/respond`（应答，未知身份 400，桌面入口能力缺失）；前端新增 `agent-save-path-bridge.ts`（SSE 订阅 + pending 领取 + 选择器应答，请求去重），挂载于选择器宿主。
- 契约：新增共享 topic `agent.save_path_event`（`src/shared/agent.ts`）；请求载荷 `{type:"requested", request_id, default_name}`，应答经 REST 回传 `{request_id, path}`（null 为取消）。桌面路径行为不变（继续走原生对话框）。
- 验证一（单元）：宿主 6 测试（请求发布、应答放行、取消、pending 领取、dispose、超时）；renderer 16 测试（选择器宿主排队 + 桥接端到端：SSE 请求→保存模式选择器默认名预填→确认→REST 应答所选路径）。
- 验证二（集成）：`gui-backend-bootstrap.test.ts` 新增 Web 模式真实 Gateway 用例——访问会话建 cookie、创建工程与工作区文件、订阅 SSE 触发 `activate-path`、断言 `agent.save_path_event` 驻留请求、pending 领取、应答后文件复制到目标、未知身份 400；bootstrap 9/9，api + workspace service 合计 150 通过。
- 验证三（运行态）：真实启动 Web 服务，`/api/agent/save-path/pending` 带会话返回空列表、未知身份应答 400、无会话 401。
- 未运行：Agent 对话全链路（模拟模型对话、材料上传、受限脚本执行、写入审批、取消与重连）；`npm run typecheck`（R-01）；浏览器级保存桥接（SSE+REST 契约已由集成测试覆盖，选择器交互有 renderer 测试）。
- 适用边界：证明 Web 传输下 Agent 工作区保存位置请求可驻留、可领取、可应答且放行真实文件复制；不证明完整 Agent 对话与工作区执行链路。

### V-013：TW-10 全格式 Web 导入矩阵（第六轮）

- 日期：2026-10-18；关联任务：`TW-10`；代码基线：`6f2c40c9` 加此前各轮未提交改动。
- 实现：新增 `src/backend/file/web-import-format-matrix.test.ts`（5 个用例，测试自有临时目录与合成数据，不读取仓库真实样例、不访问网络）。矩阵覆盖格式注册表全部文件型身份与两个 RPG Maker 目录格式：TXT、Markdown、ASS、SSA、LRC、SRT、VTT、PDF、EPUB、RenPy、KVJSON、MESSAGEJSON、XLSX、WOLFXLSX、TRANS、WOLF TRANS、`rpgmaker_mv_mz`、`rpgmaker_rgss`。
- 方法一（矩阵主体）：单一批次目录暂存 16 个合成文件，断言目录递归发现的格式身份、`summarize_source_files` 的命中数（覆盖注册表全部文件型 ID）、`build_project_draft` 的文件类型与条目正文/状态/行号，PDF 走独立文档不产条目，暂存路径与字节和磁盘一致。
- 方法二（编码）：GBK 与 Shift_JIS 长样本 TXT 经 `chardet` 探测解码后逐行等于原文，UTF-8 走严格解码；依赖仓库内置 chardet 的确定性判定。
- 方法三（目录型格式）：MV/MZ 散装 `www/data` 目录与 RGSS `Game.rgss3a` 归档分别经批次暂存进入流水线；断言游戏身份收拢为单容器、暂存相对结构保持、Marshal 数据条目与默认资格、归档解包后旧数据被覆盖且原稿备份覆盖全部固化成员；MV/MZ 另走导入→导出闭环，译文按 `game/www/data/...` 容器结构落盘。
- 方法四（失败边界）：零条目资产（空 TXT、仅结构 VTT、无 Dialogue SSA、`{}`、`[]`）保留文件身份且不产条目；空文件与损坏文件（空/损坏 EPUB、空/损坏 JSON）逐条进入 `failed_files` 并带稳定错误码（`file.io_failed` / `file.parse_failed`），同批成功文件不受影响。
- 结果：新增文件单独运行 5/5 通过；`npx vitest run --project node src/backend/file` 76 文件 565 测试，559 通过、6 失败，失败全部落在 V-006 已登记的 4 个环境依赖文件（`javascript.test.ts`、`ruby.test.ts`、`vtt-format.test.ts` 缺 Electron/Chromium，`shared/rpgmaker-prepare.test.ts` 的 `readdir` 顺序断言）。未修改任何产品代码：矩阵未暴露 Web 暂存路径下的识别、结构或清理缺陷。
- 未运行：`npm run typecheck`（R-01）；旧 `.lg` 副本回归；真实 RPG Maker 目录的文件夹上传与目标平台游戏启动。
- 适用边界：证明全部注册表格式与两个游戏目录格式在 Web 暂存→解析（含导出）路径上的可观察行为；不证明真实样本、旧工程迁移与游戏实际启动。

### V-014：Chromium 图片与 PDF 宿主（第七轮，TW-09）

- 日期：2026-10-18；关联任务：`TW-09`、`TW-02`；代码基线：`6f2c40c9` 加此前各轮未提交改动。
- 环境探针（实现前）：Termux `chromium-headless`（Chromium 155.0.8059.39）可以 `--headless=new --remote-debugging-port=0` 启动，stderr 暴露 `DevTools listening on ws://…`；Node 内置 `WebSocket` 可连通浏览器级端点，`Target.createTarget` + `Target.attachToTarget{flatten:true}` 可取到 session。实测：`Runtime.evaluate` 可建 canvas 并产出 `data:image/webp;base64,…`；`createImageBitmap(Blob)` 可用；`Network.setBlockedURLs(["*"])` 下 data: 文档导航与 `document.write` 正常、外部 URL 被拦成 `chrome-error://chromewebdata/`；`document.fonts.ready` 与图片 `decode()` 可等待；figure 布局测量可取到真实高度；`Page.printToPDF` 产出 `%PDF-1.4` 字节；`SIGTERM` 后进程退出。
- 实现：Web 运行期按可执行文件解析结果注入真实宿主，图片与 PDF 共用同一 `ChromiumBrowser`；基本文本启动不创建浏览器进程，首次 `open_page()` 才启动；`dispose()` 先 SIGTERM、3 秒后 SIGKILL，并删除独立 profile。
- 验证一（静态与单元）：`npm run check` 五项、`npm run lint`（仅 2 个既有告警）、受影响文件 `npm run format -- --check` 全部通过；`npx vitest run --project node src/native/chromium-*.test.ts` 3 文件 21 测试全过。
- 验证二（运行态）：`node buildtools/web-agent-chain-verify.mjs` 真实启动（仓库外临时数据根）后，`/api/web/bootstrap` 报告 `imageHost=true pdfHost=true`；服务 `SIGTERM` 停止后，临时目录无 `lg-chromium-*` profile 残留、`ps` 无匹配进程。
- 未运行：`emitImage` 与 `host({kind:"print_pdf"})` 经 Agent 工作区的端到端调用（被 R-17 阻塞，mock 服务已备 `--script host` 模式）；PDF 版面与图片输出的人工视觉查看；宿主崩溃、超时与取消的真实 Chromium 证据；`npm run typecheck`（R-01）。
- 适用边界：证明 Web 传输下图片与 PDF 能力按事实注入、浏览器按需启停且无遗留进程；不证明端到端视觉结果与取消语义。

### V-015：Agent 对话全链路尝试（第七轮，TW-07，受阻）

- 日期：2026-10-18；关联任务：`TW-07`、`TW-09`；代码基线：`6f2c40c9` 加本轮全部改动。
- 方法：`node buildtools/build-web.mjs` 后执行 `node buildtools/web-agent-chain-verify.mjs --script=host --keep=true`（编排脚本自建临时数据根、启动模拟模型服务与真实 Web 服务、经 `/api/models/*` 配置 Agent 模型、跑 `web-agent-chain-probe.mjs` 三场景）。
- 结果：编排层全部通过——访问会话 204、能力事实 `imageHost=true pdfHost=true`、`/api/models/add`+`/update`+`/select` 把 Agent 用途指向模拟服务、`/api/settings/update {agent_approval_mode:"manual"}` 受理、工程创建与 Agent 附件上传成功、SSE 订阅与 `chat_status` running→idle 转换正常、revision 单调。**但三个探针场景全部失败**：`full-chain` 与 `reconnect` 等待 `workspace_run` 工具条目 120 秒超时，`cancel` 仅以"回合在停止前已结束"通过。
- 失败证据：数据根 `log/app.*.jsonl` 中 `run_start` → user message `status:"success"` → 175ms 后 `run_end status:"error"`，detail 为 `document is not defined`；模拟模型服务的请求日志为空，即**从未发出模型 HTTP 请求**。
- 原始失败及排查结论的更正见 6.1（R-17）。
- 适用边界：证明 Agent 链路的验证设施（模拟模型、探针、编排、模型配置入口）可用；不证明 Agent 对话本身。本轮未修改任何产品行为来"让探针通过"。

### V-016：Web 后端构建模式修复与 Agent 回归（第八轮）

- 日期：2026-10-18；关联任务：`TW-02`、`TW-07`、`R-17`；基线：`6f2c40c9` 加此前未提交改动；环境：Termux Android arm64、Node `v24.18.0`。
- 修复前：真实产物与本地 HTTP 模型复现失败，inspector 捕获 `preload-helper-CxyQbZZj.js:33` 的原始 `ReferenceError`；provider 未加载，模型请求日志为零。诊断数据根：`/data/data/com.termux/files/usr/tmp/lg-r17-analysis-ZKbVsF/`。
- 修改：`buildtools/build-web.mjs` 的后端构建启用 `build.ssr`、关闭 `modulePreload`，以 `ssr.noExternal` 保持服务依赖打包；前端构建不变。`buildtools/web-agent-chain-probe.mjs` 的重连场景使用独立合成工程，保留原有写入审批与事件连续性断言。
- 构建：`npm run build:web` 通过；后端 `assets/` 与 `.mjs` 入口检索不到 `__vitePreload` / `vite/preload-helper`。构建日志：`/data/data/com.termux/files/usr/tmp/lg-r17-build.log`。
- Agent：`node buildtools/web-agent-chain-verify.mjs --script=glossary --keep=true` 通过，探针 `full-chain`、`cancel`、`reconnect` 为 3/3，编排检查 6/6。材料与附件上传、真实受限 Node 脚本、术语写入审批与提交、助手正文、用户取消、SSE 重连均通过；恢复快照保留 2 个已提交条目，后续 9 条事件 revision 严格递增；模型请求日志 7 条，回合结果为 success / stopped / success。日志：`/data/data/com.termux/files/usr/tmp/lg-r17-agent-chain-fixed.log`；临时数据根与模型日志：`/data/data/com.termux/files/usr/tmp/lg-web-agent-verify-sQG50X/`。服务停止后 Chromium profile / 进程均为零。
- 夹具失败：首次修复后运行的完整循环与取消已通过，重连复用工程时 `workspace_apply` 返回同名术语 `invalid_change`，因此没有审批。读取测试工程的真实工具回执确认后中止等待；独立工程修正后重跑全部场景通过。首次日志：`/data/data/com.termux/files/usr/tmp/lg-r17-agent-chain.log`。
- 仓库外启动：以独立临时目录为 cwd、临时数据根运行正式 `build/web/index.mjs`，健康检查、HTML 启动配置、渲染 JS 资源、未授权 API 401、访问会话 204、已授权模型快照与 SIGTERM 退出码 0 共 7 项通过。结果：`/data/data/com.termux/files/usr/tmp/lg-r17-deploy-L2bQp0/result.json`。
- 静态检查：`npm run check`、`npm run lint`、两份脚本的显式路径格式检查与 `git diff --check` 通过；lint 仍有两个既有告警。`npm run typecheck` 失败：缺少 `@typescript/typescript-android-arm64`（R-01）。
- 适用边界：证明 R-17 已解除及 OpenAI Chat Completions 的本地 HTTP Agent 工具闭环；未运行真实供应商、其他三种 provider 协议、host 模式图片/PDF、浏览器界面或 Android 真机验收，不将 `TW-07` / `TW-09` 整项标为完成。无用户数据或数据库迁移；已有无关改动保留，未创建提交。

### V-017：Android 原生 TypeScript 7 与全量类型检查（第九轮）

- 日期：2026-10-18；关联任务：`TW-01`、`R-01`；基线：`6f2c40c9` 加此前未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、新安装的 Termux Go `1.27.2`。
- 原始阻塞与备选：官方 `@typescript/typescript-android-arm64` 包查询返回 404；同版本 Linux ARM64 二进制启动即在 `fanotify_init` 触发 `SIGSYS`。JavaScript 版 TypeScript 6.0.3 诊断试验在 test 项目达到 1536 MiB 堆上限后失败（日志 `/data/data/com.termux/files/usr/tmp/lg-ts6-typecheck.log`），未作为最终工具链。
- 工具链：新增 `buildtools/typecheck.mjs`，Android 首次下载与 npm TypeScript `7.0.2` 的 `gitHead` 一致的官方源码，校验固定 SHA256，移植[上游 Android 监视器修复](https://github.com/microsoft/typescript-go/pull/4734)，用 `GOOS=android GOARCH=arm64 CGO_ENABLED=0` 构建并内嵌标准库；仅禁用 Android 不允许的 fanotify 并选择 inotify，类型检查实现不变。完整二进制原子发布到 `build/toolchains/typescript/7.0.2-android-1-arm64/tsc`；源代码临时目录在成功或失败时回收，Go 编译缓存保留供复用。首次成功构建日志：`/data/data/com.termux/files/usr/tmp/lg-ts7-android-build-cn.log`。
- 入口：`npm run typecheck` 与 `src/test/typescript-fixture.ts` 共用启动器；其它平台沿用安装包的编译器。TypeScript 固定为 `7.0.2`，锁文件仅同步根依赖版本约束，没有更新其它依赖。原有 `tsconfig`、严格选项、ES2025 标准库与 renderer / node / test 检查集合未缩减。
- 类型缺口修正：真实全量检查发现当前 Web 实现与测试的类型问题；修正可选 JSON 值与保存宿主、快照发布完成值、running 标记返回类型、Chromium 空参数与超时错误码、文件选择回调收窄、复用既有复制失败文案键，以及测试中的 mock / URL / 可选桥 / 回调声明。缺少保存宿主时明确报告能力缺失并保留文件，追加对应行为测试。首次完整诊断：`/data/data/com.termux/files/usr/tmp/lg-ts7-typecheck-before-fixes.log`。
- 全量类型检查：`npm run typecheck -- --force` 通过，检查根配置引用的全部三个项目，日志 `/data/data/com.termux/files/usr/tmp/lg-ts7-typecheck-passed.log`；随后正常 `npm run typecheck` 增量入口再次通过。清空 PATH 中的 Go、设置 `GOPROXY=off` 后缓存编译器仍返回 `Version 7.0.2`。
- 编译器行为：`buildtools/typecheck.test.mjs` 的仓库外合法/非法赋值测试，以及 Agent 工具契约、schema 声明、runtime API 声明测试，共 4 文件 10 项通过；错误赋值保留 `TS2322` 和退出码 1。日志 `/data/data/com.termux/files/usr/tmp/lg-ts7-compiler-tests.log`。
- 后端回归：API、保存路径桥、翻译 runtime/service、bootstrap、工作区、Chromium 参数与错误契约，共 9 文件 169 项通过；日志 `/data/data/com.termux/files/usr/tmp/lg-ts7-node-regression.log`。
- 前端回归：受影响的 renderer 8 文件 53 项全部通过（`--maxWorkers=2`），日志 `/data/data/com.termux/files/usr/tmp/lg-ts7-renderer-all-final.log`。首次一项失败由本轮测试参数重命名误改造成，修正后单文件及整组均复验通过。
- Web 构建：`npm run build:web` 通过；编译器缓存与 Go 工具不进入 `build/web/`。日志 `/data/data/com.termux/files/usr/tmp/lg-ts7-web-build-final.log`。
- Agent 冒烟：重建后 `node buildtools/web-agent-chain-verify.mjs --script=glossary --keep=true` 三场景 3/3、编排 6/6 通过，服务停止后 Chromium profile / 进程为零；日志 `/data/data/com.termux/files/usr/tmp/lg-ts7-agent-final.log`，临时数据根 `/data/data/com.termux/files/usr/tmp/lg-web-agent-verify-wcqZx9/`。
- 静态与文档：`npm run check`、`npm run lint`、本任务显式路径格式检查与 `git diff --check` 通过；lint 保留两个既有告警。方案补充本机源码构建路径，操作标准链接准备入口，WORKFLOW 维护 Go 首次准备与缓存使用方法；相对链接及任务记录一致性检查通过。
- 适用边界：解除本机类型检查工具链阻塞，编译器与测试均在 Android 原生环境执行；不证明 Android 浏览器系统交互、真实供应商、图片/PDF 视觉或其它 Android 架构。已有无关改动保留，未创建提交。

### V-018：对 V-016 / V-017 的独立复核与一处 renderer 补修（第十轮）

- 日期：2026-10-18；关联任务：`TW-02`、`TW-07`、`TW-09`、`R-01`、`R-17`；基线：`6f2c40c9` 加此前各轮未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155。
- 目的：不依赖上一轮的自述结论，由另一方重跑关键证据。
- 复核一（构建配置）：`buildtools/build-web.mjs` 服务端构建确为 `build.ssr: true` + `modulePreload: false` + `ssr: { noExternal: true }`；产物中已无 `__vitePreload`，`gui-backend-bootstrap` chunk 内没有未防护的 `document` 读取（只有局部变量、字符串与 `debug` 包的 `typeof document` 防护），外部导入只剩 `node:` 内置、`mupdf` 与 `fs` 系列。补充 A/B：仅去掉 `noExternal` 保留 `build.ssr: true` 时 Agent 三场景仍通过，与"根因是浏览器构建注入了预加载器"一致——单靠依赖打包并不能复现或修复该故障。
- 复核二（Agent 与 Chromium 宿主）：`node buildtools/build-web.mjs` 后执行 `node buildtools/web-agent-chain-verify.mjs --script=host`，编排 9/9 通过——访问会话、能力事实（`imageHost=true pdfHost=true`）、模型配置、审批模式、探针三场景（`full-chain` / `cancel` / `reconnect`）、Chromium 图片宿主（`emitImage` → `image/webp` 24×16）、Chromium PDF 宿主（`host({kind:"print_pdf"})` → `%PDF-` 57753 字节）、进程与 profile 回收、服务以退出码 0 停止。此前发现的临时 profile 清理失败把正常停止变成退出码 1 已修复（进程组信号 + 有界重试 + 不再向上传播）。
- 复核三（Android TypeScript）：`build/toolchains/typescript/7.0.2-android-1-arm64/tsc --version` 为 `7.0.2`；对合法文件退出 0、对含 `TS2322` 的非法文件退出 1；`npm run typecheck` 退出 0 且无输出（`tsc -b` 成功即静默），三个 `*.tsbuildinfo` 均刷新。
- 复核四（全量测试）：node 项目 370 文件 2868 项，2855 通过、11 失败、2 跳过；renderer 项目 207 文件 1176 项，1175 通过、1 失败。失败文件为 `src/index.test.ts`、`buildtools/vite/renderer-runtime-reload.test.mjs`、`src/native/agent-image-host.test.ts`、`src/native/native-fs.test.ts`（Windows 盘符根语义）、`src/native/pdf-host.test.ts`、`src/backend/file/rpgmaker-mv-mz/javascript.test.ts`、`src/backend/file/rpgmaker-rgss/ruby.test.ts`、`src/backend/file/shared/rpgmaker-prepare.test.ts`（3 项，readdir 顺序）、`src/backend/file/subtitle/vtt-format.test.ts`、`src/backend/agent/workspace/runtime/bootstrap.test.ts`、`src/gui/preload/index.test.ts`——全部属于 V-006 / V-009 已登记的真实 Electron / Chromium / ASAR 依赖或平台差异，失败数少于既往登记值。
- 补修（本轮唯一代码改动）：`src/frontend/app/index.test.tsx` 的 `desktop-api` mock 缺 `open_event_stream` / `api_get` / `api_fetch`。应用壳无条件挂载 `WebFilePickerHost`，其中的保存位置桥接会订阅 SSE 与 pending 列表，mock 不完整即在渲染期抛错。该失败在此前按范围验证中未被覆盖，属既有失败而非本轮回归。按"测试补齐所测模块表面"修复，未改动产品挂载行为——把宿主改为按 web 模式条件挂载会牵连开发态无注入启动配置的场景，风险大于收益。
- 附带修正：复核用脚本 `buildtools/web-agent-chain-verify.mjs` 的 PDF 证据正则要求 `header=%PDF`，实际文件头为 `%PDF-`；进程回收检查曾把清理命令自身字面量当匹配项，改为要求 `--user-data-dir=` 与 profile 名同时出现，或匹配宿主可执行文件路径。两者都只影响验证脚本，不影响产品。
- 静态与文档：`npm run check` 五项、`npm run lint`（保留两个既有告警）、改动文件格式检查与 `git diff --check` 通过。
- 适用边界：证明上一轮的两项解除在本机可被第三方复现，并给出全量测试基线；不证明真实模型供应商、图片/PDF 视觉结果、Android 真机系统交互与其它架构。未创建提交。

### V-019：宿主能力如实投影与 Chromium 打印缺陷修复（第十一轮）

- 日期：2026-10-18；关联任务：`TW-07`、`TW-09`、`R-07`；基线：`6f2c40c9` 加此前各轮未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155。
- 实现一（模型可见能力投影）：`AgentImageService` 改为可无宿主构造，新增 `available` 能力事实，未注入宿主时按 `runtime.capability_missing`（`reason: image_host_unavailable`）回答；`AgentWorkspaceService` 新增 `host_capabilities` getter 并纳入 `AgentWorkspacePort`；`format_agent_workspace_typescript_api()` 改为按能力过滤成员，能力缺失时不声明 `emitImage` 与 `host`；`workspace_run` 工具说明新增「宿主能力」段，明确本次运行可用 / 不可用及原因；`web-entry.ts` 不再注入必然失败的图片宿主，`GuiBackendBootstrapOptions.imageHost` 与 Web 传输选项随之按缺失传递。
- 实现二（Chromium 打印缺陷）：`ChromiumBrowser.open_page()` 的 `Network.setBlockedURLs` 由通配 `*` 改为按可外联协议拦截（`http` / `https` / `ws` / `wss` / `ftp` / `ftps` / `file`），`data:` 与 `blob:` 不再被拦。
- 验证一（单元与静态）：新增 / 调整测试——`agent-image-service` 无宿主能力缺失 1 例、`workspace-run` 能力齐备与缺失两种说明投影 2 例、`api-description` 缺失成员不声明且 TypeScript 反例成立 1 例、`workspace/service` 宿主能力按注入报告 1 例、`chromium-browser` 拦截清单不拦进程内数据且覆盖外联协议 2 例；`npm run typecheck`、`npm run check`、`npm run lint`（保留两个既有告警）、显式路径格式检查与 `git diff --check` 全部通过；受影响目录测试（native 6 文件 37 项、agent 工作区 / 服务 / bootstrap / file/pdf 8 文件 228 项）全通过。
- 验证二（真实宿主视觉验收，人工查看）：真实 Chromium 宿主 + 真实应用排版 CSS 打印两页文档（`/data/data/com.termux/files/usr/tmp/lg-visual-probe-2/`）：第 1 页为中文字体标题、中英与等宽混排正文、带表头底色的表格、列表、带左边框引用、等宽代码块；第 2 页为块级公式、脚注引用、带图注的合成图片（色条 + 渐变）与底部分隔线脚注区。PDF 内嵌字体经字节检查为 `LGBaseFont-Regular`、`LGBaseFont-Bold` 与三个 KaTeX 字体；图片宿主对 320×200 合成 PNG 产出 `image/webp`、尺寸与原图一致，人工查看色条与渐变无失真。分页为 2 页，PDF 100892 字节，WebP 1208 字节。
- 验证三（缺陷根因与修复证据）：修复前 `Network.setBlockedURLs(["*"])` 同时拦掉 `data:` 图片与字体请求——打印页面中已知良好的 `data:` PNG 也无法加载（`naturalWidth` 为 0），带图 PDF 的图片与嵌入字体会静默缺失；改为按协议拦截后同一页面图片加载成功（`load 24`），CSP（`default-src 'none'; img-src data:; font-src data:`）与网络拦截共同保留外部访问边界。真实宿主连续两次打印均稳定嵌入应用字体。
- 验证四（运行态能力事实）：以 `LINGUAGACHA_CHROMIUM_PATH=/nonexistent/chromium` 启动真实服务，`/api/web/bootstrap` 报告 `imageHost=false pdfHost=false`（修复前会因注入必然失败宿主而误报 `true`）；Chromium 就绪时端到端 `node buildtools/web-agent-chain-verify.mjs --script=host --keep=true` 编排 9/9 通过（含 `emitImage` 与 `print_pdf` 真实字节、进程与 profile 回收、退出码 0）。
- 期间排除的假象：vitest 环境里 `pdf-print.css?raw` 导入为空，曾据此外推「打印字体必然回退 DejaVu」；用磁盘读取 CSS 复刻真实文档结构复测，证明不强制布局字体同样嵌入，该改动无收益已撤销，未进入产物。
- 未运行：宿主崩溃 / 超时 / 取消的真实 Chromium 证据；真实供应商与完整工作区权限矩阵；Android 真机。未创建提交。
- 适用边界：证明宿主能力说明与能力报告按真实注入投影，以及 Chromium 打印资源边界缺陷已修复且版面 / 图片输出经人工查看；不证明真实模型供应商与真机系统行为。

### V-020：Chromium 宿主真实浏览器弹性证据（第十二轮）

- 日期：2026-10-18；关联任务：`TW-09`、`R-07`；基线：`6f2c40c9` 加此前各轮未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155。
- 实现：新增 `src/native/chromium-host-resilience.test.ts`（6 个用例），驱动真实 `ChromiumBrowser` 与真实图片 / PDF 宿主，只以测试自有夹具补充工作量；找不到 Chromium 可执行文件时整组 `describe.skip`，不用假页面伪装通过。
- 方法一（取消，真实浏览器）：3000×3000 合成 PNG（确定性噪声行重复而成，压缩快、软件 WebP 编码成本高）走真实图片宿主；导航完成、页面内编码在途时按调用方原因取消——任务按原原因拒绝，收敛耗时短于同机一次完整编码，随后同一浏览器进程完成完整编码，证明页面已释放且宿主未留在半坏状态。
- 方法二（任务级超时，真实浏览器）：图片宿主以 `timeoutMs=400` 在真实编码途中超时（拒绝值为 `TimeoutError`），页面释放后小图编码仍成功；PDF 宿主以 `timeoutMs=1200` 加 900 页合成文档在打印途中超时——实测单页打印约 400ms、900 页约 3s，预算稳定落在打印途中，用例末尾的单页跟进打印有约 3 倍余量，超时后同宿主完成单页打印并校验 `%PDF-` 文件头。
- 方法三（宿主进程崩溃，真实浏览器）：任务在途时先断言产品代码确实启动了主进程，再按进程组 `SIGKILL` 杀死真实 Chromium——在途任务立即以 `runtime.internal_invariant` 拒绝（`chromium_exited` 或 `chromium_debug_socket_closed`，两者都表示宿主进程消失），后续图片与 PDF 请求快速失败且不挂起（有界 30 秒内），`dispose()` 正常结束，无遗留进程与临时 profile。
- 稳定性：修正两处用例自身问题后连续 4 次运行 6/6 通过（9.5~11.6 秒）。两处问题均为夹具与预算标定，不是产品缺陷：① 夹具目录名 `lg-chromium-resilience-` 与宿主 profile 前缀 `lg-chromium-` 冲突，被残留断言误报（改用 `lg-print-resources-`）；② PDF 超时预算 400ms 过紧，跟进单页打印也超时（实测阶段耗时后改为 900 页 + 1200ms）。
- 门禁：`npm run typecheck`、`npm run check`、`npm run lint`（保留两个既有告警）、新文件显式路径格式检查与 `git diff --check` 全部通过；`src/native` 目录 3 个失败为 V-006 / V-018 已登记的 Electron 依赖（`agent-image-host.test.ts`、`pdf-host.test.ts`）与 Windows 盘符根语义（`native-fs.test.ts`），与本次改动无关。
- 全量套件（本轮补跑）：node 项目 2881 项，2866 通过 / 13 失败 / 2 跳过（246 秒）。13 个失败 = V-006 / V-018 已登记的 10 个文件共 11 项（真实 Electron / Chromium / ASAR 依赖与 readdir 顺序、Windows 盘符根语义）+ `bootstrap.test.ts` 文件级加载失败（Electron 未安装，0 个用例执行）+ 新观测的 `log-file-store.test.ts` 2 项。后者根因经探针证实为平台文件系统时间戳粒度：连续三次快速同尺寸写入的 `mtimeMs` / `ctimeMs` 完全相同，而该测试靠时间戳变化识别等字节替换；单独重跑 3 次均复现 1~2 项失败。其出现取决于替换写入是否跨过时间戳刻度：V-009 / V-018 的满载套件中未出现，本轮满载套件中出现。`log-file-store.ts` 与其测试在工作区未修改，本轮唯一改动是新增未跟踪测试文件，不触及日志代码。renderer 项目本轮无改动，未重跑。
- 未运行：宿主峰值资源（内存 / CPU）记录，仍属 `R-07` 剩余项；Android 真机与真实供应商不在本任务范围。
- 适用边界：证明崩溃 / 超时 / 取消三种边界在真实 Chromium 上的可观察行为与进程 / profile 回收；不证明峰值资源、真实供应商与真机系统行为。未创建提交。

### V-021：范围收敛、仓库外部署验证与同数据根多开证据（第十三轮）

- 日期：2026-10-18；关联任务：`TW-02`、`TW-11`、`R-02`、`R-05`、`R-13`；基线：`2a36b113`（第十二轮提交）。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155。
- 范围决定（用户）：移植目标收敛为小说翻译（TXT / Markdown / EPUB / PDF 与术语、提示词、规则、校对工作流）；游戏文本（RPG Maker MV/MZ/RGSS、RenPy、KVJSON/MESSAGEJSON、TRANS/WOLF TRANS、WOLFXLSX）与字幕形式冻结——保持实现与既有覆盖（`V-013`），不再投入迁移验收，未验项登记为范围外；能力不从产品中移除。方案新增 1.1 记录该决定与边界，任务表、风险表与下一步同步更新。
- 实现一（构建清理）：`buildtools/build-web.mjs` 移除 `backend-runtime-worker-entry` 输入。核对依据：该入口只由桌面产品入口 `src/index.ts` 经 `build_backend_runtime_worker_entry_url_from_desktop_bundle_dir` 加载（`gui-entry.ts` 创建 `BackendRuntimeClient`），Web 路径（`web-entry.ts` → `GuiBackendBootstrap`）不创建该客户端；桌面构建（`electron.vite.config.ts`）不受影响。重新构建后产物为服务入口 + 4 个 worker 入口。
- 实现二（部署验证脚本）：新增 `buildtools/web-deploy-verify.mjs`，12 项检查；新增 `buildtools/web-multi-instance-verify.mjs`，10 项检查。两者只依赖 Node 标准库与仓库开发依赖生成夹具（jszip / iconv-lite），不读取仓库真实样例。
- 验证一（仓库外部署，R-02）：复制 `build/web` 到仓库外临时目录，以该目录为 cwd、全新数据根启动正式入口。连续 3 次运行 12/12 通过：访问会话、部署产物完整（5 个入口与 `dist` / `builtin` / `resources` / `version.txt`）、能力事实、小说格式上传与命中（GBK / UTF-8 TXT ×2、Markdown、EPUB、PDF）、工程创建无失败文件、工程内容落库（5 个文件且条目总数大于零）、prepare worker 部署加载（MV/MZ 工程建成，oxc 原生绑定与 worker 入口在部署位置加载；游戏功能已冻结，仅作部署完整性）、工程副本（`SQLite format 3`）、翻译统计回读、全程无浏览器启动、退出码 0。部署目录无 `node_modules`：小说依赖随入口 bundle 打包，mupdf 等经 `resources/workspace/node_modules` 随部署发布。
- 验证二（同数据根多开，R-13）：连续 2 次运行 10/10 通过。双实例均可启动与会话；B 跨进程打开 A 的工程并读到相同文件 / 条目数；A 删除文件成功后，B 以过期修订删除被 409 `data.revision_conflict` 拒绝（跨进程冲突在数据库事务内检测，不静默覆盖）；B 重读清单后用新修订删除成功；终态两实例读取一致（文件与条目均为 0），工程副本可生成；停止 A 后 B 仍可读，双实例退出码均为 0。
- 验证三（静态门禁）：`npm run check`、`npm run lint`（仅两个既有告警）、`npm run typecheck`（无 TypeScript 改动，按批次收尾规则未单独重跑）、三个改动 / 新增脚本的格式检查与 `git diff --check` 通过。
- 结论（R-05）：Web 服务进程自持组合根，重型计算由 work-unit / planning / rpgmaker-mv-mz-prepare / compute 四个 worker 池承担，翻译期间 API 响应与空闲同量级（`V-011`）；桌面 Backend Runtime worker 的职责是 Electron 主进程隔离，Web 服务进程即后端，无需第二隔离边界，该风险解除。
- 结论（R-13）：证据支持当前单用户本地形态不加单写入口锁——冲突可检测、可重试、无数据损坏；是否增加"第二实例"产品提示属产品决策，最终锁策略待部署形态确认。
- 未运行：宿主峰值资源（`R-07`）；翻译 worker（work-unit / planning）的仓库外加载证据（需配模拟模型从部署目录跑一次翻译，列入 `TW-11` 长任务轮）；Android 真机与真实供应商。
- 适用边界：证明小说路径可在仓库外干净目录运行、运行依赖随部署加载、同数据根多开不损坏数据；不证明峰值资源、翻译 worker 的仓库外加载与真机行为。未创建提交。

### V-022：EPUB 浏览器闭环、多语言下载边界与 pending 契约修复（第十四轮）

- 日期：2026-10-18；关联任务：`TW-05`、`TW-04`、`R-12`、`R-06`；基线：`2a36b113` 加第十三轮改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155、Playwright Core。
- 实现：新增 `buildtools/web-novel-loop-verify.mjs`（13 项检查），Playwright Core 驱动本机 Chromium 走真实界面流程；修复 `agent-save-path-bridge.ts` 的 pending 领取方法错配并补 renderer 契约测试。
- 验证一（EPUB 闭环）：连续 3 次运行 13/13 通过。界面路径：带凭据进入 → 取消首启更新提示 → “点击或拖拽源文件 → 选择文件 → 上传文件”上传合成 EPUB → 摘要“已选择 1 个源文件” → “创建工程” → 保存选择器切到“应用数据”根后确认（工程落临时数据根，不写用户主目录）→ 应用进入 AGENT 页 → 侧栏进入工作台 → 文件表显示 `book.epub` → “生成译文”→ 确认 → 下载清单 → 捕获浏览器下载（1325 字节）并校验内容含 EPUB 正文。
- 验证二（R-12 多语言下载边界）：同一会话内经侧栏语言菜单切换 English，界面文案随之切换；再次生成译文并下载成功（内容同样含正文）；对切换前的中文输出目录下载链接直查返回 **403 `translation_download_outside_output_directories`**——R-12 描述的边界从推测变为实测：切换语言后旧语言目录不可下载，新语言目录可下载。
- 验证三（缺陷修复）：修复前浏览器控制台出现 `GET /api/agent/save-path/pending` 404（路由只注册 POST，领取被 try/catch 静默吞掉，迟连接窗口的保存位置请求永远领不到；SSE 增量路径正常故既有测试未暴露）。改为 `api_fetch(path, {})` 后 404 消失；renderer 测试新增“迟连接领取按 POST 契约读取驻留列表”断言（mock 记录方法），`src/frontend/features/web-file-picker` 3 文件 17 项通过。
- 验证四（门禁与回归）：`npm run typecheck`、`npm run check`、`npm run lint`（仅两个既有告警）、改动文件格式检查通过；重新 `node buildtools/build-web.mjs` 后复跑浏览器验证 13/13。
- 新观测（产品面，未处理）：Web 首启会弹出桌面式更新提示（“检查到 LinguaGacha v0.129.0，是否下载更新”），取消后可继续；**确认后的下载 / 安装路径在 Web 传输下未验证**，归入 `TW-04` 更新入口剩余项。
- 过程修正（验证脚本自身，非产品缺陷）：① 建工程后应用落在 AGENT 页而非工作台，早期版本据“生成译文”文本误判已进工作台（该按钮在 AGENT 工具栏也存在）——改为显式点击侧栏“工作台”；② 保存选择器默认根是 Termux 主目录，早期调试运行把工程写进用户主目录（已清理）——脚本改为切到“应用数据”根；③ 无校对警告时生成确认弹窗主按钮是“确认”而非“继续生成”——改为按弹窗实际形态点击。
- 未运行：`R-06` 的浏览器不在线场景（请求驻留 → 重连领取 → 应答）尚未经真实浏览器驱动；宿主峰值资源（`R-07`）；Android 真机与真实供应商。
- 适用边界：证明 EPUB 在真实浏览器界面完成导入到导出闭环、多语言下载边界的实测行为与 pending 契约修复；不证明离线驻留场景、峰值资源与真机行为。未创建提交。

### V-023：Agent 保存位置驻留与迟连接领取验证（第十五轮）

- 日期：2026-10-18；关联任务：`TW-07`、`R-06`；基线：`2a36b113` 加此前各轮未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155、Playwright Core。
- 实现：新增 `buildtools/web-agent-save-path-verify.mjs`（14 项检查），REST 驱动后端事实、Playwright 驱动两个浏览器会话，覆盖 R-06 的“等待或领取语义及断线恢复”。
- 验证一（无浏览器驻留）：真实服务 + 临时数据根；REST 建小说工程并上传 Agent 附件；订阅 SSE 后触发 `activate-path`（`{path}` 契约）——SSE 收到 `agent.save_path_event`（`request_id` + 默认名）、`POST /api/agent/save-path/pending` 返回 1 个驻留请求、激活调用不返回。
- 验证二（领取后断线）：浏览器 #1 登录后桥接自动领取 pending，保存选择器打开且默认名预填为附件名；**不回答直接关闭浏览器**——请求仍驻留（pending 仍为 1、激活调用仍未返回）。
- 验证三（再次领取与应答）：浏览器 #2 登录后再次领取，保存位置切到“应用数据”根后确认——激活调用以 `{status:"saved"}` 收尾、pending 清空、目标文件落盘且内容与附件逐字一致（27 字节）。
- 稳定性：连续 3 次运行 14/14 通过；`npm run lint`（仅两个既有告警）与新脚本格式检查通过（无 TypeScript 与产品代码改动，typecheck 未重跑）。
- 过程修正（脚本自身）：① `activate-path` 请求字段是 `path` 而非 `href`（400 后查契约修正）；② 两处 `.mjs` 误带 TypeScript 标注（启动即失败，已改）。
- 未运行：宿主峰值资源（`R-07`）；Android 真机与真实供应商；`TW-11` 备份恢复 / 更新流程 / 30 分钟长任务。
- 适用边界：证明保存位置请求在无前端、前端断线两种情况下驻留并可被后续浏览器领取应答，保存真实落盘；不证明峰值资源、超时兜底的真实浏览器表现（由单元测试覆盖）与真机行为。未创建提交。

### V-024：C 类决策落地、A 类收尾与冻结功能阻塞性检查（第十六轮）

- 日期：2026-10-18 深夜（约 22:39 至 23:58，用户要求中止 A3 后收尾）；关联任务：`TW-02`、`TW-05`、`TW-07`、`TW-09`、`TW-10`、`TW-11`、`R-07`、`R-12`、`R-13`、`R-15`；基线：`2a36b113` 加第十三至十五轮未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155、Playwright Core、可用内存约 2.9GB。**本轮全部改动未提交。**
- 实现一（C1 真实供应商）：新增 `buildtools/web-stepfun-provider-verify.mjs`，经 `POST /api/models/add|update|select` 把翻译 / Agent / Agent 批译三种用途指向 `https://api.stepfun.com/step_plan/v1`（`step-3.5-flash`，密钥取自环境变量 `STEPFUN_API_KEY`）。
- 实现二（C2 仓库链接）：`desktop-api.ts` 更新检查 URL、`index.tsx` 仓库入口、`app-metadata-service.ts` User-Agent 改指本地仓库；wiki 文档链接保留上游（fork 无 wiki）。
- 实现三（C3 决策 C）：`translation-file-generation-service.ts` 输出目录边界放宽到 `APP_LANGUAGE_DEFINITIONS` 全部语言（撞名时间戳规则不变），新增 `read_output_files()` 与路由 `POST /api/translation/files/outputs`，前端生成成功后合并各语言输出目录进下载清单（列举失败降级为仅本次生成）。
- 实现四（C4 决策 B）：新增 `web-instance-marker.ts`（数据根 `web-instance.json`，wx 排他创建 + pid 存活判定 + 陈旧重建 + 按 pid 删除）；`web-entry.ts` 启动占位并打印冲突警告；bootstrap 新增 `anotherInstance`；前端新增可关闭 toast（5 语言 i18n）。
- 实现五（A 类脚本）：`web-chromium-host-resource-probe.mjs`（宿主峰值资源）、`web-lg-copy-regression.mjs`（副本回归）、`web-backup-restore-verify.mjs`（备份恢复）、`web-instance-conflict-verify.mjs`（双实例真实验证）；A5 修复两个测试文件。
- 验证一（C1，连续运行，末次 10/10 PASS，exit 0）：访问会话 204；语言设置 `source=EN target=ZH`；模型三用途配置成功；合成英文小说（11 条目）上传、摘要 `txt=1`、工程创建无失败文件、条目落库 11；翻译受理后 `status=done processed=6/6 error=0 tokens=1812`（5 个空行按规则跳过，属正确行为）；生成译文文件 2 个，下载内容为中文译文（“灯塔管理员在黎明爬上了楼梯。”）且与原文不同；真实 Agent 对话经 SSE 收到助手回复；无浏览器启动、退出码 0。
- 验证二（C2，实测判断）：本地 fork `breakyuna/LinguaGacha-Termux` 的 `releases/latest` 返回 404（无任何 release）；`check_github_release_update` 对非 200 静默返回 null → 改指向后每次页面加载仅一次 404 调用、无提示；Web 路径 `autoUpdate=false` → 确认后打开发布页，不下载不安装；结论：维持现状，fork 将来发布 release 即自动生效。测试：`app-metadata-service.test.ts` 2/2、`desktop-api.test.ts` 14/14。
- 验证三（C3，单元与契约）：`translation-file-generation-service.test.ts` 23 通过（新增：切换语言后旧语言目录与撞名目录仍在界内且可下载、五种语言目录都进边界和清单、生成路径与回执清单不变）；`api-routes.test.ts` 21 通过（新路由契约 + 公开路径登记）；renderer `translation-generation` 14 通过（合并与降级）。`--project node src/backend/file src/backend/api` 635 项 631 通过，4 失败为已登记 Electron 环境失败与并发代理瞬时改动。**浏览器级复验未做**（`web-novel-loop-verify.mjs` 断言已改为预期可下载，待跑）。
- 验证四（C4）：单元/网关/renderer 96 + 31 + 273 通过（含标记 9 用例：新建、EEXIST+pid 存活、pid 已死陈旧重建、空/半行内容、自 pid、停止清理、不误删他人标记、5 路并发只有一个胜出、数据根不可用降级）；**真实双进程验证 11/11 PASS**（`web-instance-conflict-verify.mjs`）：单实例 `anotherInstance=null` 且标记记录本实例 pid/端口；第二实例健康检查 200（不被阻止）、bootstrap 报告 `{"pid":<第一实例>,"port":<第一实例端口>}`、启动输出含“同一数据根已有另一个实例在运行”警告；第二实例停止不删他人标记；第一实例停止后标记删除；陈旧标记（已退出 pid）不误报且重建为本实例；收尾标记删除。
- 验证五（A1 宿主峰值资源，3 次运行 10/10）：空闲基线 0 MB；图片任务 `emitImage` 峰值 RSS ~1130-1145MB（PSS ~359MB）、CPU ~2.7-3.3s；PDF 任务 `print_pdf` 峰值 RSS ~1750-1880MB（PSS ~701MB）、CPU ~3.2-3.9s；进程树峰值 15 个进程；服务停止后进程与 profile 均为 0。口径说明：RSS 为进程树 VmRSS 之和、重复计入共享页（约 2.5 倍虚高），PSS 更接近实际独占；图片阶段 CPU 主要是浏览器冷启动。
- 验证六（A2 副本回归，4 次运行 20/20，纯 REST）：数据根 A 建合成小说工程（3 文件 14 条目）→ 生成副本（180224 字节，`SQLite format 3`）→ 停 A → 全新数据根 B 打开副本：文件清单（含 file_type/sort_index/每文件条目数）、条目数、统计、14 条逐条原文全部一致；数据库级复核 17 张表逐行相同，唯一差异 `meta.updated_at` 为 `load_project` 打开期预期写入。未发现产品缺陷。
- 验证七（A4 备份恢复，3 次运行 24/24）：产品无数据根整包备份/恢复功能（路由与 5 语言 i18n 均无入口；`grep backup` 仅 RPG Maker 内部机制）；唯一显式备份是工程副本（`VACUUM INTO` → `<数据根>/userdata/project-copies/` → 受控下载）。产品路径：备份→删原工程→打开 404→副本放回原路径→工程事实（文件/条目/逐文件条目/6 项统计）与基线逐项相等。运维路径：停服务整目录复制→损坏（删工程 + 写坏 config.json）→恢复到全新数据根→启动→事实一致、`config.json` 字节级恢复、设置（app_language 与最近工程）保留。观察项：config.json 损坏时启动失败呈现原始 `SyntaxError` 堆栈而非归一化 AppError（`model_selection_migration` 设计上的响亮失败，未擅动）。
- 验证八（A5 测试基线修复，28/28，连跑 5 次稳定）：`log-file-store.test.ts` 根因判定为测试假设问题（生产 stamp 机制上限即文件系统时间戳粒度，本机 4ms 量化；漏识别窗口是有界竞态，详情路径仍重读正文）→ 测试改为等字节替换后显式 `utimesSync` 推进 mtime，断言一字未改（临时注掉该行可复现原失败）；`rpgmaker-prepare.test.ts` readdir 顺序断言改为排序后比较。`npm run check`、`npm run lint`、格式检查通过（lint 保留两个既有告警）。
- 验证九（A3 长任务，**未完成，用户中止**）：`web-long-task-verify.mjs` 从仓库外部署目录启动 + 延迟 mock 模型。第 2 轮完整跑完并取得可用证据：12000/12000 条 `done`、翻译段约 21.5 分钟、44 次采样健康检查 5-18ms 与快照 9-18ms（与空闲同量级）、SSE revision 严格递增至 1438 无断流、服务退出码 0。第 3 轮稳定性复跑于 23:58 被用户要求中止（kill 验证脚本、部署服务与 bash 包装进程；已确认无残留进程与 profile）。脚本尚有 3 处中文异常文本违反错误契约（213/560/837 行）待修。
- 验证十（冻结功能阻塞性检查，只读调查，无任何改动）：结论为**不阻塞运行、无产品 bug**。证据：① Web 构建产物含 MV/MZ prepare worker（`build-web.mjs` 输入清单），oxc-parser 与 @ruby/prism 随 `resources/workspace` 部署且在仓库外部署目录实测可加载（prism 为 WASM，154 个导出全部可用）；② `src/backend/file` 生产代码零 electron 导入（仅 3 个测试文件引用）；③ 本机 4 个失败测试全部是夹具环境依赖——`javascript.test.ts`/`ruby.test.ts` 把 Electron 可执行文件当仓库外 Node 运行时，`vtt-format.test.ts` 需要真实浏览器环境与原生 TextTrack 做交叉验证（生产 VTT 解析是纯 TS `parse_text`）；④ RGSS/MV-MZ 解析器在共享 bootstrap 按 workspaceRuntimeDirectory 配置（`backend-services.ts:155-156`）；⑤ MV/MZ 导出为纯文件写回；⑥ 生成后“打开目录”在 Web 注入能力缺失宿主，失败被捕获并仅记日志，不推翻译文已写出的事实；⑦ 前端无格式特定的桌面门禁入口，导入走格式无关的自动发现。
- 门禁状态：`npm run typecheck` 通过（C3/C4 落地后复跑 exit 0）；`npm run check` 基础层/GUI/前端/后端边界通过，错误契约仅剩 `web-long-task-verify.mjs` 4 处（A3 中止时其在制）；`npm run lint` 两个既有告警；本轮新建/改动脚本与产品文件的格式检查通过（`web-instance-conflict-verify.mjs` 一处中文异常文本与 4 个脚本的格式问题已修）。
- 未运行：全量 node/renderer 套件；novel-loop 浏览器复验（决策 C）；Android 真机；真实供应商其它协议与长时稳定性；翻译 worker 仓库外加载的第 3 轮复跑。
- 适用边界：证明 C 类四项决策在本机可运行且机器契约正确、A 类四项收尾工作完成、冻结功能无阻塞；不证明浏览器级跨语言下载体验、真机系统行为与 30 分钟长任务的第三轮稳定性。未创建提交。

### V-025：A3 长任务登记、novel-loop 复验、安全审查修复与移动端适配（第十七轮）

- 日期：2026-10-19；关联任务：`TW-05`、`TW-11`、`TW-08`、`TW-09`；基线：`2a36b113` 加第十六轮全部未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155、Playwright Core。**本轮全部改动未提交。**
- 实现一（A3 脚本收尾）：`web-long-task-verify.mjs` 的 3 处中文异常文本改英文、移除只写不读的 `translate_ended_at`、ANSI 剥离正则加行内禁用并注明原因；`web-chromium-host-resource-probe.mjs` 移除死变量与未用导入。
- 实现二（安全修复一）：`api-gateway-server.ts` 新增导出 `build_web_bootstrap_script_tag()`，内联启动配置的 JSON 把 `<` 转义为 `\u003c` 后再进入 `<script>` 标签。
- 实现三（安全修复二）：`web-file-service.ts` 的 `resolve_controlled_path` 从"词法界内或真实界内"改为"真实路径不得逃出词法命中的边界，且真实（或词法）路径至少位于一个边界内"——界内符号链接指向界外的下载请求被拒绝，经符号链接进入界内的既有放行不变，文件不存在时仍由 stat 给出 not_found。
- 实现四（安全修复三）：`resolve_directory_path` 在词法边界之外增加真实路径边界检查，目录浏览不再能沿符号链接逃出允许根。
- 实现五（移动端适配）：新增 `web-file-picker-dialog.css`，`(hover: none), (max-width: 767px)` 下列实行铺满 40px 行高、xs/sm 小按钮补足 40px 触摸目标；对话框组件加对应类名。
- 验证一（A3 长任务证据登记）：第 2 轮运行 31/31 PASS——部署副本与构建哈希一致（3385 文件）、worker 探针范围受控、仓库外启动与能力事实、空闲基线、12000 条目合成小说、翻译 `done 12000/12000 error=0`、命令身份去重回放、译文 12000 行逐行一致（1752893 字节）、统计 100%、SSE 1437 事件 revision 2→1438 零违论且 keepalive 2560 次未断开、翻译期间 health avg 17.7ms / snapshot avg 12.8ms（与空闲同量级）、**work-unit 与 planning worker 均从仓库外 deploy 目录加载（探针日志实证）**、WorkerThread 9 个、控制台与 stderr 零错误、退出码 0 无残留。
- 验证二（novel-loop 复验决策 C，14/14 PASS）：EPUB 上传→摘要→创建→工作台→生成→下载全链路；切英文后下载清单含 4 个文件（各语言输出目录合并生效）、英文目录可下载、**旧语言目录 HTTP 200**（决策 C 生效）、进程与 profile 回收、退出码 0。期间修正验证脚本：更新检查指向 fork 后的 GitHub 404 按 URL 显式容忍（资源类控制台错误改由 failed_responses 按 URL 断言）。
- 验证三（全量测试基线）：node 2883 通过 / 9 失败 / 2 跳过；renderer 1179 通过 / 2 失败。失败全部为已登记环境依赖（8 个文件）加两个负载抖动项——`chromium-host-resilience.test.ts`（满载下 PDF 超时预算敏感，单独复跑 6/6）与 `agent-conversation.test.tsx`（单独复跑 48/48）。
- 验证四（真机 OOM 定性）：上传路径实测流式——300MB 文件上传耗时 1.56s，服务 RSS 262MB → 峰值 336MB（瞬时 +74MB）→ 传回回落，服务存活；前端串行上传且直接传 Blob；摘要发现不读文件内容。结论：OOM 是"整目录上传时解析大文件（jszip/mupdf 整载）"的资源边界，非缓冲缺陷；用户决定不修，使用约束为只选小说章节文件上传。
- 验证五（安全审查）：远端 `origin/main` 仍为 `6f2c40c9`（Web 移植全部未推送），审查范围 = 已提交移植 198 文件 + 未提交 29 文件。逐项核对静态资源路径收敛、访问会话（256 位凭据 + timingSafeEqual + 令牌仅存摘要）、Host/Origin 门禁（绑定实际监听地址、API 一律要会话、SameSite=Strict）、材料与副本服务（路径来自服务自有注册表）、保存桥接（服务端 UUID 身份）、启动参数（严格解析）。发现并修复 3 个缺陷（见实现二~四）。新增测试：bootstrap 转义 1 例、下载/浏览符号链接逃逸 2 例；均经"还原原始逻辑即失败"的非空验证（`web-file-service.test.ts` 14/14、`api-gateway-server.test.ts` 全过）。
- 验证六（移动端审查）：全前端无 `onMouseEnter/onMouseOver` 处理器；`:hover` 均为视觉 affordance；8 个 CSS 文件有 `(hover: none)` / 窄视口回退（附件移除常驻、排序 40px 隐形热区等）；共享 `AppPageDialog` 视口自适应（dvh + 内部滚动）。390×844 触屏探针（`web-mobile-picker-probe.mjs`）**13/13 PASS**：整页与对话框无横向溢出、对话框完整位于视口内、**列实行触摸高度 40×5（修复前可点击元素仅 20px）**、29 个可用按钮全部 ≥40px（修复前根按钮 24px、页脚 28px）、选择器内上传合成 TXT 成功、确认后摘要显示已选择源文件、保存选择器无溢出且行高 40px、可切换应用数据根、控制台零错误。
- 门禁：`npm run check` 五项通过；`npm run lint` 仅 2 个既有告警；`npm run typecheck` 通过；`web-file-picker` renderer 17/17。
- 未运行：Android 真机（文件选择器、下载、软键盘、后台回收）；真实供应商其它协议；提交。
- 适用边界：证明 A3 长任务与 worker 仓库外加载、决策 C 的浏览器行为、三个安全缺陷的修复与移动端选择器触屏可达性；不证明真机系统交互。未创建提交。

### V-026：对照代码的移植进度核查与文档归位（第十八轮）

- 日期：2026-10-19；关联任务：`TW-02`、`TW-04`、`TW-07`、`TW-11`；基线：`2a36b113` 加第十七轮未提交改动。只读核查 + 文档改动，无产品代码改动。
- 核查一（宿主消费点迁移）：`window.desktopApp` 直读仅剩 4 处——桥接安装点（`host-bridge.ts` 同时装模块状态与全局，注释说明是为未迁移读取点保留同一契约）、测试 mock、一句 Electron 注释、`desktop-api.ts` 的地址回退（属上述契约设计）。`read_host_bridge()` 覆盖 40 处消费点（工程/工作台/设置/日志/提示词/质量规则/标题栏/外观/拖拽/Agent 通知等）。结论：TW-04 迁移项在代码上成立。
- 核查二（Web 桥契约完整度）：`DesktopBridgeApi` 22 个方法在 `create_web_host_bridge` 全部实现（另加 `appVersion` 属性），能力缺失路径按 `runtime.capability_missing` 明确报告，不伪造成功。
- 核查三（Electron 依赖边界）：生产代码中 electron 导入仅存在于 `src/gui/**`（桌面主进程/preload）、`src/cli/cli-runner.ts`（桌面 CLI）与 `src/native/{pdf-host,window-task}.ts`；后两者只被桌面入口 `gui-entry.ts` 引用，Web 入口改用 `chromium-{image,pdf}-host`。Web 构建产物无 Electron 依赖，与 V-021 仓库外部署证据一致。
- 核查四（worker 与生命周期）：`web-entry.ts` 经 `build_worker_threads_backend_worker_execution_from_desktop_bundle_dir(bundle_dir, ".mjs")` 装配 4 个 worker 池；`web-server-main.ts` 接管 SIGINT/SIGTERM（重复信号共用同一次停止）与 uncaughtException/unhandledRejection；postinstall 在 android 与 `LINGUAGACHA_SKIP_ELECTRON=1` 下跳过 Electron 二进制并提示 Web 路径。
- 核查五（工作区子进程）：Agent 工作区运行时共用 `fork(script, [], {execPath: process.execPath})`，Web 与桌面同一机制，权限、模块钩子、IPC 与取消边界不变（V-016 端到端证据）。
- 文档归位（本轮实际改动）：`ARCHITECTURE.md` 进程隔离节补 Web 第三入口（自持组合根、四 worker 池、Web 传输外壳、实例标记语义）并更新 mermaid；`FRONTEND.md` 宿主接入节改写为 `read_host_bridge()` 单一入口 + Web 访问会话 + 手机触屏模式（40px 热区两种模式）；`BACKEND.md` 新增 Web 传输与访问会话、Web 文件边界两节（同源门禁、暂存三重上限、受控下载符号链接语义、副本边界、第二实例提示语义）；`AGENT_RUNTIME.md` 工作区文件交付补 Web 保存位置驻留/领取/断线语义；`TERMUX_WEB_OPERATIONS.md` 更正 `dev:web` 描述为“构建并启动”（实现无开发服务器与代理，WORKFLOW.md 记载本就一致）。
- 链接与门禁：10 份文档 137 个相对链接全部有效；`npm run check` 五项通过。
- 未发现与 HANDOFF 记载不符的虚报项；未发现新的产品缺陷。遗留：README 无 Termux Web 使用说明（用户文档归位属产品决策）；真机验证项不变。
- 适用边界：证明移植进度与文档记载一致且文档归位完成；不证明真机系统交互。未创建提交。

### V-027：解除冻结格式的翻译闭环与两个产品修复（第十九轮）

- 日期：2026-10-19；关联任务：`TW-05`、`TW-10`；基线：`2a36b113` 加第十八轮未提交改动。环境：Android ARM64 / Termux、Node `v24.18.0`、Chromium 155、Playwright Core。**本轮全部改动未提交。**
- 范围决定（用户）：游戏文本与字幕自 2026-10-19 解除冻结，重新纳入验收。方案 1.1 已修订：纳入字幕（SRT / VTT / ASS / SSA / LRC）与 MV/MZ 游戏目录的服务级 + 浏览器级闭环、RenPy / KVJSON / MESSAGEJSON / TRANS / WOLF TRANS / XLSX / WOLFXLSX 的同链路内容验收；RGSS 服务级闭环（Marshal 夹具复杂度）与目标平台游戏实际启动（Termux 无 Windows / nwjs）仍为范围外，后者以“导出容器可被产品自身重新解析”替代。
- 实现一（服务级闭环脚本）：新增 `web-frozen-formats-loop-verify.mjs`。夹具与仓库矩阵测试同源（自包含复现）；经批次目录走目录导入契约（与 `web-file-picker-dialog.tsx` 的 `WebUploadBatch.directory_path` 一致）；翻译用 `web-long-task-mock-model.mjs`（译文为 `【译】` 前缀 + 源文，姓名字段走 `演员<id>`）。
- 实现二（浏览器级闭环脚本）：新增 `web-subtitle-browser-loop-verify.mjs`，Playwright 驱动真实界面：选择器上传 SRT/VTT → 保存选择器切“应用数据”根 → 建工程 → 工作台 → 翻译 → 生成确认弹窗 → 捕获浏览器下载并校验内容。
- 实现三（产品缺陷修复）：`read_directory_files` 由顶层列举改为递归列举，展示名用相对路径（上限 10000）。修复前：目录导入（文件夹上传、游戏容器）的译文输出是嵌套结构，顶层只有一个目录项被 `isFile()` 过滤——**下载清单为空，用户拿不到任何译文**。修复经单元测试（嵌套目录列举 + 相对路径名）与端到端探针（批次目录导入 → generate 清单含嵌套文件）双重验证。
- 实现四（健壮性修复）：`ProofreadingQueryService.read_filters` 不再把缺失筛选字段实体化成空数组。修复前：读取器以“字段是否存在”区分显式空选择与缺省筛选，实体化让未传筛选的 API 消费者得到空列表（GUI 总是先 sync 所以不受影响）。新增测试覆盖缺失不实体化与显式空数组保留两种语义。
- 验证一（服务级闭环）：`web-frozen-formats-loop-verify.mjs` **51/51 PASS，连续两次 exit 0**。字幕 5 格式：cue 数、时间码逐字不变、正文为译文、WEBVTT 头 / Format 行保留；MV/MZ：容器收拢 `rpgmaker_mv_mz=1`、3 条目、翻译 3/3、导出 JSON 的 displayName / 对白 / 姓名 / gameTitle 均为译文、导出容器回灌后 4 个字段保持可解析；文件型 7 格式：格式命中与条目数正确、KVJSON / TRANS / WOLF TRANS（白名单译、黑名单保留）/ RenPy（新文本译、既有译文保留）/ MESSAGEJSON 内容断言全过，XLSX / WOLFXLSX 落盘校验。
- 验证二（浏览器级闭环）：`web-subtitle-browser-loop-verify.mjs` **22/22 PASS，连续三次 exit 0**。SRT 下载 84 字节：2 cue、时间码逐字不变、正文 `【译】` 译文；VTT 保留 WEBVTT 头与 NOTE 注释；双语文件每个 cue 同时含原文与译文；mock 日志 2 条翻译请求共 4 条目；控制台零错误（GitHub 404 按 URL 容忍）；进程与 profile 回收、服务退出码 0。
- 验证三（回归）：`web-novel-loop-verify.mjs` 14/14（产品修复后小说闭环无变化）；`src/backend/file` + `src/backend/api` 635 通过 / 3 失败（均为 V-006 / V-018 已登记的 Electron / Chromium 夹具环境失败）；`src/backend/proofreading` 38/38；`npm run check` 五项通过；`npm run typecheck` 通过；lint 仅 2 个既有告警。
- 观察项（未修，需产品决策）：Web 文件夹上传的批次目录名（`batch-<ts>-<rand>`）进入资产相对路径，工作台文件表与下载清单展示名带该前缀（桌面端目录导入带的是用户选定文件夹名，是有意语义；下载文件名仍为 basename 不受影响）。建议后续把批次目录命名为用户上传的文件夹名，改动影响新建导入的资产路径，未在本次擅动。
- 未运行：Android 真机；真实供应商对冻结格式的抽样（mock 已证明链路）；RGSS 服务级闭环；目标平台游戏启动；提交。
- 适用边界：证明解除冻结格式在 Web 传输下的翻译闭环与两个产品修复；不证明真机系统交互与真实供应商语言质量。未创建提交。

### V-028：文档整理与 Termux README 重写

- 日期：2026-10-20；基线：`2a36b113` 加当前未提交改动；仅修改文档。
- 核对：Web 启动及参数、构建、Android postinstall、宿主桥、数据路径、文件暂存限制与 `V-001` 至 `V-027` 记录。
- 内容去向：用户安装、使用、备份与限制归 `README.md`；开发定位与验证归 `WORKFLOW.md`；当前结论、风险和下一步归本文；历史验证记录保留原有时点语义。其它语言 README 标明尚未同步 Termux 文档。
- 验证：145 个相对链接及对应锚点、12 个唯一任务行与合法状态、28 条验证记录检查通过，`git diff --check` 通过；未重跑构建、测试、浏览器或真机验证，不新增运行能力声明。
- 未决：第 7 节产品验收事项不变；未提交、未推送。

## 6. 风险与未决事项

以下是待验证风险，不表示已经发生实施阻塞。

|编号|问题|处理任务 / 解除依据|
|---|---|---|
|`R-01`|官方 TypeScript 7 npm 包缺少 Android 预编译程序|已解除：固定同版本源码、校验 SHA256 并编译 Android ARM64 版本，`npm run typecheck` 本机检查全部引用项目通过（`V-017`）；首次准备需 Go|
|`R-02`|正式部署的原生绑定、WASM 和 SDK|小说路径已仓库外验证（`V-021`：jszip / mupdf / chardet / iconv-lite / SQLite 与 prepare worker 在部署位置真实加载）；`@ruby/prism` WASM 在仓库外加载见 `V-024`；方案 1.1 仍排除 RGSS 服务级完整闭环，模块加载不代替格式闭环|
|`R-03`|浏览器文件无法沿用桌面绝对路径语义|已解除：后端材料解析、受控下载与浏览器选择器端到端均已实现并验证（`V-008`、`V-009`）；文件夹相对结构已验（`V-011`），MV/MZ 导出容器回灌见 `V-027`；Android 系统文件夹选择仍未验|
|`R-04`|启动访问会话、SSE 和下载鉴权细节|`TW-03`：会话与 SSE 已通过；下载鉴权边界已在 `V-008` 验证（根外 403、材料释放后 404、译文越界 403）|
|`R-05`|Backend Runtime worker 在 Web 服务中的组织|`TW-02`：当前 Web 入口直接持有组合根，未复用 backend-runtime worker；翻译期间 API 响应见 `V-011`，长任务与 worker 仓库外加载见 `V-025`；不代表任意负载的性能保证|
|`R-06`|Agent 的无前端保存/目录请求|已取证（`V-023`）：请求驻留、迟连接领取、浏览器关闭不应答后仍驻留、再次领取应答后保存落盘；30 分钟超时按取消收尾由单元测试覆盖|
|`R-07`|Chromium 图片/PDF 实际输出与资源开销|已解除（`V-024`）：样例视觉查看（`V-019`）、崩溃/超时/取消真实浏览器证据（`V-020`）、峰值资源记录（图片 RSS ~1135MB / PDF ~1750-1880MB，PSS ~359 / ~701MB）均已完成|
|`R-08`|Android 后台进程终止与软键盘/文件系统交互|`TW-08`、`TW-11`：实机记录，失败时明确支持边界|
|`R-09`|`390 × 844` 下侧栏与内容并排造成整体横向溢出|已解除：抽屉导航 + `min-width: 0` + dvh + 页面 min-content 修复，三视口实测无溢出（`V-008`）；剩余为逐页触控细节|
|`R-10`|窄视口抽屉默认展开曾遮挡首屏；Web 标题栏高度契约误报 0|已在 `V-008` 修复并回归；后续改壳层高度时须同时核对桌面与 Web 两条启动配置|
|`R-11`|规则导出材料模式只交付 `.json`，`.xlsx` 伴随文件被清理|`TW-05`：交付 JSON 交换格式为当前契约；需要 Excel 交付时再扩展|
|`R-12`|译文下载边界按当前界面语言计算输出目录名，切换语言后旧语言目录不可下载|已按决策 C 落地（`V-024`）：边界与下载清单覆盖全部语言输出目录，切语言后旧语言目录可下载；浏览器级复验已完成（`V-025`：novel-loop 14/14，旧语言目录 HTTP 200）|
|`R-13`|同数据根允许多个服务实例并存（SQLite WAL 多进程），无跨进程互斥|已按决策 B 落地（`V-024`）：数据根实例标记 + 启动警告 + bootstrap `anotherInstance` + 前端可关闭提示；真实双实例验证 11/11（第二实例不被阻止、标记互不删除、陈旧标记不误报）；已知局限：PID 复用可能误报（代价仅一条可关闭提示）|
|`R-14`|术语表/提示词导入在读取成功后即释放材料，随后项目写入失败需重新选文件|`TW-05`：当前契约已按此实现；如需重试友好化再改释放时机|
|`R-15`|单批文件夹上传超过 64 个文件触发 `runtime.busy`（`UPLOAD_MAX_MATERIALS`），用户需分批|决策 C5（2026-10-18 用户）：维持 64；解除格式冻结未改变该上限。准确含义为同时驻留的暂存材料最多 64 个，已有未释放材料也计入。另注意（`V-025`）：整目录上传时若含大 EPUB/PDF，建工程解析会整载文件，曾撞 1GB 堆上限 OOM——属资源边界非缺陷（上传本身实测流式，300MB 瞬时仅 +74MB），使用约束是只选小说章节文件|
|`R-16`|`webkitdirectory` 在真实 Android 文件选择器的行为与本机 Chromium 注入验证可能存在差异|`TW-08`、`TW-11`：真机验证时优先走一遍文件夹上传（小说章节目录）|
|`R-17`|Web 后端误用 Vite 浏览器构建，provider 动态加载时读取 `document`|已解除：服务端构建与依赖打包策略已修正，Agent 三场景通过（`V-016`）；原始堆栈与结论更正见 6.1|

依赖或环境失败出现后，在本节补具体命令、错误、已尝试方法与解除条件，不把风险推测写成确定故障。

### 6.1 Agent 模型链路 `document is not defined`（R-17）

**状态**：已修复，真实 Web 构建与 Agent 三场景回归通过（`V-016`）。

**修复前证据**：2026-10-18 用真实 Web 产物、临时工程与本地模拟模型复现，通过 Node inspector 的异常暂停捕获原始堆栈：

```text
ReferenceError: document is not defined
  at preload (build/web/assets/preload-helper-CxyQbZZj.js:33:25)
  at build/web/assets/gui-backend-bootstrap-Do84kz0S.js:38283:48
  at build/web/assets/estimate-b1-UG53U.js:153:83
```

- `buildtools/build-web.mjs` 虽然指定 `target: "node24"`、`rolldownOptions.platform: "node"` 与 Node 解析条件，但 Vite 的实际环境仍为 `build.ssr=false`、`consumer="client"`。
- Vite 为 provider 的动态 `import()` 注入 `__vitePreload`；它先读取 `document.querySelector("meta[property=csp-nonce]")`，在 Node 中抛出异常，provider 实现尚未加载，模拟模型请求日志为零。
- `pi-ai/dist/api/lazy.js` 的 `lazyStream` setup catch 用 `error.message` 构造 assistant error；随后 pi-durable 将它记入 submission detail，`AgentChat.run` 再以新 `Error` 抛出。原始堆栈首先在 setup error 转换处丢失。
- 此前“运行期没有全局 `document` 读取”“产物没有未防护的裸 `document`”两条排除结论撤回；此前 getter 探针为何漏报尚未确认。`openai-completions.js` 内部 catch 没有触发，是因为尚未进入 provider 实现，不能据此限定为 provider 内的同步前置段。

**修复边界**：只修改 Web 后端那次 Vite 构建，启用 `build.ssr=true`、关闭 `modulePreload`，并以 `ssr.noExternal=true` 继续打包服务依赖；Node 内置模块与 `mupdf` 保持显式 external。前端继续使用浏览器构建。已安装的 `electron-vite` main preset 采用相同的服务端构建与依赖打包策略。

**回归入口与结果**：`npm run build:web` 后执行 `node buildtools/web-agent-chain-verify.mjs --script=glossary --keep=true`；`full-chain`、`cancel`、`reconnect` 全部通过，模型日志记录 7 次 `/chat/completions` 请求。重连探针改用独立合成工程，避免首场景已写入的同名术语被正常拒绝、导致探针误等审批；保持原有审批与 revision 断言。

## 7. 下一步

1. Android 真机：在临时工程上验证系统文件及文件夹选择（`webkitdirectory`）、字幕与嵌套游戏输出下载落地、软键盘与长文输入、切后台与锁屏后恢复，记录设备与浏览器版本。另核对外链新标签行为；不要为触发更新提示擅自修改产品更新源或发布资产。
2. `TW-07`：从工作区权限边界及已有测试入手，补完整权限拒绝矩阵与 Agent 长任务恢复证据；批量翻译长任务证据不能替代此项。
3. `TW-03`：在实际代理网络环境验证模型认证回调，记录代理选择、回环直连与失败恢复。
4. `TW-11`：决定 Termux 发布与更新方式，再以临时数据验证停止、升级、恢复及兼容条件下的回退。README 已给出手动维护原则，但不代表更新验收完成。
5. 文件夹上传展示名：`V-027` 记录批次目录前缀进入资产相对路径，后续如调整命名，须核对新建、追加导入和下载展示；本轮仅整理文档，未改产品行为。
6. 代码交付：后续若获提交授权，先审阅当前全部差异与验证覆盖，再确定提交粒度；本轮未提交、未推送。

继续产品修改时，按 [WORKFLOW](docs/WORKFLOW.md) 与 [操作标准](docs/TERMUX_WEB_OPERATIONS.md) 选择验证；需要运行态证据时再构建和启动。仅文档整理不要求启动产品。

### 7.1 本机验证安排

本机可用内存与软件渲染能力随运行状态变化，开始重型验证前重新检查。按受影响范围串行安排测试与浏览器，避免并行构建、全量测试和宿主压测造成资源竞争。

验证触发条件与命令统一归 [WORKFLOW](docs/WORKFLOW.md#-选择验证)，专项运行证据要求归 [操作标准](docs/TERMUX_WEB_OPERATIONS.md#5-验证选择与证据)。已有结果覆盖最终改动后无需重复运行；新改动、失败或未决边界再触发补充验证。R-17 的原始堆栈与排查结论保留在第 6.1 节。

## 8. 后续交接记录模板

新增记录应替换过期的当前结论和下一步，以下模板仅供填写：

```text
日期 / 代码基线：
关联任务：TW-xx
本轮范围：
实际改动与行为：
验证记录：V-xxx（命令、环境、结果、覆盖边界）
未完成 / 阻塞及解除条件：
数据或迁移影响：
工作区无关改动 / 残留进程与产物：
下一步入口与首个验收：
```
