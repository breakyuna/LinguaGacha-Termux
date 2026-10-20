#!/usr/bin/env node
/**
 * 字幕闭环浏览器验证：SRT / VTT 导入到导出（TW-05，字幕形式 2026-10-19 解除冻结后纳入验收）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`（主代理保证为最新，本脚本直接用 build/web，
 * 不自行构建，避免与并行代理争抢构建产物）。
 *
 * 覆盖内容：
 *   1. 真实启动 Web 服务（仓库外临时数据根、自有端口），Playwright Core 驱动本机 Chromium；
 *   2. 启动 `web-long-task-mock-model.mjs` 作为 mock 翻译模型，经模型接口把翻译用途指向它，
 *      并把源／目标语言设为 ZH/EN（合成字幕是中文，默认 JA 会跳过条目）；
 *   3. 工程页上传合成 SRT 与 VTT，摘要确认后创建工程（保存选择器切到“应用数据”根）；
 *   4. 工作台显示两个字幕文件，命令栏开始翻译并等待全部条目完成；
 *   5. 全量翻译自然完成后应用自动弹出译文生成确认（跨路由 follow-up），
 *      确认 → 下载清单 → 捕获浏览器下载并校验内容：
 *      SRT 译文保持序号与时间码、正文为 mock 译文前缀加原文，VTT 译文含前缀，
 *      双语对照文件同时包含原文与译文；
 *   6. 除 api.github.com 的 404（fork 无 release 的预期行为）外控制台零错误；
 *   7. 停止服务后进程与 profile 回收、退出码 0。
 *
 * 用法：
 *   node buildtools/web-subtitle-browser-loop-verify.mjs [--keep=true] [--port=8491]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");
const MOCK_MODEL_ENTRY = path.join(PROJECT_ROOT, "buildtools", "web-long-task-mock-model.mjs");

// 本机验证约定：禁用 Playwright 浏览器注册表查找，使用系统 Chromium。
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("/data/data/com.termux/files/home/.local/share/html-visual-check/node_modules/playwright-core");
const {
  launchOptions,
} = require("/data/data/com.termux/files/home/.local/share/html-visual-check/browser-config.cjs");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const MOCK_START_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 60_000;
const TRANSLATION_TIMEOUT_MS = 180_000;
const DEFAULT_PORT = 8491;

const SRT_NAME = "ep01.srt";
const VTT_NAME = "subs.vtt";
const TRANSLATION_TEXT_PREFIX = "【译】";
const MOCK_MODEL_ID = "long-task-mock-model";
const BILINGUAL_DIRECTORY_MARK = "双语对照";

// 合成字幕夹具与仓库矩阵测试同源：序号 + 时间轴 + 正文，单行正文使条目与行同数。
const SRT_SOURCE_LINES = ["第一句台词", "第二句台词"];
const SRT_TIME_CODES = ["00:00:01,000 --> 00:00:03,500", "00:00:04,000 --> 00:00:06,250"];
const SRT_EXPECTED_CUES = SRT_SOURCE_LINES.map((text, index) => ({
  index: String(index + 1),
  time_code: SRT_TIME_CODES[index] ?? "",
  text: `${TRANSLATION_TEXT_PREFIX}${text}`,
}));
const SRT_FIXTURE = `${SRT_EXPECTED_CUES.map(
  (cue, index) => `${cue.index}\n${cue.time_code}\n${SRT_SOURCE_LINES[index]}\n`,
).join("\n")}\n`;
// 合成 VTT：文件头 + 注释块 + 两个无标识 cue，与矩阵测试夹具一致。
const VTT_FIXTURE = [
  "WEBVTT",
  "",
  "NOTE 片头注释",
  "kept",
  "",
  "00:00.000 --> 00:02.000",
  "第一句",
  "",
  "00:02.000 --> 00:04.000",
  "第二句",
  "",
].join("\n");
const VTT_EXPECTED_TRANSLATION_LINES = ["第一句", "第二句"].map(
  (text) => `${TRANSLATION_TEXT_PREFIX}${text}`,
);

// 两个字幕文件各 2 个条目，单行正文下条目与行同数。
const EXPECTED_ITEM_COUNT = SRT_SOURCE_LINES.length + 2;

const ZH_GENERATION_LABELS = {
  dialog_pattern: "是否确认生成当前可用译文|检查到.*校对警告",
  continue_label: "继续生成",
  confirm_label: "确认",
};

class VerifyFailure extends Error {}

/** 每个检查独立计数，失败不影响后续检查，便于一次运行拿到完整结论。 */
class Report {
  constructor() {
    this.results = [];
  }

