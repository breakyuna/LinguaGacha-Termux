#!/usr/bin/env node
/**
 * TW-11 备份恢复验证：产品备份功能与运维等价流程。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs <构建目录>`。
 *
 * 产品事实（2026-10-18 核对 `src/backend/api/api-routes.ts` 与相关服务）：
 *   - 产品没有面向整个数据根的备份 / 恢复功能：路由表不提供数据根打包、恢复或
 *     设置整包导入；`/api/quality/rules|prompts` 的导出 / 导入只是单类资源交换，
 *     不覆盖工程与全局设置，不构成备份。
 *   - 产品唯一的显式备份能力是工程副本：`/api/session/project/copy` 在当前工程的
 *     数据库一致性边界生成 `.lg` 快照，落入 `<数据根>/userdata/project-copies/`，
 *     并经 `GET /api/web/files/download` 受控下载交付（下载边界显式包含副本目录）。
 *     粒度为单工程；产品内没有恢复动作，把副本文件放回原路径即完成恢复。
 *   - 数据根（`--data-root`）承载工程 `.lg` 与 `userdata/`（`config.json` 设置、
 *     工程副本、上传暂存、技能与预设），整目录复制即运维等价备份。
 *
 * 覆盖内容：
 *   第一部分（产品功能）：建合成小说工程 → 工程副本备份 → 受控下载交付 →
 *     删除原工程 → 打开失败实证 → 副本放回原路径 → 打开 → 文件 / 条目 /
 *     逐文件条目数 / 统计与基线一致；
 *   第二部分（运维等价流程）：修改设置 → 停服务 → 复制数据根到备份位置 →
 *     破坏（删除工程文件 + 写坏 `userdata/config.json`）→ 损坏态实证 →
 *     备份恢复到全新数据根 → 启动服务 → 工程可打开且事实一致、设置恢复。
 *
 * 用法：
 *   node buildtools/web-backup-restore-verify.mjs [--keep=true] [--build-dir=<目录>] [--port=<端口>]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
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

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUILD_DIR = path.join(PROJECT_ROOT, "build", "web");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 60_000; // 解析与工程提交在软件渲染的本机上可能较慢
const DEFAULT_PORT = 8484;

const DEPLOY_ENTRY = "index.mjs";
const DEPLOY_RESOURCE_PATHS = ["dist", "builtin", "resources/pdf-print.css", "version.txt"];

/** 合成小说夹具：四个文件覆盖两种编码与两种格式，正文互不重复。 */
const GBK_NOVEL_TEXT = "第一行中文正文。\n第二行继续描写主角的对白。\n第三行收尾。\n";
const UTF8_NOVEL_TEXT = "备份恢复探针第一段。\n备份恢复探针第二段。\n";
const MARKDOWN_NOVEL_TEXT = "# 备份恢复探针\n\n正文第一行\n正文第二行\n";
const EPUB_PARAGRAPHS = ["第一章正文：主角走进城门。", "第二章正文：夜色降临。"];

/** GBK 字节：用仓库开发依赖生成夹具，服务运行时不经过仓库 node_modules。 */
async function create_gbk_bytes() {
  const { default: iconv } = await import("iconv-lite");
  return iconv.encode(GBK_NOVEL_TEXT, "gbk");
}

