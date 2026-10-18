import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AppError } from "../shared/error";
import { default_native_fs } from "./native-fs";

const CHROMIUM_LAUNCH_TIMEOUT_MS = 20_000; // 冷启动到 DevTools 端口就绪的上限
const CHROMIUM_PAGE_CALL_TIMEOUT_MS = 60_000; // 单次 CDP 调用上限，宿主自身另有任务级超时
const CHROMIUM_NAVIGATE_TIMEOUT_MS = 30_000; // data: 文档加载上限，超时按宿主错误收尾
const CHROMIUM_TERMINATE_GRACE_MS = 3_000; // SIGTERM 后等待自行退出的时间，超时升级为 SIGKILL
const CHROMIUM_PROFILE_CLEANUP_ATTEMPTS = 3; // 渲染子进程收尾期间仍可能写 profile，删除需要重试
const CHROMIUM_PROFILE_CLEANUP_DELAY_MS = 100;
const CHROMIUM_STDERR_KEEP_BYTES = 8_192; // 启动行只在开头出现，只保留尾部用于诊断

/**
 * 页面只允许进程内数据（`data:` / `blob:` 图片与字体），可离开本机的请求按协议拦截。
 * 通配 `*` 会把内嵌图片与字体一并拦掉，使打印静默回退到默认字体。
 */
export const CHROMIUM_BLOCKED_URL_PATTERNS = [
  "http://*",
  "https://*",
  "ws://*",
  "wss://*",
  "ftp://*",
  "ftps://*",
  "file://*",
] as const;

/**
 * Termux 与常见桌面位置的 Chromium 可执行文件候选。
 * 产品不内置浏览器，未找到时图片与 PDF 能力如实报告不可用。
 */
const CHROMIUM_EXECUTABLE_CANDIDATES = [
  "/data/data/com.termux/files/usr/bin/chromium-headless",
  "/data/data/com.termux/files/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
] as const;

/** 页面上下文能力，宿主只依赖解码执行、打印与导航这三项。 */
export interface ChromiumPage {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  print_to_pdf(options: {
    printBackground: boolean;
    preferCSSPageSize: boolean;
  }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** 页面来源。生产实现持有浏览器进程，测试可注入等价假实现。 */
export interface ChromiumPageSource {
  open_page(): Promise<ChromiumPage>;
  dispose(): Promise<void>;
}

export interface ChromiumBrowserOptions {
  executablePath: string;
  env?: NodeJS.ProcessEnv;
  launchTimeoutMs?: number;
  pageCallTimeoutMs?: number;
}

interface CdpCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type ChromiumPageEventListener = (method: string, params: unknown) => void;

/** 解析可用的 Chromium 可执行文件；找不到返回 null，由调用方按能力缺失处理。 */
export function resolve_chromium_executable_path(explicit?: string | null): string | null {
  if (typeof explicit === "string" && explicit !== "") {
    // 显式配置可以是绝对路径，也可以是 PATH 中的命令名。
    return path.isAbsolute(explicit)
      ? is_executable_file(explicit)
        ? explicit
        : null
      : resolve_from_path(explicit);
  }
  for (const candidate of CHROMIUM_EXECUTABLE_CANDIDATES) {
    if (path.isAbsolute(candidate)) {
      if (is_executable_file(candidate)) return candidate;
      continue;
    }
    const found = resolve_from_path(candidate);
    if (found !== null) return found;
  }
  return null;
}

function is_executable_file(candidate: string): boolean {
  try {
    return default_native_fs.stat(candidate).isFile();
  } catch {
    // 候选不存在或不可访问时继续尝试下一个，查找本身不视为错误。
    return false;
  }
}

/** 生成宿自有的临时 profile 目录；目录只由本宿主创建与删除。 */
function create_profile_directory(): string {
  const directory = path.join(tmpdir(), `lg-chromium-${randomUUID()}`);
  default_native_fs.make_dir(directory);
  return directory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 删除临时 profile。
 *
 * Chromium 的渲染子进程可能在父进程退出后仍在落盘，单次删除会以 `ENOTEMPTY` 竞争失败，因此重试。
 * 重试后仍失败时不再向上传播：遗留的只是系统临时目录，不影响"进程已终止"这一停止语义，
 * 而传播出去会把一次正常停止变成服务退出码 1。
 */
async function remove_profile_directory(directory: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await default_native_fs.remove_async(directory, { recursive: true, force: true });
      return;
    } catch {
      if (attempt >= CHROMIUM_PROFILE_CLEANUP_ATTEMPTS) return;
      await sleep(CHROMIUM_PROFILE_CLEANUP_DELAY_MS * attempt);
    }
  }
}

function resolve_from_path(name: string): string | null {
  const search_path = process.env["PATH"] ?? "";
  for (const directory of search_path.split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, name);
    if (is_executable_file(candidate)) return candidate;
  }
  return null;
}

