#!/usr/bin/env node
/**
 * Chromium 宿主峰值资源探针（TW-09 / R-07 最后一项）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs <web-root>` 把 Web 产物构建到
 * 脚本指定的输出目录（不要复用仓库 build/web，避免与其它验证争抢）。
 *
 * 覆盖内容：
 *   1. 临时数据根 + 自有端口启动真实 Web 服务与 Agent 模拟模型（`--script host`
 *      会驱动 `emitImage` 与 `host({kind:"print_pdf"})`）；
 *   2. 以约 200ms 间隔采样本机 Chromium 进程树的 `/proc/<pid>/status`（VmRSS）与
 *      `/proc/<pid>/stat`（utime+stime），按 profile 标记（`lg-chromium-`）识别产品进程；
 *   3. 分别记录空闲基线（服务已起、无浏览器）、图片任务与 PDF 任务的峰值 RSS 与 CPU 时间；
 *   4. 停止服务后核对进程与临时 profile 均已回收（残留应为 0）。
 *
 * 只使用测试自有合成数据，不读取仓库真实样例；不修改任何产品代码或既有脚本。
 *
 * 用法：
 *   node buildtools/web-chromium-host-resource-probe.mjs
 *       [--web-root <dir>] [--port 8481] [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { start_agent_mock_server } from "./agent-mock-model-server.mjs";

const DEFAULT_WEB_ROOT = "/data/data/com.termux/files/usr/tmp/lg-a1-build/web";

// 产物目录前缀不得以 lg-chromium- 开头：那是宿主临时 profile 前缀，会被回收断言误报。
const ARTIFACT_PREFIX = "lg-host-resource-probe-";
const PROFILE_PREFIX = "lg-chromium-";
const PROFILE_MARKER = "--user-data-dir=";

// 采样间隔约 200ms；CPU 时间以时钟滴答累计，本机 USER_HZ=100（已实测校准）。
const SAMPLE_INTERVAL_MS = 200;
// 阶段边界轮询更快：图片与 PDF 任务都很短，粗间隔会把两个标记吞进同一次采样。
const MARKER_POLL_INTERVAL_MS = 40;
const CLK_TCK = 100;

// 工作区子进程把 stdout 直接写入日志文件（real time），据此判定任务阶段边界。
const IMAGE_DONE_MARKER = "emitted workspace image through the image host";
const PDF_DONE_MARKER = "printed pdf path=";

const MATERIAL_NAME = "chromium-resource-probe.txt";
const MATERIAL_TEXT = [
  "Chromium 宿主峰值资源探针的合成材料第一行。",
  "第二行同样为合成文本，用于创建最小工程。",
].join("\n");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 60_000;
const MARKER_WAIT_TIMEOUT_MS = 150_000;
const IDLE_BASELINE_MS = 2_000; // 发送消息前先采样一段空闲基线
const RESIDUAL_WINDOW_MS = 2_000; // 服务停止后再采样一段，核对归零

class ProbeFailure extends Error {}

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

  note(name, detail) {
    // 只记录观测事实，不计入通过 / 失败门禁。
    process.stdout.write(`NOTE ${name}：${detail}\n`);
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
  throw new ProbeFailure(`Timed out waiting for: ${description}`);
}

/** 读取 /proc/<pid>/status 的 VmRSS（kB）；进程已退出或不可读时按 0 计。 */
function read_vmrss_kb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/mu);
    return match === null ? 0 : Number(match[1]);
  } catch {
    // 采样与进程退出竞争：读不到即视为该进程本次无驻留内存。
    return 0;
  }
}

/**
 * 读取 /proc/<pid>/smaps_rollup 的 Pss（kB，比例集大小）。
 * 进程树各进程从同一基线 fork，VmRSS 之和会重复计入共享页；Pss 按比例分摊共享页，
 * 用于给出更接近实际独占驻留的口径。读不到（内核不支持或进程退出）时按 0 计。
 */
function read_pss_kb(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const match = rollup.match(/^Pss:\s+(\d+)\s+kB$/mu);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

/**
 * 读取 /proc/<pid>/stat 的 utime+stime（时钟滴答）。
 * comm 字段可能含空格与括号，取最后一个右括号后再按位置取字段。
 */
function read_cpu_ticks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return 0;
    const fields = stat.slice(close + 2).split(" ");
    // fields[0] 是 state（第 3 字段）；第 N 字段 = fields[N-3]；utime=14、stime=15。
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return 0;
    return utime + stime;
  } catch {
    // 进程在读取间隔退出属于正常竞争，按 0 计。
    return 0;
  }
}

