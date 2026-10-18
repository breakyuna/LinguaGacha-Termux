import { useEffect, useRef, useState, type JSX } from "react";

import { subscribe_web_file_pick_requests } from "./picker-request-bus";
import type { WebFilePickIntent, WebFilePickResult } from "./picker-request-bus";
import { useAgentSavePathRequests } from "./agent-save-path-bridge";
import { WebFilePickerDialog } from "./web-file-picker-dialog";

type QueuedWebFilePickRequest = {
  request_id: number; // 同 mode 的连续请求也必须是新实例，界面状态不能跨请求继承
  intent: WebFilePickIntent;
  resolve: (result: WebFilePickResult) => void;
};

/**
 * 选择器宿主：订阅请求总线并维护排队，一次只渲染一个对话框。
 * 并发请求按到达顺序逐个呈现，调用方始终只等到自己的结果。
 * 同时承接 Agent 工作区的保存位置请求：后端驻留的保存确认经同一选择器交付。
 */
export function WebFilePickerHost(): JSX.Element | null {
  useAgentSavePathRequests();
  const [requests, set_requests] = useState<QueuedWebFilePickRequest[]>([]);
  const next_request_id_ref = useRef(0);

  useEffect(() => {
    return subscribe_web_file_pick_requests((intent, resolve) => {
      const request_id = next_request_id_ref.current + 1;
      next_request_id_ref.current = request_id;
      set_requests((previous_requests) => [...previous_requests, { request_id, intent, resolve }]);
    });
  }, []);

  const active_request = requests[0] ?? null;

  if (active_request === null) {
    return null;
  }

  /** 结算当前请求后立即让位给下一个，界面不叠加多个对话框。 */
  const handle_settle = (result: WebFilePickResult): void => {
    active_request.resolve(result);
    set_requests((previous_requests) => previous_requests.slice(1));
  };

  return (
    <WebFilePickerDialog
      key={active_request.request_id}
      intent={active_request.intent}
      on_settle={handle_settle}
    />
  );
}
