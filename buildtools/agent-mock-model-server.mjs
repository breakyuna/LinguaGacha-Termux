#!/usr/bin/env node
/**
 * Agent 对话模拟模型服务：OpenAI Chat Completions 兼容，只使用 Node 标准库。
 *
 * 用途：驱动 LinguaGacha 文本 Agent 的完整工具循环。材料上传、受限脚本执行、工程写入
 * 审批、取消与断线重连由探针断言，本服务只按固定脚本向模型循环发出工具调用。
 *
 * 与 `buildtools/mock_llm_api_server.py` 的分工：那个服务只回填 JSONLINE 翻译文本，
 * 不发 `tool_calls`；本服务按“已发生的工具轮次”推进脚本，不猜请求内容。
 *
 * 状态机按请求 `messages` 中已执行的工具结果数量推进：
 * - 0 个工具结果：发出 `workspace_run`，脚本向 `changes/glossary/creates.jsonl`
 *   追加一条合成术语（工作区权限只允许写 `changes/**` 与 `work/**`，见
 *   `src/backend/agent/workspace/runtime/policy.ts`）；`--script host` 时脚本另输出
 *   工作区图片并请求 HTML 打印，用于验证 Chromium 图片与 PDF 宿主；
 * - 1 个工具结果：发出 `workspace_apply` 提交变更清单；
 * - 2 个及以上工具结果：只回复普通助手文本；
 * - 请求不带 `tools`（标题生成、摘要等未知请求）：回复固定普通文本，绝不挂起。
 *
 * 路由同时接受根路径与 `/v1` 前缀，与 `mock_llm_api_server.py` 的兼容行为一致；
 * 模型 `api_url` 直接配 `http://127.0.0.1:<port>`，OpenAI SDK 自行拼接
 * `/chat/completions`。
 *
 * 用法：
 *   node buildtools/agent-mock-model-server.mjs [--port 0] [--host 127.0.0.1]
 *       [--log <tmp>/agent-mock-requests.jsonl] [--delay-ms 0] [--script glossary|host]
 * 启动后向 stdout 打印 `AGENT_MOCK_LISTENING <port>`，供探针读取实际端口。
 */

import http from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MODEL_ID = "agent-mock-model";
const DEFAULT_LOG_NAME = "agent-mock-requests.jsonl";
const MAX_BODY_BYTES = 64 * 1024 * 1024; // Agent 提示词与工作区契约可达数 MB，留足余量后再拒绝
const MESSAGE_SUMMARY_CHARACTERS = 200; // 日志只保留定位所需的用户正文前缀
const ARGUMENT_SUMMARY_CHARACTERS = 120; // 工具参数摘要同样只保留前缀
const ARGUMENT_STREAM_CHUNK_CHARACTERS = 24; // 切割参数流，验证 SDK 的增量 JSON 解析

const DECISION_WORKSPACE_RUN = "workspace_run";
const DECISION_WORKSPACE_APPLY = "workspace_apply";
const DECISION_PLAIN_TEXT = "plain_text";

const TOOL_NAME_WORKSPACE_RUN = "workspace_run";
const TOOL_NAME_WORKSPACE_APPLY = "workspace_apply";

const SCRIPT_GLOSSARY = "glossary"; // 只写术语变更清单，验证工程写入审批
const SCRIPT_HOST = "host"; // 追加术语的同时输出图片与请求打印，验证 Chromium 宿主
const SCRIPT_MODES = Object.freeze([SCRIPT_GLOSSARY, SCRIPT_HOST]);

const AFTER_APPLY_TEXT = "已提交写入申请，随后按回执继续处理。";
const FOLLOW_UP_TEXT = "收到，继续处理后续任务。";
const UNKNOWN_REQUEST_TEXT = "这是模拟模型对未知请求的固定回复。";

