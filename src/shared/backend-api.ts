export const BACKEND_API_HOST = "127.0.0.1"; // Backend API 只监听本机 IPv4 回环地址，renderer 通过 preload 获得完整 base URL

// Web 访问会话 Cookie 名；一次性启动凭据换来的会话令牌，服务端与 renderer 共用同一名称
export const WEB_ACCESS_SESSION_COOKIE_NAME = "lg_web_session";

/**
 * 数据根下独占实例标记的内容，同时作为 /api/web/bootstrap 中另一实例提示的载荷形状。
 * 该事实只服务于界面提醒：同数据根多实例仍可并存，跨进程写入由数据库修订冲突检测收敛。
 */
export type WebInstanceMarker = {
  pid: number;
  port: number;
  started_at: string; // ISO 8601 启动时间
};

const BACKEND_API_BASE_URL_ARG_PREFIX = "--backend-api-base-url=";

// base URL 在进入 renderer 前统一去掉尾部斜杠，避免调用层重复处理路径拼接
export function normalize_backend_api_base_url(base_url: string): string {
  return base_url.trim().replace(/\/+$/u, "");
}

// API 端口分配器只负责端口可用性，公开访问地址由桌面契约层统一构造
export function build_backend_api_base_url(port: number): string {
  return `http://${BACKEND_API_HOST}:${port.toString()}`;
}

// main 通过 BrowserWindow additionalArguments 注入地址，preload 只解析这一条显式契约
export function build_backend_api_base_url_argument(base_url: string): string {
  return `${BACKEND_API_BASE_URL_ARG_PREFIX}${normalize_backend_api_base_url(base_url)}`;
}

// 缺失或为空的启动参数表示窗口创建顺序错误，必须立即失败而不是猜测默认端口
export function resolve_backend_api_base_url_from_argv(argv: readonly string[]): string {
  const matched_argument = argv.find((argument) =>
    argument.startsWith(BACKEND_API_BASE_URL_ARG_PREFIX),
  );

  if (matched_argument === undefined) {
    throw new Error("Backend API base URL launch argument is missing.");
  }

  const base_url = normalize_backend_api_base_url(
    matched_argument.slice(BACKEND_API_BASE_URL_ARG_PREFIX.length),
  );
  if (base_url === "") {
    throw new Error("Backend API base URL launch argument is empty.");
  }

  return base_url;
}
