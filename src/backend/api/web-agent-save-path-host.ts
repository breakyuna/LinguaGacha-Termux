import { randomUUID } from "node:crypto";

import { AGENT_SAVE_PATH_EVENT_TOPIC } from "../../shared/agent";
import type { JsonRecord } from "../../domain/json";
import { AppError } from "../../shared/error";

/** 待处理保存请求的公开形状；身份是应答关联的唯一依据。 */
export type AgentSavePathRequest = {
  request_id: string;
  default_name: string;
};

/** 默认驻留时长：浏览器可能长时间不在线，超时只释放等待，不产生副作用。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

type PendingRequest = {
  request_id: string;
  default_name: string;
  resolve: (destination: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type WebAgentSavePathHost = {
  /** 请求浏览器选择保存位置；取消、超时与无浏览器在线都返回 null。 */
  request_save_path: (default_name: string) => Promise<string | null>;
  /** 迟连接的浏览器领取驻留请求。 */
  list_pending_requests: () => AgentSavePathRequest[];
  /** 应答驻留请求；身份未知时返回 false，调用方据此报告失效。 */
  respond_to_request: (request_id: string, destination: string | null) => boolean;
  /** 释放全部驻留请求；服务停止时调用，等待方按取消收尾。 */
  dispose: () => void;
};

export type WebAgentSavePathHostOptions = {
  publish: (topic: string, payload: JsonRecord) => void;
  timeout_ms?: number;
};

/**
 * Web 传输的保存位置宿主：把 Agent 工作区的保存确认桥接到浏览器选择器。
 * 桌面入口仍走原生对话框，本宿主只在 Web 组合根创建。
 */
export function create_web_agent_save_path_host(
  options: WebAgentSavePathHostOptions,
): WebAgentSavePathHost {
  const timeout_ms = options.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  const publish = (type: "requested" | "resolved", request: AgentSavePathRequest): void => {
    options.publish(AGENT_SAVE_PATH_EVENT_TOPIC, {
      type,
      request_id: request.request_id,
      default_name: request.default_name,
    } satisfies JsonRecord);
  };

  const settle = (request_id: string, destination: string | null): boolean => {
    const entry = pending.get(request_id);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    pending.delete(request_id);
    entry.resolve(destination);
    return true;
  };

  return {
    request_save_path: (default_name: string) => {
      if (disposed) return Promise.resolve(null);
      const request_id = randomUUID();
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          // 超时按取消收尾：调用方已经等待过用户，不重复打扰。
          pending.delete(request_id);
          resolve(null);
        }, timeout_ms);
        timer.unref();
        pending.set(request_id, { request_id, default_name, resolve, timer });
        publish("requested", { request_id, default_name });
      });
    },
    list_pending_requests: () =>
      [...pending.values()].map((entry) => ({
        request_id: entry.request_id,
        default_name: entry.default_name,
      })),
    respond_to_request: (request_id: string, destination: string | null) => {
      const entry = pending.get(request_id);
      if (entry === undefined) return false;
      settle(request_id, destination);
      publish("resolved", { request_id, default_name: entry.default_name });
      return true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const request_id of [...pending.keys()]) settle(request_id, null);
    },
  };
}

/** 应答体收窄：路径必须是字符串或显式 null，其它形状按参数错误拒绝。 */
export function read_save_path_response(body: JsonRecord): string | null {
  const raw = body["path"];
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new AppError("request.validation_failed", {
      public_details: { reason: "invalid_save_path_response" },
    });
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
