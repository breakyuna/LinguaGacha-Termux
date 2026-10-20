#!/usr/bin/env node
/**
 * 解除冻结格式的翻译闭环验证（2026-10-19 范围调整，TW-05 / TW-10）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`；mock 模型脚本随仓库提供。
 *
 * 覆盖内容：
 *   1. 字幕闭环：SRT / VTT / ASS / SSA / LRC 经上传 → 建工程 → 真实翻译批次 →
 *      生成译文 → 受控下载，解析下载内容核对 cue 数、时间码与译文落位；
 *   2. MV/MZ 游戏闭环：合成游戏目录上传（收拢为单容器）→ 建工程 → 翻译 →
 *      按容器结构导出 → 下载解析 JSON 断言译文写入游戏数据结构；
 *      再把导出容器回灌为新工程，验证导出结果可被产品自身重新解析；
 *   3. 其余文件型冻结格式：RenPy / KVJSON / MESSAGEJSON / TRANS / WOLF TRANS /
 *      XLSX / WOLFXLSX 同链路，下载输出并核对译文内容。
 *
 * 导入契约与浏览器文件夹上传一致：每批文件暂存到独立批次目录，
 * `source_paths` 传批次目录绝对路径走目录导入，工程资产路径带批次目录前缀，
 * 译文按同一相对结构落盘，下载路径由 output_path 拼接上传相对名得到。
 *
 * 不在本脚本范围：RGSS 归档（Marshal 夹具复杂度，管道级覆盖见 V-013 与单元测试）；
 * 目标平台游戏启动（Termux 无 Windows / nwjs，以“导出容器可回灌”替代验收）。
 *
 * 用法：
 *   node buildtools/web-frozen-formats-loop-verify.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");
const MOCK_MODEL_SCRIPT = path.join(PROJECT_ROOT, "buildtools", "web-long-task-mock-model.mjs");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 60_000;
const TRANSLATION_TIMEOUT_MS = 10 * 60_000;
const ACTIVE_TRANSLATION_STATUSES = new Set(["requested", "running", "stopping"]);
const MOCK_TRANSLATION_PREFIX = "【译】"; // 与 web-long-task-mock-model.mjs 的译文前缀一致

class VerifyFailure extends Error {}

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
    if (name === "keep") options.keep = value === "true";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
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

/** 翻译 mock 模型：OpenAI Chat Completions 兼容，按 jsonline 输入回送同 id 译文。 */
class MockModelProcess {
  constructor(child) {
    this.child = child;
    this.stdout = "";
    child.stdout.on("data", (chunk) => {
      this.stdout += String(chunk);
    });
  }

