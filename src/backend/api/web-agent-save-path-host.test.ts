import { describe, expect, it, vi } from "vitest";

import { AGENT_SAVE_PATH_EVENT_TOPIC } from "../../shared/agent";
import type { JsonRecord } from "../../domain/json";
import {
  create_web_agent_save_path_host,
  read_save_path_response,
} from "./web-agent-save-path-host";

/** 收集发布事件，验证请求与应答都到达传输层。 */
function create_publish_spy(): {
  publish: (topic: string, payload: JsonRecord) => void;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  const publish = vi.fn((topic: string, payload: Record<string, unknown>) => {
    events.push({ topic, ...payload });
  });
  return { publish, events };
}

describe("web agent save path host", () => {
  it("请求经 SSE 发布，应答后等待方拿到路径", async () => {
    const { publish, events } = create_publish_spy();
    const host = create_web_agent_save_path_host({ publish });

    const waiting = host.request_save_path("report.txt");
    const request = host.list_pending_requests();
    expect(request).toHaveLength(1);
    expect(request[0]?.default_name).toBe("report.txt");
    expect(events).toEqual([
      {
        topic: AGENT_SAVE_PATH_EVENT_TOPIC,
        type: "requested",
        request_id: request[0]!.request_id,
        default_name: "report.txt",
      },
    ]);

    expect(host.respond_to_request(request[0]!.request_id, "/storage/emulated/0/report.txt")).toBe(
      true,
    );
    await expect(waiting).resolves.toBe("/storage/emulated/0/report.txt");
    expect(host.list_pending_requests()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "resolved" });
  });

  it("取消应答返回 null，重复应答与未知身份都被拒绝", async () => {
    const { publish } = create_publish_spy();
    const host = create_web_agent_save_path_host({ publish });

    const waiting = host.request_save_path("notes.md");
    const request_id = host.list_pending_requests()[0]!.request_id;
    expect(host.respond_to_request(request_id, null)).toBe(true);
    await expect(waiting).resolves.toBeNull();
    expect(host.respond_to_request(request_id, "/anywhere")).toBe(false);
    expect(host.respond_to_request("missing", "/anywhere")).toBe(false);
  });

  it("迟连接浏览器经 pending 列表领取驻留请求", async () => {
    const { publish } = create_publish_spy();
    const host = create_web_agent_save_path_host({ publish });

    const first = host.request_save_path("a.txt");
    const second = host.request_save_path("b.txt");
    const pending = host.list_pending_requests();
    expect(pending.map((request) => request.default_name)).toEqual(["a.txt", "b.txt"]);

    host.respond_to_request(pending[1]!.request_id, "/storage/b.txt");
    await expect(second).resolves.toBe("/storage/b.txt");
    expect(host.list_pending_requests().map((request) => request.default_name)).toEqual(["a.txt"]);
    host.dispose(); // 另一个请求驻留到 dispose 才收尾
    await expect(first).resolves.toBeNull();
  });

  it("dispose 释放全部等待方，且不再受理新请求", async () => {
    const { publish } = create_publish_spy();
    const host = create_web_agent_save_path_host({ publish });

    const waiting = host.request_save_path("c.txt");
    host.dispose();
    await expect(waiting).resolves.toBeNull();
    await expect(host.request_save_path("d.txt")).resolves.toBeNull();
    expect(host.list_pending_requests()).toEqual([]);
  });

  it("超时按取消收尾且不留下驻留请求", async () => {
    vi.useFakeTimers();
    try {
      const { publish } = create_publish_spy();
      const host = create_web_agent_save_path_host({ publish, timeout_ms: 1000 });
      const waiting = host.request_save_path("slow.txt");
      vi.advanceTimersByTime(1001);
      await expect(waiting).resolves.toBeNull();
      expect(host.list_pending_requests()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("read_save_path_response", () => {
  it("接受字符串与显式 null，空白按取消，其它形状拒绝", () => {
    expect(read_save_path_response({ path: "/storage/x.txt" })).toBe("/storage/x.txt");
    expect(read_save_path_response({ path: "  /storage/x.txt  " })).toBe("/storage/x.txt");
    expect(read_save_path_response({ path: null })).toBeNull();
    expect(read_save_path_response({ path: "   " })).toBeNull();
    expect(() => read_save_path_response({ path: 12 })).toThrow();
  });
});
