import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create_desktop_bridge_api_mock } from "../../../test/desktop-bridge-mock";
import { request_web_file_pick } from "./picker-request-bus";
import { WebFilePickerHost } from "./web-file-picker-host";
import type { WebDirectoryListing, WebFileRoot } from "./web-file-picker-api";
import { AGENT_SAVE_PATH_EVENT_TOPIC } from "@shared/agent";

let active_event_source: FakeEventSource | null = null;
const save_path_responses: Record<string, unknown>[] = [];

vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const { fetch_mock } = vi.hoisted(() => ({ fetch_mock: vi.fn() }));

const ROOTS: WebFileRoot[] = [{ id: "home", label: "主目录", path: "/data/home" }];

const ROOT_LISTING: WebDirectoryListing = {
  path: "/data/home",
  root_id: "home",
  parent_path: null,
  entries: [
    { name: "docs", kind: "directory", size: null },
    { name: "novel.txt", kind: "file", size: 12 },
  ],
};

const DOCS_LISTING: WebDirectoryListing = {
  path: "/data/home/docs",
  root_id: "home",
  parent_path: "/data/home",
  entries: [{ name: "chapter01.txt", kind: "file", size: 8 }],
};

/** 只实现桥接订阅需要的事件面；不发真实网络请求。 */
class FakeEventSource {
  public onopen: (() => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();
  public addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
  public removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  public close(): void {}
  public emit(type: string, payload: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
}
/** 安装不访问真实文件系统的宿主桥与后端路由。 */
function install_backend(): void {
  Object.defineProperty(window, "desktopApp", {
    configurable: true,
    writable: true,
    value: create_desktop_bridge_api_mock(),
  });
  fetch_mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/web/files/roots")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { roots: ROOTS } }) };
    }
    if (url.includes("/api/agent/save-path/pending")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { requests: [] } }) };
    }
    if (url.includes("/api/agent/save-path/respond")) {
      save_path_responses.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { path: string };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: body.path === "" ? ROOT_LISTING : DOCS_LISTING }),
    };
  });
  vi.stubGlobal("fetch", fetch_mock);
  vi.stubGlobal(
    "EventSource",
    class extends FakeEventSource {
      public constructor() {
        super();
        active_event_source = this;
      }
    },
  );
}

function find_button(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find((element) => {
    return element.textContent?.includes(text) ?? false;
  });
  if (!(button instanceof HTMLButtonElement)) throw new Error(`未找到按钮：${text}`);
  return button;
}

describe("WebFilePickerHost", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    install_backend();
  });

  afterEach(async () => {
    if (root !== null) await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
  });

  async function mount_host(): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(WebFilePickerHost));
    });
  }

  async function flush_async_updates(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("排队请求逐个呈现，同 mode 的连续请求不继承上一个目录与选择", async () => {
    await mount_host();

    let first_pick!: Promise<unknown>;
    await act(async () => {
      first_pick = request_web_file_pick({ mode: "file" });
    });
    await flush_async_updates();
    act(() => {
      find_button("docs").click();
    });
    await flush_async_updates();
    expect(document.body.textContent).toContain("chapter01.txt");

    act(() => {
      find_button("app.action.cancel").click();
    });
    await expect(first_pick).resolves.toEqual({ canceled: true, paths: [], material_ids: [] });

    // 第一个请求进入过子目录，第二个同 mode 请求必须从根目录重新开始。
    let second_pick!: Promise<unknown>;
    await act(async () => {
      second_pick = request_web_file_pick({ mode: "file" });
    });
    await flush_async_updates();
    expect(document.body.textContent).toContain("novel.txt");
    expect(document.body.textContent).not.toContain("chapter01.txt");

    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => {
      checkbox?.click();
    });
    act(() => {
      find_button("app.web_files.confirm").click();
    });
    await expect(second_pick).resolves.toEqual({
      canceled: false,
      paths: ["/data/home/novel.txt"],
      material_ids: [],
    });
    expect(document.body.querySelector('[data-slot="dialog"]')).toBeNull();
  });
});

describe("WebFilePickerHost Agent 保存位置桥接", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    install_backend();
    save_path_responses.length = 0;
  });

  afterEach(async () => {
    if (root !== null) await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
  });

  it("保存位置请求经选择器应答，取消时回传 null", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(WebFilePickerHost));
    });

    // 后端驻留请求经 SSE 到达
    await act(async () => {
      active_event_source?.emit(AGENT_SAVE_PATH_EVENT_TOPIC, {
        type: "requested",
        request_id: "req-1",
        default_name: "结果.md",
      });
    });

    // 选择器以保存模式打开，默认名预填
    // 选择器以保存模式打开（等待根列表加载后渲染文件名输入）
    let name_input: HTMLInputElement | null = null;
    for (let attempt = 0; attempt < 20 && name_input === null; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      name_input = document.body.querySelector(
        'input:not([type="file"])',
      ) as HTMLInputElement | null;
    }
    expect(name_input?.value).toBe("结果.md");

    // 确认后经 REST 应答所选路径
    await act(async () => {
      find_button("app.web_files.confirm").click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save_path_responses).toEqual([{ request_id: "req-1", path: "/data/home/结果.md" }]);
  });
});
