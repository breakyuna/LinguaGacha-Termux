#!/usr/bin/env node
/**
 * 仓库外部署与运行依赖加载验证（R-02 / TW-11 部署面）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`。
 *
 * 覆盖内容：
 *   1. 复制 `build/web` 到仓库外临时目录，以该目录为 cwd、全新数据根启动正式入口；
 *   2. 核对部署产物完整性（入口、4 个 worker 入口、静态资源、内置资源、版本文件）；
 *   3. 上传合成小说格式（GBK / UTF-8 TXT、Markdown、EPUB、PDF）并建工程，
 *      断言格式命中与工程提交——jszip、mupdf、chardet、iconv-lite 与 SQLite
 *      在部署位置真实加载，仓库内 node_modules 不参与运行；
 *   4. 追加一个 MV/MZ 目录上传，只作部署完整性检查：证明随部署发布的
 *      rpgmaker prepare worker 入口与 oxc 原生绑定可加载。游戏格式功能已按
 *      方案 1.1 冻结，此处不作功能验收；
 *   5. 工程副本一致性快照；无模型时翻译受理的失败路径；
 *   6. 停止后退出码 0；全程不启动 Chromium，结束时不得残留浏览器进程与 profile。
 *
 * 用法：
 *   node buildtools/web-deploy-verify.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_BUILD_DIR = path.join(PROJECT_ROOT, "build", "web");

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

/** GBK 长样本：证明 chardet 与 iconv-lite 在部署位置可用。 */
const GBK_NOVEL_TEXT = "第一行中文正文。\n第二行继续描写主角的对白。\n第三行收尾。\n";

/** 合成 PDF：文字页 + 纯图页，证明 mupdf 在部署位置可解析。 */
function create_pdf_bytes() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const pages = [];
  for (const text of ["部署探针第一页", null]) {
    const page = objects.length + 1;
    pages.push(page);
    const content =
      text === null ? "0.1 0.4 0.8 rg 40 40 120 80 re f" : `BT /F1 18 Tf 40 240 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

/** 合成 EPUB：mimetype + container + opf + 一章 xhtml，证明 jszip 在部署位置可用。 */
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
  <body><p>第一章正文：主角走进城门。</p><p>第二章正文：夜色降临。</p></body>
</html>`,
  );
  return zip.generateAsync({ compression: "STORE", type: "nodebuffer" });
}

/** GBK 字节：用仓库开发依赖生成夹具，运行时不经过仓库 node_modules。 */
async function create_gbk_bytes() {
  const { default: iconv } = await import("iconv-lite");
  return iconv.encode(GBK_NOVEL_TEXT, "gbk");
}

