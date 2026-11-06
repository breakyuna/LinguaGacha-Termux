import {
  create_web_host_bridge,
  establish_web_access_session,
  read_web_host_bootstrap,
  WebAccessCredentialRequiredError,
} from "@frontend/app/host/web-host-bridge";
import { install_web_host_bridge, is_web_host_document } from "@frontend/app/host/host-bridge";

export { WebAccessCredentialRequiredError };

/**
 * Web 宿主启动：先建立访问会话，再安装宿主桥。
 * 会话缺失时抛出 WebAccessCredentialRequiredError，由入口展示凭据录入视图。
 */
export async function prepare_web_host(): Promise<void> {
  if (!is_web_host_document()) return; // 桌面入口由 preload 安装宿主桥
  const bootstrap = await read_web_host_bootstrap();
  if (!bootstrap.session.established) {
    await establish_web_access_session();
  }
  install_web_host_bridge(create_web_host_bridge(bootstrap));
}
