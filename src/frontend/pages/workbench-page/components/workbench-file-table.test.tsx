import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchFileTable } from "./workbench-file-table";
import type { WorkbenchFileEntry } from "@shared/workbench/workbench-query";
import { TooltipProvider } from "@frontend/shadcn/tooltip";

// 触屏与窄视口的点击热区由 CSS 媒体查询决定，jsdom 不求值样式表，按样式源文断言契约。
const workbench_page_css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "workbench-page.css"),
  "utf8",
);

// 观察进度单位和计数，让提示措辞可以独立修改。
vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? JSON.stringify({ key, ...values }) : key,
  }),
}));

// 接入测试直接提供可见行，布局与虚拟化由通用表格测试验证。
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * options.estimateSize(),
        end: (index + 1) * options.estimateSize(),
        size: options.estimateSize(),
      })),
    getTotalSize: () => options.count * options.estimateSize(),
    measure: () => {},
    scrollToIndex: () => {},
  }),
}));

/** 文件排序场景只调整路径与后端提供的完成率。 */
function create_entry(rel_path: string, completion_percent = 33): WorkbenchFileEntry {
  return {
    rel_path,
    file_type: "TXT",
    sort_index: 0,
    progress: {
      unit: "line",
      total_count: 3,
      completed_count: 1,
      skipped_count: 0,
      failed_count: 0,
      pending_count: 2,
      completion_percent,
    },
  };
}

describe("WorkbenchFileTable", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  /** 挂载真实表格，覆盖页面列配置与通用表格的接入。 */
  async function render(entries: WorkbenchFileEntry[]): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <TooltipProvider delay={0}>
          <WorkbenchFileTable
            entries={entries}
            selected_entry_ids={[]}
            active_entry_id={null}
            anchor_entry_id={null}
            readonly={false}
            on_selection_change={() => {}}
            on_prepare_entry_action={() => {}}
            on_reset={() => {}}
            on_reorder={async () => {}}
          />
        </TooltipProvider>,
      ),
    );
  }

  /** 键盘聚焦触发提示，避免通过 Tooltip 内部状态驱动测试。 */
  async function focus_tooltip(target: HTMLElement): Promise<Element> {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      target.focus();
    });
    await act(async () =>
      vi.waitFor(() =>
        expect(document.querySelector('[role="tooltip"][data-open]')).not.toBeNull(),
      ),
    );
    return document.querySelector('[role="tooltip"][data-open]')!;
  }

  it("PDF 文件显示可聚焦的 AGENT 限制提示并传递页进度", async () => {
    const entry: WorkbenchFileEntry = {
      ...create_entry("books/book.pdf"),
      file_type: "PDF",
      progress: {
        unit: "page",
        total_count: 3,
        completed_count: 2,
        skipped_count: 1,
        failed_count: null,
        pending_count: 0,
        completion_percent: 100,
      },
    };
    await render([entry]);
    const badge = container.querySelector<HTMLElement>(
      '.workbench-page__table-file [data-tone="brand"]',
    )!;
    await focus_tooltip(badge);
    await act(async () => badge.blur());
    await act(async () =>
      vi.waitFor(() => expect(document.querySelector('[role="tooltip"][data-open]')).toBeNull()),
    );
    const progress = container.querySelector<HTMLElement>(
      ".workbench-page__table-progress-cell [data-tone]",
    )!;
    expect(Number.parseFloat(progress.textContent!)).toBe(entry.progress.completion_percent); // 完成率沿用后端快照，不能在表格按完成页数重新计算。
    const tooltip = await focus_tooltip(progress);
    expect(tooltip.textContent).toContain(
      JSON.stringify({
        key: "task_progress.page",
        status: "task_progress.total_lines",
        count: "3",
      }),
    );
  });

  it("按文件名自然排序，按进度排序时同值使用路径顺序并可恢复工程顺序", async () => {
    await render([
      create_entry("chapter10.txt", 33),
      create_entry("chapter2.txt", 33),
      create_entry("chapter1.txt", 100),
    ]);
    const read_paths = () =>
      [...container.querySelectorAll(".workbench-page__table-file-text")].map((e) => e.textContent);
    const sort_buttons = container.querySelectorAll<HTMLButtonElement>(".app-table__sort-trigger");
    await act(async () => sort_buttons[0]?.click());
    expect(read_paths()).toEqual(["chapter1.txt", "chapter2.txt", "chapter10.txt"]);
    await act(async () => sort_buttons[1]?.click());
    expect(read_paths()).toEqual(["chapter2.txt", "chapter10.txt", "chapter1.txt"]);
    await act(async () => sort_buttons[1]?.click());
    expect(read_paths()).toEqual(["chapter1.txt", "chapter10.txt", "chapter2.txt"]);
    await act(async () => sort_buttons[1]?.click());
    expect(read_paths()).toEqual(["chapter10.txt", "chapter2.txt", "chapter1.txt"]);
  });

  it("行操作按钮桌面保持 20px，触屏与窄视口用不可见热区补到 40px 量级", () => {
    // 桌面：视觉尺寸不回归，仍是 20px 图标按钮。
    expect(workbench_page_css).toContain("width: 20px;");
    expect(workbench_page_css).toContain("height: 20px;");

    // 触屏与窄视口：-10px 四向热区把点击目标补到 40px 量级，不改变渲染尺寸。
    const phone_block_start = workbench_page_css.indexOf("@media (hover: none)");
    expect(phone_block_start).toBeGreaterThan(-1);
    const phone_block = workbench_page_css.slice(
      phone_block_start,
      workbench_page_css.indexOf("\n}", phone_block_start),
    );
    expect(phone_block).toContain(".workbench-page__row-action");
    expect(phone_block).toContain("inset: -10px;");
  });
});
