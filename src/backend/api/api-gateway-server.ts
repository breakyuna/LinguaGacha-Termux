import type { AgentPersonalityService } from "../agent/agent-personality-service";
import type { AgentSkillsApi } from "../agent/agent-skills-service";
import type { Server } from "node:http";

import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { t_main_log } from "../log/log-text";
import { record_app_error } from "../log/app-error-reporter";
import { renderer_error_report_to_log_payload } from "../log/renderer-error-log-adapter";
import type { LogPageRequest } from "../../shared/log";
import type { BackendServices } from "../bootstrap/backend-services";
import type { AgentService } from "../agent/agent-service";
import type { ApiStreamHub } from "./api-stream-hub";
import { is_json_record, type JsonRecord, type JsonValue } from "../../domain/json";
import type { PDFHost } from "../../shared/pdf";
import type { AgentImageHost } from "../../shared/agent-image";
import type { WebFileService } from "../file/web-file-service";
import type { WebAgentSavePathHost } from "./web-agent-save-path-host";
import { JsonTool } from "../../shared/utils/json-tool";
import { BACKEND_API_HOST, build_backend_api_base_url } from "../../shared/backend-api";
import {
  AppError,
  normalize_renderer_error_report,
  resolve_app_error_http_status,
} from "../../shared/error";
import type { ApiGatewayStartResult } from "./api-types";
import { api_error_envelope, normalize_api_error } from "./api-error";
import { register_post_json_route, register_api_request } from "./api-request";
import { register_api_routes, type ApiRouteContext } from "./api-routes";
import {
  create_web_access_session,
  is_matching_web_access_credential,
  type WebAccessSession,
} from "./web-access-session";
import {
  read_static_asset_response,
  read_web_index_response,
  resolve_static_asset_lookup,
} from "./web-static-assets";

const CORS_ALLOWED_HEADERS = "Content-Type"; // 上传与 JSON 请求共用标准 Content-Type，renderer 不依赖私有请求头
const API_PATH_PREFIX = "/api/"; // 同源静态资源与 API 的路径分界，静态回退不得吞掉 API 404
const WEB_SESSION_ESTABLISH_PATH = "/api/web/session"; // 启动凭据换会话的唯一入口
const WEB_BOOTSTRAP_PATH = "/api/web/bootstrap"; // 启动配置只含版本、地址与能力，不含凭据
const WEB_TITLE_BAR_HEIGHT = 40; // 与桌面 DESKTOP_TITLE_BAR_HEIGHT 契约一致；Web 无原生 overlay，壳层标题栏仍按该高度渲染

/**
 * 同源 Web 传输配置。桌面入口不设置该选项，保留回环随机端口与 file:// renderer 所需 CORS。
 */
export interface WebGatewayOptions {
  hostname?: string; // 默认继续绑定本机回环；显式 0.0.0.0 需自行确认暴露面
  port?: number; // 0 表示随机端口，与桌面入口一致
  staticRoot?: string; // 构建产物根目录，缺省时只提供 API
  allowedHosts?: readonly string[]; // Host 头白名单，缺省由实际监听地址推导
  accessSession?: WebAccessSession; // 缺省时网关自建一次性启动凭据会话
  sessionTtlMs?: number;
  pdfHost?: PDFHost; // PDF 宿主按需注入；缺失时能力信息如实报告不可用
  imageHost?: AgentImageHost; // 图片宿主按需注入；缺失时能力信息如实报告不可用
}

/**
 * Gateway 启动参数由 GUI Backend 组合根注入，路由层只消费已组装的服务与传输端口。
 */
export interface ApiGatewayServerOptions {
  backendServices: BackendServices;
  agentService: AgentService;
  skillsService: AgentSkillsApi;
  personalityService: Pick<AgentPersonalityService, "read" | "save">;
  eventStream: ApiStreamHub;
  webFiles?: WebFileService | null; // Web 文件能力；桌面入口为 null，相关路径按能力缺失回答
  agentSavePathHost?: WebAgentSavePathHost | null; // Agent 工作区保存位置桥接宿主；仅 Web 传输创建
  web?: WebGatewayOptions; // 仅 Web 入口提供；桌面入口留空以保持 file:// renderer 行为
}

