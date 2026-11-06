import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AppButton } from "@frontend/widgets/app-button";
import { CommandBar } from "@frontend/widgets/command-bar/command-bar";

// 触屏与窄视口的点击热区由 CSS 媒体查询决定，jsdom 不求值样式表，按样式源文断言契约。
const command_bar_css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "command-bar.css"),
  "utf8",
);

describe("CommandBar", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
      });
    }

    container?.remove();
    container = null;
    root = null;
  });

  it("操作按钮进入工具栏容器，触屏与窄视口用不可见热区补到 40px 量级", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <CommandBar
          actions={
            <AppButton type="button" size="toolbar">
              导入
            </AppButton>
          }
        />,
      );
    });

    // 页面传入的操作按钮必须是工具栏容器后代，热区选择器才能覆盖各页面命令栏。
    const toolbar = container.querySelector(".command-bar__toolbar");
    const action_button = container.querySelector<HTMLButtonElement>('[data-size="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(action_button).not.toBeNull();
    expect(toolbar?.contains(action_button ?? null)).toBe(true);

    const phone_block_start = command_bar_css.indexOf("@media (hover: none)");
    expect(phone_block_start).toBeGreaterThan(-1);
    const phone_block = command_bar_css.slice(
      phone_block_start,
      command_bar_css.indexOf("\n}", phone_block_start),
    );

    // 工具栏按钮 36px + 2px 四向达到 40px 量级；热区走 ::before，不与页面自有样式争用。
    expect(phone_block).toContain('.command-bar__toolbar [data-slot="button"]');
    expect(phone_block).toContain("inset: -2px;");
    expect(phone_block).toContain("::before");
    expect(phone_block).not.toContain("::after");
  });
});
