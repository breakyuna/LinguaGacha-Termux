import { read_host_bridge } from "@frontend/app/host/host-bridge";
import { api_fetch } from "@frontend/app/desktop/desktop-api";
import { deliver_web_file_material } from "@frontend/features/web-file-picker/web-file-download";
import type {
  QualityRuleQueryResponse,
  QualityRulePresets,
  QualityRulePresetChange,
  QualityRuleUpdateRequest,
  QualityRuleEntriesResponse,
  QualityRuleExportResponse,
  QualityRulePresetSaveResponse,
  QualityRuleQueryRequest,
  QualityRuleFileRequest,
  QualityRulePresetRequest,
  QualityRulePresetRenameRequest,
  QualityRulePresetSaveRequest,
  QualityRuleExportRequest,
} from "@shared/quality/quality-rule-api";
import type { QualityRuleEntryByKind, QualityRuleKind } from "@domain/quality";
import type { ProjectWriteResult } from "@shared/project-event";
import type { SettingsUpdateResponse } from "@shared/settings";

/** 导入来源：桌面给出本地路径，Web 给出暂存材料身份。 */
export type QualityRuleImportSource = { path: string } | { material_id: string };

/** 按来源补齐导入入参；材料身份存在时 path 被后端忽略。 */
function build_quality_rule_import_request(
  rule_type: QualityRuleKind,
  source: QualityRuleImportSource,
): QualityRuleFileRequest {
  return "material_id" in source
    ? { rule_type, path: "", material_id: source.material_id }
    : { rule_type, path: source.path };
}

/**
 * 读取后端完整规则切片，供页面映射交互状态。
 */
export async function read_quality_rule_snapshot<TType extends QualityRuleKind>(
  rule_type: TType,
): Promise<QualityRuleQueryResponse<TType>> {
  return await api_fetch<QualityRuleQueryResponse<TType>>("/api/quality/rules/query", {
    rule_type,
  } satisfies QualityRuleQueryRequest);
}

/** 导入入口负责条目校验与身份分配，客户端直接消费完整结果。 */
export async function import_quality_rule_entries<TType extends QualityRuleKind>(
  rule_type: TType,
  source: QualityRuleImportSource,
): Promise<QualityRuleEntryByKind[TType][]> {
  const payload = await api_fetch<QualityRuleEntriesResponse<TType>>(
    "/api/quality/rules/import",
    build_quality_rule_import_request(rule_type, source),
  );
  return payload.entries;
}

/** 使用质量规则页共用的系统文件选择器读取导入来源。 */
export async function pick_quality_rule_import_source(): Promise<QualityRuleImportSource | null> {
  const result = await read_host_bridge().pickGlossaryImportFilePath();
  if (result.canceled) return null;
  const material_id = result.material_ids?.[0] ?? "";
  if (material_id !== "") return { material_id };
  const path = result.paths[0] ?? "";
  return path === "" ? null : { path };
}

/** 选择导出路径并提交当前页面规则；取消选择不视为导出成功。 */
export async function export_quality_rule_entries<TType extends QualityRuleKind>(args: {
  rule_type: TType;
  file_name: string;
  entries: QualityRuleEntryByKind[TType][];
}): Promise<boolean> {
  const result = await read_host_bridge().pickGlossaryExportPath(args.file_name);
  if (result.canceled) {
    return false;
  }

  // Web 没有可写入的本地路径，导出登记为暂存材料后经受控下载交付。
  if (result.web_download === true) {
    await export_quality_rule_entries_as_material(args);
    return true;
  }

  const path = result.paths[0] ?? null;
  if (path === null) {
    return false;
  }

  await api_fetch<QualityRuleExportResponse>("/api/quality/rules/export", {
    rule_type: args.rule_type,
    path,
    entries: args.entries,
  } satisfies QualityRuleExportRequest<TType>);
  return true;
}

/** 材料模式导出：交付文件名取页面导出名，下载完成后释放暂存材料。 */
async function export_quality_rule_entries_as_material<TType extends QualityRuleKind>(args: {
  rule_type: TType;
  file_name: string;
  entries: QualityRuleEntryByKind[TType][];
}): Promise<void> {
  const payload = await api_fetch<QualityRuleExportResponse>("/api/quality/rules/export", {
    rule_type: args.rule_type,
    // 材料模式忽略 path，入参由路由层改写到一次性导出目录。
    path: "",
    entries: args.entries,
    material: true,
    material_name: args.file_name,
  } satisfies QualityRuleExportRequest<TType>);
  const material_id = payload.material?.material_id ?? "";
  if (material_id === "") {
    throw new Error("Quality rule export did not register a staged material.");
  }

  await deliver_web_file_material(material_id);
}

/** 规则写入沿用工程提交回执；调用者必须通过工程写入口执行。 */
export function update_quality_rule<K extends QualityRuleKind>(
  request: QualityRuleUpdateRequest<K>,
): Promise<ProjectWriteResult> {
  return api_fetch("/api/quality/rules/update", request);
}
/** 读取预设目录快照，默认标记由设置快照提供。 */
export function read_quality_rule_presets(rule_type: QualityRuleKind): Promise<QualityRulePresets> {
  return api_fetch("/api/quality/rules/presets", { rule_type } satisfies QualityRuleQueryRequest);
}
/** 读取预设条目，应用和重复确认由编辑流程负责。 */
export async function read_quality_rule_preset<K extends QualityRuleKind>(
  rule_type: K,
  virtual_id: string,
): Promise<QualityRuleEntryByKind[K][]> {
  const response = await api_fetch<QualityRuleEntriesResponse<K>>(
    "/api/quality/rules/presets/read",
    { rule_type, virtual_id } satisfies QualityRulePresetRequest,
  );
  return response.entries;
}
/** 保存当前规则为用户预设。 */
export function save_quality_rule_preset<K extends QualityRuleKind>(
  rule_type: K,
  name: string,
  entries: QualityRuleEntryByKind[K][],
): Promise<QualityRulePresetSaveResponse> {
  return api_fetch("/api/quality/rules/presets/save", {
    rule_type,
    name,
    entries,
  } satisfies QualityRulePresetSaveRequest<K>);
}
/** 用一个后端命令更新名称和关联的默认引用。 */
export function rename_quality_rule_preset(
  rule_type: QualityRuleKind,
  virtual_id: string,
  new_name: string,
): Promise<QualityRulePresetChange> {
  return api_fetch("/api/quality/rules/presets/rename", {
    rule_type,
    virtual_id,
    new_name,
  } satisfies QualityRulePresetRenameRequest);
}
/** 等待文件与默认引用的删除命令完成。 */
export function delete_quality_rule_preset(
  rule_type: QualityRuleKind,
  virtual_id: string,
): Promise<QualityRulePresetChange> {
  return api_fetch("/api/quality/rules/presets/delete", {
    rule_type,
    virtual_id,
  } satisfies QualityRulePresetRequest);
}
/** 通过应用设置入口保存默认预设引用。 */
export function update_quality_rule_default_preset(
  key: string,
  value: string,
): Promise<SettingsUpdateResponse> {
  return api_fetch("/api/settings/update", { [key]: value });
}
