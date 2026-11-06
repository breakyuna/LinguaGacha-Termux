import { describe, expect, it } from "vitest";

import {
  WEB_ACCESS_SESSION_COOKIE_NAME,
  create_web_access_session,
  is_matching_web_access_credential,
} from "./web-access-session";

const TTL_MS = 60_000;

function create_session_at(start_time: number) {
  let current_time = start_time;
  const session = create_web_access_session({
    ttl_ms: TTL_MS,
    now: () => current_time,
  });
  return {
    session,
    advance: (duration_ms: number) => {
      current_time += duration_ms;
    },
  };
}

describe("web access session", () => {
  it("凭据一次性换取会话 Cookie，重复建立不产生第二枚令牌", () => {
    const { session } = create_session_at(0);

    expect(session.credential).not.toBe("");
    expect(session.cookie_name).toBe(WEB_ACCESS_SESSION_COOKIE_NAME);

    const issued = session.issue_session_cookie();
    const cookie_header = `${session.cookie_name}=${issued.token}`;

    expect(issued.max_age_seconds).toBe(60);
    expect(session.is_authorized(cookie_header)).toBe(true);
    expect(session.is_authorized(`${session.cookie_name}=not-issued`)).toBe(false);
    expect(session.is_authorized(null)).toBe(false);
    expect(session.is_authorized(undefined)).toBe(false);
    expect(session.read_cookie_token(cookie_header)).toBe(issued.token);
    // 同名 Cookie 取首个匹配值，其余条目不参与解析。
    expect(session.read_cookie_token(`${WEB_ACCESS_SESSION_COOKIE_NAME}=other; keep=1`)).toBe(
      "other",
    );
    expect(session.read_cookie_token("keep=1")).toBeNull();
  });

  it("过期令牌失效，全部撤销后已发令牌同时失效", () => {
    const { session, advance } = create_session_at(0);
    const issued = session.issue_session_cookie();
    const cookie_header = `${session.cookie_name}=${issued.token}`;

    advance(TTL_MS + 1);
    expect(session.is_authorized(cookie_header)).toBe(false);

    const second = session.issue_session_cookie();
    expect(session.is_authorized(`${session.cookie_name}=${second.token}`)).toBe(true);
    session.revoke_all_sessions();
    expect(session.is_authorized(`${session.cookie_name}=${second.token}`)).toBe(false);
  });

  it("凭据比对拒绝长度不同与内容不同的输入", () => {
    expect(is_matching_web_access_credential("abc", "abc")).toBe(true);
    expect(is_matching_web_access_credential("abc", "abd")).toBe(false);
    expect(is_matching_web_access_credential("abc", "abcd")).toBe(false);
    expect(is_matching_web_access_credential("", "")).toBe(true);
  });
});