/**
 * 持有单一 Chromium 进程的 CDP 页面来源。
 *
 * 进程按需启动：只有真正需要图片或 PDF 时才创建浏览器，基本文本启动不产生浏览器进程。
 * 每个页面是独立 target，宿主之间不共享渲染上下文；dispose 之后不再接受新页面。
 */
export class ChromiumBrowser implements ChromiumPageSource {
  private readonly executable_path: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly launch_timeout_ms: number;
  private readonly page_call_timeout_ms: number;

  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private profile_directory: string | null = null;
  private launch: Promise<void> | null = null;
  private next_id = 1;
  private readonly pending_calls = new Map<number, CdpCall>();
  private readonly page_listeners = new Map<string, ChromiumPageEventListener>();
  private disposed = false;
  private exit_error: Error | null = null;

  public constructor(options: ChromiumBrowserOptions) {
    this.executable_path = options.executablePath;
    this.env = options.env ?? process.env;
    this.launch_timeout_ms = options.launchTimeoutMs ?? CHROMIUM_LAUNCH_TIMEOUT_MS;
    this.page_call_timeout_ms = options.pageCallTimeoutMs ?? CHROMIUM_PAGE_CALL_TIMEOUT_MS;
  }

  /** 打开独立页面并接通调试会话；并发首用共享同一次启动。 */
  public async open_page(): Promise<ChromiumPage> {
    this.throw_if_unavailable();
    await this.ensure_started();
    const socket = this.require_socket();
    const created = (await this.call(socket, undefined, "Target.createTarget", {
      url: "about:blank",
    })) as { targetId: string };
    const attached = (await this.call(socket, undefined, "Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const session_id = attached.sessionId;
    // 打印与图片宿主只消费 data: 文档：按协议拦截可外联的请求，data: 与 blob:
    // 属于进程内数据（打印图片、内嵌字体），拦截它们会让图片与字体静默回退。
    await this.call(socket, session_id, "Network.enable");
    await this.call(socket, session_id, "Network.setBlockedURLs", {
      urls: [...CHROMIUM_BLOCKED_URL_PATTERNS],
    });
    await this.call(socket, session_id, "Page.enable");
    await this.call(socket, session_id, "Runtime.enable");
    return this.create_page(socket, created.targetId, session_id);
  }

  /** 终止浏览器进程并清理独立 profile；重复调用只执行一次。 */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const socket = this.socket;
    this.socket = null;
    const child = this.child;
    this.child = null;
    const profile_directory = this.profile_directory;
    this.profile_directory = null;
    this.page_listeners.clear();
    this.reject_pending_calls(
      new AppError("runtime.disposed", {
        diagnostic_context: { reason: "chromium_browser_disposed" },
      }),
    );
    socket?.close();
    await terminate_child(child);
    if (profile_directory !== null) {
      await remove_profile_directory(profile_directory);
    }
  }

  private create_page(socket: WebSocket, target_id: string, session_id: string): ChromiumPage {
    const events = new Map<string, PromiseWithResolvers<void>>();
    const listener: ChromiumPageEventListener = (method) => {
      const waiting = events.get(method);
      if (waiting === undefined) return;
      events.delete(method);
      waiting.resolve();
    };
    this.page_listeners.set(session_id, listener);
    const wait_for_event = (method: string): Promise<void> => {
      const waiting = Promise.withResolvers<void>();
      events.set(method, waiting);
      return waiting.promise;
    };
    return {
      navigate: async (url: string) => {
        this.throw_if_unavailable();
        const loaded = wait_for_event("Page.loadEventFired");
        const navigated = (await this.call(socket, session_id, "Page.navigate", { url })) as {
          errorText?: string;
        };
        if (typeof navigated.errorText === "string" && navigated.errorText !== "") {
          events.delete("Page.loadEventFired");
          throw new AppError("runtime.internal_invariant", {
            diagnostic_context: {
              reason: "chromium_navigate_failed",
              url_kind: url.slice(0, 5),
              error: navigated.errorText,
            },
          });
        }
        await this.with_call_timeout(loaded, CHROMIUM_NAVIGATE_TIMEOUT_MS, "Page.loadEventFired");
      },
      evaluate: async (expression: string) => {
        this.throw_if_unavailable();
        const result = (await this.call(socket, session_id, "Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        const failure = result.exceptionDetails;
        if (failure !== undefined) {
          throw new AppError("runtime.internal_invariant", {
            diagnostic_context: { reason: "chromium_page_evaluate_failed", details: failure },
          });
        }
        return result.result?.value;
      },
      print_to_pdf: async (options) => {
        this.throw_if_unavailable();
        const result = (await this.call(socket, session_id, "Page.printToPDF", {
          printBackground: options.printBackground,
          preferCSSPageSize: options.preferCSSPageSize,
        })) as { data?: string };
        if (typeof result.data !== "string") {
          throw new AppError("runtime.internal_invariant", {
            diagnostic_context: { reason: "chromium_print_pdf_empty" },
          });
        }
        return new Uint8Array(Buffer.from(result.data, "base64"));
      },
      close: async () => {
        this.page_listeners.delete(session_id);
        try {
          await this.call(socket, undefined, "Target.closeTarget", { targetId: target_id });
        } catch {
          // 页面随浏览器退出或崩溃已消失时关闭失败无害，队列继续由宿主推进。
        }
      },
    };
  }

  private throw_if_unavailable(): void {
    if (this.exit_error !== null) throw this.exit_error;
    if (this.disposed) {
      throw new AppError("runtime.disposed", {
        diagnostic_context: { reason: "chromium_browser_disposed" },
      });
    }
  }

  private require_socket(): WebSocket {
    const socket = this.socket;
    if (socket === null) {
      throw new AppError("runtime.internal_invariant", {
        diagnostic_context: { reason: "chromium_browser_socket_missing" },
      });
    }
    return socket;
  }

  private ensure_started(): Promise<void> {
    this.launch ??= this.launch_browser().catch((error: unknown) => {
      this.launch = null; // 启动失败允许后续重试，不把一次失败固化成永久状态
      throw error;
    });
    return this.launch;
  }

  private async launch_browser(): Promise<void> {
    const profile_directory = create_profile_directory();
    const child = spawn(this.executable_path, build_chromium_launch_arguments(profile_directory), {
      // 独立进程组：停止时按组发信号，Chromium 派生的渲染子进程随父进程一起收尾。
      detached: true,
      env: { ...this.env, LINGUAGACHA_CHROMIUM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.profile_directory = profile_directory;
    const release_child = async (): Promise<void> => {
      await terminate_child(child);
      this.child = null;
      await remove_profile_directory(profile_directory);
      this.profile_directory = null;
    };
    let stderr_tail = "";
    const websocket_url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new AppError("runtime.timeout", {
            diagnostic_context: { reason: "chromium_launch_timeout", stderr: stderr_tail },
          }),
        );
      }, this.launch_timeout_ms);
      const on_data = (chunk: Buffer | string) => {
        stderr_tail = (stderr_tail + String(chunk)).slice(-CHROMIUM_STDERR_KEEP_BYTES);
        const match = stderr_tail.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (match?.[1] === undefined) return;
        cleanup();
        resolve(match[1]);
      };
      const on_exit = (code: number | null) => {
        cleanup();
        reject(
          new AppError("runtime.internal_invariant", {
            diagnostic_context: {
              reason: "chromium_exited_before_ready",
              code,
              stderr: stderr_tail,
            },
          }),
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.stderr?.off("data", on_data);
        child.off("exit", on_exit);
      };
      child.stderr?.on("data", on_data);
      child.once("exit", on_exit);
    }).catch(async (error: unknown) => {
      await release_child();
      throw error;
    });

    child.on("exit", (code, signal) => {
      // 浏览器意外退出必须让在途调用立即失败，避免宿主队列留在永久等待中。
      this.exit_error = new AppError("runtime.internal_invariant", {
        diagnostic_context: { reason: "chromium_exited", code, signal },
      });
      this.socket = null;
      this.reject_pending_calls(this.exit_error);
    });

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const websocket = new WebSocket(websocket_url);
      const on_open = () => {
        cleanup();
        resolve(websocket);
      };
      const on_error = () => {
        cleanup();
        reject(
          new AppError("runtime.internal_invariant", {
            diagnostic_context: { reason: "chromium_debug_socket_failed" },
          }),
        );
      };
      const cleanup = () => {
        websocket.removeEventListener("open", on_open);
        websocket.removeEventListener("error", on_error);
      };
      websocket.addEventListener("open", on_open, { once: true });
      websocket.addEventListener("error", on_error, { once: true });
    }).catch(async (error: unknown) => {
      await release_child();
      throw error;
    });

    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      // 调试通道只承载文本帧，其余形态直接忽略。
      if (typeof event.data !== "string") return;
      this.handle_message(JSON.parse(event.data) as unknown);
    });
    socket.addEventListener("close", () => {
      this.socket = null;
      this.reject_pending_calls(
        new AppError("runtime.internal_invariant", {
          diagnostic_context: { reason: "chromium_debug_socket_closed" },
        }),
      );
    });
    this.socket = socket;
  }

  /** 分发 CDP 消息：响应按 id 归属调用，事件按 sessionId 归属页面。 */
  private handle_message(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as {
      id?: unknown;
      sessionId?: unknown;
      method?: unknown;
      error?: unknown;
      result?: unknown;
      params?: unknown;
    };
    if (typeof record.id === "number") {
      const call = this.pending_calls.get(record.id);
      if (call === undefined) return;
      this.pending_calls.delete(record.id);
      clearTimeout(call.timer);
      if (record.error !== undefined) {
        call.reject(
          new AppError("runtime.internal_invariant", {
            diagnostic_context: { reason: "chromium_cdp_error", error: record.error },
          }),
        );
        return;
      }
      call.resolve(record.result);
      return;
    }
    if (typeof record.sessionId !== "string" || typeof record.method !== "string") return;
    this.page_listeners.get(record.sessionId)?.(record.method, record.params);
  }

  private call(
    socket: WebSocket,
    session_id: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.throw_if_unavailable();
    const id = this.next_id++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending_calls.delete(id);
        reject(
          new AppError("runtime.timeout", {
            diagnostic_context: { reason: "chromium_cdp_timeout", method },
          }),
        );
      }, this.page_call_timeout_ms);
      this.pending_calls.set(id, { resolve, reject, timer });
      const payload =
        session_id === undefined
          ? { id, method, params }
          : { id, sessionId: session_id, method, params };
      socket.send(JSON.stringify(payload));
    });
  }

  /** 事件等待与 CDP 调用各自超时，取先到达的一方。 */
  private async with_call_timeout(
    waiting: Promise<void>,
    timeout_ms: number,
    method: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new AppError("runtime.timeout", {
            diagnostic_context: { reason: "chromium_event_timeout", method },
          }),
        );
      }, timeout_ms);
    });
    try {
      await Promise.race([waiting, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private reject_pending_calls(error: Error): void {
    for (const [id, call] of this.pending_calls) {
      clearTimeout(call.timer);
      this.pending_calls.delete(id);
      call.reject(error);
    }
  }
}

/**
 * 独立 profile 并禁用联网与同步：宿主只渲染本地 data: 文档，
 * 不继承用户浏览器数据，也不把本机浏览习惯带进编码与打印结果。
 */
export function build_chromium_launch_arguments(profile_directory: string): string[] {
  return [
    "--headless=new",
    "--no-sandbox", // Termux 与 rootless 容器没有 setuid sandbox；页面只加载 data: 文档且网络被拦截
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--metrics-recording-only",
    "--mute-audio",
    "--force-color-profile=srgb", // 画布与打印按 sRGB 采样，跨宿主结果一致
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile_directory}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", // 调试端口只监听回环，不对局域网暴露
    "about:blank",
  ];
}

/**
 * 向整个进程组发信号：Chromium 会派生子进程，只通知直接子进程会留下仍在写 profile 的渲染进程。
 * 进程组已不存在（进程先于我们退出）时退回单进程信号。
 */
function signal_child_group(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** 先给 Chromium 自行退出的机会，超时后强制结束，保证不遗留任务拥有的进程。 */
async function terminate_child(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  signal_child_group(child, "SIGTERM");
  const timed_out = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), CHROMIUM_TERMINATE_GRACE_MS);
  });
  if ((await Promise.race([exited, timed_out])) === "timeout") {
    signal_child_group(child, "SIGKILL");
    await exited;
  }
}
