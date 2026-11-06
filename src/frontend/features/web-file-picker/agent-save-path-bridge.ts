import { useCallback, useEffect, useRef } from "react";

import { AGENT_SAVE_PATH_EVENT_TOPIC } from "@shared/agent";
import { api_fetch, open_event_stream } from "@frontend/app/desktop/desktop-api";
import { request_web_file_pick } from "./picker-request-bus";

/** 迟连接时领取的驻留请求形状，与后端 pending 列表一致。 */
type PendingSavePathRequest = {
  request_id: string;
  default_name: string;
};

/** SSE 载荷只关心身份与默认名，其余字段忽略。 */
function read_save_path_event(payload: unknown): PendingSavePathRequest | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record["type"] !== "requested") return null;
  const request_id = record["request_id"];
  const default_name = record["default_name"];
  if (typeof request_id !== "string" || request_id === "") return null;
  return { request_id, default_name: typeof default_name === "string" ? default_name : "" };
}

/**
 * Agent 工作区保存位置桥接：把后端驻留的保存请求呈现为应用内选择器，
 * 用户确认或取消后经 REST 应答，桥接宿主放行工作区保存。
 * 浏览器不在线时请求驻留，连接后先领取 pending 列表再接收增量。
 */
export function useAgentSavePathRequests(): void {
  // 同一请求只处理一次：SSE 增量与 pending 领取可能重叠，重试不重复弹选择器。
  const handled_request_ids_ref = useRef<Set<string>>(new Set());

  const handle_request = useCallback(async (request: PendingSavePathRequest): Promise<void> => {
    if (handled_request_ids_ref.current.has(request.request_id)) return;
    handled_request_ids_ref.current.add(request.request_id);

    let destination: string | null = null;
    try {
      const result = await request_web_file_pick({
        mode: "save",
        default_name: request.default_name,
      });
      destination = result.canceled ? null : (result.paths[0] ?? null);
    } catch {
      destination = null; // 选择器不可用按取消应答，工作区保存不悬挂
    }

    try {
      await api_fetch<Record<string, never>>("/api/agent/save-path/respond", {
        request_id: request.request_id,
        path: destination,
      });
    } catch {
      // 应答失败只让本次保存按取消收尾；请求已从桥接宿主移除，不影响后续保存。
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    /** 迟连接领取：先读驻留列表，再挂增量监听，避免恢复窗口丢请求。 */
    void (async (): Promise<void> => {
      try {
        // 领取与应答同属 POST 契约：GET 会被路由判为不存在，迟连接请求永远领不到。
        const payload = await api_fetch<{ requests?: unknown }>("/api/agent/save-path/pending", {});
        const requests = Array.isArray(payload.requests) ? payload.requests : [];
        for (const request of requests) {
          const parsed = read_save_path_event({ type: "requested", ...(request as object) });
          if (parsed !== null && !cancelled) await handle_request(parsed);
        }
      } catch {
        // pending 领取失败不阻塞增量监听：桌面入口该路径按能力缺失回答，属于预期。
      }
    })();

    const event_source = open_event_stream();
    const listener = ((event: MessageEvent<string>): void => {
      try {
        const parsed = read_save_path_event(JSON.parse(event.data) as unknown);
        if (parsed !== null) void handle_request(parsed);
      } catch {
        // 单个事件解析失败不影响后续请求。
      }
    }) as EventListener;
    event_source.addEventListener(AGENT_SAVE_PATH_EVENT_TOPIC, listener);

    return () => {
      cancelled = true;
      event_source.removeEventListener(AGENT_SAVE_PATH_EVENT_TOPIC, listener);
      event_source.close();
    };
  }, [handle_request]);
}
