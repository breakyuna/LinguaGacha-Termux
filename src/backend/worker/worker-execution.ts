import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BUNDLED_CHUNK_DIRECTORY_NAME = "chunks"; // electron-vite 会把动态入口拆到 chunks，运行时契约需要回到 dist-electron 根目录
const WORK_UNIT_WORKER_ENTRY_BASE_NAME = "work-unit-worker-entry"; // work unit worker 入口产物名必须与构建入口保持一致
const PLANNING_WORKER_ENTRY_BASE_NAME = "planning-worker-entry"; // planning worker 入口产物名必须与构建入口保持一致
const RPGMAKER_MV_MZ_PREPARE_WORKER_ENTRY_BASE_NAME = "rpgmaker-mv-mz-prepare-worker-entry"; // 与构建入口一致。
const COMPUTE_WORKER_ENTRY_BASE_NAME = "compute-worker-entry"; // 非 engine Compute worker 入口产物名必须与构建入口保持一致
const BACKEND_RUNTIME_WORKER_ENTRY_BASE_NAME = "backend-runtime-worker-entry"; // GUI Backend Runtime 入口产物名必须与构建入口保持一致
export const DESKTOP_WORKER_ENTRY_EXTENSION = ".js"; // electron-vite 主构建产物扩展名
export const WEB_WORKER_ENTRY_EXTENSION = ".mjs"; // Web 构建产物扩展名；入口层按实际构建显式选择，运行时不猜测

// 由产品入口显式注入，避免运行时在底层自行猜测构建产物位置或执行模式。
export type BackendWorkerExecution =
  | {
      kind: "worker_threads"; // worker_threads 是 GUI / CLI 正式 worker 执行路径
      workUnitWorkerEntryUrl: URL; // 指向构建产物中的 work unit worker 入口文件
      planningWorkerEntryUrl: URL; // 指向构建产物中的 planning worker 入口文件
      rpgmakerMvMzPrepareWorkerEntryUrl: URL; // MV/MZ 准备线程只写暂存目录。
      computeWorkerEntryUrl: URL; // 指向非 engine 通用 worker 入口文件
    }
  | {
      // in_process 是测试和源码执行显式选择的同进程模式：不读取构建产物，不作为生产回退或兼容层。
      kind: "in_process";
    };

/**
 * 从当前 ESM 模块地址解析桌面 bundle 根目录；动态 chunk 内执行时必须回到父目录。
 */
export function resolve_desktop_bundle_dir_from_module_url(module_url: string): string {
  const module_dir = path.dirname(fileURLToPath(module_url));
  if (path.basename(module_dir) === BUNDLED_CHUNK_DIRECTORY_NAME) {
    return path.dirname(module_dir);
  }

  return module_dir;
}

/**
 * 构造正式 Backend worker 执行配置，调用方不再从底层池内部猜测构建产物位置。
 * 入口扩展名由调用方按构建产物命名显式传入：桌面传 .js，Web 传 .mjs。
 */
export function build_worker_threads_backend_worker_execution_from_desktop_bundle_dir(
  desktop_bundle_dir: string,
  entry_extension: string = DESKTOP_WORKER_ENTRY_EXTENSION,
): BackendWorkerExecution {
  const build_entry_url = (base_name: string): URL =>
    pathToFileURL(path.join(desktop_bundle_dir, `${base_name}${entry_extension}`));
  return {
    kind: "worker_threads",
    workUnitWorkerEntryUrl: build_entry_url(WORK_UNIT_WORKER_ENTRY_BASE_NAME),
    planningWorkerEntryUrl: build_entry_url(PLANNING_WORKER_ENTRY_BASE_NAME),
    rpgmakerMvMzPrepareWorkerEntryUrl: build_entry_url(
      RPGMAKER_MV_MZ_PREPARE_WORKER_ENTRY_BASE_NAME,
    ),
    computeWorkerEntryUrl: build_entry_url(COMPUTE_WORKER_ENTRY_BASE_NAME),
  };
}

/** 解析 GUI Backend Runtime 的独立线程入口；该入口不属于 BackendWorkerExecution。 */
export function build_backend_runtime_worker_entry_url_from_desktop_bundle_dir(
  desktop_bundle_dir: string,
  entry_extension: string = DESKTOP_WORKER_ENTRY_EXTENSION,
): URL {
  return pathToFileURL(
    path.join(desktop_bundle_dir, `${BACKEND_RUNTIME_WORKER_ENTRY_BASE_NAME}${entry_extension}`),
  );
}
