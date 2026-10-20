import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { WebHostBootstrap } from "@frontend/app/host/host-bridge";
import { create_text_resolver } from "@shared/i18n";
import { LocaleContext } from "@frontend/app/locale/locale-context";
import { WebInstanceConflictToast } from "./web-instance-conflict-toast";

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }));
afterEach(() => {
  vi.clearAllMocks();
  delete (window as unknown as { __LG_WEB_BOOTSTRAP__?: unknown }).__LG_WEB_BOOTSTRAP__;
});

const ANOTHER_INSTANCE = { pid: 4321, port: 5555, started_at: "2026-10-18T09:30:00.000Z" };

/** 按服务端注入形状写启动配置，只改变另一实例事实。 */
function inject_bootstrap(another_instance: WebHostBootstrap["anotherInstance"]): void {
  (window as unknown as { __LG_WEB_BOOTSTRAP__?: unknown }).__LG_WEB_BOOTSTRAP__ = {
    appVersion: "1.2.3",
    shell: {},
    backendApi: { baseUrl: "http://127.0.0.1:38191" },
    capabilities: {},
    session: { established: true },
    anotherInstance: another_instance,
  };
}

/** 挂载通知组件，返回卸载入口。 */
async function mount_toast(): Promise<() => Promise<void>> {
  const root = createRoot(document.createElement("div"));
  const t = vi.fn(create_text_resolver("zh-CN"));
  await act(async () =>
    root.render(
      <LocaleContext.Provider value={{ locale: "zh-CN", t }}>
        <WebInstanceConflictToast />
      </LocaleContext.Provider>,
    ),
  );
  return async () => await act(async () => root.unmount());
}

it("启动配置报告第二实例时弹出可关闭的警告通知", async () => {
  inject_bootstrap(ANOTHER_INSTANCE);

  const unmount = await mount_toast();

  expect(toast.warning).toHaveBeenCalledOnce();
  const call = vi.mocked(toast.warning).mock.lastCall;
  expect(call?.[0]).toBe(
    create_text_resolver("zh-CN")("app.web_instance.conflict", { PID: "4321", PORT: "5555" }),
  );
  expect(call?.[1]).toMatchObject({
    id: expect.any(String),
    dismissible: true,
    closeButton: true,
  });

  await unmount();
  expect(toast.dismiss).toHaveBeenCalledWith(call?.[1]?.id);
});

it("单实例与桌面入口不弹出通知", async () => {
  const unmount = await mount_toast();
  expect(toast.warning).not.toHaveBeenCalled();
  await unmount();

  inject_bootstrap(null);
  const single_instance_unmount = await mount_toast();
  expect(toast.warning).not.toHaveBeenCalled();
  await single_instance_unmount();
});