/** 合成 PNG（24×16，左亮右暗）：供工作区 `emitImage` 走真实图片宿主解码与编码。 */
const SYNTHETIC_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAHUlEQVR4nGO4E7WAINIgAjGMGjRq0KhBowZRZhAA8kM6H6HfTgAAAAAASUVORK5CYII=";

/** 合成打印文档：只含静态文本，验证 Chromium 打印宿主的字节输出。 */
const PROBE_PDF_HTML =
  "<h1>合成 PDF 探针</h1><p>Chromium 打印宿主：中文与等宽字体排版。</p><pre>mono 0123</pre>";

/** 变更清单行格式见 `src/backend/agent/workspace/changes.ts` 与 `schema.ts`。 */
const SYNTHETIC_GLOSSARY_ENTRY = Object.freeze({
  src: "合成术语",
  dst: "synthetic term",
  info: "Agent 全链路探针写入的合成术语条目",
  case_sensitive: false,
  sort: -1, // 追加到末尾，不抢占工程已有顺序
});

/**
 * 生成 `workspace_run` 的脚本正文。路径取自工作区契约而非硬编码，
 * 契约变化时脚本随真实契约失败，而不是静默写错位置。
 *
 * `script` 选择验证目标：
 * - `glossary`：只写术语变更清单，驱动工程写入审批；
 * - `host`：在写清单之外输出工作区图片并请求 HTML 打印，
 *   让 Chromium 图片宿主与 PDF 宿主在真实子进程中被调用。
 */
function build_workspace_run_script(script) {
  const entry = JSON.stringify(SYNTHETIC_GLOSSARY_ENTRY);
  const glossary_lines = [
    "// 合成探针脚本：向术语变更清单追加一条合成术语，供 workspace_apply 提交。",
    'import { appendFile } from "node:fs/promises";',
    "",
    "const target = ws.contract.changes.glossary.creates.path;",
    `const entry = ${entry};`,
    'await appendFile(target, `${JSON.stringify(entry)}\\n`, "utf8");',
    "console.log(`appended glossary create to ${target}`);",
  ];
  if (script === SCRIPT_GLOSSARY) return glossary_lines.join("\n");
  return [
    ...glossary_lines,
    'import { readFile, writeFile } from "node:fs/promises";',
    "",
    "// 图片宿主：写出合成 PNG 后交给工作区 emitImage，父进程按策略解码并编码为 WebP。",
    'await writeFile("work/probe-image.png", Buffer.from(' +
      JSON.stringify(SYNTHETIC_PROBE_PNG_BASE64) +
      ', "base64"));',
    'await ws.emitImage("work/probe-image.png");',
    'console.log("emitted workspace image through the image host");',
    "",
    "// PDF 宿主：请求打印合成文档，宿主返回落盘路径，脚本读回文件头确认字节输出。",
    "const printed = await ws.host({ kind: " +
      JSON.stringify("print_pdf") +
      ", html: " +
      JSON.stringify(PROBE_PDF_HTML) +
      " });",
    "const bytes = await readFile(printed.path);",
    'console.log(`printed pdf path=${printed.path} header=${bytes.subarray(0, 5).toString("latin1")} bytes=${bytes.length}`);',
  ].join("\n");
}

/**
 * 按已发生的工具轮次决策；`tool_rounds` 只统计已执行的工具结果，
 * 同一轮的重试不会提前推进脚本。
 */
