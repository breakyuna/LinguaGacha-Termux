import { BrowserWindow, session, type Session } from "electron";
import { randomUUID } from "node:crypto";

import type { PDFHost } from "../shared/pdf";
import { run_window_task } from "./window-task";
import {
  PDF_PRINT_ASSETS_READY_SCRIPT,
  PDF_PRINT_DOCUMENT_SCRIPT,
  PDF_PRINT_FIGURE_LAYOUT_SCRIPT,
  PDF_PRINT_STYLES_SCRIPT,
  build_pdf_print_html,
  build_pdf_print_styles,
} from "./pdf-print-shared";

const PDF_HOST_TIMEOUT_MS = 120_000;

/** Electron 只拥有 HTML 打印。任务串行且独占窗口，回收完成后才释放队列。 */
export function create_pdf_host(resources: {
  stylesPath: string; // 构建生成的内嵌数学样式。
  fontsDirectory: string; // GUI 注入开发或发行资源中的共享字体目录。
}): PDFHost & { dispose: () => Promise<void> } {
  let print_styles: string | null = null; // 宿主生命周期内复用固定版本的字体与数学样式。
  let tail: Promise<unknown> = Promise.resolve(); // 前一任务回收后才能创建下一窗口
  const lifetime = new AbortController(); // 关闭宿主时取消活动及排队任务
  let browser_session: Session | null = null; // GUI 组合根早于 app.ready，首次打印才创建原生资源。
  /** 串行执行打印，排队取消在取得窗口前完成。 */
  const host: PDFHost = async (operation, signal) => {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    combined.throwIfAborted();
    // 排队取消立即返回。开始执行后由窗口任务确认回收。
    const cancelled = Promise.withResolvers<never>();
    const cancel_queued = () => cancelled.reject(combined.reason); // 开始执行时移交取消责任
    combined.addEventListener("abort", cancel_queued, { once: true });
    const result = tail.then(async () => {
      combined.removeEventListener("abort", cancel_queued);
      combined.throwIfAborted();
      if (!browser_session) {
        browser_session = session.fromPartition(`pdf-print-${randomUUID()}`, { cache: false });
        browser_session.webRequest.onBeforeRequest((details, callback) =>
          callback({ cancel: !details.url.startsWith("data:") }),
        );
        browser_session.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        );
      }
      const current = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser_session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      current.webContents.on("will-navigate", (event) => event.preventDefault());
      return await run_window_task(current, combined, PDF_HOST_TIMEOUT_MS, async (step) => {
        // 只读取应用自带的固定字体，首次打印时编码并缓存，发行包与 UI 共用一份文件。
        print_styles ??= build_pdf_print_styles(resources);
        // 每次加载新文档，CSP 在调用方内容前生效，页面不能执行脚本或请求外部资源。
        const html = build_pdf_print_html(operation.html);
        await step("load", () => current.loadURL("data:text/html;charset=utf-8,<html></html>"));
        // 图片内嵌的 HTML 可能很大，通过脚本参数传递以避开导航 URL 长度限制。
        await step("document", () =>
          current.webContents.executeJavaScript(PDF_PRINT_DOCUMENT_SCRIPT(html)),
        );
        // 宿主注入共享样式，调用方只提供文档 HTML。
        await step("styles", () =>
          current.webContents.executeJavaScript(PDF_PRINT_STYLES_SCRIPT(print_styles ?? "")),
        );
        await step("assets", () =>
          current.webContents.executeJavaScript(PDF_PRINT_ASSETS_READY_SCRIPT),
        );
        // 按已加载字体测量图注及紧邻标题，整组预留空间。长图注允许在前三行之后自然分页。
        await step("layout", () =>
          current.webContents.executeJavaScript(PDF_PRINT_FIGURE_LAYOUT_SCRIPT),
        );
        const bytes = await step("print", () =>
          current.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
          }),
        );
        return new Uint8Array(bytes);
      });
    });
    tail = result.catch(() => undefined); // 错误已通过 result 返回，后续打印仍可重新创建窗口。
    try {
      return await Promise.race([result, cancelled.promise]);
    } finally {
      combined.removeEventListener("abort", cancel_queued);
    }
  };
  return Object.assign(host, {
    /** 先取消活动任务并排空队列，再释放会话持有的资源。 */
    dispose: async () => {
      lifetime.abort();
      await tail;
      browser_session?.webRequest.onBeforeRequest(null);
      await browser_session?.clearStorageData();
    },
  });
}
