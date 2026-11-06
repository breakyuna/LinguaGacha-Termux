import { BrowserWindow } from "electron";
import { run_window_task } from "./window-task";
import { encode_agent_image } from "./agent-image-encode";
import type { AgentImageHost } from "../shared/agent-image";

const IMAGE_HOST_TIMEOUT_MS = 30_000;

/** 图片解码属于 Electron 宿主，窗口随单次请求回收，取消沿现有宿主通道传播。 */
export const prepare_agent_image: AgentImageHost = async (operation, signal) => {
  signal.throwIfAborted();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  return await run_window_task(window, signal, IMAGE_HOST_TIMEOUT_MS, async (step) => {
    await step("load", () =>
      window.loadURL(
        'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob: data:">',
      ),
    );
    const request = {
      data: Buffer.from(operation.bytes).toString("base64"),
      mimeType: operation.mimeType,
      policy: operation.policy,
    };
    const result = (await step("encode", () =>
      window.webContents.executeJavaScript(
        `(${encode_agent_image.toString()})(${JSON.stringify(request)})`,
      ),
    )) as {
      data: string;
      width: number;
      height: number;
      originalWidth: number;
      originalHeight: number;
    };
    return {
      bytes: new Uint8Array(Buffer.from(result.data, "base64")),
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
    };
  });
};
