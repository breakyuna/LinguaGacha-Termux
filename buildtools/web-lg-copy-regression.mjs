#!/usr/bin/env node
/**
 * 旧 .lg 小说工程副本回归（TW-10 剩余项）。
 *
 * 前置条件：无需预先构建，脚本自行调用 `buildtools/build-web.mjs` 产出独立部署目录。
 *
 * 覆盖内容：
 *   1. 以自有输出目录执行 Web 构建，核对入口、worker 入口与运行资源落盘；
 *   2. 临时数据根 A + 固定端口启动真实服务，上传合成小说源文件（TXT / Markdown）建工程，
 *      记录文件清单、条目数、翻译统计与逐条原文；
 *   3. 调用工程副本接口生成副本 .lg，核对一致性快照文件头与落点后停止服务；
 *   4. 以全新临时数据根 B 启动服务，经“打开已有 .lg”路由打开该副本；
 *   5. 断言副本的文件清单、条目数、统计与逐条原文和源工程一致；
 *   6. 两个服务退出码均为 0，无残留服务进程与 Chromium 进程 / profile。
 *
 * 全程 REST 驱动，不启动浏览器；工程副本是产品自身在数据库一致性边界生成的快照。
 *
 * 用法：
 *   node buildtools/web-lg-copy-regression.mjs [--keep=true|false]
 *     [--build-dir=<path>] [--port-a=<port>] [--port-b=<port>]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_SCRIPT = path.join(PROJECT_ROOT, "buildtools", "build-web.mjs");

// 源工程实例与副本打开实例各自占用固定端口，避免随机端口在日志中难以对应。
const DEFAULT_PORT_A = 8482;
const DEFAULT_PORT_B = 8483;

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 60_000; // 解析与工程提交在软件渲染的本机上可能较慢

const DEPLOY_ENTRY = "index.mjs";
const WORKER_ENTRIES = [
  "work-unit-worker-entry.mjs",
  "planning-worker-entry.mjs",
  "rpgmaker-mv-mz-prepare-worker-entry.mjs",
  "compute-worker-entry.mjs",
];
const DEPLOY_RESOURCE_PATHS = [
  "dist",
  "builtin",
  "resources/pdf-print.css",
  "version.txt",
  "dist/fonts/LGBaseFont-Regular.woff2",
];

const PROJECT_COPY_DIR_NAME = "project-copies"; // 工程副本落点，与 app-path-service 约定一致

/** 校对列表筛选词表：覆盖全部条目状态与真实 warning 类型，保证窗口取回全部条目。 */
const PROOFREADING_ALL_OUTCOMES = Object.freeze([
  "NONE",
  "PROCESSED",
  "ERROR",
  "EXCLUDED",
  "RULE_SKIPPED",
  "LANGUAGE_SKIPPED",
  "DUPLICATED",
  "NO_WARNING",
  "FOREIGN_CHAR_RESIDUE",
  "SIMILARITY",
  "LINE_COUNT_MISMATCH",
  "GLOSSARY",
  "TEXT_PRESERVE",
  "PUNCTUATION_MISMATCH",
]);
const PROOFREADING_WINDOW_COUNT = 2_000; // 合成工程条目远小于此值，一次窗口取回全部行

/**
 * 合成小说源文件：TXT 一行一条目，Markdown 以 AST 块为条目。
 * 正文使用英文，配合源语言 EN，避免条目在预过滤阶段被语言规则跳过。
 */
const NOVEL_SOURCES = [
  [
    "novel/chapter-one.txt",
    [
      "The lighthouse keeper lit the lamp at dusk.",
      "Waves broke against the rocks below the cliff.",
      "A fisherman counted his nets by the harbour.",
      "The wind carried salt across the sleeping village.",
      "Night fell, and the lamp kept its promise.",
    ].join("\n") + "\n",
  ],
  [
    "novel/chapter-two.txt",
    [
      "Morning brought a letter from the mainland.",
      "The postmaster read the address twice before smiling.",
      "Rain tapped the windows of the small bakery.",
      "Children waited for the school bell to ring.",
      "The baker sold the last loaf at noon.",
    ].join("\n") + "\n",
  ],
  [
    "novel/chapter-three.md",
    [
      "# The Winter Harbour",
      "",
      "Snow covered the boats like a quiet blanket.",
      "",
      "The harbour master wrote the tide times in his notebook.",
      "",
      "Nobody spoke of the storm that took the old pier.",
      "",
    ].join("\n"),
  ],
];

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

