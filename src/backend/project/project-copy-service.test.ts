import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppPathService } from "../app/app-path-service";
import { ProjectDatabase } from "../database/database-operations";
import { AppError } from "../../shared/error";
import { ProjectCopyService } from "./project-copy-service";
import { ProjectSessionState } from "./project-session-state";

let data_root = "";
let project_path = "";
let database: ProjectDatabase;
let session_state: ProjectSessionState;
let paths: AppPathService;
let service: ProjectCopyService;

beforeEach(async () => {
  data_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-project-copy-"));
  project_path = path.join(data_root, "current.lg");
  database = new ProjectDatabase();
  await database.create_project(project_path, "原始工程");
  await database.transaction(project_path, (writer) => {
    writer.set_meta(project_path, "updated_at", "2026-10-18T00:00:00.000Z");
    writer.add_asset(project_path, "script.txt", new TextEncoder().encode("原文"), "TXT", null, 0);
  });
  session_state = new ProjectSessionState();
  await session_state.mark_loaded(project_path);
  paths = new AppPathService({
    appRoot: data_root,
    builtinRoot: path.join(data_root, "builtin"),
    dataRoot: path.join(data_root, "data"),
  });
  service = new ProjectCopyService(database, session_state, paths);
});

afterEach(async () => {
  await database.close();
  fs.rmSync(data_root, { recursive: true, force: true });
});

describe("ProjectCopyService", () => {
  it("副本落入用户数据固定目录，可重新打开且与源数据一致", async () => {
    const copy = await service.copy_project();

    expect(path.dirname(copy.path)).toBe(paths.get_project_copy_root_dir());
    expect(copy.name).toBe(path.basename(copy.path));
    expect(copy.name.startsWith("current_副本_")).toBe(true);
    expect(copy.name.endsWith(".lg")).toBe(true);
    expect(copy.size).toBe(fs.statSync(copy.path).size);
    expect(copy.path).not.toBe(project_path);

    const reopened = new ProjectDatabase();
    try {
      await reopened.prepare(copy.path);
      expect(await reopened.get_all_meta(copy.path)).toMatchObject({
        name: "原始工程",
        updated_at: "2026-10-18T00:00:00.000Z",
      });
      const records = await reopened.get_all_asset_records(copy.path);
      expect(records.map((record) => record.path)).toEqual(["script.txt"]);
      const content = await reopened.read_asset_content(copy.path, "script.txt");
      expect(Buffer.from(content ?? new Uint8Array()).toString("utf8")).toBe("原文");
    } finally {
      await reopened.close();
    }
  });

  it("同秒重复复制不覆盖已有副本", async () => {
    const first = await service.copy_project();
    const second = await service.copy_project();

    expect(second.path).not.toBe(first.path);
    expect(fs.existsSync(first.path)).toBe(true);
    expect(second.name.endsWith("_2.lg")).toBe(true);
  });

  it("未加载工程时按会话错误码拒绝，不创建副本目录", async () => {
    const empty_state = new ProjectSessionState();

    await expect(
      new ProjectCopyService(database, empty_state, paths).copy_project(),
    ).rejects.toMatchObject({ code: "project.not_loaded" });
    expect(fs.existsSync(paths.get_project_copy_root_dir())).toBe(false);
  });

  it("源工程不可读时保留错误事实且不留下半成品副本", async () => {
    const broken_path = path.join(data_root, "broken.lg");
    fs.writeFileSync(broken_path, "not a sqlite database");
    const broken_state = new ProjectSessionState();
    await broken_state.mark_loaded(broken_path);

    await expect(
      new ProjectCopyService(database, broken_state, paths).copy_project(),
    ).rejects.toThrow(AppError);
    expect(fs.readdirSync(paths.get_project_copy_root_dir())).toEqual([]);
  });
});