/** 从命令行读取宿主自有的临时 profile 目录名；非本产品进程返回 null。 */
function read_chromium_profile(args) {
  const start = args.indexOf(PROFILE_MARKER);
  if (start === -1) return null;
  const value = args.slice(start + PROFILE_MARKER.length).split(/\s/u)[0] ?? "";
  const name = path.basename(value);
  return name.startsWith(PROFILE_PREFIX) ? name : null;
}

/**
 * 列出产品启动的 Chromium 进程。
 * Termux 的 chromium-headless 包装脚本会 exec 成 chrome，命令行不含原始可执行文件路径，
 * 因此按 profile 标记识别；主进程与渲染 / 工具 / 网络子进程都带 `--user-data-dir=`。
 */
function list_product_chromium() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return { pids: [], profiles: [] };
  const pids = [];
  const profiles = new Set();
  for (const line of String(result.stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const separator = trimmed.search(/\s/u);
    if (separator === -1) continue;
    const pid = Number(trimmed.slice(0, separator));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const profile = read_chromium_profile(trimmed.slice(separator).trim());
    if (profile === null) continue;
    pids.push(pid);
    profiles.add(profile);
  }
  return { pids, profiles: [...profiles] };
}

/** 读取系统临时目录下的 Chromium profile 目录名；服务停止后应当为空。 */
function list_profile_directories() {
  try {
    return readdirSync(os.tmpdir()).filter((name) => name.startsWith(PROFILE_PREFIX));
  } catch {
    return [];
  }
}

/** 一次采样：汇总进程树的 RSS（MB）、PSS（MB）、CPU（秒）与进程数。 */
function sample_chromium() {
  const { pids, profiles } = list_product_chromium();
  let rss_kb = 0;
  let pss_kb = 0;
  let cpu_ticks = 0;
  for (const pid of pids) {
    rss_kb += read_vmrss_kb(pid);
    pss_kb += read_pss_kb(pid);
    cpu_ticks += read_cpu_ticks(pid);
  }
  return {
    t_ms: Date.now(),
    rss_mb: rss_kb / 1024,
    pss_mb: pss_kb / 1024,
    cpu_sec: cpu_ticks / CLK_TCK,
    count: pids.length,
    pids,
    profiles,
  };
}

/**
 * 资源监控器：周期性采样进程树，并轮询工作区执行日志判定任务阶段边界。
 * 浏览器按需启动于首次图片请求，进程树 CPU 从 0 累计，因此图片任务结束时的
 * 绝对 CPU 即图片阶段（含一次性启动）的 CPU；PDF 阶段 CPU 为两次边界的差值。
 */
class ChromiumResourceMonitor {
  constructor(workspace_base) {
    this.workspace_base = workspace_base;
    this.samples = [];
    this.seen_profiles = new Set();
    this.current_pids = [];
    this.markers = { image_done: null, pdf_done: null };
    this.marker_flags = { image: false, pdf: false };
    this.running = false;
  }

  start() {
    this.running = true;
    void this.sample_loop();
    void this.marker_loop();
  }

  stop() {
    this.running = false;
  }