/** 字典序比较，供事实排序复用，避免在多个读取点重复书写比较式。 */
function compare_text(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
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

/** 列出产品可能启动的 Chromium 进程；本回归不走浏览器，服务停止后必须归零。 */
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

/** 列出本回归启动的服务进程；停止后不得残留，用于发现未收尾的子进程。 */
function list_service_processes(build_dir) {
  const marker = path.join(build_dir, DEPLOY_ENTRY);
  const result = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(marker));
}

class WebServiceProcess {
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.stdout = "";
    this.stderr = "";
    child.stdout.on("data", (chunk) => {
      this.stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
  }

  /** 从启动输出解析访问地址与一次性凭据。 */
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
      `${this.label} 退出`,
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

  /** 上传原始字节到暂存区，返回暂存材料记录（含绝对路径）。 */
  async upload(name, bytes) {
    return await this.data("POST", `/api/web/files/upload?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  post(route, payload) {
    return this.data("POST", route, {
      body: JSON.stringify(payload ?? {}),
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** 建立访问会话并返回 API 客户端。 */
async function connect(service, label) {
  const access = await wait_for(
    () => service.read_access(),
    SERVICE_START_TIMEOUT_MS,
    `${label} 打印访问地址`,
  );
  const session = await fetch(`${access.baseUrl}/api/web/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: access.credential }),
  });
  const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (session.status !== 204 || cookie === "")
    throw new VerifyFailure(`${label} access session failed: HTTP ${session.status}`);
  process.stdout.write(`[verify] ${label} ${access.baseUrl}\n`);
  return new ApiClient(access.baseUrl, cookie);
}

/** 文件清单事实：相对路径、格式、排序位与每文件条目数。 */
async function read_file_facts(client) {
  const workbench = await client.post("/api/workbench/snapshot", {});
  const entries = workbench?.["snapshot"]?.["entries"] ?? [];
  return entries
    .map((entry) => ({
      rel_path: String(entry?.["rel_path"] ?? ""),
      file_type: String(entry?.["file_type"] ?? ""),
      sort_index: Number(entry?.["sort_index"] ?? -1),
      total_count: Number(entry?.["progress"]?.["total_count"] ?? -1),
    }))
    .sort((left, right) => compare_text(left.rel_path, right.rel_path));
}

/** 工程级计数事实：文件数与条目数。 */
async function read_count_facts(client) {
  const manifest = await client.post("/api/session/project/manifest", {});
  return {
    files: Number(manifest?.["counts"]?.["files"] ?? -1),
    items: Number(manifest?.["counts"]?.["items"] ?? -1),
  };
}

/** 翻译统计事实：条目状态聚合，与数据库条目同源。 */
async function read_stats_facts(client) {
  const response = await client.post("/api/project/translation-stats", {});
  return response?.["stats"] ?? null;
}

/** 逐条原文事实：文件归属、行号、状态与正文，用于内容级一致性比对。 */
async function read_item_facts(client) {
  const view = await client.post("/api/proofreading/query", {
    action: "list",
    query: {
      keyword: "",
      scope: "all",
      is_regex: false,
      filters: {
        outcomes: [...PROOFREADING_ALL_OUTCOMES],
        files: { mode: "default" },
        glossary_entry_ids: [],
        include_without_glossary_miss: true,
      },
      window_start: 0,
      window_count: PROOFREADING_WINDOW_COUNT,
    },
  });
  const rows = view?.["view"]?.["window_rows"] ?? [];
  return rows
    .filter((row) => row?.["kind"] === "item")
    .map((row) => ({
      file_path: String(row?.["item"]?.["file_path"] ?? ""),
      row_number: Number(row?.["item"]?.["row_number"] ?? -1),
      status: String(row?.["item"]?.["status"] ?? ""),
      src: String(row?.["item"]?.["src"] ?? ""),
    }))
    .sort((left, right) => {
      const key_difference = compare_text(
        `${left.file_path}#${left.row_number}`,
        `${right.file_path}#${right.row_number}`,
      );
      return key_difference !== 0 ? key_difference : compare_text(left.src, right.src);
    });
}

