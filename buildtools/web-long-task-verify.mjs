#!/usr/bin/env node
/**
 * TW-11 长任务验证：仓库外部署目录上的 30 分钟翻译长任务。
 *
 * 前置条件：已执行
 *   node buildtools/build-web.mjs /data/data/com.termux/files/usr/tmp/lg-a3-build/web
 *
 * 覆盖内容：
 *   1. 把构建产物复制到仓库外临时目录（仿 `web-deploy-verify.mjs`），以该目录为
 *      cwd 启动正式入口 `<deploy>/index.mjs`，配临时数据根与固定端口；
 *   2. 经模型接口把翻译模型指向 `web-long-task-mock-model.mjs`（带前置延迟的
 *      合成模型服务），上传合成长篇小说并建工程，以 `command_id` 受理批量翻译；
 *   3. 任务运行期间每 30 秒探针一次：健康检查与快照查询延迟（与空闲基线对比，
 *      对应 V-011 的量级要求），同时经 SSE 订阅核对 `batch_translation.snapshot_changed`
 *      事件 revision 严格单调、连接无断开；
 *   4. 结束时核对：翻译终态 `done`、全部条目 processed、译文文件落盘且内容可回读、
 *      统计可回读、控制台无 ERROR/FATAL 级日志；
 *   5. 核对 work-unit 与 planning 两个翻译 worker 从仓库外部署位置加载：
 *      部署副本的两个 worker 入口各追加一行加载探针（仅写日志，不改行为），
 *      启动日志因此直接给出 worker 入口路径；辅以进程命令行、cwd 与线程普查；
 *   6. 优雅停止服务，核对退出码 0、无残留进程与临时 profile，清理临时产物。
 *
 * 用法：
 *   node buildtools/web-long-task-verify.mjs [--keep=true]
 *     [--build-dir=<dir>] [--port=8473] [--items=14400]
 *     [--min-delay-ms=3000] [--max-delay-ms=6000] [--chunk-delay-ms=250]
 *     [--concurrency=4] [--probe-interval-ms=30000]
 *     [--target-duration-ms=1800000] [--max-wait-ms=2700000]
 *     [--evidence-dir=<dir>]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start_long_task_mock_server } from "./web-long-task-mock-model.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BATCH_TRANSLATION_EVENT_TOPIC = "batch_translation.snapshot_changed";
const SERVICE_START_TIMEOUT_MS = 120_000;
const SERVICE_STOP_TIMEOUT_MS = 90_000;
const HTTP_TIMEOUT_MS = 60_000; // 解析与工程提交在软件渲染的本机上可能较慢
const WORKER_ENTRY_FILES = ["work-unit-worker-entry.mjs", "planning-worker-entry.mjs"];

// 节奏控制边界：单次请求前置延迟的可行区间，探针按投影完成时间在此区间内校准。
const PACE_FLOOR_MS = 500;
const PACE_CEILING_MS = 20_000;
// 预热期：流水线起步阶段吞吐估计偏保守，此前不校准节奏。
const PACE_WARMUP_S = 120;

/** 合成长篇小说：每行唯一且长度稳定，避免重复过滤与切块抖动。 */
const NOVEL_LINE_TEMPLATE =
  "第{index}行：夜色下的城池安静下来，主角握紧长剑继续前行，远处传来钟声与马蹄声，灯火在风里摇晃。";

/** worker 入口加载探针：只写一行启动日志，证明入口由部署目录加载。 */
function build_worker_probe_line() {
  return [
    "",
    "// [long-task-probe] TW-11 长任务验证：确认 worker 入口从仓库外部署目录加载（仅追加日志，不改变行为）。",
    "process.stderr.write(`[long-task-probe] worker entry loaded from ${import.meta.url}\\n`);",
    "",
  ].join("\n");
}

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 目录内容指纹：用于证明部署副本与构建产物一致（除追加的 worker 探针外）。 */
function hash_directory(root) {
  const files = new Map();
  const walk = (current, relative) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entry_relative = relative === "" ? entry.name : path.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, entry_relative);
        continue;
      }
      files.set(entry_relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  walk(root, "");
  return files;
}

/** 列出产品启动的 Chromium 进程；本探针不调用图片 / PDF 宿主，不得有任何残留。 */
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

/** 线程普查：worker_threads 池的真实线程在 /proc/<pid>/task 里可见。 */
function read_thread_census(pid) {
  const names = new Map();
  try {
    for (const entry of readdirSync(`/proc/${pid}/task`)) {
      let name = "";
      try {
        name = readFileSync(`/proc/${pid}/task/${entry}/comm`, "utf8").trim();
      } catch {
        continue;
      }
      names.set(name, (names.get(name) ?? 0) + 1);
    }
  } catch {
    return null;
  }
  return Object.fromEntries([...names.entries()].sort((left, right) => right[1] - left[1]));
}

function read_process_facts(pid) {
  const facts = {};
  try {
    facts.cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/u, "").split("\0");
  } catch (error) {
    facts.cmdline_error = String(error);
  }
  try {
    facts.cwd = readFileSync(`/proc/${pid}/cwd`, "utf8").trim();
  } catch {
    try {
      facts.cwd = spawnSync("readlink", [`/proc/${pid}/cwd`], { encoding: "utf8" }).stdout?.trim();
    } catch {
      facts.cwd = "unknown";
    }
  }
  facts.threads = read_thread_census(pid);
  return facts;
}

