import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppPathService } from "../app/app-path-service";
import { AppError } from "../../shared/error";
import { WebFileService } from "./web-file-service";

const data_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-web-files-"));
const outside_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-web-outside-"));
const paths = new AppPathService({
  appRoot: data_root,
  builtinRoot: path.join(data_root, "builtin"),
  dataRoot: path.join(data_root, "data"),
});

fs.mkdirSync(path.join(data_root, "home", "novels", "epub"), { recursive: true });
fs.writeFileSync(path.join(data_root, "home", "novels", "a.txt"), "hello");
fs.writeFileSync(path.join(data_root, "home", "novels", "epub", "b.epub"), "zip");
fs.mkdirSync(path.join(outside_root, "secret"), { recursive: true });
fs.writeFileSync(path.join(outside_root, "secret", "hidden.txt"), "secret");

let service: WebFileService;

function create_upload_body(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

beforeAll(() => {
  service = new WebFileService({
    paths,
    extraRoots: [{ id: "fixture-home", label: "Fixture", path: path.join(data_root, "home") }],
  });
});

afterAll(async () => {
  await service.dispose();
  fs.rmSync(data_root, { recursive: true, force: true });
  fs.rmSync(outside_root, { recursive: true, force: true });
});

describe("web file service", () => {
  it("允许根包含显式注入目录，隐藏项不进入列举", () => {
    const roots = service.list_roots();

    expect(roots.map((root) => root.id)).toContain("fixture-home");
    const listing = service.list_directory("fixture-home", "/novels");
    expect(listing.path).toBe(path.join(data_root, "home", "novels"));
    expect(listing.parent_path).toBe(path.join(data_root, "home"));
    expect(listing.entries).toEqual([
      { name: "epub", kind: "directory", size: null },
      { name: "a.txt", kind: "file", size: 5 },
    ]);
  });

  it("列举收敛在允许根内，越界与穿越都拒绝", () => {
    expect(() => service.list_directory("fixture-home", "/../..")).toThrow(AppError);
    expect(() => service.list_directory("fixture-home", `/${path.basename(outside_root)}`)).toThrow(
      AppError,
    );
    expect(() => service.list_directory("unknown-root", "/")).toThrow(AppError);
    expect(() => service.list_directory("fixture-home", "/missing")).toThrow(AppError);
  });

  it("上传材料落盘后可读取，并按身份释放", async () => {
    const staged = await service.stage_upload(
      "escape name.txt",
      create_upload_body(" imported "),
      new AbortController().signal,
    );

    expect(staged.name).toBe("escape name.txt");
    expect(staged.size).toBe(10);
    expect(fs.existsSync(staged.path)).toBe(true);
    expect(path.dirname(staged.path)).toBe(paths.get_user_data_path("web-imports"));
    // 无竞争时落盘名用清洗后的原始名（分隔符变下划线），导入预览目标名不带暂存身份后缀。
    expect(path.basename(staged.path)).toBe("escape_name.txt");

    const material = service.read_material(staged.material_id);
    expect(material.name).toBe("escape name.txt");
    expect(material.size).toBe(10);

    await service.release_material(staged.material_id);
    expect(fs.existsSync(staged.path)).toBe(false);
    expect(() => service.read_material(staged.material_id)).toThrow(AppError);
  });

  it("上传名只含单段时分隔符清洗为下划线，仍落暂存区根", async () => {
    const staged = await service.stage_upload(
      "..\\escape name.txt",
      create_upload_body(" imported "),
      new AbortController().signal,
    );

    expect(staged.name).toBe("..\\escape name.txt");
    expect(path.dirname(staged.path)).toBe(paths.get_user_data_path("web-imports"));
    expect(path.basename(staged.path)).toBe("_escape_name.txt");
  });

  it("带目录的上传名按段清洗，落点与显示名都保留相对结构", async () => {
    const staged = await service.stage_upload(
      "www/data/Map 001.json",
      create_upload_body("{}"),
      new AbortController().signal,
    );

    const staging_root = paths.get_user_data_path("web-imports");
    expect(staged.name).toBe("www/data/Map_001.json");
    expect(staged.path).toBe(path.join(staging_root, "www", "data", "Map_001.json"));
    expect(fs.readFileSync(staged.path, "utf8")).toBe("{}");
    expect(service.read_material(staged.material_id).name).toBe("www/data/Map_001.json");
    // 批次目录内子路径进入受控下载边界。
    expect(service.open_download(staged.path).name).toBe("Map_001.json");
  });

  it("上传名中的空段、上级目录、绝对路径与盘符都拒绝", async () => {
    for (const name of [
      "../escape.txt",
      "www/../../escape.txt",
      "/etc/passwd",
      "www//Map001.json",
      "www/",
      "C:/www/Map001.json",
      ".",
      "..",
    ]) {
      await expect(
        service.stage_upload(name, create_upload_body("x"), new AbortController().signal),
      ).rejects.toMatchObject({ code: "request.validation_failed" });
    }
    expect(fs.readdirSync(paths.get_user_data_path("web-imports"))).not.toContain("escape.txt");
  });

  it("同目录重名才追加身份后缀，不同批次目录互不影响", async () => {
    const first = await service.stage_upload(
      "batch-a/data/Map001.json",
      create_upload_body("first"),
      new AbortController().signal,
    );
    const second = await service.stage_upload(
      "batch-a/data/Map001.json",
      create_upload_body("second"),
      new AbortController().signal,
    );
    const other_batch = await service.stage_upload(
      "batch-b/data/Map001.json",
      create_upload_body("third"),
      new AbortController().signal,
    );

    const staging_root = paths.get_user_data_path("web-imports");
    expect(first.path).toBe(path.join(staging_root, "batch-a", "data", "Map001.json"));
    expect(second.path).toBe(
      path.join(staging_root, "batch-a", "data", `Map001_${second.material_id}.json`),
    );
    // 另一批次目录的同名文件不触发身份后缀。
    expect(other_batch.path).toBe(path.join(staging_root, "batch-b", "data", "Map001.json"));
    expect(fs.readFileSync(first.path, "utf8")).toBe("first");
    expect(fs.readFileSync(second.path, "utf8")).toBe("second");
    expect(fs.readFileSync(other_batch.path, "utf8")).toBe("third");

    await service.release_material(first.material_id);
    await service.release_material(second.material_id);
    // 批次目录内最后一个材料释放后回收空目录，暂存区不堆积空批次目录。
    expect(fs.existsSync(path.join(staging_root, "batch-a"))).toBe(false);
    expect(fs.existsSync(path.join(staging_root, "batch-b", "data", "Map001.json"))).toBe(true);
    await service.release_material(other_batch.material_id);
    expect(fs.existsSync(path.join(staging_root, "batch-b"))).toBe(false);
  });

  it("同名上传重名才追加身份后缀，并发上传不互相覆盖", async () => {
    const first = await service.stage_upload(
      "same.txt",
      create_upload_body("first"),
      new AbortController().signal,
    );
    const second = await service.stage_upload(
      "same.txt",
      create_upload_body("second"),
      new AbortController().signal,
    );

    expect(path.basename(first.path)).toBe("same.txt");
    expect(path.basename(second.path)).toBe(`same_${second.material_id}.txt`);
    expect(first.path).not.toBe(second.path);
    expect(fs.readFileSync(first.path, "utf8")).toBe("first");
    expect(fs.readFileSync(second.path, "utf8")).toBe("second");

    const concurrent = await Promise.all(
      ["a.txt", "a.txt", "a.txt"].map((name, index) =>
        service.stage_upload(
          name,
          create_upload_body(`body-${index}`),
          new AbortController().signal,
        ),
      ),
    );
    const distinct_paths = new Set(concurrent.map((material) => material.path));
    expect(distinct_paths.size).toBe(3);
    for (const material of concurrent) {
      expect(fs.existsSync(material.path)).toBe(true);
    }
  });

  it("上传取消后不留下半成品", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream_controller) {
        stream_controller.enqueue(new TextEncoder().encode("partial"));
        controller.abort();
      },
    });

    await expect(service.stage_upload("cancel.txt", body, controller.signal)).rejects.toBeTruthy();
    const upload_root = paths.get_user_data_path("web-imports");
    const leftovers = fs.readdirSync(upload_root).filter((name) => name.includes("cancel"));
    expect(leftovers).toEqual([]);
  });

  it("下载只交付允许根内文件，根外路径一律拒绝", async () => {
    const allowed = service.open_download(path.join(data_root, "home", "novels", "a.txt"));
    expect(allowed.name).toBe("a.txt");
    expect(allowed.size).toBe(5);

    expect(() => service.open_download(path.join(outside_root, "secret", "hidden.txt"))).toThrow(
      AppError,
    );
    expect(() => service.open_download("")).toThrow(AppError);
    expect(() => service.open_download(path.join(data_root, "home", "missing.txt"))).toThrow(
      AppError,
    );
  });

  it("工程副本目录纳入下载边界，目录未创建时不放行", async () => {
    const copy_directory = paths.get_project_copy_root_dir();
    const copy_path = path.join(copy_directory, "demo_副本_20261018_120000.lg");
    fs.mkdirSync(copy_directory, { recursive: true });
    fs.writeFileSync(copy_path, "sqlite");

    const download = service.open_download(copy_path);
    expect(download.name).toBe("demo_副本_20261018_120000.lg");
    expect(download.size).toBe(6);
    await new Promise<void>((resolve) => {
      download.stream.on("error", () => resolve());
      download.stream.on("close", () => resolve());
      download.stream.destroy();
    });
    // 暂存区与副本目录之外的用户数据仍被拒绝。
    expect(() =>
      service.open_download(path.join(data_root, "data", "userdata", "config.json")),
    ).toThrow(AppError);

    fs.rmSync(copy_path);
    expect(() => service.open_download(copy_path)).toThrow(AppError);
  });

  it("释放后拒绝新上传，dispose 清理服务拥有的材料", async () => {
    const staged = await service.stage_upload(
      "keep.txt",
      create_upload_body("keep"),
      new AbortController().signal,
    );
    await service.dispose();

    expect(fs.existsSync(staged.path)).toBe(false);
    await expect(
      service.stage_upload("after.txt", create_upload_body("x"), new AbortController().signal),
    ).rejects.toThrow(AppError);
  });
});
