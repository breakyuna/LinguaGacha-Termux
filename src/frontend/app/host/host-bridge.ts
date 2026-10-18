import type { DesktopBridgeApi } from "@gui/bridge-api";
import type { DesktopShellInfo } from "@gui/bridge-types";

export const WEB_BOOTSTRAP_GLOBAL_NAME = "__LG_WEB_BOOTSTRAP__"; // 服务端注入的启动配置全局名

/** 宿主能力由服务端事实决定，前端只按能力暴露入口，不隐藏按钮后伪造成功。 */
export type WebHostCapabilities = {
  fileDialog: boolean;
  directoryDialog: boolean;
  saveDialog: boolean;
  imageHost: boolean;
  pdfHost: boolean;
  systemNotification: boolean;
  autoUpdate: boolean;
};

export type WebHostBootstrap = {
  appVersion: string;
  shell: DesktopShellInfo;
  backendApi: { baseUrl: string };
  capabilities: WebHostCapabilities;
  session: { established: boolean }; // 会话 Cookie 为 HttpOnly，是否已建立由服务端报告
};

let installed_web_host_bridge: DesktopBridgeApi | null = null;

/** 读取服务端注入的启动配置；开发态没有注入时返回 null，由调用方回退到接口读取。 */
export function read_injected_web_host_bootstrap(): WebHostBootstrap | null {
  const injected = (window as unknown as { [WEB_BOOTSTRAP_GLOBAL_NAME]?: unknown })[
    WEB_BOOTSTRAP_GLOBAL_NAME
  ];
  if (typeof injected !== "object" || injected === null) return null;
  return injected as WebHostBootstrap;
}

/** 当前文档是否由 Web 服务端注入启动配置；桌面入口没有该全局。 */
export function is_web_host_document(): boolean {
  return read_injected_web_host_bootstrap() !== null;
}

/**
 * 安装 Web 宿主桥。入口在渲染前调用，同时落到宿主全局，
 * 让未迁移的读取点与 API 地址解析继续沿用同一契约。
 */
export function install_web_host_bridge(bridge: DesktopBridgeApi): void {
  installed_web_host_bridge = bridge;
  window.desktopApp = bridge;
}

/**
 * 宿主能力唯一读取入口。桌面返回 preload 注入的桥，Web 返回启动时安装的桥。
 */
export function read_host_bridge(): DesktopBridgeApi {
  const desktop_bridge = window.desktopApp;
  if (desktop_bridge !== undefined) return desktop_bridge;
  if (installed_web_host_bridge !== null) return installed_web_host_bridge;
  throw new Error(
    `Host bridge is unavailable; the web runtime must install ${WEB_BOOTSTRAP_GLOBAL_NAME} first.`,
  );
}
