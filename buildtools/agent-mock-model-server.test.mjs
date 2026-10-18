import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { start_agent_mock_server } from "./agent-mock-model-server.mjs";

const REQUEST_TIMEOUT_MS = 10_000; // 未知请求挂起会直接超过该预算，避免测试卡死

const servers = [];

afterEach(async () => {
  // 每个用例自持服务与临时日志目录，失败也留下可读诊断。
  for (const server of servers.splice(0)) await server.close();
});

/** 启动真实 HTTP 服务；端口 0 由系统分配，日志落在用例临时目录。 */
async function start_server() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-mock-test-"));
  const server = await start_agent_mock_server({
    port: 0,
    log: path.join(directory, "requests.jsonl"),
  });
  servers.push({ close: server.close, directory });
  return { server, directory };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "workspace_run",
      description: "在工作区运行脚本",
      parameters: { type: "object", properties: { script: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_apply",
      description: "提交变更清单",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** 复刻 Agent 循环写入的 transcript：assistant tool_calls + tool 结果。 */
function append_tool_round(messages, tool_call, result_text) {
  return [
    ...messages,
    { role: "assistant", content: null, tool_calls: [tool_call] },
    { role: "tool", tool_call_id: tool_call.id, content: result_text },
  ];
}

async function post_completion(server, body) {
  const response = await fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(response.status).toBe(200);
  return await response.json();
}

function read_tool_call(payload, expected_name) {
  const message = payload.choices[0].message;
  expect(payload.choices[0].finish_reason).toBe("tool_calls");
  expect(message.tool_calls).toHaveLength(1);
  const tool_call = message.tool_calls[0];
  expect(tool_call.type).toBe("function");
  expect(tool_call.function.name).toBe(expected_name);
  expect(typeof tool_call.id).toBe("string");
  expect(tool_call.id).not.toBe("");
  return tool_call;
}

/** 收集完整 SSE 文本；流必须自行结束，超时即失败。 */
async function read_sse(server, body) {
  const response = await fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return await response.text();
}

/** 按 `data: ` 行解析 SSE 帧，保留顺序供索引与终止断言。 */
function parse_sse_frames(text) {
  const frames = text.split("\n\n").filter((frame) => frame.trim() !== "");
  const payloads = [];
  for (const frame of frames) {
    expect(frame.startsWith("data: ")).toBe(true);
    const data = frame.slice("data: ".length);
    if (data === "[DONE]") continue;
    payloads.push(JSON.parse(data));
  }
  return { frames, payloads, done: frames.at(-1) === "data: [DONE]" };
}

it("脚本状态机按工具轮次推进：run、apply、第三轮纯文本", async () => {
  const { server, directory } = await start_server();
  try {
    const first = await post_completion(server, {
      model: "agent-mock",
      messages: [
        { role: "system", content: "你是翻译 Agent" },
        { role: "user", content: "请为工程补充一条术语" },
      ],
      tools: TOOLS,
    });
    const run_call = read_tool_call(first, "workspace_run");
    const run_arguments = JSON.parse(run_call.function.arguments);
    // 脚本必须能在受限工作区真实执行：写入变更清单的一行合成术语。
    expect(run_arguments.script).toContain("ws.contract.changes.glossary.creates.path");
    expect(run_arguments.script).toContain("appendFile");
    expect(run_arguments.script).toContain("合成术语");

    const second_messages = append_tool_round(
      [
        { role: "system", content: "你是翻译 Agent" },
        { role: "user", content: "请为工程补充一条术语" },
      ],
      run_call,
      JSON.stringify({ exitCode: 0, stdout: { content: "appended glossary create" } }),
    );
    const second = await post_completion(server, {
      model: "agent-mock",
      messages: second_messages,
      tools: TOOLS,
    });
    const apply_call = read_tool_call(second, "workspace_apply");
    expect(apply_call.function.arguments).toBe("{}");

    const third_messages = append_tool_round(
      second_messages,
      apply_call,
      JSON.stringify({ status: "applied", applied: { glossary: 1 } }),
    );
    const third = await post_completion(server, {
      model: "agent-mock",
      messages: third_messages,
      tools: TOOLS,
    });
    expect(third.choices[0].finish_reason).toBe("stop");
    expect(third.choices[0].message.tool_calls).toBeUndefined();
    expect(third.choices[0].message.content.trim().length).toBeGreaterThan(0);

    // 用户再发消息仍回复纯文本，脚本不会退回工具调用。
    const fourth = await post_completion(server, {
      model: "agent-mock",
      messages: [
        ...third_messages,
        { role: "assistant", content: third.choices[0].message.content },
        { role: "user", content: "继续" },
      ],
      tools: TOOLS,
    });
    expect(fourth.choices[0].finish_reason).toBe("stop");
    expect(fourth.choices[0].message.content.trim().length).toBeGreaterThan(0);

    const log = (await readFile(server.logPath, "utf8")).trim().split("\n").map(JSON.parse);
    expect(log.map((entry) => entry.decision)).toEqual([
      "workspace_run",
      "workspace_apply",
      "plain_text",
      "plain_text",
    ]);
    expect(log.map((entry) => entry.toolRounds)).toEqual([0, 1, 2, 2]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("流式 chunk 序列合法：index 递增、finish_reason 与 DONE 收尾", async () => {
  const { server, directory } = await start_server();
  try {
    const text = await read_sse(server, {
      model: "agent-mock",
      messages: [{ role: "user", content: "请为工程补充一条术语" }],
      tools: TOOLS,
      stream: true,
      stream_options: { include_usage: true },
    });
    const { frames, payloads, done } = parse_sse_frames(text);
    expect(done).toBe(true);
    expect(payloads.length).toBeGreaterThan(3);
    expect(payloads.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
    expect(payloads.every((chunk) => chunk.choices.every((choice) => choice.index === 0))).toBe(
      true,
    );

    const tool_deltas = payloads.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? []);
    expect(tool_deltas.length).toBeGreaterThan(1);
    const indices = tool_deltas.map((delta) => delta.index);
    expect(indices[0]).toBe(0);
    expect([...indices].sort((left, right) => left - right)).toEqual(indices);
    expect(tool_deltas[0].function.name).toBe("workspace_run");
    expect(typeof tool_deltas[0].id).toBe("string");
    expect(tool_deltas[0].id).not.toBe("");

    // 参数分片拼回后必须是完整 JSON，验证 SDK 的增量解析输入。
    const arguments_text = tool_deltas.map((delta) => delta.function.arguments ?? "").join("");
    expect(JSON.parse(arguments_text)).toMatchObject({ script: expect.any(String) });

    expect(payloads.at(-2)?.choices[0]?.finish_reason).toBe("tool_calls");
    const usage_chunk = payloads.at(-1);
    expect(usage_chunk.choices).toEqual([]);
    expect(usage_chunk.usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage_chunk.usage.completion_tokens).toBeGreaterThan(0);
    expect(usage_chunk.usage.total_tokens).toBe(
      usage_chunk.usage.prompt_tokens + usage_chunk.usage.completion_tokens,
    );
    expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("无 tools 的未知请求不会挂起，直接回复固定文本", async () => {
  const { server, directory } = await start_server();
  try {
    const payload = await post_completion(server, {
      model: "agent-mock",
      messages: [{ role: "user", content: "请为本次对话生成一个标题" }],
    });
    expect(payload.choices[0].finish_reason).toBe("stop");
    expect(payload.choices[0].message.content).toBe("这是模拟模型对未知请求的固定回复。");

    const text = await read_sse(server, {
      model: "agent-mock",
      messages: [{ role: "user", content: "请摘要这段历史" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { payloads, done } = parse_sse_frames(text);
    expect(done).toBe(true);
    expect(payloads.at(-2)?.choices[0]?.finish_reason).toBe("stop");
    const content = payloads.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("");
    expect(content).toBe("这是模拟模型对未知请求的固定回复。");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("模型清单与健康检查遵循 OpenAI 兼容形状", async () => {
  const { server, directory } = await start_server();
  try {
    const health = await fetch(`${server.baseUrl}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const models = await fetch(`${server.baseUrl}/models`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(models.status).toBe(200);
    const payload = await models.json();
    expect(payload.object).toBe("list");
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({ object: "model", owned_by: "mock" });
    expect(typeof payload.data[0].id).toBe("string");

    const preflight = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(preflight.status).toBe(204);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("请求日志按序记录决策、工具调用与消息摘要", async () => {
  const { server, directory } = await start_server();
  try {
    const first = await post_completion(server, {
      model: "agent-mock",
      messages: [
        { role: "system", content: "你是翻译 Agent" },
        { role: "user", content: "请为工程补充一条术语" },
      ],
      tools: TOOLS,
    });
    const run_call = read_tool_call(first, "workspace_run");
    const second = await post_completion(server, {
      model: "agent-mock",
      messages: append_tool_round(
        [
          { role: "system", content: "你是翻译 Agent" },
          { role: "user", content: "请为工程补充一条术语" },
        ],
        run_call,
        JSON.stringify({ exitCode: 0 }),
      ),
      tools: TOOLS,
    });
    const apply_call = read_tool_call(second, "workspace_apply");
    await post_completion(server, {
      model: "agent-mock",
      messages: [
        { role: "user", content: "请为工程补充一条术语" },
        { role: "assistant", content: null, tool_calls: [run_call] },
        { role: "tool", tool_call_id: run_call.id, content: "{}" },
        { role: "assistant", content: null, tool_calls: [apply_call] },
        { role: "tool", tool_call_id: apply_call.id, content: "{}" },
      ],
      tools: TOOLS,
    });

    const log = (await readFile(server.logPath, "utf8")).trim().split("\n").map(JSON.parse);
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(log.every((entry) => entry.path === "/chat/completions")).toBe(true);
    expect(log.map((entry) => entry.decision)).toEqual([
      "workspace_run",
      "workspace_apply",
      "plain_text",
    ]);
    expect(log[0].hasTools).toBe(true);
    expect(log[0].toolNames).toEqual(["workspace_run", "workspace_apply"]);
    expect(log[0].toolCalls).toEqual([
      { name: "workspace_run", arguments: expect.stringContaining("script") },
    ]);
    expect(log[1].toolCalls).toEqual([{ name: "workspace_apply", arguments: "{}" }]);
    expect(log[2].toolCalls).toBeNull();
    expect(log[0].messages.lastUserText).toBe("请为工程补充一条术语");
    expect(log[0].messages.roles).toEqual(["system", "user"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