/**
 * 封装 Electron 公开 API Gateway 的路由和生命周期边界
 */
export class ApiGatewayServer {
  private readonly options: ApiGatewayServerOptions;

  private server: Server | null = null; // 只代表公开 Gateway 监听器，Backend 与 Database 生命周期不归这里关闭

  private public_base_url = ""; // start 成功后固定，重复 start 必须返回同一公开入口

  private public_port = 0; // 实际监听端口，Host 白名单与启动展示共用同一事实

  private accepting_requests = false; // stop 后拒绝尚未进入 Gateway 处理链的迟到请求

  private readonly in_flight_requests = new Set<Promise<unknown>>(); // 请求解析、业务处理和错误响应全部落稳后，Bootstrap 才能释放后端资源

  private readonly web_options: WebGatewayOptions | null;

  private access_session: WebAccessSession | null = null; // Web 访问会话；桌面入口不建立

  private allowed_hosts: readonly string[] = []; // 实际监听地址推导出的 Host 白名单

  private readonly static_root: string | null = null; // 同源静态资源根，与 API 共用同一端口

  /**
   * Gateway 只接收已组装好的运行期依赖，避免路由层自行解析全局状态
   */
  public constructor(options: ApiGatewayServerOptions) {
    this.options = options;
    this.web_options = options.web ?? null;
    this.static_root = options.web?.staticRoot ?? null;
  }

  /**
   * 重复 start 返回同一入口，避免公开端口在运行期漂移
   */
  public async start(): Promise<ApiGatewayStartResult> {
    if (this.server !== null) {
      return { baseUrl: this.public_base_url, port: this.public_port };
    }
    this.accepting_requests = false;
    const app = this.create_app();
    const hostname = this.web_options?.hostname ?? BACKEND_API_HOST;
    const port = this.web_options?.port ?? 0;
    const server = await new Promise<Server>((resolve, reject) => {
      let pending_server: Server;
      /** 启动失败时撤销监听状态，保持重试入口可用。 */
      const handle_start_error = (error: Error): void => {
        pending_server.close();
        this.server = null;
        this.accepting_requests = false;
        reject(error);
      };
      pending_server = serve(
        {
          fetch: app.fetch,
          hostname,
          port,
        },
        () => {
          pending_server.off("error", handle_start_error);
          const address = pending_server.address();
          if (address === null || typeof address === "string") {
            handle_start_error(new Error("API Gateway did not obtain a local listening port."));
            return;
          }
          this.public_port = address.port;
          this.public_base_url = build_backend_api_base_url(address.port);
          resolve(pending_server);
        },
      ) as Server;

      pending_server.once("error", handle_start_error);
    });
    this.server = server;
    this.accepting_requests = true;
    this.allowed_hosts = this.resolve_allowed_hosts(hostname);
    return { baseUrl: this.public_base_url, port: this.public_port };
  }

