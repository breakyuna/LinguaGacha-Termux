import type { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { JsonRecord, JsonSnapshot } from "../../domain/json";
import type { BackendServices } from "../bootstrap/backend-services";
import type { AgentService } from "../agent/agent-service";
import type { ApiJsonHandler } from "./api-request";
import { register_api_routes } from "./api-routes";
import { AppPathService } from "../app/app-path-service";
import type { WebFileService } from "../file/web-file-service";
import { WebFileService as RealWebFileService } from "../file/web-file-service";
import { AppError } from "../../shared/error";

// 公开 HTTP 路径是客户端契约，独立清单用于发现误删、改名与重复注册。
const GET_PATHS = new Set([
  "/api/agent/files",
  "/api/agent/workspace/image",
  "/api/agent/uploads/:id",
  "/api/health",
  "/api/events/stream",
  "/api/agent/snapshot",
  "/api/models/selection",
  "/api/models/catalog/snapshot",
  "/api/web/bootstrap",
  "/api/web/files/material/:id",
  "/api/web/files/download",
  "/api/translation/files/download",
]);

const POST_PATHS = new Set([
  "/api/web/session",
  "/api/web/files/roots",
  "/api/web/files/list",
  "/api/web/files/upload",
  "/api/web/files/material/release",
  "/api/models/auth/snapshot",
  "/api/models/auth/login",
  "/api/models/auth/cancel",
  "/api/models/auth/logout",
  "/api/agent/personality/read",
  "/api/agent/personality/save",
  "/api/skills/delete",
  "/api/skills/snapshot",
  "/api/skills/enabled",
  "/api/skills/reorder",
  "/api/skills/tree",
  "/api/skills/file/read",
  "/api/skills/file/save",
  "/api/skills/file/change",
  "/api/agent/uploads",
  "/api/logs/detail",
  "/api/logs/files",
  "/api/logs/page",
  "/api/diagnostics/renderer-error",
  "/api/runtime/snapshot",
  "/api/agent/input-status",
  "/api/agent/message",
  "/api/agent/workspace/activate-path",
  "/api/agent/workspace/document",
  "/api/agent/workspace/file",
  "/api/agent/question/resolve",
  "/api/agent/write-approval/resolve",
  "/api/agent/queue/update",
  "/api/agent/queue/delete",
  "/api/agent/queue/reorder",
  "/api/agent/queue/send",
  "/api/agent/round/revise",
  "/api/agent/round/fork",
  "/api/agent/save-path/pending",
  "/api/agent/save-path/respond",
  "/api/agent/continue",
  "/api/agent/context/compact",
  "/api/agent/stop",
  "/api/agent/reset",
  "/api/session/project/manifest",
  "/api/session/project/snapshot",
  "/api/session/project/close",
  "/api/session/project/preview",
  "/api/session/source-files/summary",
  "/api/session/project/open",
  "/api/session/project/create",
  "/api/session/project/copy",
  "/api/session/project/open-preview",
  "/api/workbench/snapshot",
  "/api/project/translation-stats",
  "/api/workbench/files/import",
  "/api/workbench/file/reset",
  "/api/workbench/file/delete",
  "/api/workbench/files/reorder",
  "/api/workbench/files/preview",
  "/api/workbench/settings-alignment/apply",
  "/api/workbench/translation/reset",
  "/api/proofreading/query",
  "/api/proofreading/page",
  "/api/proofreading/items/update",
  "/api/proofreading/translations/clear",
  "/api/proofreading/items/replace-all",
  "/api/quality/statistics/view",
  "/api/quality/rules/query",
  "/api/quality/prompts/view",
  "/api/quality/rules/update",
  "/api/quality/rules/import",
  "/api/quality/rules/export",
  "/api/quality/rules/presets",
  "/api/quality/rules/presets/read",
  "/api/quality/rules/presets/save",
  "/api/quality/rules/presets/rename",
  "/api/quality/rules/presets/delete",
  "/api/quality/prompts/template",
  "/api/quality/prompts/save",
  "/api/quality/prompts/import",
  "/api/quality/prompts/export",
  "/api/quality/prompts/presets",
  "/api/quality/prompts/presets/read",
  "/api/quality/prompts/presets/save",
  "/api/quality/prompts/presets/rename",
  "/api/quality/prompts/presets/delete",
  "/api/translation/files/generate",
  "/api/settings/app",
  "/api/settings/update",
  "/api/settings/recent-projects/add",
  "/api/settings/recent-projects/remove",
  "/api/models/snapshot",
  "/api/models/update",
  "/api/models/select",
  "/api/models/add",
  "/api/models/copy",
  "/api/models/delete",
  "/api/models/reset-preset",
  "/api/models/reorder",
  "/api/models/list-available",
  "/api/models/test",
  "/api/batch-translation/start",
  "/api/batch-translation/stop",
  "/api/batch-translation/snapshot",
]);

const data_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-api-routes-"));
const paths = new AppPathService({
  appRoot: data_root,
  builtinRoot: path.join(data_root, "builtin"),
  dataRoot: path.join(data_root, "data"),
});
const staging_root = paths.get_web_import_root_dir();

// 材料契约用例共用同一个真实暂存服务，注册清单用例不受影响。
const web_files: WebFileService = new RealWebFileService({ paths });

afterAll(async () => {
  await web_files.dispose();
  fs.rmSync(data_root, { recursive: true, force: true });
});

function create_upload_body(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

/** 把响应快照按 JSON 记录读取，材料字段断言不依赖信封类型收窄。 */
function read_snapshot_record(value: JsonSnapshot): JsonRecord {
  return value as unknown as JsonRecord;
}

describe("register_api_routes", () => {
  it("注册完整且无重复的公开路径，不锁定注册顺序", () => {
    const fixture = create_route_fixture();
    const get_paths = fixture.get.mock.calls.map(([route_path]) => String(route_path));
    const post_paths = fixture.post_json.mock.calls.map(([route_path]) => String(route_path));
    const all_paths = [...get_paths, ...post_paths];

    expect(new Set(get_paths)).toEqual(GET_PATHS);
    expect(new Set(post_paths)).toEqual(POST_PATHS);
    expect(new Set(all_paths).size).toBe(all_paths.length);
  });

  it("GET 路由返回 Agent、模型选择和目录快照", () => {
    const fixture = create_route_fixture();
    const json = (value: unknown) => value; // 保留原始响应对象以验证公开载荷。

    expect(read_get_handler(fixture.get, "/api/agent/snapshot")({ json })).toEqual({
      ok: true,
      data: {
        revision: 0,
        state: "idle",
        pendingDecision: null,
        entries: [],
        skills: [],
        inputQueue: { paused: false, canSendNow: false, items: [] },
        doing: null,
        context: { tokens: null, compactable: false, limits: null },
      },
    });
    expect(read_get_handler(fixture.get, "/api/models/selection")({ json })).toEqual({
      ok: true,
      data: {
        model_selection: { translation: "a", agent: "c" },
        models: [],
      },
    });
    expect(read_get_handler(fixture.get, "/api/models/catalog/snapshot")({ json })).toEqual({
      ok: true,
      data: fixture.catalog_snapshot,
    });
  });

  it("POST 路由把任务与 Agent 命令原样转交组合根", async () => {
    const fixture = create_route_fixture();
    const task = { task_type: "translation" };
    const message: JsonRecord = { text: '@skill("glossary-audit") 审校' };

    expect(read_post_handler(fixture.post_json, "/api/batch-translation/start")(task)).toEqual({
      accepted: true,
    });
    expect(fixture.start_task).toHaveBeenCalledWith(task);
    await expect(
      read_post_handler(fixture.post_json, "/api/agent/message")(message),
    ).resolves.toEqual({ revision: 7 });
    expect(fixture.input_command).toHaveBeenCalledWith("send", message);
    const question = { id: "question-1", response: { kind: "option", optionId: "safe" } };
    expect(read_post_handler(fixture.post_json, "/api/agent/question/resolve")(question)).toEqual({
      revision: 7,
    });
    expect(fixture.resolve_question).toHaveBeenCalledWith(question);
    const write = { id: "apply-1", decision: "allow_once" };
    expect(
      read_post_handler(fixture.post_json, "/api/agent/write-approval/resolve")(write),
    ).toEqual({ revision: 7 });
    expect(fixture.resolve_write_approval).toHaveBeenCalledWith(write);
    const queued = { id: "queue-1" };
    expect(read_post_handler(fixture.post_json, "/api/agent/queue/delete")(queued)).toEqual({
      revision: 7,
    });
    expect(fixture.delete_queued_message).toHaveBeenCalledWith(queued);
    const update = { id: "queue-1", message: { text: "修改", attachments: [] } };
    expect(read_post_handler(fixture.post_json, "/api/agent/queue/update")(update)).toEqual({
      revision: 7,
    });
    expect(fixture.update_queued_message).toHaveBeenCalledWith(update);
    const reorder = { ids: ["queue-2", "queue-1"] };
    expect(read_post_handler(fixture.post_json, "/api/agent/queue/reorder")(reorder)).toEqual({
      revision: 7,
    });
    expect(fixture.reorder_queued_messages).toHaveBeenCalledWith(reorder);
    await expect(
      read_post_handler(fixture.post_json, "/api/agent/queue/send")(queued),
    ).resolves.toEqual({ revision: 7 });
    expect(fixture.input_command).toHaveBeenCalledWith("queue_send", queued);
    const continuation = { message: { text: "继续后追加", attachments: [] } };
    await expect(
      read_post_handler(fixture.post_json, "/api/agent/continue")(continuation),
    ).resolves.toEqual({ revision: 7 });
    expect(fixture.input_command).toHaveBeenCalledWith("continue", continuation);
    await expect(
      read_post_handler(fixture.post_json, "/api/agent/context/compact")({}),
    ).resolves.toEqual({ revision: 7 });
    expect(fixture.compact_context).toHaveBeenCalledWith();
    const revision = { entryId: "assistant-1", message: { text: "修订", attachments: [] } };
    await expect(
      read_post_handler(fixture.post_json, "/api/agent/round/revise")(revision),
    ).resolves.toEqual({ revision: 7 });
    expect(fixture.input_command).toHaveBeenCalledWith("revise", revision);
    expect(read_post_handler(fixture.post_json, "/api/agent/stop")({})).toEqual({ revision: 7 });
    expect(fixture.stop).toHaveBeenCalledWith();
    await expect(read_post_handler(fixture.post_json, "/api/agent/reset")({})).resolves.toEqual({
      revision: 7,
    });
    expect(fixture.reset).toHaveBeenCalledWith();
  });

  it("POST 路由从组合根读取统一运行时快照", () => {
    const fixture = create_route_fixture();

    expect(read_post_handler(fixture.post_json, "/api/runtime/snapshot")({})).toEqual({
      runtime: { revision: 0, owner: null },
    });
  });

  it("source-files 摘要路由把显式路径原样转交生命周期服务", () => {
    const fixture = create_route_fixture();
    const request = { source_paths: ["E:/source"] };

    expect(read_post_handler(fixture.post_json, "/api/session/source-files/summary")(request)).toBe(
      fixture.source_file_summary,
    );
    expect(fixture.summarize_source_files).toHaveBeenCalledWith(request);
  });

  it("设置更新只调用组合根提供的受保护写入口", () => {
    const fixture = create_route_fixture();

    expect(
      read_post_handler(fixture.post_json, "/api/settings/update")({ app_language: "ZH" }),
    ).toEqual({ settings: { app_language: "ZH" } });
    expect(fixture.update_settings).toHaveBeenCalledWith({ app_language: "ZH" });
  });

  it("组合选模载荷原样转交唯一选模入口", () => {
    const fixture = create_route_fixture();
    const request = { target: "translation", model_id: "a", thinking_level: "HIGH" };
    expect(read_post_handler(fixture.post_json, "/api/models/select")(request)).toEqual({
      selected: request,
    });
    expect(fixture.select_model).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("复制路由原样转交源 ID 并返回副本身份和快照", () => {
    const fixture = create_route_fixture();
    const request = { model_id: "source" };
    const response = { copied_model_id: "copy", snapshot: { models: [] } };
    fixture.copy_model.mockReturnValue(response);
    expect(read_post_handler(fixture.post_json, "/api/models/copy")(request)).toBe(response);
    expect(fixture.copy_model).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("工程创建合并暂存材料路径，提交成功后释放材料", async () => {
    const fixture = create_route_fixture();
    const staged = await web_files.stage_upload(
      "novel.txt",
      create_upload_body("正文"),
      new AbortController().signal,
    );
    fixture.create_project_commit.mockResolvedValue({
      project: { path: "/data/out.lg", loaded: true },
    });

    const response = await read_post_handler(
      fixture.post_json,
      "/api/session/project/create",
    )({
      path: "/data/out.lg",
      source_paths: ["/data/source.txt"],
      material_ids: [staged.material_id],
      project_settings: {},
    });

    expect(response).toEqual({ project: { path: "/data/out.lg", loaded: true } });
    const request = fixture.create_project_commit.mock.calls[0]?.[0] as JsonRecord;
    expect(request["material_ids"]).toBeUndefined();
    expect(request["source_paths"]).toEqual(["/data/source.txt", staged.path]);
    expect(fs.existsSync(staged.path)).toBe(false);
    expect(() => web_files.read_staged_material(staged.material_id)).toThrow(AppError);
  });

  it("工程创建提交失败不释放暂存材料", async () => {
    const fixture = create_route_fixture();
    const staged = await web_files.stage_upload(
      "novel.txt",
      create_upload_body("正文"),
      new AbortController().signal,
    );
    fixture.create_project_commit.mockRejectedValue(new AppError("file.parse_failed"));

    await expect(
      read_post_handler(
        fixture.post_json,
        "/api/session/project/create",
      )({
        path: "/data/out.lg",
        source_paths: [],
        material_ids: [staged.material_id],
      }),
    ).rejects.toMatchObject({ code: "file.parse_failed" });
    expect(web_files.read_staged_material(staged.material_id).path).toBe(staged.path);
  });

  it("工程创建不传材料时桌面载荷原样转交", async () => {
    const fixture = create_route_fixture({ webFiles: null });
    const request = { path: "/data/out.lg", source_paths: ["/data/source.txt"] };

    await read_post_handler(fixture.post_json, "/api/session/project/create")(request);

    expect(fixture.create_project_commit).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("工作台导入把暂存材料追加为文件命令，提交成功后释放", async () => {
    const fixture = create_route_fixture();
    const staged = await web_files.stage_upload(
      "www/data/escape name.txt",
      create_upload_body("正文"),
      new AbortController().signal,
    );
    fixture.import_files.mockResolvedValue({ accepted: true });

    await read_post_handler(
      fixture.post_json,
      "/api/workbench/files/import",
    )({
      files: [{ source_path: "/data/a.txt", target_rel_path: "a.txt" }],
      materials: [{ material_id: staged.material_id }],
      conflict_action: "skip",
    });

    const request = fixture.import_files.mock.calls[0]?.[0] as JsonRecord;
    expect(request["files"]).toEqual([
      { source_path: "/data/a.txt", target_rel_path: "a.txt" },
      { source_path: staged.path, target_rel_path: "www/data/escape_name.txt" },
    ]);
    expect(fs.existsSync(staged.path)).toBe(false);
  });

  it("工作台预览把暂存材料解析为源路径", async () => {
    const fixture = create_route_fixture();
    const staged = await web_files.stage_upload(
      "novel.txt",
      create_upload_body("正文"),
      new AbortController().signal,
    );
    fixture.preview_import_files.mockResolvedValue({ files_revision: 3, files: [] });

    await read_post_handler(
      fixture.post_json,
      "/api/workbench/files/preview",
    )({
      source_paths: ["/data/a.txt"],
      materials: [{ material_id: staged.material_id }],
    });

    expect(fixture.preview_import_files).toHaveBeenCalledWith({
      source_paths: ["/data/a.txt", staged.path],
      materials: [{ material_id: staged.material_id }],
    });
  });

  it("质量规则导入把材料身份提升为暂存路径", async () => {
    const fixture = create_route_fixture();
    const staged = await web_files.stage_upload(
      "rules.json",
      create_upload_body("[]"),
      new AbortController().signal,
    );
    fixture.import_rules.mockResolvedValue({ entries: [] });

    await read_post_handler(
      fixture.post_json,
      "/api/quality/rules/import",
    )({
      rule_type: "glossary",
      material_id: staged.material_id,
    });

    expect(fixture.import_rules).toHaveBeenCalledWith({
      rule_type: "glossary",
      path: staged.path,
    });
  });

  it("质量规则导出材料模式把输出登记为暂存材料并清理一次性目录", async () => {
    const fixture = create_route_fixture();
    fixture.export_rules.mockImplementation(async (request: JsonRecord) => {
      const base_path = String(request["path"]);
      fs.mkdirSync(path.dirname(base_path), { recursive: true });
      fs.writeFileSync(`${base_path}.json`, "[]");
      fs.writeFileSync(`${base_path}.xlsx`, "xlsx");
      return { path: `${base_path}.json` };
    });

    const response = read_snapshot_record(
      await read_post_handler(
        fixture.post_json,
        "/api/quality/rules/export",
      )({
        rule_type: "glossary",
        path: "/ignored/path.json",
        entries: [],
        material: true,
      }),
    );

    const request = fixture.export_rules.mock.calls[0]?.[0] as JsonRecord;
    expect(request["material"]).toBeUndefined();
    expect(String(request["path"]).startsWith(path.join(staging_root, ".export-"))).toBe(true);
    expect(response["path"]).toBe(`${String(request["path"])}.json`);
    expect(response["material"]).toMatchObject({ name: "quality-rules.json", size: 2 });
    const material = response["material"] as unknown as JsonRecord;
    expect(web_files.read_staged_material(String(material["material_id"])).name).toBe(
      "quality-rules.json",
    );
    expect(fs.readdirSync(staging_root).some((name) => name.startsWith(".export-"))).toBe(false);
  });

  it("质量规则导出不请求材料时桌面行为不变", async () => {
    const fixture = create_route_fixture();
    fixture.export_rules.mockResolvedValue({ path: "/data/rules.json" });

    const response = read_snapshot_record(
      await read_post_handler(
        fixture.post_json,
        "/api/quality/rules/export",
      )({
        rule_type: "glossary",
        path: "/data/rules",
        entries: [],
      }),
    );

    expect(response).toEqual({ path: "/data/rules.json" });
    expect(fixture.export_rules).toHaveBeenCalledWith({
      rule_type: "glossary",
      path: "/data/rules",
      entries: [],
    });
  });

  it("提示词导出材料模式登记暂存材料", async () => {
    const fixture = create_route_fixture();
    fixture.export_prompt.mockImplementation(async (request: JsonRecord) => {
      const output_path = String(request["path"]);
      fs.mkdirSync(path.dirname(output_path), { recursive: true });
      fs.writeFileSync(output_path, "prompt");
      return { path: output_path };
    });

    const response = read_snapshot_record(
      await read_post_handler(
        fixture.post_json,
        "/api/quality/prompts/export",
      )({
        material: true,
      }),
    );

    expect(response["material"]).toMatchObject({ name: "translation-prompt.txt", size: 6 });
  });

  it("译文下载路由把路径转交生成服务并返回受控下载响应头", () => {
    const fixture = create_route_fixture();
    const output_path = "/data/demo_译文/script.txt";
    fixture.open_download.mockReturnValue({
      name: "script.txt",
      size: 5,
      stream: Readable.from(Buffer.from("正文")),
    });

    const response = read_request_handler(
      fixture.get,
      "/api/translation/files/download",
    )(
      new Request(
        `http://127.0.0.1/api/translation/files/download?path=${encodeURIComponent(output_path)}`,
      ),
    ) as Response;

    expect(fixture.open_download).toHaveBeenCalledWith(output_path);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''script.txt",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("译文下载缺少路径参数按请求参数错误拒绝", () => {
    const fixture = create_route_fixture();

    expect(() =>
      read_request_handler(
        fixture.get,
        "/api/translation/files/download",
      )(new Request("http://127.0.0.1/api/translation/files/download")),
    ).toThrow(AppError);
    expect(fixture.open_download).not.toHaveBeenCalled();
  });

  it("工程副本路由转交副本服务并返回副本身份", async () => {
    const fixture = create_route_fixture();
    const copy = { path: "/data/project-copies/demo_副本_1.lg", name: "demo_副本_1.lg", size: 24 };
    fixture.copy_project.mockResolvedValue(copy);

    await expect(
      read_post_handler(fixture.post_json, "/api/session/project/copy")({}),
    ).resolves.toEqual(copy);
    expect(fixture.copy_project).toHaveBeenCalledTimes(1);
  });
});

/** 每个行为独立注册一次，避免跨测试共享 mock 调用历史。 */
function create_route_fixture(options: { webFiles?: WebFileService | null } = {}) {
  const catalog_snapshot = { instance_id: "catalog", started_at: 100, revision: 1 };
  const get = vi.fn();
  const post_json = vi.fn();
  const start_task = vi.fn(() => ({ accepted: true }));
  const acknowledgement = { revision: 7 };
  const input_command = vi.fn(async () => acknowledgement);
  const input_command_status = vi.fn(() => acknowledgement);
  const resolve_question = vi.fn(() => acknowledgement);
  const resolve_write_approval = vi.fn(() => acknowledgement);
  const update_queued_message = vi.fn(() => acknowledgement);
  const delete_queued_message = vi.fn(() => acknowledgement);
  const reorder_queued_messages = vi.fn(() => acknowledgement);
  const compact_context = vi.fn(async () => acknowledgement);
  const stop = vi.fn(() => acknowledgement);
  const reset = vi.fn(async () => acknowledgement);
  const update_settings = vi.fn((request: JsonRecord) => ({ settings: request }));
  const select_model = vi.fn((request: JsonRecord) => ({ selected: request }));
  const copy_model = vi.fn();
  const source_file_summary = { source_file_count: 1, format_hit_counts: { txt: 1 } };
  const summarize_source_files = vi.fn(() => source_file_summary);
  const create_project_commit = vi.fn();
  const copy_project = vi.fn();
  const import_files = vi.fn();
  const preview_import_files = vi.fn();
  const import_rules = vi.fn();
  const export_rules = vi.fn();
  const read_import_text = vi.fn();
  const export_prompt = vi.fn();
  const generate_files = vi.fn();
  const open_download = vi.fn();
  const agent = {
    get_snapshot: vi.fn(() => ({
      revision: 0,
      state: "idle",
      pendingDecision: null,
      entries: [],
      skills: [],
      inputQueue: { paused: false, canSendNow: false, items: [] },
      doing: null,
      context: { tokens: null, compactable: false, limits: null },
    })),
    input_command,
    input_command_status,
    resolve_question,
    resolve_write_approval,
    update_queued_message,
    delete_queued_message,
    reorder_queued_messages,
    compact_context,
    stop,
    reset,
  } as unknown as AgentService;
  const services = {
    modelCatalog: { get_snapshot: () => catalog_snapshot },
    app: { metadata: {}, settings: {}, updateSettings: update_settings, paths },
    project: {
      lifecycle: { summarize_source_files, create_project_commit, copy_project },
      summary: {},
      content: { import_files, preview_import_files },
      copy: { copy_project },
    },
    proofreading: { query: {}, commands: {} },
    quality: {
      statistics: {},
      rules: { import_rules, export_rules },
      prompts: { read_import_text, export: export_prompt },
    },
    files: { preview: {}, translationGeneration: { generate_files, open_download } },
    model: {
      get_selection_snapshot: vi.fn(() => ({
        model_selection: { translation: "a", agent: "c" },
        models: [],
      })),
      select_model,
      copy_model,
    },
    batchTranslation: { start: start_task },
    runtime: {
      getSnapshot: vi.fn(() => ({ runtime: { revision: 0, owner: null } })),
    },
  } as unknown as BackendServices;

  register_api_routes({
    app: { get } as unknown as Hono,
    services,
    agent,
    personality: { read: vi.fn(), save: vi.fn() },
    skills: {
      delete: vi.fn(),
      snapshot: vi.fn(),
      set_enabled: vi.fn(),
      tree: vi.fn(),
      read_file: vi.fn(),
      save_file: vi.fn(),
      change_file: vi.fn(),
      reorder: vi.fn(),
    },
    postJson: post_json,
    request: (method, route, handler) =>
      method === "GET" ? get(route, handler) : post_json(route, handler),
    createEventStreamResponse: vi.fn(),
    establishWebSession: vi.fn(),
    readWebBootstrap: vi.fn(() => ({})),
    webFiles: options.webFiles === undefined ? web_files : options.webFiles,
    agentSavePathHost: null,
    readLogFiles: vi.fn(),
    readLogPage: vi.fn(),
    readLogDetail: vi.fn(),
    recordRendererError: vi.fn(),
  });
  return {
    catalog_snapshot,
    get,
    post_json,
    compact_context,
    copy_project,
    create_project_commit,
    delete_queued_message,
    export_prompt,
    export_rules,
    generate_files,
    import_files,
    import_rules,
    open_download,
    preview_import_files,
    reset,
    input_command,
    input_command_status,
    resolve_question,
    resolve_write_approval,
    reorder_queued_messages,
    update_queued_message,
    source_file_summary,
    summarize_source_files,
    start_task,
    stop,
    update_settings,
    select_model,
    copy_model,
  };
}

/** 读取已注册 GET handler，缺失路径立即给出可定位错误。 */
function read_get_handler(
  get: ReturnType<typeof vi.fn>,
  route_path: string,
): (context: { json: (value: unknown) => unknown }) => unknown {
  const handler = get.mock.calls.find(([candidate]) => candidate === route_path)?.[1];
  if (typeof handler !== "function") throw new Error(`GET 路由未注册：${route_path}`);
  return handler;
}

/** 读取已注册的字节流 GET handler，按原始 Request 调用以覆盖查询参数分支。 */
function read_request_handler(
  get: ReturnType<typeof vi.fn>,
  route_path: string,
): (request: Request) => Response {
  const handler = get.mock.calls.find(([candidate]) => candidate === route_path)?.[1];
  if (typeof handler !== "function") throw new Error(`GET 路由未注册：${route_path}`);
  return handler as (request: Request) => Response;
}

/** 读取已注册 POST handler，缺失路径立即给出可定位错误。 */
function read_post_handler(
  post_json: ReturnType<typeof vi.fn>,
  route_path: string,
): ApiJsonHandler {
  const handler = post_json.mock.calls.find(([candidate]) => candidate === route_path)?.[1];
  if (typeof handler !== "function") throw new Error(`POST 路由未注册：${route_path}`);
  return handler as ApiJsonHandler;
}
