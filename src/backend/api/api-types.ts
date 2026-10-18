import type { JsonSnapshot } from "../../domain/json";
import type { ApiErrorEnvelope, ApiSuccessEnvelope } from "../../shared/error";

export type { ApiEnvelope, ApiErrorEnvelope, ApiSuccessEnvelope } from "../../shared/error";

export interface ApiGatewayStartResult {
  baseUrl: string;
  port: number; // 实际监听端口，Web 入口据此刻印访问地址与 Host 白名单
}

export function ok(data: JsonSnapshot): ApiSuccessEnvelope {
  return { ok: true, data };
}

export function api_error(args: ApiErrorEnvelope["error"]): ApiErrorEnvelope {
  return { ok: false, error: args };
}