/** 汇总一次读取得到的工程事实，供源工程与副本两侧复用同一口径。 */
async function read_project_facts(client) {
  return {
    files: await read_file_facts(client),
    counts: await read_count_facts(client),
    stats: await read_stats_facts(client),
    items: await read_item_facts(client),
  };
}

function truncate(text, limit = 240) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 递归定位两份事实的第一处差异路径；完全一致时返回 null。 */
function find_difference_path(source_value, copy_value, current_path) {
  if (JSON.stringify(source_value) === JSON.stringify(copy_value)) return null;
  const both_objects =
    typeof source_value === "object" &&
    source_value !== null &&
    typeof copy_value === "object" &&
    copy_value !== null;
  if (!both_objects || Array.isArray(source_value) !== Array.isArray(copy_value))
    return current_path === "" ? "$" : current_path;
  if (Array.isArray(source_value)) {
    for (let index = 0; index < Math.max(source_value.length, copy_value.length); index += 1) {
      const found = find_difference_path(
        source_value[index],
        copy_value[index],
        `${current_path}[${index}]`,
      );
      if (found !== null) return found;
    }
    return null;
  }
  for (const key of new Set([...Object.keys(source_value), ...Object.keys(copy_value)])) {
    const found = find_difference_path(
      source_value[key],
      copy_value[key],
      `${current_path}.${key}`,
    );
    if (found !== null) return found;
  }
  return null;
}

/** 差异明细：定位到第一处不同并给出两侧摘要，便于失败时直接判断根因。 */
function describe_difference(name, source_value, copy_value) {
  const difference_path = find_difference_path(source_value, copy_value, "");
  if (difference_path === null) return "";
  return `${name} 在 ${difference_path} 不同：source=${truncate(String(JSON.stringify(source_value)))} copy=${truncate(String(JSON.stringify(copy_value)))}`;
}