function decide_round(body, script) {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const tool_rounds = messages.filter(
    (message) => is_record(message) && message["role"] === "tool",
  ).length;
  const has_tools = tools.length > 0;
  if (!has_tools)
    // 标题生成、摘要等未知请求不带工具，直接回复固定文本。
    return {
      decision: DECISION_PLAIN_TEXT,
      tool_rounds,
      has_tools,
      tool_calls: null,
      text: UNKNOWN_REQUEST_TEXT,
    };
  if (tool_rounds <= 0)
    return {
      decision: DECISION_WORKSPACE_RUN,
      tool_rounds,
      has_tools,
      tool_calls: [
        {
          name: TOOL_NAME_WORKSPACE_RUN,
          arguments: { script: build_workspace_run_script(script) },
        },
      ],
      text: null,
    };
  if (tool_rounds === 1)
    return {
      decision: DECISION_WORKSPACE_APPLY,
      tool_rounds,
      has_tools,
      tool_calls: [{ name: TOOL_NAME_WORKSPACE_APPLY, arguments: {} }],
      text: null,
    };
  return {
    decision: DECISION_PLAIN_TEXT,
    tool_rounds,
    has_tools,
    tool_calls: null,
    text: tool_rounds === 2 ? AFTER_APPLY_TEXT : FOLLOW_UP_TEXT,
  };
}

function is_record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 估算 token 数只服务于 usage 统计，字符长度除以 4 已足够。 */
function estimate_tokens(text) {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : Math.max(1, Math.ceil(trimmed.length / 4));
}

function read_message_text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      is_record(part) && part["type"] === "text" ? [String(part["text"] ?? "")] : [],
    )
    .join("");
}

/** 日志中的请求摘要：只保留可定位的角色序列与最后一个用户正文前缀。 */
function summarize_messages(body) {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const last_user = [...messages]
    .reverse()
    .find((message) => is_record(message) && message["role"] === "user");
  return {
    count: messages.length,
    roles: messages.map((message) =>
      is_record(message) ? String(message["role"] ?? "unknown") : "unknown",
    ),
    lastUserText:
      last_user === undefined
        ? ""
        : read_message_text(last_user["content"]).slice(0, MESSAGE_SUMMARY_CHARACTERS),
  };
}

function summarize_tool_calls(tool_calls) {
  if (tool_calls === null) return null;
  return tool_calls.map((tool_call) => ({
    name: tool_call.name,
    arguments: JSON.stringify(tool_call.arguments).slice(0, ARGUMENT_SUMMARY_CHARACTERS),
  }));
}

function build_usage(body, output_text) {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const prompt_text = messages
    .map((message) => (is_record(message) ? read_message_text(message["content"]) : ""))
    .join("\n");
  const prompt_tokens = estimate_tokens(prompt_text);
  const completion_tokens = estimate_tokens(output_text);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

function create_tool_call_id() {
  return `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function build_chunk(context, delta, finish_reason) {
  return {
    id: context.id,
    object: "chat.completion.chunk",
    created: context.created,
    model: context.model,
    choices: [{ index: 0, delta, finish_reason: finish_reason ?? null }],
  };
}

/** `include_usage` 的终帧不带 choices，pi-ai 只消费其中的 usage。 */
function build_usage_chunk(context, usage) {
  return {
    id: context.id,
    object: "chat.completion.chunk",
    created: context.created,
    model: context.model,
    choices: [],
    usage,
  };
}

/** 工具调用轮次的 SSE 序列：role → id/name → 参数分片 → finish_reason=tool_calls。 */
function build_tool_call_chunks(context, tool_calls) {
  const chunks = [build_chunk(context, { role: "assistant" }, null)];
  tool_calls.forEach((tool_call, index) => {
    const arguments_text = JSON.stringify(tool_call.arguments);
    chunks.push(
      build_chunk(
        context,
        {
          tool_calls: [
            {
              index,
              id: create_tool_call_id(),
              type: "function",
              function: { name: tool_call.name, arguments: "" },
            },
          ],
        },
        null,
      ),
    );
    for (let start = 0; start < arguments_text.length; start += ARGUMENT_STREAM_CHUNK_CHARACTERS)
      chunks.push(
        build_chunk(
          context,
          {
            tool_calls: [
              {
                index,
                function: {
                  arguments: arguments_text.slice(start, start + ARGUMENT_STREAM_CHUNK_CHARACTERS),
                },
              },
            ],
          },
          null,
        ),
      );
  });
  chunks.push(build_chunk(context, {}, "tool_calls"));
  return chunks;
}

/** 纯文本轮次的 SSE 序列：role → content → finish_reason=stop。 */
function build_text_chunks(context, text) {
  return [
    build_chunk(context, { role: "assistant" }, null),
    build_chunk(context, { content: text }, null),
    build_chunk(context, {}, "stop"),
  ];
}

/**
 * 请求日志串行写入：同一文件的多条记录不会交叉，
 * 调用方 await 返回后即可读到完整行。
 */
function create_request_log(log_path) {
  let chain = Promise.resolve();
  return {
    path: log_path,
    append(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      chain = chain
        .then(() => appendFile(log_path, line, "utf8"))
        .catch((error) => {
          // 日志失败不影响模拟服务本身，探针仍可通过 SSE 与回执断言链路。
          process.stderr.write(`[agent-mock] request log append failed: ${String(error)}\n`);
        });
      return chain.then(() => undefined);
    },
  };
}

function sleep(ms) {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function send_json(response, status, payload, extra_headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    ...extra_headers,
  });
  response.end(body);
}

function send_sse_head(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  });
}

/** 携带状态码的请求异常，路由层统一转换为 OpenAI 错误壳。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

async function read_json_body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!is_record(parsed)) throw new TypeError("body is not a JSON object");
    return parsed;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${String(error)}`);
  }
}

