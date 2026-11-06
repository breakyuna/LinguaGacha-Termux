import { encode_agent_image, type AgentImageEncodeResult } from "./agent-image-encode";
import type { ChromiumPageSource } from "./chromium-browser";
import { run_chromium_page_task } from "./chromium-page-task";
import type { AgentImageHost, AgentImageHostResult } from "../shared/agent-image";
import { AppError } from "../shared/error";

const IMAGE_HOST_TIMEOUT_MS = 30_000;

/** 页面只加载内嵌 CSP 的数据文档，解码与编码都在隔离上下文中完成。 */
const IMAGE_HOST_PAGE_URL =
  'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob: data:">';

/**
 * 用本机 Chromium 承担图片解码与 WebP 编码，替代 Electron 隐藏窗口。
 * 每次请求开独立页面，浏览器进程按需启动并在 dispose 时结束。
 */
export function create_chromium_image_host(
  pages: ChromiumPageSource,
  options?: { timeoutMs?: number },
): AgentImageHost & { dispose: () => Promise<void> } {
  const timeout_ms = options?.timeoutMs ?? IMAGE_HOST_TIMEOUT_MS;
  const host: AgentImageHost = async (operation, signal) => {
    signal.throwIfAborted();
    const page = await pages.open_page();
    return await run_chromium_page_task(page, signal, timeout_ms, async (step) => {
      await step("load", () => page.navigate(IMAGE_HOST_PAGE_URL));
      const request = {
        data: Buffer.from(operation.bytes).toString("base64"),
        mimeType: operation.mimeType,
        policy: operation.policy,
      };
      const result = (await step("encode", () =>
        page.evaluate(`(${encode_agent_image.toString()})(${JSON.stringify(request)})`),
      )) as AgentImageEncodeResult | undefined;
      if (
        result === undefined ||
        typeof result.data !== "string" ||
        !Number.isFinite(result.width) ||
        !Number.isFinite(result.height) ||
        !Number.isFinite(result.originalWidth) ||
        !Number.isFinite(result.originalHeight)
      ) {
        // 宿主返回值形状不受信任：形状异常按能力缺失回答，不把坏数据送进模型请求。
        throw new AppError("runtime.capability_missing", {
          public_details: { reason: "image_host_unavailable" },
          diagnostic_context: { reason: "invalid_image_result" },
        });
      }
      const encoded: AgentImageHostResult = {
        bytes: new Uint8Array(Buffer.from(result.data, "base64")),
        width: result.width,
        height: result.height,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
      };
      if (encoded.bytes.byteLength > operation.policy.maxBytes) {
        throw new AppError("runtime.capability_missing", {
          public_details: { reason: "image_host_unavailable" },
          diagnostic_context: { reason: "image_exceeds_output_limit" },
        });
      }
      return encoded;
    });
  };
  return Object.assign(host, {
    /** 结束浏览器进程，取消与排队中的图片请求随调用方信号自行收尾。 */
    dispose: async () => {
      await pages.dispose();
    },
  });
}
