import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { AppPathService } from "../app/app-path-service";
import type { NativeFs } from "../../native/native-fs";
import { default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";
import { is_path_inside } from "./path-boundary";

const NAME_MAX_CHARACTERS = 80;
const MATERIAL_ID_BYTES = 16;
const UPLOAD_MAX_BYTES = 512 * 1024 * 1024; // 单文件上限，覆盖 EPUB 与中小型游戏目录打包
const UPLOAD_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 暂存区总量上限，超出后拒绝新上传
const UPLOAD_MAX_MATERIALS = 64; // 同时驻留的材料数量上限
const DIRECTORY_ENTRY_LIMIT = 2000; // 单次目录列举上限，避免巨型目录拖垮响应
const MATERIAL_TTL_MS = 24 * 60 * 60 * 1000; // 未引用的上传材料保留时长

/** 目录浏览的允许根；标签由入口展示，路径在服务内解析。 */
export type WebFileRoot = {
  id: string;
  label: string;
  path: string;
};

export type WebFileEntry = {
  name: string;
  kind: "file" | "directory";
  size: number | null;
};

export type WebDirectoryListing = {
  path: string; // 已归一的绝对路径
  root_id: string;
  entries: WebFileEntry[];
  parent_path: string | null;
};

export type WebStagedMaterial = {
  material_id: string; // 暂存材料身份，只在本服务注册表内有效
  name: string;
  path: string; // 暂存区内的绝对路径，可直接交给既有导入流程
  size: number;
};

interface StagedMaterialRecord {
  material_id: string;
  name: string;
  path: string;
  size: number;
  created_at: number;
}

/**
 * 上传名的解析结果：浏览器上传文件夹时按 `webkitRelativePath` 携带相对目录，
 * 目录段与末段分别清洗，显示名保留完整相对路径供导入目标名使用。
 */
type UploadTargetName = {
  relative_directory: string; // 暂存区内的 POSIX 相对目录，空串表示暂存区根
  file_name: string; // 清洗后的末段名称
  display_name: string; // 材料显示名，即完整相对路径
};

export interface WebFileServiceOptions {
  paths: AppPathService;
  nativeFs?: NativeFs;
  now?: () => number;
  extraRoots?: readonly WebFileRoot[];
}

/**
 * Web 文件能力：目录浏览限定在允许根内，上传材料由本服务独占生命周期。
 * 浏览器没有系统对话框，这里同时承担选择器后端与暂存区两个责任。
 */
export class WebFileService {
  private readonly paths: AppPathService;
  private readonly native_fs: NativeFs;
  private readonly now: () => number;
  private readonly roots: WebFileRoot[];
  private readonly materials = new Map<string, StagedMaterialRecord>();
  private readonly pending_uploads = new Set<Promise<unknown>>();
  /** 暂存落盘命名队列：检查与重命名在同一链上执行，并发上传不会互相覆盖。 */
  private destination_chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  public constructor(options: WebFileServiceOptions) {
    this.paths = options.paths;
    this.native_fs = options.nativeFs ?? default_native_fs;
    this.now = options.now ?? (() => Date.now());
    this.roots = build_web_file_roots(this.paths, options.extraRoots ?? []);
    this.release_expired_materials();
  }

  /** 允许根只报告实际存在的目录，避免前端出现无法进入的入口。 */
  public list_roots(): WebFileRoot[] {
    return this.roots
      .filter((root) => this.is_existing_directory(root.path))
      .map((root) => ({ id: root.id, label: root.label, path: root.path }));
  }

  /**
   * 列举允许根内的目录；相对路径、符号链接和越界尝试都在这里收敛。
   */
  public list_directory(root_id: string, relative_path: string): WebDirectoryListing {
    const root = this.require_root(root_id);
    const directory_path = this.resolve_directory_path(root, relative_path);
    let dirents: ReturnType<NativeFs["read_dirents"]>;
    try {
      dirents = this.native_fs.read_dirents(directory_path);
    } catch (cause) {
      throw new AppError("file.not_found", {
        public_details: { reason: "directory_unreadable", path: relative_path },
        cause,
      });
    }
    const entries: WebFileEntry[] = [];
    for (const dirent of dirents) {
      if (entries.length >= DIRECTORY_ENTRY_LIMIT) break;
      if (dirent.name.startsWith(".")) continue; // 隐藏项不进浏览器选择器
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, kind: "directory", size: null });
        continue;
      }
      if (!dirent.isFile()) continue;
      let size: number | null = null;
      try {
        size = this.native_fs.stat(path.join(directory_path, dirent.name)).size;
      } catch {
        size = null;
      }
      entries.push({ name: dirent.name, kind: "file", size });
    }
    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return {
      path: directory_path,
      root_id: root.id,
      entries,
      parent_path: this.resolve_parent_path(root, directory_path),
    };
  }

  /** 流式接收上传材料；写入临时文件成功后才登记身份，取消与失败都清理半成品。 */
  public async stage_upload(
    name: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<WebStagedMaterial> {
    this.assert_active();
    this.release_expired_materials();
    if (this.materials.size >= UPLOAD_MAX_MATERIALS) {
      throw new AppError("runtime.busy", {
        public_details: { reason: "web_upload_material_limit" },
      });
    }
    if (this.count_staged_bytes() + 0 > UPLOAD_MAX_TOTAL_BYTES) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "web_upload_total_limit" },
      });
    }
    const material_id = randomUUID()
      .replaceAll("-", "")
      .slice(0, MATERIAL_ID_BYTES * 2);
    const directory = this.paths.get_web_import_root_dir();
    const temporary_path = path.join(directory, `.${material_id}.part`);
    const operation = this.write_upload(
      material_id,
      parse_upload_target_name(name),
      body,
      signal,
      directory,
      temporary_path,
    );
    this.pending_uploads.add(operation);
    void operation.finally(() => this.pending_uploads.delete(operation)).catch(() => undefined);
    return await operation;
  }

  /** 读取已暂存材料；身份只在本服务注册表内有效。 */
  public read_material(material_id: string): {
    name: string;
    size: number;
    stream: ReturnType<NativeFs["create_read_stream"]>;
  } {
    const record = this.require_material(material_id);
    return {
      name: record.name,
      size: record.size,
      stream: this.native_fs.create_read_stream(record.path),
    };
  }

  /** 读取已暂存材料的身份与落点，不打开文件句柄，供导入命令解析使用。 */
  public read_staged_material(material_id: string): WebStagedMaterial {
    const record = this.require_material(material_id);
    return {
      material_id: record.material_id,
      name: record.name,
      path: record.path,
      size: record.size,
    };
  }

  /** 释放单个材料并删除服务拥有的文件。 */
  public async release_material(material_id: string): Promise<void> {
    const record = this.materials.get(material_id);
    if (record === undefined) return;
    this.materials.delete(material_id);
    await this.remove_staged_file(record);
  }

  /**
   * 受控下载：只交付允许根、暂存区或工程副本内的文件，符号链接解析后仍须位于边界内。
   */
  public open_download(requested_path: string): {
    name: string;
    size: number;
    stream: ReturnType<NativeFs["create_read_stream"]>;
  } {
    const resolved = this.resolve_controlled_path(requested_path);
    let size: number;
    try {
      size = this.native_fs.stat(resolved).size;
    } catch (cause) {
      throw new AppError("file.not_found", { cause });
    }
    return {
      name: path.basename(resolved),
      size,
      stream: this.native_fs.create_read_stream(resolved),
    };
  }

  /** 逆序释放：先取消在途上传，再删除服务拥有的材料。 */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(this.pending_uploads);
    const failures: unknown[] = [];
    for (const record of this.materials.values()) {
      try {
        await this.remove_staged_file(record);
      } catch (error) {
        failures.push(error);
      }
    }
    this.materials.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Web file service failed to release staged materials.");
    }
  }

  /**
   * 暂存落盘命名：无竞争时保留清洗后的原始名，导入预览与目标名因此不带暂存身份；
   * 重名才追加材料身份后缀。检查与重命名串行在同一队列，并发上传不会读到过期存在性。
   * 队列按目录维度工作：批次目录内同名文件才会互相追加后缀，不同批次目录互不影响。
   */
  private claim_destination(
    directory: string,
    temporary_path: string,
    target: UploadTargetName,
    material_id: string,
  ): Promise<string> {
    const task = this.destination_chain.then(() => {
      const destination_directory =
        target.relative_directory === ""
          ? directory
          : path.join(directory, target.relative_directory);
      const clean_path = path.join(destination_directory, target.file_name);
      const destination_path = this.native_fs.exists(clean_path)
        ? path.join(destination_directory, upload_file_name(target.file_name, material_id))
        : clean_path;
      this.native_fs.rename(temporary_path, destination_path);
      return destination_path;
    });
    this.destination_chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async write_upload(
    material_id: string,
    target: UploadTargetName,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    directory: string,
    temporary_path: string,
  ): Promise<WebStagedMaterial> {
    const reader = body.getReader();
    const cancel_reader = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel_reader, { once: true });
    let published = false;
    let destination_path: string | null = null;
    let size = 0;
    try {
      signal.throwIfAborted();
      await this.native_fs.make_dir_async(directory);
      // 批次目录在上传前创建，落盘重命名才能直接进入目标位置。
      if (target.relative_directory !== "") {
        await this.native_fs.make_dir_async(path.join(directory, target.relative_directory));
      }
      await using handle = await this.native_fs.open_file(temporary_path, "wx");
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > UPLOAD_MAX_BYTES) {
          throw new AppError("file.preview_too_large", {
            public_details: { reason: "web_upload_too_large", limit_bytes: UPLOAD_MAX_BYTES },
          });
        }
        await handle.writeFile(chunk.value);
      }
      signal.throwIfAborted();
      destination_path = await this.claim_destination(
        directory,
        temporary_path,
        target,
        material_id,
      );
      const record: StagedMaterialRecord = {
        material_id,
        name: target.display_name,
        path: destination_path,
        size,
        created_at: this.now(),
      };
      this.materials.set(material_id, record);
      published = true;
      return { material_id, name: target.display_name, path: destination_path, size };
    } catch (cause) {
      signal.throwIfAborted();
      if (cause instanceof AppError) throw cause;
      throw new AppError("file.io_failed", { cause });
    } finally {
      signal.removeEventListener("abort", cancel_reader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      if (!published) {
        await this.native_fs.remove_async(temporary_path, { force: true });
        // 只有已完成落盘重命名的失败才可能留下目标文件。
        if (destination_path !== null) {
          await this.native_fs.remove_async(destination_path, { force: true });
        }
      }
    }
  }

  /**
   * 删除服务拥有的暂存文件，并回收因此变空的批次目录。
   * 批次目录由文件夹上传创建，不回收会在暂存区留下永不清理的空目录。
   */
  private async remove_staged_file(record: StagedMaterialRecord): Promise<void> {
    await this.native_fs.remove_async(record.path, { force: true });
    const upload_root = path.resolve(this.paths.get_web_import_root_dir());
    let directory = path.dirname(record.path);
    while (directory !== upload_root && directory.startsWith(`${upload_root}${path.sep}`)) {
      try {
        this.native_fs.remove_empty_dir(directory);
      } catch {
        return; // 同批次文件仍在或目录正被并发写入，交给后续释放再回收。
      }
      directory = path.dirname(directory);
    }
  }

  /** 清理超过保留时长且无在途引用的材料，重启后也不会无限堆积。 */
  private release_expired_materials(): void {
    const current_time = this.now();
    for (const record of this.materials.values()) {
      if (current_time - record.created_at < MATERIAL_TTL_MS) continue;
      this.materials.delete(record.material_id);
      void this.remove_staged_file(record).catch(() => undefined);
    }
  }

  private count_staged_bytes(): number {
    let total = 0;
    for (const record of this.materials.values()) total += record.size;
    return total;
  }

  private require_material(material_id: string): StagedMaterialRecord {
    const record = this.materials.get(material_id);
    if (record === undefined) {
      throw new AppError("file.not_found", { public_details: { reason: "web_material_unknown" } });
    }
    return record;
  }

  private assert_active(): void {
    if (this.disposed) {
      throw new AppError("runtime.disposed", {
        diagnostic_context: { reason: "web_file_service" },
      });
    }
  }

  private require_root(root_id: string): WebFileRoot {
    const root = this.roots.find((candidate) => candidate.id === root_id);
    if (root === undefined) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "unknown_web_file_root", root_id },
      });
    }
    return root;
  }

  /** 归一相对路径并确认仍位于根内；空路径表示根本身。 */
  private resolve_directory_path(root: WebFileRoot, relative_path: string): string {
    const root_path = this.resolve_real_root(root);
    const candidate = path.resolve(root_path, `.${normalize_relative_path(relative_path)}`);
    if (!is_path_inside(root_path, candidate)) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "web_path_outside_root", root_id: root.id },
      });
    }
    if (!this.is_existing_directory(candidate)) {
      throw new AppError("file.not_found", { public_details: { reason: "web_directory_missing" } });
    }
    return candidate;
  }

  private resolve_parent_path(root: WebFileRoot, directory_path: string): string | null {
    const root_path = this.resolve_real_root(root);
    if (directory_path === root_path) return null;
    const parent = path.dirname(directory_path);
    return is_path_inside(root_path, parent) ? parent : null;
  }

  /** 根目录按真实路径参与比较，符号链接根不会把边界让出去。 */
  private resolve_real_root(root: WebFileRoot): string {
    try {
      return this.native_fs.real_path(root.path);
    } catch {
      return path.resolve(root.path);
    }
  }

  private is_existing_directory(candidate: string): boolean {
    try {
      return this.native_fs.stat(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  /** 下载与材料读取都经过同一处边界：允许根、暂存区或工程副本内，且解析符号链接后仍在界内。 */
  private resolve_controlled_path(requested_path: string): string {
    const trimmed = requested_path.trim();
    if (trimmed === "") {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "web_download_path_empty" },
      });
    }
    // 暂存区与工程副本都由后端写入、浏览器只按受控下载读取；目录未创建时边界自然不命中。
    const upload_root = this.paths.get_web_import_root_dir();
    const boundaries = [
      ...this.roots.map((root) => this.resolve_real_root(root)),
      path.resolve(upload_root),
      path.resolve(this.paths.get_project_copy_root_dir()),
    ];
    const resolved = path.resolve(trimmed);
    const real_path = this.resolve_real_path_or_null(resolved);
    const is_inside_boundary = boundaries.some(
      (boundary) =>
        is_path_inside(boundary, resolved) ||
        (real_path !== null && is_path_inside(boundary, real_path)),
    );
    if (!is_inside_boundary) {
      throw new AppError("request.forbidden_origin", {
        public_details: { reason: "web_download_outside_allowed_roots" },
      });
    }
    const controlled = real_path ?? resolved;
    try {
      if (!this.native_fs.stat(controlled).isFile()) {
        throw new AppError("file.not_found");
      }
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("file.not_found", { cause });
    }
    return controlled;
  }

  private resolve_real_path_or_null(candidate: string): string | null {
    try {
      return this.native_fs.real_path(candidate);
    } catch {
      return null;
    }
  }
}

