import { describe, expect, it } from "vitest";

import { create_node_system_proxy_resolver } from "./node-system-proxy-resolver";

// 规则文本的最终解析契约由 system-proxy-http-client 的测试负责，这里只断言本入口产生的规则文本。
function create_resolver(env: NodeJS.ProcessEnv) {
  return create_node_system_proxy_resolver({ env });
}

describe("node system proxy resolver", () => {
  it("未配置代理时全部直连", async () => {
    const resolver = create_resolver({});

    await expect(resolver.resolveProxy("https://api.example.com/v1")).resolves.toBe("DIRECT");
  });

  it("读取大小写代理变量并转换为可解析规则", async () => {
    const resolver = create_resolver({ https_proxy: "http://127.0.0.1:7890" });

    await expect(resolver.resolveProxy("https://api.example.com/v1")).resolves.toBe(
      "PROXY 127.0.0.1:7890",
    );
  });

  it("socks 代理转换为 SOCKS5 规则并保留默认端口", async () => {
    const resolver = create_resolver({ ALL_PROXY: "socks5://proxy.invalid" });

    await expect(resolver.resolveProxy("https://api.example.com/v1")).resolves.toBe(
      "SOCKS5 proxy.invalid:1080",
    );
  });

  it("回环端点与 NO_PROXY 命中保持直连", async () => {
    const resolver = create_resolver({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,.internal.example",
    });

    await expect(resolver.resolveProxy("http://127.0.0.1:11434/v1")).resolves.toBe("DIRECT");
    await expect(resolver.resolveProxy("http://localhost:11434/v1")).resolves.toBe("DIRECT");
    await expect(resolver.resolveProxy("https://api.internal.example/v1")).resolves.toBe("DIRECT");
    await expect(resolver.resolveProxy("https://api.example.com/v1")).resolves.toBe(
      "PROXY 127.0.0.1:7890",
    );
  });

  it("非法代理地址降级为直连，不阻塞请求", async () => {
    const resolver = create_resolver({ HTTPS_PROXY: "://bad" });

    await expect(resolver.resolveProxy("https://api.example.com/v1")).resolves.toBe("DIRECT");
  });

  it("取消信号在解析前生效", async () => {
    const resolver = create_resolver({ HTTPS_PROXY: "http://127.0.0.1:7890" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolver.resolveProxy("https://api.example.com/v1", controller.signal),
    ).rejects.toThrow();
  });
});
