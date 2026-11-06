import type { ChromiumPage } from "./chromium-browser";

type ChromiumPageTaskStep = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/**
 * 单次任务独占页面，与窗口任务同构。
 * 页面关闭后 Chromium 的脚本 Promise 可能悬挂，各阶段通过 step 等待，
 * 外部取消、超时都收敛为同一次页面释放。
 */
export async function run_chromium_page_task<T>(
  page: ChromiumPage,
  signal: AbortSignal,
  timeout_ms: number,
  run: (step: ChromiumPageTaskStep) => Promise<T>,
): Promise<T> {
  const lifetime = new AbortController(); // 超时与提前关闭共用终止信号
  const combined = AbortSignal.any([signal, lifetime.signal]);
  let stage = "start"; // 异常定位到最后进入的宿主阶段
  const stopped = Promise.withResolvers<never>(); // 结束当前阶段对 Chromium 的等待
  /** 保留触发取消的一方提供的原因。 */
  const abort = () => stopped.reject(combined.reason);
  combined.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () =>
      lifetime.abort(
        new DOMException(`Chromium page task timed out during ${stage}.`, "TimeoutError"),
      ),
    timeout_ms,
  );
  /** 执行前和结果交付前检查取消，防止迟到结果启动后续阶段。 */
  const step: ChromiumPageTaskStep = async (name, action) => {
    combined.throwIfAborted();
    stage = name;
    const settled = action();
    settled.catch(() => undefined); // 取消后放弃的阶段结果不再上报，避免未处理拒绝
    const value = await Promise.race([settled, stopped.promise]);
    combined.throwIfAborted();
    return value;
  };
  try {
    return await run(step);
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener("abort", abort);
    await page.close(); // 页面必须释放，后续任务才能取得干净的渲染上下文
  }
}
