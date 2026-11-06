import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TranslationGenerationDialog } from "./translation-generation-dialog";
import type { TranslationGenerationState } from "./use-translation-generation-flow";

vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (params?.COUNT !== undefined) return `${key}:${params.COUNT}`;
      if (params?.NAME !== undefined) return `${key}:${params.NAME}`;
      return key;
    },
  }),
}));

vi.mock("@frontend/app/desktop/desktop-api", () => ({
  api_file_url: (path: string) => `http://127.0.0.1:38191${path}`,
}));

describe("TranslationGenerationDialog", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let close_handler: ReturnType<typeof vi.fn> | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it("有警告时显示类型计数并提供前往 AGENT 与继续生成", () => {
    const jump_to_agent = vi.fn();
    const confirm_generation = vi.fn(async () => {});
    render_dialog(
      {
        phase: "ready",
        summary: {
          total_count: 3,
          entries: [
            { code: "FOREIGN_CHAR_RESIDUE", count: 1 },
            { code: "GLOSSARY", count: 2 },
          ],
        },
      },
      { jump_to_agent, confirm_generation },
    );

    expect(document.body.textContent).toContain(
      "app.translation_generation.confirmation.warning_description:3",
    );
    expect(document.body.textContent).toContain("proofreading_page.warning.foreign_char_residue1");
    expect(document.body.textContent).toContain("proofreading_page.warning.glossary2");
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="alert-dialog-secondary-action"]')
        ?.click(),
    );
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="alert-dialog-primary-action"]')
        ?.click(),
    );
    expect(jump_to_agent).toHaveBeenCalledOnce();
    expect(confirm_generation).toHaveBeenCalledOnce();
  });

  it("无警告时直接提交确认动作", () => {
    const confirm_generation = vi.fn(async () => {});
    render_dialog(
      { phase: "ready", summary: { total_count: 0, entries: [] } },
      { confirm_generation },
    );

    expect(document.body.querySelector('[data-slot="alert-dialog-secondary-action"]')).toBeNull();
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="alert-dialog-primary-action"]')
        ?.click(),
    );
    expect(confirm_generation).toHaveBeenCalledOnce();
  });

  it("生成完成后按输出文件渲染受控下载链接", () => {
    render_dialog(
      {
        phase: "generated",
        files: [
          { name: "demo.txt", path: "E:/demo/out/demo.txt", size: 12 },
          { name: "demo_双语.txt", path: "E:/demo/out/demo_bilingual.txt", size: 20 },
        ],
      },
      {},
    );

    const links = Array.from(document.body.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "http://127.0.0.1:38191/api/translation/files/download?path=E%3A%2Fdemo%2Fout%2Fdemo.txt",
      "http://127.0.0.1:38191/api/translation/files/download?path=E%3A%2Fdemo%2Fout%2Fdemo_bilingual.txt",
    ]);
    expect(links.every((link) => link.hasAttribute("download"))).toBe(true);
    expect(document.body.textContent).toContain(
      "app.translation_generation.download.file_action:demo.txt",
    );
    expect(document.body.textContent).toContain(
      "app.translation_generation.download.file_action:demo_双语.txt",
    );

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-slot="alert-dialog-primary-action"]')
        ?.click(),
    );
    expect(close_handler).toHaveBeenCalledOnce();
  });

  /** 通过公开流程状态驱动确认与警告分流。 */
  function render_dialog(
    state: TranslationGenerationState,
    callbacks: {
      jump_to_agent?: () => void;
      confirm_generation?: () => Promise<void>;
    } = {},
  ): void {
    const on_close = vi.fn<() => void>();
    close_handler = on_close;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <TranslationGenerationDialog
          can_jump_to_agent
          state={state}
          retry_check={vi.fn()}
          confirm_generation={callbacks.confirm_generation ?? vi.fn(async () => {})}
          jump_to_agent={callbacks.jump_to_agent ?? vi.fn()}
          close={on_close}
        />,
      );
    });
  }
});