  read_base_url() {
    const match = this.stdout.match(/LONG_TASK_MOCK_LISTENING\s+(\d+)/u);
    if (match === null) return null;
    return `http://127.0.0.1:${match[1]}/v1`;
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await wait_for(
      () => this.child.exitCode !== null,
      SERVICE_STOP_TIMEOUT_MS,
      "mock 模型退出",
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

  /** 上传原始字节到暂存区；name 可携带相对目录（批次目录结构）。 */
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
      throw new VerifyFailure(`upload ${name} -> ${response.status} ${text.slice(0, 200)}`);
    const envelope = payload;
    if (envelope !== null && typeof envelope === "object" && "data" in envelope)
      return envelope["data"];
    return envelope;
  }

  /** 受控下载返回原始字节。 */
  async download(file_path) {
    const response = await fetch(
      `${this.baseUrl}/api/translation/files/download?path=${encodeURIComponent(file_path)}`,
      { headers: { cookie: this.cookie }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
    if (!response.ok)
      throw new VerifyFailure(
        `download ${file_path} -> ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    return Buffer.from(await response.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------
// 合成夹具（与 web-import-format-matrix.test.ts 同源，脚本自包含复现）
// ---------------------------------------------------------------------------

const SRT_FIXTURE = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "第一句台词",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,250",
  "第二句台词",
  "第二句的第二行",
  "",
].join("\n");

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

const ASS_FIXTURE = [
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,第一句",
  "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,第二句",
].join("\n");

const SSA_FIXTURE = [
  "[Events]",
  "Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,唯一一句",
].join("\n");

const LRC_FIXTURE = ["[ti:标题]", "[00:01.00]第一句", "[00:12.50]第二句"].join("\n");

const KV_JSON_FIXTURE = JSON.stringify({ 已翻: "已处理", 待翻: "待翻" });

// 正文使用中文：源语言为 ZH，拉丁正文会被语言预过滤跳过（与其余夹具同口径）。
const MESSAGE_JSON_FIXTURE = JSON.stringify([
  { name: "Alice", message: "消息一" },
  { names: ["Bob", 123, "Carol"], message: "消息二" },
  { message: "消息三" },
]);

const TRANS_FIXTURE = JSON.stringify({
  project: {
    indexOriginal: 1,
    indexTranslation: 2,
    gameEngine: "kag",
    files: {
      "file.json": {
        data: [["id-1", "原文", ""]],
        tags: [["keep"]],
        context: [["ctx"]],
        parameters: [[{ note: "meta" }]],
      },
    },
  },
});

const WOLF_TRANS_FIXTURE = JSON.stringify({
  project: {
    gameEngine: "wolf",
    indexOriginal: 0,
    indexTranslation: 1,
    files: {
      "Data/Map001.json": {
        data: [
          ["对话正文", ""],
          ["内部标识", ""],
        ],
        context: [["common/1.json/Message/stringArgs/0"], ["common/1.json/Database/stringArgs/1"]],
      },
    },
  },
});

// 对白正文使用中文：源语言为 ZH，拉丁正文会被语言预过滤跳过。
const RENPY_FIXTURE = [
  "translate schinese strings:",
  '    old "START"',
  '    new "开始"',
  '    old "新文本"',
  '    new ""', // 空译文槽：本条目进入翻译批次，写回替换 new 行的 STRING 槽
  "translate schinese start:",
  '    # "Alice" "对白"',
  '    "艾丽丝" "你好"',
].join("\n");

const MV_MZ_SYSTEM_FIXTURE = JSON.stringify({ gameTitle: "原稿" });

const MV_MZ_MAP_FIXTURE = JSON.stringify({
  displayName: "地图",
  events: [
    null,
    {
      pages: [
        {
          list: [
            { code: 101, parameters: ["", 0, 0, 2, "勇者"], indent: 0 },
            { code: 401, parameters: ["对白文字"], indent: 0 },
            { code: 0, parameters: [], indent: 0 },
          ],
        },
      ],
    },
  ],
});

/**
 * MV/MZ 合成游戏目录：上传相对名的首段即游戏根目录名，
 * 暂存时置于批次目录之下，目录导入据此发现游戏容器。
 * 容器只收拢数据与插件文件，引擎标志文件仅参与游戏识别、不进入导出。
 */
const MV_MZ_GAME_FIXTURE = [
  ["game/www/data/System.json", Buffer.from(MV_MZ_SYSTEM_FIXTURE, "utf8")],
  ["game/www/data/Map001.json", Buffer.from(MV_MZ_MAP_FIXTURE, "utf8")],
  ["game/www/js/rmmz_core.js", Buffer.from("// engine marker", "utf8")],
];

/** 用真实 exceljs 生成术语表与 WOLF 索引色工作簿（与测试夹具同规格）。 */
async function create_spreadsheet_fixture(cells) {
  // ESM 动态 import 返回模块命名空间，默认导出位于 .default。
  const exceljs_module = await import("exceljs");
  const ExcelJS = exceljs_module.default ?? exceljs_module;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet");
  for (const [address, value] of Object.entries(cells)) {
    const cell = sheet.getCell(address);
    if (typeof value !== "object") {
      cell.value = value;
      continue;
    }
    cell.value =
      value.formula !== undefined
        ? {
            formula: value.formula,
            ...(value.result === undefined ? {} : { result: value.result }),
          }
        : value.rich
          ? { richText: value.rich.map((text) => ({ text })) }
          : (value.text ?? "");
    if (value.fill !== undefined) {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { indexed: value.fill },
      };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// 字幕解析（最小验证用：cue 数、时间码、正文）
// ---------------------------------------------------------------------------

function split_blocks(text) {
  return text
    .replace(/\r\n/gu, "\n")
    .split(/\n\n+/u)
    .map((block) => block.split("\n").filter((line) => line.trim() !== ""))
    .filter((lines) => lines.length > 0);
}

function parse_srt(text) {
  const cues = [];
  for (const lines of split_blocks(text)) {
    const time_index = lines.findIndex((line) => line.includes("-->"));
    if (time_index === -1) continue;
    cues.push({ time: lines[time_index].trim(), text: lines.slice(time_index + 1).join("\n") });
  }
  return cues;
}

function parse_vtt(text) {
  return parse_srt(text); // 验证口径相同：块内时间行 + 正文
}

function parse_ass(text) {
  const cues = [];
  for (const raw_line of text.split(/\r?\n/u)) {
    const line = raw_line.trim();
    if (!line.startsWith("Dialogue:")) continue;
    // Text 位于末列；ASS 标准 10 列与 SSA 的 Marked=0 前缀在相同索引落地。
    const parts = line.slice("Dialogue:".length).split(",");
    cues.push({ time: `${parts[1]?.trim()},${parts[2]?.trim()}`, text: parts.slice(9).join(",") });
  }
  return cues;
}

function parse_lrc(text) {
  const lines = [];
  for (const raw_line of text.split(/\r?\n/u)) {
    const line = raw_line.trim();
    const match = /^\[(\d+:\d+(?:\.\d+)?)\](.*)$/u.exec(line);
    if (match === null) continue;
    lines.push({ time: match[1], text: match[2] });
  }
  return lines;
}

/** 译文判定：必须等于 mock 前缀 + 源文，证明“该条目被翻译后落盘”。 */
function assert_translated(actual, source, label, report, check_name) {
  const expected = `${MOCK_TRANSLATION_PREFIX}${source}`;
  if (actual === expected) {
    report.pass(check_name, `${label}：${actual}`);
    return;
  }
  report.fail(check_name, `${label} 期望 ${expected}，实际 ${actual}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 批次目录名只含时间戳与随机后缀，与 Web 文件选择器的文件夹上传命名一致。 */
function create_upload_batch_name() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `batch-${timestamp}-${random}`;
}

/**
 * 反推批次目录绝对路径：按上传相对名的段数从暂存路径逐级回退，
 * 与 web-file-picker-dialog.tsx 的 resolve_batch_directory_path 同规则
 * ——回退段数不含批次目录名自身，重名暂存只改末段，回退结果仍然精确。
 */
function resolve_batch_directory_path(staged_path, relative_name) {
  let directory = staged_path;
  for (let level = 0; level < relative_name.split("/").length; level += 1) {
    directory = path.dirname(directory);
  }
  return directory;
}

/**
 * 上传一批文件并建成工程，返回工程路径、摘要与工作台条目数。
 * 文件夹上传契约：每批暂存到独立批次目录，source_paths 传批次目录走目录导入，
 * 游戏容器等需要目录结构的来源才能被发现（同 web-file-picker-dialog.tsx）。
 */
async function setup_project(client, artifacts, label, files) {
  const batch_name = create_upload_batch_name();
  const staged = [];
  for (const [name, bytes] of files) {
    const upload_name = `${batch_name}/${name}`;
    const material = await client.upload(upload_name, bytes);
    staged.push({
      name: upload_name, // 含批次目录前缀，译文落盘与下载路径沿用该相对名
      relative: name, // 上传时的相对名，用于反推批次目录
      path: String(material?.["path"] ?? ""),
      id: String(material?.["material_id"] ?? ""),
    });
  }
  const incomplete = staged.filter((entry) => entry.path === "" || entry.id === "");
  if (incomplete.length > 0)
    throw new VerifyFailure(
      `${label} staged records incomplete: ${incomplete.map((entry) => entry.name).join(", ")}`,
    );

  const batch_directory = resolve_batch_directory_path(staged[0].path, staged[0].relative);
  const inconsistent = staged.filter(
    (entry) => resolve_batch_directory_path(entry.path, entry.relative) !== batch_directory,
  );
  if (inconsistent.length > 0)
    throw new VerifyFailure(
      `${label} staged files escape batch directory ${batch_directory}: ${inconsistent
        .map((entry) => entry.name)
        .join(", ")}`,
    );

  const summary = await client.data("POST", "/api/session/source-files/summary", {
    source_paths: [batch_directory],
  });

  const project_path = path.join(artifacts, "projects", `${label}.lg`);
  mkdirSync(path.dirname(project_path), { recursive: true });
  const created = await client.data("POST", "/api/session/project/create", {
    path: project_path,
    source_paths: [batch_directory],
    material_ids: staged.map((entry) => entry.id),
  });
  const failed_files = created?.["failed_files"] ?? [];
  if (failed_files.length > 0)
    throw new VerifyFailure(
      `${label} project create failed files: ${JSON.stringify(failed_files).slice(0, 300)}`,
    );

  const workbench = await client.data("POST", "/api/workbench/snapshot", {});
  const entries = workbench?.["snapshot"]?.["entries"] ?? [];
  const item_total = entries.reduce(
    (sum, entry) => sum + Number(entry?.["progress"]?.["total_count"] ?? 0),
    0,
  );
  return {
    project_path,
    summary,
    file_entries: entries,
    item_total,
    file_names: staged.map((entry) => entry.name),
  };
}

/** 跑一次真实翻译批次并等待终态。 */
async function run_translation(client, label) {
  const start = await client.data("POST", "/api/batch-translation/start", {
    operation: "translate",
    mode: "new",
    scope: { kind: "all" },
    include_errors: false,
    command_id: `frozen-${label}-${Date.now().toString(36)}`,
  });
  if (start?.["accepted"] !== true)
    throw new VerifyFailure(
      `${label} translation not accepted: ${JSON.stringify(start).slice(0, 200)}`,
    );

  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await client.data("POST", "/api/batch-translation/snapshot", {});
    const current = snapshot?.["batch_translation"] ?? snapshot;
    const status = String(current?.["status"] ?? "");
    if (!ACTIVE_TRANSLATION_STATUSES.has(status)) break;
    await sleep(2_000);
  }
  const final = snapshot?.["batch_translation"] ?? snapshot;
  const status = String(final?.["status"] ?? "");
  const progress = final?.["progress"] ?? {};
  return {
    status,
    processed_line: Number(progress["processed_line"] ?? 0),
    total_line: Number(progress["total_line"] ?? 0),
    error_line: Number(progress["error_line"] ?? 0),
  };
}

/**
 * 生成译文文件并下载全部条目。
 * 返回 output_path（译文目录）与 entries（绝对路径 + 字节）：
 * 目录导入的资产路径等于上传相对名，译文按同一相对结构落盘，
 * 因此下载路径按 output_path 拼接上传相对名构造，仍经受控下载边界校验。
 */
async function generate_and_download(client, label) {
  const generated = await client.data("POST", "/api/translation/files/generate", {});
  const output_path = String(generated?.["output_path"] ?? "");
  if (output_path === "") throw new VerifyFailure(`${label} generation output path is empty`);
  // 生成响应按输出目录实际落盘内容列举（含嵌套结构），逐条受控下载。
  const entries = [];
  for (const file of generated?.["files"] ?? []) {
    entries.push({
      name: String(file["name"]),
      path: String(file["path"]),
      bytes: await client.download(String(file["path"])),
    });
  }
  if (entries.length === 0) throw new VerifyFailure(`${label} generation response listed no files`);
  return { output_path, entries };
}

/** 取译文目录内的文件（排除双语目录的同名文件）。 */
function pick_translated(generated, suffix) {
  const prefix = `${generated.output_path}${path.sep}`;
  return (
    generated.entries.find(
      (entry) => entry.path.startsWith(prefix) && entry.name.endsWith(suffix),
    ) ?? null
  );
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-frozen-formats-"));
  const data_root = path.join(artifacts, "data-root");
  const mock_log = path.join(artifacts, "mock-requests.jsonl");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  const mock_model = new MockModelProcess(
    spawn(
      process.execPath,
      [
        MOCK_MODEL_SCRIPT,
        `--port=0`,
        `--log=${mock_log}`,
        "--min-delay-ms=50",
        "--max-delay-ms=150",
      ],
      { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const service = new WebServiceProcess(
    spawn(process.execPath, [WEB_SERVER_ENTRY, "--port=0", `--data-root=${data_root}`], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  let client = null;
  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    const mock_base_url = await wait_for(
      () => mock_model.read_base_url(),
      SERVICE_START_TIMEOUT_MS,
      "mock 模型监听",
    );
    process.stdout.write(`[verify] Web 服务 ${access.baseUrl}；mock 模型 ${mock_base_url}\n`);

    const session = await fetch(`${access.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: access.credential }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const set_cookie = session.headers.get("set-cookie") ?? "";
    const cookie = set_cookie.split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
    client = new ApiClient(access.baseUrl, cookie);
    report.pass("访问会话", `HTTP ${session.status}`);

    // 语言与模型：合成夹具为中文正文，源语言设 ZH；翻译用途指向 mock 模型。
    await client.data("POST", "/api/settings/update", {
      source_language: "ZH",
      target_language: "EN",
    });
    const added = await client.data("POST", "/api/models/add", { model_type: "CUSTOM_OPENAI" });
    const custom_model = (added?.["snapshot"]?.["models"] ?? []).find(
      (model) => model?.["type"] === "CUSTOM_OPENAI",
    );
    if (custom_model === undefined) throw new VerifyFailure("CUSTOM_OPENAI model missing");
    const model_id = String(custom_model["id"]);
    await client.data("POST", "/api/models/update", {
      model_id,
      patch: {
        api_url: mock_base_url,
        api_key: "no-key-required",
        model_id: "long-task-mock-model",
      },
    });
    await client.data("POST", "/api/models/select", { target: "translation", model_id });
    report.pass("翻译模型配置", `mock @ ${mock_base_url}`);

    // ======================= 场景一：字幕闭环 =======================
    const subtitle_project = await setup_project(client, artifacts, "subtitles", [
      ["subs/ep01.srt", Buffer.from(SRT_FIXTURE, "utf8")],
      ["subs/ep02.vtt", Buffer.from(VTT_FIXTURE, "utf8")],
      ["subs/ep03.ass", Buffer.from(ASS_FIXTURE, "utf8")],
      ["subs/ep04.ssa", Buffer.from(SSA_FIXTURE, "utf8")],
      ["subs/ep05.lrc", Buffer.from(LRC_FIXTURE, "utf8")],
    ]);
    const subtitle_hits = subtitle_project.summary?.["format_hit_counts"] ?? {};
    report.pass(
      "字幕格式命中",
      `srt=${subtitle_hits["srt"]} vtt=${subtitle_hits["vtt"]} ass=${subtitle_hits["ass"]} ssa=${subtitle_hits["ssa"]} lrc=${subtitle_hits["lrc"]}`,
    );
    for (const [id, expected] of [
      ["srt", 1],
      ["vtt", 1],
      ["ass", 1],
      ["ssa", 1],
      ["lrc", 1],
    ])
      if (subtitle_hits[id] !== expected)
        report.fail("字幕格式命中", `${id}=${subtitle_hits[id]} 期望 ${expected}`);
    report.pass("字幕条目落库", `条目 ${subtitle_project.item_total}`);
    if (subtitle_project.item_total < 9)
      report.fail("字幕条目落库", `条目数 ${subtitle_project.item_total} 少于预期`);

    const subtitle_run = await run_translation(client, "subtitles");
    report.pass(
      "字幕翻译终态",
      `status=${subtitle_run.status} processed=${subtitle_run.processed_line}/${subtitle_run.total_line} error=${subtitle_run.error_line}`,
    );
    if (subtitle_run.status !== "done")
      report.fail("字幕翻译终态", `期望 done，实际 ${subtitle_run.status}`);
    if (subtitle_run.error_line !== 0)
      report.fail("字幕翻译终态", `失败行 ${subtitle_run.error_line}`);

    const subtitle_files = await generate_and_download(client, "subtitles");
    report.pass("字幕译文下载", subtitle_files.entries.map((entry) => entry.name).join(", "));

    const srt_entry = pick_translated(subtitle_files, "ep01.srt");
    if (srt_entry === null) report.fail("SRT 结构", "译文目录缺少 ep01.srt");
    else {
      const srt_cues = parse_srt(srt_entry.bytes.toString("utf8"));
      report.pass("SRT 结构", `cue ${srt_cues.length}`);
      if (srt_cues.length !== 2) report.fail("SRT 结构", `cue 数 ${srt_cues.length} 期望 2`);
      else {
        if (srt_cues[0].time !== "00:00:01,000 --> 00:00:03,500")
          report.fail("SRT 时间码", `第一条时间码被改写：${srt_cues[0].time}`);
        else report.pass("SRT 时间码", srt_cues[0].time);
        assert_translated(srt_cues[0].text, "第一句台词", "SRT 第一条", report, "SRT 译文");
        assert_translated(
          srt_cues[1].text,
          "第二句台词\n第二句的第二行",
          "SRT 第二条",
          report,
          "SRT 译文",
        );
      }
    }

    const vtt_entry = pick_translated(subtitle_files, "ep02.vtt");
    if (vtt_entry === null) report.fail("VTT 结构", "译文目录缺少 ep02.vtt");
    else {
      const vtt_cues = parse_vtt(vtt_entry.bytes.toString("utf8"));
      const vtt_text = vtt_entry.bytes.toString("utf8");
      report.pass("VTT 结构", `cue ${vtt_cues.length}`);
      if (vtt_cues.length !== 2) report.fail("VTT 结构", `cue 数 ${vtt_cues.length} 期望 2`);
      else {
        assert_translated(vtt_cues[0].text, "第一句", "VTT 第一条", report, "VTT 译文");
        assert_translated(vtt_cues[1].text, "第二句", "VTT 第二条", report, "VTT 译文");
      }
      if (!vtt_text.startsWith("WEBVTT")) report.fail("VTT 文件头", "下载内容缺少 WEBVTT 头");
      else report.pass("VTT 文件头", "WEBVTT 头保留");
    }

    const ass_entry = pick_translated(subtitle_files, "ep03.ass");
    if (ass_entry === null) report.fail("ASS 结构", "译文目录缺少 ep03.ass");
    else {
      const ass_cues = parse_ass(ass_entry.bytes.toString("utf8"));
      const ass_text = ass_entry.bytes.toString("utf8");
      report.pass("ASS 结构", `cue ${ass_cues.length}`);
      if (ass_cues.length !== 2) report.fail("ASS 结构", `cue 数 ${ass_cues.length} 期望 2`);
      else {
        assert_translated(ass_cues[0].text, "第一句", "ASS 第一条", report, "ASS 译文");
        assert_translated(ass_cues[1].text, "第二句", "ASS 第二条", report, "ASS 译文");
      }
      if (!ass_text.includes("Format: Layer, Start, End"))
        report.fail("ASS 格式行", "下载内容缺少 Format 行");
      else report.pass("ASS 格式行", "Format 行保留");
    }

    const ssa_entry = pick_translated(subtitle_files, "ep04.ssa");
    if (ssa_entry === null) report.fail("SSA 结构", "译文目录缺少 ep04.ssa");
    else {
      const ssa_cues = parse_ass(ssa_entry.bytes.toString("utf8"));
      report.pass("SSA 结构", `cue ${ssa_cues.length}`);
      if (ssa_cues.length !== 1) report.fail("SSA 结构", `cue 数 ${ssa_cues.length} 期望 1`);
      else assert_translated(ssa_cues[0].text, "唯一一句", "SSA", report, "SSA 译文");
    }

    const lrc_entry = pick_translated(subtitle_files, "ep05.lrc");
    if (lrc_entry === null) report.fail("LRC 结构", "译文目录缺少 ep05.lrc");
    else {
      const lrc_lines = parse_lrc(lrc_entry.bytes.toString("utf8"));
      report.pass("LRC 结构", `行 ${lrc_lines.length}`);
      if (lrc_lines.length !== 2) report.fail("LRC 结构", `行数 ${lrc_lines.length} 期望 2`);
      else {
        if (lrc_lines[0].time !== "00:01.00" || lrc_lines[1].time !== "00:12.50")
          report.fail(
            "LRC 时间标签",
            `时间标签被改写：${lrc_lines.map((line) => line.time).join(" | ")}`,
          );
        else report.pass("LRC 时间标签", lrc_lines.map((line) => line.time).join(" | "));
        assert_translated(lrc_lines[0].text, "第一句", "LRC 第一条", report, "LRC 译文");
        assert_translated(lrc_lines[1].text, "第二句", "LRC 第二条", report, "LRC 译文");
      }
    }

    // ======================= 场景二：MV/MZ 游戏闭环 =======================
    const game_project = await setup_project(client, artifacts, "game-mvmz", MV_MZ_GAME_FIXTURE);
    const game_hits = game_project.summary?.["format_hit_counts"] ?? {};
    report.pass("MV/MZ 容器收拢", `rpgmaker_mv_mz=${game_hits["rpgmaker_mv_mz"]}`);
    if (game_hits["rpgmaker_mv_mz"] !== 1)
      report.fail("MV/MZ 容器收拢", `命中 ${game_hits["rpgmaker_mv_mz"]} 期望 1`);
    report.pass(
      "MV/MZ 条目落库",
      `文件 ${game_project.file_entries.length} 条目 ${game_project.item_total}`,
    );
    if (game_project.item_total !== 3)
      report.fail("MV/MZ 条目落库", `条目 ${game_project.item_total} 期望 3（地图/对白/原稿）`);

    const game_run = await run_translation(client, "game");
    report.pass(
      "MV/MZ 翻译终态",
      `status=${game_run.status} processed=${game_run.processed_line}/${game_run.total_line} error=${game_run.error_line}`,
    );
    if (game_run.status !== "done" || game_run.error_line !== 0)
      report.fail("MV/MZ 翻译终态", JSON.stringify(game_run));

    // 游戏目录收拢为 `game.zip` 容器，导出目录是去掉 `.zip` 的 `game`，
    // 只有数据成员按游戏内相对结构落盘，因此下载名用不含批次目录前缀的上传相对名。
    const game_files = await generate_and_download(
      client,
      "game",
      MV_MZ_GAME_FIXTURE.filter(([name]) => path.extname(name) === ".json").map(([name]) => name),
    );
    report.pass("MV/MZ 导出下载", game_files.entries.map((entry) => entry.name).join(", "));
    const exported_map = pick_translated(game_files, "Map001.json");
    const exported_system = pick_translated(game_files, "System.json");
    if (exported_map === null || exported_system === null) {
      report.fail(
        "MV/MZ 导出结构",
        `导出清单缺少游戏数据文件：${game_files.entries.map((entry) => entry.name).join(", ")}`,
      );
    } else {
      const map_json = JSON.parse(exported_map.bytes.toString("utf8"));
      if (map_json.displayName !== `${MOCK_TRANSLATION_PREFIX}地图`)
        report.fail("MV/MZ 导出译文", `displayName=${map_json.displayName}`);
      else report.pass("MV/MZ 导出译文", `displayName=${map_json.displayName}`);
      const dialogue_command =
        map_json.events?.[1]?.pages?.[0]?.list?.find((command) => command.code === 401) ?? null;
      if (dialogue_command?.parameters?.[0] !== `${MOCK_TRANSLATION_PREFIX}对白文字`)
        report.fail(
          "MV/MZ 导出译文",
          `对白参数=${JSON.stringify(dialogue_command?.parameters?.[0])}`,
        );
      else report.pass("MV/MZ 导出译文", `对白=${dialogue_command.parameters[0]}`);
      const name_command =
        map_json.events?.[1]?.pages?.[0]?.list?.find((command) => command.code === 101) ?? null;
      // mock 模型对带姓名的请求回送 `演员<条目id>`（见 web-long-task-mock-model.mjs），
      // 因此导出的姓名参数按该契约核对“姓名被译名写回”，不使用 【译】 前缀。
      const exported_name = String(name_command?.parameters?.[4] ?? "");
      if (!/^演员\d+$/u.test(exported_name))
        report.fail("MV/MZ 导出姓名", `姓名参数=${JSON.stringify(name_command?.parameters?.[4])}`);
      else report.pass("MV/MZ 导出姓名", `姓名=${exported_name}`);
      const system_json = JSON.parse(exported_system.bytes.toString("utf8"));
      if (system_json.gameTitle !== `${MOCK_TRANSLATION_PREFIX}原稿`)
        report.fail("MV/MZ 导出译文", `gameTitle=${system_json.gameTitle}`);
      else report.pass("MV/MZ 导出译文", `gameTitle=${system_json.gameTitle}`);

      // 回灌：把导出数据覆盖回原游戏目录重建工程，验证导出可被产品自身重新解析。
      // 导出只含数据文件，引擎标志文件沿用原稿，与“译文合并回游戏目录”的真实用法一致。
      const export_prefix = `${game_files.output_path}${path.sep}`;
      const reimport_files = [
        ...game_files.entries
          .filter((entry) => entry.path.startsWith(export_prefix))
          .map((entry) => [path.relative(game_files.output_path, entry.path), entry.bytes]),
        ...MV_MZ_GAME_FIXTURE.filter(([name]) => path.extname(name) === ".js"),
      ];
      report.pass("导出容器结构", reimport_files.map(([relative]) => relative).join(", "));
      const reimport_project = await setup_project(
        client,
        artifacts,
        "game-reimport",
        reimport_files,
      );
      report.pass(
        "导出容器回灌",
        `文件 ${reimport_project.file_entries.length} 条目 ${reimport_project.item_total}`,
      );
      if (reimport_project.item_total !== 3)
        report.fail("导出容器回灌", `条目 ${reimport_project.item_total} 期望 3`);
      // 回灌内容自证：回灌工程直接生成译文并下载，未翻译条目的导出正文即其 src——
      // 若导出字段又是第一轮的译文，证明导出容器可被产品自身重新解析且译文保持。
      const reimport_generated = await generate_and_download(client, "game-reimport");
      const reimport_map = reimport_generated.entries.find((entry) =>
        entry.name.endsWith("Map001.json"),
      );
      const reimport_system = reimport_generated.entries.find((entry) =>
        entry.name.endsWith("System.json"),
      );
      if (!reimport_map || !reimport_system)
        report.fail(
          "导出容器回灌",
          `回灌工程没有导出游戏数据文件：${reimport_generated.entries.map((entry) => entry.name).join(", ")}`,
        );
      else {
        const reimport_map_json = JSON.parse(reimport_map.bytes.toString("utf8"));
        const reimport_dialogue =
          reimport_map_json.events?.[1]?.pages?.[0]?.list?.find(
            (command) => command.code === 401,
          ) ?? null;
        const reimport_name =
          reimport_map_json.events?.[1]?.pages?.[0]?.list?.find(
            (command) => command.code === 101,
          ) ?? null;
        const reimport_system_json = JSON.parse(reimport_system.bytes.toString("utf8"));
        const round_trip_fields = [
          ["displayName", reimport_map_json.displayName, `${MOCK_TRANSLATION_PREFIX}地图`],
          ["对白", reimport_dialogue?.parameters?.[0], `${MOCK_TRANSLATION_PREFIX}对白文字`],
          // 姓名走 mock 的 actor 译法（“演员<id>”），第一轮导出与回灌导出保持一致。
          ["姓名", reimport_name?.parameters?.[4], "演员1"],
          ["gameTitle", reimport_system_json.gameTitle, `${MOCK_TRANSLATION_PREFIX}原稿`],
        ];
        for (const [field, actual, expected] of round_trip_fields)
          if (actual !== expected)
            report.fail("导出容器回灌", `${field}=${JSON.stringify(actual)} 期望 ${expected}`);
        if (round_trip_fields.every(([, actual, expected]) => actual === expected))
          report.pass("导出容器回灌", "四条译文经导出容器回灌后保持可解析");
      }
    }

    // ======================= 场景三：其余文件型冻结格式 =======================
    const glossary = await create_spreadsheet_fixture({
      A1: "src",
      B1: "dst",
      A2: "原文",
      B2: "译文",
      A3: "待翻",
    });
    const wolf = await create_spreadsheet_fixture({
      A1: "code",
      B1: "flag",
      C1: "type",
      D1: "info",
      F2: { text: "原文1", fill: 9 },
      F3: { rich: ["原", "文2"], fill: 9 },
      G3: { formula: "F3", result: "已译" },
      F4: { text: "排除", fill: 44 },
      F5: "无填充",
    });
    const text_project = await setup_project(client, artifacts, "text-formats", [
      ["data/kv.json", Buffer.from(KV_JSON_FIXTURE, "utf8")],
      ["data/messages.json", Buffer.from(MESSAGE_JSON_FIXTURE, "utf8")],
      ["patches/demo.trans", Buffer.from(TRANS_FIXTURE, "utf8")],
      ["patches/wolf.trans", Buffer.from(WOLF_TRANS_FIXTURE, "utf8")],
      ["scripts/game.rpy", Buffer.from(RENPY_FIXTURE, "utf8")],
      ["tables/glossary.xlsx", glossary],
      ["tables/wolf.xlsx", wolf],
    ]);
    const text_hits = text_project.summary?.["format_hit_counts"] ?? {};
    report.pass(
      "文件型格式命中",
      `json=${text_hits["json"]} trans=${text_hits["trans"]} rpy=${text_hits["rpy"]} xlsx=${text_hits["xlsx"]}`,
    );
    for (const [id, expected] of [
      ["json", 2],
      ["trans", 2],
      ["rpy", 1],
      ["xlsx", 2],
    ])
      if (text_hits[id] !== expected)
        report.fail("文件型格式命中", `${id}=${text_hits[id]} 期望 ${expected}`);
    report.pass("文件型条目落库", `条目 ${text_project.item_total}`);

    const text_run = await run_translation(client, "text-formats");
    report.pass(
      "文件型翻译终态",
      `status=${text_run.status} processed=${text_run.processed_line}/${text_run.total_line} error=${text_run.error_line}`,
    );
    if (text_run.status !== "done" || text_run.error_line !== 0)
      report.fail("文件型翻译终态", JSON.stringify(text_run));

    const text_files = await generate_and_download(client, "text-formats");
    report.pass("文件型译文下载", text_files.entries.map((entry) => entry.name).join(", "));

    const kv_entry = pick_translated(text_files, "kv.json");
    if (kv_entry === null) report.fail("KVJSON 译文", "译文目录缺少 kv.json");
    else {
      const kv = JSON.parse(kv_entry.bytes.toString("utf8"));
      if (kv["待翻"] !== `${MOCK_TRANSLATION_PREFIX}待翻`)
        report.fail("KVJSON 译文", `待翻=${JSON.stringify(kv["待翻"])}`);
      else report.pass("KVJSON 译文", `待翻=${kv["待翻"]}`);
      if (kv["已翻"] !== "已处理")
        report.fail("KVJSON 译文", `已翻的既有译文被改写：${JSON.stringify(kv["已翻"])}`);
      else report.pass("KVJSON 译文", "已翻的既有译文保留");
    }

    const trans_entry = pick_translated(text_files, "demo.trans");
    if (trans_entry === null) report.fail("TRANS 译文", "译文目录缺少 demo.trans");
    else {
      const trans = JSON.parse(trans_entry.bytes.toString("utf8"));
      const row = trans.project.files["file.json"].data[0];
      if (row[2] !== `${MOCK_TRANSLATION_PREFIX}原文`)
        report.fail("TRANS 译文", `译列=${JSON.stringify(row[2])}`);
      else report.pass("TRANS 译文", `译列=${row[2]}`);
      if (row[0] !== "id-1") report.fail("TRANS 结构", `id 列被改写：${JSON.stringify(row[0])}`);
      else report.pass("TRANS 结构", "id 与同位字段保留");
    }

    const wolf_trans_entry = pick_translated(text_files, "wolf.trans");
    if (wolf_trans_entry === null) report.fail("WOLF TRANS 译文", "译文目录缺少 wolf.trans");
    else {
      const wolf_trans = JSON.parse(wolf_trans_entry.bytes.toString("utf8"));
      const rows = wolf_trans.project.files["Data/Map001.json"].data;
      if (rows[0][1] !== `${MOCK_TRANSLATION_PREFIX}对话正文`)
        report.fail("WOLF TRANS 译文", `白名单行=${JSON.stringify(rows[0][1])}`);
      else report.pass("WOLF TRANS 译文", `白名单行=${rows[0][1]}`);
      if (rows[1][1] !== "")
        report.fail("WOLF TRANS 译文", `黑名单行被翻译：${JSON.stringify(rows[1][1])}`);
      else report.pass("WOLF TRANS 译文", "黑名单内部标识保持未译");
    }

    const rpy_entry = pick_translated(text_files, "game.rpy");
    if (rpy_entry === null) report.fail("RenPy 译文", "译文目录缺少 game.rpy");
    else {
      const rpy = rpy_entry.bytes.toString("utf8");
      if (!rpy.includes(`new "${MOCK_TRANSLATION_PREFIX}新文本"`))
        report.fail("RenPy 译文", `导出缺少新文本的译文：${rpy.slice(0, 200)}`);
      else report.pass("RenPy 译文", `new "${MOCK_TRANSLATION_PREFIX}新文本"`);
      if (!rpy.includes('new "开始"')) report.fail("RenPy 译文", "START 的既有译文丢失");
      else report.pass("RenPy 译文", "START 的既有译文保留");
      if (!rpy.includes('"艾丽丝" "你好"')) report.fail("RenPy 译文", "start 翻译块的既有译文丢失");
      else report.pass("RenPy 译文", "start 翻译块的既有译文保留");
    }

    const message_entry = pick_translated(text_files, "messages.json");
    if (message_entry === null) report.fail("MESSAGEJSON 译文", "译文目录缺少 messages.json");
    else {
      const messages = JSON.parse(message_entry.bytes.toString("utf8"));
      const translated = messages.filter((entry) =>
        String(entry.message ?? "").startsWith(MOCK_TRANSLATION_PREFIX),
      );
      if (translated.length !== 3)
        report.fail(
          "MESSAGEJSON 译文",
          `译文体 ${translated.length} 期望 3：${JSON.stringify(messages).slice(0, 200)}`,
        );
      else report.pass("MESSAGEJSON 译文", "三条 message 均为译文");
    }

    const glossary_entry = pick_translated(text_files, "glossary.xlsx");
    if (glossary_entry === null) report.fail("XLSX 译文", "译文目录缺少 glossary.xlsx");
    else report.pass("XLSX 译文", `${glossary_entry.name} ${glossary_entry.bytes.length} 字节`);

    const wolf_entry = pick_translated(text_files, "wolf.xlsx");
    if (wolf_entry === null) report.fail("WOLFXLSX 译文", "译文目录缺少 wolf.xlsx");
    else report.pass("WOLFXLSX 译文", `${wolf_entry.name} ${wolf_entry.bytes.length} 字节`);
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    await service.stop();
    await mock_model.close();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-2_000)}\n`);
    }
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
