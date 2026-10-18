import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";

import { default_native_fs, type NativeFs } from "../../native/native-fs";
import { AppError, is_app_error } from "../../shared/error";
import type { WebFileService, WebStagedMaterial } from "./web-file-service";

/** 导入命令形状与工作台 files 入参一致，路由层不再各自拼装路径。 */
export type WebMaterialImportCommand = {
  source_path: string;
  target_rel_path: string;
};

/** 导入材料声明；目标相对路径缺省时由暂存材料显示名推导。 */
export type WebMaterialImportRequest = {
  material_id: string;
  target_rel_path?: string;
};

/**
 * 暂存材料是请求作用域的运行态事实：身份过期或不存在时按请求参数拒绝，
 * 与磁盘文件缺失的 file.not_found 区分，调用方不必解析错误文本。
 */
function require_staged_material(
  web_files: WebFileService,
  material_id: string,
): WebStagedMaterial {
  try {
    return web_files.read_staged_material(material_id);
  } catch (cause) {
    if (is_app_error(cause) && cause.code === "file.not_found") {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "web_material_unknown", material_id },
        cause,
      });
    }
    throw cause;
  }
}

/** Web 文件能力缺失时拒绝材料请求，与 require_web_files 的能力缺失语义保持一致。 */
function require_web_file_service(web_files: WebFileService | null): WebFileService {
  if (web_files === null) {
    throw new AppError("runtime.capability_missing", {
      public_details: { reason: "web_file_service_unavailable" },
    });
  }
  return web_files;
}

/**
 * 解析暂存材料为暂存区绝对路径；桌面入口不传材料 ID 时返回空列表，行为与现状一致。
 */
export function resolve_material_paths(
  web_files: WebFileService | null,
  material_ids: readonly string[],
): string[] {
  if (material_ids.length === 0) return [];
  const files = require_web_file_service(web_files);
  return material_ids.map((material_id) => require_staged_material(files, material_id).path);
}

/** 单个材料的暂存路径解析，导入与导出流程共用同一身份校验。 */
export function resolve_material_path(
  web_files: WebFileService | null,
  material_id: string,
): string {
  return require_staged_material(require_web_file_service(web_files), material_id).path;
}

/**
 * 把暂存材料解析为导入命令：源取暂存绝对路径，目标相对路径缺省时用上传显示名，
 * 避免暂存身份后缀进入工程资产名。
 */
export function resolve_material_import_commands(
  web_files: WebFileService | null,
  materials: readonly WebMaterialImportRequest[],
): WebMaterialImportCommand[] {
  if (materials.length === 0) return [];
  const files = require_web_file_service(web_files);
  return materials.map((material) => {
    const staged = require_staged_material(files, material.material_id);
    const target_rel_path = material.target_rel_path?.trim() ?? "";
    return {
      source_path: staged.path,
      target_rel_path: target_rel_path === "" ? staged.name : target_rel_path,
    };
  });
}

/**
 * 把后端已写出的文件复制进暂存区并登记为材料，供受控下载交付；
 * 暂存上限与命名规则沿用上传入口，读取失败由暂存流程统一包装。
 */
export async function stage_existing_file(
  web_files: WebFileService,
  source_path: string,
  display_name: string,
  native_fs: NativeFs = default_native_fs,
): Promise<WebStagedMaterial> {
  if (!native_fs.exists(source_path)) {
    throw new AppError("file.not_found", {
      public_details: { reason: "web_stage_source_missing" },
    });
  }
  const stream = native_fs.create_read_stream(source_path);
  try {
    return await web_files.stage_upload(
      display_name,
      Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      new AbortController().signal,
    );
  } finally {
    // 暂存入口可能在读取前就因限额拒绝，此时必须主动释放源文件句柄。
    stream.destroy();
  }
}

/** 释放多个材料；身份不存在时视为已释放，与单材料释放语义一致。 */
export async function release_materials(
  web_files: WebFileService,
  material_ids: readonly string[],
): Promise<void> {
  for (const material_id of material_ids) {
    await web_files.release_material(material_id);
  }
}

/** 暂存区内的一次性导出目录；点前缀使浏览器目录列举不展示。 */
export function create_export_directory(staging_root: string): string {
  return path.join(staging_root, `.export-${randomUUID()}`);
}

/** 递归清理一次性导出目录；目录尚未创建时视为已完成清理。 */
export async function remove_export_directory(
  export_directory: string,
  native_fs: NativeFs = default_native_fs,
): Promise<void> {
  await native_fs.remove_async(export_directory, { recursive: true, force: true });
}
