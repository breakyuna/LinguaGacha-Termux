#!/usr/bin/env node
/**
 * Web Agent 全链路与 Chromium 宿主验证编排脚本。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`。
 *
 * 覆盖内容：
 *   1. 启动真实 Web 服务（仓库外临时数据根）与 Agent 模拟模型服务；
 *   2. 核对 `/api/web/bootstrap` 的能力事实：Chromium 就绪时图片与 PDF 宿主均可用；
 *   3. 经模型接口把 Agent 模型指向模拟服务，并固定写入审批为 manual；
 *   4. 驱动 `workspace_run`，让工作区子进程真实调用图片宿主（`emitImage`）与
 *      PDF 宿主（`host({kind:"print_pdf"})`），并从工具输出断言两者都产出真实字节；
 *   5. 运行 `buildtools/web-agent-chain-probe.mjs` 的全链路、取消与重连场景；
 *   6. 停止服务后核对没有遗留的 Chromium 进程与临时 profile 目录。
 *
 * 用法：
 *   node buildtools/web-agent-chain-verify.mjs [--script glossary|host] [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start_agent_mock_server } from "./agent-mock-model-server.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");
const AGENT_CHAIN_PROBE = path.join(PROJECT_ROOT, "buildtools", "web-agent-chain-probe.mjs");

const AGENT_CHAT_EVENT_TOPIC = "agent.chat_event";
const WORKSPACE_RUN_TOOL = "workspace_run";
const IMAGE_HOST_MARKER = "emitted workspace image through the image host";
const PDF_HOST_MARKER = /printed pdf path=(\S+) header=(%PDF-?) bytes=(\d+)/u;

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15 * 60_000;
const HTTP_TIMEOUT_MS = 30_000;

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

/** 读取临时目录下的 Chromium profile 目录名；服务停止后应当为空。 */
function list_chromium_profiles() {
  try {
    return readdirSync(os.tmpdir()).filter((name) => name.startsWith("lg-chromium-"));
  } catch {
    return [];
  }
}

/**
 * 通过命令行识别 Chromium 进程。
 * profile 标记必须落在 `--user-data-dir=` 参数里，避免匹配到清理命令自身的字面量；
 * 渲染子进程不一定带该参数，因此同时按宿主可执行文件路径匹配。
 */
function list_chromium_processes(executable) {
  const result = spawnSyncSafe("ps", ["-A", "-o", "args="]);
  if (result === null) return [];
  const markers = ["--user-data-dir=", "lg-chromium-"];
  return result
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line === "") return false;
      const has_profile = markers.every((marker) => line.includes(marker));
      const has_executable = executable !== "" && line.includes(executable);
      return has_profile || has_executable;
    });
}

