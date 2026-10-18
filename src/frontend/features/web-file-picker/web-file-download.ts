import { api_blob } from "@frontend/app/desktop/desktop-api";
import { release_web_file_material } from "./web-file-picker-api";

// 浏览器接管下载后才释放对象 URL，立即释放可能中断尚未开始读取的流。
const OBJECT_URL_RELEASE_DELAY_MS = 1000;

/** 通过临时锚点触发浏览器下载；文件名由响应 Content-Disposition 决定。 */
export function trigger_browser_download(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** 经后端受控下载读取暂存材料并交给浏览器保存。 */
export async function download_web_file_material(material_id: string): Promise<void> {
  const controller = new AbortController();
  // api_blob 自行拼接宿主地址，这里只传路径，避免双重前缀。
  const blob = await api_blob(
    `/api/web/files/material/${encodeURIComponent(material_id)}`,
    controller.signal,
  );
  const object_url = URL.createObjectURL(blob);
  trigger_browser_download(object_url);
  window.setTimeout(() => URL.revokeObjectURL(object_url), OBJECT_URL_RELEASE_DELAY_MS);
}

/** 交付暂存材料：触发浏览器下载后释放，下载失败不留下暂存文件。 */
export async function deliver_web_file_material(material_id: string): Promise<void> {
  try {
    await download_web_file_material(material_id);
  } finally {
    await release_web_file_material(material_id);
  }
}