  async sample_loop() {
    while (this.running) {
      const started_at = Date.now();
      const sample = sample_chromium();
      this.current_pids = sample.pids;
      this.samples.push(sample);
      for (const profile of sample.profiles) this.seen_profiles.add(profile);
      // 采样本身耗时（ps + 每进程 status / smaps_rollup / stat），按剩余时间补齐，保持约 200ms 节奏。
      await sleep(Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - started_at)));
    }
  }

  async marker_loop() {
    while (this.running) {
      if (this.marker_flags.image && this.marker_flags.pdf) return;
      this.poll_markers();
      await sleep(MARKER_POLL_INTERVAL_MS);
    }
  }

  /** 读取当前进程树的累计 CPU（秒），用于边界时刻的精确取值。 */
  read_current_cpu_sec() {
    let ticks = 0;
    for (const pid of this.current_pids) ticks += read_cpu_ticks(pid);
    return ticks / CLK_TCK;
  }

  poll_markers() {
    let text = "";
    for (const file of this.find_stdout_logs()) {
      try {
        text += `${readFileSync(file, "utf8")}\n`;
      } catch {
        // 日志正在写入或尚未刷出：本次轮询跳过，下次再读。
      }
    }
    if (!this.marker_flags.image && text.includes(IMAGE_DONE_MARKER)) {
      this.marker_flags.image = true;
      this.markers.image_done = { t_ms: Date.now(), cpu_sec: this.read_current_cpu_sec() };
      process.stdout.write(
        `[monitor] image task done at cpu=${this.markers.image_done.cpu_sec.toFixed(3)}s\n`,
      );
    }
    if (!this.marker_flags.pdf && text.includes(PDF_DONE_MARKER)) {
      this.marker_flags.pdf = true;
      this.markers.pdf_done = { t_ms: Date.now(), cpu_sec: this.read_current_cpu_sec() };
      process.stdout.write(
        `[monitor] pdf task done at cpu=${this.markers.pdf_done.cpu_sec.toFixed(3)}s\n`,
      );
    }
  }

  /** 递归查找工作区执行日志：会话目录身份随机，按 userdata/workspace 扫描。 */
  find_stdout_logs() {
    const logs = [];
    let sessions;
    try {
      sessions = readdirSync(this.workspace_base, { withFileTypes: true });
    } catch {
      return logs;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const runs_directory = path.join(this.workspace_base, session.name, "work", "runs");
      let files;
      try {
        files = readdirSync(runs_directory);
      } catch {
        continue;
      }
      for (const file of files)
        if (file.endsWith(".stdout.log")) logs.push(path.join(runs_directory, file));
    }
    return logs;
  }

  async wait_for_markers(timeout_ms) {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      if (this.marker_flags.image && this.marker_flags.pdf) return true;
      await sleep(SAMPLE_INTERVAL_MS);
    }
    return this.marker_flags.image && this.marker_flags.pdf;
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

  /** 从启动输出解析访问地址与一次性凭据，以及宿主可执行文件路径。 */
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

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await wait_for(
      () => this.child.exitCode !== null,
      SERVICE_STOP_TIMEOUT_MS,
      "Web service to exit",
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
      throw new ProbeFailure(
        `${method} ${route} -> ${response.status} ${JSON.stringify(response.payload).slice(0, 300)}`,
      );
    const envelope = response.payload;
    if (envelope !== null && typeof envelope === "object" && "data" in envelope)
      return envelope["data"];
    return envelope;
  }

  /** 上传类路由只接收查询参数 name 与原始字节，响应是统一 ok 壳。 */
  async upload(route, name, text) {
    const response = await fetch(`${this.baseUrl}${route}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { cookie: this.cookie, "content-type": "text/plain; charset=utf-8" },
      body: text,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (response.status !== 200 || payload === null || payload["ok"] !== true)
      throw new ProbeFailure(
        `${route} failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
      );
    return payload["data"];
  }
}

/** 解析 `--name value` 与 `--name=value` 两种形式的启动参数；未知参数立即失败。 */
function parse_arguments(argv) {
  const options = { web_root: DEFAULT_WEB_ROOT, port: 8481, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    let name = argument;
    let value = "";
    const equals = argument.indexOf("=");
    if (argument.startsWith("--") && equals !== -1) {
      name = argument.slice(0, equals);
      value = argument.slice(equals + 1);
    } else {
      // 兼容 `--name value` 形式：取下一个参数作为值。
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`Missing value for argument: ${argument}`);
      name = argument;
      value = next;
      index += 1;
    }
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = name.slice(2);
    if (value === "") throw new Error(`Empty argument value: ${key}`);
    switch (key) {
      case "web-root":
        options.web_root = value;
        break;
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535)
          throw new Error(`Invalid port: ${value}`);
        options.port = port;
        break;
      }
      case "keep":
        options.keep = value === "true";
        break;
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  return options;
}

function peak_rss(samples) {
  return samples.reduce((maximum, sample) => Math.max(maximum, sample.rss_mb), 0);
}

function peak_pss(samples) {
  return samples.reduce((maximum, sample) => Math.max(maximum, sample.pss_mb), 0);
}

