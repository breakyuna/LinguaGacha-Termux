#!/usr/bin/env node
/**
 * 同数据根多实例场景验证（R-13 / TW-02）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`。
 *
 * 覆盖内容：
 *   1. 同一数据根启动两个实例（不同端口），都能建立访问会话；
 *   2. A 建小说工程（两个 TXT 源文件）；
 *   3. B 打开同一工程并读清单：跨进程可见 A 已提交的事实；
 *   4. A 删除一个文件（携带 A 的预期修订）→ 成功；
 *   5. B 用过期修订删除另一个文件 → 预期 `data.revision_conflict`：
 *      跨进程冲突在数据库事务内被检测，不会静默覆盖；
 *   6. B 重读清单后用新修订删除 → 成功；
 *   7. 终态核对：两实例读到的文件与条目数一致，工程副本可生成（数据库未损坏）；
 *   8. 停止 A 后 B 仍可读；随后停止 B，退出码均为 0。
 *
 * 结论用于回答 R-13：同数据根多开是否需要单写入口锁。
 *
 * 用法：
 *   node buildtools/web-multi-instance-verify.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 60_000;

const SOURCE_FILES = [
  ["multi-a.txt", "第一份小说正文。\n主角走进城门。\n"],
  ["multi-b.txt", "第二份小说正文。\n夜色降临。\n"],
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

  async upload(name, bytes) {
    return await this.data("POST", `/api/web/files/upload?name=${encodeURIComponent(name)}`, {
      body: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  async post(route, payload) {
    return await this.data("POST", route, {
      body: JSON.stringify(payload ?? {}),
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** 读取当前加载工程的清单事实（文件数、条目数与分区修订）。 */
async function read_manifest(client) {
  const manifest = await client.post("/api/session/project/manifest", {});
  return {
    files: Number(manifest?.["counts"]?.["files"] ?? -1),
    items: Number(manifest?.["counts"]?.["items"] ?? -1),
    section_revisions: manifest?.["sectionRevisions"] ?? {},
  };
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
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-multi-instance-"));
  const data_root = path.join(artifacts, "data-root"); // 两个实例共享同一数据根
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);
  process.stdout.write(`[verify] 共享数据根 ${data_root}\n`);

  const spawn_service = (label) =>
    new WebServiceProcess(
      spawn(process.execPath, [WEB_SERVER_ENTRY, "--port=0", `--data-root=${data_root}`], {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      label,
    );

  const service_a = spawn_service("实例 A");
  let service_b = null;
  let client_a = null;
  let client_b = null;
  const project_path = path.join(artifacts, "projects", "multi.lg");

  /** 建立访问会话，返回 API 客户端。 */
  const connect = async (service, label) => {
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
  };

  try {
    client_a = await connect(service_a, "实例 A");
    service_b = spawn_service("实例 B");
    client_b = await connect(service_b, "实例 B");
    report.pass("同数据根双实例启动", "两个实例均就绪且会话独立");

    // A 上传两个小说源文件并建工程。
    const staged = [];
    for (const [name, text] of SOURCE_FILES) {
      const material = await client_a.upload(name, Buffer.from(text, "utf8"));
      staged.push(String(material?.["material_id"] ?? ""));
    }
    if (staged.some((id) => id === ""))
      throw new VerifyFailure("incomplete staged materials for A");
    mkdirSync(path.dirname(project_path), { recursive: true });
    await client_a.post("/api/session/project/create", {
      path: project_path,
      material_ids: staged,
    });
    const manifest_a = await read_manifest(client_a);
    report.pass("A 建工程", `files=${manifest_a.files} items=${manifest_a.items}`);
    if (manifest_a.files !== SOURCE_FILES.length)
      report.fail("A 建工程", `文件数 ${manifest_a.files} 期望 ${SOURCE_FILES.length}`);

    // B 打开同一工程：跨进程读取 A 已提交的事实。
    await client_b.post("/api/session/project/open", { path: project_path });
    const manifest_b_after_open = await read_manifest(client_b);
    report.pass(
      "B 跨进程打开",
      `files=${manifest_b_after_open.files} items=${manifest_b_after_open.items}`,
    );
    if (
      manifest_b_after_open.files !== manifest_a.files ||
      manifest_b_after_open.items !== manifest_a.items
    )
      report.fail(
        "B 跨进程打开",
        `B 读到 files=${manifest_b_after_open.files} items=${manifest_b_after_open.items}，A 为 files=${manifest_a.files} items=${manifest_a.items}`,
      );

    // 工作台快照给出文件相对路径，供删除操作使用。
    const workbench = await client_b.post("/api/workbench/snapshot", {});
    const rel_paths = (workbench?.["snapshot"]?.["entries"] ?? []).map((entry) =>
      String(entry?.["rel_path"] ?? ""),
    );
    if (rel_paths.length !== SOURCE_FILES.length)
      throw new VerifyFailure(`unexpected workbench entries: ${JSON.stringify(rel_paths)}`);

    // A 携带自己的预期修订删除第一个文件。
    const delete_a = await client_a.call("POST", "/api/workbench/file/delete", {
      body: JSON.stringify({
        rel_paths: [rel_paths[0]],
        expected_section_revisions: manifest_a.section_revisions,
      }),
      headers: { "Content-Type": "application/json" },
    });
    report.pass("A 删除文件", `HTTP ${delete_a.status}`);
    if (delete_a.status < 200 || delete_a.status >= 300)
      report.fail("A 删除文件", JSON.stringify(delete_a.payload).slice(0, 200));

    // B 仍持打开时的修订：预期冲突，而不是静默覆盖 A 的提交。
    const conflict = await client_b.call("POST", "/api/workbench/file/delete", {
      body: JSON.stringify({
        rel_paths: [rel_paths[1]],
        expected_section_revisions: manifest_b_after_open.section_revisions,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const conflict_code = conflict.payload?.["error"]?.["code"] ?? conflict.payload?.["code"] ?? "";
    report.pass("B 过期修订被拒绝", `HTTP ${conflict.status} ${conflict_code}`);
    if (conflict.status !== 409 || conflict_code !== "data.revision_conflict")
      report.fail(
        "B 过期修订被拒绝",
        `期望 409 data.revision_conflict，实际 HTTP ${conflict.status} ${JSON.stringify(conflict.payload).slice(0, 200)}`,
      );

    // B 重读清单后用新修订删除：恢复路径可用。
    const manifest_b_fresh = await read_manifest(client_b);
    const retry = await client_b.call("POST", "/api/workbench/file/delete", {
      body: JSON.stringify({
        rel_paths: [rel_paths[1]],
        expected_section_revisions: manifest_b_fresh.section_revisions,
      }),
      headers: { "Content-Type": "application/json" },
    });
    report.pass("B 重读后删除", `HTTP ${retry.status}`);
    if (retry.status < 200 || retry.status >= 300)
      report.fail("B 重读后删除", JSON.stringify(retry.payload).slice(0, 200));

    // 终态一致：两实例读到相同事实，副本可生成（数据库未损坏）。
    const final_a = await read_manifest(client_a);
    const final_b = await read_manifest(client_b);
    report.pass(
      "终态一致",
      `A files=${final_a.files} items=${final_a.items}；B files=${final_b.files} items=${final_b.items}`,
    );
    if (final_a.files !== final_b.files || final_a.items !== final_b.items)
      report.fail("终态一致", "两个实例读到的工程事实不一致");
    if (final_a.files !== 0) report.fail("终态一致", `文件未全部删除：${final_a.files}`);
    const copy = await client_a.call("POST", "/api/session/project/copy", {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const copy_path = copy.payload?.["data"]?.["path"] ?? copy.payload?.["path"] ?? "";
    report.pass(
      "数据库完好",
      copy.status >= 200 && copy.status < 300 && copy_path !== ""
        ? copy_path
        : `HTTP ${copy.status}`,
    );
    if (copy.status < 200 || copy.status >= 300 || copy_path === "")
      report.fail("数据库完好", `副本失败：HTTP ${copy.status}`);

    // 停止 A 后 B 继续服务：数据根与数据库对存活实例仍可用。
    await service_a.stop();
    const after_a_stop = await read_manifest(client_b);
    report.pass("A 停止后 B 仍可读", `files=${after_a_stop.files} items=${after_a_stop.items}`);
    if (after_a_stop.files !== final_b.files) report.fail("A 停止后 B 仍可读", "读取结果发生变化");
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    for (const service of [service_a, service_b]) {
      if (service !== null && service.stderr !== "")
        process.stdout.write(`[${service.label}:err] ${service.stderr}\n`);
    }
  } finally {
    await service_a.stop();
    if (service_b !== null) await service_b.stop();
    for (const service of [service_a, service_b]) {
      if (service === null) continue;
      if (service.stderr !== "") {
        process.stdout.write(`[${service.label}:err tail]\n${service.stderr.slice(-2_000)}\n`);
      }
    }
    const exit_a = service_a.child.exitCode;
    const exit_b = service_b?.child.exitCode ?? "not-started";
    report.pass("双实例正常停止", `A=${exit_a} B=${exit_b}`);
    if (exit_a !== 0 || (service_b !== null && exit_b !== 0))
      report.fail("双实例正常停止", `A=${exit_a} B=${exit_b}`);

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
