import { useEffect } from "react";
import { dismiss_toast, push_toast } from "@frontend/app/feedback/desktop-toast";
import { read_injected_web_host_bootstrap } from "@frontend/app/host/host-bridge";
import { useI18n } from "@frontend/app/locale/locale-context";

const INSTANCE_CONFLICT_TOAST_ID = "web-instance-conflict";

/**
 * 同数据根第二个实例的提示。服务端在启动配置里报告一次事实，
 * 这里转成可关闭的通知，不阻塞当前实例继续运行。
 */
export function WebInstanceConflictToast(): null {
  const { t } = useI18n();
  // 启动配置由入口文档内联注入，是页面加载时唯一的实例事实来源。
  const another_instance = read_injected_web_host_bootstrap()?.anotherInstance ?? null;

  useEffect(() => {
    if (another_instance === null) return;
    push_toast(
      "warning",
      t("app.web_instance.conflict", {
        PID: String(another_instance.pid),
        PORT: String(another_instance.port),
      }),
      { id: INSTANCE_CONFLICT_TOAST_ID, dismissible: true },
    );
  }, [another_instance, t]);

  useEffect(
    () => () => {
      dismiss_toast(INSTANCE_CONFLICT_TOAST_ID);
    },
    [],
  );

  return null;
}
