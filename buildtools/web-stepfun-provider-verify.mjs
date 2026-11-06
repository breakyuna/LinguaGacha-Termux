#!/usr/bin/env node
/**
 * StepFun 真实供应商有界验证（C1，TW-07）。
 *
 * 前置条件：环境变量 `STEPFUN_API_KEY` 已设置；脚本自行构建 Web 产物到临时目录。
 *
 * 覆盖内容：
 *   1. 启动真实 Web 服务（仓库外临时数据根）并建立访问会话；
 *   2. 经模型接口把翻译 / Agent / Agent 批译用途指向 StepFun 真实端点
 *      （`https://api.stepfun.com/step_plan/v1`，OpenAI Chat Completions 兼容）；
 *   3. 上传合成英文小说并创建工程，跑一次真实翻译批次直到终态；
 *   4. 生成译文文件并经受控下载校验内容确实被翻译（与原文不同且非空）；
 *   5. 经 SSE 订阅驱动一次真实 Agent 对话，断言收到助手回复；
 *   6. 停止服务并核对退出码与无浏览器残留（本探针不调用图片 / PDF 宿主）。
 *
 * 用法：
 *   node buildtools/web-stepfun-provider-verify.mjs [--model=step-3.5-flash] [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_WEB_SCRIPT = path.join(PROJECT_ROOT, "buildtools", "build-web.mjs");

const STEPFUN_API_URL = "https://api.stepfun.com/step_plan/v1";
const DEFAULT_MODEL = "step-3.5-flash";

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 60_000;
const TRANSLATION_TIMEOUT_MS = 15 * 60_000;
const AGENT_TIMEOUT_MS = 5 * 60_000;
const ACTIVE_TRANSLATION_STATUSES = new Set(["requested", "running", "stopping"]);

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

/** 读取临时目录下的 Chromium profile 目录名；本探针不调用宿主，停止后应当为空。 */
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

  /** 从启动输出解析访问地址与一次性凭据，用于建立访问会话。 */
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

  /** 上传原始字节到暂存区：不经 JSON 序列化，直接以 octet-stream 发送文件内容。 */
  async upload(name, bytes) {
    const response = await fetch(
      `${this.baseUrl}/api/web/files/upload?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", cookie: this.cookie },
        body: bytes,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    if (response.status < 200 || response.status >= 300)
      throw new VerifyFailure(
        `POST upload -> ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
      );
    const envelope = payload;
    if (envelope !== null && typeof envelope === "object" && "data" in envelope)
      return envelope["data"];
    return envelope;
  }
}

/**
 * `agent.chat_event` 订阅者：收集助手消息文本，
 * 用于断言真实供应商驱动了一轮完整对话。
 */
class AgentChatCollector {
  constructor({ baseUrl, cookie }) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.assistant_texts = [];
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
    if (topic !== "agent.chat_event" || data_line === undefined) return;
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
      if (entry?.["kind"] !== "assistant_message") continue;
      this.assistant_texts.push(JSON.stringify(entry["parts"] ?? {}));
    }
  }

  close() {
    this.abort_controller.abort();
  }
}

