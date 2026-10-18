import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { WEB_ACCESS_SESSION_COOKIE_NAME } from "../../shared/backend-api";

export { WEB_ACCESS_SESSION_COOKIE_NAME }; // 网关与 renderer 共用同一 Cookie 名，避免两侧各持一份字面量

const CREDENTIAL_BYTES = 32; // 启动凭据熵，终端一次性展示，不进入日志与 URL 查询参数
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 单次启动会话有效期，服务重启即失效

export interface WebAccessSessionOptions {
  ttl_ms?: number;
  now?: () => number;
}

export interface WebAccessSessionCookie {
  token: string; // 只出现在 Set-Cookie 响应头，HttpOnly 阻止脚本读取
  max_age_seconds: number;
}

/**
 * Web 访问会话持有者。启动凭据一次性换 Cookie，服务停止时全部失效。
 */
export interface WebAccessSession {
  readonly credential: string;
  readonly cookie_name: string;
  issue_session_cookie(): WebAccessSessionCookie;
  read_cookie_token(cookie_header: string | null | undefined): string | null;
  is_authorized(cookie_header: string | null | undefined): boolean;
  revoke_all_sessions(): void;
}

/** 令牌只以摘要形式驻留内存，进程退出后无法还原。 */
function hash_session_token(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** 生成 URL 安全随机文本，避免启动凭据出现在日志时被 shell 或终端转义。 */
function create_random_token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function read_cookie_value(
  cookie_header: string | null | undefined,
  cookie_name: string,
): string | null {
  // Headers.get 在缺失时返回 null，统一按未提供处理。
  if (cookie_header === null || cookie_header === undefined) return null;
  for (const raw_pair of cookie_header.split(";")) {
    const pair = raw_pair.trim();
    const separator_index = pair.indexOf("=");
    if (separator_index <= 0) continue;
    if (pair.slice(0, separator_index).trim() !== cookie_name) continue;
    const value = pair.slice(separator_index + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * 建立本机启动到浏览器的访问会话；凭据比对使用定长比较，避免时序侧信道。
 */
export function create_web_access_session(options: WebAccessSessionOptions = {}): WebAccessSession {
  const ttl_ms = options.ttl_ms ?? DEFAULT_SESSION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const credential = create_random_token(CREDENTIAL_BYTES);
  const issued_tokens = new Map<string, number>(); // 令牌摘要 -> 过期时间戳

  const prune_expired_tokens = (): void => {
    const current_time = now();
    for (const [token_hash, expires_at] of issued_tokens) {
      if (expires_at <= current_time) issued_tokens.delete(token_hash);
    }
  };

  return {
    credential,
    cookie_name: WEB_ACCESS_SESSION_COOKIE_NAME,
    issue_session_cookie(): WebAccessSessionCookie {
      prune_expired_tokens();
      const token = create_random_token(SESSION_TOKEN_BYTES);
      issued_tokens.set(hash_session_token(token), now() + ttl_ms);
      return { token, max_age_seconds: Math.floor(ttl_ms / 1000) };
    },
    read_cookie_token(cookie_header) {
      return read_cookie_value(cookie_header, WEB_ACCESS_SESSION_COOKIE_NAME);
    },
    is_authorized(cookie_header) {
      const token = read_cookie_value(cookie_header, WEB_ACCESS_SESSION_COOKIE_NAME);
      if (token === null) return false;
      prune_expired_tokens();
      const expires_at = issued_tokens.get(hash_session_token(token));
      return expires_at !== undefined && expires_at > now();
    },
    revoke_all_sessions() {
      issued_tokens.clear();
    },
  };
}

/** 启动凭据与期望值做定长比较，长度不一致直接拒绝，避免时序侧信道。 */
export function is_matching_web_access_credential(
  presented_credential: string,
  expected_credential: string,
): boolean {
  const presented_buffer = Buffer.from(presented_credential, "utf8");
  const expected_buffer = Buffer.from(expected_credential, "utf8");
  if (presented_buffer.length !== expected_buffer.length) return false;
  return timingSafeEqual(presented_buffer, expected_buffer);
}
