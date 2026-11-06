import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api_fetch, DesktopApiError } from "@frontend/app/desktop/desktop-api";
import { create_empty_batch_translation_snapshot } from "@shared/batch-translation/batch-translation";
import { useProofreadingBatchActions } from "./use-proofreading-batch-actions";

vi.mock("@frontend/app/desktop/desktop-api", async (import_original) => {
  return {
    ...(await import_original<typeof import("@frontend/app/desktop/desktop-api")>()),
    api_fetch: vi.fn(),
  };
});

it.each([false, true])("重翻确认提交稳定身份并完成回执或错误处理：失败 %s", async (failed) => {
  const snapshot = create_empty_batch_translation_snapshot();
  const error = new Error("请求失败");
  vi.mocked(api_fetch).mockReset();
  if (failed) vi.mocked(api_fetch).mockRejectedValueOnce(error);
  else vi.mocked(api_fetch).mockResolvedValueOnce({ batch_translation: snapshot });
  const options: Parameters<typeof useProofreadingBatchActions>[0] = {
    readonly: false,
    is_refreshing: false,
    is_writing: false,
    dialog_open: true,
    list_revisions: {},
    read_items_by_row_ids: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        item_id: Number(id),
        dst: "译文",
        name_dst: null,
        status: "PROCESSED",
      })),
    ),
    sync_task_snapshot: vi.fn(),
    run_project_write: vi.fn(async () => true),
    set_is_writing: vi.fn(),
    resolve_preferred_row_id: () => null,
    remember_preferred_row_id: vi.fn(),
    close_edit_dialog: vi.fn(),
    handle_api_error: vi.fn(),
    t: (key) => key,
  };
  let actions!: ReturnType<typeof useProofreadingBatchActions>;
  /** 挂载动作拥有者，页面负责的行级展示由页面集成测试验证。 */
  function Probe() {
    actions = useProofreadingBatchActions(options);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      actions.request_retranslate_row_ids(["1", 'page:["book.pdf",1]']);
    });
    expect(actions.pending_confirmation).toBeNull();
    expect(options.read_items_by_row_ids).not.toHaveBeenCalled();
    await act(async () => {
      actions.request_retranslate_row_ids(["2", "1", "2"]);
    });
    expect(api_fetch).not.toHaveBeenCalled();
    await act(async () => {
      await actions.confirm_pending_confirmation("retranslate");
    });
    expect(api_fetch).toHaveBeenCalledWith("/api/batch-translation/start", {
      operation: "retranslate",
      scope: { kind: "items", item_ids: [2, 1] },
      command_id: expect.any(String),
    });
    expect(actions.pending_confirmation).toBeNull();
    expect(options.set_is_writing).toHaveBeenLastCalledWith(false);
    if (failed) {
      expect(options.sync_task_snapshot).not.toHaveBeenCalled();
      expect(options.handle_api_error).toHaveBeenCalledWith(error, expect.any(String));
      expect(options.close_edit_dialog).not.toHaveBeenCalled();
    } else {
      expect(options.sync_task_snapshot).toHaveBeenCalledWith(snapshot);
      expect(options.close_edit_dialog).toHaveBeenCalledOnce();
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});

