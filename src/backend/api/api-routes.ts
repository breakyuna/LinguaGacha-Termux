import type { AgentPersonalityService } from "../agent/agent-personality-service";
import type { AgentSkillsApi } from "../agent/agent-skills-service";
import type { Hono } from "hono";
import { Readable } from "node:stream";
import path from "node:path";
import { AppError } from "../../shared/error";

import { is_json_record, type JsonRecord, type JsonValue } from "../../domain/json";
import type { BackendServices } from "../bootstrap/backend-services";
import type { AgentService } from "../agent/agent-service";
import type { ApiPostJsonRoute, ApiRequestRoute } from "./api-request";
import { ok } from "./api-types";
import type { WebFileService } from "../file/web-file-service";
import { read_save_path_response, type WebAgentSavePathHost } from "./web-agent-save-path-host";
import {
  create_export_directory,
  release_materials,
  remove_export_directory,
  resolve_material_import_commands,
  resolve_material_path,
  resolve_material_paths,
  stage_existing_file,
  type WebMaterialImportRequest,
} from "../file/web-import-materials";

const RULE_EXPORT_MATERIAL_NAME = "quality-rules.json"; // 材料模式的规则导出文件名，交付 JSON 交换格式
const PROMPT_EXPORT_MATERIAL_NAME = "translation-prompt.txt"; // 材料模式的提示词导出文件名

/**
 * 公开路由只消费组合根和 Gateway 提供的传输适配器，不自行创建领域依赖。
 */
export interface ApiRouteContext {
  app: Hono;
  services: BackendServices;
  agent: AgentService;
  skills: AgentSkillsApi;
  personality: Pick<AgentPersonalityService, "read" | "save">;
  postJson: ApiPostJsonRoute;
  request: ApiRequestRoute;
  createEventStreamResponse: () => Response;
  readLogFiles: () => JsonValue;
  readLogPage: (body: JsonRecord) => Promise<JsonValue>;
  readLogDetail: (body: JsonRecord) => Promise<JsonValue>;
  recordRendererError: (body: JsonRecord) => JsonValue;
  establishWebSession: (request: Request) => Promise<Response>;
  readWebBootstrap: (request: Request) => JsonValue;
  webFiles: WebFileService | null; // 桌面入口为 null，Web 文件路径按能力缺失回答
  agentSavePathHost: WebAgentSavePathHost | null; // 桌面入口为 null，保存位置请求按能力缺失回答
}

