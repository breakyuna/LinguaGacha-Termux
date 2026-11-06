#!/usr/bin/env node
/**
 * 长任务翻译模拟模型服务：`buildtools/agent-mock-model-server.mjs` 的副本，
 * 面向 TW-11 的 30 分钟翻译长任务验证（`buildtools/web-long-task-verify.mjs`）。
 *
 * 与共享脚本的分工：共享的 `agent-mock-model-server.mjs` 同时被其他验证代理使用，
 * 本副本只服务长任务探针，不改动共享文件。相对原文件的差异：
 *   1. 新增翻译响应：不带 `tools` 的请求（翻译 worker 的单次请求）按提示词中的
 *      ```jsonline 输入块回送同 `id` 的 JSON 行译文，翻译条目因此可被真实提交，
 *      长任务以全部条目 processed 的 done 终态收尾；
 *   2. 新增节奏控制：`--min-delay-ms` / `--max-delay-ms` 为每次请求的前置延迟
 *      （均匀抖动，模拟模型思考时间），`--delay-ms` 仍为每个 SSE 分片的间隔；
 *      运行期可经 `POST /__control` 调整延迟区间，`GET /__stats` 读取完成计数，
 *      供探针把整批翻译耗时稳定校准到约 30 分钟；
 *   3. 其余路由、状态机与请求日志格式与原文件保持一致。
 *
 * 用法：
 *   node buildtools/web-long-task-mock-model.mjs [--port 0] [--host 127.0.0.1]
 *       [--log <tmp>/long-task-mock-requests.jsonl]
 *       [--min-delay-ms 3000] [--max-delay-ms 6000] [--delay-ms 250]
 *       [--script glossary|host]
 * 启动后向 stdout 打印 `LONG_TASK_MOCK_LISTENING <port>`，供探针读取实际端口。
 */

import http from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MODEL_ID = "long-task-mock-model";
const DEFAULT_LOG_NAME = "long-task-mock-requests.jsonl";
const MAX_BODY_BYTES = 64 * 1024 * 1024; // 翻译提示词与模板可达数 MB，留足余量后再拒绝
const MESSAGE_SUMMARY_CHARACTERS = 200; // 日志只保留定位所需的用户正文前缀
const ARGUMENT_SUMMARY_CHARACTERS = 120; // 工具参数摘要同样只保留前缀
const ARGUMENT_STREAM_CHUNK_CHARACTERS = 24; // 切割参数流，验证 SDK 的增量 JSON 解析

const DECISION_WORKSPACE_RUN = "workspace_run";
const DECISION_WORKSPACE_APPLY = "workspace_apply";
const DECISION_PLAIN_TEXT = "plain_text";
const DECISION_TRANSLATION = "translation"; // 翻译请求：按 jsonline 输入回送同 id 译文

const TOOL_NAME_WORKSPACE_RUN = "workspace_run";
const TOOL_NAME_WORKSPACE_APPLY = "workspace_apply";

const SCRIPT_GLOSSARY = "glossary"; // 只写术语变更清单，验证工程写入审批
const SCRIPT_HOST = "host"; // 追加术语的同时输出图片与请求打印，验证 Chromium 宿主
const SCRIPT_MODES = Object.freeze([SCRIPT_GLOSSARY, SCRIPT_HOST]);

const AFTER_APPLY_TEXT = "已提交写入申请，随后按回执继续处理。";
const FOLLOW_UP_TEXT = "收到，继续处理后续任务。";
const UNKNOWN_REQUEST_TEXT = "这是模拟模型对未知请求的固定回复。";

/** 译文前缀：回显源文并加固定前缀，探针可逐条核对落盘内容与条目对齐。 */
const TRANSLATION_TEXT_PREFIX = "【译】";

const DEFAULT_MIN_DELAY_MS = 0; // 默认不加前置延迟，由调用方按长任务目标显式设置
const DEFAULT_MAX_DELAY_MS = 0;
const DEFAULT_CHUNK_DELAY_MS = 250; // 每个 SSE 分片的间隔，模拟逐 token 流出
const MAX_DELAY_MS = 60_000; // 节奏控制上限，防止配置错误把单次请求挂死

/** 提示词输入块围栏，见 `work-unit-prompt-builder.ts` 的 `build_inputs`。 */
const JSONLINE_BLOCK_PATTERN = /```jsonline[ \t]*\r?\n([\s\S]*?)```/gu;
/** 输入行身份：`JsonTool.stringifyStrict({ id, ... , text })` 的首字段。 */
const INPUT_ID_PATTERN = /"id":\s*(\d+)/u;
const INPUT_ACTOR_PATTERN = /"actor":\s*"/u;

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
 * 从提示词用户正文解析 jsonline 输入块，返回待回译文的条目身份。
 * 只认围栏内的行，系统提示词的输出格式示例不会混入。
 */
