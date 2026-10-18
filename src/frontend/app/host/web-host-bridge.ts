import { AppError } from "@shared/error";
import type { DesktopBridgeApi } from "@gui/bridge-api";
import type {
  DesktopRendererDiagnosticsPayload,
  DesktopUpdateDownloadRequest,
  DesktopUpdateDownloadResult,
  ResolvedThemeMode,
} from "@gui/bridge-types";

import {
  establish_web_access_session_request,
  read_web_host_bootstrap_request,
} from "@frontend/app/desktop/desktop-api";
import { WEB_ACCESS_CREDENTIAL_HASH_KEY } from "@frontend/app/desktop/web-host-api";
import { request_web_file_pick } from "@frontend/features/web-file-picker/picker-request-bus";
import type { WebHostBootstrap } from "@frontend/app/host/host-bridge";

function capability_error(reason: string): AppError {
  return new AppError("runtime.capability_missing", {
    public_details: { reason },
    diagnostic_context: { host: "web" },
  });
}

/** 缺少可用访问凭据时抛出，入口据此展示凭据录入视图而不是进入应用。 */
export class WebAccessCredentialRequiredError extends Error {
  public constructor() {
    super("Web access credential is required.");
    this.name = "WebAccessCredentialRequiredError";
  }
}

/** 从 URL 片段读取一次性访问凭据，读取后由调用方清理片段。 */
export function read_web_access_credential_from_location(): string | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const credential = new URLSearchParams(hash).get(WEB_ACCESS_CREDENTIAL_HASH_KEY);
  return credential === null || credential === "" ? null : credential;
}

/** 清理 URL 中的凭据片段，避免凭据留在地址栏、历史记录和分享链接里。 */
export function clear_web_access_credential_from_location(): void {
  if (!window.location.hash.includes(WEB_ACCESS_CREDENTIAL_HASH_KEY)) return;
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, document.title, `${url.pathname}${url.search}`);
}

/**
 * 建立访问会话：用 URL 片段或用户录入的一次性凭据换取 HttpOnly Cookie。
 * 会话是否已建立由服务端报告，renderer 不读取 HttpOnly Cookie。
 */
export async function establish_web_access_session(presented_credential?: string): Promise<void> {
  const credential = presented_credential ?? read_web_access_credential_from_location();
  if (credential === null) throw new WebAccessCredentialRequiredError();
  const established = await establish_web_access_session_request(credential);
  if (!established) throw new WebAccessCredentialRequiredError();
  clear_web_access_credential_from_location();
}

/** 读取启动配置；注入缺失时回退到同源启动配置接口。 */
export async function read_web_host_bootstrap(): Promise<WebHostBootstrap> {
  return await read_web_host_bootstrap_request();
}

/**
 * Web 宿主桥。浏览器没有系统文件对话框，文件、目录与保存选择统一交给应用内
 * 选择器界面；导出交付没有可写入的本地路径，改由受控下载返回。
 */
export function create_web_host_bridge(bootstrap: WebHostBootstrap): DesktopBridgeApi {
  const capabilities = bootstrap.capabilities;
  return {
    appVersion: bootstrap.appVersion,
    shell: bootstrap.shell,
    backendApi: bootstrap.backendApi,
    getPathForFile: () => "", // 浏览器不暴露本地路径，拖拽导入由上传流程承接
    setTitleBarTheme: (_theme_mode: ResolvedThemeMode) => undefined, // Web 没有原生标题栏覆盖层
    requestUserAttention: () => undefined, // 页面焦点与系统提醒由用户自行查看，不伪造打扰
    quitApp: async () => {
      // 服务生命周期归终端，页面关闭不等于服务停止。
      throw capability_error("app_quit");
    },
    openLogWindow: async () => {
      window.location.assign("/?window=logs"); // 日志窗口是同一服务的同源路由
    },
    onWindowCloseRequest: () => () => undefined, // 浏览器关闭不可拦截
    reportRendererDiagnostics: (_payload: DesktopRendererDiagnosticsPayload) => undefined, // 诊断已由 HTTP 上报
    openExternalUrl: async (url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    downloadUpdate: async (
      request: DesktopUpdateDownloadRequest,
    ): Promise<DesktopUpdateDownloadResult> => {
      if (capabilities.autoUpdate) throw capability_error("auto_update");
      // 本地服务没有自动更新通道，交回发布页由用户自行选择版本。
      return {
        status: "fallback_to_release_page",
        release_url: request.release_url,
        reason: "unsupported_platform",
      };
    },
    launchUpdate: async () => {
      throw capability_error("auto_update");
    },
    // 工程源文件与工作台追加文件允许上传暂存，暂存路径与材料身份一并返回。
    pickProjectSourceFilePath: async () =>
      await request_web_file_pick({ mode: "file", allow_upload: true }),
    pickProjectSourceDirectoryPath: async () => await request_web_file_pick({ mode: "directory" }),
    // 打开工程只浏览已有 .lg，不开放上传，避免把暂存文件当成工程文件。
    pickProjectFilePath: async () => await request_web_file_pick({ mode: "file" }),
    pickProjectSavePath: async (default_name: string) =>
      await request_web_file_pick({ mode: "save", default_name }),
    pickWorkbenchFilePath: async () =>
      await request_web_file_pick({ mode: "file", allow_upload: true }),
    pickFixedProjectDirectory: async () => await request_web_file_pick({ mode: "directory" }),
    pickGlossaryImportFilePath: async () =>
      await request_web_file_pick({ mode: "file", allow_upload: true }),
    // 导出没有可写入的本地路径，调用方按材料身份经受控下载交付。
    pickGlossaryExportPath: async () => ({
      canceled: false,
      paths: [],
      material_ids: [],
      web_download: true,
    }),
    pickPromptImportFilePath: async () =>
      await request_web_file_pick({ mode: "file", allow_upload: true }),
    pickPromptExportFilePath: async () => ({
      canceled: false,
      paths: [],
      material_ids: [],
      web_download: true,
    }),
  };
}
