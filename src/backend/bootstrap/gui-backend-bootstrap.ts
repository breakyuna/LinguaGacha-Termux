import { AgentPersonalityService } from "../agent/agent-personality-service";
import { AgentSkillsService } from "../agent/agent-skills-service";
import type { PDFHost } from "../../shared/pdf";
import type { AgentImageHost } from "../../shared/agent-image";
import { AgentImageService } from "../agent/agent-image-service";
import { AgentService } from "../agent/agent-service";
import { WebSearchService } from "../agent/web-search-service";
import { AgentWorkspaceService } from "../agent/workspace/service";
import { AgentWorkspaceRunner } from "../agent/workspace/runtime/runner";
import { ApiGatewayServer, type WebGatewayOptions } from "../api/api-gateway-server";
import { WebFileService } from "../file/web-file-service";
import { ApiStreamHub } from "../api/api-stream-hub";
import {
  create_web_agent_save_path_host,
  type WebAgentSavePathHost,
} from "../api/web-agent-save-path-host";
import { t_main_log } from "../log/log-text";
import type { SystemProxyResolver } from "../network/system-proxy-http-client";
import type { BackendWorkerExecution } from "../worker/worker-execution";
import { AppError } from "../../shared/error";
import type { LogTargets } from "../../shared/log";
import { write_bootstrap_error } from "./bootstrap-log";
import { BackendResources } from "./backend-resources";
import { BackendServices } from "./backend-services";

type GuiBackendBootstrapState = "idle" | "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface GuiBackendBootstrapOptions {
  pdfHost?: PDFHost;
  imageHost?: AgentImageHost; // 未注入时图片能力按缺失回答，模型可见说明不声明对应接口
  appRoot: string; // 安装根与便携数据位置
  builtinRoot: string; // 当前版本只读内置资产根
  logTargets?: Partial<LogTargets>; // GUI Backend 日志出口
  systemProxyResolver: SystemProxyResolver; // Electron main 提供的代理解析端口
  workspaceRuntimeDirectory: string; // 与 runner 同版本的标准 npm 环境
  openDirectory: (path: string) => Promise<void>; // Electron main 副作用端口
  pickSavePath?: (defaultName: string) => Promise<string | null>; // 原生保存选择，取消返回 null；Web 入口省略，由组合根创建浏览器桥接宿主
  workerExecution: BackendWorkerExecution; // 正式 worker_threads 与测试执行策略
  dataRoot?: string; // Web 入口显式注入可写数据根，避免安装更新覆盖用户数据
  webGateway?: WebGatewayOptions; // 仅 Web 入口提供同源静态资源与访问会话配置
}

export interface GuiBackendBootstrapStartResult {
  apiBaseUrl: string;
  apiPort: number; // 公开监听端口，Web 入口用于展示访问地址
  backendServices: BackendServices;
  readAppLanguage: () => unknown;
}

/** GUI Backend 的完整组合根。Agent、SSE 与 Gateway 在该入口恒定存在。 */
export class GuiBackendBootstrap {
  private state: GuiBackendBootstrapState = "idle";
  private resources: BackendResources | null = null;
  private services: BackendServices | null = null;
  private event_stream: ApiStreamHub | null = null;
  private agent: AgentService | null = null;
  private images: AgentImageService | null = null; // 关闭 Gateway 前取消模型图片准备，排空正在受理的发送请求
  private web_search: WebSearchService | null = null;
  private gateway: ApiGatewayServer | null = null;
  private web_files: WebFileService | null = null;
  private agent_save_path_host: WebAgentSavePathHost | null = null; // 仅 Web 入口创建，桌面路径不暴露目录浏览与暂存能力
  private start_promise: Promise<GuiBackendBootstrapStartResult> | null = null; // stop 等待在途启动后再释放资源
  private stop_promise: Promise<void> | null = null; // 并发 stop 共用一次清理，清理期间拒绝 start

  /** 保存入口注入的宿主端口，资源只在 start 中创建。 */
  public constructor(private readonly options: GuiBackendBootstrapOptions) {}

  /** idle、stopped 与已清理的 failed 都没有活动 GUI Backend 资源。 */
  public isStopped(): boolean {
    return this.state === "idle" || this.state === "stopped" || this.state === "failed";
  }