/** 解析 `--name value` 形式的启动参数；未知参数与缺失值都立即失败。 */
function parse_arguments(argv) {
  const options = { model: DEFAULT_MODEL, keep: false };
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
      case "model":
        options.model = value;
        break;
      case "keep":
        options.keep = value === "true";
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

/** 合成英文小说：段落短、句数少，控制真实供应商的调用量与耗时。 */
function create_novel_bytes() {
  const paragraphs = [
    "The lighthouse keeper climbed the stairs at dawn.",
    "He checked the lamp, the logs, and the empty mailbox.",
    "No ship had passed the cape for eleven days.",
    "The fog came in without warning, as it always did.",
    "He wrote one line in the ledger and closed the book.",
    "Tomorrow, he decided, he would repair the broken shutter.",
  ];
  return Buffer.from(`${paragraphs.join("\n\n")}\n`, "utf8");
}

/** 构建到临时目录，避免与并发验证争抢仓库内 build/web。 */
function build_web(build_dir) {
  process.stdout.write(`[verify] 构建 Web 产物到 ${build_dir}\n`);
  const completed = spawnSync(process.execPath, [BUILD_WEB_SCRIPT, build_dir], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  if (completed.error !== undefined || completed.status !== 0)
    throw new VerifyFailure(
      `build:web failed: ${completed.error?.message ?? `exit ${completed.status}`}\n${String(
        completed.stderr ?? "",
      ).slice(-2_000)}`,
    );
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const api_key = process.env["STEPFUN_API_KEY"] ?? "";
  if (api_key === "")
    throw new VerifyFailure("STEPFUN_API_KEY is not set; cannot reach the real provider");

  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-stepfun-verify-"));
  const data_root = path.join(artifacts, "data-root");
  const build_dir = path.join(artifacts, "build-web");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);
  process.stdout.write(`[verify] 数据根 ${data_root}\n`);

  build_web(build_dir);

  const service = new WebServiceProcess(
    spawn(
      process.execPath,
      [path.join(build_dir, "index.mjs"), "--port=0", `--data-root=${data_root}`],
      {
        cwd: artifacts, // 以仓库外目录为 cwd，同时证明运行不依赖仓库位置
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  let client = null;
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
    const set_cookie = session.headers.get("set-cookie") ?? "";
    const cookie = set_cookie.split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
    client = new ApiClient(access.baseUrl, cookie);
    report.pass("访问会话", `HTTP ${session.status}`);

    // 语言设置：工程默认源语言为 JA，英文夹具必须先切到 EN，否则条目会被语言过滤跳过。
    const language_settings = await client.data("POST", "/api/settings/update", {
      source_language: "EN",
      target_language: "ZH",
    });
    report.pass(
      "语言设置",
      `source=${language_settings?.["settings"]?.["source_language"]} target=${language_settings?.["settings"]?.["target_language"]}`,
    );

    // 模型配置：自定义 OpenAI 端点指向 StepFun，三种用途全部选到该模型。
    const added = await client.data("POST", "/api/models/add", { model_type: "CUSTOM_OPENAI" });
    const custom_model = (added?.["snapshot"]?.["models"] ?? []).find(
      (model) => model?.["type"] === "CUSTOM_OPENAI",
    );
    if (custom_model === undefined)
      throw new VerifyFailure("CUSTOM_OPENAI model missing from snapshot after add");
    const model_id = String(custom_model["id"]);
    await client.data("POST", "/api/models/update", {
      model_id,
      patch: { api_url: STEPFUN_API_URL, api_key, model_id: options.model },
    });
    const selections = [];
    for (const target of ["translation", "agent", "agent_batch_translation"]) {
      const selection = await client.data("POST", "/api/models/select", { target, model_id });
      selections.push(`${target}=${selection?.["model_selection"]?.[target]}`);
    }
    report.pass("模型配置", `${options.model} @ ${STEPFUN_API_URL}；${selections.join(" ")}`);

    // 小说工程：上传 → 摘要 → 创建。
    const material = await client.upload("novel/lighthouse.txt", create_novel_bytes());
    const material_path = String(material?.["path"] ?? "");
    const material_id = String(material?.["material_id"] ?? "");
    if (material_path === "" || material_id === "")
      throw new VerifyFailure(
        `staged material record incomplete: ${JSON.stringify(material).slice(0, 200)}`,
      );
    report.pass("上传暂存", material_path);

    const summary = await client.data("POST", "/api/session/source-files/summary", {
      source_paths: [material_path],
    });
    report.pass("源文件摘要", `txt=${summary?.["format_hit_counts"]?.["txt"] ?? 0}`);

    const project_path = path.join(artifacts, "projects", "stepfun-novel.lg");
    mkdirSync(path.dirname(project_path), { recursive: true });
    const created = await client.data("POST", "/api/session/project/create", {
      path: project_path,
      material_ids: [material_id],
    });
    const failed_files = created?.["failed_files"] ?? [];
    report.pass(
      "工程创建",
      failed_files.length === 0 ? "无失败文件" : `失败 ${failed_files.length} 个`,
    );
    if (failed_files.length > 0)
      report.fail("工程创建", JSON.stringify(failed_files).slice(0, 300));

    // 工作台快照证明条目真实落库：没有条目时翻译无从执行。
    const workbench = await client.data("POST", "/api/workbench/snapshot", {});
    const file_entries = workbench?.["snapshot"]?.["entries"] ?? [];
    const item_total = file_entries.reduce(
      (sum, entry) => sum + Number(entry?.["progress"]?.["total_count"] ?? 0),
      0,
    );
    report.pass("工程条目落库", `文件 ${file_entries.length} 个，条目 ${item_total}`);
    if (item_total <= 0) report.fail("工程条目落库", "工作台没有任何翻译条目");

    // 真实翻译批次：轮询快照直到终态。
    const start = await client.data("POST", "/api/batch-translation/start", {
      operation: "translate",
      mode: "new",
      scope: { kind: "all" },
      include_errors: false,
      command_id: "stepfun-verify-translate-1",
    });
    report.pass("翻译受理", `accepted=${start?.["accepted"]} duplicate=${start?.["duplicate"]}`);

    const translation_deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
    let final_snapshot = null;
    while (Date.now() < translation_deadline) {
      const snapshot = await client.data("POST", "/api/batch-translation/snapshot", {});
      final_snapshot = snapshot?.["batch_translation"] ?? snapshot;
      const status = String(final_snapshot?.["status"] ?? "");
      const progress = final_snapshot?.["progress"] ?? {};
      process.stdout.write(
        `[verify] 翻译 status=${status} line=${progress["processed_line"]}/${progress["total_line"]} tokens=${progress["total_tokens"]}\n`,
      );
      if (!ACTIVE_TRANSLATION_STATUSES.has(status)) break;
      await sleep(3_000);
    }
    const final_status = String(final_snapshot?.["status"] ?? "");
    const final_progress = final_snapshot?.["progress"] ?? {};
    report.pass(
      "翻译终态",
      `status=${final_status} processed=${final_progress["processed_line"]}/${final_progress["total_line"]} error=${final_progress["error_line"]} tokens=${final_progress["total_tokens"]}`,
    );
    if (final_status !== "done") report.fail("翻译终态", `期望 done，实际 ${final_status}`);
    if (Number(final_progress["processed_line"] ?? 0) <= 0)
      report.fail("翻译终态", "没有成功提交的译文行");

    // 生成译文文件并下载校验：内容必须非空且与原文不同。
    const generated = await client.data("POST", "/api/translation/files/generate", {});
    const generated_files = generated?.["files"] ?? [];
    report.pass("生成译文文件", `${generated_files.length} 个`);
    if (generated_files.length === 0)
      throw new VerifyFailure("generated translation file list is empty");
    const downloaded = await fetch(
      `${access.baseUrl}/api/translation/files/download?path=${encodeURIComponent(String(generated_files[0]["path"]))}`,
      { headers: { cookie } },
    );
    if (!downloaded.ok)
      throw new VerifyFailure(
        `translation download failed: HTTP ${downloaded.status} ${(await downloaded.text()).slice(0, 200)}`,
      );
    const downloaded_bytes = Buffer.from(await downloaded.arrayBuffer());
    const source_bytes = create_novel_bytes();
    const translated = downloaded_bytes.toString("utf8");
    report.pass(
      "下载译文内容",
      `${downloaded_bytes.length} 字节，首行：${translated.split("\n")[0]?.slice(0, 40) ?? ""}`,
    );
    if (downloaded_bytes.length === 0) report.fail("下载译文内容", "文件为空");
    if (translated === source_bytes.toString("utf8"))
      report.fail("下载译文内容", "内容与原文完全相同，疑似未翻译");

    // 真实 Agent 对话：SSE 订阅后发送一句话，断言收到助手回复。
    collector = new AgentChatCollector({ baseUrl: access.baseUrl, cookie });
    await collector.connect();
    const agent_snapshot = await client.data("GET", "/api/agent/snapshot");
    const chat_id = String(agent_snapshot?.["chatId"] ?? "");
    if (chat_id === "") throw new VerifyFailure("agent snapshot has no chatId");
    await client.data("POST", "/api/agent/message", {
      text: "请用一句中文确认你已作为翻译助手就绪，并说明你能帮助用户做什么。",
      attachments: [],
      chatId: chat_id,
      commandId: crypto.randomUUID(),
    });
    report.pass("Agent 消息受理", "已发送");
    const assistant_deadline = Date.now() + AGENT_TIMEOUT_MS;
    while (collector.assistant_texts.length === 0 && Date.now() < assistant_deadline)
      await sleep(1_000);
    report.pass(
      "Agent 助手回复",
      collector.assistant_texts.length === 0
        ? "未收到"
        : collector.assistant_texts[0].slice(0, 120),
    );
    if (collector.assistant_texts.length === 0) report.fail("Agent 助手回复", "SSE 中没有助手消息");
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    collector?.close();
    await service.stop();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }
    const profiles = list_chromium_profiles();
    report.pass("无浏览器启动", `profile=${profiles.length} exit=${service.child.exitCode}`);
    if (profiles.length > 0) report.fail("无浏览器启动", `残留 profile：${profiles.join(", ")}`);
    if (!options.keep) rmSync(artifacts, { recursive: true, force: true });
    else process.stdout.write(`[verify] 保留产物目录 ${artifacts}\n`);
  }

  process.stdout.write(`\n[verify] 失败项 ${report.failed_count}\n`);
  process.exit(report.failed_count === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`[verify] 未处理异常：${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