/** 注册 Web 文件路由；能力缺失由 require_web_files 统一回答。 */
function register_web_file_routes(context: ApiRouteContext): void {
  context.postJson("/api/web/files/roots", () => ({
    roots: require_web_files(context).list_roots(),
  }));
  context.postJson("/api/web/files/list", (body) => {
    const files = require_web_files(context);
    const root_id = String(body["root_id"] ?? "");
    const relative_path = String(body["path"] ?? "");
    return files.list_directory(root_id, relative_path);
  });
  context.request("POST", "/api/web/files/upload", async (request) => {
    const files = require_web_files(context);
    const name = new URL(request.url).searchParams.get("name");
    if (name === null || name === "") throw new AppError("request.validation_failed");
    return Response.json(
      ok(
        await files.stage_upload(
          name,
          request.body ??
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
          request.signal,
        ),
      ),
    );
  });
  context.request("GET", "/api/web/files/material/:id", (request) => {
    const files = require_web_files(context);
    const material_id = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const material = files.read_material(material_id);
    return new Response(Readable.toWeb(material.stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(material.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(material.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
  context.postJson("/api/web/files/material/release", async (body) => {
    const files = require_web_files(context);
    await files.release_material(String(body["material_id"] ?? ""));
    return {};
  });
  context.request("GET", "/api/web/files/download", (request) => {
    const files = require_web_files(context);
    const requested_path = new URL(request.url).searchParams.get("path");
    if (requested_path === null || requested_path === "") {
      throw new AppError("request.validation_failed");
    }
    const download = files.open_download(requested_path);
    return new Response(Readable.toWeb(download.stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(download.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
}

/** Web 文件能力只在 Web 传输装配时可用；桌面入口同一路径返回能力缺失。 */

/** Agent 保存位置桥接只在 Web 传输装配时可用；桌面入口由原生对话框承接。 */
function require_agent_save_path_host(context: ApiRouteContext): WebAgentSavePathHost {
  if (context.agentSavePathHost === null) {
    throw new AppError("runtime.capability_missing", {
      public_details: { reason: "web_save_path_host_unavailable" },
    });
  }
  return context.agentSavePathHost;
}
function require_web_files(context: ApiRouteContext): WebFileService {
  if (context.webFiles === null) {
    throw new AppError("runtime.capability_missing", {
      public_details: { reason: "web_file_service_unavailable" },
    });
  }
  return context.webFiles;
}

/** 读取请求内的非空字符串列表，材料身份与路径集合共用同一收窄规则。 */
function read_string_list(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .filter((item) => item.trim() !== "");
}

/** 读取导入材料声明，非对象或空身份条目直接忽略，由暂存解析统一拒绝未知身份。 */
function read_material_import_requests(value: JsonValue | undefined): WebMaterialImportRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!is_json_record(item)) return [];
    const material_id = String(item["material_id"] ?? "").trim();
    if (material_id === "") return [];
    const target_rel_path = item["target_rel_path"];
    return [
      {
        material_id,
        ...(typeof target_rel_path === "string" && target_rel_path.trim() !== ""
          ? { target_rel_path }
          : {}),
      },
    ];
  });
}

/** 导入命令追加进 files，目标相对路径缺省时由暂存材料显示名推导。 */
function with_material_import_commands(
  web_files: WebFileService | null,
  body: JsonRecord,
): JsonRecord {
  const material_requests = read_material_import_requests(body["materials"]);
  if (material_requests.length === 0) return body; // 桌面请求原样转交，载荷不复制
  const commands = resolve_material_import_commands(web_files, material_requests);
  const files = Array.isArray(body["files"])
    ? body["files"].filter((item): item is JsonRecord => is_json_record(item))
    : [];
  return { ...body, files: [...files, ...commands] };
}

/** 材料导入把暂存路径提升为服务 path 入参，桌面 path 语义保持不变。 */
function with_material_import_path(web_files: WebFileService | null, body: JsonRecord): JsonRecord {
  const material_id = String(body["material_id"] ?? "").trim();
  if (material_id === "") return body;
  const request: JsonRecord = { ...body, path: resolve_material_path(web_files, material_id) };
  delete request["material_id"];
  return request;
}

/** 预览只接收源路径集合，暂存材料解析为绝对路径后追加进去。 */
function with_material_source_paths(
  web_files: WebFileService | null,
  body: JsonRecord,
): JsonRecord {
  const material_paths = resolve_material_paths(
    web_files,
    read_material_import_requests(body["materials"]).map((material) => material.material_id),
  );
  if (material_paths.length === 0) return body; // 桌面请求原样转交，载荷不复制
  return {
    ...body,
    source_paths: [...read_string_list(body["source_paths"]), ...material_paths],
  };
}

/** 材料模式导出名只取单个文件基名，分隔符统一替换，避免命名穿越一次性导出目录。 */
function read_material_export_name(body: JsonRecord, fallback: string): string {
  const raw = body["material_name"];
  if (typeof raw !== "string") return fallback;
  const base_name = raw.replace(/[\\/]/gu, "_").trim();
  return base_name === "" ? fallback : base_name;
}

/**
 * 导出材料模式：服务输出写到暂存区一次性目录，主文件登记为材料后清理目录；
 * 桌面 path 入参和响应形状不变，material 字段只在材料模式出现。
 */
async function export_with_material(args: {
  context: ApiRouteContext;
  body: JsonRecord;
  display_name: string;
  export_file: (request: JsonRecord) => Promise<JsonRecord>;
}): Promise<JsonRecord> {
  const web_files = require_web_files(args.context);
  const staging_root = args.context.services.app.paths.get_web_import_root_dir();
  const export_directory = create_export_directory(staging_root);
  const display_name = read_material_export_name(args.body, args.display_name);
  try {
    const request: JsonRecord = {
      ...args.body,
      path: path.join(export_directory, display_name),
    };
    delete request["material"];
    delete request["material_name"];
    const response = await args.export_file(request);
    const material = await stage_existing_file(
      web_files,
      String(response["path"]),
      args.display_name,
    );
    return {
      ...response,
      // 暂存绝对路径不穿过 API 边界，浏览器只按材料身份下载。
      material: { material_id: material.material_id, name: material.name, size: material.size },
    };
  } finally {
    await remove_export_directory(export_directory);
  }
}

/**
 * 在唯一 API 注册文件集中绑定路径；这里只做协议分发，业务语义留在领域服务。
 */
export function register_api_routes(context: ApiRouteContext): void {
  const services = context.services;
  const agent = context.agent;

  context.postJson("/api/agent/personality/read", () => context.personality.read());
  context.postJson("/api/agent/personality/save", (body) => context.personality.save(body));
  context.postJson("/api/skills/delete", (body) => context.skills.delete(body));
  context.postJson("/api/skills/snapshot", () => context.skills.snapshot());
  context.postJson("/api/skills/enabled", (body) => context.skills.set_enabled(body));
  context.postJson("/api/skills/reorder", (body) => context.skills.reorder(body));
  context.postJson("/api/skills/tree", (body) => context.skills.tree(body));
  context.postJson("/api/skills/file/read", (body) => context.skills.read_file(body));
  context.postJson("/api/skills/file/save", (body) => context.skills.save_file(body));
  context.postJson("/api/skills/file/change", (body) => context.skills.change_file(body));

  context.app.get("/api/health", (hono_context) =>
    hono_context.json(
      ok({
        status: "ok",
        service: "linguagacha-backend",
        version: services.app.metadata.read_version(),
      }),
    ),
  );
  context.postJson("/api/logs/files", () => context.readLogFiles());
  context.postJson("/api/logs/page", (body) => context.readLogPage(body));
  context.postJson("/api/logs/detail", (body) => context.readLogDetail(body));
  context.postJson("/api/diagnostics/renderer-error", (body) => context.recordRendererError(body));

  const lifecycle = services.project.lifecycle;
  context.postJson("/api/session/project/manifest", () => services.project.readManifest());
  context.postJson("/api/session/project/snapshot", () => lifecycle.get_project_snapshot());
  context.postJson("/api/session/project/close", () => lifecycle.unload_project());
  context.postJson("/api/session/project/preview", (body) => lifecycle.get_project_preview(body));
  context.postJson("/api/session/source-files/summary", (body) =>
    lifecycle.summarize_source_files(body),
  );
  context.postJson("/api/session/project/open", (body) => lifecycle.load_project(body));
  context.postJson("/api/session/project/create", async (body) => {
    const web_files = context.webFiles;
    const material_ids = read_string_list(body["material_ids"]);
    // 暂存材料解析为绝对路径后并入 source_paths，去重由生命周期服务的身份语义完成。
    const material_paths = resolve_material_paths(web_files, material_ids);
    const request: JsonRecord = {
      ...body,
      source_paths: [...read_string_list(body["source_paths"]), ...material_paths],
    };
    delete request["material_ids"];
    const response = await lifecycle.create_project_commit(request);
    // 材料只在工程提交成功后释放，失败保留暂存文件供重试。
    if (material_ids.length > 0 && web_files !== null) {
      await release_materials(web_files, material_ids);
    }
    return response;
  });
  context.postJson("/api/session/project/copy", () => services.project.copy.copy_project());
  context.postJson("/api/session/project/open-preview", (body) =>
    lifecycle.get_open_alignment_preview(body),
  );

  context.app.get("/api/events/stream", () => context.createEventStreamResponse());
  context.request("POST", "/api/web/session", (request) => context.establishWebSession(request));
  register_web_file_routes(context);
  context.app.get("/api/web/bootstrap", (hono_context) =>
    hono_context.json(ok(context.readWebBootstrap(hono_context.req.raw))),
  );
  context.postJson("/api/runtime/snapshot", () => services.runtime.getSnapshot());
  context.app.get("/api/models/catalog/snapshot", (hono_context) =>
    hono_context.json(ok(services.modelCatalog.get_snapshot())),
  );
  context.app.get("/api/agent/files", async (context) =>
    context.json(ok(await agent.list_files())),
  );
  context.app.get("/api/agent/snapshot", (hono_context) =>
    hono_context.json(ok(agent.get_snapshot())),
  );
  context.postJson("/api/agent/message", (body) => agent.input_command("send", body));
  context.postJson("/api/agent/input-status", (body) => agent.input_command_status(body));
  context.request("POST", "/api/agent/uploads", async (request) => {
    const name = new URL(request.url).searchParams.get("name");
    if (name === null || name === "") throw new AppError("request.validation_failed");
    return Response.json(
      ok(
        await agent.upload_file(
          name,
          request.body ??
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
          request.signal,
        ),
      ),
    );
  });
  context.request("GET", "/api/agent/uploads/:id", (request) => {
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    const { file, stream } = agent.read_upload(id);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": file.imageMimeType ?? "application/octet-stream",
        "Content-Length": String(file.size),
        "Content-Disposition": `${file.imageMimeType === null ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
  context.postJson("/api/agent/workspace/file", (body) => agent.describe_workspace_file(body));
  context.postJson("/api/agent/workspace/document", (body) => agent.read_workspace_document(body));
  context.request("GET", "/api/agent/workspace/image", async (request) => {
    const query = new URL(request.url).searchParams;
    const image = await agent.read_workspace_image(query.get("path"), query.get("chatId"));
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
  context.postJson("/api/agent/workspace/activate-path", (body) =>
    agent.activate_workspace_path(body),
  );
  // 迟连接的浏览器领取驻留的保存位置请求，应答后桥接宿主放行工作区保存。
  context.postJson("/api/agent/save-path/pending", () => {
    const host = require_agent_save_path_host(context);
    return { requests: host.list_pending_requests() };
  });
  context.postJson("/api/agent/save-path/respond", (body) => {
    const host = require_agent_save_path_host(context);
    const request_id = String(body["request_id"] ?? "");
    if (request_id === "") throw new AppError("request.validation_failed");
    const responded = host.respond_to_request(request_id, read_save_path_response(body));
    if (!responded)
      throw new AppError("request.validation_failed", {
        public_details: { reason: "web_save_path_request_unknown" },
      });
    return {};
  });
  context.postJson("/api/agent/question/resolve", (body) => agent.resolve_question(body));
  context.postJson("/api/agent/write-approval/resolve", (body) =>
    agent.resolve_write_approval(body),
  );
  context.postJson("/api/agent/queue/update", (body) => agent.update_queued_message(body));
  context.postJson("/api/agent/queue/delete", (body) => agent.delete_queued_message(body));
  context.postJson("/api/agent/queue/reorder", (body) => agent.reorder_queued_messages(body));
  context.postJson("/api/agent/queue/send", (body) => agent.input_command("queue_send", body));
  context.postJson("/api/agent/round/fork", (body) => agent.input_command("fork", body));
  context.postJson("/api/agent/round/revise", (body) => agent.input_command("revise", body));
  context.postJson("/api/agent/continue", (body) => agent.input_command("continue", body));
  context.postJson("/api/agent/context/compact", () => agent.compact_context());
  context.postJson("/api/agent/stop", () => agent.stop());
  context.postJson("/api/agent/reset", () => agent.reset());

  const project_content = services.project.content;
  context.postJson("/api/workbench/snapshot", () => services.project.summary.read());
  context.postJson("/api/project/translation-stats", () =>
    services.project.summary.read_translation_stats(),
  );
  context.postJson("/api/workbench/files/import", async (body) => {
    const web_files = context.webFiles;
    const material_requests = read_material_import_requests(body["materials"]);
    const request = with_material_import_commands(web_files, body);
    const response = await project_content.import_files(request);
    // 导入提交成功后才释放暂存材料，失败保留文件供重试。
    if (material_requests.length > 0 && web_files !== null) {
      await release_materials(
        web_files,
        material_requests.map((material) => material.material_id),
      );
    }
    return response;
  });
  context.postJson("/api/workbench/file/reset", (body) => project_content.reset_files(body));
  context.postJson("/api/workbench/file/delete", (body) => project_content.delete_files(body));
  context.postJson("/api/workbench/files/reorder", (body) => project_content.reorder_files(body));
  // 预览只消费源路径集合，暂存材料解析为绝对路径后追加。
  context.postJson("/api/workbench/files/preview", (body) =>
    project_content.preview_import_files(with_material_source_paths(context.webFiles, body)),
  );
  context.postJson("/api/workbench/settings-alignment/apply", (body) =>
    project_content.align_settings(body),
  );
  context.postJson("/api/workbench/translation/reset", (body) =>
    project_content.reset_translation(body),
  );

  const proofreading_query = services.proofreading.query;
  const proofreading = services.proofreading.commands;
  context.postJson("/api/proofreading/page", (body) => services.proofreading.preview.query(body));
  context.postJson("/api/proofreading/query", (body) => proofreading_query.query(body));
  context.postJson("/api/proofreading/items/update", (body) =>
    proofreading.apply_item_changes(body),
  );
  context.postJson("/api/proofreading/translations/clear", (body) =>
    proofreading.clear_translations(body),
  );
  context.postJson("/api/proofreading/items/replace-all", (body) => proofreading.replace_all(body));

  const quality_statistics = services.quality.statistics;
  const quality_rules = services.quality.rules;
  const prompts = services.quality.prompts;
  context.postJson("/api/quality/statistics/view", (body) => quality_statistics.read(body));
  context.postJson("/api/quality/rules/query", (body) => quality_rules.query(body));
  context.postJson("/api/quality/prompts/view", (body) => prompts.read(body));
  context.postJson("/api/quality/rules/update", (body) => quality_rules.update(body));
  context.postJson("/api/quality/rules/import", (body) =>
    quality_rules.import_rules(with_material_import_path(context.webFiles, body)),
  );
  context.postJson("/api/quality/rules/export", (body) =>
    body["material"] === true
      ? export_with_material({
          context,
          body,
          display_name: RULE_EXPORT_MATERIAL_NAME,
          export_file: (request) => quality_rules.export_rules(request),
        })
      : quality_rules.export_rules(body),
  );
  context.postJson("/api/quality/rules/presets", (body) => quality_rules.list_rule_presets(body));
  context.postJson("/api/quality/rules/presets/read", (body) =>
    quality_rules.read_rule_preset(body),
  );
  context.postJson("/api/quality/rules/presets/save", (body) =>
    quality_rules.save_rule_preset(body),
  );
  context.postJson("/api/quality/rules/presets/rename", (body) =>
    quality_rules.rename_rule_preset(body),
  );
  context.postJson("/api/quality/rules/presets/delete", (body) =>
    quality_rules.delete_rule_preset(body),
  );
  context.postJson("/api/quality/prompts/template", (body) => prompts.get_template(body));
  context.postJson("/api/quality/prompts/save", (body) => prompts.save(body));
  context.postJson("/api/quality/prompts/import", (body) =>
    prompts.read_import_text(with_material_import_path(context.webFiles, body)),
  );
  context.postJson("/api/quality/prompts/export", (body) =>
    body["material"] === true
      ? export_with_material({
          context,
          body,
          display_name: PROMPT_EXPORT_MATERIAL_NAME,
          export_file: (request) => prompts.export(request),
        })
      : prompts.export(body),
  );
  context.postJson("/api/quality/prompts/presets", (body) => prompts.list_presets(body));
  context.postJson("/api/quality/prompts/presets/read", (body) => prompts.read_preset(body));
  context.postJson("/api/quality/prompts/presets/save", (body) => prompts.save_preset(body));
  context.postJson("/api/quality/prompts/presets/rename", (body) => prompts.rename_preset(body));
  context.postJson("/api/quality/prompts/presets/delete", (body) => prompts.delete_preset(body));

  context.postJson("/api/translation/files/generate", () =>
    services.files.translationGeneration.generate_files(),
  );
  context.postJson("/api/translation/files/outputs", () => ({
    // 下载清单与受控下载边界同源，覆盖该工程全部语言的译文输出目录。
    files: services.files.translationGeneration.read_output_files(),
  }));
  context.request("GET", "/api/translation/files/download", (request) => {
    const requested_path = new URL(request.url).searchParams.get("path");
    if (requested_path === null || requested_path === "") {
      throw new AppError("request.validation_failed");
    }
    const download = services.files.translationGeneration.open_download(requested_path);
    return new Response(Readable.toWeb(download.stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(download.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });

  const settings = services.app.settings;
  context.postJson("/api/settings/app", () => settings.get_app_settings());
  context.postJson("/api/settings/update", (body) => services.app.updateSettings(body));
  context.postJson("/api/settings/recent-projects/add", (body) =>
    settings.add_recent_project(body),
  );
  context.postJson("/api/settings/recent-projects/remove", (body) =>
    settings.remove_recent_project(body),
  );

  const models = services.model;
  context.postJson("/api/models/auth/snapshot", () => ({
    snapshot: services.modelAuth.snapshot(),
  }));
  context.postJson("/api/models/auth/login", () => services.modelAuth.login());
  context.postJson("/api/models/auth/cancel", (body) =>
    services.modelAuth.cancel_login(body["id"]),
  );
  context.postJson("/api/models/auth/logout", () => services.modelAuth.logout());
  context.app.get("/api/models/selection", (hono_context) =>
    hono_context.json(ok(models.get_selection_snapshot())),
  );
  context.postJson("/api/models/snapshot", () => models.get_snapshot());
  context.postJson("/api/models/update", (body) => models.update_model(body));
  context.postJson("/api/models/select", (body) => models.select_model(body));
  context.postJson("/api/models/add", (body) => models.add_model(body));
  context.postJson("/api/models/copy", (body) => models.copy_model(body));
  context.postJson("/api/models/delete", (body) => models.delete_model(body));
  context.postJson("/api/models/reset-preset", (body) => models.reset_preset_model(body));
  context.postJson("/api/models/reorder", (body) => models.reorder_model(body));
  context.postJson("/api/models/list-available", (body) => models.list_available_models(body));
  context.postJson("/api/models/test", (body) => models.test_model(body));

  const batch_translation = services.batchTranslation;
  context.postJson("/api/batch-translation/start", (body) => batch_translation.start(body));
  context.postJson("/api/batch-translation/stop", () => batch_translation.stop());
  context.postJson("/api/batch-translation/snapshot", () => batch_translation.get_snapshot());
}
