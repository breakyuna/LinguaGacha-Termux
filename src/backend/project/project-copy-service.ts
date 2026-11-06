import path from "node:path";

import type { AppPathService } from "../app/app-path-service";
import type { ProjectDatabase } from "../database/database-operations";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import type { ProjectSessionState } from "./project-session-state";

const PROJECT_COPY_NAME_SUFFIX = "副本"; // 副本文件名标识，与工程库展示语义一致
const PROJECT_COPY_EXTENSION = ".lg"; // 源工程没有扩展名时按工程文件补齐
const COPY_SEQUENCE_START = 2; // 同秒撞名从 2 开始追加序号

/** 工程副本响应：路径供受控下载使用，名称与体积供界面展示。 */
export type ProjectCopyResult = {
  path: string;
  name: string;
  size: number;
};

/**
 * 工程副本在数据库一致性边界生成：当前 .lg 快照落入用户数据下的固定副本目录，
 * 交付由 Web 文件服务的受控下载统一收口，不暴露任意路径。
 */
export class ProjectCopyService {
  /**
   * 注入数据库一致性入口、会话权威与路径服务，副本只读取当前 loaded 工程。
   */
  public constructor(
    private readonly database: ProjectDatabase,
    private readonly session_state: ProjectSessionState,
    private readonly paths: AppPathService,
    private readonly native_fs: NativeFs = default_native_fs,
  ) {}

  /** 未加载工程时按现有会话错误码拒绝，不猜测工程路径。 */
  public async copy_project(): Promise<ProjectCopyResult> {
    const project_path = this.session_state.require_loaded_project_path();
    const copy_directory = this.paths.get_project_copy_root_dir();
    this.native_fs.make_dir(copy_directory);
    const copy_path = this.resolve_copy_path(copy_directory, project_path);
    await this.database.copy_snapshot_to(project_path, copy_path);
    return {
      path: copy_path,
      name: path.basename(copy_path),
      size: this.native_fs.stat(copy_path).size,
    };
  }

  /** 副本名带本地时间戳，撞名时追加递增序号，不覆盖已有副本。 */
  private resolve_copy_path(copy_directory: string, project_path: string): string {
    const parsed_path = path.parse(project_path);
    const extension = parsed_path.ext === "" ? PROJECT_COPY_EXTENSION : parsed_path.ext;
    const base_name = `${parsed_path.name}_${PROJECT_COPY_NAME_SUFFIX}_${this.build_timestamp_suffix()}`;
    const candidate_path = path.join(copy_directory, `${base_name}${extension}`);
    if (!this.native_fs.exists(candidate_path)) return candidate_path;
    let sequence = COPY_SEQUENCE_START;
    let sequence_path = path.join(
      copy_directory,
      `${base_name}_${sequence.toString()}${extension}`,
    );
    while (this.native_fs.exists(sequence_path)) {
      sequence += 1;
      sequence_path = path.join(copy_directory, `${base_name}_${sequence.toString()}${extension}`);
    }
    return sequence_path;
  }

  /** 时间戳与工程新建撞名后缀保持同一本地时间格式。 */
  private build_timestamp_suffix(): string {
    const now = new Date();
    const pad = (value: number): string => value.toString().padStart(2, "0");
    return `${now.getFullYear().toString()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
      now.getHours(),
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
}
