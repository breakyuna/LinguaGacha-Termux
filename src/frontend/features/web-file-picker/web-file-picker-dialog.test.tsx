import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create_desktop_bridge_api_mock } from "../../../test/desktop-bridge-mock";
import type { WebFilePickIntent, WebFilePickResult } from "./picker-request-bus";
import {
  list_web_file_directory,
  type WebDirectoryListing,
  type WebFileRoot,
  type WebStagedMaterial,
} from "./web-file-picker-api";
import { WebFilePickerDialog } from "./web-file-picker-dialog";

vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const { fetch_mock } = vi.hoisted(() => ({ fetch_mock: vi.fn() }));

const ROOTS: WebFileRoot[] = [
  { id: "home", label: "主目录", path: "/data/home" },
  { id: "shared", label: "共享存储", path: "/storage/emulated/0" },
];

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
  entries: [
    { name: "chapter01.txt", kind: "file", size: 8 },
    { name: "chapter02.txt", kind: "file", size: 9 },
  ],
};

const UPLOADED_MATERIAL: WebStagedMaterial = {
  material_id: "mat-1",
  name: "upload.txt",
  path: "/data/user/0/web-imports/upload.txt",
  size: 5,
};

/** 记录上传调用携带的 name 查询参数，用于断言批次目录相对结构。 */
const upload_names: string[] = [];

/** 用 webkitRelativePath 构造文件夹内的文件对象，jsdom 不自动填充该属性。 */
function create_directory_file(relative_path: string, content: string): File {
  const file = new File([content], relative_path.split("/").at(-1) ?? relative_path, {
    type: "text/plain",
  });
  Object.defineProperty(file, "webkitRelativePath", { value: relative_path });
  return file;
}

/** 按上传名回传不同的暂存材料，让批次内多个文件拥有独立身份。 */
function staged_material_for_name(name: string): WebStagedMaterial {
  const material_id = `mat-${upload_names.length}`;
  return {
    material_id,
    name,
    path: `/data/user/0/web-imports/${name}`,
    size: 5,
  };
}

/** 按请求路径与载荷路由 Web 文件接口，返回统一 JSON 信封。 */
function install_backend(options: { upload_should_fail?: boolean } = {}): void {
  upload_names.length = 0;
  fetch_mock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/web/files/roots")) {
      return json_response({ roots: ROOTS });
    }
    if (url.includes("/api/web/files/list")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { root_id: string; path: string };
      const listing = body.path === "" ? ROOT_LISTING : DOCS_LISTING;
      if (body.root_id !== "home") return json_response(undefined, false);
      return json_response(listing);
    }
    if (url.includes("/api/web/files/upload")) {
      if (options.upload_should_fail === true) return json_response(undefined, false);
      const requested_name = new URL(url).searchParams.get("name") ?? "";
      upload_names.push(requested_name);
      return json_response(
        url.includes("%2F") ? staged_material_for_name(requested_name) : UPLOADED_MATERIAL,
      );
    }
    return json_response(undefined, false);
  });
  vi.stubGlobal("fetch", fetch_mock);
}

function json_response(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => (ok ? { ok: true, data } : { ok: false, error: { code: "http_error" } }),
  } as Response;
}

/** 安装不访问真实文件系统的宿主桥，只为 API 地址解析提供 baseUrl。 */
function install_host(): void {
  Object.defineProperty(window, "desktopApp", {
    configurable: true,
    writable: true,
    value: create_desktop_bridge_api_mock(),
  });
}

