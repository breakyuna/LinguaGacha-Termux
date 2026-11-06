import os from "node:os";
import path from "node:path";

import { AppError } from "../shared/error";
import { create_node_system_proxy_resolver } from "../backend/network/node-system-proxy-resolver";
import {
  build_worker_threads_backend_worker_execution_from_desktop_bundle_dir,
  resolve_desktop_bundle_dir_from_module_url,
  WEB_WORKER_ENTRY_EXTENSION,
} from "../backend/worker/worker-execution";
import { GuiBackendBootstrap } from "../backend/bootstrap/gui-backend-bootstrap";
import { create_web_access_session } from "../backend/api/web-access-session";
import {
  acquire_web_instance_marker,
  release_web_instance_marker,
} from "../backend/api/web-instance-marker";
import type { WebInstanceMarker } from "../shared/backend-api";
import { ChromiumBrowser, resolve_chromium_executable_path } from "../native/chromium-browser";
import { create_chromium_image_host } from "../native/chromium-image-host";
import { create_chromium_pdf_host } from "../native/chromium-pdf-host";

const HOME_DATA_ROOT_NAME = "LinguaGacha"; // 与便携数据位置一致，Termux 私有目录下的默认数据根
const DEFAULT_BUILTIN_DIRECTORY_NAME = "builtin";
const DEFAULT_STATIC_DIRECTORY_NAME = "dist";
const DEFAULT_WORKSPACE_RESOURCES_PATH = path.join("resources", "workspace");
const PDF_PRINT_STYLES_PATH = path.join("resources", "pdf-print.css"); // 构建生成的内嵌数学样式
const PDF_PRINT_FONTS_DIRECTORY = path.join("dist", "fonts"); // 渲染产物内的共享字体目录
const DEFAULT_PORT = 0; // 0 表示随机端口，启动结果提供真实访问地址

/** 同数据根第二个实例的提示文案前缀，与启动信息块共用同一输出通道。 */
const ANOTHER_INSTANCE_WARNING_PREFIX = "  [警告]";
const ANOTHER_INSTANCE_WARNING_INDENT = "         ";

export interface WebEntryOptions {
  argv: readonly string[];
  moduleUrl: string;
  env?: NodeJS.ProcessEnv;
  writeLine?: (line: string) => void;
}

interface WebEntryArguments {
  port: number;
  host: string;
  dataRoot: string;
  appRoot: string;
  builtinRoot: string;
  staticRoot: string;
  workspaceRuntimeDirectory: string;
  allowedHosts: string[];
}

export interface WebEntryRunResult {
  baseUrl: string;
  port: number;
  credential: string;
  stop: () => Promise<void>;
}

/**
 * 解析 Web 启动参数；未知参数与缺失值都立即失败，避免带着半配置启动服务。
 */
export function parse_web_entry_arguments(
  argv: readonly string[],
  defaults: { appRoot: string; dataRoot: string },
): WebEntryArguments {
  const flag_values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "unexpected_argument", argument },
      });
    }
    const separator_index = argument.indexOf("=");
    const name = separator_index === -1 ? argument.slice(2) : argument.slice(2, separator_index);
    if (separator_index === -1) {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "missing_argument_value", argument: name },
      });
    }
    const value = argument.slice(separator_index + 1);
    if (value === "") {
      throw new AppError("request.validation_failed", {
        public_details: { reason: "empty_argument_value", argument: name },
      });
    }
    const existing_values = flag_values.get(name);
    if (existing_values === undefined) flag_values.set(name, [value]);
    else existing_values.push(value);
  }

  const read_text = (name: string): string | null => flag_values.get(name)?.[0] ?? null;
  const read_path = (name: string, fallback: string): string => {
    const value = read_text(name);
    return value === null ? fallback : path.resolve(value);
  };

  const port_text = read_text("port");
  if (port_text !== null && !/^\d+$/u.test(port_text)) {
    throw new AppError("request.validation_failed", {
      public_details: { reason: "invalid_port", port: port_text },
    });
  }

  return {
    port: port_text === null ? DEFAULT_PORT : Number(port_text),
    host: read_text("host") ?? "127.0.0.1",
    dataRoot: read_path("data-root", defaults.dataRoot),
    appRoot: read_path("app-root", defaults.appRoot),
    builtinRoot: read_path(
      "builtin-root",
      path.join(defaults.appRoot, DEFAULT_BUILTIN_DIRECTORY_NAME),
    ),
    staticRoot: read_path(
      "static-root",
      path.join(defaults.appRoot, DEFAULT_STATIC_DIRECTORY_NAME),
    ),
    workspaceRuntimeDirectory: read_path(
      "workspace-runtime",
      path.join(defaults.appRoot, DEFAULT_WORKSPACE_RESOURCES_PATH),
    ),
    allowedHosts: [...(flag_values.get("allowed-host") ?? [])],
  };
}

/** 目录打开与保存选择依赖原生对话框；Web 运行期由文件流程接管前明确报告能力缺失。 */
function create_unavailable_directory_host(): (target: string) => Promise<void> {
  return async (target: string) => {
    throw new AppError("runtime.capability_missing", {
      public_details: { reason: "directory_host_unavailable" },
      diagnostic_context: { target },
    });
  };
}

/**
 * 启动 Termux 原生 Node Web 服务：组装完整后端、同源静态资源与访问会话，并接管停止信号。
 */