/** 合成 EPUB：mimetype + container + opf + 一章 xhtml，与部署验证同构。 */
async function create_epub_bytes() {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.file(
    "OPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata/>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`,
  );
  zip.file(
    "OPS/chapter.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><p>${EPUB_PARAGRAPHS[0]}</p><p>${EPUB_PARAGRAPHS[1]}</p></body>
</html>`,
  );
  return zip.generateAsync({ compression: "STORE", type: "nodebuffer" });
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

/** 列出产品启动的 Chromium 进程；本探针不应启动任何浏览器。 */
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

  async post(route, payload) {
    return await this.data("POST", route, {
      body: JSON.stringify(payload ?? {}),
      headers: { "Content-Type": "application/json" },
    });
  }

  /** 上传原始字节到暂存区，返回暂存材料记录（含绝对路径）。 */
  async upload(name, bytes) {
    return await this.data("POST", `/api/web/files/upload?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  /** 受控下载原始字节，用于核对产品备份产物的交付路径。 */
  async download(download_path) {
    const response = await fetch(
      `${this.baseUrl}/api/web/files/download?path=${encodeURIComponent(download_path)}`,
      {
        headers: this.cookie === "" ? {} : { cookie: this.cookie },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
  }
}

/** 从错误响应提取稳定错误码，形状与多实例验证脚本一致。 */
function read_error_code(payload) {
  if (payload === null || typeof payload !== "object") return "";
  return String(payload["error"]?.["code"] ?? payload["code"] ?? "");
}

/** 读取当前加载工程的一致性事实：文件数、条目数、逐文件条目与翻译统计。 */
async function read_project_facts(client) {
  const manifest = await client.post("/api/session/project/manifest", {});
  const stats = await client.post("/api/project/translation-stats", {});
  const workbench = await client.post("/api/workbench/snapshot", {});
  const entries = workbench?.["snapshot"]?.["entries"] ?? [];
  return {
    files: Number(manifest?.["counts"]?.["files"] ?? -1),
    items: Number(manifest?.["counts"]?.["items"] ?? -1),
    stats: stats?.["stats"] ?? null,
    per_file: entries
      .map((entry) => ({
        rel_path: String(entry?.["rel_path"] ?? ""),
        total_count: Number(entry?.["progress"]?.["total_count"] ?? -1),
      }))
      .sort((left, right) => left.rel_path.localeCompare(right.rel_path)),
  };
}

/** 规范化后做结构比较；逐文件条目已排序，避免文件顺序差异造成误报。 */
function same_project_facts(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 建立访问会话并返回 API 客户端；凭据来自服务启动输出。 */
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

function start_service(build_dir, data_root, port, label) {
  return new WebServiceProcess(
    spawn(process.execPath, [DEPLOY_ENTRY, `--port=${port}`, `--data-root=${data_root}`], {
      cwd: build_dir, // 以构建目录为工作目录，证明运行不依赖仓库位置
      stdio: ["ignore", "pipe", "pipe"],
    }),
    label,
  );
}

/**
 * 损坏态实证专用启动：数据根已破坏时服务可能启动失败，这本身也是有效证据，
 * 因此进程提前退出或超时都返回 null，由调用方按两种形态分别记录。
 */
async function try_start_service(build_dir, data_root, port, label) {
  const service = start_service(build_dir, data_root, port, label);
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  let access = null;
  while (Date.now() < deadline) {
    access = service.read_access();
    if (access !== null) break;
    if (service.child.exitCode !== null) break; // 进程已退出：启动失败即破坏证据
    await sleep(100);
  }
  return { service, access };
}

function parse_arguments(argv) {
  const options = { keep: false, build_dir: DEFAULT_BUILD_DIR, port: DEFAULT_PORT };
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
      case "port":
        if (!/^\d+$/u.test(value)) throw new Error(`Invalid port: ${value}`);
        options.port = Number(value);
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
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-backup-restore-"));
  const build_dir = options.build_dir;
  const data_root_a = path.join(artifacts, "data-root-a"); // 运行与破坏都发生在这
  const backup_root = path.join(artifacts, "backup", "data-root"); // 运维备份落点
  const data_root_b = path.join(artifacts, "restored", "data-root"); // 恢复出的全新数据根
  const project_rel_path = path.join("projects", "backup-novel.lg");
  const project_path_a = path.join(data_root_a, project_rel_path);
  const project_path_b = path.join(data_root_b, project_rel_path);
  mkdirSync(data_root_a, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);
  process.stdout.write(`[verify] 构建目录 ${build_dir}\n`);
  process.stdout.write(`[verify] 数据根 A ${data_root_a}\n`);

  const service_a = start_service(build_dir, data_root_a, options.port, "服务 A");
  let client_a = null;
  let service_b = null; // 恢复出全新数据根后才启动，避免数据根不存在时启动失败
  let corrupted = null;

  try {
    // 部署产物完整性：入口与运行资源都必须随构建落盘。
    const missing = [DEPLOY_ENTRY, ...DEPLOY_RESOURCE_PATHS].filter(
      (relative) => !existsSync(path.join(build_dir, relative)),
    );
    report.pass(
      "构建产物完整",
      missing.length === 0 ? `${build_dir} 入口与运行资源齐全` : `缺失 ${missing.join(", ")}`,
    );
    if (missing.length > 0)
      throw new VerifyFailure(`build artifacts missing: ${missing.join(", ")}`);

    // ============ 数据根 A 上建工程，作为两部分共用的基线 ============
    client_a = await connect(service_a, "服务 A（数据根 A）");
    report.pass("服务启动与访问会话（数据根 A）", `port=${options.port}`);

    const novel_files = [
      ["backup/gbk.txt", await create_gbk_bytes()],
      ["backup/utf8.txt", Buffer.from(UTF8_NOVEL_TEXT, "utf8")],
      ["backup/chapter.md", Buffer.from(MARKDOWN_NOVEL_TEXT, "utf8")],
      ["backup/book.epub", await create_epub_bytes()],
    ];
    const staged = [];
    for (const [name, bytes] of novel_files) {
      const material = await client_a.upload(name, bytes);
      staged.push({
        name,
        path: String(material?.["path"] ?? ""),
        id: String(material?.["material_id"] ?? ""),
      });
    }
    const incomplete = staged.filter((entry) => entry.path === "" || entry.id === "");
    report.pass(
      "合成小说上传",
      incomplete.length === 0
        ? `${staged.length} 个文件已暂存`
        : `记录不完整：${incomplete.map((entry) => entry.name).join(", ")}`,
    );
    if (incomplete.length > 0) throw new VerifyFailure("staged material records incomplete");

    const summary = await client_a.post("/api/session/source-files/summary", {
      source_paths: staged.map((entry) => entry.path),
    });
    const hits = summary?.["format_hit_counts"] ?? {};
    const expected_hits = { txt: 2, md: 1, epub: 1 };
    const mismatches = Object.entries(expected_hits).filter(([id, count]) => hits[id] !== count);
    report.pass(
      "源文件摘要",
      mismatches.length === 0
        ? `txt=${hits["txt"]} md=${hits["md"]} epub=${hits["epub"]}`
        : JSON.stringify({ expected: expected_hits, actual: hits }),
    );
    if (mismatches.length > 0)
      report.fail(
        "源文件摘要",
        `不一致：${mismatches.map(([id, count]) => `${id}=${hits[id]} 期望 ${count}`).join(", ")}`,
      );
    if (summary?.["source_file_count"] !== novel_files.length)
      report.fail(
        "源文件摘要",
        `source_file_count=${summary?.["source_file_count"]} 期望 ${novel_files.length}`,
      );

    const created = await client_a.post("/api/session/project/create", {
      path: project_path_a,
      material_ids: staged.map((entry) => entry.id),
    });
    const failed_files = created?.["failed_files"] ?? [];
    report.pass(
      "工程创建",
      failed_files.length === 0 ? project_path_a : `失败 ${failed_files.length} 个`,
    );
    if (failed_files.length > 0)
      report.fail("工程创建", JSON.stringify(failed_files).slice(0, 300));

    const baseline = await read_project_facts(client_a);
    report.pass(
      "工程创建与基线事实",
      `files=${baseline.files} items=${baseline.items} total_items=${baseline.stats?.["total_items"]}`,
    );
    if (baseline.files !== novel_files.length)
      report.fail("工程创建与基线事实", `文件数 ${baseline.files} 期望 ${novel_files.length}`);
    if (baseline.items <= 0) report.fail("工程创建与基线事实", `条目数为 ${baseline.items}`);

    // ============ 第一部分：产品功能——工程副本备份与恢复 ============
    // 产品唯一显式备份能力：当前工程的一致性 .lg 快照落入 userdata/project-copies/。
    const copy_response = await client_a.call("POST", "/api/session/project/copy", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const copy_path =
      copy_response.payload?.["data"]?.["path"] ?? copy_response.payload?.["path"] ?? "";
    const copy_size = Number(copy_response.payload?.["data"]?.["size"] ?? 0);
    const copy_directory = path.join(data_root_a, "userdata", "project-copies");
    const copy_in_place = copy_path.startsWith(copy_directory + path.sep);
    const copy_header = existsSync(copy_path)
      ? readFileSync(copy_path).subarray(0, 15).toString("latin1")
      : "";
    report.pass(
      "产品备份（工程副本）",
      `HTTP ${copy_response.status} ${path.basename(copy_path)} size=${copy_size}`,
    );
    if (copy_response.status < 200 || copy_response.status >= 300)
      report.fail(
        "产品备份（工程副本）",
        `HTTP ${copy_response.status} ${JSON.stringify(copy_response.payload).slice(0, 200)}`,
      );
    if (!copy_in_place) report.fail("产品备份（工程副本）", `副本未落入工程副本目录：${copy_path}`);
    if (copy_header !== "SQLite format 3")
      report.fail("产品备份（工程副本）", `文件头异常：${copy_header}`);

    // 备份产物经产品受控下载交付：下载边界显式包含工程副本目录。
    const downloaded = await client_a.download(copy_path);
    const downloaded_header = downloaded.buffer.subarray(0, 15).toString("latin1");
    report.pass(
      "备份交付（受控下载）",
      `HTTP ${downloaded.status} bytes=${downloaded.buffer.length}`,
    );
    if (downloaded.status < 200 || downloaded.status >= 300)
      report.fail("备份交付（受控下载）", `HTTP ${downloaded.status}`);
    if (downloaded_header !== "SQLite format 3")
      report.fail("备份交付（受控下载）", `文件头异常：${downloaded_header}`);
    if (existsSync(copy_path) && downloaded.buffer.length !== statSync(copy_path).size)
      report.fail(
        "备份交付（受控下载）",
        `下载字节 ${downloaded.buffer.length} 与磁盘 ${statSync(copy_path).size} 不一致`,
      );

    // 模拟丢失：先卸载再删除原工程（含 SQLite 边车文件），打开必须失败。
    await client_a.post("/api/session/project/close", {});
    for (const sidecar of ["", "-wal", "-shm"]) {
      rmSync(`${project_path_a}${sidecar}`, { force: true });
    }
    const open_after_loss = await client_a.call("POST", "/api/session/project/open", {
      body: JSON.stringify({ path: project_path_a }),
      headers: { "Content-Type": "application/json" },
    });
    const loss_code = read_error_code(open_after_loss.payload);
    report.pass("原工程删除后打开失败", `HTTP ${open_after_loss.status} ${loss_code}`);
    if (open_after_loss.status < 400 || loss_code !== "project.not_found")
      report.fail(
        "原工程删除后打开失败",
        `期望 4xx project.not_found，实际 HTTP ${open_after_loss.status} ${loss_code}`,
      );

    // 恢复：产品内没有恢复动作，把副本文件放回原路径后重新打开。
    cpSync(copy_path, project_path_a);
    await client_a.post("/api/session/project/open", { path: project_path_a });
    const restored_product = await read_project_facts(client_a);
    report.pass(
      "副本恢复原路径",
      `files=${restored_product.files} items=${restored_product.items}`,
    );
    if (!same_project_facts(restored_product, baseline))
      report.fail(
        "恢复一致性（产品副本）",
        `恢复后 ${JSON.stringify(restored_product)} 基线 ${JSON.stringify(baseline)}`,
      );
    else report.pass("恢复一致性（产品副本）", "文件 / 条目 / 逐文件条目 / 统计与基线一致");

    // ============ 设置修改：让 config.json 带上可识别状态，供第二部分恢复核对 ============
    const settings_update = await client_a.post("/api/settings/update", { app_language: "EN" });
    const recent_add = await client_a.post("/api/settings/recent-projects/add", {
      path: project_path_a,
    });
    const language_after_update = settings_update?.["settings"]?.["app_language"] ?? "";
    const recent_after_add = Array.isArray(recent_add?.["settings"]?.["recent_projects"])
      ? recent_add["settings"]["recent_projects"]
      : [];
    report.pass("设置修改与最近工程", `app_language=${language_after_update}`);
    if (language_after_update !== "EN")
      report.fail("设置修改与最近工程", `app_language=${language_after_update} 期望 EN`);
    if (!recent_after_add.some((entry) => entry?.["path"] === project_path_a))
      report.fail("设置修改与最近工程", "最近工程列表缺少当前工程");

    // ============ 第二部分：运维等价流程 ============
    await service_a.stop();
    report.pass("停服务（备份前置）", `exitCode=${service_a.child.exitCode}`);
    if (service_a.child.exitCode !== 0)
      report.fail("停服务（备份前置）", `exitCode=${service_a.child.exitCode}`);

    // 停服务后整目录复制数据根：工程 .lg 与 userdata 设置都进入备份。
    cpSync(data_root_a, backup_root, { recursive: true });
    const backup_project = path.join(backup_root, project_rel_path);
    const backup_config = path.join(backup_root, "userdata", "config.json");
    const backup_complete =
      existsSync(backup_project) &&
      existsSync(backup_config) &&
      existsSync(path.join(backup_root, "userdata", "project-copies"));
    report.pass(
      "数据根复制到备份位置",
      backup_complete
        ? `${backup_root}（工程 + 设置 + 副本目录）`
        : `备份不完整：project=${existsSync(backup_project)} config=${existsSync(backup_config)}`,
    );
    if (!backup_complete) report.fail("数据根复制到备份位置", "备份缺少工程、设置或副本目录");

    // 模拟数据损坏：删除工程文件并写坏设置文件。
    for (const sidecar of ["", "-wal", "-shm"]) {
      rmSync(`${project_path_a}${sidecar}`, { force: true });
    }
    writeFileSync(path.join(data_root_a, "userdata", "config.json"), '{"app_language": "EN",');
    const corrupted_project_gone = !existsSync(project_path_a);
    let corrupted_config_broken = false;
    try {
      JSON.parse(readFileSync(path.join(data_root_a, "userdata", "config.json"), "utf8"));
    } catch {
      corrupted_config_broken = true;
    }
    report.pass(
      "模拟数据损坏",
      `工程文件已删除=${corrupted_project_gone} 设置文件已损坏=${corrupted_config_broken}`,
    );
    if (!corrupted_project_gone) report.fail("模拟数据损坏", "工程文件仍然存在");
    if (!corrupted_config_broken) report.fail("模拟数据损坏", "设置文件仍可解析");

    // 损坏态实证：在损坏数据根上启动，破坏必须可观察（工程缺失、设置不可读），
    // 证明备份恢复不是空转；服务整体启动失败同样是有效的破坏证据。
    corrupted = await try_start_service(build_dir, data_root_a, options.port, "服务 C（损坏根）");
    if (corrupted.access === null) {
      report.pass("损坏态实证", "损坏数据根上服务未能启动（启动即失败的破坏证据）");
    } else {
      const client_c = await connect(corrupted.service, "服务 C（损坏根）");
      const open_corrupted = await client_c.call("POST", "/api/session/project/open", {
        body: JSON.stringify({ path: project_path_a }),
        headers: { "Content-Type": "application/json" },
      });
      const open_code = read_error_code(open_corrupted.payload);
      const settings_corrupted = await client_c.call("POST", "/api/settings/app", {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const settings_code = read_error_code(settings_corrupted.payload);
      report.pass(
        "损坏态实证",
        `打开工程 HTTP ${open_corrupted.status} ${open_code}；读取设置 HTTP ${settings_corrupted.status} ${settings_code}`,
      );
      if (open_corrupted.status < 400 || open_code !== "project.not_found")
        report.fail(
          "损坏态实证",
          `损坏根上打开工程应失败，实际 HTTP ${open_corrupted.status} ${open_code}`,
        );
      if (settings_corrupted.status >= 200 && settings_corrupted.status < 300)
        report.fail("损坏态实证", "损坏的设置文件仍被成功读取，破坏不可观察");
    }
    await corrupted.service.stop();
    corrupted = null;

    // 备份恢复到全新数据根：先做字节级核对，再启动服务做行为级核对。
    cpSync(backup_root, data_root_b, { recursive: true });
    const restored_project_ready = existsSync(project_path_b);
    const restored_config = path.join(data_root_b, "userdata", "config.json");
    const config_identical =
      existsSync(restored_config) &&
      Buffer.compare(readFileSync(backup_config), readFileSync(restored_config)) === 0;
    report.pass(
      "备份恢复到全新数据根",
      `工程文件就位=${restored_project_ready} 设置字节一致=${config_identical}`,
    );
    if (!restored_project_ready) report.fail("备份恢复到全新数据根", "恢复后工程文件缺失");
    if (!config_identical) report.fail("备份恢复到全新数据根", "恢复后设置文件与备份不一致");

    service_b = start_service(build_dir, data_root_b, options.port, "服务 B");
    const client_b = await connect(service_b, "服务 B（数据根 B）");
    report.pass("恢复后服务启动（数据根 B）", `port=${options.port}`);

    await client_b.post("/api/session/project/open", { path: project_path_b });
    const restored_ops = await read_project_facts(client_b);
    report.pass(
      "恢复后工程可打开",
      `files=${restored_ops.files} items=${restored_ops.items} total_items=${restored_ops.stats?.["total_items"]}`,
    );
    if (!same_project_facts(restored_ops, baseline))
      report.fail(
        "恢复一致性（工程事实）",
        `恢复后 ${JSON.stringify(restored_ops)} 基线 ${JSON.stringify(baseline)}`,
      );
    else report.pass("恢复一致性（工程事实）", "文件 / 条目 / 逐文件条目 / 统计与基线一致");

    const settings_restored = await client_b.post("/api/settings/app", {});
    const language_restored = settings_restored?.["settings"]?.["app_language"] ?? "";
    const recent_restored = Array.isArray(settings_restored?.["settings"]?.["recent_projects"])
      ? settings_restored["settings"]["recent_projects"]
      : [];
    report.pass("设置恢复", `app_language=${language_restored}`);
    if (language_restored !== "EN")
      report.fail("设置恢复", `app_language=${language_restored} 期望 EN`);
    // 最近工程在备份里记录的是数据根 A 的绝对路径；恢复后仍应按原值可读。
    if (!recent_restored.some((entry) => entry?.["path"] === project_path_a))
      report.fail("设置恢复", "最近工程列表与备份不一致");
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service_a.stderr !== "") process.stdout.write(`[服务 A:err] ${service_a.stderr}\n`);
    if (service_b !== null && service_b.stderr !== "")
      process.stdout.write(`[服务 B:err] ${service_b.stderr}\n`);
  } finally {
    if (corrupted !== null) await corrupted.service.stop();
    await service_a.stop();
    if (service_b !== null) await service_b.stop();
    for (const service of [service_a, service_b]) {
      if (service === null || service.stderr === "") continue;
      process.stdout.write(`[${service.label}:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }

    // 本探针不调用图片 / PDF 宿主：服务停止后不得有任何浏览器进程或 profile。
    const processes = list_chromium_processes();
    const profiles = list_chromium_profiles();
    report.pass("无浏览器启动", `profile=${profiles.length} process=${processes.length}`);
    if (profiles.length > 0) report.fail("无浏览器启动", `残留 profile：${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("无浏览器启动", `残留进程：${processes[0].slice(0, 160)}`);

    for (const [service, name] of [
      [service_a, "服务 A"],
      [service_b, "服务 B"],
    ]) {
      if (service === null) continue;
      const exit_code = service.child.exitCode;
      report.pass(`${name} 正常停止`, `exitCode=${exit_code}`);
      if (exit_code !== 0) report.fail(`${name} 正常停止`, `exitCode=${exit_code}`);
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
  process.stdout.write("---- 结论 ----\n");
  process.stdout.write(
    "产品功能（第一部分）：工程副本 POST /api/session/project/copy 是产品唯一显式备份能力，\n" +
      "  在当前工程的一致性边界生成 .lg 快照落入 <数据根>/userdata/project-copies/，并经\n" +
      "  GET /api/web/files/download 受控下载交付；粒度为单工程，产品内无恢复动作，\n" +
      "  恢复 = 将副本文件放回原路径后打开。数据根整包备份与设置恢复不在产品能力内。\n",
  );
  process.stdout.write(
    "运维等价流程（第二部分）：停服务后整目录复制数据根（工程 .lg + userdata/config.json）\n" +
      "  即为备份；破坏（删除工程文件 + 写坏设置）可观察，从备份恢复到全新数据根后\n" +
      "  工程事实与设置完整还原。该流程属运维操作，不是产品功能。\n",
  );
  return report.failed_count === 0 ? 0 : 1;
}

process.exitCode = await main();