/** 端口占用检查：固定端口被占用时立即失败，不静默换端口。 */
async function assert_port_free(port) {
  const occupied = await new Promise((resolve) => {
    const socket = net
      .connect({ host: "127.0.0.1", port })
      .once("error", () => resolve(false))
      .once("connect", () => {
        socket.end();
        resolve(true);
      });
  });
  if (occupied) throw new VerifyFailure(`port ${port} is already in use; release it and retry`);
}

class WebServiceProcess {
  constructor(child, log_dir) {
    this.child = child;
    this.pid = child.pid;
    this.stdout = "";
    this.stderr = "";
    this.stdout_lines = 0;
    this.stdout_file = createWriteStream(path.join(log_dir, "service-stdout.log"));
    this.stderr_file = createWriteStream(path.join(log_dir, "service-stderr.log"));
    this.worker_probe_lines = new Set();
    this.console_error_lines = [];
    this.pending = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => this.absorb("stdout", chunk));
    child.stderr.on("data", (chunk) => this.absorb("stderr", chunk));
  }

  /** 流式输出同时落盘并保留内存尾部，控制台日志量大时不让内存无限增长。 */
  absorb(stream, chunk) {
    const text = String(chunk);
    const file = stream === "stdout" ? this.stdout_file : this.stderr_file;
    const buffer = stream === "stdout" ? this.stdout : this.stderr;
    file.write(text);
    if (stream === "stdout") {
      this.stdout_lines += text.split("\n").length - 1;
      this.stdout = (buffer + text).slice(-400_000);
    } else {
      this.stderr = (buffer + text).slice(-200_000);
    }
    this.scan_lines(stream, text);
  }

  /** 逐行扫描：worker 加载探针与控制台 ERROR/FATAL 行即时入账，不依赖尾部缓冲。 */
  scan_lines(stream, text) {
    const combined = this.pending[stream] + text;
    const lines = combined.split("\n");
    this.pending[stream] = lines.pop() ?? "";
    // 终端输出带 ANSI 颜色转义，剥离时必须匹配 ESC 控制字符。
    // eslint-disable-next-line no-control-regex
    const strip_ansi = (line) => line.replace(/\x1B\[[0-9;]*m/gu, "").trim();
    for (const raw_line of lines) {
      const line = strip_ansi(raw_line);
      if (line.startsWith("[long-task-probe]")) this.worker_probe_lines.add(line);
      if (/^\[[^\]]+\]\s+(ERROR|FATAL)(\s|$)/u.test(line) && this.console_error_lines.length < 50)
        this.console_error_lines.push(`[${stream}] ${line.slice(0, 240)}`);
    }
  }

  /** 从启动输出解析访问地址与一次性凭据。 */
  read_access() {
    const match = this.stdout.match(/访问地址:\s*(\S+?)\/#credential=(\S+)/u);
    if (match === null) return null;
    const host = this.stdout.match(/图片\/PDF 宿主:\s*(\S+)/u);
    return {
      baseUrl: match[1],
      credential: match[2],
      chromiumExecutable: host?.[1] ?? "",
    };
  }

  /** worker 入口加载探针写出的启动日志行。 */
  read_worker_probe_lines() {
    return [...this.worker_probe_lines];
  }

  /** 控制台 ERROR / FATAL 级日志行（错误与致命日志走 stderr，其余走 stdout）。 */
  read_console_error_lines() {
    return this.console_error_lines;
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

  close_logs() {
    this.stdout_file.end();
    this.stderr_file.end();
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

  async upload(name, bytes) {
    return await this.data("POST", `/api/web/files/upload?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }
}

/**
 * SSE 订阅者：只关心 `batch_translation.snapshot_changed` 的 revision 序列，
 * 同时记录连接是否断开与 keepalive 是否持续到达。
 */
class SnapshotEventCollector {
  constructor({ baseUrl, cookie }) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.revisions = [];
    this.keepalives = 0;
    this.other_events = 0;
    this.connected_at = null;
    this.closed_at = null;
    this.disconnected_before_end = false;
    this.disconnect_reason = null;
    this.abort_controller = new AbortController();
  }

  async connect() {
    const response = await fetch(`${this.baseUrl}/api/events/stream`, {
      headers: { cookie: this.cookie },
      signal: this.abort_controller.signal,
    });
    if (!response.ok || response.body === null)
      throw new VerifyFailure(`SSE subscription failed: HTTP ${response.status}`);
    this.connected_at = new Date().toISOString();
    void this.read_loop(response.body);
  }

  async read_loop(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.closed_at = new Date().toISOString();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          this.handle_frame(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      this.closed_at = new Date().toISOString();
      this.disconnected_before_end = true;
      this.disconnect_reason = String(error);
    }
  }

  handle_frame(frame) {
    const lines = frame.split("\n");
    const event_line = lines.find((line) => line.startsWith("event:"));
    const data_line = lines.find((line) => line.startsWith("data:"));
    if (event_line === undefined || data_line === undefined) {
      // keepalive 注释帧没有 event/data 行。
      if (frame.includes(": keepalive")) this.keepalives += 1;
      return;
    }
    const topic = event_line.slice(6).trim();
    if (topic !== BATCH_TRANSLATION_EVENT_TOPIC) {
      this.other_events += 1;
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(data_line.slice(5).trim());
    } catch {
      return;
    }
    const revision = Number(payload?.["batch_translation"]?.["revision"]);
    if (Number.isFinite(revision)) this.revisions.push(revision);
  }

  /** 最近一次采样以来新增的事件数与最新 revision。 */
  drain() {
    const start_index = this.drained_index ?? 0;
    const fresh = this.revisions.slice(start_index);
    this.drained_index = this.revisions.length;
    let violations = [];
    for (let index = Math.max(1, start_index); index < this.revisions.length; index += 1) {
      if (this.revisions[index] <= this.revisions[index - 1])
        violations.push(`${this.revisions[index - 1]}->${this.revisions[index]}`);
    }
    return {
      fresh_count: fresh.length,
      last_revision: this.revisions.at(-1) ?? null,
      violations,
      keepalives: this.keepalives,
    };
  }

  close() {
    this.abort_controller.abort();
  }
}

function parse_arguments(argv) {
  const options = {
    keep: false,
    build_dir: path.join(PROJECT_ROOT, "build", "web"),
    port: 8473,
    items: 12_000,
    min_delay_ms: 3_000,
    max_delay_ms: 6_000,
    chunk_delay_ms: 250,
    concurrency: 4,
    probe_interval_ms: 30_000,
    target_duration_ms: 30 * 60_000,
    max_wait_ms: 45 * 60_000,
    evidence_dir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1)
      throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value === "") throw new Error(`Empty argument value: ${name}`);
    const read_positive_int = () => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}: ${value}`);
      return parsed;
    };
    switch (name) {
      case "keep":
        options.keep = value === "true";
        break;
      case "build-dir":
        options.build_dir = path.resolve(value);
        break;
      case "port":
        options.port = read_positive_int();
        break;
      case "items":
        options.items = read_positive_int();
        break;
      case "min-delay-ms":
        options.min_delay_ms = read_positive_int();
        break;
      case "max-delay-ms":
        options.max_delay_ms = read_positive_int();
        break;
      case "chunk-delay-ms":
        options.chunk_delay_ms = Number(value);
        if (!Number.isFinite(options.chunk_delay_ms) || options.chunk_delay_ms < 0)
          throw new Error(`Invalid chunk-delay-ms: ${value}`);
        break;
      case "concurrency":
        options.concurrency = read_positive_int();
        break;
      case "probe-interval-ms":
        options.probe_interval_ms = read_positive_int();
        break;
      case "target-duration-ms":
        options.target_duration_ms = read_positive_int();
        break;
      case "max-wait-ms":
        options.max_wait_ms = read_positive_int();
        break;
      case "evidence-dir":
        options.evidence_dir = path.resolve(value);
        break;
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  if (options.max_delay_ms < options.min_delay_ms) options.max_delay_ms = options.min_delay_ms;
  if (options.max_wait_ms < options.target_duration_ms)
    throw new Error("max-wait-ms must not be smaller than target-duration-ms");
  return options;
}

function format_ms(value) {
  return value === null ? "-" : `${Math.round(value)}ms`;
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-long-task-verify-"));
  const log_dir = options.evidence_dir ?? path.join(artifacts, "logs");
  const deploy_dir = path.join(artifacts, "deploy");
  const data_root = path.join(artifacts, "data-root");
  const project_path = path.join(artifacts, "projects", "long-task.lg");
  const samples_path = path.join(log_dir, "probe-samples.jsonl");
  mkdirSync(log_dir, { recursive: true });
  mkdirSync(data_root, { recursive: true });
  mkdirSync(path.dirname(project_path), { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);
  process.stdout.write(`[verify] 证据目录 ${log_dir}\n`);
  process.stdout.write(`[verify] 构建目录 ${options.build_dir}\n`);

  // 部署副本：与构建产物逐文件哈希一致，仅两个 worker 入口追加加载探针。
  const build_index = hash_directory(options.build_dir);
  const missing_build_files = ["index.mjs", ...WORKER_ENTRY_FILES].filter(
    (relative) => !existsSync(path.join(options.build_dir, relative)),
  );
  if (missing_build_files.length > 0)
    throw new VerifyFailure(
      `build output is missing entry files: ${missing_build_files.join(", ")}`,
    );
  cpSync(options.build_dir, deploy_dir, { recursive: true });
  const deploy_index_before = hash_directory(deploy_dir);
  const identical_count = [...build_index.keys()].filter(
    (relative) => deploy_index_before.get(relative) === build_index.get(relative),
  ).length;
  report.pass("部署副本与构建一致", `${identical_count}/${build_index.size} 个文件哈希一致`);
  if (identical_count !== build_index.size || deploy_index_before.size !== build_index.size)
    report.fail("部署副本与构建一致", "存在哈希不一致或多余文件");

  const probe_line = build_worker_probe_line();
  for (const entry of WORKER_ENTRY_FILES) {
    const target = path.join(deploy_dir, entry);
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original}${probe_line}`, "utf8");
  }
  const deploy_index_after = hash_directory(deploy_dir);
  const changed_files = [...build_index.keys()].filter(
    (relative) => deploy_index_after.get(relative) !== build_index.get(relative),
  );
  const probe_only_diff =
    changed_files.length === WORKER_ENTRY_FILES.length &&
    changed_files.every((relative) =>
      readFileSync(path.join(deploy_dir, relative), "utf8").endsWith(
        readFileSync(path.join(options.build_dir, relative), "utf8") + probe_line,
      ),
    );
  report.pass(
    "worker 探针追加范围",
    probe_only_diff
      ? `仅 ${changed_files.join("、")} 追加探针日志行，其余文件保持构建产物原样`
      : `差异文件：${changed_files.join(", ")}`,
  );
  if (!probe_only_diff) report.fail("worker 探针追加范围", "差异超出预期的两个 worker 入口");

  process.stdout.write(`[verify] 部署目录 ${deploy_dir}\n`);
  process.stdout.write(`[verify] 数据根 ${data_root}\n`);

  const mock_server = await start_long_task_mock_server({
    port: 0,
    log: path.join(log_dir, "long-task-mock-requests.jsonl"),
    min_delay_ms: options.min_delay_ms,
    max_delay_ms: options.max_delay_ms,
    delay_ms: options.chunk_delay_ms,
  });
  process.stdout.write(
    `[verify] 模拟模型服务 ${mock_server.baseUrl}（前置延迟 ${options.min_delay_ms}~${options.max_delay_ms}ms，分片 ${options.chunk_delay_ms}ms）\n`,
  );

  await assert_port_free(options.port);

  const service = new WebServiceProcess(
    spawn(
      process.execPath,
      [path.join(deploy_dir, "index.mjs"), `--port=${options.port}`, `--data-root=${data_root}`],
      {
        cwd: deploy_dir, // 以部署目录为工作目录，证明运行不依赖仓库位置
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
    log_dir,
  );
  process.stdout.write(`[verify] 服务进程 pid=${service.pid}\n`);

  let client = null;
  let collector = null;
  let command_id = `long-task-${Date.now().toString(36)}`;
  let translate_started_at = null;
  const samples = [];
  const pace_log = [];
  let current_pace = {
    min_delay_ms: options.min_delay_ms,
    max_delay_ms: options.max_delay_ms,
  };

  /** 单次探针：健康检查与快照查询延迟、SSE 事件增量。 */
  const take_sample = async (label) => {
    const at = new Date();
    const health_started = performance.now();
    const health = await fetch(`${service_base_url}/api/health`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    await health.text();
    const health_ms = performance.now() - health_started;
    const snapshot_started = performance.now();
    const snapshot = await client.post("/api/batch-translation/snapshot", {});
    const snapshot_ms = performance.now() - snapshot_started;
    const batch = snapshot?.["batch_translation"] ?? {};
    const run = batch.run_progress ?? batch.progress ?? {};
    const sse = collector.drain();
    const sample = {
      label,
      at: at.toISOString(),
      elapsed_ms: translate_started_at === null ? null : at.getTime() - translate_started_at,
      health_ms: Math.round(health_ms * 100) / 100,
      snapshot_ms: Math.round(snapshot_ms * 100) / 100,
      health_status: health.status,
      revision: batch.revision ?? null,
      status: batch.status ?? null,
      processed_line: run.processed_line ?? null,
      total_line: run.total_line ?? null,
      error_line: run.error_line ?? null,
      sse_fresh: sse.fresh_count,
      sse_last_revision: sse.last_revision,
      sse_keepalives: sse.keepalives,
    };
    samples.push(sample);
    appendFileSync(samples_path, `${JSON.stringify(sample)}\n`);
    process.stdout.write(
      `[probe ${String(samples.length).padStart(2, "0")}] ${sample.at} elapsed=${
        sample.elapsed_ms === null ? "-" : `${Math.round(sample.elapsed_ms / 1000)}s`
      } health=${format_ms(sample.health_ms)} snapshot=${format_ms(sample.snapshot_ms)} rev=${
        sample.revision
      } status=${sample.status} processed=${sample.processed_line}/${sample.total_line} error=${
        sample.error_line
      } sse=+${sample.sse_fresh} last_rev=${sample.sse_last_revision}\n`,
    );
    return { sample, batch };
  };

  /** 节奏校准：按投影完成时间把整批翻译稳定在目标时长附近。 */
  const control_pace = async (sample) => {
    const total = Number(sample.total_line ?? 0);
    const done = Number(sample.processed_line ?? 0);
    const elapsed_s = (sample.elapsed_ms ?? 0) / 1000;
    if (total <= 0 || done <= 0 || done >= total || elapsed_s <= 0) return;
    // 预热期不校准：流水线起步阶段的吞吐估计偏保守，此时调整会过度加大延迟。
    if (elapsed_s < PACE_WARMUP_S) return;
    const target_s = options.target_duration_ms / 1000;
    const projected_remaining_s = (total - done) / (done / elapsed_s);
    let next = null;
    let reason = "";
    if (elapsed_s >= target_s) {
      next = { min_delay_ms: PACE_FLOOR_MS, max_delay_ms: PACE_FLOOR_MS };
      reason = `已超过目标时长 ${Math.round(elapsed_s)}s，尽快收尾`;
    } else {
      const desired_remaining_s = Math.max(60, target_s - elapsed_s);
      const ratio = projected_remaining_s / desired_remaining_s;
      if (ratio >= 0.8 && ratio <= 1.25) return; // 投影命中目标区间，不调整
      // 阻尼修正：每探针只按投影比平方根的倒数调整，避免在估计噪声上反复过冲。
      // 投影比大于 1 表示收尾慢于目标，需要缩短延迟；小于 1 需要拉长延迟。
      const factor = clamp(1 / Math.sqrt(ratio), 0.5, 2);
      next = {
        min_delay_ms: clamp(
          Math.round((current_pace.min_delay_ms * factor) / 100) * 100,
          PACE_FLOOR_MS,
          PACE_CEILING_MS,
        ),
        max_delay_ms: clamp(
          Math.round((current_pace.max_delay_ms * factor) / 100) * 100,
          PACE_FLOOR_MS,
          PACE_CEILING_MS,
        ),
      };
      reason = `投影剩余 ${Math.round(projected_remaining_s)}s / 期望 ${Math.round(
        desired_remaining_s,
      )}s（ratio ${ratio.toFixed(2)}，阻尼因子 ${factor.toFixed(2)}）`;
    }
    // 硬上限保护：投影完成时间超出 max-wait 时直接压到延迟下限。
    const hard_deadline_ms = run_started_at_ms + options.max_wait_ms;
    const projected_end_ms = Date.now() + projected_remaining_s * 1000;
    if (projected_end_ms > hard_deadline_ms) {
      next = { min_delay_ms: PACE_FLOOR_MS, max_delay_ms: PACE_FLOOR_MS };
      reason = `投影完成时间超出硬上限 ${new Date(hard_deadline_ms).toISOString()}，压到延迟下限`;
    }
    const response = await fetch(`${mock_server.baseUrl}/__control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).catch((error) => {
      throw new Error(`pace control request failed: ${String(error)}`);
    });
    if (!response.ok) {
      process.stdout.write(`[pace] 控制请求失败 HTTP ${response.status}\n`);
      return;
    }
    current_pace = next;
    pace_log.push({ at: new Date().toISOString(), reason, pace: { ...next } });
    process.stdout.write(
      `[pace] 调整前置延迟到 ${next.min_delay_ms}~${next.max_delay_ms}ms：${reason}\n`,
    );
  };

  let run_started_at_ms = Date.now();
  let service_base_url = "";

  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    service_base_url = access.baseUrl;
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
    report.pass("仓库外启动与访问会话", `HTTP ${session.status} port=${options.port}`);

    const bootstrap = await client.data("GET", "/api/web/bootstrap");
    const capabilities = bootstrap?.["capabilities"] ?? {};
    report.pass(
      "能力事实",
      `imageHost=${capabilities["imageHost"]} pdfHost=${capabilities["pdfHost"]}`,
    );

    // 空闲基线：翻译开始前的健康检查与快照查询延迟，用于量级对比。
    const baseline = [];
    for (let index = 0; index < 3; index += 1) {
      const health_started = performance.now();
      const health = await fetch(`${access.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      await health.text();
      const snapshot_started = performance.now();
      await client.post("/api/batch-translation/snapshot", {});
      baseline.push({
        health_ms: Math.round((performance.now() - health_started) * 100) / 100,
        snapshot_ms: Math.round((performance.now() - snapshot_started) * 100) / 100,
      });
      await sleep(500);
    }
    report.pass(
      "空闲基线延迟",
      `health ${baseline.map((item) => `${item.health_ms}ms`).join("/")}；snapshot ${baseline
        .map((item) => `${item.snapshot_ms}ms`)
        .join("/")}`,
    );

    // 模型配置：自定义 OpenAI 模型指向模拟服务，固定并发额度，选为翻译用途。
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
        api_url: mock_server.baseUrl,
        api_key: "no-key-required",
        model_id: "long-task-mock-model",
        threshold: {
          input_token_limit: 512,
          rpm_limit: 0,
          concurrency_limit: options.concurrency,
        },
      },
    });
    const selection = await client.post("/api/models/select", {
      target: "translation",
      model_id,
    });
    report.pass(
      "翻译模型配置",
      `translation=${selection?.["model_selection"]?.["translation"]} concurrency=${options.concurrency}`,
    );

    // 合成长篇小说：单文件、每行唯一，按行成为翻译条目。
    const novel_lines = Array.from({ length: options.items }, (_, index) =>
      NOVEL_LINE_TEMPLATE.replace("{index}", String(index + 1)),
    );
    const novel_bytes = Buffer.from(`${novel_lines.join("\n")}\n`, "utf8");
    const material = await client.upload("novel/long-task.txt", novel_bytes);
    const material_id = String(material?.["material_id"] ?? "");
    if (material_id === "") throw new VerifyFailure("upload material record incomplete");
    const summary = await client.post("/api/session/source-files/summary", {
      source_paths: [String(material["path"])],
    });
    const hits = summary?.["format_hit_counts"] ?? {};
    report.pass("合成小说上传", `条目 ${options.items} 行，格式命中 txt=${hits["txt"] ?? 0}`);
    if (hits["txt"] !== 1) report.fail("合成小说上传", `txt 命中数 ${hits["txt"]} 期望 1`);

    const created = await client.post("/api/session/project/create", {
      path: project_path,
      material_ids: [material_id],
    });
    const failed_files = created?.["failed_files"] ?? [];
    report.pass(
      "工程创建",
      failed_files.length === 0 ? project_path : `失败 ${failed_files.length} 个`,
    );
    if (failed_files.length > 0)
      report.fail("工程创建", JSON.stringify(failed_files).slice(0, 300));

    const workbench = await client.post("/api/workbench/snapshot", {});
    const file_entries = workbench?.["snapshot"]?.["entries"] ?? [];
    const item_total = file_entries.reduce(
      (sum, entry) => sum + Number(entry?.["progress"]?.["total_count"] ?? 0),
      0,
    );
    report.pass("工程条目落库", `文件 ${file_entries.length} 个，条目 ${item_total} 条`);
    if (item_total !== options.items)
      report.fail("工程条目落库", `条目 ${item_total} 期望 ${options.items}`);

    // SSE 订阅先于翻译受理，保证事件序列从起点完整可见。
    collector = new SnapshotEventCollector({ baseUrl: access.baseUrl, cookie });
    await collector.connect();

    run_started_at_ms = Date.now();
    const started = await client.post("/api/batch-translation/start", {
      operation: "translate",
      mode: "new",
      scope: { kind: "all" },
      command_id,
    });
    translate_started_at = new Date();
    const accepted = started?.["accepted"] === true;
    report.pass(
      "翻译受理",
      accepted ? `command_id=${command_id} accepted` : JSON.stringify(started).slice(0, 200),
    );
    if (!accepted) report.fail("翻译受理", "start 未接受命令");
    const start_status = started?.["batch_translation"]?.["status"];
    if (start_status !== "requested" && start_status !== "running")
      report.fail("翻译受理", `受理后状态 ${start_status}`);

    // 长任务探针循环：每 30 秒采样，终态或硬上限时结束。
    let terminal = null;
    let timed_out = false;
    let consecutive_probe_errors = 0;
    for (;;) {
      let sample = null;
      let batch = null;
      try {
        ({ sample, batch } = await take_sample("run"));
        consecutive_probe_errors = 0;
      } catch (error) {
        // 探针失败不静默：记录时间点与原因，连续失败视为服务劣化并终止等待。
        consecutive_probe_errors += 1;
        process.stdout.write(
          `[probe-err] ${new Date().toISOString()} 第 ${consecutive_probe_errors} 次连续失败：${String(
            error,
          ).slice(0, 200)}\n`,
        );
        if (consecutive_probe_errors >= 6) {
          report.fail("长任务探针连续失败", `连续 ${consecutive_probe_errors} 次探针失败`);
          break;
        }
        await sleep(options.probe_interval_ms);
        continue;
      }
      if (
        sample.status !== "running" &&
        sample.status !== "requested" &&
        sample.status !== "stopping"
      ) {
        terminal = batch;
        break;
      }
      if (Date.now() - run_started_at_ms > options.max_wait_ms) {
        timed_out = true;
        break;
      }
      try {
        await control_pace(sample);
      } catch (error) {
        process.stdout.write(`[pace] 校准失败：${String(error).slice(0, 200)}\n`);
      }
      await sleep(options.probe_interval_ms);
    }
    if (timed_out) {
      report.fail("长任务在硬上限内完成", `超过 ${options.max_wait_ms}ms 仍未终态`);
      const { batch } = await take_sample("timeout");
      terminal = batch;
    }

    // 终态核对。
    const final_status = terminal?.status;
    const run_progress = terminal?.run_progress ?? {};
    const project_progress = terminal?.progress ?? {};
    report.pass(
      "翻译终态",
      `status=${final_status} processed=${run_progress.processed_line}/${run_progress.total_line} error=${run_progress.error_line}`,
    );
    if (final_status !== "done") report.fail("翻译终态", `期望 done，实际 ${final_status}`);
    if (Number(run_progress.error_line ?? -1) !== 0)
      report.fail("翻译终态", `本轮 error_line=${run_progress.error_line}`);
    if (Number(run_progress.processed_line ?? -1) !== Number(run_progress.total_line ?? -2))
      report.fail("翻译终态", "本轮 processed_line 与 total_line 不一致");
    if (Number(project_progress.processed_line ?? -1) !== options.items)
      report.fail(
        "翻译终态",
        `工程累计 processed_line=${project_progress.processed_line} 期望 ${options.items}`,
      );

    // 命令身份去重：同一 command_id 重复提交回放终态，不新建运行。
    const duplicate = await client.post("/api/batch-translation/start", {
      operation: "translate",
      mode: "new",
      scope: { kind: "all" },
      command_id,
    });
    const duplicate_flag = duplicate?.["duplicate"] === true && duplicate?.["accepted"] === false;
    report.pass(
      "命令身份去重",
      duplicate_flag
        ? `duplicate=${duplicate["duplicate"]} 回放 status=${duplicate?.["batch_translation"]?.["status"]}`
        : JSON.stringify(duplicate).slice(0, 200),
    );
    if (!duplicate_flag) report.fail("命令身份去重", "重复提交未被识别为 duplicate");

    // 译文文件落盘：经正式生成入口写回，并独立读盘核对行数与内容。
    const generation = await client.post("/api/translation/files/generate", {});
    const output_path = String(generation?.["output_path"] ?? "");
    const generated_files = (Array.isArray(generation?.["files"]) ? generation["files"] : []).map(
      read_generated_file_path,
    );
    report.pass("译文生成", `output=${output_path} files=${generated_files.length}`);
    if (output_path === "" || generated_files.length === 0)
      report.fail("译文生成", "生成结果没有输出路径或文件清单");
    const translated_file =
      generated_files.find(
        (entry) => entry.startsWith(output_path) && entry.endsWith("long-task.txt"),
      ) ?? path.join(output_path, "long-task.txt");
    if (!existsSync(translated_file)) {
      report.fail("译文文件落盘", `未找到 ${translated_file}`);
    } else {
      const written = readFileSync(translated_file, "utf8").split("\n");
      if (written.at(-1) === "") written.pop();
      // 模拟模型回显源文并加固定前缀：逐行等于 `【译】` + 源文即证明条目对齐与写回完整。
      const expected_lines = novel_lines.map((line) => `【译】${line}`);
      const mismatches = written.filter((line, index) => line !== (expected_lines[index] ?? null));
      report.pass(
        "译文文件落盘",
        `${translated_file} 行数 ${written.length}/${options.items}，逐行一致 ${
          written.length - mismatches.length
        } 行${mismatches.length === 0 ? "" : `，不一致 ${mismatches.length} 行`}`,
      );
      if (written.length !== options.items)
        report.fail("译文文件落盘", `行数 ${written.length} 期望 ${options.items}`);
      if (mismatches.length > 0)
        report.fail(
          "译文文件落盘",
          `不一致行数 ${mismatches.length}，首例 ${JSON.stringify(
            mismatches[0]?.slice(0, 80) ?? "",
          )}`,
        );
      const stat = statSync(translated_file);
      report.pass("译文文件体积", `${stat.size} 字节`);
    }

    // 统计回读：数据库事实可重复读取。
    const stats = await client.post("/api/project/translation-stats", {});
    const stats_body = stats?.["stats"] ?? {};
    report.pass(
      "翻译统计回读",
      `total=${stats_body["total_items"]} completed=${stats_body["completed_count"]} failed=${stats_body["failed_count"]} percent=${stats_body["completion_percent"]}`,
    );
    if (Number(stats_body["total_items"]) !== options.items)
      report.fail("翻译统计回读", `total_items=${stats_body["total_items"]} 期望 ${options.items}`);
    if (Number(stats_body["completed_count"]) !== options.items)
      report.fail("翻译统计回读", `completed=${stats_body["completed_count"]}`);
    if (Number(stats_body["failed_count"]) !== 0)
      report.fail("翻译统计回读", `failed=${stats_body["failed_count"]}`);
    if (Number(stats_body["completion_percent"]) !== 100)
      report.fail("翻译统计回读", `completion_percent=${stats_body["completion_percent"]}`);

    // SSE 事件序列核对：revision 严格单调、采样期间无断开。
    const sse_summary = collector.drain();
    const monotonic = sse_summary.violations.length === 0;
    report.pass(
      "SSE revision 单调",
      `事件 ${collector.revisions.length} 条，revision ${
        collector.revisions[0] ?? "-"
      }→${sse_summary.last_revision}，违例 ${sse_summary.violations.length}`,
    );
    if (!monotonic)
      report.fail(
        "SSE revision 单调",
        `非严格单调：${sse_summary.violations.slice(0, 5).join(", ")}`,
      );
    if (collector.revisions.length === 0)
      report.fail("SSE revision 单调", "没有收到任何 batch_translation 事件");
    if (collector.disconnected_before_end)
      report.fail("SSE 连接持续", `订阅中断：${collector.disconnect_reason}`);
    else report.pass("SSE 连接持续", `keepalive ${sse_summary.keepalives} 次，未断开`);
    if (
      sse_summary.last_revision !== null &&
      sse_summary.last_revision > Number(terminal?.revision ?? 0)
    )
      report.fail("SSE revision 单调", "SSE 末 revision 超过终态快照 revision");

    // 延迟量级对比：翻译期间健康检查与快照查询相对空闲基线同量级。
    const run_samples = samples.filter((sample) => sample.label === "run");
    const warm_samples = run_samples.slice(1); // 首个样本含流水线预热，单独列出的同时不并入结论
    const max_health = Math.max(...run_samples.map((sample) => sample.health_ms), 0);
    const max_health_warm = Math.max(...warm_samples.map((sample) => sample.health_ms), 0);
    const avg_health =
      run_samples.reduce((sum, sample) => sum + sample.health_ms, 0) /
      Math.max(1, run_samples.length);
    const median_health = [...run_samples].map((sample) => sample.health_ms).sort((a, b) => a - b)[
      Math.floor(run_samples.length / 2)
    ];
    const max_snapshot = Math.max(...run_samples.map((sample) => sample.snapshot_ms), 0);
    const max_snapshot_warm = Math.max(...warm_samples.map((sample) => sample.snapshot_ms), 0);
    const avg_snapshot =
      run_samples.reduce((sum, sample) => sum + sample.snapshot_ms, 0) /
      Math.max(1, run_samples.length);
    const baseline_health_max = Math.max(...baseline.map((item) => item.health_ms));
    const baseline_snapshot_max = Math.max(...baseline.map((item) => item.snapshot_ms));
    report.pass(
      "翻译期间服务响应",
      `health avg ${avg_health.toFixed(1)}ms / 中位 ${median_health}ms / max ${max_health}ms（剔除预热 ${max_health_warm}ms；空闲 max ${baseline_health_max}ms）；snapshot avg ${avg_snapshot.toFixed(
        1,
      )}ms / max ${max_snapshot}ms（剔除预热 ${max_snapshot_warm}ms；空闲 max ${baseline_snapshot_max}ms）`,
    );
    if (max_health_warm > Math.max(1_000, baseline_health_max * 20))
      report.fail("翻译期间服务响应", `健康检查峰值 ${max_health_warm}ms 超过空闲量级`);
    if (max_snapshot_warm > Math.max(1_000, baseline_snapshot_max * 20))
      report.fail("翻译期间服务响应", `快照查询峰值 ${max_snapshot_warm}ms 超过空闲量级`);

    // worker 仓库外加载证据：部署副本 worker 入口的加载探针 + 进程事实。
    const probe_lines = [...new Set(service.read_worker_probe_lines())];
    const facts = read_process_facts(service.pid);
    for (const entry of WORKER_ENTRY_FILES) {
      const expected = `file://${path.join(deploy_dir, entry)}`;
      const matched = probe_lines.filter((line) => line.includes(expected));
      report.pass(
        `worker 仓库外加载（${entry}）`,
        matched.length > 0 ? matched[0] : `未观测到 ${expected} 的加载日志`,
      );
      if (matched.length === 0) report.fail(`worker 仓库外加载（${entry}）`, "缺少加载探针日志");
    }
    report.pass(
      "服务进程事实",
      `pid=${service.pid} cwd=${facts.cwd} cmdline=${(facts.cmdline ?? []).join(" ")}`,
    );
    if (facts.cwd !== deploy_dir)
      report.fail("服务进程事实", `cwd=${facts.cwd} 期望 ${deploy_dir}`);
    const cmdline_text = (facts.cmdline ?? []).join(" ");
    if (!cmdline_text.includes(path.join(deploy_dir, "index.mjs")))
      report.fail("服务进程事实", "命令行未包含部署目录入口");
    const worker_threads = Number(facts.threads?.["WorkerThread"] ?? 0);
    report.pass(
      "worker 线程普查",
      `WorkerThread=${worker_threads}（线程名分布 ${JSON.stringify(facts.threads)}）`,
    );
    if (worker_threads < 1) report.fail("worker 线程普查", "服务进程内没有 worker 线程");

    // 控制台 / 日志无未处理错误。
    const console_errors = service.read_console_error_lines();
    report.pass(
      "控制台无 ERROR/FATAL",
      console_errors.length === 0 ? "0 条" : console_errors.slice(0, 3).join(" | ").slice(0, 300),
    );
    if (console_errors.length > 0)
      report.fail("控制台无 ERROR/FATAL", `${console_errors.length} 条`);
    const stderr_markers = service.stderr
      .split("\n")
      .filter((line) =>
        /unhandled|uncaught|ERR_UNHANDLED|ERR_WORKER|worker\.failed|FATAL|\[fatal\]|\[startup\]/iu.test(
          line,
        ),
      );
    report.pass(
      "stderr 无未处理错误",
      stderr_markers.length === 0 ? "0 条" : stderr_markers.slice(0, 3).join(" | ").slice(0, 300),
    );
    if (stderr_markers.length > 0)
      report.fail("stderr 无未处理错误", `${stderr_markers.length} 条`);

    // 节奏校准记录（诊断输出）。
    if (pace_log.length > 0)
      process.stdout.write(
        `[verify] 节奏校准 ${pace_log.length} 次：${pace_log
          .map(
            (item) =>
              `${item.at} ${item.pace.min_delay_ms}~${item.pace.max_delay_ms}ms（${item.reason}）`,
          )
          .join("；")}\n`,
      );
    const mock_stats = await (await fetch(`${mock_server.baseUrl}/__stats`)).json();
    report.pass(
      "模拟模型请求统计",
      `requests=${mock_stats.requests} completed=${mock_stats.completed} translation=${mock_stats.translation_requests} items=${mock_stats.translation_items} avg=${mock_stats.avg_duration_ms}ms max=${mock_stats.max_duration_ms}ms`,
    );
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    collector?.close();
    await service.stop();
    service.close_logs();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }
    await mock_server.close();

    // 服务停止后不得残留 Chromium 进程或临时 profile（本探针不应启动浏览器）。
    const profiles = list_chromium_profiles();
    const processes = list_chromium_processes();
    report.pass("无浏览器启动", `profile=${profiles.length} process=${processes.length}`);
    if (profiles.length > 0) report.fail("无浏览器启动", `残留 profile：${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("无浏览器启动", `残留进程：${processes[0].slice(0, 160)}`);

    // 优雅停止：退出码必须为 0。
    const exit_code = service.child.exitCode;
    report.pass("服务正常停止", `exitCode=${exit_code}`);
    if (exit_code !== 0) report.fail("服务正常停止", `exitCode=${exit_code}`);

    // 无残留进程：按部署路径扫描，服务与 worker 线程都应随进程退出。
    const ps_result = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
    const leftover = String(ps_result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && line.includes(deploy_dir));
    report.pass("无残留进程", leftover.length === 0 ? "0 个" : leftover[0].slice(0, 160));
    if (leftover.length > 0)
      report.fail("无残留进程", `残留：${leftover.join(" | ").slice(0, 300)}`);

    if (options.keep) process.stdout.write(`[verify] 保留产物目录 ${artifacts}\n`);
    else {
      rmSync(artifacts, { recursive: true, force: true });
      report.pass("临时产物清理", existsSync(artifacts) ? "仍存在" : `${artifacts} 已删除`);
      if (existsSync(artifacts)) report.fail("临时产物清理", "临时目录未删除");
    }
    // 证据目录在产物目录外时保留给运行方取证，不随产物目录清理。
    if (!log_dir.startsWith(artifacts)) process.stdout.write(`[verify] 证据目录保留 ${log_dir}\n`);
  }

  process.stdout.write("---- 汇总 ----\n");
  for (const result of report.results)
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}\n`);
  process.stdout.write(
    `通过 ${report.results.length - report.failed_count}/${report.results.length}\n`,
  );

  // 延迟采样表：时间戳 + 健康检查/快照查询延迟 + revision + 进度。
  process.stdout.write("---- 延迟采样表 ----\n");
  process.stdout.write(
    "| # | 时间戳 | 运行时长 | 健康检查 | 快照查询 | revision | 状态 | 进度 | SSE 增量 |\n",
  );
  process.stdout.write("|---|---|---|---|---|---|---|---|---|\n");
  for (const [index, sample] of samples.entries())
    process.stdout.write(
      `| ${index + 1} | ${sample.at} | ${
        sample.elapsed_ms === null ? "-" : `${Math.round(sample.elapsed_ms / 1000)}s`
      } | ${format_ms(sample.health_ms)} | ${format_ms(sample.snapshot_ms)} | ${
        sample.revision
      } | ${sample.status} | ${sample.processed_line}/${sample.total_line} | +${sample.sse_fresh} |\n`,
    );
  return report.failed_count === 0 ? 0 : 1;
}

/** 生成结果里的文件条目可能是对象或字符串，统一取可读路径。 */
function read_generated_file_path(entry) {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const record = entry;
    for (const key of ["path", "name", "file_path"]) {
      const value = record[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return String(entry);
}

process.exitCode = await main();
