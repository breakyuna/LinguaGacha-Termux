import type {
  QualityRuleEntryByKind,
  QualityRuleKind,
  TextPreserveMode,
} from "../../domain/quality";
import type { SettingSnapshot } from "../../domain/setting";
import type { ProjectDataSectionRevisions } from "../project-event";
import type { QualityRuleSlice } from "./quality-rule-state";

export type QualityRuleQueryResponse<K extends QualityRuleKind = QualityRuleKind> = {
  projectPath: string;
  sectionRevisions: ProjectDataSectionRevisions;
  qualityRule: QualityRuleSlice<K>;
};
export type QualityRulePresetItem = {
  name: string;
  file_name: string;
  virtual_id: string;
  type: "builtin" | "user";
  path?: string;
};
export type QualityRulePresets = {
  builtin_presets: QualityRulePresetItem[];
  user_presets: QualityRulePresetItem[];
};
export type QualityRulePresetChange = QualityRulePresets & { settings: SettingSnapshot };

/** 每种规则仅允许自身的元信息字段。 */
export type QualityRuleMetaByKind = {
  glossary: { enabled?: boolean; mode?: never };
  pre_replacement: { enabled?: boolean; mode?: never };
  post_replacement: { enabled?: boolean; mode?: never };
  text_preserve: { mode?: TextPreserveMode; enabled?: never };
};
export type QualityRuleUpdateRequest<K extends QualityRuleKind = QualityRuleKind> = {
  [P in K]: {
    rule_type: P;
    expected_section_revisions: { quality: number };
    entries?: QualityRuleEntryByKind[P][];
    meta?: QualityRuleMetaByKind[P];
  };
}[K];
export type QualityRuleQueryRequest = { rule_type: QualityRuleKind };
export type QualityRuleFileRequest = QualityRuleQueryRequest & {
  path: string;
  material_id?: string; // Web 材料模式：暂存材料身份，存在时忽略 path
};
export type QualityRuleEntriesResponse<K extends QualityRuleKind = QualityRuleKind> = {
  entries: QualityRuleEntryByKind[K][];
};
export type QualityRuleExportResponse = {
  path: string;
  material?: { material_id: string; name: string; size: number }; // 材料模式才返回，供受控下载定位
};
export type QualityRulePresetRequest = QualityRuleQueryRequest & { virtual_id: string };
export type QualityRulePresetSaveResponse = { item: QualityRulePresetItem };
export type QualityRulePresetSaveRequest<K extends QualityRuleKind = QualityRuleKind> = {
  [P in K]: { rule_type: P; name: string; entries: QualityRuleEntryByKind[P][] };
}[K];
export type QualityRuleExportRequest<K extends QualityRuleKind = QualityRuleKind> = {
  [P in K]: {
    rule_type: P;
    path: string;
    entries: QualityRuleEntryByKind[P][];
    material?: boolean; // 为 true 时忽略 path，导出结果登记为暂存材料交付
    material_name?: string; // 材料交付的文件名，缺省用交换格式常量；只接受单个基名
  };
}[K];
export type QualityRulePresetRenameRequest = QualityRulePresetRequest & { new_name: string };