describe("WebFilePickerDialog", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    install_host();
    install_backend();
  });

  afterEach(async () => {
    if (root !== null) await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
  });

  /** 按用户操作入口渲染对话框，结果经回调回传。 */
  function render_dialog(
    intent: WebFilePickIntent,
    on_settle: (result: WebFilePickResult) => void,
  ): void {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(createElement(WebFilePickerDialog, { intent, on_settle }));
    });
  }

  /** 等待根列举与目录列举的异步链进入界面。 */
  async function flush_async_updates(): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  /** 按可见文案读取按钮，缺失时给出可定位错误。 */
  function find_button(text: string): HTMLButtonElement {
    const button = Array.from(document.body.querySelectorAll("button")).find((element) => {
      return element.textContent?.includes(text) ?? false;
    });
    if (!(button instanceof HTMLButtonElement)) throw new Error(`未找到按钮：${text}`);
    return button;
  }

  /** 用合成文件驱动隐藏上传输入。 */
  function select_upload_files(files: File[]): void {
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("未找到上传输入");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  /** 文件夹上传走带 webkitdirectory 的第二个隐藏输入。 */
  function select_upload_directory(files: File[]): void {
    const input = document.body.querySelector<HTMLInputElement>("input[webkitdirectory]");
    if (input === null) throw new Error("未找到文件夹上传输入");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("列举允许根，进入目录后按响应的上一级返回", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file" }, settle);
    await flush_async_updates();

    expect(document.body.textContent).toContain("主目录");
    expect(document.body.textContent).toContain("novel.txt");

    act(() => {
      find_button("docs").click();
    });
    await flush_async_updates();

    expect(document.body.textContent).toContain("chapter01.txt");
    expect(document.body.textContent).not.toContain("novel.txt");
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("/api/web/files/list"),
      expect.objectContaining({ body: expect.stringContaining('"path":"docs"') }),
    );

    act(() => {
      find_button("app.web_files.up").click();
    });
    await flush_async_updates();

    expect(document.body.textContent).toContain("novel.txt");
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("/api/web/files/list"),
      expect.objectContaining({ body: expect.stringContaining('"path":""') }),
    );
  });

  it("目录模式确认返回当前目录", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "directory" }, settle);
    await flush_async_updates();

    act(() => {
      find_button("docs").click();
    });
    await flush_async_updates();
    act(() => {
      find_button("app.web_files.confirm").click();
    });

    expect(settle).toHaveBeenCalledWith({
      canceled: false,
      paths: ["/data/home/docs"],
      material_ids: [],
    });
  });

  it("file 模式多选后返回全部绝对路径", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file" }, settle);
    await flush_async_updates();
    act(() => {
      find_button("docs").click();
    });
    await flush_async_updates();

    const checkboxes = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(2);
    act(() => {
      checkboxes[0]!.click();
      checkboxes[1]!.click();
    });
    act(() => {
      find_button("app.web_files.confirm").click();
    });

    expect(settle).toHaveBeenCalledWith({
      canceled: false,
      paths: ["/data/home/docs/chapter01.txt", "/data/home/docs/chapter02.txt"],
      material_ids: [],
    });
  });

  it("取消时只回传取消结果", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file" }, settle);
    await flush_async_updates();

    act(() => {
      find_button("app.action.cancel").click();
    });

    expect(settle).toHaveBeenCalledWith({ canceled: true, paths: [], material_ids: [] });
  });

  it("取消时释放本次上传但未交付的暂存材料", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file", allow_upload: true }, settle);
    await flush_async_updates();
    select_upload_files([new File(["hello"], "upload.txt", { type: "text/plain" })]);
    await flush_async_updates();

    act(() => {
      find_button("app.action.cancel").click();
    });

    expect(settle).toHaveBeenCalledWith({ canceled: true, paths: [], material_ids: [] });
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("/api/web/files/material/release"),
      expect.objectContaining({ body: expect.stringContaining("mat-1") }),
    );
  });

  it("上传成功后进入已上传列表并默认可选", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file", allow_upload: true }, settle);
    await flush_async_updates();

    select_upload_files([new File(["hello"], "upload.txt", { type: "text/plain" })]);
    await flush_async_updates();

    expect(document.body.textContent).toContain("upload.txt");
    const uploaded_checkbox = Array.from(
      document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).at(-1);
    expect(uploaded_checkbox?.checked).toBe(true);

    act(() => {
      find_button("app.web_files.confirm").click();
    });

    expect(settle).toHaveBeenCalledWith({
      canceled: false,
      paths: ["/data/user/0/web-imports/upload.txt"],
      material_ids: ["mat-1"],
    });
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("/api/web/files/upload?name=upload.txt"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("上传失败展示失败文案且不产生可确认选择", async () => {
    install_backend({ upload_should_fail: true });
    const settle = vi.fn();
    render_dialog({ mode: "file", allow_upload: true }, settle);
    await flush_async_updates();

    select_upload_files([new File(["hello"], "upload.txt", { type: "text/plain" })]);
    await flush_async_updates();

    expect(document.body.textContent).toContain("app.web_files.upload_failed");
    expect(document.body.textContent).not.toContain("upload.txt");
    expect(find_button("app.web_files.confirm").disabled).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  it("上传文件夹按批次目录保留相对结构，确认时交付目录路径与材料身份", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file", allow_upload: true }, settle);
    await flush_async_updates();

    select_upload_directory([
      create_directory_file("game/www/data/Map001.json", "{}"),
      create_directory_file("game/www/js/rmmz_core.js", ""),
    ]);
    await flush_async_updates();

    // 首段是用户选择的文件夹本身，上传名从批次目录开始。
    expect(upload_names).toHaveLength(2);
    expect(upload_names[0]).toMatch(/^batch-[0-9a-z]+-[0-9a-z]+\/www\/data\/Map001\.json$/u);
    expect(upload_names[1]).toMatch(/^batch-[0-9a-z]+-[0-9a-z]+\/www\/js\/rmmz_core\.js$/u);
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("name=batch-"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(document.body.textContent).toContain("app.web_files.upload_directory");

    act(() => {
      find_button("app.web_files.confirm").click();
    });

    const batch_name = upload_names[0]!.split("/")[0]!;
    expect(settle).toHaveBeenCalledWith({
      canceled: false,
      paths: [`/data/user/0/web-imports/${batch_name}`],
      material_ids: ["mat-1", "mat-2"],
    });
  });

  it("取消批次目录时释放本次上传的全部材料", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file", allow_upload: true }, settle);
    await flush_async_updates();

    select_upload_directory([
      create_directory_file("game/www/data/Map001.json", "{}"),
      create_directory_file("game/www/js/rmmz_core.js", ""),
    ]);
    await flush_async_updates();

    act(() => {
      find_button("app.action.cancel").click();
    });

    expect(settle).toHaveBeenCalledWith({ canceled: true, paths: [], material_ids: [] });
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("/api/web/files/material/release"),
      expect.objectContaining({ body: expect.stringContaining("mat-1") }),
    );
    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringContaining("/api/web/files/material/release"),
      expect.objectContaining({ body: expect.stringContaining("mat-2") }),
    );
  });

  it("文件夹上传失败时中断并释放已暂存文件", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "file", allow_upload: true }, settle);
    await flush_async_updates();

    select_upload_directory([create_directory_file("game/www/data/Map001.json", "{}")]);
    await flush_async_updates();
    const delivered_batch_name = upload_names[0]!.split("/")[0]!;
    install_backend({ upload_should_fail: true });
    select_upload_directory([
      create_directory_file("game/www/data/Map001.json", "{}"),
      create_directory_file("game/www/data/Map002.json", "{}"),
    ]);
    await flush_async_updates();

    expect(document.body.textContent).toContain("app.web_files.upload_failed");
    expect(find_button("app.web_files.confirm").disabled).toBe(false);
    // 第一批文件夹仍然可选，失败批次不留下可确认条目。
    act(() => {
      find_button("app.web_files.confirm").click();
    });
    expect(settle).toHaveBeenCalledWith({
      canceled: false,
      paths: [`/data/user/0/web-imports/${delivered_batch_name}`],
      material_ids: ["mat-1"],
    });
  });

  it("save 模式用默认名拼出目录下的目标路径", async () => {
    const settle = vi.fn();
    render_dialog({ mode: "save", default_name: "demo.lg" }, settle);
    await flush_async_updates();
    act(() => {
      find_button("docs").click();
    });
    await flush_async_updates();

    const name_input = document.body.querySelector<HTMLInputElement>(
      'input:not([type="checkbox"])',
    );
    expect(name_input?.value).toBe("demo.lg");

    act(() => {
      find_button("app.web_files.confirm").click();
    });

    expect(settle).toHaveBeenCalledWith({
      canceled: false,
      paths: ["/data/home/docs/demo.lg"],
      material_ids: [],
    });
  });

  it("list_web_file_directory 按响应形状收窄条目", async () => {
    const listing = await list_web_file_directory("home", "");
    expect(listing.entries).toEqual(ROOT_LISTING.entries);
    expect(listing.parent_path).toBeNull();
  });
});
