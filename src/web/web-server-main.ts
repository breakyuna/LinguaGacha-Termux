import { run_web_entry, type WebEntryRunResult } from "./web-entry";

/**
 * Web 服务进程入口；只负责信号接管与退出码，后端生命周期由 run_web_entry 拥有。
 */
async function main(): Promise<void> {
  let run_result: WebEntryRunResult | null = null;
  let shutdown_promise: Promise<void> | null = null;

  const shutdown = (exit_code: number): Promise<void> => {
    if (shutdown_promise !== null) return shutdown_promise;
    // 先保存 Promise 再收尾，重复信号共用同一次停止流程。
    shutdown_promise = Promise.resolve().then(async () => {
      try {
        await run_result?.stop();
      } catch (error) {
        process.stderr.write(`[shutdown] ${error instanceof Error ? error.message : String(error)}\n`);
        exit_code = 1;
      } finally {
        process.exit(exit_code);
      }
    });
    return shutdown_promise;
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[fatal] ${error instanceof Error ? error.stack : String(error)}\n`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[fatal] ${reason instanceof Error ? reason.stack : String(reason)}\n`);
    void shutdown(1);
  });

  run_result = await run_web_entry({ argv: process.argv.slice(2), moduleUrl: import.meta.url });
}

void main().catch((error: unknown) => {
  process.stderr.write(`[startup] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