function read_translation_request_items(user_text) {
  const items = [];
  for (const block of user_text.matchAll(JSONLINE_BLOCK_PATTERN)) {
    const lines = String(block[1] ?? "").split(/\r?\n/u);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const id_match = INPUT_ID_PATTERN.exec(trimmed);
      if (id_match === null) continue;
      items.push({
        id: Number(id_match[1]),
        has_actor: INPUT_ACTOR_PATTERN.test(trimmed),
        text: read_input_text(trimmed),
      });
    }
  }
  return items;
}

/** 输入行正文：按 JSON 解析，失败时退化为正则截取，保证模型杂质不中断服务。 */
function read_input_text(line) {
  try {
    const parsed = JSON.parse(line);
    if (is_record(parsed) && typeof parsed["text"] === "string") return parsed["text"];
  } catch {
    // 落入正则分支
  }
  const match = /"text":\s*"((?:[^"\\]|\\.)*)"/u.exec(line);
  return match === null ? "" : match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

/**
 * 按请求身份生成 JSON 行译文；姓名模式同时回送 `actor`，
 * 满足 `response-decoder.ts` 对两种提示词模式的字段要求。
 * 译文回显源文并加固定前缀，使落盘内容可逐条核对（对齐与写回验证）。
 */
function build_translation_response(items) {
  if (items.length === 0) return null;
  return items
    .map((item) =>
      JSON.stringify({
        id: item.id,
        ...(item.has_actor ? { actor: `演员${String(item.id)}` } : {}),
        text: `${TRANSLATION_TEXT_PREFIX}${item.text}`,
      }),
    )
    .join("\n");
}

/**
 * 按已发生的工具轮次决策；`tool_rounds` 只统计已执行的工具结果，
 * 同一轮的重试不会提前推进脚本。不带工具的翻译请求按输入块回送译文。
 */