/** 允许根来自本机私有目录与 Android 共享存储；不存在的目录不进入清单。 */
function build_web_file_roots(
  paths: AppPathService,
  extra_roots: readonly WebFileRoot[],
): WebFileRoot[] {
  const home_root: WebFileRoot = { id: "home", label: "Termux 主目录", path: os.homedir() };
  const shared_storage_roots: WebFileRoot[] = [
    { id: "shared", label: "共享存储", path: "/storage/emulated/0" },
    { id: "sdcard", label: "SD 卡", path: "/sdcard" },
  ];
  const data_root: WebFileRoot = { id: "data", label: "应用数据", path: paths.get_data_root() };
  return [home_root, ...shared_storage_roots, data_root, ...extra_roots];
}

/** 相对路径统一为 POSIX 语义，Windows 风格分隔符与盘符都不被接受为根内路径。 */
function normalize_relative_path(relative_path: string): string {
  const trimmed = relative_path.trim().replace(/\\/gu, "/");
  if (trimmed === "" || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * 上传名允许携带相对目录：批次目录上传时每个文件按 `批次目录/相对路径` 提交，
 * 落点保留目录结构，游戏目录因此能走既有目录导入流程。
 * 每段沿用单文件清洗规则；空段、`.`、`..` 与盘符段在清洗前拒绝，
 * 绝对路径的首段必然为空段，同样落入拒绝分支。
 * 无目录时显示名保持调用方原始输入，既有单文件行为完全不变。
 */
function parse_upload_target_name(name: string): UploadTargetName {
  const segments = name.split("/");
  const safe_segments = segments.map((segment) => {
    if (segment === "" || segment === "." || segment === ".." || /^[A-Za-z]:/u.test(segment)) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "web_upload_name_invalid", name },
      });
    }
    return sanitize_upload_name(segment);
  });
  const file_name = safe_segments.at(-1) ?? "file";
  const directory_segments = safe_segments.slice(0, -1);
  return {
    relative_directory: directory_segments.join("/"),
    file_name,
    display_name:
      directory_segments.length === 0 ? name : [...directory_segments, file_name].join("/"),
  };
}

/** 清洗上传名：保留可读字符与扩展名，剔除路径分隔与首尾点。 */
function sanitize_upload_name(name: string): string {
  const safe =
    name
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_.-]/gu, "_")
      .replace(/^[.-]+|[.]+$/gu, "") || "file";
  const suffix = path.extname(safe);
  const extension = Array.from(suffix)
    .slice(0, NAME_MAX_CHARACTERS - 1)
    .join("");
  const stem = Array.from(suffix === "" ? safe : safe.slice(0, -suffix.length))
    .slice(0, NAME_MAX_CHARACTERS - Array.from(extension).length)
    .join("");
  return `${stem}${extension}`;
}

/** 重名暂存文件追加材料身份后缀，避免同名上传互相覆盖。 */
function upload_file_name(name: string, material_id: string): string {
  const clean_name = sanitize_upload_name(name);
  const extension = path.extname(clean_name);
  return `${clean_name.slice(0, clean_name.length - extension.length)}_${material_id}${extension}`;
}
