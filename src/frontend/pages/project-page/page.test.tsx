import { type ReactNode, act, cloneElement, isValidElement } from "react";

import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@frontend/app/locale/locale-provider";
import { ProjectPage } from "@frontend/pages/project-page/page";
import { read_host_bridge } from "@frontend/app/host/host-bridge";
import { create_desktop_bridge_api_mock } from "../../../test/desktop-bridge-mock";

// 触屏与窄视口的可见性由 CSS 媒体查询决定，jsdom 不求值样式表，按样式源文断言契约。
const project_page_css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "project-page.css"),
  "utf8",
);

const {
  api_fetch_mock,
  desktop_runtime_fixture,
  dismiss_toast_mock,
  push_progress_toast_mock,
  push_toast_mock,
  update_progress_toast_mock,
} = vi.hoisted(() => {
  return {
    api_fetch_mock: vi.fn(),
    desktop_runtime_fixture: {
      current: null as ReturnType<typeof create_desktop_runtime_fixture> | null,
    },
    dismiss_toast_mock: vi.fn(),
    push_progress_toast_mock: vi.fn(() => "project-loading-toast"),
    push_toast_mock: vi.fn(),
    update_progress_toast_mock: vi.fn(),
  };
});

vi.mock("@frontend/app/desktop/desktop-api", async () => {
  const actual = await vi.importActual<typeof import("@frontend/app/desktop/desktop-api")>(
    "@frontend/app/desktop/desktop-api",
  );
  return {
    ...actual,
    api_fetch: api_fetch_mock,
  };
});

vi.mock("@frontend/app/state/use-desktop-state", () => {
  return {
    useDesktopState: () => desktop_runtime_fixture.current,
  };
});

vi.mock("@frontend/app/feedback/desktop-toast", () => ({
  dismiss_toast: dismiss_toast_mock,
  push_progress_toast: push_progress_toast_mock,
  push_error_toast: push_toast_mock,
  push_toast: push_toast_mock,
  update_progress_toast: update_progress_toast_mock,
}));

vi.mock("@frontend/widgets/app-context-menu", () => {
  return {
    AppContextMenu: (props: { children: ReactNode }) => <div>{props.children}</div>,
    AppContextMenuContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
    AppContextMenuItem: (props: { children: ReactNode; onClick?: (event: Event) => void }) => (
      <button
        type="button"
        onClick={() => {
          props.onClick?.(new Event("select"));
        }}
      >
        {props.children}
      </button>
    ),
    AppContextMenuTrigger: (props: { children?: ReactNode; render?: ReactNode }) => (
      <>{props.render ?? props.children}</>
    ),
  };
});

vi.mock("@frontend/widgets/app-button", () => {
  return {
    AppButton: (props: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
      type?: "button";
      "aria-label"?: string;
    }) => (
      <button
        type={props.type ?? "button"}
        aria-label={props["aria-label"]}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.children}
      </button>
    ),
  };
});

vi.mock("@frontend/shadcn/card", () => {
  return {
    Card: (props: { children: ReactNode }) => <section>{props.children}</section>,
    CardContent: (props: { children: ReactNode }) => <div>{props.children}</div>,
    CardDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
    CardFooter: (props: { children: ReactNode }) => <footer>{props.children}</footer>,
    CardHeader: (props: { children: ReactNode }) => <header>{props.children}</header>,
    CardTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  };
});

vi.mock("@frontend/shadcn/spinner", () => {
  return {
    Spinner: () => <span />,
  };
});

vi.mock("@frontend/shadcn/tooltip", () => {
  return {
    Tooltip: (props: { children?: ReactNode; render?: ReactNode }) => (
      <>{props.render ?? props.children}</>
    ),
    TooltipContent: (props: { children: ReactNode }) => <div role="tooltip">{props.children}</div>,
    TooltipTrigger: (props: { children?: ReactNode; render?: ReactNode }) => (
      <>
        {isValidElement(props.render) && props.children !== undefined
          ? cloneElement(props.render, undefined, props.children)
          : (props.render ?? props.children)}
      </>
    ),
  };
});