function max_count(samples) {
  return samples.reduce((maximum, sample) => Math.max(maximum, sample.count), 0);
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const web_root = path.resolve(options.web_root);
  const web_server_entry = path.join(web_root, "index.mjs");
  const report = new Report();

  if (!statSync(web_server_entry).isFile())
    throw new ProbeFailure(
      `Web build entry not found: ${web_server_entry}; run build-web.mjs with this output first`,
    );

  const artifacts = mkdtempSync(path.join(os.tmpdir(), ARTIFACT_PREFIX));
  const data_root = path.join(artifacts, "data-root");
  const projects_root = path.join(artifacts, "projects");
  mkdirSync(data_root, { recursive: true });
  mkdirSync(projects_root, { recursive: true });
  const workspace_base = path.join(realpathSync(data_root), "userdata", "workspace");
  process.stdout.write(`[probe] artifacts ${artifacts}\n`);
  process.stdout.write(`[probe] data root ${data_root}\n`);
  process.stdout.write(`[probe] web root ${web_root}\n`);

  const mock_server = await start_agent_mock_server({
    port: 0,
    log: path.join(artifacts, "agent-mock-requests.jsonl"),
    script: "host",
  });
  process.stdout.write(`[probe] mock model ${mock_server.baseUrl} (script=host)\n`);

  const service = new WebServiceProcess(
    spawn(
      process.execPath,
      [web_server_entry, `--port=${options.port}`, `--data-root=${data_root}`],
      { cwd: web_root, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );

  let client = null;
  let monitor = null;
  // 进入前已存在的产品浏览器属于其它实例，回收断言不触碰。
  const foreign_profiles = new Set(list_profile_directories());
  const residual = { processes: [], profiles: [] };

  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web service to print access address",
    );
    process.stdout.write(`[probe] web service ${access.baseUrl}\n`);

    const session = await fetch(`${access.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: access.credential }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const set_cookie = session.headers.get("set-cookie") ?? "";
    const cookie = set_cookie.split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new ProbeFailure(`Access session failed: HTTP ${session.status}`);
    client = new ApiClient(access.baseUrl, cookie);
    report.pass("访问会话", `HTTP ${session.status}`);

    const bootstrap = await client.data("GET", "/api/web/bootstrap");
    const capabilities = bootstrap?.["capabilities"] ?? {};
    report.pass(
      "宿主能力事实",
      `imageHost=${capabilities["imageHost"]} pdfHost=${capabilities["pdfHost"]}`,
    );
    if (capabilities["imageHost"] !== true)
      report.fail("宿主能力事实", `imageHost should be true, got ${capabilities["imageHost"]}`);
    if (capabilities["pdfHost"] !== true)
      report.fail("宿主能力事实", `pdfHost should be true, got ${capabilities["pdfHost"]}`);

    // 模型配置：新增自定义 OpenAI 模型并指向模拟服务，再把 Agent 用途选到该模型。
    const added = await client.data("POST", "/api/models/add", { model_type: "CUSTOM_OPENAI" });
    const custom_model = (added?.["snapshot"]?.["models"] ?? []).find(
      (model) => model?.["type"] === "CUSTOM_OPENAI",
    );
    if (custom_model === undefined)
      throw new ProbeFailure("CUSTOM_OPENAI model missing from snapshot after add");
    const model_id = String(custom_model["id"]);
    await client.data("POST", "/api/models/update", {
      model_id,
      patch: {
        api_url: mock_server.baseUrl,
        api_key: "no-key-required",
        model_id: "agent-mock-model",
      },
    });
    await client.data("POST", "/api/models/select", { target: "agent", model_id });
    await client.data("POST", "/api/settings/update", { agent_approval_mode: "manual" });
    report.pass("模型与审批配置", "agent -> mock, approval=manual");

    // 建最小工程：workspace_run 需要活动工程读取工作区契约。
    const material = await client.upload("/api/web/files/upload", MATERIAL_NAME, MATERIAL_TEXT);
    const material_id = String(material?.["material_id"] ?? "");
    if (material_id === "") throw new ProbeFailure("material upload did not return material_id");
    const project_path = path.join(projects_root, `probe-${randomUUID()}.lg`);
    const project = await client.data("POST", "/api/session/project/create", {
      path: project_path,
      material_ids: [material_id],
    });
    if (project?.["project"]?.["loaded"] !== true)
      throw new ProbeFailure("project create did not reach the loaded state");
    report.pass("合成工程创建", project_path);

    const chat_id = String((await client.data("GET", "/api/agent/snapshot"))?.["chatId"] ?? "");
    if (chat_id === "" || chat_id === "inactive")
      throw new ProbeFailure("Agent chat is not active after project create");

    monitor = new ChromiumResourceMonitor(workspace_base);
    monitor.start();

    // 空闲基线：服务已起、尚未驱动任务，此时不应有浏览器进程。
    await sleep(IDLE_BASELINE_MS);
    const idle_samples = monitor.samples.filter((sample) => sample.count === 0);
    const idle_peak = peak_rss(idle_samples);
    const idle_max_count = max_count(monitor.samples.slice(0, idle_samples.length));
    report.pass(
      "空闲基线无浏览器",
      `samples=${idle_samples.length} peakRSS=${idle_peak.toFixed(1)}MB maxCount=${idle_max_count}`,
    );
    if (idle_max_count > 0)
      report.fail("空闲基线无浏览器", `unexpected browser process: maxCount=${idle_max_count}`);

    // 驱动一次 Agent 回合：mock 的 host 脚本依次调用 emitImage 与 print_pdf。
    const message_sent_at = Date.now();
    await client.data("POST", "/api/agent/message", {
      chatId: chat_id,
      commandId: randomUUID(),
      text: "请运行工作区脚本，输出合成图片并请求打印 PDF。",
      attachments: [],
    });
    process.stdout.write(`[probe] agent message sent at ${message_sent_at}\n`);

    const markers_seen = await monitor.wait_for_markers(MARKER_WAIT_TIMEOUT_MS);
    if (monitor.marker_flags.image) {
      const image = monitor.markers.image_done;
      report.pass(
        "图片任务标记",
        `wall=${image.t_ms - message_sent_at}ms browserCPU=${image.cpu_sec.toFixed(3)}s`,
      );
    } else {
      report.fail("图片任务标记", "image host marker not observed in workspace run log");
    }
    if (monitor.marker_flags.pdf) {
      const pdf = monitor.markers.pdf_done;
      const image = monitor.markers.image_done;
      report.pass(
        "PDF 任务标记",
        `phaseWall=${image === null ? "n/a" : `${pdf.t_ms - image.t_ms}ms`} browserCPU=${pdf.cpu_sec.toFixed(3)}s`,
      );
    } else {
      report.fail("PDF 任务标记", "pdf host marker not observed in workspace run log");
    }
    if (!markers_seen)
      report.fail("任务阶段边界", "timed out waiting for both image and pdf markers");

    // 让在途回合收敛后再停止，避免把等待审批的回合留到服务停止。
    await sleep(500);
    try {
      await client.call("POST", "/api/agent/stop", {});
    } catch {
      // 回合已自行收敛时停止按空操作返回，竞争无害。
    }
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    monitor?.stop();
    await service.stop();
    await mock_server.close();

    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }

    // 停止后继续采样一段，核对进程树归零。
    if (monitor !== null) {
      const residual_start = Date.now();
      while (Date.now() - residual_start < RESIDUAL_WINDOW_MS) {
        const sample = sample_chromium();
        monitor.samples.push(sample);
        await sleep(SAMPLE_INTERVAL_MS);
      }
    }

    // 进程与 profile 回收核对：只针对本次运行创建 / 见过的 profile。
    const live = list_product_chromium();
    const own_live = live.profiles.filter((profile) => monitor?.seen_profiles.has(profile));
    const foreign_live = live.profiles.filter((profile) => !monitor?.seen_profiles.has(profile));
    residual.processes = own_live;
    const remaining = list_profile_directories();
    const own_remaining = remaining.filter((profile) => monitor?.seen_profiles.has(profile));
    const foreign_remaining = remaining.filter((profile) => foreign_profiles.has(profile));
    residual.profiles = own_remaining;
    report.pass("Chromium 进程回收", `own=${own_live.length} foreign=${foreign_live.length}`);
    if (own_live.length > 0)
      report.fail("Chromium 进程回收", `leftover processes for profiles: ${own_live.join(", ")}`);
    report.pass(
      "Chromium profile 回收",
      `own=${own_remaining.length} foreign=${foreign_remaining.length}`,
    );
    if (own_remaining.length > 0)
      report.fail("Chromium profile 回收", `leftover profiles: ${own_remaining.join(", ")}`);

    const exit_code = service.child.exitCode;
    report.pass("服务正常停止", `exitCode=${exit_code}`);
    if (exit_code !== 0) report.fail("服务正常停止", `exitCode=${exit_code}`);

    if (options.keep) process.stdout.write(`[probe] kept artifacts ${artifacts}\n`);
    else rmSync(artifacts, { recursive: true, force: true });
  }

  print_resource_summary(monitor, report);

  process.stdout.write("---- 汇总 ----\n");
  for (const result of report.results)
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}\n`);
  process.stdout.write(
    `通过 ${report.results.length - report.failed_count}/${report.results.length}\n`,
  );
  return report.failed_count === 0 ? 0 : 1;
}

/** 汇总各阶段峰值 RSS 与 CPU，作为观测事实打印（不计入门禁）。 */
function print_resource_summary(monitor, report) {
  if (monitor === null) {
    report.note("峰值资源", "monitor did not start; no samples collected");
    return;
  }
  const samples = monitor.samples;
  const launch_index = samples.findIndex((sample) => sample.count > 0);
  const launch_sample = launch_index === -1 ? null : samples[launch_index];
  const image = monitor.markers.image_done;
  const pdf = monitor.markers.pdf_done;

  const idle = launch_index === -1 ? samples : samples.slice(0, launch_index);
  const image_window =
    launch_sample === null || image === null
      ? []
      : samples.filter((sample) => sample.t_ms >= launch_sample.t_ms && sample.t_ms < image.t_ms);
  const pdf_window =
    image === null || pdf === null
      ? []
      : samples.filter((sample) => sample.t_ms >= image.t_ms && sample.t_ms < pdf.t_ms);
  const residual = samples.filter(
    (sample) =>
      sample.count === 0 &&
      launch_sample !== null &&
      sample.t_ms > (pdf?.t_ms ?? launch_sample.t_ms),
  );

  const idle_peak = peak_rss(idle);
  const image_peak = peak_rss(image_window);
  const pdf_peak = peak_rss(pdf_window);
  const overall_peak = peak_rss(samples);
  const peak_processes = max_count(samples);

  // 浏览器按需启动于首次图片请求，CPU 从 0 累计：图片阶段 CPU = 图片边界绝对 CPU；
  // PDF 阶段 CPU = 两次边界差值。RSS 为进程树 VmRSS 之和（会重复计入共享页）。
  const image_cpu = image === null ? null : image.cpu_sec;
  const pdf_cpu = image === null || pdf === null ? null : pdf.cpu_sec - image.cpu_sec;
  const total_cpu = pdf === null ? image_cpu : pdf.cpu_sec;

  process.stdout.write("---- 峰值资源（进程树合计）----\n");
  report.note(
    "采样",
    `interval=${SAMPLE_INTERVAL_MS}ms samples=${samples.length} peakProcesses=${peak_processes}`,
  );
  report.note("空闲基线", `peakRSS=${idle_peak.toFixed(1)}MB`);
  report.note(
    "图片任务",
    `peakRSS=${image_peak.toFixed(1)}MB peakPSS=${peak_pss(image_window).toFixed(1)}MB cpu=${image_cpu === null ? "n/a" : `${image_cpu.toFixed(3)}s`}`,
  );
  report.note(
    "PDF 任务",
    `peakRSS=${pdf_peak.toFixed(1)}MB peakPSS=${peak_pss(pdf_window).toFixed(1)}MB cpu=${pdf_cpu === null ? "n/a" : `${pdf_cpu.toFixed(3)}s`}`,
  );
  report.note(
    "整轮峰值",
    `peakRSS=${overall_peak.toFixed(1)}MB peakPSS=${peak_pss(samples).toFixed(1)}MB totalCPU=${total_cpu === null ? "n/a" : `${total_cpu.toFixed(3)}s`}`,
  );
  report.note("停止后残留", `peakRSS=${peak_rss(residual).toFixed(1)}MB`);
  report.note(
    "口径",
    "图片任务 CPU 含一次性浏览器启动（宿主按需启动于首次图片请求）；RSS 为进程树 VmRSS 之和，重复计入共享页，PSS 按比例分摊共享页、更接近实际独占驻留",
  );
}

process.exitCode = await main();
