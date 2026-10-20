#!/usr/bin/env node
/**
 * Agent 保存位置驻留与迟连接领取验证（R-06 / TW-07）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`。
 *
 * 覆盖内容：
 *   1. 真实启动 Web 服务（临时数据根），REST 建小说工程并上传 Agent 附件；
 *   2. 无浏览器在线时触发 `activate-path`：请求驻留——SSE 收到
 *      `agent.save_path_event`、pending 列表非空、调用不返回；
 *   3. 浏览器 #1 登录后桥接自动领取 pending，保存选择器打开且默认名预填；
 *      不回答直接关闭浏览器；
 *   4. 核对请求仍然驻留（pending 非空、调用仍未返回）；
 *   5. 浏览器 #2 登录后再次领取，切到应用数据根并确认；
 *   6. 核对 activate-path 以 `saved` 返回、pending 清空、目标文件存在且内容一致；
 *   7. 停止服务后退出码 0，无遗留 Chromium 进程与 profile。
 *
 * 用法：
 *   node buildtools/web-agent-save-path-verify.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");

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
const HTTP_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 60_000;

const ATTACHMENT_NAME = "驻留报告.md";
const ATTACHMENT_TEXT = "Agent 工作区生成的驻留保存内容。\n第二行正文。\n";

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

class ApiClient {
  constructor(baseUrl, cookie) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
  }

  async call(method, route, { body, headers } = {}) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        ...headers,
        ...(this.cookie === "" ? {} : { cookie: this.cookie }),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return { status: response.status, payload };
  }

  async data(method, route, options) {
    const response = await this.call(method, route, options);
    if (response.status < 200 || response.status >= 300)
      throw new VerifyFailure(
        `${method} ${route} -> ${response.status} ${JSON.stringify(response.payload).slice(0, 300)}`,
      );
    const envelope = response.payload;
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

  async upload(route, name, bytes) {
    return await this.data("POST", `${route}?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }
}

/** SSE 订阅：只收集 Agent 保存位置事件。 */
class SavePathEventCollector {
  constructor({ baseUrl, cookie }) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.events = [];
    this.abort_controller = new AbortController();
  }

  async connect() {
    const response = await fetch(`${this.baseUrl}/api/events/stream`, {
      headers: { cookie: this.cookie },
      signal: this.abort_controller.signal,
    });
    if (!response.ok || response.body === null)
      throw new VerifyFailure(`SSE subscription failed: HTTP ${response.status}`);
    void this.read_loop(response.body);
  }

  async read_loop(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          this.handle_frame(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // 订阅中断只影响证据收集，验证结论由 REST 断言独立给出。
    }
  }

  handle_frame(frame) {
    const lines = frame.split("\n");
    const topic = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data_line = lines.find((line) => line.startsWith("data:"));
    if (topic !== "agent.save_path_event" || data_line === undefined) return;
    try {
      this.events.push(JSON.parse(data_line.slice(5).trim()));
    } catch {
      // 单帧解析失败不影响后续事件。
    }
  }

  close() {
    this.abort_controller.abort();
  }
}

async function click_button(page, name, timeout_ms = PAGE_TIMEOUT_MS) {
  const locator = page.getByRole("button", { name, exact: true });
  await locator.first().waitFor({ state: "visible", timeout: timeout_ms });
  await locator.first().click();
}

/** 登录并等待应用外壳就绪；首启更新提示出现时取消。 */
async function open_browser_session(browser, access) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  const console_errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") console_errors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => console_errors.push(`pageerror: ${error.message.slice(0, 200)}`));
  await page.goto(`${access.baseUrl}/#credential=${access.credential}`, {
    waitUntil: "networkidle",
  });
  await wait_for_text(page, /新建工程|工作台|AGENT/, 30_000, "应用外壳渲染");
  const cancel_update = page.getByRole("button", { name: "取消", exact: true }).first();
  try {
    await cancel_update.waitFor({ state: "visible", timeout: 25_000 });
    await cancel_update.click();
  } catch {
    // 未出现更新提示时继续。
  }
  return { context, page, console_errors };
}