function spawnSyncSafe(command, args) {
  try {
    const completed = spawnSync(command, args, { encoding: "utf8" });
    if (completed.error !== undefined || completed.status !== 0) return null;
    return String(completed.stdout ?? "");
  } catch {
    return null;
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

  /** 从启动输出解析访问地址与一次性凭据，用于建立访问会话。 */
  read_access() {
    const match = this.stdout.match(/访问地址:\s*(\S+?)\/#credential=(\S+)/u);
    if (match === null) return null;
    // 宿主可执行文件路径由服务自报，用于停止后核对没有遗留的浏览器进程。
    const host = this.stdout.match(/图片\/PDF 宿主:\s*(\S+)/u);
    return {
      baseUrl: match[1],
      credential: match[2],
      chromiumExecutable: host?.[1] ?? "",
    };
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

  async call(method, route, body) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.cookie === "" ? {} : { cookie: this.cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  async data(method, route, body) {
    const response = await this.call(method, route, body);
    if (response.status < 200 || response.status >= 300)
      throw new VerifyFailure(
        `${method} ${route} -> ${response.status} ${JSON.stringify(response.payload).slice(0, 300)}`,
      );
    const envelope = response.payload;
    if (envelope !== null && typeof envelope === "object" && "data" in envelope)
      return envelope["data"];
    return envelope;
  }
}

/**
 * `agent.chat_event` 订阅者：只收集工具条目输出，
 * 用于断言 Chromium 宿主在工作区子进程中被真实调用。
 */
class ToolOutputCollector {
  constructor({ baseUrl, cookie }) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.outputs = [];
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
      // 订阅中断只影响证据收集，验证结论由 REST 断言与探针独立给出。
    }
  }

  handle_frame(frame) {
    const lines = frame.split("\n");
    const topic = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data_line = lines.find((line) => line.startsWith("data:"));
    if (topic !== AGENT_CHAT_EVENT_TOPIC || data_line === undefined) return;
    let payload = null;
    try {
      payload = JSON.parse(data_line.slice(5).trim());
    } catch {
      return;
    }
    const changes = payload?.["changes"];
    if (!Array.isArray(changes)) return;
    for (const change of changes) {
      if (change?.["type"] !== "entry_upsert") continue;
      const entry = change["entry"];
      if (entry?.["kind"] !== "tool_call" || entry["toolName"] !== WORKSPACE_RUN_TOOL) continue;
      const output = entry["output"];
      if (!Array.isArray(output)) continue;
      this.outputs.push(...output);
    }
  }

  close() {
    this.abort_controller.abort();
  }
}

/** 解析 `--name value` 形式的启动参数；未知参数与缺失值都立即失败。 */
function parse_arguments(argv) {
  const options = { script: "host", keep: false };
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
      case "script":
        if (value !== "glossary" && value !== "host")
          throw new Error(`Invalid script: ${value} (expected glossary | host)`);
        options.script = value;
        break;
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
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-agent-verify-"));
  const data_root = path.join(artifacts, "data-root");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);
  process.stdout.write(`[verify] 数据根 ${data_root}\n`);

  const mock_server = await start_agent_mock_server({
    port: 0,
    log: path.join(artifacts, "agent-mock-requests.jsonl"),
    script: options.script,
  });
  process.stdout.write(
    `[verify] 模拟模型服务 ${mock_server.baseUrl}（script=${options.script}）\n`,
  );

  const service = new WebServiceProcess(
    spawn(
      process.execPath,
      [
        ...(process.env["LG_DIAGNOSTIC_PRELOAD"] === undefined
          ? []
          : ["--import", process.env["LG_DIAGNOSTIC_PRELOAD"]]),
        WEB_SERVER_ENTRY,
        "--port=0",
        `--data-root=${data_root}`,
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  let client = null;
  let collector = null;
  let chromium_executable = "";
  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    chromium_executable = access.chromiumExecutable;
    process.stdout.write(`[verify] Web 服务 ${access.baseUrl}\n`);

    const session = await fetch(`${access.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: access.credential }),
    });
    const set_cookie = session.headers.get("set-cookie") ?? "";
    const cookie = set_cookie.split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
    client = new ApiClient(access.baseUrl, cookie);
    report.pass("访问会话", `HTTP ${session.status}`);

    const bootstrap = await client.data("GET", "/api/web/bootstrap");
    const capabilities = bootstrap?.["capabilities"] ?? {};
    report.pass(
      "宿主能力事实",
      `imageHost=${capabilities["imageHost"]} pdfHost=${capabilities["pdfHost"]}`,
    );
    if (capabilities["imageHost"] !== true)
      report.fail("宿主能力事实", `imageHost 应为 true，实际 ${capabilities["imageHost"]}`);
    if (capabilities["pdfHost"] !== true)
      report.fail("宿主能力事实", `pdfHost 应为 true，实际 ${capabilities["pdfHost"]}`);

    // 模型配置：新增自定义 OpenAI 模型并指向模拟服务，再把 Agent 用途选到该模型。
    const added = await client.data("POST", "/api/models/add", { model_type: "CUSTOM_OPENAI" });
    const added_models = added?.["snapshot"]?.["models"] ?? [];
    const custom_model = added_models.find((model) => model?.["type"] === "CUSTOM_OPENAI");
    if (custom_model === undefined)
      throw new VerifyFailure("CUSTOM_OPENAI model missing from snapshot after add");
    const model_id = String(custom_model["id"]);
    await client.data("POST", "/api/models/update", {
      model_id,
      patch: {
        api_url: mock_server.baseUrl,
        api_key: "no-key-required",
        model_id: "agent-mock-model",
      },
    });
    const selection = await client.data("POST", "/api/models/select", {
      target: "agent",
      model_id,
    });
    report.pass("模型配置", `agent=${selection?.["model_selection"]?.["agent"]}`);

    const settings = await client.data("POST", "/api/settings/update", {
      agent_approval_mode: "manual",
    });
    report.pass("写入审批模式", String(settings?.["accepted"] ?? "unknown"));

    collector = new ToolOutputCollector({ baseUrl: access.baseUrl, cookie });
    await collector.connect();

    const probe = spawn(process.execPath, [AGENT_CHAIN_PROBE, access.baseUrl, access.credential], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_CHAIN_PROBE_BUDGET_MS: String(PROBE_TIMEOUT_MS) },
    });
    let probe_output = "";
    probe.stdout.on("data", (chunk) => {
      const text = String(chunk);
      probe_output += text;
      process.stdout.write(`[probe] ${text}`);
    });
    probe.stderr.on("data", (chunk) => {
      process.stdout.write(`[probe:err] ${String(chunk)}`);
    });
    const probe_exit = await new Promise((resolve) => {
      probe.on("close", (code) => resolve(code ?? -1));
    });
    collector.close();
    report.pass("Agent 全链路探针", `退出码 ${probe_exit}`);
    if (probe_exit !== 0) report.fail("Agent 全链路探针", `退出码 ${probe_exit}`);

    if (options.script === "host") {
      const image_lines = collector.outputs.filter((line) => line.includes(IMAGE_HOST_MARKER));
      const pdf_lines = collector.outputs
        .map((line) => PDF_HOST_MARKER.exec(line))
        .filter((match) => match !== null);
      report.pass("Chromium 图片宿主", image_lines.length === 0 ? "未观测到输出" : image_lines[0]);
      if (image_lines.length === 0)
        report.fail("Chromium 图片宿主", "workspace_run 输出中没有 emitImage 成功标记");
      const pdf_match = pdf_lines[0];
      report.pass("Chromium PDF 宿主", pdf_match === undefined ? "未观测到输出" : pdf_match[0]);
      if (pdf_match === undefined)
        report.fail("Chromium PDF 宿主", "workspace_run 输出中没有 PDF 文件头证据");
      else if (Number(pdf_match[3]) < 1_000)
        report.fail("Chromium PDF 宿主", `PDF 字节数异常：${pdf_match[3]}`);
    }
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    collector?.close();
    await service.stop();
    await mock_server.close();

    // 诊断输出：服务 stderr 尾部，便于定位宿主与模型链路问题。
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }

    // 服务停止后不得残留 Chromium 进程或临时 profile。
    const profiles = list_chromium_profiles();
    const processes = list_chromium_processes(chromium_executable);
    report.pass("Chromium 进程回收", `profile=${profiles.length} process=${processes.length}`);
    if (profiles.length > 0)
      report.fail("Chromium 进程回收", `残留 profile：${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("Chromium 进程回收", `残留进程：${processes[0].slice(0, 160)}`);

    // 正常停止必须以 0 退出：临时 profile 清理失败曾把 SIGTERM 停止变成退出码 1。
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
