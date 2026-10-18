import type { SystemProxyResolver } from "./system-proxy-http-client";

// Electron session 是桌面系统代理规则的唯一来源；Node 运行态改由进程环境变量承担同一契约。
const PROXY_URL_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "all_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

const NO_PROXY_ENVIRONMENT_KEYS = ["NO_PROXY", "no_proxy"] as const;

const DEFAULT_PROXY_PORTS: Record<"http:" | "https:" | "socks5:", number> = {
  "http:": 80,
  "https:": 443,
  "socks5:": 1080,
};

/**
 * 读取首个非空环境变量；大小写两种写法由桌面 shell 习惯决定，都可能是唯一配置。
 */
function read_first_environment_value(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = environment[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** 回环端点按既有系统代理语义保持直连，本机模型接口不经过外部代理。 */
function is_loopback_hostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.startsWith("127.")
  );
}

/** NO_PROXY 支持逗号分隔的主机与域名后缀，端口和协议前缀按无关信息忽略。 */
function matches_no_proxy(environment: NodeJS.ProcessEnv, hostname: string): boolean {
  const no_proxy = read_first_environment_value(environment, NO_PROXY_ENVIRONMENT_KEYS);
  if (no_proxy === null) return false;
  const normalized_hostname = hostname.toLowerCase();
  for (const raw_entry of no_proxy.split(",")) {
    const entry = raw_entry
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, "");
    if (entry === "") continue;
    if (entry === "*" || raw_entry.trim() === "*") return true;
    if (normalized_hostname === entry || normalized_hostname.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** 把环境变量中的代理地址转换成 parse_system_proxy_route 可消费的规则文本。 */
function build_proxy_rule(proxy_url_text: string): string | null {
  let proxy_url: URL;
  try {
    proxy_url = new URL(proxy_url_text);
  } catch {
    return null;
  }
  const scheme =
    proxy_url.protocol === "socks5:" || proxy_url.protocol === "socks:"
      ? "socks5:"
      : proxy_url.protocol;
  if (scheme !== "http:" && scheme !== "https:" && scheme !== "socks5:") return null;
  const port = proxy_url.port === "" ? String(DEFAULT_PROXY_PORTS[scheme]) : proxy_url.port;
  const authority = `${proxy_url.hostname}:${port}`;
  return scheme === "socks5:" ? `SOCKS5 ${authority}` : `PROXY ${authority}`;
}

/**
 * 构造 Node 运行态的系统代理解析端口；每次请求重新读取环境变量，不保存启动快照。
 */
export function create_node_system_proxy_resolver(
  options: {
    env?: NodeJS.ProcessEnv;
  } = {},
): SystemProxyResolver {
  const environment = options.env ?? process.env;
  return {
    resolveProxy: async (url, signal) => {
      signal?.throwIfAborted();
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return "DIRECT";
      }
      if (is_loopback_hostname(target.hostname)) return "DIRECT";
      if (matches_no_proxy(environment, target.hostname)) return "DIRECT";
      const proxy_url_text = read_first_environment_value(environment, PROXY_URL_ENVIRONMENT_KEYS);
      if (proxy_url_text === null) return "DIRECT";
      const rule = build_proxy_rule(proxy_url_text);
      return rule ?? "DIRECT";
    },
  };
}