function run_build(build_dir) {
  const result = spawnSync(process.execPath, [BUILD_SCRIPT, build_dir], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
  if (result.error !== undefined)
    throw new VerifyFailure(`Web build failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new VerifyFailure(`Web build exited with code ${result.status}`);
}

function parse_arguments(argv) {
  const options = {
    keep: false,
    build_dir: null,
    port_a: DEFAULT_PORT_A,
    port_b: DEFAULT_PORT_B,
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
    switch (name) {
      case "keep":
        options.keep = value === "true";
        break;
      case "build-dir":
        options.build_dir = path.resolve(value);
        break;
      case "port-a":
        options.port_a = Number(value);
        break;
      case "port-b":
        options.port_b = Number(value);
        break;
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  for (const [name, port] of [
    ["port-a", options.port_a],
    ["port-b", options.port_b],
  ]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`Invalid ${name}: ${port}`);
  }
  if (options.port_a === options.port_b)
    throw new Error(`port-a and port-b must differ: ${options.port_a}`);
  return options;
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-lg-copy-regression-"));
  const build_dir = options.build_dir ?? path.join(artifacts, "build", "web");
  const data_root_a = path.join(artifacts, "data-root-a");
  const data_root_b = path.join(artifacts, "data-root-b");
  const project_path = path.join(artifacts, "projects", "regression-novel.lg");
  mkdirSync(data_root_a, { recursive: true });
  mkdirSync(data_root_b, { recursive: true });
  mkdirSync(path.dirname(project_path), { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);
  process.stdout.write(`[verify] 构建目录 ${build_dir}\n`);
  process.stdout.write(`[verify] 数据根 A ${data_root_a}\n`);
  process.stdout.write(`[verify] 数据根 B ${data_root_b}\n`);

  const spawn_service = (label, port, data_root) =>
    new WebServiceProcess(
      spawn(
        process.execPath,
        [path.join(build_dir, DEPLOY_ENTRY), `--port=${port}`, `--data-root=${data_root}`],
        { cwd: build_dir, stdio: ["ignore", "pipe", "pipe"] },
      ),
      label,
    );

  let service_a = null;
  let service_b = null;
  let copy_path = "";
  try {
    // 1) 自有目录构建：部署产物完整才继续启动真实服务。
    run_build(build_dir);
    report.pass("自有构建产物", build_dir);
    const missing = [DEPLOY_ENTRY, ...WORKER_ENTRIES, ...DEPLOY_RESOURCE_PATHS].filter(
      (relative) => !existsSync(path.join(build_dir, relative)),
    );
    report.pass(
      "部署产物完整",
      missing.length === 0 ? "入口与运行资源齐全" : `缺失 ${missing.join(", ")}`,
    );
    if (missing.length > 0)
      throw new VerifyFailure(`missing deploy artifacts: ${missing.join(", ")}`);

    // 2) 数据根 A 启动服务并建合成小说工程。
    service_a = spawn_service("源工程实例", options.port_a, data_root_a);
    const client_a = await connect(service_a, "数据根 A");
    report.pass("数据根 A 启动与访问会话", `port=${options.port_a}`);

    // 源语言设为 EN：默认 JA 会把英文条目标为 LANGUAGE_SKIPPED，与回归目标无关。
    const settings = await client_a.post("/api/settings/update", {
      source_language: "EN",
      target_language: "ZH",
    });
    report.pass(
      "语言设置",
      `source=${settings?.["settings"]?.["source_language"]} target=${settings?.["settings"]?.["target_language"]}`,
    );

    const staged = [];
    for (const [name, text] of NOVEL_SOURCES) {
      const material = await client_a.upload(name, Buffer.from(text, "utf8"));
      const material_path = String(material?.["path"] ?? "");
      const material_id = String(material?.["material_id"] ?? "");
      if (material_path === "" || material_id === "")
        throw new VerifyFailure(
          `staged material record incomplete for ${name}: ${JSON.stringify(material).slice(0, 200)}`,
        );
      staged.push({ name, path: material_path, material_id });
    }
    report.pass("小说格式上传", `${staged.length} 个文件已暂存`);

    // 摘要按暂存材料的绝对路径识别格式，与工程创建共用同一份路径。
    const summary = await client_a.post("/api/session/source-files/summary", {
      source_paths: staged.map((entry) => entry.path),
    });
    const hits = summary?.["format_hit_counts"] ?? {};
    const expected_hits = { txt: 2, md: 1 };
    const hit_mismatches = Object.entries(expected_hits).filter(
      ([id, count]) => hits[id] !== count,
    );
    report.pass(
      "源文件摘要",
      hit_mismatches.length === 0
        ? `txt=${hits["txt"]} md=${hits["md"]}`
        : `格式命中不一致：${JSON.stringify(hits)}`,
    );
    if (hit_mismatches.length > 0)
      report.fail(
        "源文件摘要",
        `expected ${JSON.stringify(expected_hits)}, got ${JSON.stringify(hits)}`,
      );
    if (Number(summary?.["source_file_count"] ?? -1) !== NOVEL_SOURCES.length)
      report.fail(
        "源文件摘要",
        `source_file_count=${summary?.["source_file_count"]}, expected ${NOVEL_SOURCES.length}`,
      );

    const created = await client_a.post("/api/session/project/create", {
      path: project_path,
      material_ids: staged.map((entry) => entry.material_id),
    });
    const failed_files = created?.["failed_files"] ?? [];
    report.pass(
      "源工程创建",
      failed_files.length === 0 ? project_path : `失败 ${failed_files.length} 个`,
    );
    if (failed_files.length > 0)
      report.fail("源工程创建", `failed files: ${JSON.stringify(failed_files).slice(0, 300)}`);
    const source_snapshot = await client_a.post("/api/session/project/snapshot", {});
    if (source_snapshot?.["project"]?.["loaded"] !== true)
      report.fail("源工程创建", `snapshot=${JSON.stringify(source_snapshot)}`);

    const source_facts = await read_project_facts(client_a);
    const source_item_total = source_facts.items.length;
    report.pass(
      "源工程事实",
      `文件 ${source_facts.files.length} 个、条目 ${source_item_total} 条、total_items=${source_facts.stats?.["total_items"]}`,
    );
    if (source_facts.files.length !== NOVEL_SOURCES.length)
      report.fail(
        "源工程事实",
        `file entries ${source_facts.files.length}, expected ${NOVEL_SOURCES.length}`,
      );
    if (source_item_total <= 0) report.fail("源工程事实", `no items parsed: ${source_item_total}`);
    if (Number(source_facts.stats?.["total_items"] ?? 0) !== source_item_total)
      report.fail(
        "源工程事实",
        `stats.total_items=${source_facts.stats?.["total_items"]} but ${source_item_total} rows read`,
      );

    // 3) 工程副本：产品在数据库一致性边界生成的快照。
    const copy_response = await client_a.call("POST", "/api/session/project/copy", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    copy_path = copy_response.payload?.["data"]?.["path"] ?? copy_response.payload?.["path"] ?? "";
    if (copy_response.status < 200 || copy_response.status >= 300 || copy_path === "")
      throw new VerifyFailure(
        `project copy failed: HTTP ${copy_response.status} ${JSON.stringify(copy_response.payload).slice(0, 300)}`,
      );
    const copy_header = readFileSync(copy_path).subarray(0, 15).toString("latin1");
    const copy_size = statSync(copy_path).size;
    const expected_copy_dir = path.join(data_root_a, "userdata", PROJECT_COPY_DIR_NAME);
    const copy_in_data_root_a = path.dirname(copy_path) === expected_copy_dir;
    report.pass(
      "工程副本生成",
      `${path.basename(copy_path)} ${copy_size} 字节，落点 ${copy_in_data_root_a ? "在数据根 A" : "异常"}`,
    );
    if (copy_header !== "SQLite format 3")
      report.fail("工程副本生成", `unexpected file header: ${copy_header}`);
    if (copy_size <= 0) report.fail("工程副本生成", `copy size is ${copy_size}`);
    if (!copy_in_data_root_a)
      report.fail(
        "工程副本生成",
        `copy dir ${path.dirname(copy_path)}, expected ${expected_copy_dir}`,
      );
    if (!copy_path.endsWith(".lg"))
      report.fail("工程副本生成", `copy path does not end with .lg: ${copy_path}`);

    await service_a.stop();
    report.pass("源工程实例停止", `exitCode=${service_a.child.exitCode}`);
    if (service_a.child.exitCode !== 0)
      report.fail("源工程实例停止", `exitCode=${service_a.child.exitCode}`);

    // 4) 全新数据根 B 启动服务，打开该副本。
    if (existsSync(path.join(data_root_b, "userdata")))
      report.fail("数据根 B 全新性", "B 已存在 userdata，不能证明是全新数据根");
    else report.pass("数据根 B 全新性", "尚未产生任何产品状态");
    if (copy_path.startsWith(`${data_root_b}${path.sep}`))
      report.fail("数据根 B 全新性", `副本位于数据根 B 内：${copy_path}`);
    if (!existsSync(copy_path))
      throw new VerifyFailure(`copy file disappeared before open: ${copy_path}`);

    service_b = spawn_service("副本打开实例", options.port_b, data_root_b);
    const client_b = await connect(service_b, "数据根 B");
    report.pass("数据根 B 启动与访问会话", `port=${options.port_b}`);

    const opened = await client_b.post("/api/session/project/open", { path: copy_path });
    const opened_snapshot = await client_b.post("/api/session/project/snapshot", {});
    report.pass(
      "副本打开",
      `loaded=${opened_snapshot?.["project"]?.["loaded"]} path=${opened_snapshot?.["project"]?.["path"]}`,
    );
    if (opened_snapshot?.["project"]?.["loaded"] !== true)
      report.fail("副本打开", `snapshot=${JSON.stringify(opened_snapshot)}`);
    if (opened_snapshot?.["project"]?.["path"] !== copy_path)
      report.fail(
        "副本打开",
        `opened path is not the copy: ${opened_snapshot?.["project"]?.["path"]}`,
      );
    if (opened !== undefined && opened !== null && typeof opened === "object")
      process.stdout.write(`[verify] open 响应 ${JSON.stringify(opened).slice(0, 300)}\n`);

    // 5) 副本与源工程的事实一致性。
    const copy_facts = await read_project_facts(client_b);
    const file_difference = describe_difference("文件清单", source_facts.files, copy_facts.files);
    report.pass(
      "副本文件清单一致",
      file_difference === ""
        ? `${copy_facts.files.length} 个文件：${copy_facts.files.map((entry) => entry.rel_path).join(", ")}`
        : file_difference,
    );
    if (file_difference !== "") report.fail("副本文件清单一致", file_difference);

    const count_difference = describe_difference("条目数", source_facts.counts, copy_facts.counts);
    report.pass(
      "副本条目数一致",
      count_difference === ""
        ? `files=${copy_facts.counts.files} items=${copy_facts.counts.items}`
        : count_difference,
    );
    if (count_difference !== "") report.fail("副本条目数一致", count_difference);

    const stats_difference = describe_difference("翻译统计", source_facts.stats, copy_facts.stats);
    report.pass(
      "副本统计一致",
      stats_difference === "" ? JSON.stringify(copy_facts.stats) : stats_difference,
    );
    if (stats_difference !== "") report.fail("副本统计一致", stats_difference);

    const item_difference = describe_difference("条目原文", source_facts.items, copy_facts.items);
    report.pass(
      "副本条目原文一致",
      item_difference === "" ? `${copy_facts.items.length} 条原文逐条相同` : item_difference,
    );
    if (item_difference !== "") report.fail("副本条目原文一致", item_difference);
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service_a !== null && service_a.stderr !== "")
      process.stdout.write(`[service-a:err] ${service_a.stderr}\n`);
    if (service_b !== null && service_b.stderr !== "")
      process.stdout.write(`[service-b:err] ${service_b.stderr}\n`);
  } finally {
    for (const service of [service_a, service_b]) {
      if (service === null) continue;
      await service.stop();
      if (service.stderr !== "") {
        process.stdout.write(`[${service.label}:err tail]\n${service.stderr.slice(-4_000)}\n`);
      }
    }

    const processes = list_chromium_processes();
    const profiles = list_chromium_profiles();
    const leftovers = list_service_processes(build_dir);
    report.pass(
      "无残留进程与 profile",
      `chromium process=${processes.length} profile=${profiles.length} service=${leftovers.length}`,
    );
    if (profiles.length > 0)
      report.fail("无残留进程与 profile", `profiles: ${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("无残留进程与 profile", `chromium process: ${processes[0].slice(0, 160)}`);
    if (leftovers.length > 0)
      report.fail("无残留进程与 profile", `service process: ${leftovers[0].slice(0, 160)}`);

    for (const [service, label] of [
      [service_a, "源工程实例"],
      [service_b, "副本打开实例"],
    ]) {
      if (service === null) continue;
      const exit_code = service.child.exitCode;
      report.pass(`${label} 退出码`, `exitCode=${exit_code}`);
      if (exit_code !== 0) report.fail(`${label} 退出码`, `exitCode=${exit_code}`);
    }

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