  /**
   * 只释放 Gateway 自己持有的监听器，Backend 与 Database 生命周期由上层编排
   */
  public async stop(): Promise<void> {
    this.accepting_requests = false;
    const server = this.server;
    this.server = null;
    this.public_base_url = "";
    this.public_port = 0;
    this.allowed_hosts = [];
    this.access_session?.revoke_all_sessions(); // 服务停止即会话失效，重启后旧 Cookie 不得复用
    if (server === null) {
      await this.wait_for_in_flight_requests();
      return;
    }
    let close_error: unknown = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      });
    } catch (error) {
      close_error = error;
    }
    await this.wait_for_in_flight_requests();
    if (close_error !== null) {
      throw close_error;
    }
  }

  /**
   * Gateway 只装配 HTTP 外壳，公开业务路径集中由 api-routes.ts 注册。
   */
  private create_app(): Hono {
    const services = this.options.backendServices;
    const app = new Hono();

    app.use(
      "*",
      async (context, next) =>
        await this.run_tracked_request(async () => {
          if (this.web_options !== null) {
            try {
              this.guard_web_request(context.req.raw);
            } catch (error) {
              // 访问边界失败也走统一错误壳，未授权与非法来源返回可判定的状态码。
              return this.respond_error(error, context.req.path, randomUUID());
            }
            if (context.req.method === "OPTIONS") {
              return new Response(null, { status: 204 });
            }
            await next();
            return; // 同源访问不需要 CORS 响应头，跨站请求已在前面按来源拒绝
          }
          if (context.req.method === "OPTIONS") {
            return new Response(null, { headers: this.cors_headers(), status: 204 });
          }
          await next();
          context.header("Access-Control-Allow-Origin", "*");
          context.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
          context.header("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
        }),
    );

    const route_context: ApiRouteContext = {
      app,
      services,
      agent: this.options.agentService,
      skills: this.options.skillsService,
      personality: this.options.personalityService,
      postJson: (path_name, handler) =>
        register_post_json_route(app, path_name, handler, this.respond_error),
      request: (method, path, handler) =>
        register_api_request(app, method, path, handler, this.respond_error),
      createEventStreamResponse: () => this.options.eventStream.create_stream_response(),
      readLogFiles: () => ({ dates: services.logManager.files.list_dates() }),
      readLogPage: async (body: JsonRecord) =>
        (await services.logManager.files.read_page(
          body as unknown as LogPageRequest,
        )) as unknown as JsonValue,
      readLogDetail: (body: JsonRecord) => this.read_log_detail(body),
      recordRendererError: (body: JsonRecord) => this.record_renderer_error(body),
      establishWebSession: (request) => this.establish_web_session(request),
      readWebBootstrap: (request) => this.read_web_bootstrap(request.headers.get("cookie")),
      webFiles: this.options.webFiles ?? null,
      agentSavePathHost: this.options.agentSavePathHost ?? null,
    };

    register_api_routes(route_context);

    this.register_web_transport_routes(app);

    app.all("*", (context) => this.route_not_found_response(context.req.path));

    return app;
  }

  /**
   * Web 入口的 Host / Origin / 会话校验。静态资源与凭据交换对未授权请求开放，API 与 SSE 一律要求会话。
   */
  private guard_web_request(request: Request): void {
    const request_url = new URL(request.url);
    const host_header = request.headers.get("host") ?? "";
    if (!this.is_allowed_host(host_header)) {
      throw new AppError("request.forbidden_origin", {
        public_details: { reason: "host" },
        diagnostic_context: { host: host_header },
      });
    }
    const origin_header = request.headers.get("origin");
    if (origin_header !== null && !this.is_allowed_origin(origin_header, request_url.protocol)) {
      throw new AppError("request.forbidden_origin", {
        public_details: { reason: "origin" },
        diagnostic_context: { origin: origin_header },
      });
    }
    const request_path = request_url.pathname;
    if (!request_path.startsWith(API_PATH_PREFIX)) return; // 同源静态资源不含敏感事实
    if (request_path === WEB_SESSION_ESTABLISH_PATH || request_path === WEB_BOOTSTRAP_PATH) return;
    if (request_path === "/api/health") return; // 健康检查只报告进程状态
    const session = this.require_access_session();
    if (!session.is_authorized(request.headers.get("cookie"))) {
      throw new AppError("request.unauthorized");
    }
  }

  /** Host 头必须命中实际监听地址或显式白名单，端口不同一律拒绝。 */
  private is_allowed_host(host_header: string): boolean {
    if (this.allowed_hosts.length === 0) return true; // 未配置 Web 传输时不做 Host 收敛
    const normalized_host = host_header.trim().toLowerCase();
    return this.allowed_hosts.some(
      (allowed_host) => allowed_host.toLowerCase() === normalized_host,
    );
  }

  /** Origin 必须与允许 Host 同源；缺失 Origin 的同源导航与 curl 不受影响。 */
  private is_allowed_origin(origin_header: string, protocol: string): boolean {
    let origin_url: URL;
    try {
      origin_url = new URL(origin_header);
    } catch {
      return false;
    }
    return this.allowed_hosts.some(
      (allowed_host) =>
        `${protocol}//${allowed_host}` === `${origin_url.protocol}//${origin_url.host}`,
    );
  }

  /** 实际监听地址推导 Host 白名单；显式配置优先，避免反向代理场景被默认值挡外。 */
  private resolve_allowed_hosts(hostname: string): readonly string[] {
    const configured_hosts = this.web_options?.allowedHosts;
    if (configured_hosts !== undefined) return configured_hosts;
    if (this.public_port === 0) return [];
    const hostnames =
      hostname === BACKEND_API_HOST || hostname === "0.0.0.0" || hostname === "::"
        ? [BACKEND_API_HOST, "localhost"]
        : [hostname];
    return hostnames.map((candidate) => `${candidate}:${this.public_port.toString()}`);
  }

  /** 静态资源与 API 同源；API 路径不进入静态回退，避免把 404 伪装成页面。 */
  private register_web_transport_routes(app: Hono): void {
    const static_root = this.static_root;
    if (static_root === null) return;
    // Hono 把 HEAD 请求交由 GET 路由派发，静态资源只需注册一次。
    app.get("*", (context) => {
      const request_path = new URL(context.req.raw.url).pathname;
      // API 前缀不进入静态回退，未注册的 API 路径仍由统一错误壳回答。
      if (request_path.startsWith(API_PATH_PREFIX))
        return this.route_not_found_response(request_path);
      const lookup = resolve_static_asset_lookup(static_root, request_path);
      if (lookup.file_path === null) {
        return new Response("Not Found", { status: 404 });
      }
      const response = lookup.is_spa_fallback
        ? read_web_index_response(static_root, this.build_web_bootstrap_script())
        : read_static_asset_response(lookup.file_path, request_path);
      return response ?? new Response("Not Found", { status: 404 });
    });
  }

  /** 入口文档内联启动配置，避免首屏前多一次往返，也让访问凭据只存在于 URL 片段。 */
  private build_web_bootstrap_script(): string {
    const bootstrap_json = JsonTool.stringifyStrict(this.read_web_bootstrap(null));
    return `<script>window.__LG_WEB_BOOTSTRAP__=${bootstrap_json};</script>`;
  }

  /** Web 传输启用时按请求携带的 Cookie 报告会话是否已建立。 */
  private is_web_session_established(cookie_header: string | null): boolean {
    if (this.web_options === null) return false;
    const session = this.access_session;
    return session !== null && session.is_authorized(cookie_header);
  }

  /** 启动凭据一次性换取 HttpOnly 会话 Cookie；失败不泄漏凭据是否接近正确。 */
  private async establish_web_session(request: Request): Promise<Response> {
    const session = this.require_access_session();
    if (session.is_authorized(request.headers.get("cookie"))) {
      return new Response(null, { status: 204 });
    }
    const body: unknown = await request.json().catch((error: unknown) => {
      throw new AppError("request.invalid_json", { cause: error });
    });
    const credential = is_json_record(body) ? String(body["credential"] ?? "") : "";
    if (!is_matching_web_access_credential(credential, session.credential)) {
      throw new AppError("request.unauthorized");
    }
    const issued_cookie = session.issue_session_cookie();
    const cookie = `${session.cookie_name}=${issued_cookie.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${issued_cookie.max_age_seconds.toString()}`;
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie } });
  }

  /** 启动配置只包含版本、地址与能力事实，凭据与模型密钥都不进入页面配置。 */
  private read_web_bootstrap(cookie_header: string | null): JsonValue {
    return {
      appVersion: this.options.backendServices.app.metadata.read_version(),
      shell: {
        platform: process.platform,
        usesTitleBarOverlay: false,
        // renderer 标题栏高度与桌面契约 DESKTOP_TITLE_BAR_HEIGHT 一致；
        // Web 没有原生 overlay，但应用壳仍渲染自己的标题栏，报 0 会塌缩壳层。
        titleBarHeight: WEB_TITLE_BAR_HEIGHT,
        titleBarControlSide: "none",
        titleBarSafeAreaStart: 0,
        titleBarSafeAreaEnd: 0,
      },
      backendApi: { baseUrl: this.public_base_url },
      capabilities: {
        // 文件、目录与保存选择已由 Web 宿主桥经应用内选择器实现，能力对前端开放。
        fileDialog: true,
        directoryDialog: true,
        saveDialog: true,
        imageHost: this.options.web?.imageHost !== undefined,
        pdfHost: this.options.web?.pdfHost !== undefined,
        systemNotification: false,
        autoUpdate: false, // 本地服务没有自动更新通道
      },
      session: {
        // 会话 Cookie 为 HttpOnly，renderer 无法自行判断，由本接口按请求携带的 Cookie 报告。
        established: this.is_web_session_established(cookie_header),
      },
      web: {
        sessionRequired: this.access_session !== null,
        staticRoot: this.static_root !== null,
      },
    };
  }

  /** Web 传输启用时按需建立访问会话；桌面入口不触及该状态。 */
  private require_access_session(): WebAccessSession {
    if (this.web_options === null) {
      throw new AppError("runtime.capability_missing", {
        diagnostic_context: { reason: "web_transport_not_configured" },
      });
    }
    if (this.access_session === null) {
      this.access_session =
        this.web_options.accessSession ??
        create_web_access_session(
          this.web_options.sessionTtlMs === undefined
            ? {}
            : { ttl_ms: this.web_options.sessionTtlMs },
        );
    }
    return this.access_session;
  }

  /** 未注册路径统一返回 404 错误壳，静态回退与 API 共用同一事实。 */
  private route_not_found_response(route_path: string): Response {
    const error = new AppError("request.route_not_found", {
      public_details: { path: route_path },
      diagnostic_context: { path: route_path },
    });
    return new Response(JsonTool.stringifyStrict(api_error_envelope(error)), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
      status: resolve_app_error_http_status(error),
    });
  }

  /** JSON 与文件路由共用错误映射和诊断，响应只携带公开错误字段。 */
  private readonly respond_error = (
    error: unknown,
    route_path: string,
    request_id: string,
  ): Response => {
    const normalized_error = normalize_api_error(error);
    const envelope = api_error_envelope(normalized_error);
    const status = resolve_app_error_http_status(normalized_error);
    if (status >= 500 || normalized_error.severity !== "expected") {
      record_app_error(normalized_error, {
        logManager: this.options.backendServices.logManager,
        message: t_main_log("app.diagnostic.api_gateway.direct_route_failed"),
        source: "api-gateway",
        context: {
          code: normalized_error.code,
          path: route_path,
          request_id,
          status,
        },
      });
    }
    return new Response(JsonTool.stringifyStrict(envelope), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
      status,
    });
  };

  /**
   * 从 Gateway 中间件入口跟踪完整请求；连接被强制关闭也不能让解析或错误响应越过资源释放边界。
   */
  private async run_tracked_request<T>(run: () => Promise<T>): Promise<T> {
    if (!this.accepting_requests) {
      throw new AppError("runtime.disposed", {
        diagnostic_context: { reason: "api_gateway_stopping" },
      });
    }
    const operation = Promise.resolve().then(run);
    this.in_flight_requests.add(operation);
    try {
      return await operation;
    } finally {
      this.in_flight_requests.delete(operation);
    }
  }

  /**
   * stop 已关闭接入，因此当前集合清空后不会再出现新的请求处理。
   */
  private async wait_for_in_flight_requests(): Promise<void> {
    await Promise.allSettled(this.in_flight_requests);
  }

  /**
   * 日志详情按正文位置读取，旧 .log 文件不进入读取协议。
   */
  private async read_log_detail(body: JsonRecord): Promise<JsonValue> {
    const id = String(body["id"] ?? "").trim();
    return {
      detail:
        id === ""
          ? null
          : ((await this.options.backendServices.logManager.files.read_detail(
              id,
              String(body["revision"] ?? ""),
            )) as unknown as JsonValue),
    };
  }

  /**
   * renderer 只能提交已裁剪的异常快照；Gateway 再做一次边界收窄后写入统一 LogManager。
   */
  private record_renderer_error(body: JsonRecord): JsonValue {
    const report = normalize_renderer_error_report(body);

    this.options.backendServices.logManager.error(
      t_main_log("app.diagnostic.renderer.reported_error"),
      {
        source: "renderer",
        ...renderer_error_report_to_log_payload(report),
      },
    );

    return {};
  }

  /**
   * 集中 CORS 头，保持健康检查、代理和预检响应一致
   */
  private cors_headers(): Headers {
    return new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    });
  }
}
