#!/usr/bin/env node
/**
 * 同数据根第二实例提示验证（R-13 决策 B）。
 *
 * 前置条件：无；脚本自行构建 Web 产物到临时目录。
 *
 * 覆盖内容：
 *   1. 单实例启动：`/api/web/bootstrap` 的 `anotherInstance` 为 null，数据根标记记录本实例；
 *   2. 第二实例启动：不被阻止（健康检查可用），bootstrap 报告另一实例的 pid 与端口，
 *      启动输出包含醒目警告，且本实例停止不删除他人标记；
 *   3. 第一实例停止后标记被删除，第二实例见到的是干净数据根；
 *   4. 陈旧标记（所属进程已停止）被重建而非误报为第二实例。
 *
 * 用法：
 *   node buildtools/web-instance-conflict-verify.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_WEB_SCRIPT = path.join(PROJECT_ROOT, "buildtools", "build-web.mjs");
const INSTANCE_MARKER_FILE_NAME = "web-instance.json";

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 30_000;
const WARNING_PATTERN = /同一数据根已有另一个实例在运行/u;

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
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
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

/** 一次性凭据换取会话 Cookie，后续 API 与 bootstrap 查询都依赖它。 */
async function create_session(baseUrl, credential) {
  const session = await fetch(`${baseUrl}/api/web/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const set_cookie = session.headers.get("set-cookie") ?? "";
  const cookie = set_cookie.split(";")[0] ?? "";
  if (session.status !== 204 || cookie === "")
    throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
  return cookie;
}

async function read_bootstrap(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/web/bootstrap`, {
    headers: { cookie },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const payload = await response.json();
  const envelope =
    payload !== null && typeof payload === "object" && "data" in payload
      ? payload["data"]
      : payload;
  return envelope ?? {};
}

/** 启动一个服务实例并完成访问会话，返回进程句柄与访问事实。 */
async function start_instance(build_dir, data_root, label) {
  const service = new WebServiceProcess(
    spawn(
      process.execPath,
      [path.join(build_dir, "index.mjs"), "--port=0", `--data-root=${data_root}`],
      {
        cwd: path.dirname(build_dir),
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const access = await wait_for(
    () => service.read_access(),
    SERVICE_START_TIMEOUT_MS,
    `${label} 打印访问地址`,
  );
  const cookie = await create_session(access.baseUrl, access.credential);
  return { service, access, cookie };
}

function read_instance_marker(data_root) {
  const marker_path = path.join(data_root, INSTANCE_MARKER_FILE_NAME);
  if (!existsSync(marker_path)) return null;
  try {
    return JSON.parse(readFileSync(marker_path, "utf8"));
  } catch {
    return null;
  }
}

/** 取一个确定已退出的进程 PID，用于构造陈旧标记。 */
async function create_dead_pid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new VerifyFailure("failed to capture short-lived process pid");
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-instance-conflict-"));
  const data_root = path.join(artifacts, "data-root");
  const build_dir = path.join(artifacts, "build-web");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  build_web(build_dir);

  let first = null;
  let second = null;
  let third = null;
  try {
    // 1) 单实例：无冲突事实，标记记录本实例。
    first = await start_instance(build_dir, data_root, "第一实例");
    const first_bootstrap = await read_bootstrap(first.access.baseUrl, first.cookie);
    const first_another = first_bootstrap["anotherInstance"] ?? null;
    report.pass("单实例无冲突事实", JSON.stringify(first_another));
    if (first_another !== null)
      report.fail(
        "单实例无冲突事实",
        `anotherInstance 应为 null，实际 ${JSON.stringify(first_another)}`,
      );

    const marker = read_instance_marker(data_root);
    report.pass("实例标记落盘", marker === null ? "缺失" : `pid=${marker.pid} port=${marker.port}`);
    if (marker === null || marker.pid !== first.service.child.pid)
      report.fail("实例标记落盘", `标记 pid=${marker?.pid} 应为 ${first.service.child.pid}`);

    // 2) 第二实例：不被阻止，报告另一实例事实并打印警告。
    second = await start_instance(build_dir, data_root, "第二实例");
    const health = await fetch(`${second.access.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    report.pass("第二实例可启动", `健康检查 HTTP ${health.status}`);
    if (health.status !== 200) report.fail("第二实例可启动", `健康检查 HTTP ${health.status}`);

    const second_bootstrap = await read_bootstrap(second.access.baseUrl, second.cookie);
    const another = second_bootstrap["anotherInstance"] ?? null;
    report.pass("bootstrap 报告另一实例", JSON.stringify(another));
    if (another === null || typeof another !== "object")
      report.fail("bootstrap 报告另一实例", "anotherInstance 缺失");
    else {
      if (another["pid"] !== first.service.child.pid)
        report.fail(
          "bootstrap 报告另一实例",
          `pid=${another["pid"]} 期望 ${first.service.child.pid}`,
        );
      const first_port = Number(new URL(first.access.baseUrl).port);
      if (another["port"] !== first_port)
        report.fail("bootstrap 报告另一实例", `port=${another["port"]} 期望 ${first_port}`);
    }

    const warned = WARNING_PATTERN.test(second.service.stdout);
    report.pass("启动输出警告", warned ? "已打印另一实例警告" : "未出现警告");
    if (!warned) report.fail("启动输出警告", "第二实例启动输出中没有多实例警告");

    // 3) 第二实例停止不删他人标记；第一实例停止后标记删除。
    await second.service.stop();
    const marker_after_second = read_instance_marker(data_root);
    report.pass(
      "第二实例停止不删他人标记",
      marker_after_second === null ? "标记缺失" : `pid=${marker_after_second.pid}`,
    );
    if (marker_after_second === null || marker_after_second.pid !== first.service.child.pid)
      report.fail("第二实例停止不删他人标记", "第一实例的标记被第二实例删除或丢失");

    const first_bootstrap_again = await read_bootstrap(first.access.baseUrl, first.cookie);
    if ((first_bootstrap_again["anotherInstance"] ?? null) !== null)
      report.fail("第一实例视图", "第一实例不应看到冲突事实");
    else report.pass("第一实例视图", "仍为单实例事实");

    await first.service.stop();
    const marker_after_first = read_instance_marker(data_root);
    report.pass("第一实例停止后删除标记", marker_after_first === null ? "已删除" : "仍存在");
    if (marker_after_first !== null)
      report.fail("第一实例停止后删除标记", "标记未随第一实例停止删除");

    // 4) 陈旧标记：所属进程已退出，按重建处理而不误报。
    const dead_pid = await create_dead_pid();
    writeFileSync(
      path.join(data_root, INSTANCE_MARKER_FILE_NAME),
      JSON.stringify({ pid: dead_pid, port: 1, started_at: "2026-10-18T00:00:00.000Z" }),
      "utf8",
    );
    third = await start_instance(build_dir, data_root, "陈旧标记实例");
    const third_bootstrap = await read_bootstrap(third.access.baseUrl, third.cookie);
    const third_another = third_bootstrap["anotherInstance"] ?? null;
    report.pass("陈旧标记不误报", JSON.stringify(third_another));
    if (third_another !== null)
      report.fail(
        "陈旧标记不误报",
        `已停止进程的标记被当成第二实例：${JSON.stringify(third_another)}`,
      );
    const rebuilt = read_instance_marker(data_root);
    report.pass("陈旧标记重建", rebuilt === null ? "缺失" : `pid=${rebuilt.pid}`);
    if (rebuilt === null || rebuilt.pid !== third.service.child.pid)
      report.fail("陈旧标记重建", "标记未重建为本实例");
    await third.service.stop();
    third = null;
    if (read_instance_marker(data_root) !== null)
      report.fail("收尾清理", "陈旧标记实例停止后标记未删除");
    else report.pass("收尾清理", "标记已删除");
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
  } finally {
    await second?.service.stop();
    await first?.service.stop();
    await third?.service.stop();
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
