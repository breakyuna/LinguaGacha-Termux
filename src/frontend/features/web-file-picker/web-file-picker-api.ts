import { api_fetch, api_upload } from "@frontend/app/desktop/desktop-api";

/** 允许根；标签由入口展示，路径在服务内解析。 */
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

/** 上传暂存材料；暂存路径是服务端真实路径，可直接作为导入源。 */
export type WebStagedMaterial = {
  material_id: string;
  name: string;
  path: string;
  size: number;
};

/** 读取允许根清单，过滤缺失字段，避免脏数据进入选择器。 */
export async function list_web_file_roots(): Promise<WebFileRoot[]> {
  const payload = await api_fetch<{ roots?: unknown }>("/api/web/files/roots", {});
  if (!Array.isArray(payload.roots)) return [];
  return payload.roots.flatMap((root) => {
    if (typeof root !== "object" || root === null) return [];
    const record = root as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.label !== "string" ||
      typeof record.path !== "string"
    ) {
      return [];
    }
    return [{ id: record.id, label: record.label, path: record.path }];
  });
}

/** 收窄条目类型，未知取值直接丢弃而不是落入默认分支。 */
function read_web_file_kind(value: unknown): WebFileEntry["kind"] | null {
  return value === "file" || value === "directory" ? value : null;
}

/** 列举根内目录；响应形状按服务契约收窄，失败由 api_fetch 统一映射。 */
export async function list_web_file_directory(
  root_id: string,
  relative_path: string,
): Promise<WebDirectoryListing> {
  const payload = await api_fetch<Record<string, unknown>>("/api/web/files/list", {
    root_id,
    path: relative_path,
  });
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return {
    path: typeof payload.path === "string" ? payload.path : "",
    root_id: typeof payload.root_id === "string" ? payload.root_id : root_id,
    entries: entries.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const kind = read_web_file_kind(record.kind);
      if (typeof record.name !== "string" || kind === null) return [];
      const size = typeof record.size === "number" ? record.size : null;
      return [{ name: record.name, kind, size }];
    }),
    parent_path: typeof payload.parent_path === "string" ? payload.parent_path : null,
  };
}

/**
 * 上传文件字节进入后端暂存区，成功后返回材料身份与暂存路径。
 * name 可以携带相对目录（文件夹上传的批次目录结构），
 * `encodeURIComponent` 把分隔符编码为 `%2F`，服务端解码后按段清洗落盘。
 */
export async function upload_web_file(
  name: string,
  file: Blob,
  signal: AbortSignal,
): Promise<WebStagedMaterial> {
  const payload = await api_upload<Record<string, unknown>>(
    `/api/web/files/upload?name=${encodeURIComponent(name)}`,
    file,
    signal,
  );
  const material_id = typeof payload.material_id === "string" ? payload.material_id : "";
  const staged_path = typeof payload.path === "string" ? payload.path : "";
  const staged_name = typeof payload.name === "string" ? payload.name : name;
  const size = typeof payload.size === "number" ? payload.size : file.size;
  if (material_id === "" || staged_path === "") {
    throw new Error("Web upload response is missing the staged material identity.");
  }
  return { material_id, name: staged_name, path: staged_path, size };
}

/** 释放单个暂存材料；身份不存在时服务端视为已释放。 */
export async function release_web_file_material(material_id: string): Promise<void> {
  await api_fetch<Record<string, never>>("/api/web/files/material/release", { material_id });
}

/** 批量释放；单个失败不阻塞其余材料，调用方按导入结果决定是否反馈。 */
export async function release_web_file_materials(material_ids: readonly string[]): Promise<void> {
  for (const material_id of material_ids) {
    await release_web_file_material(material_id);
  }
}

/** 用响应给出的目录与名称拼接绝对路径，分隔符沿用服务端归一结果。 */
export function join_web_path(directory_path: string, entry_name: string): string {
  if (directory_path === "") return entry_name;
  const separator = directory_path.includes("\\") ? "\\" : "/";
  const normalized_directory = directory_path.replace(/[\\/]+$/u, "");
  return `${normalized_directory}${separator}${entry_name}`;
}