vi.mock("@frontend/widgets/app-alert-dialog", () => {
  return {
    AppConfirmDialog: () => null,
  };
});

/** 构造项目页需要的最小设置快照，并允许场景定点覆写。 */
function create_settings_snapshot(overrides: Record<string, unknown> = {}) {
  return {
    app_language: "ZH",
    source_language: "JA",
    target_language: "ZH",
    project_save_mode: "SOURCE",
    project_fixed_path: "",
    output_folder_open_on_finish: false,
    request_timeout: 120,
    preceding_lines_threshold: 0,
    clean_ruby: false,
    deduplication_in_bilingual: true,
    write_translated_name_fields_to_file: true,
    mtool_optimizer_enable: true,
    skip_duplicate_source_text_enable: true,
    glossary_default_preset: "",
    pre_translation_replacement_default_preset: "",
    post_translation_replacement_default_preset: "",
    text_preserve_default_preset: "",
    translation_custom_prompt_default_preset: "",

    recent_projects: [],
    ...overrides,
  };
}

/** 构造页面公开依赖的 DesktopState 测试替身。 */
function create_desktop_runtime_fixture(settings_overrides: Record<string, unknown> = {}) {
  return {
    project_session_stage: null,
    project_snapshot: { loaded: false, path: "" },
    project_session_status: "idle",
    settings_snapshot: create_settings_snapshot(settings_overrides),
    refresh_project_snapshot: vi.fn(),
    set_project_session_status: vi.fn(),
    refresh_settings: vi.fn(async () => {}),
    refresh_batch_translation: vi.fn(async () => {}),
  };
}

/** 安装不访问真实文件系统的桌面桥测试替身。 */
function install_desktop_app_fixture(): void {
  Object.defineProperty(window, "desktopApp", {
    configurable: true,
    writable: true,
    value: create_desktop_bridge_api_mock({
      methods: {
        getPathForFile: vi.fn(() => ""),
        pickFixedProjectDirectory: vi.fn(async () => ({ canceled: true, paths: [] })),
        pickProjectFilePath: vi.fn(async () => ({ canceled: true, paths: [] })),
        pickProjectSavePath: vi.fn(async () => ({ canceled: true, paths: [] })),
        pickProjectSourceDirectoryPath: vi.fn(async () => ({ canceled: true, paths: [] })),
        pickProjectSourceFilePath: vi.fn(async () => ({
          canceled: false,
          paths: ["E:\\Source\\demo.txt"],
        })),
      },
    }),
  });
}

/** 等待当前交互链上的 Promise 更新进入 React 状态。 */
async function flush_async_updates(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

/** 按用户可见文案读取按钮，缺失时给出可定位错误。 */
function get_button_by_text(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((element) => {
    return element.textContent?.includes(text) ?? false;
  });

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`未找到按钮：${text}`);
  }

  return button;
}

/** 读取触屏或窄视口的媒体查询块；jsdom 不求值媒体查询，契约按样式文本断言。 */
function read_phone_media_block(css: string): string {
  const block_start = css.indexOf("@media (hover: none)");
  if (block_start < 0) {
    throw new Error("未找到触屏或窄视口媒体查询块");
  }

  const block_end = css.indexOf("\n}", block_start);
  if (block_end < 0) {
    throw new Error("未找到触屏或窄视口媒体查询块结尾");
  }

  return css.slice(block_start, block_end);
}