  /** 串行启动完整 GUI Backend，并处理启动期间到达的 stop。 */
  public async start(): Promise<GuiBackendBootstrapStartResult> {
    const stop_in_progress = this.stop_promise !== null;
    if ((this.state !== "idle" && this.state !== "stopped") || stop_in_progress) {
      throw new AppError("runtime.internal_invariant", {
        diagnostic_context: {
          reason: "gui_backend_bootstrap_start_invalid_state",
          state: this.state,
          stop_in_progress,
        },
      });
    }
    const starting = this.start_runtime();
    this.start_promise = starting;
    try {
      const result = await starting;
      const stopping = this.stop_promise;
      if (stopping !== null) {
        await stopping;
        throw new AppError("runtime.disposed", {
          diagnostic_context: { reason: "gui_backend_bootstrap_stopped_during_start" },
        });
      }
      return result;
    } finally {
      if (this.start_promise === starting) this.start_promise = null;
    }
  }

  /** 按共享资源、业务服务、Agent、Gateway 的顺序完成装配。 */
  private async start_runtime(): Promise<GuiBackendBootstrapStartResult> {
    this.state = "starting";
    try {
      const resources = await BackendResources.start(this.options);
      this.resources = resources;
      const event_stream = new ApiStreamHub();
      this.event_stream = event_stream;
      const services = new BackendServices({
        paths: resources.paths,
        metadata: resources.metadata,
        appSettingService: resources.settings,
        database: resources.database,
        logManager: resources.logManager,
        publishEvent: (topic, payload) => event_stream.publish(topic, payload),
        openOutputFolder: this.options.openDirectory,
        pdfHost: this.options.pdfHost,
        workspaceRuntimeDirectory: this.options.workspaceRuntimeDirectory,
        workerExecution: this.options.workerExecution,
      });
      this.services = services;
      // 装配后核对一次崩溃恢复线索；此刻通常还没有加载工程，实际中断提示由工程加载时的会话切换发布。
      await services.batchTranslation.restore_interrupted_run();
      const web_search = new WebSearchService(
        resources.metadata.read_version_or_default(),
        resources.logManager,
      );
      this.web_search = web_search;
      const images = new AgentImageService(this.options.imageHost);
      this.images = images;
      // runner 与 catalog 共用同一 AppPathService，避免重复维护可写数据根的选择。
      // Web 传输的保存位置请求经浏览器选择器应答；桌面入口继续用原生对话框，两者不并存。
      if (
        this.options.webGateway !== undefined &&
        this.options.pickSavePath === undefined &&
        this.agent_save_path_host === null
      ) {
        this.agent_save_path_host = create_web_agent_save_path_host({
          publish: (topic, payload) => event_stream.publish(topic, payload),
        });
      }
      const save_path_host =
        this.agent_save_path_host?.request_save_path ?? this.options.pickSavePath;
      const runner = new AgentWorkspaceRunner({
        paths: resources.paths,
        runtimeDirectory: this.options.workspaceRuntimeDirectory,
        systemProxyResolver: this.options.systemProxyResolver,
      });
      const workspace = new AgentWorkspaceService({
        images,
        paths: resources.paths,
        settings: resources.settings,
        sessionState: services.state.session,
        cache: services.state.cache,
        proofreading: services.proofreading.query,
        database: resources.database,
        runtimeGate: services.state.runtimeGate,
        writeStore: services.state.writes,
        logManager: resources.logManager,
        run: runner.run.bind(runner),
        pdfHost: this.options.pdfHost,
        runtimeDirectory: this.options.workspaceRuntimeDirectory,
        openDirectory: this.options.openDirectory,
        ...(save_path_host === undefined ? {} : { pickSavePath: save_path_host }), // 未注入任何宿主时工作区保存按能力缺失回答
      });
      // 管理 API 和 Agent 共用技能队列，让当前对话接收设置变更。
      const skills = new AgentSkillsService(
        resources.paths,
        resources.settings,
        resources.logManager,
        services.state.runtimeGate,
      );
      const agent = new AgentService({
        database: resources.database,
        auth: services.modelAuth,
        skills,
        catalog: services.modelCatalog,
        images,
        batchTranslation: services.batchTranslation,
        paths: resources.paths,
        settings: resources.settings,
        userAgent: resources.metadata.build_linguagacha_user_agent(),
        sessionState: services.state.session,
        runtimeGate: services.state.runtimeGate,
        webSearch: web_search.search,
        workspace,
        logManager: resources.logManager,
        publish: (topic, payload) => event_stream.publish(topic, payload),
      });
      this.agent = agent;
      await agent.load_resources();
      resources.settings.set_stream_publisher(event_stream);
      // Web 文件能力与同源传输同生共死：没有 Web 传输就不创建目录浏览与上传暂存。
      if (this.options.webGateway !== undefined && this.web_files === null) {
        this.web_files = new WebFileService({ paths: resources.paths });
      }
      const gateway = new ApiGatewayServer({
        backendServices: services,
        agentService: agent,
        skillsService: skills,
        personalityService: new AgentPersonalityService(
          resources.paths,
          resources.settings,
          services.state.runtimeGate,
        ),
        eventStream: event_stream,
        webFiles: this.web_files,
        agentSavePathHost: this.agent_save_path_host,
        ...(this.options.webGateway === undefined ? {} : { web: this.options.webGateway }),
      });
      this.gateway = gateway;
      const gateway_result = await gateway.start();
      this.state = "ready";
      services.start_model_catalog_check();
      return {
        apiBaseUrl: gateway_result.baseUrl,
        apiPort: gateway_result.port,
        backendServices: services,
        readAppLanguage: () => resources.settings.read_app_language(),
      };
    } catch (error) {
      this.state = "failed";
      const failures: unknown[] = [error];
      const log_manager = this.resources?.logManager;
      if (log_manager !== undefined) {
        try {
          write_bootstrap_error(
            t_main_log("app.diagnostic.lifecycle.backend_gateway_start_failed"),
            { error },
            log_manager,
          );
        } catch (log_error) {
          failures.push(log_error);
        }
      }
      await this.dispose_runtime(failures);
      if (failures.length > 1) {
        throw new AggregateError(failures, "GUI Backend startup and cleanup failed.");
      }
      throw error;
    }
  }