function parse_arguments(argv) {
  const options = { keep: false };
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
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  return options;
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-save-path-"));
  const data_root = path.join(artifacts, "data-root");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  const service = new WebServiceProcess(
    spawn(process.execPath, [WEB_SERVER_ENTRY, "--port=0", `--data-root=${data_root}`], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  let browser = null;
  let collector = null;
  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    process.stdout.write(`[verify] Web 服务 ${access.baseUrl}\n`);

    const session = await fetch(`${access.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: access.credential }),
    });
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
    const client = new ApiClient(access.baseUrl, cookie);
    report.pass("访问会话", `HTTP ${session.status}`);

    // 建小说工程：上传 TXT 材料后创建，Agent 工作区随之就绪。
    const material = await client.upload(
      "/api/web/files/upload",
      "novel.txt",
      Buffer.from("小说正文第一行。\n小说正文第二行。\n", "utf8"),
    );
    const material_id = String(material?.["material_id"] ?? "");
    if (material_id === "") throw new VerifyFailure("TXT material upload record incomplete");
    const project_path = path.join(data_root, "驻留工程.lg");
    await client.post("/api/session/project/create", {
      path: project_path,
      material_ids: [material_id],
    });
    report.pass("建工程", project_path);

    // 上传 Agent 附件，取得工作区相对路径作为激活目标。
    const attachment = await client.upload(
      "/api/agent/uploads",
      ATTACHMENT_NAME,
      Buffer.from(ATTACHMENT_TEXT, "utf8"),
    );
    const attachment_path = String(attachment?.["path"] ?? "");
    if (attachment_path === "")
      throw new VerifyFailure("Agent attachment upload record incomplete");
    report.pass("Agent 附件上传", attachment_path);

    // 订阅 SSE 后触发激活：无浏览器在线，请求应驻留。
    collector = new SavePathEventCollector({ baseUrl: access.baseUrl, cookie });
    await collector.connect();

    let activate_settled = false;
    const activate_result = client
      .post("/api/agent/workspace/activate-path", { path: attachment_path })
      .then((result) => {
        activate_settled = true;
        return result;
      })
      .catch((error) => {
        activate_settled = true;
        throw error;
      });

    const request_event = await wait_for(
      async () => collector.events.find((event) => event["type"] === "requested") ?? false,
      30_000,
      "SSE 收到保存位置驻留请求",
    );
    const request_id = String(request_event["request_id"] ?? "");
    const default_name = String(request_event["default_name"] ?? "");
    report.pass("无浏览器时请求驻留", `request_id=${request_id} default_name=${default_name}`);
    if (request_id === "") report.fail("无浏览器时请求驻留", "事件缺少 request_id");

    const pending_before = await client.post("/api/agent/save-path/pending", {});
    const pending_requests_before = pending_before?.["requests"] ?? [];
    report.pass("pending 列表非空", `${pending_requests_before.length} 个驻留请求`);
    if (pending_requests_before.length !== 1)
      report.fail("pending 列表非空", `期望 1 个，实际 ${pending_requests_before.length}`);
    if (activate_settled) report.fail("无浏览器时请求驻留", "activate-path 在无浏览器时已返回");

    // 浏览器 #1：登录后桥接自动领取，选择器打开；不回答直接关闭。
    browser = await chromium.launch(launchOptions);
    const first = await open_browser_session(browser, access);
    await wait_for_text(first.page, /选择保存位置/, 30_000, "浏览器 #1 领取后打开保存选择器");
    const prefilled_name = await first.page.evaluate(() => {
      const input = document.querySelector('input:not([type="file"])');
      return input?.value ?? "";
    });
    report.pass("选择器默认名预填", prefilled_name);
    if (prefilled_name !== ATTACHMENT_NAME)
      report.fail("选择器默认名预填", `期望 ${ATTACHMENT_NAME}，实际 ${prefilled_name}`);
    await first.context.close();
    report.pass("浏览器 #1 关闭且未应答", "选择器打开后直接关闭");

    // 关闭未应答的浏览器后请求仍应驻留。
    await sleep(1_000);
    const pending_after_close = await client.post("/api/agent/save-path/pending", {});
    const pending_requests_after = pending_after_close?.["requests"] ?? [];
    report.pass("关闭后请求仍驻留", `${pending_requests_after.length} 个驻留请求`);
    if (pending_requests_after.length !== 1)
      report.fail("关闭后请求仍驻留", `期望 1 个，实际 ${pending_requests_after.length}`);
    if (activate_settled) report.fail("关闭后请求仍驻留", "activate-path 在浏览器关闭后已返回");

    // 浏览器 #2：重新登录再次领取，切到应用数据根后确认。
    const second = await open_browser_session(browser, access);
    await wait_for_text(second.page, /选择保存位置/, 30_000, "浏览器 #2 领取后打开保存选择器");
    await click_button(second.page, "应用数据");
    await wait_for_text(
      second.page,
      new RegExp(data_root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      15_000,
      "保存位置切换到数据根",
    );
    await click_button(second.page, "选择");

    // 应答后激活调用应以 saved 收尾，目标文件落盘且内容一致。
    const activated = await wait_for(
      async () => {
        if (!activate_settled) return false;
        return true;
      },
      30_000,
      "activate-path 返回",
    ).then(async () => await activate_result);
    report.pass("激活调用收尾", JSON.stringify(activated));
    if (activated?.["status"] !== "saved")
      report.fail("激活调用收尾", `期望 saved，实际 ${JSON.stringify(activated)}`);

    const pending_final = await client.post("/api/agent/save-path/pending", {});
    const pending_requests_final = pending_final?.["requests"] ?? [];
    report.pass("pending 清空", `${pending_requests_final.length} 个驻留请求`);
    if (pending_requests_final.length !== 0)
      report.fail("pending 清空", `期望 0 个，实际 ${pending_requests_final.length}`);

    const destination = path.join(data_root, ATTACHMENT_NAME);
    if (!existsSync(destination)) report.fail("目标文件落盘", `不存在：${destination}`);
    else {
      const saved_text = readFileSync(destination, "utf8");
      report.pass("目标文件落盘", `${destination} ${saved_text.length} 字节`);
      if (saved_text !== ATTACHMENT_TEXT)
        report.fail("目标文件落盘", `内容不一致：${saved_text.slice(0, 80)}`);
    }
    await second.context.close();

    report.pass(
      "浏览器控制台",
      second.console_errors.length === 0 ? "零错误" : `${second.console_errors.length} 个错误`,
    );
    for (const error of second.console_errors.slice(0, 5)) process.stdout.write(`  - ${error}\n`);
    if (second.console_errors.length > 0) report.fail("浏览器控制台", second.console_errors[0]);
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    collector?.close();
    if (browser !== null) await browser.close();
    await service.stop();
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