function decide_round(body, script) {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const tool_rounds = messages.filter(
    (message) => is_record(message) && message["role"] === "tool",
  ).length;
  const has_tools = tools.length > 0;
  if (!has_tools) {
    // 翻译请求不带工具：按 jsonline 输入块回送同 id 译文；其余未知请求回复固定文本。
    const last_user = [...messages]
      .reverse()
      .find((message) => is_record(message) && message["role"] === "user");
    if (last_user !== undefined) {
      const user_text = read_message_text(last_user["content"]);
      const request_items = read_translation_request_items(user_text);
      const translation_text = build_translation_response(request_items);
      if (translation_text !== null)
        return {
          decision: DECISION_TRANSLATION,
          tool_rounds,
          has_tools,
          tool_calls: null,
          text: translation_text,
          translation_items: request_items.length,
        };
    }
    return {
      decision: DECISION_PLAIN_TEXT,
      tool_rounds,
      has_tools,
      tool_calls: null,
      text: UNKNOWN_REQUEST_TEXT,
    };
  }
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
          process.stderr.write(`[long-task-mock] request log append failed: ${String(error)}\n`);
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
 * 节奏状态可被 `POST /__control` 运行期修改，探针据此校准整批翻译耗时。
 */
export async function start_long_task_mock_server(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const script = options.script ?? SCRIPT_GLOSSARY;
  const log_path = options.log ?? path.join(os.tmpdir(), DEFAULT_LOG_NAME);
  await mkdir(path.dirname(log_path), { recursive: true });
  const log = create_request_log(log_path);
  const pace = {
    min_delay_ms: Math.max(0, Math.trunc(options.min_delay_ms ?? DEFAULT_MIN_DELAY_MS)),
    max_delay_ms: Math.max(0, Math.trunc(options.max_delay_ms ?? DEFAULT_MAX_DELAY_MS)),
    chunk_delay_ms: Math.max(0, Math.trunc(options.delay_ms ?? DEFAULT_CHUNK_DELAY_MS)),
  };
  if (pace.max_delay_ms < pace.min_delay_ms) pace.max_delay_ms = pace.min_delay_ms;
  let sequence = 0;
  const stats = {
    started_at: new Date().toISOString(),
    requests: 0,
    completed: 0,
    in_flight: 0,
    translation_requests: 0,
    translation_items: 0,
    total_duration_ms: 0,
    max_duration_ms: 0,
  };

  const server = http.createServer((request, response) => {
    // 客户端中途断开（取消、探针 abort）时写入失败属于正常结束，不做错误上报。
    response.on("error", () => undefined);
    handle_request(request, response).catch((error) => {
      if (response.headersSent || response.writableEnded) return;
      if (error instanceof HttpError) send_error(response, error.status, error.message);
      else {
        send_error(response, 500, `Internal server error: ${String(error)}`, "server_error");
        process.stderr.write(`[long-task-mock] ${String(error)}\n`);
      }
    });
  });

  /** 前置延迟：均匀抖动区间模拟模型思考时间；区间由探针经控制接口调整。 */
  function read_pre_delay_ms() {
    const min = pace.min_delay_ms;
    const max = pace.max_delay_ms;
    if (max <= min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

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
    stats.requests += 1;
    stats.in_flight += 1;
    const started_at = Date.now();
    const pre_delay_ms = read_pre_delay_ms();
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
      preDelayMs: pre_delay_ms,
      translationItems: round.translation_items ?? 0,
      messages: summarize_messages(body),
      toolCalls: summarize_tool_calls(round.tool_calls),
    });

    const chunks =
      round.tool_calls === null
        ? build_text_chunks(context, round.text ?? "")
        : build_tool_call_chunks(context, round.tool_calls);

    if (!stream) {
      await sleep(pre_delay_ms);
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
      settle_request(round, started_at);
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

    await sleep(pre_delay_ms);
    send_sse_head(response);
    for (const chunk of chunks) {
      await sleep(pace.chunk_delay_ms);
      // 客户端中途断开（取消、探针 abort）时静默收尾，不向已断开的 socket 报错。
      if (response.writableEnded || response.destroyed) {
        settle_request(round, started_at);
        return;
      }
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    if (include_usage) {
      await sleep(pace.chunk_delay_ms);
      if (response.writableEnded || response.destroyed) {
        settle_request(round, started_at);
        return;
      }
      response.write(
        `data: ${JSON.stringify(build_usage_chunk(context, build_usage(body, output_text)))}\n\n`,
      );
    }
    await sleep(pace.chunk_delay_ms);
    if (response.writableEnded || response.destroyed) {
      settle_request(round, started_at);
      return;
    }
    response.write("data: [DONE]\n\n");
    response.end();
    settle_request(round, started_at);
  }

  /** 请求结算：完成计数、在途计数与耗时统计供控制接口与探针读取。 */
  function settle_request(round, started_at) {
    const duration_ms = Date.now() - started_at;
    stats.in_flight = Math.max(0, stats.in_flight - 1);
    stats.completed += 1;
    stats.total_duration_ms += duration_ms;
    stats.max_duration_ms = Math.max(stats.max_duration_ms, duration_ms);
    if (round.decision === DECISION_TRANSLATION) {
      stats.translation_requests += 1;
      stats.translation_items += round.translation_items ?? 0;
    }
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
    if (route === "/__stats") {
      if (request.method !== "GET") throw new HttpError(405, "Only GET is supported");
      send_json(response, 200, {
        ...stats,
        avg_duration_ms:
          stats.completed === 0 ? 0 : Math.round(stats.total_duration_ms / stats.completed),
        pace: { ...pace },
      });
      return;
    }
    if (route === "/__control") {
      if (request.method !== "POST") throw new HttpError(405, "Only POST is supported");
      const body = await read_json_body(request);
      const min = body["min_delay_ms"];
      const max = body["max_delay_ms"];
      if (min !== undefined) {
        if (!Number.isFinite(Number(min)) || Number(min) < 0)
          throw new HttpError(400, "Invalid min_delay_ms");
        pace.min_delay_ms = Math.min(MAX_DELAY_MS, Math.trunc(Number(min)));
      }
      if (max !== undefined) {
        if (!Number.isFinite(Number(max)) || Number(max) < 0)
          throw new HttpError(400, "Invalid max_delay_ms");
        pace.max_delay_ms = Math.min(MAX_DELAY_MS, Math.trunc(Number(max)));
      }
      if (pace.max_delay_ms < pace.min_delay_ms) pace.max_delay_ms = pace.min_delay_ms;
      send_json(response, 200, { accepted: true, pace: { ...pace } });
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
    throw new Error("Long task mock server did not obtain a listening address.");
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
export function parse_long_task_mock_arguments(argv) {
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
      case "min-delay-ms": {
        const delay = Number(value);
        if (!Number.isFinite(delay) || delay < 0) throw new Error(`Invalid min-delay-ms: ${value}`);
        options.min_delay_ms = delay;
        break;
      }
      case "max-delay-ms": {
        const delay = Number(value);
        if (!Number.isFinite(delay) || delay < 0) throw new Error(`Invalid max-delay-ms: ${value}`);
        options.max_delay_ms = delay;
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
  const options = parse_long_task_mock_arguments(process.argv.slice(2));
  const server = await start_long_task_mock_server(options);
  process.stdout.write(`LONG_TASK_MOCK_LISTENING ${server.port.toString()}\n`);
}
