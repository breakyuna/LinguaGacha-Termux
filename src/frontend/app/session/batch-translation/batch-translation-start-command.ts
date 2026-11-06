import { api_fetch, DesktopApiError } from "@frontend/app/desktop/desktop-api";
import {
  is_active_batch_translation_status,
  type BatchTranslationSnapshot,
} from "@domain/batch-translation";
import {
  normalize_batch_translation_snapshot,
  type BatchTranslationPayload,
} from "@shared/batch-translation/batch-translation";

/**
 * start 路由在快照载荷之外返回受理事实：重复提交同一命令身份只回放既有快照。
 */
export type BatchTranslationStartAck = BatchTranslationPayload & {
  accepted?: boolean;
  duplicate?: boolean;
  command_id?: string;
};

/**
 * 回包丢失后重查快照的三种结论：已受理、确认未受理、结果不确定。
 */
export type BatchTranslationAcceptanceProbe =
  | { outcome: "accepted"; snapshot: BatchTranslationSnapshot }
  | { outcome: "rejected" }
  | { outcome: "unknown" };

/**
 * 网络失败或响应不可解析时命令结果不确定，需要重查快照确认；
 * 明确的请求错误（如运行互斥拒绝）保持原有失败反馈。
 */
export function is_uncertain_batch_translation_start_error(error: unknown): boolean {
  return (
    error instanceof DesktopApiError &&
    (error.code === "network_failed" || error.code === "http_error")
  );
}

/**
 * 重查任务快照判断命令是否已被受理：活跃态说明运行已存在，
 * 查询本身失败时无法结论，由调用方保留命令身份供下一次提交去重。
 */
export async function probe_batch_translation_acceptance(): Promise<BatchTranslationAcceptanceProbe> {
  try {
    const task_payload = await api_fetch<BatchTranslationPayload>(
      "/api/batch-translation/snapshot",
      {},
    );
    const snapshot = normalize_batch_translation_snapshot(task_payload);
    return is_active_batch_translation_status(snapshot.status)
      ? { outcome: "accepted", snapshot }
      : { outcome: "rejected" };
  } catch {
    return { outcome: "unknown" };
  }
}
