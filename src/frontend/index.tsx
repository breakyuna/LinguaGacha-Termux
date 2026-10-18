import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "@frontend/app";
import { RendererErrorBoundary } from "@frontend/app/diagnostics/renderer-error-boundary";
import { install_renderer_global_error_handlers } from "@frontend/app/diagnostics/renderer-error-reporter";
import {
  WebAccessCredentialRequiredError,
  prepare_web_host,
} from "@frontend/app/host/web-host-startup";
import { WebAccessGate } from "@frontend/app/host/web-access-gate";
import "@frontend/index.css";

install_renderer_global_error_handlers();

function render_application(content: ReactNode): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RendererErrorBoundary>{content}</RendererErrorBoundary>
    </React.StrictMode>,
  );
}

/** 桌面宿主由 preload 安装桥后直接渲染；Web 宿主先建立访问会话再进入应用。 */
async function start_renderer(): Promise<void> {
  try {
    await prepare_web_host();
  } catch (error) {
    if (error instanceof WebAccessCredentialRequiredError) {
      render_application(
        <WebAccessGate
          on_established={() => {
            window.location.reload();
          }}
        />,
      );
      return;
    }
    throw error;
  }
  render_application(<App />);
}

void start_renderer();