export async function run_web_entry(options: WebEntryOptions): Promise<WebEntryRunResult> {
  const env = options.env ?? process.env;
  const write_line = options.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  const bundle_dir = resolve_desktop_bundle_dir_from_module_url(options.moduleUrl);
  const default_data_root =
    env["LINGUAGACHA_DATA_ROOT"] ?? path.join(os.homedir(), HOME_DATA_ROOT_NAME);
  const entry_arguments = parse_web_entry_arguments(options.argv, {
    appRoot: bundle_dir,
    dataRoot: default_data_root,
  });
  const access_session = create_web_access_session();
  // 图片与 PDF 宿主共用同一浏览器进程：按需启动、页面按请求创建，基本文本启动不产生浏览器进程。
  // 未找到可执行文件时不注入宿主，能力信息与模型可见说明按缺失报告，不让界面出现必然失败的入口。
  const chromium_executable = resolve_chromium_executable_path(
    env["LINGUAGACHA_CHROMIUM_PATH"] ?? null,
  );
  const chromium_browser =
    chromium_executable === null
      ? null
      : new ChromiumBrowser({ executablePath: chromium_executable, env });
  const image_host =
    chromium_browser === null ? undefined : create_chromium_image_host(chromium_browser);
  const pdf_host =
    chromium_browser === null
      ? undefined
      : create_chromium_pdf_host(
          {
            stylesPath: path.join(entry_arguments.appRoot, PDF_PRINT_STYLES_PATH),
            fontsDirectory: path.join(entry_arguments.appRoot, PDF_PRINT_FONTS_DIRECTORY),
          },
          chromium_browser,
        );
  let another_instance: WebInstanceMarker | null = null; // 监听就绪后由实例标记占位结果填写
  const bootstrap = new GuiBackendBootstrap({
    appRoot: entry_arguments.appRoot,
    builtinRoot: entry_arguments.builtinRoot,
    dataRoot: entry_arguments.dataRoot,
    logTargets: { console: true, window: true },
    systemProxyResolver: create_node_system_proxy_resolver({ env }),
    workspaceRuntimeDirectory: entry_arguments.workspaceRuntimeDirectory,
    openDirectory: create_unavailable_directory_host(),
    // pickSavePath 省略：Web 传输由组合根创建浏览器桥接宿主（驻留请求 + pending 领取）。
    ...(image_host === undefined ? {} : { imageHost: image_host }),
    ...(pdf_host === undefined ? {} : { pdfHost: pdf_host }),
    workerExecution:
      // Web 构建产物入口为 .mjs，与桌面 .js 命名不同，入口层显式选择。
      build_worker_threads_backend_worker_execution_from_desktop_bundle_dir(
        bundle_dir,
        WEB_WORKER_ENTRY_EXTENSION,
      ),
    webGateway: {
      hostname: entry_arguments.host,
      port: entry_arguments.port,
      staticRoot: entry_arguments.staticRoot,
      accessSession: access_session,
      ...(image_host === undefined ? {} : { imageHost: image_host }),
      ...(pdf_host === undefined ? {} : { pdfHost: pdf_host }),
      ...(entry_arguments.allowedHosts.length === 0
        ? {}
        : { allowedHosts: entry_arguments.allowedHosts }),
      // 启动配置按读取函数取实例事实，端口与第二实例判定在监听就绪后才确定。
      readAnotherInstance: () => another_instance,
    },
  });

  let is_stopping = false;
  let owns_instance_marker = false; // 只有本实例成功占位的标记才在停止时删除
  const stop = async (): Promise<void> => {
    if (is_stopping) return;
    is_stopping = true;
    try {
      await bootstrap.stop();
    } finally {
      // 优雅停止时尽力删除实例标记，删除失败不影响后端与宿主的收尾。
      if (owns_instance_marker) {
        await release_web_instance_marker({
          dataRoot: entry_arguments.dataRoot,
          pid: process.pid,
        });
      }
      // 宿主浏览器独立于后端生命周期：后端停止后结束进程，避免遗留任务拥有的浏览器。
      await chromium_browser?.dispose();
    }
  };

  const start_result = await bootstrap.start();
  // 实例标记在监听就绪后创建，端口用真实监听端口；标记只承载提示事实，不构成互斥锁。
  const instance_marker = await acquire_web_instance_marker({
    dataRoot: entry_arguments.dataRoot,
    port: start_result.apiPort,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });
  owns_instance_marker = instance_marker.status === "acquired";
  const access_url = `${start_result.apiBaseUrl}/#credential=${access_session.credential}`;
  write_line("LinguaGacha Web 服务已就绪。");
  write_line(`  访问地址: ${access_url}`);
  write_line(`  数据根:   ${entry_arguments.dataRoot}`);
  if (instance_marker.status === "conflict") {
    const existing = instance_marker.existing;
    another_instance = existing;
    write_line(
      `${ANOTHER_INSTANCE_WARNING_PREFIX} 同一数据根已有另一个实例在运行：PID ${existing.pid}，端口 ${existing.port}，启动于 ${existing.started_at}`,
    );
    write_line(
      `${ANOTHER_INSTANCE_WARNING_INDENT}本次启动仍可继续；跨实例写入会按修订冲突（409 data.revision_conflict）拒绝，请避免同时操作同一数据。`,
    );
  } else if (instance_marker.status === "unavailable") {
    write_line(
      `${ANOTHER_INSTANCE_WARNING_PREFIX} 无法创建实例标记（${instance_marker.reason}），同数据根多实例提示不可用。`,
    );
  }
  write_line(
    chromium_executable === null
      ? "  图片/PDF 宿主: 未找到 Chromium 可执行文件，相关能力不可用（可用 LINGUAGACHA_CHROMIUM_PATH 指定）。"
      : `  图片/PDF 宿主: ${chromium_executable}`,
  );
  write_line("  停止服务: Ctrl+C 或发送 SIGTERM。");

  return {
    baseUrl: start_result.apiBaseUrl,
    port: start_result.apiPort,
    credential: access_session.credential,
    stop,
  };
}
