import { describe, expect, it } from "vitest";

import type { WebHostBootstrap } from "@frontend/app/host/host-bridge";
import { create_web_host_bridge } from "./web-host-bridge";
import {
  subscribe_web_file_pick_requests,
  type WebFilePickIntent,
  type WebFilePickResult,
} from "@frontend/features/web-file-picker/picker-request-bus";

const BOOTSTRAP: WebHostBootstrap = {
  appVersion: "1.2.3",
  shell: {
    platform: "android",
    usesTitleBarOverlay: false,
    titleBarHeight: 40,
    titleBarControlSide: "none",
    titleBarSafeAreaStart: 0,
    titleBarSafeAreaEnd: 0,
  },
  backendApi: { baseUrl: "http://127.0.0.1:38191" },
  capabilities: {
    fileDialog: true,
    directoryDialog: true,
    saveDialog: true,
    imageHost: false,
    pdfHost: false,
    systemNotification: false,
    autoUpdate: false,
  },
  session: { established: true },
};

/** 订阅总线并记录收到的意图，按给定结果结算。 */
function capture_pick_intents(): {
  intents: WebFilePickIntent[];
  settle: (result: WebFilePickResult) => void;
  unsubscribe: () => void;
} {
  const intents: WebFilePickIntent[] = [];
  let settle_active: ((result: WebFilePickResult) => void) | null = null;
  const unsubscribe = subscribe_web_file_pick_requests((intent, resolve) => {
    intents.push(intent);
    settle_active = resolve;
  });
  return {
    intents,
    settle: (result) => settle_active?.(result),
    unsubscribe,
  };
}

describe("create_web_host_bridge 文件选择接线", () => {
  it("源文件与工作台入口走可上传的 file 模式", async () => {
    const capture = capture_pick_intents();
    const bridge = create_web_host_bridge(BOOTSTRAP);
    const pending = bridge.pickProjectSourceFilePath();
    expect(capture.intents).toEqual([{ mode: "file", allow_upload: true }]);
    capture.settle({ canceled: false, paths: ["/data/a.txt"], material_ids: ["mat-1"] });
    await expect(pending).resolves.toEqual({
      canceled: false,
      paths: ["/data/a.txt"],
      material_ids: ["mat-1"],
    });
    capture.unsubscribe();

    const workbench_capture = capture_pick_intents();
    void bridge.pickWorkbenchFilePath();
    expect(workbench_capture.intents).toEqual([{ mode: "file", allow_upload: true }]);
    workbench_capture.unsubscribe();
  });

  it("打开工程只浏览，保存与目录分别走 save 和 directory 模式", async () => {
    const capture = capture_pick_intents();
    const bridge = create_web_host_bridge(BOOTSTRAP);
    void bridge.pickProjectFilePath();
    void bridge.pickProjectSavePath("demo.lg");
    void bridge.pickProjectSourceDirectoryPath();
    void bridge.pickFixedProjectDirectory();
    expect(capture.intents).toEqual([
      { mode: "file" },
      { mode: "save", default_name: "demo.lg" },
      { mode: "directory" },
      { mode: "directory" },
    ]);
    capture.unsubscribe();
  });

  it("导出入口直接回答受控下载，不弹出选择器", async () => {
    const capture = capture_pick_intents();
    const bridge = create_web_host_bridge(BOOTSTRAP);

    await expect(bridge.pickGlossaryExportPath("rules.json")).resolves.toEqual({
      canceled: false,
      paths: [],
      material_ids: [],
      web_download: true,
    });
    await expect(bridge.pickPromptExportFilePath()).resolves.toEqual({
      canceled: false,
      paths: [],
      material_ids: [],
      web_download: true,
    });
    expect(capture.intents).toEqual([]);
    capture.unsubscribe();
  });

  it("选择器未挂载时按接线失败拒绝", async () => {
    const bridge = create_web_host_bridge(BOOTSTRAP);
    await expect(bridge.pickGlossaryImportFilePath()).rejects.toThrow(
      "Web file picker host is not mounted.",
    );
  });

  it("自动更新能力缺失仍按能力缺失反馈", async () => {
    const bridge = create_web_host_bridge(BOOTSTRAP);
    await expect(
      bridge.launchUpdate({ latest_version: "1.2.4", zip_path: "/unused/update.zip" }),
    ).rejects.toMatchObject({
      code: "runtime.capability_missing",
    });
    await expect(bridge.quitApp()).rejects.toMatchObject({ code: "runtime.capability_missing" });
  });
});