function send_error(response, status, message, error_type = "invalid_request_error") {
  send_json(response, status, { error: { message, type: error_type, param: null, code: null } });
}

/**
 * 启动模拟服务；测试与探针共用同一入口，端口 0 表示随机。
 */
export async function start_agent_mock_server(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const delay_ms = options.delay_ms ?? 0;
  const script = options.script ?? SCRIPT_GLOSSARY;
  const log_path = options.log ?? path.join(os.tmpdir(), DEFAULT_LOG_NAME);
  await mkdir(path.dirname(log_path), { recursive: true });
  const log = create_request_log(log_path);
  let sequence = 0;

  const server = http.createServer((request, response) => {
    // 客户端中途断开（取消、探针 abort）时写入失败属于正常结束，不做错误上报。
    response.on("error", () => undefined);
    handle_request(request, response).catch((error) => {
      if (response.headersSent || response.writableEnded) return;
      if (error instanceof HttpError) send_error(response, error.status, error.message);
      else {
        send_error(response, 500, `Internal server error: ${String(error)}`, "server_error");
        process.stderr.write(`[agent-mock] ${String(error)}\n`);
      }
    });
  });

  async function handle_chat_completions(request, response) {
    const body = await read_json_body(request);
    const stream = body["stream"] === true;
    const stream_options = is_record(body["stream_options"]) ? body["stream_options"] : {};
    const include_usage = stream_options["include_usage"] === true;
    const model =
      typeof body["model"] === "string" && body["model"] !== "" ? body["model"] : MODEL_ID;
    const round = decide_round(body, script);
    const context = {
      id: `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      created: Math.floor(Date.now() / 1000),
      model,
    };
    sequence += 1;
    const output_text =
      round.text ?? (round.tool_calls ?? []).map((call) => JSON.stringify(call.arguments)).join("");
    await log.append({
      seq: sequence,
      at: new Date().toISOString(),
      method: request.method ?? "POST",
      path: "/chat/completions",
      stream,
      hasTools: round.has_tools,
      toolNames: Array.isArray(body["tools"])
        ? body["tools"].map((tool) =>
            is_record(tool)
              ? String(
                  (is_record(tool["function"]) ? tool["function"]["name"] : undefined) ??
                    tool["name"] ??
                    "",
                )
              : "",
          )
        : [],
      toolRounds: round.tool_rounds,
      decision: round.decision,
      messages: summarize_messages(body),
      toolCalls: summarize_tool_calls(round.tool_calls),
    });

    const chunks =
      round.tool_calls === null
        ? build_text_chunks(context, round.text ?? "")
        : build_tool_call_chunks(context, round.tool_calls);

    if (!stream) {
      await sleep(delay_ms);
      const message =
        round.tool_calls === null
          ? { role: "assistant", content: round.text ?? "" }
          : {
              role: "assistant",
              content: null,
              tool_calls: round.tool_calls.map((tool_call) => ({
                id: create_tool_call_id(),
                type: "function",
                function: {
                  name: tool_call.name,
                  arguments: JSON.stringify(tool_call.arguments),
                },
              })),
            };
      send_json(response, 200, {
        id: context.id,
        object: "chat.completion",
        created: context.created,
        model: context.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: round.tool_calls === null ? "stop" : "tool_calls",
          },
        ],
        usage: build_usage(body, output_text),
      });
      return;
    }

    send_sse_head(response);
    for (const chunk of chunks) {
      await sleep(delay_ms);
      // 客户端中途断开（取消、探针 abort）时静默收尾，不向已断开的 socket 报错。
      if (response.writableEnded || response.destroyed) return;
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    if (include_usage) {
      await sleep(delay_ms);
      if (response.writableEnded || response.destroyed) return;
      response.write(
        `data: ${JSON.stringify(build_usage_chunk(context, build_usage(body, output_text)))}\n\n`,
      );
    }
    await sleep(delay_ms);
    if (response.writableEnded || response.destroyed) return;
    response.write("data: [DONE]\n\n");
    response.end();
  }

  async function handle_request(request, response) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    // 与 mock_llm_api_server.py 保持一致：同时接受根路径与 /v1 前缀，
    // 模型 api_url 配成哪种都能驱动同一状态机。
    const route = url.pathname.replace(/^\/v1(?=\/)/u, "").replace(/\/+$/u, "") || "/";
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        "Content-Length": "0",
      });
      response.end();
      return;
    }
    if (route === "/health") {
      send_json(response, 200, { status: "ok" });
      return;
    }
    if (route === "/models") {
      if (request.method !== "GET") throw new HttpError(405, "Only GET is supported");
      send_json(response, 200, {
        object: "list",
        data: [
          {
            id: MODEL_ID,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "mock",
          },
        ],
      });
      return;
    }
    if (route === "/chat/completions") {
      if (request.method !== "POST") throw new HttpError(405, "Only POST is supported");
      await handle_chat_completions(request, response);
      return;
    }
    throw new HttpError(404, `Not found: ${route}`);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Agent mock server did not obtain a listening address.");
  return {
    baseUrl: `http://${host}:${address.port.toString()}`,
    port: address.port,
    logPath: log_path,
    close() {
      return new Promise((resolve, reject) => {
        // Node 可能在成功时不传回调参数，只用真值判断错误。
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

/** 解析 `--name value` 形式的启动参数；未知参数与缺失值都立即失败。 */
export function parse_agent_mock_arguments(argv) {
  const options = {};
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
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0) throw new Error(`Invalid port: ${value}`);
        options.port = port;
        break;
      }
      case "host":
        options.host = value;
        break;
      case "log":
        options.log = value;
        break;
      case "delay-ms": {
        const delay = Number(value);
        if (!Number.isFinite(delay) || delay < 0) throw new Error(`Invalid delay-ms: ${value}`);
        options.delay_ms = delay;
        break;
      }
      case "script": {
        if (!SCRIPT_MODES.includes(value))
          throw new Error(`Invalid script: ${value} (expected ${SCRIPT_MODES.join(" | ")})`);
        options.script = value;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  return options;
}

/** 直接执行时作为独立服务启动；被测试导入时不进入 CLI 分支。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parse_agent_mock_arguments(process.argv.slice(2));
  const server = await start_agent_mock_server(options);
  process.stdout.write(`AGENT_MOCK_LISTENING ${server.port.toString()}\n`);
}
