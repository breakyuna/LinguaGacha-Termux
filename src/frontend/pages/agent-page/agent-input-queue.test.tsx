import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: () => ({ ref: vi.fn(), handleRef: vi.fn(), isDragSource: false }),
}));
vi.mock("@frontend/app/locale/locale-context", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock("@frontend/shadcn/tooltip", () => ({
  Tooltip: (props: { children?: ReactNode; render?: ReactNode }) => (
    <>{props.render ?? props.children}</>
  ),
  TooltipTrigger: (props: { children?: ReactNode; render?: ReactNode }) => (
    <>{props.render ?? props.children}</>
  ),
  TooltipContent: (props: { children?: ReactNode; render?: ReactNode }) => (
    <>{props.render ?? props.children}</>
  ),
  TooltipTarget: (props: { children: ReactNode }) => <span>{props.children}</span>,
}));

import { AgentInputQueue } from "./agent-input-queue";

describe("AgentInputQueue", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root !== null) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("转发编辑、删除与立即发送", async () => {
    const on_edit = vi.fn();
    const on_delete = vi.fn();
    const on_reorder = vi.fn(async () => {});
    const on_send_now = vi.fn();
    const first = {
      id: "queue-1",
      text: "检查第一章",
      attachments: [],
      status: "queued" as const,
      createdAt: 1,
    };
    const second = {
      id: "queue-2",
      text: "检查第二章",
      attachments: [],
      status: "queued" as const,
      createdAt: 2,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AgentInputQueue
          queue={{ paused: true, canSendNow: true, items: [first, second] }}
          disabled={false}
          on_edit={on_edit}
          on_delete={on_delete}
          on_reorder={on_reorder}
          on_send_now={on_send_now}
        />,
      ),
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    await act(async () =>
      buttons
        .find((button) => button.getAttribute("aria-label") === "agent_page.queue.send_now")
        ?.click(),
    );
    await act(async () =>
      buttons
        .find((button) => button.getAttribute("aria-label") === "agent_page.action.edit")
        ?.click(),
    );
    await act(async () =>
      buttons
        .find((button) => button.getAttribute("aria-label") === "agent_page.queue.delete")
        ?.click(),
    );

    expect(on_send_now).toHaveBeenCalledWith("queue-1");
    expect(on_edit).toHaveBeenCalledWith(first);
    expect(on_delete).toHaveBeenCalledWith("queue-1");
  });

  it("sending 项把主操作切为 busy 并禁用全部操作", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AgentInputQueue
          queue={{
            paused: false,
            canSendNow: false,
            items: [
              { id: "queue-1", text: "插队", attachments: [], status: "sending", createdAt: 1 },
            ],
          }}
          disabled={false}
          on_edit={vi.fn()}
          on_delete={vi.fn()}
          on_reorder={vi.fn()}
          on_send_now={vi.fn()}
        />,
      ),
    );

    const send_action = container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
    expect(send_action?.disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".agent-input-queue__item button")].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
  });

  it("上移/下移按钮提交相邻顺序，边界项禁用对应方向", async () => {
    const on_reorder = vi.fn(async () => {});
    const items = [
      { id: "queue-1", text: "第一章", attachments: [], status: "queued" as const, createdAt: 1 },
      { id: "queue-2", text: "第二章", attachments: [], status: "queued" as const, createdAt: 2 },
    ];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AgentInputQueue
          queue={{ paused: true, canSendNow: true, items }}
          disabled={false}
          on_edit={vi.fn()}
          on_delete={vi.fn()}
          on_reorder={on_reorder}
          on_send_now={vi.fn()}
        />,
      ),
    );

    const move_up_buttons = [
      ...container!.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="agent_page.queue.move_up"]',
      ),
    ];
    const move_down_buttons = [
      ...container!.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="agent_page.queue.move_down"]',
      ),
    ];

    // 首行不能上移，末行不能下移；相邻交换沿用拖拽共用的提交入口。
    expect(move_up_buttons.map((button) => button.disabled)).toEqual([true, false]);
    expect(move_down_buttons.map((button) => button.disabled)).toEqual([false, true]);

    // 顺序以后端快照为权威，组件不保留本地乐观顺序：两个方向交换同一对行得到同一提交结果。
    await act(async () => move_down_buttons[0]?.click());
    expect(on_reorder).toHaveBeenCalledWith(["queue-2", "queue-1"]);

    await act(async () => move_up_buttons[1]?.click());
    expect(on_reorder).toHaveBeenLastCalledWith(["queue-2", "queue-1"]);
    expect(on_reorder).toHaveBeenCalledTimes(2);
  });

  it("发送中的行阻断相邻方向的重排按钮", async () => {
    const on_reorder = vi.fn(async () => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AgentInputQueue
          queue={{
            paused: true,
            canSendNow: true,
            items: [
              { id: "queue-1", text: "第一章", attachments: [], status: "queued", createdAt: 1 },
              { id: "queue-2", text: "第二章", attachments: [], status: "sending", createdAt: 2 },
              { id: "queue-3", text: "第三章", attachments: [], status: "queued", createdAt: 3 },
            ],
          }}
          disabled={false}
          on_edit={vi.fn()}
          on_delete={vi.fn()}
          on_reorder={on_reorder}
          on_send_now={vi.fn()}
        />,
      ),
    );

    const read_disabled = (label: string): boolean[] =>
      [...container!.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)].map(
        (button) => button.disabled,
      );

    // 首行不能上移、末行不能下移；与发送中行相邻的方向同样不可用。
    expect(read_disabled("agent_page.queue.move_up")).toEqual([true, true, true]);
    expect(read_disabled("agent_page.queue.move_down")).toEqual([true, true, true]);
    expect(on_reorder).not.toHaveBeenCalled();
  });
});
