import { describe, expect, it } from "vitest";

import { create_chromium_image_host } from "./chromium-image-host";
import type { ChromiumPage, ChromiumPageSource } from "./chromium-browser";
import { encode_agent_image } from "./agent-image-encode";
import type { AgentImageHostOperation } from "../shared/agent-image";
import { AGENT_IMAGE_DEFAULT_MAX_EDGE } from "../shared/agent-image";

const POLICY = {
  maxEdge: AGENT_IMAGE_DEFAULT_MAX_EDGE,
  maxPixels: 10_000_000,
  maxBytes: 4096,
  quality: 0.8,
} as const;

const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

interface FakeRecorder {
  pages: ChromiumPageSource;
  navigations: string[];
  expressions: string[];
  closed: number[];
  opened: number;
  dispose_calls: number;
}

/** 记录宿主对页面的每次调用，按序返回预设编码结果。 */
function create_fake_pages(results: readonly unknown[]): FakeRecorder {
  const recorder: FakeRecorder = {
    pages: { open_page: async () => ({}) as ChromiumPage, dispose: async () => {} },
    navigations: [],
    expressions: [],
    closed: [],
    opened: 0,
    dispose_calls: 0,
  };
  recorder.pages = {
    open_page: async () => {
      const id = recorder.opened;
      recorder.opened += 1;
      return {
        navigate: async (url: string) => {
          recorder.navigations.push(url);
        },
        evaluate: async (expression: string) => {
          recorder.expressions.push(expression);
          return results[id] ?? results.at(-1);
        },
        print_to_pdf: async () => new Uint8Array(),
        close: async () => {
          recorder.closed.push(id);
        },
      };
    },
    dispose: async () => {
      recorder.dispose_calls += 1;
    },
  };
  return recorder;
}

function create_operation(): AgentImageHostOperation {
  return {
    kind: "prepare_image",
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    mimeType: "image/png",
    policy: POLICY,
  };
}

describe("chromium image host", () => {
  it("经 data: 文档加载与页面内编码返回 WebP 字节与原始尺寸", async () => {
    const encoded = Buffer.from(WEBP_BYTES).toString("base64");
    const recorder = create_fake_pages([
      { data: encoded, width: 100, height: 50, originalWidth: 4000, originalHeight: 2000 },
    ]);
    const host = create_chromium_image_host(recorder.pages);

    const result = await host(create_operation(), new AbortController().signal);

    expect(Array.from(result.bytes)).toEqual(Array.from(WEBP_BYTES));
    expect(result).toMatchObject({
      width: 100,
      height: 50,
      originalWidth: 4000,
      originalHeight: 2000,
    });
    // 只加载内嵌 CSP 的空白文档，真实字节与策略都经脚本参数进入页面。
    expect(recorder.navigations).toHaveLength(1);
    expect(recorder.navigations[0]).toContain("Content-Security-Policy");
    expect(recorder.expressions).toHaveLength(1);
    expect(recorder.expressions[0]).toContain(encode_agent_image.name);
    expect(recorder.expressions[0]).toContain(Buffer.from([1, 2, 3, 4, 5]).toString("base64"));
    expect(recorder.closed).toEqual([0]);
  });

  it("编码结果形状异常按能力缺失回答，页面仍然释放", async () => {
    const recorder = create_fake_pages([{ data: "not-base64-shape" }]);
    const host = create_chromium_image_host(recorder.pages);

    await expect(host(create_operation(), new AbortController().signal)).rejects.toMatchObject({
      public_details: { reason: "image_host_unavailable" },
    });
    expect(recorder.closed).toEqual([0]);
  });

  it("输出超出字节预算按能力缺失回答", async () => {
    const oversized = Buffer.alloc(POLICY.maxBytes + 1, 7).toString("base64");
    const recorder = create_fake_pages([
      { data: oversized, width: 10, height: 10, originalWidth: 10, originalHeight: 10 },
    ]);
    const host = create_chromium_image_host(recorder.pages);

    await expect(host(create_operation(), new AbortController().signal)).rejects.toMatchObject({
      diagnostic_context: { reason: "image_exceeds_output_limit" },
    });
    expect(recorder.closed).toEqual([0]);
  });

  it("加载阶段取消后不进入编码，迟到编码结果不交付", async () => {
    const controller = new AbortController();
    const recorder = create_fake_pages([
      { data: "x", width: 1, height: 1, originalWidth: 1, originalHeight: 1 },
    ]);
    recorder.pages = {
      ...recorder.pages,
      open_page: async () => {
        recorder.opened += 1;
        return {
          navigate: async () => {
            controller.abort(new Error("cancelled by caller"));
            // 在途导航永不完成，模拟被放弃的 CDP 调用。
            return new Promise<void>(() => undefined);
          },
          evaluate: async (expression: string) => {
            recorder.expressions.push(expression);
            return { data: "x", width: 1, height: 1, originalWidth: 1, originalHeight: 1 };
          },
          print_to_pdf: async () => new Uint8Array(),
          close: async () => {
            recorder.closed.push(0);
          },
        };
      },
    };
    const host = create_chromium_image_host(recorder.pages);

    await expect(host(create_operation(), controller.signal)).rejects.toThrow(
      "cancelled by caller",
    );
    expect(recorder.expressions).toEqual([]);
    expect(recorder.closed).toEqual([0]);
  });

  it("dispose 结束页面来源", async () => {
    const recorder = create_fake_pages([
      { data: "x", width: 1, height: 1, originalWidth: 1, originalHeight: 1 },
    ]);
    const host = create_chromium_image_host(recorder.pages);

    await host.dispose();

    expect(recorder.dispose_calls).toBe(1);
  });
});
