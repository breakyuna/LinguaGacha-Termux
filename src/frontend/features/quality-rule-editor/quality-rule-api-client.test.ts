import { beforeEach, describe, expect, it, vi } from "vitest";

const { api_fetch_mock, release_mock, deliver_mock } = vi.hoisted(() => ({
  api_fetch_mock: vi.fn(),
  release_mock: vi.fn(),
  deliver_mock: vi.fn(),
}));

vi.mock("@frontend/app/desktop/desktop-api", () => ({
  api_fetch: api_fetch_mock,
}));

vi.mock("@frontend/features/web-file-picker/web-file-picker-api", () => ({
  release_web_file_material: release_mock,
}));

vi.mock("@frontend/features/web-file-picker/web-file-download", () => ({
  deliver_web_file_material: deliver_mock,
}));

import {
  export_quality_rule_entries,
  import_quality_rule_entries,
  read_quality_rule_snapshot,
} from "./quality-rule-api-client";

describe("quality rule api client", () => {
  beforeEach(() => {
    api_fetch_mock.mockReset();
  });

  it("读取规则视图", async () => {
    const response = { projectPath: "E:/demo/demo.lg" };
    api_fetch_mock.mockResolvedValue(response);

    await expect(read_quality_rule_snapshot("glossary")).resolves.toBe(response);
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/quality/rules/query", {
      rule_type: "glossary",
    });
  });

  it("导入消费后端条目并传播解析失败", async () => {
    const entries = [{ entry_id: "hp", src: "HP", dst: "生命值", info: "", case_sensitive: false }];
    api_fetch_mock
      .mockResolvedValueOnce({ entries })
      .mockRejectedValueOnce(new Error("invalid rules"));

    await expect(import_quality_rule_entries("glossary", { path: "E:/rules.json" })).resolves.toBe(
      entries,
    );
    await expect(import_quality_rule_entries("glossary", { path: "E:/bad.json" })).rejects.toThrow(
      "invalid rules",
    );
    expect(api_fetch_mock).toHaveBeenNthCalledWith(1, "/api/quality/rules/import", {
      rule_type: "glossary",
      path: "E:/rules.json",
    });
  });

  it("导入按暂存材料身份提交，path 由后端忽略", async () => {
    const entries = [{ entry_id: "mp", src: "MP", dst: "魔力", info: "", case_sensitive: false }];
    api_fetch_mock.mockResolvedValueOnce({ entries });

    await expect(import_quality_rule_entries("glossary", { material_id: "mat-9" })).resolves.toBe(
      entries,
    );
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/quality/rules/import", {
      rule_type: "glossary",
      path: "",
      material_id: "mat-9",
    });
  });

  it("桌面导出沿用选中的本地路径", async () => {
    vi.stubGlobal("desktopApp", {
      pickGlossaryExportPath: async () => ({ canceled: false, paths: ["E:/out/rules.json"] }),
    });
    api_fetch_mock.mockResolvedValueOnce({ path: "E:/out/rules.json" });

    await expect(
      export_quality_rule_entries({ rule_type: "glossary", file_name: "rules.json", entries: [] }),
    ).resolves.toBe(true);
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/quality/rules/export", {
      rule_type: "glossary",
      path: "E:/out/rules.json",
      entries: [],
    });
    expect(deliver_mock).not.toHaveBeenCalled();
  });

  it("Web 下载交付按材料模式导出并交给受控下载", async () => {
    vi.stubGlobal("desktopApp", {
      pickGlossaryExportPath: async () => ({
        canceled: false,
        paths: [],
        material_ids: [],
        web_download: true,
      }),
    });
    api_fetch_mock.mockResolvedValueOnce({
      path: "/data/web-imports/.export-x/quality-rules.json",
      material: { material_id: "mat-7", name: "quality-rules.json", size: 32 },
    });

    await expect(
      export_quality_rule_entries({ rule_type: "glossary", file_name: "rules.json", entries: [] }),
    ).resolves.toBe(true);
    expect(api_fetch_mock).toHaveBeenCalledWith("/api/quality/rules/export", {
      rule_type: "glossary",
      path: "",
      entries: [],
      material: true,
      material_name: "rules.json",
    });
    expect(deliver_mock).toHaveBeenCalledWith("mat-7");
  });

  it("取消导出不视为成功", async () => {
    vi.stubGlobal("desktopApp", {
      pickGlossaryExportPath: async () => ({ canceled: true, paths: [] }),
    });

    await expect(
      export_quality_rule_entries({ rule_type: "glossary", file_name: "rules.json", entries: [] }),
    ).resolves.toBe(false);
    expect(api_fetch_mock).not.toHaveBeenCalled();
  });
});
