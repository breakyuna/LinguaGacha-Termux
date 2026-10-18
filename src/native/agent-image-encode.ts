import type { AgentImagePolicy } from "../shared/agent-image";

/** 页面内编码请求：字节以 base64 传递，避开调试通道的二进制限制。 */
export type AgentImageEncodeRequest = Readonly<{
  data: string;
  mimeType: string;
  policy: AgentImagePolicy;
}>;

/** 页面内编码结果：`data` 是 WebP 字节的 base64。 */
export type AgentImageEncodeResult = Readonly<{
  data: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}>;

/**
 * 此函数独立序列化到隔离页面，所有策略来自后端请求，不能捕获模块变量。
 * Electron 隐藏窗口与 Chromium 宿主共用同一份实现，像素与字节预算语义只在此维护。
 */
export async function encode_agent_image(
  request: AgentImageEncodeRequest,
): Promise<AgentImageEncodeResult> {
  const { policy } = request;
  const bytes = Uint8Array.from(atob(request.data), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: request.mimeType }));
  try {
    const original = { originalWidth: bitmap.width, originalHeight: bitmap.height };
    if (bitmap.width * bitmap.height > policy.maxPixels)
      throw new Error("Image exceeds pixel limit.");
    const scale = Math.min(1, policy.maxEdge / bitmap.width, policy.maxEdge / bitmap.height);
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    if (request.mimeType === "image/webp" && scale === 1 && bytes.byteLength <= policy.maxBytes)
      return { data: request.data, width, height, ...original };
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Image canvas unavailable.");
    while (true) {
      canvas.width = width;
      canvas.height = height;
      context.drawImage(bitmap, 0, 0, width, height);
      const url = canvas.toDataURL("image/webp", policy.quality);
      if (!url.startsWith("data:image/webp;base64,")) throw new Error("WebP encoder unavailable.");
      const data = url.slice(url.indexOf(",") + 1);
      if (atob(data).length <= policy.maxBytes) return { data, width, height, ...original };
      if (width === 1 && height === 1) throw new Error("Image exceeds output limit.");
      const shrink = 0.75; // 固定降采样步长，使尺寸持续收敛。
      width = Math.max(1, Math.floor(width * shrink));
      height = Math.max(1, Math.floor(height * shrink));
    }
  } finally {
    bitmap.close();
  }
}