describe("ProjectPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    desktop_runtime_fixture.current = create_desktop_runtime_fixture();
    install_desktop_app_fixture();
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    };
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/session/source-files/summary") {
        return { source_file_count: 1, format_hit_counts: { txt: 1 } };
      }
      if (path === "/api/session/project/create") {
        return { project: { path: "E:\\Source\\demo_20260428_120000.lg", loaded: true } };
      }
      if (path === "/api/settings/recent-projects/add") {
        return { settings: { recent_projects: [] } };
      }

      return {};
    });
  });

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }

    container?.remove();
    container = null;
    root = null;
    api_fetch_mock.mockReset();
    dismiss_toast_mock.mockReset();
    push_progress_toast_mock.mockClear();
    push_toast_mock.mockReset();
    update_progress_toast_mock.mockReset();
  });

  /** 使用真实中文 i18n 资源挂载项目页。 */
  async function mount_page(): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <LocaleProvider locale="zh-CN">
          <ProjectPage is_sidebar_collapsed={false} />
        </LocaleProvider>,
      );
    });
  }

  /** 复用公开交互完成一次源文件选择和工程创建。 */
  async function create_project_from_selected_source(): Promise<void> {
    if (container === null) {
      throw new Error("项目页尚未挂载。");
    }
    const page_container = container;

    await act(async () => {
      get_button_by_text(page_container, "选择文件").click();
      await flush_async_updates();
    });

    await act(async () => {
      get_button_by_text(page_container, "创建工程").click();
      await flush_async_updates();
    });
  }

  it("保留预览文件顺序并用当前工程文件名记录最近打开", async () => {
    const paths = [
      "folder/chapter03.txt",
      "chapter01.txt",
      "chapter02.txt",
      "chapter04.txt",
      "chapter05.txt",
    ];
    const project_path = "E:/Source/renamed.lg";
    desktop_runtime_fixture.current = create_desktop_runtime_fixture({
      recent_projects: [{ path: project_path, name: "旧来源名称" }],
    });
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/session/project/preview")
        return {
          preview: {
            file_paths: paths,
            created_at: "2020-12-12T12:12:12",
            updated_at: "2026-09-17T14:05:54",
            translation_stats: {
              total_items: 3,
              completed_count: 1,
              skipped_count: 0,
              failed_count: 0,
              pending_count: 2,
              completion_percent: 33,
            },
          },
        };
      return {};
    });
    await mount_page();
    await act(async () => {
      get_button_by_text(container!, "旧来源名称").click();
      await flush_async_updates();
    });
    expect(container!.textContent).toContain("2020-12-12 12:12:12");
    expect(container!.textContent).toContain("2026-09-17 14:05:54");
    const files_row = container!.querySelector(".project-home__preview-files-row")!;
    const files_badge = files_row.querySelector('[data-slot="badge"]');
    expect(files_badge?.textContent).toBe(`${paths.length} 个文件`);
    expect(
      [...files_row.querySelectorAll('[role="tooltip"] li')].map((element) => element.textContent),
    ).toEqual(paths);
    const progress = container!.querySelector(
      '.project-home__preview-progress [data-slot="badge"]',
    );
    expect(progress?.textContent).toBe("33.00%");
    await act(async () => {
      get_button_by_text(container!, "打开工程").click();
      await flush_async_updates();
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/session/project/open", {
      path: project_path,
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/settings/recent-projects/add", {
      path: project_path,
      name: "renamed",
    });
  });

  it("新建工程默认提交 stem.lg，并用后端真实路径写入最近工程", async () => {
    await mount_page();

    await create_project_from_selected_source();

    expect(api_fetch_mock).toHaveBeenCalledWith(
      "/api/session/project/create",
      expect.objectContaining({
        path: "E:\\Source\\demo.lg",
      }),
    );
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/settings/recent-projects/add", {
      path: "E:\\Source\\demo_20260428_120000.lg",
      name: "demo_20260428_120000",
    });
  });

  it("来源摘要全部失败时展示具体文件原因，重新选择仍可恢复", async () => {
    const source = "E:/Source/broken.exe";
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: [source],
    });
    api_fetch_mock.mockImplementation(async (path: string) =>
      path === "/api/session/source-files/summary"
        ? {
            source_file_count: 0,
            format_hit_counts: {},
            failed_files: [
              {
                source_path: source,
                rel_path: "broken.exe",
                filename: "broken.exe",
                code: "file.io_failed",
                message: "EVB header damaged",
              },
            ],
          }
        : {},
    );
    await mount_page();
    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });
    expect(push_toast_mock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("broken.exe"),
    );
    expect(push_toast_mock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("EVB header damaged"),
    );
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["E:/Source/good.txt"],
    });
    api_fetch_mock.mockResolvedValue({ source_file_count: 1, format_hit_counts: { txt: 1 } });
    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });
    expect(get_button_by_text(container as HTMLElement, "创建工程").disabled).toBe(false);
  });

  it("多选源文件后使用完整 source_paths 创建工程", async () => {
    const selected_paths = ["E:\\Source\\a.txt", "E:\\Source\\b.md"];
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: [...selected_paths, "E:\\Source\\a.txt", " "],
    });
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/session/source-files/summary") {
        return { source_file_count: 2, format_hit_counts: { txt: 1, md: 1 } };
      }
      if (path === "/api/session/project/create") {
        return { project: { path: "E:\\Source\\a_20260428_120000.lg", loaded: true } };
      }
      if (path === "/api/settings/recent-projects/add") {
        return { settings: { recent_projects: [] } };
      }

      return {};
    });
    await mount_page();

    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });

    expect(container?.textContent).toContain("已选择 2 个源文件");

    await act(async () => {
      get_button_by_text(container as HTMLElement, "创建工程").click();
      await flush_async_updates();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/session/source-files/summary", {
      source_paths: selected_paths,
    });
    expect(api_fetch_mock).toHaveBeenCalledWith(
      "/api/session/project/create",
      expect.objectContaining({
        path: "E:\\Source\\a.lg",
        source_paths: selected_paths,
      }),
    );
  });

  it("选择源文件后显示数字徽标，重置后清除计数", async () => {
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["E:\\Source\\game.json"],
    });
    api_fetch_mock.mockResolvedValueOnce({
      source_file_count: 1,
      format_hit_counts: { json: 1 },
    });
    await mount_page();

    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });

    const selected_tags = Array.from(
      container?.querySelectorAll<HTMLElement>(".project-home__format-tag") ?? [],
    );
    const json_tag = selected_tags.find((tag) => tag.textContent?.includes("JSON 游戏文本"));
    expect(json_tag?.querySelector('[data-slot="badge"]')?.textContent).toBe("1");

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[aria-label="重置"]')?.click();
    });

    expect(container?.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("上传暂存材料改用保存选择器定位输出，并随创建请求提交材料身份", async () => {
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["/data/user/0/web-imports/upload.txt"],
      material_ids: ["mat-1"],
    });
    vi.mocked(read_host_bridge().pickProjectSavePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["/data/user/0/documents/upload.lg"],
    });
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/session/source-files/summary")
        return { source_file_count: 1, format_hit_counts: { txt: 1 } };
      if (path === "/api/session/project/create")
        return { project: { path: "/data/user/0/documents/upload.lg", loaded: true } };
      if (path === "/api/settings/recent-projects/add")
        return { settings: { recent_projects: [] } };
      return {};
    });
    await mount_page();

    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });
    await act(async () => {
      get_button_by_text(container as HTMLElement, "创建工程").click();
      await flush_async_updates();
    });

    expect(read_host_bridge().pickProjectSavePath).toHaveBeenCalledWith("upload.lg");
    expect(api_fetch_mock).toHaveBeenCalledWith(
      "/api/session/project/create",
      expect.objectContaining({
        path: "/data/user/0/documents/upload.lg",
        material_ids: ["mat-1"],
      }),
    );
    // 创建成功后前端统一释放本次上传的材料，后端释放保持现状，重复释放无害。
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/web/files/material/release", {
      material_id: "mat-1",
    });
  });

  it("文件夹上传以批次目录路径进入 source_paths，创建成功后释放全部材料", async () => {
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["/data/user/0/web-imports/batch-1770000000000-k3f9a2"],
      material_ids: ["mat-1", "mat-2"],
    });
    vi.mocked(read_host_bridge().pickProjectSavePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["/data/user/0/documents/game.lg"],
    });
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/session/source-files/summary")
        return { source_file_count: 2, format_hit_counts: { epub: 1, srt: 1 } };
      if (path === "/api/session/project/create")
        return { project: { path: "/data/user/0/documents/game.lg", loaded: true } };
      if (path === "/api/settings/recent-projects/add")
        return { settings: { recent_projects: [] } };
      return {};
    });
    await mount_page();

    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });
    await act(async () => {
      get_button_by_text(container as HTMLElement, "创建工程").click();
      await flush_async_updates();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith(
      "/api/session/project/create",
      expect.objectContaining({
        source_paths: ["/data/user/0/web-imports/batch-1770000000000-k3f9a2"],
        material_ids: ["mat-1", "mat-2"],
      }),
    );
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/web/files/material/release", {
      material_id: "mat-1",
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/web/files/material/release", {
      material_id: "mat-2",
    });
  });

  it("源文件摘要失败时释放本次上传的材料，不占用暂存区", async () => {
    vi.mocked(read_host_bridge().pickProjectSourceFilePath).mockResolvedValueOnce({
      canceled: false,
      paths: ["/data/user/0/web-imports/batch-1770000000000-k3f9a2"],
      material_ids: ["mat-1", "mat-2"],
    });
    api_fetch_mock.mockImplementation(async (path: string) => {
      if (path === "/api/session/source-files/summary") return { source_file_count: 0 };
      return {};
    });
    await mount_page();

    await act(async () => {
      get_button_by_text(container as HTMLElement, "选择文件").click();
      await flush_async_updates();
    });

    expect(container?.textContent).not.toContain("已选择");
    expect(push_toast_mock).toHaveBeenCalledWith("warning", "该目录下没有支持的源文件");
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/web/files/material/release", {
      material_id: "mat-1",
    });
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/web/files/material/release", {
      material_id: "mat-2",
    });
  });

  it("最近工程移除按钮常驻可点，触屏与窄视口不依赖悬停", async () => {
    const project_path = "E:/Source/demo.lg";
    desktop_runtime_fixture.current = create_desktop_runtime_fixture({
      recent_projects: [{ path: project_path, name: "演示工程" }],
    });
    await mount_page();

    const remove_button = get_button_by_text(container as HTMLElement, "演示工程")
      .closest(".project-home__recent-row")
      ?.querySelector<HTMLButtonElement>('button[aria-label="删除"]');
    expect(remove_button).not.toBeNull();

    await act(async () => {
      remove_button?.click();
      await flush_async_updates();
    });

    expect(api_fetch_mock).toHaveBeenCalledWith("/api/settings/recent-projects/remove", {
      path: project_path,
    });
  });

  it("移除按钮桌面悬停显示，触屏与窄视口常驻可见且热区补到 40px 量级", () => {
    // 桌面：默认隐藏，仅悬停或键盘焦点时显示，视觉不回归。
    expect(project_page_css).toContain(
      ".project-home__recent-row:hover .project-home__recent-remove",
    );
    expect(project_page_css).toContain("opacity: 0;");
    expect(project_page_css).toContain("pointer-events: none;");

    // 触屏与窄视口：常驻可见，28px 按钮配 -6px 不可见热区达到 40px 量级点击目标。
    const phone_block = read_phone_media_block(project_page_css);
    expect(phone_block).toContain(".project-home__recent-remove");
    expect(phone_block).toContain("opacity: 1;");
    expect(phone_block).toContain("pointer-events: auto;");
    expect(phone_block).toContain("inset: -6px;");
  });
});
