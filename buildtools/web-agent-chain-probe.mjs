#!/usr/bin/env node
/**
 * Web Agent 全链路探针：对真实运行中的 Web 服务驱动完整 Agent 对话并断言。
 *
 * 用法：
 *   node buildtools/web-agent-chain-probe.mjs <baseUrl> <credential>
 *
 * 覆盖场景（每个场景独立计数，全部通过时退出码为 0）：
 *   1. full-chain：合成材料上传 → 工程创建 → Agent 附件上传 → 发消息 →
 *      `workspace_run` 工具条目成功 → `pending_decision`（write_approval）→
 *      `allow_once` 放行 → 助手正文条目 → `chat_status` 回到 idle；
 *   2. cancel：发消息后立即停止，断言状态进入 stopping/idle 且服务不悬挂；
 *   3. reconnect：SSE 中途 abort 后重连，断言恢复快照 revision 连续、已提交条目不丢。
 *
 * 断言全部基于真实 API 契约（`src/backend/api/api-routes.ts`、`src/shared/agent.ts`），
 * 失败时打印实际收到的 SSE 事件摘要，便于定位是服务、模型还是工作区问题。
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const AGENT_CHAT_EVENT_TOPIC = "agent.chat_event"; // 与 src/shared/agent.ts 共用同一 topic
const WRITE_APPROVAL_DECISION = "allow_once"; // 只放行本批，不改变应用审批偏好

const HTTP_TIMEOUT_MS = 30_000; // 普通 REST 调用预算
const CHAIN_STEP_TIMEOUT_MS = 120_000; // workspace_run 会 fork 真实 Node 子进程，留足余量
const IDLE_STEP_TIMEOUT_MS = 90_000; // 等待回合结束回到 idle
const CANCEL_STEP_TIMEOUT_MS = 60_000; // 停止后必须在该预算内回到 idle
const TOTAL_BUDGET_MS = Number(process.env["AGENT_CHAIN_PROBE_BUDGET_MS"] ?? 600_000);
const POLL_INTERVAL_MS = 50;
const DIAGNOSTIC_EVENT_LIMIT = 25; // 失败时打印的最近 SSE 事件条数

const MATERIAL_NAME = "agent-chain-probe.txt";
const ATTACHMENT_NAME = "agent-chain-notes.txt";
const MATERIAL_TEXT = [
  "合成探针材料第一行，用于验证 Web 材料上传与工程创建契约。",
  "合成探针材料第二行，不依赖工程已有条目。",
].join("\n");
const ATTACHMENT_TEXT = "Agent 全链路探针附件：合成备注，不参与工程写入。";
const FIRST_MESSAGE_TEXT = "请为工程补充一条合成术语，并提交写入申请。";

class ProbeFailure extends Error {}

/** 停止落在 `workspace_apply` 等待期时服务按 runtime.busy 拒绝，调用方需要区分该竞争。 */
function is_busy_error(error) {
  return error instanceof ProbeFailure && error.payload?.error?.code === "runtime.busy";
}

/** 记录场景结果；每个场景独立计数，互不影响后续场景。 */
class ProbeReport {
  constructor() {
    this.results = [];
  }

  pass(scenario, detail) {
    this.results.push({ scenario, ok: true, detail });
    process.stdout.write(`PASS ${scenario}${detail === undefined ? "" : `：${detail}`}\n`);
  }

  fail(scenario, reason) {
    this.results.push({ scenario, ok: false, reason: String(reason) });
    process.stdout.write(`FAIL ${scenario}: ${String(reason)}\n`);
  }