  /** 幂等等待在途启动并逆序释放当前已创建的资源。 */
  public async stop(): Promise<void> {
    if (this.stop_promise !== null) {
      await this.stop_promise;
      return;
    }
    const starting = this.start_promise;
    const stopping = (async () => {
      if (starting !== null) await starting.catch(() => undefined);
      const failures: unknown[] = [];
      await this.dispose_runtime(failures);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to close GUI Backend resources.");
      }
    })();
    this.stop_promise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stop_promise === stopping) this.stop_promise = null;
    }
  }

  /** 单项清理失败不跳过后续资源，最终由调用方统一汇总。 */
  private async dispose_runtime(failures: unknown[]): Promise<void> {
    if (this.state === "stopped" && this.resources === null) return;
    this.state = "stopping";
    this.agent?.cancel_uploads();
    this.images?.clear();
    this.images = null;
    const gateway = this.gateway;
    this.gateway = null;
    // 驻留的保存位置请求随服务停止全部按取消收尾，避免等待方悬挂。
    this.agent_save_path_host?.dispose();
    this.agent_save_path_host = null;
    // 上传暂存先于 Gateway 之外的文件读取释放，避免停止后仍有材料被打开。
    const web_files = this.web_files;
    this.web_files = null;
    await collect_failure(failures, async () => await web_files?.dispose());
    // Gateway 停止受理时同步取消在途接口测试与工程写入，排空须等到目录恢复结束。
    await Promise.all([
      collect_failure(failures, async () => await gateway?.stop()),
      collect_failure(failures, async () => await this.services?.model.dispose()),
      collect_failure(failures, async () => await this.services?.stop_project_writes()),
    ]);

    this.resources?.settings.set_stream_publisher(null);
    const agent = this.agent;
    this.agent = null;
    await collect_failure(failures, async () => await agent?.dispose());

    const web_search = this.web_search;
    this.web_search = null;
    await collect_failure(failures, async () => await web_search?.dispose());

    this.event_stream?.stop();
    this.event_stream = null;

    const services = this.services;
    this.services = null;
    await collect_failure(failures, async () => await services?.dispose());

    const resources = this.resources;
    this.resources = null;
    await collect_failure(failures, async () => await resources?.dispose());
    this.state = "stopped";
  }
}

/** 将一次清理失败追加到共享生命周期结果。 */
async function collect_failure(
  failures: unknown[],
  operation: () => void | Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}