  pass(name, detail) {
    this.results.push({ name, ok: true, detail });
    process.stdout.write(`PASS ${name}${detail === undefined ? "" : `：${detail}`}\n`);
  }

  fail(name, reason) {
    this.results.push({ name, ok: false, reason: String(reason) });
    process.stdout.write(`FAIL ${name}: ${String(reason)}\n`);
  }

  get failed_count() {
    return this.results.filter((result) => !result.ok).length;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wait_for(predicate, timeout_ms, description) {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== false && value !== undefined && value !== null) return value;
    await sleep(100);
  }
  throw new VerifyFailure(`Timed out waiting for: ${description}`);
}

/** 轮询页面文本，等待界面进入预期状态。 */
async function wait_for_text(page, pattern, timeout_ms, description) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "u");
  const found = await wait_for(
    async () => {
      const text = await page.evaluate(() => document.body.innerText);
      return regex.test(text) ? text : false;
    },
    timeout_ms,
    description,
  );
  return found;
}

/** 点击按钮文字精确匹配的按钮；SPA 渲染期间允许重试。 */
async function click_button(page, name, timeout_ms = PAGE_TIMEOUT_MS) {
  const locator = page.getByRole("button", { name, exact: true });
  await locator.first().waitFor({ state: "visible", timeout: timeout_ms });
  await locator.first().click();
}

/**
 * 译文生成确认弹窗有两种形态：无校对警告时主按钮是“确认”，
 * 有警告时是“继续生成”。等待弹窗描述出现后点击实际存在的主按钮，
 * 返回弹窗文本供调用方登记警告事实。
 */
async function confirm_generation(page, labels) {
  const text = await wait_for_text(
    page,
    new RegExp(labels.dialog_pattern),
    30_000,
    "译文生成确认弹窗",
  );
  const label = text.includes(labels.continue_label) ? labels.continue_label : labels.confirm_label;
  await click_button(page, label);
  return text;
}

/** 弹窗打开时 Base UI 会把背景标记为 aria-hidden，按 data-slot 判断弹窗是否存在。 */
async function wait_for_alert_dialog(page, timeout_ms, description) {
  return await wait_for(
    async () =>
      page.evaluate(() => document.querySelector('[data-slot="alert-dialog-content"]') !== null),
    timeout_ms,
    description,
  );
}

/** 解析 SRT 字幕块：序号行 + 时间轴行 + 正文行，块间空行分隔。 */
function parse_srt_cues(content) {
  return content
    .split(/\r?\n[ \t]*\r?\n/u)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      return {
        index: (lines[0] ?? "").trim(),
        time_code: (lines[1] ?? "").trim(),
        text: lines.slice(2).join("\n").trim(),
      };
    });
}

/** 逐 cue 核对序号、时间码与正文；返回问题列表，空列表表示全部符合预期。 */
function find_srt_problems(content) {
  const cues = parse_srt_cues(content);
  const problems = [];
  if (cues.length !== SRT_EXPECTED_CUES.length)
    problems.push(`cue count ${cues.length} (expected ${SRT_EXPECTED_CUES.length})`);
  for (const expected of SRT_EXPECTED_CUES) {
    const cue = cues[Number(expected.index) - 1];
    if (cue === undefined) {
      problems.push(`missing cue ${expected.index}`);
      continue;
    }
    if (cue.index !== expected.index) problems.push(`index ${cue.index}`);
    if (cue.time_code !== expected.time_code) problems.push(`time code ${cue.time_code}`);
    if (cue.text !== expected.text) problems.push(`text ${cue.text}`);
  }
  return problems;
}

