import type { DesktopBridgeApi } from "@gui/bridge-api";

declare global {
  interface Window {
    desktopApp?: DesktopBridgeApi; // 桌面由 preload 安装；Web 运行态由宿主启动时安装，读取一律经 host-bridge
  }
}