  get failed_count() {
    return this.results.filter((result) => !result.ok).length;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 统一读取剩余预算，任何一步都不会超过探针总时长。 */
function remaining_budget(deadline) {
  return Math.max(0, deadline - Date.now());
}

function step_timeout(deadline, step_ms) {
  return Math.min(step_ms, remaining_budget(deadline));
}

/**
 * `agent.chat_event` 订阅者：解析 SSE 帧并维护当前会话事实。
 * 快照与增量共用同一份 entries / state / pendingDecision 视图，等待条件直接查询。
 */
class AgentChatEventCollector {
  constructor({ baseUrl, cookie }) {
    this.baseUrl = baseUrl;
    this.cookie = cookie;
    this.entries = new Map();
    this.state = "unknown";
    this.pending_decision = null;
    this.snapshot_revision = null;
    this.max_revision = 0;
    this.revision_gaps = [];
    this.events = [];
    this.connection_generation = 0;
    this.closed = false;
    this.close_reason = null;
    this.abort_controller = null;
    this.snapshot_seed_count = 0;
    this.state_history = [];
    this.upserted_entries = [];
  }

  async connect() {
    this.connection_generation += 1;
    const generation = this.connection_generation;
    this.closed = false;
    this.close_reason = null;
    this.abort_controller = new AbortController();
    try {
      const response = await fetch(`${this.baseUrl}/api/events/stream`, {
        headers: { cookie: this.cookie },
        signal: this.abort_controller.signal,
      });
      if (!response.ok || response.body === null)
        throw new ProbeFailure(`SSE subscription failed: HTTP ${response.status}`);
      process.stdout.write(`[probe] SSE 已订阅（第 ${generation} 代连接）\n`);
      void this.read_loop(response.body, generation);
    } catch (error) {
      // 订阅失败也让等待条件快速失败，而不是耗满超时预算。
      this.closed = true;
      this.close_reason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** 读取循环独立运行；连接关闭只影响等待条件，不抛到调用栈。 */
  async read_loop(body, generation) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (generation === this.connection_generation) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) this.receive_frame(frame);
      }
    } catch (error) {
      // abort 与网络中断都走同一条路径：标记关闭让等待条件快速失败。
      this.close_reason = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.connection_generation) this.closed = true;
      reader.releaseLock();
    }
  }

  receive_frame(frame) {
    const event_line = frame.split("\n").find((line) => line.startsWith("event: "));
    const data_line = frame.split("\n").find((line) => line.startsWith("data: "));
    // keepalive 注释帧没有 data 行，直接跳过。
    if (event_line === undefined || data_line === undefined) return;
    if (event_line.slice("event: ".length).trim() !== AGENT_CHAT_EVENT_TOPIC) return;
    let payload;
    try {
      payload = JSON.parse(data_line.slice("data: ".length));
    } catch (error) {
      throw new ProbeFailure(`SSE data frame parse failed: ${String(error)}`);
    }
    this.receive(payload);
  }

  receive(payload) {
    const revision = Number(payload["revision"]);
    if (Number.isFinite(revision)) {
      if (revision < this.max_revision) this.revision_gaps.push(revision);
      this.max_revision = Math.max(this.max_revision, revision);
    }
    if (payload["type"] === "snapshot_seed") {
      this.snapshot_seed_count += 1;
      const snapshot = payload["snapshot"] ?? {};
      this.apply_snapshot(snapshot);
    } else if (payload["type"] === "chat_update") {
      for (const change of Array.isArray(payload["changes"]) ? payload["changes"] : [])
        this.apply_change(change);
    }
    this.events.push(payload);
    if (this.events.length > DIAGNOSTIC_EVENT_LIMIT * 4) this.events.shift();
  }

  apply_snapshot(snapshot) {
    this.snapshot_revision = Number(snapshot["revision"] ?? this.snapshot_revision);
    this.state = String(snapshot["state"] ?? this.state);
    this.state_history.push(this.state);
    this.pending_decision = snapshot["pendingDecision"] ?? null;
    this.entries = new Map();
    for (const entry of Array.isArray(snapshot["entries"]) ? snapshot["entries"] : [])
      this.entries.set(entry["id"], entry);
  }

  apply_change(change) {
    switch (change["type"]) {
      case "entry_upsert":
        this.entries.set(change["entry"]["id"], change["entry"]);
        this.upserted_entries.push({
          id: change["entry"]["id"],
          kind: change["entry"]["kind"],
          toolName: change["entry"]["toolName"] ?? null,
        });
        break;
      case "chat_status":
        this.state = String(change["state"]);
        this.state_history.push(this.state);
        break;
      case "pending_decision":
        this.pending_decision = change["pendingDecision"];
        break;
      default:
        // 其余变化不影响本探针断言。
        break;
    }
  }

  abort() {
    this.connection_generation += 1;
    this.closed = true;
    this.close_reason = "探针主动断开";
    this.abort_controller?.abort();
    this.abort_controller = null;
  }

  /** 等待条件成立；谓词返回 null 表示尚未满足，超时与断连都快速失败。 */
  async wait_for(predicate, timeout_ms, label) {
    const deadline = Date.now() + timeout_ms;
    for (;;) {
      const value = predicate();
      if (value !== null && value !== undefined && value !== false) return value;
      if (this.closed)
        throw new ProbeFailure(
          `${label}: SSE connection closed${this.close_reason === null ? "" : ` (${this.close_reason})`}`,
        );
      if (Date.now() >= deadline)
        throw new ProbeFailure(`${label}: wait timed out after ${timeout_ms}ms`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** 等待一次新的快照种子；reset 后据此确认条目视图已清空，避免陈旧条目干扰断言。 */
  async wait_for_snapshot_seed(after_count, timeout_ms, label) {
    return await this.wait_for(
      () => (this.snapshot_seed_count > after_count ? this.snapshot_seed_count : null),
      timeout_ms,
      label,
    );
  }

  find_tool_entry(tool_name) {
    for (const entry of this.entries.values())
      if (entry["kind"] === "tool_call" && entry["toolName"] === tool_name) return entry;
    return null;
  }

  find_assistant_text() {
    for (const entry of this.entries.values()) {
      if (entry["kind"] !== "assistant_message") continue;
      const parts = Array.isArray(entry["parts"]) ? entry["parts"] : [];
      if (parts.some((part) => part["kind"] === "text" && part["text"].trim() !== "")) return entry;
    }
    return null;
  }

  /** 失败诊断：只打印最近事件的形状摘要，避免刷屏。 */
  diagnostic_summary() {
    return this.events
      .slice(-DIAGNOSTIC_EVENT_LIMIT)
      .map((event) => {
        if (event["type"] === "snapshot_seed")
          return `  rev=${event["revision"]} snapshot_seed state=${event["snapshot"]?.["state"]} entries=${(event["snapshot"]?.["entries"] ?? []).length}`;
        const changes = (event["changes"] ?? []).map((change) => {
          if (change["type"] === "entry_upsert") {
            const entry = change["entry"];
            return `entry_upsert(${entry["kind"]}${entry["toolName"] ? `:${entry["toolName"]}` : ""},${entry["status"]})`;
          }
          if (change["type"] === "pending_decision")
            return `pending_decision(${change["pendingDecision"]?.["kind"] ?? "null"})`;
          if (change["type"] === "chat_status") return `chat_status(${change["state"]})`;
          return `${change["type"]}`;
        });
        return `  rev=${event["revision"]} chat_update [${changes.join(" ")}]`;
      })
      .join("\n");
  }
}

/** 与 Web 服务对话的最小 HTTP 客户端：统一 Cookie、超时与错误壳解析。 */
class WebProbeClient {
  constructor({ baseUrl, credential }) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.credential = credential;
    this.cookie = "";
  }

  async establish_session() {
    const response = await fetch(`${this.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: this.credential }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.status !== 204)
      throw new ProbeFailure(
        `Web session establish failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    const set_cookie = response.headers.get("set-cookie") ?? "";
    this.cookie = set_cookie.split(";")[0] ?? "";
    if (this.cookie === "")
      throw new ProbeFailure("Web session establish failed: no session cookie");
  }

  async post_json(route, body = {}) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (response.status !== 200 || payload === null || payload["ok"] !== true) {
      // 错误壳随异常透出，调用方可按 code 区分竞争与真实失败。
      const error = new ProbeFailure(
        `${route} failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
      );
      error.payload = payload;
      throw error;
    }
    return payload["data"];
  }

  async get_json(route) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      headers: { cookie: this.cookie },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (response.status !== 200 || payload === null || payload["ok"] !== true)
      throw new ProbeFailure(
        `${route} failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
      );
    return payload["data"];
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

  async send_agent_message(chat_id, text, attachments) {
    return await this.post_json("/api/agent/message", {
      chatId: chat_id,
      commandId: randomUUID(),
      text,
      attachments,
    });
  }
}

/** 读取当前会话身份；工程切换与 reset 都会改变 chatId。 */
async function read_chat_id(client) {
  const snapshot = await client.get_json("/api/agent/snapshot");
  const chat_id = String(snapshot["chatId"] ?? "");
  if (chat_id === "" || chat_id === "inactive")
    throw new ProbeFailure("Agent chat is not active: chatId is empty or inactive");
  return chat_id;
}

/** 上传合成材料并按真实材料契约创建工程。 */
async function create_project_with_material(client) {
  const material = await client.upload("/api/web/files/upload", MATERIAL_NAME, MATERIAL_TEXT);
  const material_id = String(material["material_id"] ?? "");
  if (material_id === "") throw new ProbeFailure("material upload did not return material_id");
  process.stdout.write(`[probe] 材料已暂存 material_id=${material_id} size=${material["size"]}\n`);

  const project_path = path.join(
    os.tmpdir(),
    "agent-chain-probe",
    `probe-${Date.now().toString()}.lg`,
  );
  const project = await client.post_json("/api/session/project/create", {
    path: project_path,
    material_ids: [material_id],
  });
  if (project["project"]?.["loaded"] !== true)
    throw new ProbeFailure("project create did not reach the loaded state");
  process.stdout.write(`[probe] 工程已创建 ${project_path}\n`);
  return project_path;
}

/**
 * 场景一：完整工具循环。材料上传、脚本执行、写入审批与助手正文依次断言。
 */
async function run_full_chain_scenario({ client, collector, deadline, attachment_upload_id }) {
  const chat_id = await read_chat_id(client);
  process.stdout.write(`[probe] 会话 chatId=${chat_id}\n`);

  const settings = await client.post_json("/api/settings/app");
  const approval_mode = String(settings["settings"]?.["agent_approval_mode"] ?? "");
  if (approval_mode !== "manual")
    // auto 模式不会产生 pending_decision，写入审批断言无法成立，提前给出明确原因。
    throw new ProbeFailure(
      `approval mode is ${approval_mode || "unknown"}; manual is required to assert pending_decision`,
    );

  const ack = await client.send_agent_message(chat_id, FIRST_MESSAGE_TEXT, [
    { kind: "file", uploadId: attachment_upload_id },
  ]);
  if (typeof ack["revision"] !== "number")
    throw new ProbeFailure(`message was not accepted: ${JSON.stringify(ack)}`);
  process.stdout.write(`[probe] 消息已受理 revision=${ack["revision"]} status=${ack["status"]}\n`);

  const run_entry = await collector.wait_for(
    () => {
      const entry = collector.find_tool_entry("workspace_run");
      return entry !== null && entry["status"] === "success" ? entry : null;
    },
    step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
    "workspace_run tool entry reached success",
  );
  if (
    !collector.upserted_entries.some(
      (upsert) => upsert.kind === "tool_call" && upsert.toolName === "workspace_run",
    )
  )
    throw new ProbeFailure("no entry_upsert event for the workspace_run tool call");
  const run_output = Array.isArray(run_entry["output"]) ? run_entry["output"].join("") : "";
  process.stdout.write(`[probe] workspace_run 成功：${run_output.slice(0, 120)}\n`);

  const pending = await collector.wait_for(
    () =>
      collector.pending_decision !== null && collector.pending_decision["kind"] === "write_approval"
        ? collector.pending_decision
        : null,
    step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
    "pending_decision (write_approval)",
  );
  const pending_id = String(pending["id"] ?? "");
  if (pending_id === "") throw new ProbeFailure("pending_decision is missing an id");
  process.stdout.write(
    `[probe] 收到写入审批请求 id=${pending_id} glossary=${pending["summary"]?.["glossary"]}\n`,
  );

  await client.post_json("/api/agent/write-approval/resolve", {
    id: pending_id,
    decision: WRITE_APPROVAL_DECISION,
  });

  // 放行后变更必须真正提交：workspace_apply 条目到达 success 才继续。
  const apply_entry = await collector.wait_for(
    () => {
      const entry = collector.find_tool_entry("workspace_apply");
      return entry !== null && entry["status"] === "success" ? entry : null;
    },
    step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
    "workspace_apply tool entry reached success",
  );
  const apply_output = Array.isArray(apply_entry["output"]) ? apply_entry["output"].join("") : "";
  process.stdout.write(`[probe] workspace_apply 成功：${apply_output.slice(0, 120)}\n`);

  const assistant_entry = await collector.wait_for(
    () => collector.find_assistant_text(),
    step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
    "assistant text entry",
  );
  const assistant_text = (assistant_entry["parts"] ?? [])
    .filter((part) => part["kind"] === "text")
    .map((part) => part["text"])
    .join("");
  process.stdout.write(`[probe] 助手正文：${assistant_text.slice(0, 80)}\n`);

  await collector.wait_for(
    () => (collector.state === "idle" ? collector.state : null),
    step_timeout(deadline, IDLE_STEP_TIMEOUT_MS),
    "chat_status returned to idle",
  );
  if (collector.revision_gaps.length > 0)
    throw new ProbeFailure(`SSE revision moved backwards: ${collector.revision_gaps.join(",")}`);
  return `workspace_run 成功、写入审批已放行、助手正文 ${assistant_text.length} 字、状态回到 idle`;
}

/**
 * 重置 Agent 会话并等待快照种子到达。重置会更换 chatId 并清空时间线，
 * 后续场景因此都从空的工具轮次开始，mock 脚本顺序保持确定。
 */
async function reset_agent_chat({ client, collector, deadline }) {
  const seed_before = collector.snapshot_seed_count;
  await client.post_json("/api/agent/reset", {});
  const chat_id = await read_chat_id(client);
  await collector.wait_for_snapshot_seed(
    seed_before,
    step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
    "snapshot seed after reset",
  );
  return chat_id;
}

/**
 * 场景二：取消。先重置会话让下一轮重新执行 workspace_run（真实子进程，
 * 停止窗口稳定），发消息后立即停止，断言状态进入 stopping/idle 且服务不悬挂。
 */
async function run_cancel_scenario({ client, collector, deadline }) {
  const chat_id = await reset_agent_chat({ client, collector, deadline });
  process.stdout.write(`[probe] 取消场景会话 chatId=${chat_id}\n`);

  const history_before = collector.state_history.length;
  await client.send_agent_message(chat_id, "请再执行一次工作区脚本，随后立即停止。", []);
  // 停止与发送几乎同时发出：执行可能尚未开始，此时停止按空操作返回。
  let stop_note = "";
  try {
    await client.post_json("/api/agent/stop", {});
  } catch (error) {
    if (!is_busy_error(error)) throw error;
    // 停止恰好落在 workspace_apply 等待审批期：按拒绝收尾，避免把时序竞争当成悬挂。
    const pending = await collector.wait_for(
      () =>
        collector.pending_decision !== null &&
        collector.pending_decision["kind"] === "write_approval"
          ? collector.pending_decision
          : null,
      step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
      "pending_decision (write_approval)",
    );
    await client.post_json("/api/agent/write-approval/resolve", {
      id: String(pending["id"] ?? ""),
      decision: "reject",
    });
    stop_note = "（停止时 apply 正在等待审批，已按拒绝收尾）";
  }

  await collector.wait_for(
    () => (collector.state === "idle" ? collector.state : null),
    step_timeout(deadline, CANCEL_STEP_TIMEOUT_MS),
    "state returned to idle after stop",
  );
  const states_during = collector.state_history.slice(history_before);
  if (!states_during.some((state) => state === "stopping" || state === "idle"))
    throw new ProbeFailure(`no stopping/idle observed after stop: ${states_during.join(",")}`);
  const stopped_entries = [...collector.entries.values()].filter(
    (entry) => entry["status"] === "stopped",
  ).length;
  // 服务仍可查询即证明无悬挂；快照状态必须与事件视图一致。
  const snapshot = await client.get_json("/api/agent/snapshot");
  if (snapshot["state"] !== "idle")
    throw new ProbeFailure(`snapshot state did not return to idle: ${snapshot["state"]}`);
  const observed_stopping = states_during.includes("stopping");
  return `状态收敛到 idle${observed_stopping ? "（期间经过 stopping）" : "（回合在停止前已结束）"}${stop_note}，stopped 条目 ${stopped_entries} 个，快照与事件视图一致`;
}

/**
 * 场景三：断线重连。在工具执行期间 abort SSE，重连后按恢复快照核对
 * revision 连续性与已提交条目，再让当前回合在新连接上跑完。
 */
async function run_reconnect_scenario({ client, collector, deadline }) {
  // 独立工程保证合成术语仍可创建，避免前一场景的同名术语让写入被拒绝而跳过审批。
  await create_project_with_material(client);
  const chat_id = await reset_agent_chat({ client, collector, deadline });

  await client.send_agent_message(chat_id, "请执行工作区脚本，本次会在执行中途断开连接。", []);
  await collector.wait_for(
    () => collector.find_tool_entry("workspace_run"),
    step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
    "workspace_run entry appeared",
  );

  const revision_before = collector.max_revision;
  const entries_before = new Set(collector.entries.keys());
  process.stdout.write(
    `[probe] 断开前 revision=${revision_before} 已提交条目=${entries_before.size}\n`,
  );

  collector.abort();
  await collector.connect();

  // 重连后的恢复路径：先读完整快照，再核对连续性。
  const snapshot = await client.get_json("/api/agent/snapshot");
  const snapshot_revision = Number(snapshot["revision"]);
  if (!(snapshot_revision >= revision_before))
    throw new ProbeFailure(
      `restored snapshot revision ${snapshot_revision} is older than ${revision_before}`,
    );
  const restored_ids = new Set((snapshot["entries"] ?? []).map((entry) => entry["id"]));
  const missing = [...entries_before].filter((id) => !restored_ids.has(id));
  if (missing.length > 0)
    throw new ProbeFailure(`restored snapshot lost committed entries: ${missing.join(",")}`);
  process.stdout.write(
    `[probe] 恢复快照 revision=${snapshot_revision} 条目=${restored_ids.size}\n`,
  );

  // 与 renderer 的恢复语义一致：快照事实先落到本地视图，再继续消费增量。
  collector.apply_snapshot(snapshot);
  collector.max_revision = Math.max(collector.max_revision, snapshot_revision);
  const settled_from_snapshot =
    collector.state === "idle" && collector.find_assistant_text() !== null;

  if (!settled_from_snapshot) {
    // 重连后放行写入审批，当前回合才能在新连接上跑完。
    const pending_after_reconnect =
      collector.pending_decision !== null && collector.pending_decision["kind"] === "write_approval"
        ? collector.pending_decision
        : await collector.wait_for(
            () =>
              collector.pending_decision !== null &&
              collector.pending_decision["kind"] === "write_approval"
                ? collector.pending_decision
                : null,
            step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
            "pending_decision (write_approval) after reconnect",
          );
    await client.post_json("/api/agent/write-approval/resolve", {
      id: String(pending_after_reconnect["id"] ?? ""),
      decision: WRITE_APPROVAL_DECISION,
    });
  }

  const assistant_entry = settled_from_snapshot
    ? collector.find_assistant_text()
    : await collector.wait_for(
        () => collector.find_assistant_text(),
        step_timeout(deadline, CHAIN_STEP_TIMEOUT_MS),
        "assistant text entry after reconnect",
      );
  if (!settled_from_snapshot)
    await collector.wait_for(
      () => (collector.state === "idle" ? collector.state : null),
      step_timeout(deadline, IDLE_STEP_TIMEOUT_MS),
      "state returned to idle after reconnect",
    );
  const events_after = collector.events.filter(
    (event) => Number(event["revision"]) > snapshot_revision,
  );
  if (events_after.length === 0) {
    // 断开期间回合已结束时没有新事件，恢复快照必须已包含收敛后的事实。
    if (!settled_from_snapshot)
      throw new ProbeFailure("neither new events nor a settled snapshot after reconnect");
  } else {
    const revisions_after = events_after.map((event) => Number(event["revision"]));
    const increasing = revisions_after.every(
      (revision, index) => index === 0 || revision > revisions_after[index - 1],
    );
    if (!increasing)
      throw new ProbeFailure(
        `revisions after reconnect are not strictly increasing: ${revisions_after.join(",")}`,
      );
  }
  if (collector.revision_gaps.length > 0)
    throw new ProbeFailure(`SSE revision moved backwards: ${collector.revision_gaps.join(",")}`);
  const assistant_text = (assistant_entry["parts"] ?? [])
    .filter((part) => part["kind"] === "text")
    .map((part) => part["text"])
    .join("");
  return `断开前 revision=${revision_before} → 恢复 ${snapshot_revision}，条目 ${entries_before.size} 个全部保留，新事件 ${events_after.length} 条${events_after.length === 0 ? "（断开期间已收敛）" : "严格递增"}，助手正文 ${assistant_text.length} 字`;
}

async function main() {
  const [base_url, credential] = process.argv.slice(2);
  if (base_url === undefined || credential === undefined || credential === "") {
    process.stderr.write(
      "用法：node buildtools/web-agent-chain-probe.mjs <baseUrl> <credential>\n",
    );
    return 2;
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const report = new ProbeReport();
  const client = new WebProbeClient({ baseUrl: base_url, credential });

  try {
    await client.establish_session();
    process.stdout.write(`[probe] 会话已建立 baseUrl=${client.baseUrl}\n`);
    await create_project_with_material(client);
    const attachment = await client.upload("/api/agent/uploads", ATTACHMENT_NAME, ATTACHMENT_TEXT);
    const attachment_upload_id = String(attachment["uploadId"] ?? "");
    if (attachment_upload_id === "")
      throw new ProbeFailure("agent attachment upload did not return uploadId");
    process.stdout.write(`[probe] Agent 附件已上传 uploadId=${attachment_upload_id}\n`);

    const collector = new AgentChatEventCollector({
      baseUrl: client.baseUrl,
      cookie: client.cookie,
    });
    await collector.connect();

    const scenarios = [
      [
        "full-chain",
        () =>
          run_full_chain_scenario({
            client,
            collector,
            deadline,
            attachment_upload_id,
          }),
      ],
      ["cancel", () => run_cancel_scenario({ client, collector, deadline })],
      ["reconnect", () => run_reconnect_scenario({ client, collector, deadline })],
    ];
    for (const [scenario, run] of scenarios) {
      try {
        const detail = await run();
        report.pass(scenario, detail);
      } catch (error) {
        report.fail(scenario, error instanceof Error ? error.message : String(error));
        process.stdout.write("[probe] 最近 SSE 事件摘要：\n");
        process.stdout.write(`${collector.diagnostic_summary()}\n`);
        process.stdout.write(
          `[probe] 当前视图：state=${collector.state} entries=${collector.entries.size} pending=${JSON.stringify(collector.pending_decision)}\n`,
        );
      }
    }
    collector.abort();
  } catch (error) {
    report.fail("setup", error instanceof Error ? error.message : String(error));
  }

  process.stdout.write("---- 汇总 ----\n");
  for (const result of report.results)
    process.stdout.write(
      `${result.ok ? "PASS" : "FAIL"} ${result.scenario}${result.ok ? "" : `: ${result.reason}`}\n`,
    );
  process.stdout.write(
    `通过 ${report.results.length - report.failed_count}/${report.results.length}\n`,
  );
  return report.failed_count === 0 ? 0 : 1;
}

process.exitCode = await main();