/** 从受控下载链接查询参数读取输出文件路径，用于区分译文目录与双语对照目录。 */
function read_download_path(href) {
  try {
    return new URL(href, "http://127.0.0.1").searchParams.get("path");
  } catch {
    return null;
  }
}

/** 读取 mock 模型请求日志中的翻译请求事实，证明浏览器流程真实驱动了模型。 */
function read_mock_translation_stats(log_path) {
  let text = "";
  try {
    text = readFileSync(log_path, "utf8");
  } catch {
    return { translation_requests: 0, translation_items: 0 };
  }
  let translation_requests = 0;
  let translation_items = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry = null;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry?.["decision"] === "translation") {
      translation_requests += 1;
      translation_items += Number(entry["translationItems"] ?? 0);
    }
  }
  return { translation_requests, translation_items };
}

function list_chromium_processes() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("--user-data-dir=") && line.includes("lg-chromium-"));
}

function list_chromium_profiles() {
  try {
    return readdirSync(os.tmpdir()).filter((name) => name.startsWith("lg-chromium-"));
  } catch {
    return [];
  }
}

class WebServiceProcess {
  constructor(child) {
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    child.stdout.on("data", (chunk) => {
      this.stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
  }

  read_access() {
    const match = this.stdout.match(/访问地址:\s*(\S+?)\/#credential=(\S+)/u);
    if (match === null) return null;
    return { baseUrl: match[1], credential: match[2] };
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await wait_for(
      () => this.child.exitCode !== null,
      SERVICE_STOP_TIMEOUT_MS,
      "Web 服务退出",
    ).catch(() => {
      this.child.kill("SIGKILL");
    });
  }
}

/** mock 翻译模型进程：启动参数为 `--name=value` 形式，就绪后打印实际监听端口。 */
class MockModelProcess {
  constructor(child) {
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    child.stdout.on("data", (chunk) => {
      this.stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
  }

  read_port() {
    const match = this.stdout.match(/LONG_TASK_MOCK_LISTENING (\d+)/u);
    return match === null ? null : Number(match[1]);
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await wait_for(
      () => this.child.exitCode !== null,
      SERVICE_STOP_TIMEOUT_MS,
      "模拟模型服务退出",
    ).catch(() => {
      this.child.kill("SIGKILL");
    });
  }
}

/** REST 客户端：携带访问会话 cookie，统一解包网关的 data 信封。 */
class ApiClient {
  constructor(baseUrl, cookie) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
  }

  async data(method, route, { body, headers } = {}) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        ...headers,
        ...(this.cookie === "" ? {} : { cookie: this.cookie }),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    if (response.status < 200 || response.status >= 300)
      throw new VerifyFailure(
        `${method} ${route} -> ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
      );
    const envelope = payload;
    if (envelope !== null && typeof envelope === "object" && "data" in envelope)
      return envelope["data"];
    return envelope;
  }

  async post(route, payload) {
    return await this.data("POST", route, {
      body: JSON.stringify(payload ?? {}),
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * 轮询翻译快照等待本轮完成：非活跃状态且已产生进度即返回事实，
 * 完成度与错误数由调用方断言，避免把部分完成误判为超时。
 */
async function wait_for_translation_completion(client) {
  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const snapshot = await client.post("/api/batch-translation/snapshot", {});
    const batch = snapshot?.["batch_translation"] ?? {};
    const progress = batch["progress"] ?? {};
    const run_progress = batch["run_progress"] ?? {};
    const pick = (key) => Number(progress[key] ?? run_progress[key] ?? 0);
    last = {
      status: String(batch["status"] ?? ""),
      total_line: pick("total_line"),
      processed_line: pick("processed_line"),
      error_line: pick("error_line"),
    };
    const active = last.status === "running" || last.status === "stopping";
    if (!active && last.total_line > 0) return last;
    await sleep(500);
  }
  throw new VerifyFailure(`Timed out waiting for translation completion: ${JSON.stringify(last)}`);
}

/** 失败现场：输出页面可见文本与按钮清单，便于按实际界面文案修正定位。 */
async function dump_page(page, label) {
  if (page === null) return;
  try {
    const text = await page.evaluate(() => document.body.innerText);
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .map((button) => (button.textContent ?? "").trim())
        .filter((name) => name !== "")
        .slice(0, 80),
    );
    // 统计卡在页面顶部、命令栏在底部，首尾都保留，避免长页面截掉关键区域。
    process.stdout.write(`[dump:${label}] text head:\n${text.slice(0, 1_500)}\n`);
    process.stdout.write(`[dump:${label}] text tail:\n${text.slice(-3_000)}\n`);
    process.stdout.write(`[dump:${label}] buttons: ${buttons.join(" | ")}\n`);
  } catch {
    // 浏览器或页面已关闭时的诊断输出失败不影响结论，静默跳过。
  }
}

/**
 * 等待工作台统计卡显示预期计数值：按卡片标题定位，只读计数值，
 * 不依赖 innerText 的换行推断，界面改版时定位仍然明确。
 */
async function wait_for_stat_card(page, title, expected) {
  return await wait_for(
    async () => {
      const value = await page.evaluate((card_title) => {
        const cards = Array.from(document.querySelectorAll(".workbench-page__stat-card"));
        const card = cards.find((node) => (node.textContent ?? "").includes(card_title));
        if (card === undefined) return false;
        const value_element = card.querySelector(".workbench-page__stat-card-value");
        const value_text = (value_element?.textContent ?? "").trim();
        return value_text === "" ? false : value_text;
      }, title);
      return value === String(expected) ? value : false;
    },
    60_000,
    `工作台统计卡 ${title}=${expected}`,
  );
}

/** 捕获下载清单中指定链接的浏览器下载并落盘，返回建议文件名与本地路径。 */
async function capture_download(page, locator, download_dir, prefix) {
  const download_promise = page.waitForEvent("download", { timeout: PAGE_TIMEOUT_MS });
  await locator.click();
  const download = await download_promise;
  const file = path.join(download_dir, `${prefix}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  return { name: download.suggestedFilename(), file };
}

function parse_arguments(argv) {
  const options = { keep: false, port: DEFAULT_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1)
      throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value === "") throw new Error(`Empty argument value: ${name}`);
    switch (name) {
      case "keep":
        options.keep = value === "true";
        break;
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535)
          throw new Error(`Invalid port: ${value}`);
        options.port = port;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  return options;
}

async function main() {
  let options = null;
  try {
    options = parse_arguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-subtitle-loop-"));
  const data_root = path.join(artifacts, "data-root");
  const download_dir = path.join(artifacts, "downloads");
  const mock_log = path.join(artifacts, "mock-requests.jsonl");
  mkdirSync(data_root, { recursive: true });
  mkdirSync(download_dir, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  const mock = new MockModelProcess(
    spawn(process.execPath, [MOCK_MODEL_ENTRY, "--port=0", `--log=${mock_log}`], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const service = new WebServiceProcess(
    spawn(
      process.execPath,
      [WEB_SERVER_ENTRY, `--port=${options.port}`, `--data-root=${data_root}`],
      {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  let browser = null;
  let page = null;
  let cookie = "";
  try {
    const mock_port = await wait_for(
      () => {
        if (mock.child.exitCode !== null)
          throw new VerifyFailure(
            `Mock model exited early with code ${mock.child.exitCode}: ${mock.stderr.slice(-400)}`,
          );
        return mock.read_port();
      },
      MOCK_START_TIMEOUT_MS,
      "模拟模型服务打印监听端口",
    );
    report.pass("模拟模型服务", `port=${mock_port}`);

    const access = await wait_for(
      () => {
        if (service.child.exitCode !== null)
          throw new VerifyFailure(
            `Web service exited early with code ${service.child.exitCode}: ${service.stderr.slice(-400)}`,
          );
        return service.read_access();
      },
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    process.stdout.write(`[verify] Web 服务 ${access.baseUrl}\n`);

    const session = await fetch(`${access.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: access.credential }),
    });
    cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
    report.pass("访问会话", `HTTP ${session.status}`);

    const client = new ApiClient(access.baseUrl, cookie);

    // 模型配置：自定义 OpenAI 模型指向 mock 服务，选为翻译用途。
    const added = await client.post("/api/models/add", { model_type: "CUSTOM_OPENAI" });
    const custom_model = (added?.["snapshot"]?.["models"] ?? []).find(
      (model) => model?.["type"] === "CUSTOM_OPENAI",
    );
    if (custom_model === undefined)
      throw new VerifyFailure("CUSTOM_OPENAI model missing from snapshot after add");
    const model_id = String(custom_model["id"]);
    await client.post("/api/models/update", {
      model_id,
      patch: {
        api_url: `http://127.0.0.1:${mock_port}`,
        api_key: "no-key-required",
        model_id: MOCK_MODEL_ID,
        threshold: { input_token_limit: 512, rpm_limit: 0, concurrency_limit: 2 },
      },
    });
    const selection = await client.post("/api/models/select", {
      target: "translation",
      model_id,
    });
    if (selection?.["model_selection"]?.["translation"] !== model_id)
      throw new VerifyFailure(
        `Translation model selection mismatch: ${JSON.stringify(selection?.["model_selection"] ?? null)}`,
      );
    report.pass("翻译模型配置", `translation -> ${MOCK_MODEL_ID} (mock port ${mock_port})`);

    // 合成字幕是中文：默认源语言 JA 会跳过条目，显式设为 ZH/EN。
    const settings = await client.post("/api/settings/update", {
      source_language: "ZH",
      target_language: "EN",
    });
    const saved_settings = settings?.["settings"] ?? {};
    if (saved_settings["source_language"] !== "ZH" || saved_settings["target_language"] !== "EN")
      throw new VerifyFailure(`Language settings mismatch: ${JSON.stringify(saved_settings)}`);
    report.pass("语言设置", "source=ZH target=EN");

    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    const console_errors = [];
    page.on("console", (message) => {
      // 资源加载失败由 failed_responses 按 URL 断言（可区分已知 GitHub 404），
      // 这里只收其余控制台错误，避免同一事件双算。
      if (message.type() !== "error") return;
      if (/Failed to load resource/u.test(message.text())) return;
      console_errors.push(message.text().slice(0, 200));
    });
    page.on("pageerror", (error) =>
      console_errors.push(`pageerror: ${error.message.slice(0, 200)}`),
    );
    // 更新检查指向本地仓库：fork 未发布 release 时 GitHub API 返回 404，
    // 浏览器把它记为一条资源加载错误（真实用户无感，仅在 devtools 可见）。
    // 这是 C2 决策后的预期行为，断言只关心除此以外的失败请求。
    const failed_responses = [];
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("api.github.com"))
        failed_responses.push(`${response.status()} ${response.url().slice(0, 140)}`);
    });

    // 1) 带凭据进入，等待应用外壳与工程页就绪。
    await page.goto(`${access.baseUrl}/#credential=${access.credential}`, {
      waitUntil: "networkidle",
    });
    await wait_for_text(page, /新建工程/, 30_000, "工程页渲染");
    report.pass("登录进入工程页", "无凭据页已越过");

    // 首启更新提示会遮挡界面：真实用户先取消，再继续业务流程。
    const cancel_update = page.getByRole("button", { name: "取消", exact: true }).first();
    try {
      await cancel_update.waitFor({ state: "visible", timeout: 25_000 });
      await cancel_update.click();
      report.pass("取消首启更新提示", "更新弹窗已关闭");
    } catch {
      report.pass("取消首启更新提示", "未出现更新提示");
    }

    // 2) 上传字幕：源文件卡片 → 选择文件 → 上传文件 → 选择。
    await page.getByText("点击或拖拽源文件").first().click();
    await wait_for_text(page, /选择文件/, 10_000, "源文件菜单");
    await page.getByText("选择文件", { exact: true }).last().click();
    await wait_for_text(page, /上传文件/, 10_000, "文件选择器打开");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles([
        { name: SRT_NAME, mimeType: "text/plain", buffer: Buffer.from(SRT_FIXTURE, "utf8") },
        { name: VTT_NAME, mimeType: "text/vtt", buffer: Buffer.from(VTT_FIXTURE, "utf8") },
      ]);
    await wait_for_text(page, new RegExp(SRT_NAME), 30_000, "SRT 材料出现在列表");
    await wait_for_text(page, new RegExp(VTT_NAME), 30_000, "VTT 材料出现在列表");
    await click_button(page, "选择");
    await wait_for_text(page, /已选择\s*2\s*个源文件/, 30_000, "源文件摘要");
    report.pass("字幕上传与摘要", `摘要显示 2 个源文件（${SRT_NAME}、${VTT_NAME}）`);

    // 3) 创建工程：保存选择器切到“应用数据”根，工程落临时数据根内。
    await click_button(page, "创建工程");
    await wait_for_text(page, /选择保存位置/, 15_000, "保存选择器打开");
    await page.getByRole("button", { name: "应用数据", exact: true }).first().click();
    await wait_for_text(
      page,
      new RegExp(data_root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      15_000,
      "保存位置切换到数据根",
    );
    await click_button(page, "选择");
    await wait_for_text(page, /生成译文/, 60_000, "工程创建后进入应用");
    report.pass("工程创建", "保存选择器确认后进入应用");

    // 新建后应用落在 AGENT 页：显式进入工作台核对文件事实。
    await page.getByRole("button", { name: "工作台", exact: true }).first().click();
    await wait_for_text(page, new RegExp(SRT_NAME), 60_000, "工作台显示 SRT 文件");
    await wait_for_text(page, new RegExp(VTT_NAME), 60_000, "工作台显示 VTT 文件");
    report.pass("工作台文件", `文件表显示 ${SRT_NAME} 与 ${VTT_NAME}`);

    // 4) 命令栏“翻译”菜单开始翻译，mock 模型回送带前缀译文。
    await page.getByRole("button", { name: "翻译", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "开始翻译", exact: true }).click();
    const completion = await wait_for_translation_completion(client);
    report.pass(
      "翻译执行",
      `status=${completion.status} processed=${completion.processed_line}/${completion.total_line} error=${completion.error_line}`,
    );
    if (completion.error_line !== 0) report.fail("翻译执行", `error_line=${completion.error_line}`);
    if (completion.processed_line !== completion.total_line)
      report.fail(
        "翻译执行",
        `processed ${completion.processed_line} != total ${completion.total_line}`,
      );
    if (completion.total_line !== EXPECTED_ITEM_COUNT)
      report.fail(
        "翻译执行",
        `total_line=${completion.total_line} (expected ${EXPECTED_ITEM_COUNT})`,
      );
    // 工作台统计卡标题来自 task_progress 资源：完成计数卡为“翻译成功”。
    await wait_for_stat_card(page, "翻译成功", EXPECTED_ITEM_COUNT);
    report.pass("工作台翻译统计", `翻译成功 ${EXPECTED_ITEM_COUNT} 行`);

    const mock_stats = read_mock_translation_stats(mock_log);
    report.pass(
      "模拟模型请求",
      `translation_requests=${mock_stats.translation_requests} translation_items=${mock_stats.translation_items}`,
    );
    if (mock_stats.translation_requests < 1)
      report.fail("模拟模型请求", "mock log has no translation request");
    if (mock_stats.translation_items !== EXPECTED_ITEM_COUNT)
      report.fail(
        "模拟模型请求",
        `translation_items=${mock_stats.translation_items} (expected ${EXPECTED_ITEM_COUNT})`,
      );

    // 5) 生成译文：全量翻译自然完成后由跨路由 follow-up 自动弹出生成确认，
    //    未自动弹出时再显式点击命令栏“生成译文”（弹窗已开时按钮被 aria-hidden 覆盖，不能点）。
    const dialog_opened = await wait_for_alert_dialog(page, 20_000, "译文生成确认弹窗").catch(
      () => false,
    );
    if (dialog_opened === false) {
      await click_button(page, "生成译文");
      await wait_for_alert_dialog(page, 30_000, "译文生成确认弹窗");
      report.pass("生成确认弹窗", "命令栏点击后打开");
    } else {
      report.pass("生成确认弹窗", "翻译完成后自动打开（跨路由 follow-up）");
    }
    const dialog_text = await confirm_generation(page, ZH_GENERATION_LABELS);
    const warning_line = dialog_text.split("\n").find((line) => line.includes("校对警告")) ?? "";
    report.pass(
      "生成确认",
      warning_line === "" ? "无校对警告，直接确认" : `警告形态：${warning_line.slice(0, 90)}`,
    );
    await wait_for_text(page, /下载译文/, 60_000, "下载清单出现");

    const links = page.locator("a[download]");
    const link_count = await links.count();
    const hrefs = await links.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") ?? ""),
    );
    const download_paths = hrefs.map((href) => read_download_path(href));
    const srt_translated_index = download_paths.findIndex(
      (file_path) =>
        file_path !== null &&
        file_path.endsWith(`/${SRT_NAME}`) &&
        !file_path.includes(BILINGUAL_DIRECTORY_MARK),
    );
    const vtt_translated_index = download_paths.findIndex(
      (file_path) =>
        file_path !== null &&
        file_path.endsWith(`/${VTT_NAME}`) &&
        !file_path.includes(BILINGUAL_DIRECTORY_MARK),
    );
    const srt_bilingual_index = download_paths.findIndex(
      (file_path) =>
        file_path !== null &&
        file_path.endsWith(`/${SRT_NAME}`) &&
        file_path.includes(BILINGUAL_DIRECTORY_MARK),
    );
    const download_names = download_paths.map((file_path) =>
      file_path === null ? "(no path)" : path.basename(file_path),
    );
    report.pass("下载清单", `${link_count} 个文件：${download_names.join("、")}`);
    if (link_count < 4)
      report.fail(
        "下载清单",
        `expected translated and bilingual files for both subtitles, got ${link_count}`,
      );
    if (srt_translated_index < 0)
      report.fail("下载清单", `no translated ${SRT_NAME} link in download list`);
    if (vtt_translated_index < 0)
      report.fail("下载清单", `no translated ${VTT_NAME} link in download list`);
    if (srt_bilingual_index < 0)
      report.fail("下载清单", `no bilingual ${SRT_NAME} link in download list`);

    // SRT 译文：序号与时间码不变，正文为 mock 译文前缀加原文。
    if (srt_translated_index >= 0) {
      const srt_download = await capture_download(
        page,
        links.nth(srt_translated_index),
        download_dir,
        "srt",
      );
      const srt_content = readFileSync(srt_download.file, "utf8");
      const problems = find_srt_problems(srt_content);
      report.pass(
        "SRT 译文内容",
        `${srt_download.name} ${srt_content.length} 字节，${parse_srt_cues(srt_content).length} 个 cue`,
      );
      if (srt_download.name !== SRT_NAME)
        report.fail("SRT 译文内容", `downloaded file name ${srt_download.name}`);
      if (problems.length > 0) report.fail("SRT 译文内容", problems.join("; "));
    }

    // VTT 译文：保留文件头，正文带 mock 译文前缀。
    if (vtt_translated_index >= 0) {
      const vtt_download = await capture_download(
        page,
        links.nth(vtt_translated_index),
        download_dir,
        "vtt",
      );
      const vtt_content = readFileSync(vtt_download.file, "utf8");
      const problems = [];
      if (!vtt_content.includes("WEBVTT")) problems.push("missing WEBVTT header");
      for (const line of VTT_EXPECTED_TRANSLATION_LINES)
        if (!vtt_content.includes(line)) problems.push(`missing ${line}`);
      report.pass("VTT 译文内容", `${vtt_download.name} ${vtt_content.length} 字节`);
      if (problems.length > 0)
        report.fail("VTT 译文内容", `${problems.join("; ")}: ${vtt_content.slice(0, 160)}`);
    }

    // 双语对照：同一文件内同时包含原文与带前缀译文。
    if (srt_bilingual_index >= 0) {
      const bilingual_download = await capture_download(
        page,
        links.nth(srt_bilingual_index),
        download_dir,
        "srt-bilingual",
      );
      const bilingual_content = readFileSync(bilingual_download.file, "utf8");
      const missing = [
        ...SRT_SOURCE_LINES.filter((line) => !bilingual_content.includes(line)),
        ...SRT_EXPECTED_CUES.filter((cue) => !bilingual_content.includes(cue.text)).map(
          (cue) => cue.text,
        ),
      ];
      report.pass("SRT 双语内容", `${bilingual_download.name} ${bilingual_content.length} 字节`);
      if (missing.length > 0) report.fail("SRT 双语内容", `missing ${missing.join(", ")}`);
    }

    await click_button(page, "关闭");

    report.pass(
      "浏览器控制台",
      console_errors.length === 0 && failed_responses.length === 0
        ? "零错误"
        : `${console_errors.length} 个错误 / ${failed_responses.length} 个失败请求`,
    );
    for (const error of console_errors.slice(0, 5)) process.stdout.write(`  - ${error}\n`);
    for (const failure of failed_responses.slice(0, 5)) process.stdout.write(`  - ${failure}\n`);
    if (console_errors.length > 0) report.fail("浏览器控制台", console_errors[0]);
    if (failed_responses.length > 0)
      report.fail("浏览器控制台", `失败请求：${failed_responses[0]}`);
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    await dump_page(page, "failure");
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
    if (mock.stderr !== "") process.stdout.write(`[mock:err] ${mock.stderr}\n`);
  } finally {
    if (browser !== null) await browser.close();
    await service.stop();
    await mock.stop();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }

    const processes = list_chromium_processes();
    const profiles = list_chromium_profiles();
    report.pass("进程与 profile 回收", `profile=${profiles.length} process=${processes.length}`);
    if (profiles.length > 0)
      report.fail("进程与 profile 回收", `残留 profile：${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("进程与 profile 回收", `残留进程：${processes[0].slice(0, 160)}`);

    const exit_code = service.child.exitCode;
    report.pass("服务正常停止", `exitCode=${exit_code}`);
    if (exit_code !== 0) report.fail("服务正常停止", `exitCode=${exit_code}`);

    const mock_stopped = mock.child.exitCode !== null || mock.child.signalCode !== null;
    report.pass("模拟模型停止", `exitCode=${mock.child.exitCode} signal=${mock.child.signalCode}`);
    if (!mock_stopped) report.fail("模拟模型停止", "mock model process still running");

    if (options.keep) process.stdout.write(`[verify] 保留产物目录 ${artifacts}\n`);
    else rmSync(artifacts, { recursive: true, force: true });
  }

  process.stdout.write("---- 汇总 ----\n");
  for (const result of report.results)
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}\n`);
  process.stdout.write(
    `通过 ${report.results.length - report.failed_count}/${report.results.length}\n`,
  );
  return report.failed_count === 0 ? 0 : 1;
}

process.exitCode = await main();
