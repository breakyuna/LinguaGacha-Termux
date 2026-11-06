import type { ChromiumPageSource } from "./chromium-browser";
import { run_chromium_page_task } from "./chromium-page-task";
import {
  PDF_PRINT_ASSETS_READY_SCRIPT,
  PDF_PRINT_DOCUMENT_SCRIPT,
  PDF_PRINT_FIGURE_LAYOUT_SCRIPT,
  PDF_PRINT_STYLES_SCRIPT,
  build_pdf_print_html,
  build_pdf_print_styles,
} from "./pdf-print-shared";
import type { PDFHost } from "../shared/pdf";

const PDF_HOST_TIMEOUT_MS = 120_000;

/** 每次打印先落一个空文档，再写入调用方 HTML，避开 data: URL 长度上限。 */
const PDF_PRINT_BLANK_URL = "data:text/html;charset=utf-8,<html></html>";

/**
 * 用本机 Chromium 承担 HTML 打印，替代 Electron 隐藏窗口。
 * 任务串行且独占页面，前一任务回收完成后才释放队列，行为与 Electron 宿主一致。
 */
export function create_chromium_pdf_host(
  resources: {
    stylesPath: string; // 构建生成的内嵌数学样式。
    fontsDirectory: string; // 部署资源中的共享字体目录。
  },
  pages: ChromiumPageSource,
  options?: { timeoutMs?: number },
): PDFHost & { dispose: () => Promise<void> } {
  const timeout_ms = options?.timeoutMs ?? PDF_HOST_TIMEOUT_MS;
  let print_styles: string | null = null; // 宿主生命周期内复用固定版本的字体与数学样式。
  let tail: Promise<unknown> = Promise.resolve(); // 前一任务回收后才能打开下一页面
  const lifetime = new AbortController(); // 关闭宿主时取消活动及排队任务
  /** 串行执行打印，排队取消在取得页面前完成。 */
  const host: PDFHost = async (operation, signal) => {
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    combined.throwIfAborted();
    // 排队取消立即返回。开始执行后由页面任务确认回收。
    const cancelled = Promise.withResolvers<never>();
    const cancel_queued = () => cancelled.reject(combined.reason); // 开始执行时移交取消责任
    combined.addEventListener("abort", cancel_queued, { once: true });
    const result = tail.then(async () => {
      combined.removeEventListener("abort", cancel_queued);
      combined.throwIfAborted();
      const page = await pages.open_page();
      return await run_chromium_page_task(page, combined, timeout_ms, async (step) => {
        print_styles ??= build_pdf_print_styles(resources);
        // 每次加载新文档，CSP 在调用方内容前生效，页面不能执行脚本或请求外部资源。
        const html = build_pdf_print_html(operation.html);
        await step("load", () => page.navigate(PDF_PRINT_BLANK_URL));
        await step("document", () => page.evaluate(PDF_PRINT_DOCUMENT_SCRIPT(html)));
        await step("styles", () => page.evaluate(PDF_PRINT_STYLES_SCRIPT(print_styles ?? "")));
        await step("assets", () => page.evaluate(PDF_PRINT_ASSETS_READY_SCRIPT));
        await step("layout", () => page.evaluate(PDF_PRINT_FIGURE_LAYOUT_SCRIPT));
        return await step("print", () =>
          page.print_to_pdf({ printBackground: true, preferCSSPageSize: true }),
        );
      });
    });
    tail = result.catch(() => undefined); // 错误已通过 result 返回，后续打印仍可重新创建页面。
    try {
      return await Promise.race([result, cancelled.promise]);
    } finally {
      combined.removeEventListener("abort", cancel_queued);
    }
  };
  return Object.assign(host, {
    /** 先取消活动任务并排空队列，再结束浏览器进程。 */
    dispose: async () => {
      lifetime.abort();
      await tail;
      await pages.dispose();
    },
  });
}