/** 挂载批量动作，返回实时 actions 读取入口、选项与卸载入口。 */
async function mount_retranslate_actions(
  submit: (path: string, body: Record<string, unknown>) => Promise<unknown>,
): Promise<{
  read_actions: () => ReturnType<typeof useProofreadingBatchActions>;
  options: Parameters<typeof useProofreadingBatchActions>[0];
  unmount: () => Promise<void>;
}> {
  const options: Parameters<typeof useProofreadingBatchActions>[0] = {
    readonly: false,
    is_refreshing: false,
    is_writing: false,
    dialog_open: true,
    list_revisions: {},
    read_items_by_row_ids: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        item_id: Number(id),
        dst: "译文",
        name_dst: null,
        status: "PROCESSED",
      })),
    ),
    sync_task_snapshot: vi.fn(),
    run_project_write: vi.fn(async () => true),
    set_is_writing: vi.fn(),
    resolve_preferred_row_id: () => null,
    remember_preferred_row_id: vi.fn(),
    close_edit_dialog: vi.fn(),
    handle_api_error: vi.fn(),
    t: (key) => key,
  };
  vi.mocked(api_fetch).mockImplementation(
    async (path: string, body: Record<string, unknown> = {}) => {
      return await submit(path, body);
    },
  );
  let actions!: ReturnType<typeof useProofreadingBatchActions>;
  function Probe() {
    actions = useProofreadingBatchActions(options);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    read_actions: () => actions,
    options,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

/** 走完一次重翻确认提交。 */
async function submit_retranslate(
  read_actions: () => ReturnType<typeof useProofreadingBatchActions>,
): Promise<void> {
  await act(async () => {
    read_actions().request_retranslate_row_ids(["2", "1"]);
  });
  await act(async () => {
    await read_actions().confirm_pending_confirmation("retranslate");
  });
}

it("重翻回包丢失后重查快照，确认已受理按受理处理", async () => {
  const start_bodies: Record<string, unknown>[] = [];
  const { read_actions, options, unmount } = await mount_retranslate_actions(async (path, body) => {
    if (path === "/api/batch-translation/start") {
      start_bodies.push(body);
      throw new DesktopApiError({ code: "network_failed" });
    }
    return {
      batch_translation: {
        ...create_empty_batch_translation_snapshot(),
        status: "running",
      },
    };
  });

  try {
    await submit_retranslate(read_actions);

    expect(start_bodies).toHaveLength(1);
    expect(options.sync_task_snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
    );
    expect(options.handle_api_error).not.toHaveBeenCalled();
    expect(options.close_edit_dialog).toHaveBeenCalledOnce();
  } finally {
    await unmount();
  }
});

it("重翻确认未受理时反馈失败，同范围重试复用同一命令身份", async () => {
  const start_bodies: Record<string, unknown>[] = [];
  let snapshot_available = true;
  const { read_actions, options, unmount } = await mount_retranslate_actions(async (path, body) => {
    if (path === "/api/batch-translation/start") {
      start_bodies.push(body);
      throw new DesktopApiError({ code: "network_failed" });
    }
    if (!snapshot_available) {
      throw new DesktopApiError({ code: "network_failed" });
    }
    return { batch_translation: create_empty_batch_translation_snapshot() };
  });

  try {
    // 第一次提交结果不确定：保留命令身份
    snapshot_available = false;
    await submit_retranslate(read_actions);
    expect(options.handle_api_error).toHaveBeenCalledOnce();

    // 重查可用后同范围重试复用身份，确认未受理则结束该身份寿命
    snapshot_available = true;
    await submit_retranslate(read_actions);
    expect(start_bodies).toHaveLength(2);
    expect(start_bodies[1]?.command_id).toBe(start_bodies[0]?.command_id);
    expect(options.handle_api_error).toHaveBeenCalledTimes(2);

    // 身份已确认终结，下一次提交换用新命令
    await submit_retranslate(read_actions);
    expect(start_bodies).toHaveLength(3);
    expect(start_bodies[2]?.command_id).not.toBe(start_bodies[1]?.command_id);
  } finally {
    await unmount();
  }
});

it("重翻重复受理回包按已受理处理并结束编辑", async () => {
  const { read_actions, options, unmount } = await mount_retranslate_actions(
    async (_path, body) => {
      return {
        accepted: false,
        duplicate: true,
        command_id: body.command_id,
        batch_translation: {
          ...create_empty_batch_translation_snapshot(),
          status: "running",
        },
      };
    },
  );

  try {
    await submit_retranslate(read_actions);

    expect(options.sync_task_snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
    );
    expect(options.handle_api_error).not.toHaveBeenCalled();
    expect(options.close_edit_dialog).toHaveBeenCalledOnce();
  } finally {
    await unmount();
  }
});