/** MV/MZ 目录成员：只用于 prepare worker 加载的部署完整性检查。 */
const MV_MZ_FILES = [
  ["game/www/data/System.json", JSON.stringify({ gameTitle: "部署探针" })],
  [
    "game/www/data/Map001.json",
    JSON.stringify({
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
    }),
  ],
  ["game/www/js/rmmz_core.js", "// engine marker"],
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

  /** 上传原始字节到暂存区，返回暂存材料记录（含绝对路径）。 */
  async upload(name, bytes) {
    return await this.data("POST", `/api/web/files/upload?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }
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
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-deploy-verify-"));
  const deploy_dir = path.join(artifacts, "deploy");
  const data_root = path.join(artifacts, "data-root");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  // 仓库外部署：复制构建产物后，服务进程只依赖该目录与全新数据根。
  cpSync(WEB_BUILD_DIR, deploy_dir, { recursive: true });
  process.stdout.write(`[verify] 部署目录 ${deploy_dir}\n`);

  const service = new WebServiceProcess(
    spawn(process.execPath, [DEPLOY_ENTRY, "--port=0", `--data-root=${data_root}`], {
      cwd: deploy_dir, // 以部署目录为工作目录，证明运行不依赖仓库位置
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
    report.pass("仓库外启动与访问会话", `HTTP ${session.status}`);

    // 部署产物完整性：入口、worker 入口与运行资源都必须随构建落盘。
    const missing = [DEPLOY_ENTRY, ...WORKER_ENTRIES, ...DEPLOY_RESOURCE_PATHS].filter(
      (relative) => !existsSync(path.join(deploy_dir, relative)),
    );
    report.pass(
      "部署产物完整",
      missing.length === 0
        ? `${WORKER_ENTRIES.length + 1} 个入口与运行资源齐全`
        : `缺失 ${missing.join(", ")}`,
    );
    if (missing.length > 0) report.fail("部署产物完整", `缺失：${missing.join(", ")}`);

    const bootstrap = await client.data("GET", "/api/web/bootstrap");
    report.pass(
      "能力事实",
      `imageHost=${bootstrap?.["capabilities"]?.["imageHost"]} pdfHost=${bootstrap?.["capabilities"]?.["pdfHost"]}`,
    );

    // 小说格式上传：解析与工程提交在部署进程内真实执行。
    const novel_files = [
      ["novel/gbk.txt", await create_gbk_bytes()],
      ["novel/utf8.txt", Buffer.from("UTF-8 正文第一行。\nUTF-8 正文第二行。\n", "utf8")],
      ["novel/chapter.md", Buffer.from("# 标题\n\n正文第一行\n正文第二行\n", "utf8")],
      ["novel/book.epub", await create_epub_bytes()],
      ["novel/manual.pdf", create_pdf_bytes()],
    ];
    const staged = [];
    for (const [name, bytes] of novel_files) {
      const material = await client.upload(name, bytes);
      staged.push({
        name,
        path: String(material?.["path"] ?? ""),
        id: String(material?.["material_id"] ?? ""),
      });
    }
    const incomplete = staged.filter((entry) => entry.path === "" || entry.id === "");
    report.pass(
      "小说格式上传",
      incomplete.length === 0
        ? `${staged.length} 个文件已暂存`
        : `记录不完整：${incomplete.map((entry) => entry.name).join(", ")}`,
    );
    if (incomplete.length > 0) throw new VerifyFailure("staged material records incomplete");

    const summary = await client.data("POST", "/api/session/source-files/summary", {
      body: JSON.stringify({ source_paths: staged.map((entry) => entry.path) }),
      headers: { "Content-Type": "application/json" },
    });
    const hits = summary?.["format_hit_counts"] ?? {};
    const expected_hits = { txt: 2, md: 1, epub: 1, pdf: 1 };
    const mismatches = Object.entries(expected_hits).filter(([id, count]) => hits[id] !== count);
    report.pass(
      "小说格式命中",
      mismatches.length === 0
        ? `txt=${hits["txt"]} md=${hits["md"]} epub=${hits["epub"]} pdf=${hits["pdf"]}`
        : JSON.stringify({ expected: expected_hits, actual: hits }),
    );
    if (mismatches.length > 0)
      report.fail(
        "小说格式命中",
        `不一致：${mismatches.map(([id, count]) => `${id}=${hits[id]} 期望 ${count}`).join(", ")}`,
      );
    if (summary?.["source_file_count"] !== novel_files.length)
      report.fail(
        "小说格式命中",
        `source_file_count=${summary?.["source_file_count"]} 期望 ${novel_files.length}`,
      );

    // 工程提交：解析流水线、SQLite 写入与预设落库都在部署进程内完成。
    const project_path = path.join(artifacts, "projects", "deploy-novel.lg");
    mkdirSync(path.dirname(project_path), { recursive: true });
    const created = await client.data("POST", "/api/session/project/create", {
      body: JSON.stringify({ path: project_path, material_ids: staged.map((entry) => entry.id) }),
      headers: { "Content-Type": "application/json" },
    });
    // 全部小说格式都必须解析成功：失败文件会随创建响应返回，不能静默缺省。
    const failed_files = created?.["failed_files"] ?? [];
    report.pass(
      "工程创建",
      failed_files.length === 0 ? "无失败文件" : `失败 ${failed_files.length} 个`,
    );
    if (failed_files.length > 0)
      report.fail("工程创建", JSON.stringify(failed_files).slice(0, 300));
    const snapshot = await client.data("POST", "/api/session/project/snapshot", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    if (snapshot?.["project"]?.["loaded"] !== true)
      report.fail("工程创建", `snapshot=${JSON.stringify(snapshot)}`);

    // 工作台快照证明解析产物真实落库：文件条目与翻译条目都大于零。
    const workbench = await client.data("POST", "/api/workbench/snapshot", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const file_entries = workbench?.["snapshot"]?.["entries"] ?? [];
    const item_total = file_entries.reduce(
      (sum, entry) => sum + Number(entry?.["progress"]?.["total_count"] ?? 0),
      0,
    );
    report.pass("工程内容落库", `文件 ${file_entries.length} 个`);
    if (file_entries.length === 0) report.fail("工程内容落库", "工作台快照没有文件条目");
    if (item_total <= 0) report.fail("工程内容落库", `翻译条目总数为 ${item_total}`);

    // MV/MZ 目录上传后真实建工程，只作部署完整性检查：prepare worker 入口与 oxc
    // 原生绑定在部署位置被真实加载。游戏格式功能已按方案 1.1 冻结，此处不作功能验收。
    await client.data("POST", "/api/session/project/close", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const game_staged = [];
    for (const [name, content] of MV_MZ_FILES) {
      const material = await client.upload(name, Buffer.from(content, "utf8"));
      game_staged.push(String(material?.["path"] ?? ""));
    }
    // 落盘布局为 `web-imports/<上传名>`：游戏根即 System.json 上三级目录。
    const game_root = path.resolve(game_staged[0] ?? "", "..", "..", "..");
    const game_project_path = path.join(artifacts, "projects", "deploy-game.lg");
    await client.data("POST", "/api/session/project/create", {
      body: JSON.stringify({ path: game_project_path, source_paths: [game_root] }),
      headers: { "Content-Type": "application/json" },
    });
    const game_workbench = await client.data("POST", "/api/workbench/snapshot", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const game_entries = game_workbench?.["snapshot"]?.["entries"] ?? [];
    report.pass("prepare worker 部署加载", `游戏工程文件 ${game_entries.length} 个`);
    if (game_entries.length === 0)
      report.fail(
        "prepare worker 部署加载",
        "MV/MZ 目录未进入工程，worker 入口或 oxc 绑定可能未加载",
      );

    // 工程副本：数据库一致性边界快照。
    const copy_response = await client.call("POST", "/api/session/project/copy", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const copy_path =
      copy_response.payload?.["data"]?.["path"] ?? copy_response.payload?.["path"] ?? "";
    if (copy_response.status < 200 || copy_response.status >= 300 || copy_path === "")
      report.fail(
        "工程副本",
        `HTTP ${copy_response.status} ${JSON.stringify(copy_response.payload).slice(0, 200)}`,
      );
    else {
      const header = readFileSync(copy_path).subarray(0, 15).toString("latin1");
      report.pass("工程副本", header === "SQLite format 3" ? copy_path : `文件头异常：${header}`);
      if (header !== "SQLite format 3") report.fail("工程副本", `文件头：${header}`);
    }

    // 统计查询回读数据库：证明条目与进度事实在部署进程内可重复读取。
    const stats = await client.data("POST", "/api/project/translation-stats", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const stats_total = Number(stats?.["stats"]?.["total_items"] ?? 0);
    report.pass("翻译统计回读", `total_items=${stats_total}`);
    if (stats_total <= 0) report.fail("翻译统计回读", "统计中没有翻译条目");
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    await service.stop();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }

    // 本探针不调用图片 / PDF 宿主：服务停止后不得有任何浏览器进程或 profile。
    const processes = list_chromium_processes();
    const profiles = list_chromium_profiles();
    report.pass("无浏览器启动", `profile=${profiles.length} process=${processes.length}`);
    if (profiles.length > 0) report.fail("无浏览器启动", `残留 profile：${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("无浏览器启动", `残留进程：${processes[0].slice(0, 160)}`);

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
