import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppPathService } from "../app/app-path-service";
import { AppError } from "../../shared/error";
import { WebFileService } from "./web-file-service";
import {
  create_export_directory,
  release_materials,
  remove_export_directory,
  resolve_material_import_commands,
  resolve_material_path,
  resolve_material_paths,
  stage_existing_file,
} from "./web-import-materials";

const data_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-web-materials-"));
const paths = new AppPathService({
  appRoot: data_root,
  builtinRoot: path.join(data_root, "builtin"),
  dataRoot: path.join(data_root, "data"),
});
const staging_root = paths.get_user_data_path("web-imports");

let service: WebFileService;

function create_upload_body(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

/** 捕获同步抛出并按 AppError 事实断言，避免依赖 toThrow 的匹配语义。 */
function capture_error(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected the call to throw an AppError.");
}

async function stage_material(name: string, content: string) {
  return await service.stage_upload(
    name,
    create_upload_body(content),
    new AbortController().signal,
  );
}

beforeAll(() => {
  service = new WebFileService({ paths });
});

afterAll(async () => {
  await service.dispose();
  fs.rmSync(data_root, { recursive: true, force: true });
});

describe("web import materials", () => {
  it("解析暂存材料返回暂存区内的绝对路径", async () => {
    const staged = await stage_material("novel.txt", "正文");

    expect(resolve_material_paths(service, [staged.material_id])).toEqual([staged.path]);
    expect(resolve_material_path(service, staged.material_id)).toBe(staged.path);
    expect(resolve_material_paths(service, [])).toEqual([]);
  });

  it("材料不存在按请求参数拒绝，不暴露磁盘文件语义", () => {
    const error = capture_error(() => resolve_material_paths(service, ["missing-material"]));

    expect(error.code).toBe("request.validation_failed");
    expect(error.public_details).toMatchObject({
      reason: "web_material_unknown",
      material_id: "missing-material",
    });
  });

  it("服务缺失时材料请求按能力缺失拒绝，空列表不受影响", () => {
    expect(resolve_material_paths(null, [])).toEqual([]);
    expect(capture_error(() => resolve_material_paths(null, ["material-1"])).code).toBe(
      "runtime.capability_missing",
    );
    expect(capture_error(() => resolve_material_path(null, "material-1")).code).toBe(
      "runtime.capability_missing",
    );
    expect(
      capture_error(() => resolve_material_import_commands(null, [{ material_id: "material-1" }]))
        .code,
    ).toBe("runtime.capability_missing");
  });

  it("已有文件复制进暂存区并登记为可读取材料", async () => {
    const source_path = path.join(data_root, "exports", "rules.json");
    fs.mkdirSync(path.dirname(source_path), { recursive: true });
    fs.writeFileSync(source_path, '[{"src":"a","dst":"b"}]');

    const staged = await stage_existing_file(service, source_path, "quality-rules.json");

    expect(path.dirname(staged.path)).toBe(staging_root);
    expect(staged.name).toBe("quality-rules.json");
    expect(staged.size).toBe(fs.statSync(source_path).size);
    const material = service.read_material(staged.material_id);
    expect(material.name).toBe("quality-rules.json");
    expect(fs.readFileSync(staged.path, "utf8")).toBe(fs.readFileSync(source_path, "utf8"));
  });

  it("暂存源文件缺失时按文件缺失拒绝", async () => {
    await expect(
      stage_existing_file(service, path.join(data_root, "missing.txt"), "missing.txt"),
    ).rejects.toMatchObject({ code: "file.not_found" });
  });

  it("导入命令缺省目标使用上传显示名，显式目标原样保留", async () => {
    const staged = await stage_material("www/data/escape name.txt", "正文");

    expect(
      resolve_material_import_commands(service, [
        { material_id: staged.material_id },
        { material_id: staged.material_id, target_rel_path: "data/novel.txt" },
      ]),
    ).toEqual([
      // 缺省目标自然带上上传时的相对结构，工程资产名保留目录层级。
      { source_path: staged.path, target_rel_path: "www/data/escape_name.txt" },
      { source_path: staged.path, target_rel_path: "data/novel.txt" },
    ]);
    expect(resolve_material_import_commands(service, [])).toEqual([]);
  });

  it("释放材料删除暂存文件并忽略不存在的身份", async () => {
    const staged = await stage_material("release.txt", "正文");

    await release_materials(service, [staged.material_id, "already-gone"]);

    expect(fs.existsSync(staged.path)).toBe(false);
    expect(() => service.read_material(staged.material_id)).toThrow(AppError);
  });

  it("一次性导出目录位于暂存区且可递归清理", async () => {
    const export_directory = create_export_directory(staging_root);

    expect(path.dirname(export_directory)).toBe(staging_root);
    expect(path.basename(export_directory).startsWith(".export-")).toBe(true);
    fs.mkdirSync(export_directory, { recursive: true });
    fs.writeFileSync(path.join(export_directory, "rules.json"), "[]");
    fs.writeFileSync(path.join(export_directory, "rules.xlsx"), "xlsx");

    await remove_export_directory(export_directory);

    expect(fs.existsSync(export_directory)).toBe(false);
    await expect(remove_export_directory(export_directory)).resolves.toBeUndefined();
  });
});
