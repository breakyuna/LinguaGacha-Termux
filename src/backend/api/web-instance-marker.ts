import path from "node:path";

import { is_json_record } from "../../domain/json";
import { default_native_fs, type NativeFs } from "../../native/native-fs";
import type { WebInstanceMarker } from "../../shared/backend-api";

/** 数据根下的独占实例标记文件名；只承载提示事实，不作为跨进程互斥锁使用。 */
export const WEB_INSTANCE_MARKER_FILE_NAME = "web-instance.json";

/**
 * 陈旧标记只重试一次：第二次仍被占用说明真的撞上了存活实例，
 * 继续重试只会把并发启动变成争抢，与提示用途不符。
 */
const MAX_ACQUIRE_ATTEMPTS = 2;

/**
 * 空文件或半行内容可能只是并发实例还没写完：短重试后再判定陈旧，
 * 避免把对方刚拿到的占位当成残留删掉。
 */
const MARKER_READ_MAX_ATTEMPTS = 3;
const MARKER_READ_RETRY_DELAY_MS = 10;

export interface WebInstanceMarkerFileOptions {
  dataRoot: string;
  nativeFs?: NativeFs; // 测试注入临时目录上的门面，生产代码共用默认实例
}

export interface AcquireWebInstanceMarkerOptions extends WebInstanceMarkerFileOptions {
  port: number; // 真实监听端口，第二实例据此提示另一实例的访问地址
  pid: number;
  started_at: string; // ISO 8601 启动时间
}

export type WebInstanceMarkerAcquisition =
  | { status: "acquired"; marker: WebInstanceMarker } // 本实例持有标记，停止时负责删除
  | { status: "conflict"; existing: WebInstanceMarker } // 标记属于存活进程，仅提示不阻止启动
  | { status: "unavailable"; reason: string }; // 标记不可用不影响本次启动，只是没有多实例提示

/**
 * 在数据根下占位实例标记。排他创建由 NativeFs 的 wx 标志在一次系统调用内完成，
 * 并发启动只有一个进程能拿到句柄，其余进程读到存活标记后按第二实例提示。
 */
export async function acquire_web_instance_marker(
  options: AcquireWebInstanceMarkerOptions,
): Promise<WebInstanceMarkerAcquisition> {
  try {
    return await acquire_marker_in_data_root(options);
  } catch (error) {
    // 数据根不可写等异常只让提示降级，服务本身继续启动。
    return { status: "unavailable", reason: `open_failed:${read_error_code(error)}` };
  }
}

/**
 * 优雅停止时删除本实例创建的标记。只按 pid 匹配删除：
 * 陈旧标记被其它实例覆盖后归属已经变更，无条件删除会删掉别人的标记。
 */
export async function release_web_instance_marker(
  options: WebInstanceMarkerFileOptions & { pid: number },
): Promise<void> {
  const native_fs = options.nativeFs ?? default_native_fs;
  const file_path = path.join(options.dataRoot, WEB_INSTANCE_MARKER_FILE_NAME);
  const existing = await read_web_instance_marker(native_fs, file_path);
  if (existing === null || existing.pid !== options.pid) return;
  await remove_marker_file(native_fs, file_path);
}

/** 占位、读取判定与陈旧重建都在这里完成，异常由入口归一为不可用。 */
async function acquire_marker_in_data_root(
  options: AcquireWebInstanceMarkerOptions,
): Promise<WebInstanceMarkerAcquisition> {
  const native_fs = options.nativeFs ?? default_native_fs;
  const file_path = path.join(options.dataRoot, WEB_INSTANCE_MARKER_FILE_NAME);
  const own_marker: WebInstanceMarker = {
    pid: options.pid,
    port: options.port,
    started_at: options.started_at,
  };
  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const opened = await open_marker_exclusive(native_fs, file_path);
    if (opened === null) {
      const existing = await read_web_instance_marker_with_retry(native_fs, file_path);
      // 标记记录本进程 PID 时不可能是另一存活实例，按陈旧处理。
      if (existing !== null && existing.pid !== options.pid && is_process_alive(existing.pid)) {
        return { status: "conflict", existing };
      }
      // 标记所属进程已停止或内容不可解析：陈旧标记，删除后重试占位。
      if (!(await remove_marker_file(native_fs, file_path))) {
        return { status: "unavailable", reason: "stale_marker_not_removed" };
      }
      continue;
    }
    try {
      await opened.writeFile(JSON.stringify(own_marker), "utf-8");
      return { status: "acquired", marker: own_marker };
    } catch (error) {
      // 半成品标记会让后续启动反复重写，这里立即删除并报告不可用。
      await remove_marker_file(native_fs, file_path);
      return { status: "unavailable", reason: `write_failed:${read_error_code(error)}` };
    } finally {
      await opened.close();
    }
  }
  return { status: "unavailable", reason: "marker_contended" };
}

/** 只承担排他创建：标记已存在归一为 null，其它错误原样抛出交由入口转成不可用。 */
async function open_marker_exclusive(native_fs: NativeFs, file_path: string) {
  try {
    return await native_fs.open_file(file_path, "wx");
  } catch (error) {
    if (read_error_code(error) === "EEXIST") return null;
    throw error;
  }
}

/** 读取并校验标记内容；写入中途崩溃留下的空文件或半行 JSON 都按无标记处理。 */
async function read_web_instance_marker(
  native_fs: NativeFs,
  file_path: string,
): Promise<WebInstanceMarker | null> {
  let text: string;
  try {
    text = native_fs.read_text_file(file_path);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!is_json_record(parsed)) return null;
  const { pid, port, started_at } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (typeof port !== "number" || !Number.isInteger(port)) return null;
  if (typeof started_at !== "string" || started_at === "") return null;
  return { pid, port, started_at };
}

/** 占位创建与内容写入之间有瞬时空文件窗口，这里重试到内容落稳再下结论。 */
async function read_web_instance_marker_with_retry(
  native_fs: NativeFs,
  file_path: string,
): Promise<WebInstanceMarker | null> {
  for (let attempt = 1; attempt <= MARKER_READ_MAX_ATTEMPTS; attempt += 1) {
    const marker = await read_web_instance_marker(native_fs, file_path);
    if (marker !== null) return marker;
    if (attempt === MARKER_READ_MAX_ATTEMPTS) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, MARKER_READ_RETRY_DELAY_MS));
  }
  return null;
}

/** 尽力删除标记；文件缺失或无权删除都不该阻断调用方的停止与重试流程。 */
async function remove_marker_file(native_fs: NativeFs, file_path: string): Promise<boolean> {
  try {
    await native_fs.remove_async(file_path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 按信号探测判定进程存活。
 * PID 复用是已知局限：已停止实例的 PID 可能被无关进程占用，从而误报第二实例；
 * 该标记只产生一条可关闭的提示，不参与互斥，误报代价可接受。
 */
function is_process_alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但当前用户无权发送信号，同样按存活判定。
    return read_error_code(error) === "EPERM";
  }
}

/** 统一读取错误码，缺失时给出可诊断的占位值。 */
function read_error_code(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}
