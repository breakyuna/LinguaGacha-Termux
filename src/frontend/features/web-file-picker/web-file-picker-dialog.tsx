import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { ArrowUp, File, FolderOpen, FolderPlus, Upload } from "lucide-react";

import { useI18n, type LocaleKey } from "@frontend/app/locale/locale-context";
import { Spinner } from "@frontend/shadcn/spinner";
import { Input } from "@frontend/shadcn/input";
import { AppButton } from "@frontend/widgets/app-button";
import { AppPageDialog } from "@frontend/widgets/app-page-dialog";
import {
  join_web_path,
  list_web_file_directory,
  list_web_file_roots,
  release_web_file_material,
  upload_web_file,
  type WebDirectoryListing,
  type WebFileEntry,
  type WebFileRoot,
  type WebStagedMaterial,
} from "./web-file-picker-api";
import type { WebFilePickIntent, WebFilePickResult } from "./picker-request-bus";

type WebFilePickerDialogProps = {
  intent: WebFilePickIntent;
  on_settle: (result: WebFilePickResult) => void;
};

type WebFilePickerStatus = "loading" | "ready" | "failed";

/** 一次文件夹上传：批次目录等价于浏览选中的目录，材料身份由调用点在导入成功后释放。 */
type WebUploadBatch = {
  directory_name: string; // 暂存区内的一层批次目录名
  directory_path: string; // 批次目录绝对路径，进入 source_paths 后走既有目录导入流程
  material_ids: string[]; // 本次文件夹上传产生的暂存材料身份
};

const TITLE_KEY_BY_MODE: Record<WebFilePickIntent["mode"], LocaleKey> = {
  file: "app.web_files.title_file",
  directory: "app.web_files.title_directory",
  save: "app.web_files.title_save",
};

/** 保存名只取末段名称，路径分隔不参与拼接，避免输入穿越当前目录。 */
function read_save_file_name(raw_value: string): string {
  return (
    raw_value
      .split(/[\\/]+/u)
      .at(-1)
      ?.trim() ?? ""
  );
}

/** 批次目录名只含时间戳与随机后缀，落到暂存区时无需再清洗。 */
function create_upload_batch_name(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `batch-${timestamp}-${random}`;
}

/** 去掉末段路径，分隔符沿用服务端归一结果。 */
function strip_last_path_segment(target: string): string {
  const separator_index = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return separator_index > 0 ? target.slice(0, separator_index) : target;
}

/**
 * 反推批次目录绝对路径：后端按段清洗只改段内容，段数与上传时的相对路径一致，
 * 因此从暂存文件路径向前回溯相对路径的段数即可得到批次目录。
 */
function resolve_batch_directory_path(material_path: string, relative_path: string): string {
  let directory = material_path;
  for (let level = 0; level < relative_path.split("/").length; level += 1) {
    directory = strip_last_path_segment(directory);
  }
  return directory;
}

/** 读取文件夹内相对路径：首段是用户选择的文件夹本身，批次目录名由本流程生成。 */
function read_relative_upload_path(file: File): string {
  const segments = file.webkitRelativePath
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  // 浏览器未提供相对路径时退化为单层文件，批次目录结构此时为空。
  return segments.slice(1).join("/") || file.name;
}

/**
 * 浏览器文件选择器：允许根浏览、目录进入与上一级、多选与上传暂存、保存命名。
 * 界面状态随请求进入而重建，结果经总线回传给调用方。
 */
export function WebFilePickerDialog(props: WebFilePickerDialogProps): JSX.Element {
  const { t } = useI18n();
  const intent = props.intent;
  const is_file_mode = intent.mode === "file";
  const is_save_mode = intent.mode === "save";
  const allows_upload = is_file_mode && intent.allow_upload === true;

  const [roots, set_roots] = useState<WebFileRoot[]>([]);
  const [active_root_id, set_active_root_id] = useState("");
  const [path_segments, set_path_segments] = useState<string[]>([]);
  const [listing, set_listing] = useState<WebDirectoryListing | null>(null);
  const [status, set_status] = useState<WebFilePickerStatus>("loading");
  const [selected_entry_names, set_selected_entry_names] = useState<string[]>([]);
  const [uploaded_materials, set_uploaded_materials] = useState<WebStagedMaterial[]>([]);
  const [uploaded_batches, set_uploaded_batches] = useState<WebUploadBatch[]>([]);
  const [selected_material_ids, set_selected_material_ids] = useState<string[]>([]);
  const [selected_batch_names, set_selected_batch_names] = useState<string[]>([]);
  const [is_uploading, set_is_uploading] = useState(false);
  const [upload_failed, set_upload_failed] = useState(false);
  const [file_name, set_file_name] = useState(intent.default_name ?? "");
  const listing_generation_ref = useRef(0);
  const file_input_ref = useRef<HTMLInputElement>(null);
  const directory_input_ref = useRef<HTMLInputElement>(null);

  /** 读取根内目录；过期响应直接丢弃，避免快速导航串台。 */
  const load_listing = useCallback(async (root_id: string, segments: string[]): Promise<void> => {
    const generation = listing_generation_ref.current + 1;
    listing_generation_ref.current = generation;
    set_status("loading");
    try {
      const next_listing = await list_web_file_directory(root_id, segments.join("/"));
      if (generation !== listing_generation_ref.current) return;
      set_listing(next_listing);
      set_status("ready");
    } catch {
      if (generation !== listing_generation_ref.current) return;
      set_listing(null);
      set_status("failed");
    }
  }, []);

  // 允许根只在进入对话框时读取一次，切换目录不重复请求。
  useEffect(() => {
    let is_disposed = false;
    void list_web_file_roots()
      .then((loaded_roots) => {
        if (is_disposed) return;
        set_roots(loaded_roots);
        set_active_root_id(loaded_roots[0]?.id ?? "");
      })
      .catch(() => {
        if (is_disposed) return;
        set_roots([]);
        set_active_root_id("");
      });
    return () => {
      is_disposed = true;
    };
  }, []);

  useEffect(() => {
    if (active_root_id === "") return;
    void load_listing(active_root_id, path_segments);
  }, [active_root_id, path_segments, load_listing]);

  /** 切换根后回到根目录，旧目录的选择随之失效。 */
  function handle_select_root(root: WebFileRoot): void {
    if (root.id === active_root_id) return;
    set_active_root_id(root.id);
    set_path_segments([]);
    set_selected_entry_names([]);
  }

  /** 进入子目录；导航栈与响应 parent_path 共同决定上一级是否可用。 */
  function handle_enter_directory(entry_name: string): void {
    set_path_segments((previous_segments) => [...previous_segments, entry_name]);
    set_selected_entry_names([]);
  }

  function handle_go_up(): void {
    set_path_segments((previous_segments) => previous_segments.slice(0, -1));
    set_selected_entry_names([]);
  }

  function handle_toggle_entry(entry_name: string): void {
    set_selected_entry_names((previous_names) =>
      previous_names.includes(entry_name)
        ? previous_names.filter((name) => name !== entry_name)
        : [...previous_names, entry_name],
    );
  }

  function handle_toggle_material(material_id: string): void {
    set_selected_material_ids((previous_ids) =>
      previous_ids.includes(material_id)
        ? previous_ids.filter((id) => id !== material_id)
        : [...previous_ids, material_id],
    );
  }

  /** 批次目录整体参与选择，与浏览选中的目录一样只作为一个源路径。 */
  function handle_toggle_batch(directory_name: string): void {
    set_selected_batch_names((previous_names) =>
      previous_names.includes(directory_name)
        ? previous_names.filter((name) => name !== directory_name)
        : [...previous_names, directory_name],
    );
  }

  /** 串行上传：后端暂存命名本身串行，前台逐件提交即可保持顺序与反馈稳定。 */
  async function handle_upload_files(files: File[]): Promise<void> {
    if (files.length === 0) return;
    set_is_uploading(true);
    set_upload_failed(false);
    const staged_materials: WebStagedMaterial[] = [];
    let did_fail = false;
    for (const file of files) {
      const controller = new AbortController();
      try {
        staged_materials.push(await upload_web_file(file.name, file, controller.signal));
      } catch {
        did_fail = true;
      }
    }
    if (staged_materials.length > 0) {
      const staged_ids = staged_materials.map((material) => material.material_id);
      set_uploaded_materials((previous_materials) => [...previous_materials, ...staged_materials]);
      set_selected_material_ids((previous_ids) => [...previous_ids, ...staged_ids]);
    }
    set_upload_failed(did_fail);
    set_is_uploading(false);
  }

  /**
   * 文件夹上传：为本次选择生成批次目录，按 `webkitRelativePath` 保留相对结构串行提交；
   * 任一件失败即中断本次批次并释放已暂存文件，不留下半批目录供确认。
   */
  async function handle_upload_directory(files: File[]): Promise<void> {
    if (files.length === 0) return;
    set_is_uploading(true);
    set_upload_failed(false);
    const directory_name = create_upload_batch_name();
    const staged_files: { relative_path: string; material: WebStagedMaterial }[] = [];
    let did_fail = false;
    for (const file of files) {
      const relative_path = read_relative_upload_path(file);
      try {
        staged_files.push({
          relative_path,
          material: await upload_web_file(
            `${directory_name}/${relative_path}`,
            file,
            new AbortController().signal,
          ),
        });
      } catch {
        did_fail = true;
        break;
      }
    }
    if (did_fail) {
      await Promise.all(
        staged_files.map(({ material }) =>
          release_web_file_material(material.material_id).catch(() => undefined),
        ),
      );
      set_upload_failed(true);
      set_is_uploading(false);
      return;
    }
    const first_file = staged_files[0]!;
    set_uploaded_batches((previous_batches) => [
      ...previous_batches,
      {
        directory_name,
        directory_path: resolve_batch_directory_path(
          first_file.material.path,
          first_file.relative_path,
        ),
        material_ids: staged_files.map(({ material }) => material.material_id),
      },
    ]);
    set_selected_batch_names((previous_names) => [...previous_names, directory_name]);
    set_is_uploading(false);
  }

  const selected_entries: WebFileEntry[] = (listing?.entries ?? []).filter((entry) =>
    selected_entry_names.includes(entry.name),
  );
  const selected_materials = uploaded_materials.filter((material) =>
    selected_material_ids.includes(material.material_id),
  );
  const selected_batches = uploaded_batches.filter((batch) =>
    selected_batch_names.includes(batch.directory_name),
  );
  const selected_paths = [
    ...selected_entries.map((entry) => join_web_path(listing?.path ?? "", entry.name)),
    ...selected_materials.map((material) => material.path),
    ...selected_batches.map((batch) => batch.directory_path),
  ];
  const delivered_material_ids = [
    ...selected_materials.map((material) => material.material_id),
    ...selected_batches.flatMap((batch) => batch.material_ids),
  ];
  const save_file_name = read_save_file_name(file_name);
  const can_go_up = listing !== null && listing.parent_path !== null;
  const can_confirm = is_save_mode
    ? save_file_name !== ""
    : is_file_mode
      ? selected_paths.length > 0
      : listing !== null && status === "ready";

  function handle_confirm(): void {
    if (!can_confirm) return;
    if (is_save_mode) {
      release_undelivered_materials([]);
      props.on_settle({
        canceled: false,
        paths: [join_web_path(listing?.path ?? "", save_file_name)],
        material_ids: [],
      });
      return;
    }
    if (is_file_mode) {
      release_undelivered_materials(delivered_material_ids);
      props.on_settle({
        canceled: false,
        paths: selected_paths,
        material_ids: delivered_material_ids,
      });
      return;
    }
    release_undelivered_materials([]);
    props.on_settle({
      canceled: false,
      paths: listing === null ? [] : [listing.path],
      material_ids: [],
    });
  }

  function handle_cancel(): void {
    release_undelivered_materials([]);
    props.on_settle({ canceled: true, paths: [], material_ids: [] });
  }

  /** 结算时释放未被交付的暂存材料，避免取消或改选后长期占用暂存区。 */
  function release_undelivered_materials(released_material_ids: string[]): void {
    const delivered_ids = new Set(released_material_ids);
    const uploaded_ids = [
      ...uploaded_materials.map((material) => material.material_id),
      ...uploaded_batches.flatMap((batch) => batch.material_ids),
    ];
    for (const material_id of uploaded_ids) {
      if (delivered_ids.has(material_id)) continue;
      // 释放失败由后端保留时长清理，不影响本次选择结果。
      void release_web_file_material(material_id).catch(() => undefined);
    }
  }

  const entries = listing?.entries ?? [];
  const selected_labels = [
    ...selected_entries.map((entry) => entry.name),
    ...selected_materials.map((material) => material.name),
    ...selected_batches.map((batch) => batch.directory_name),
  ];

  return (
    <AppPageDialog
      open
      title={t(TITLE_KEY_BY_MODE[intent.mode])}
      size="md"
      onClose={handle_cancel}
      bodyClassName="gap-3"
      footer={
        <>
          <AppButton type="button" variant="outline" size="sm" onClick={handle_cancel}>
            {t("app.action.cancel")}
          </AppButton>
          <AppButton type="button" size="sm" disabled={!can_confirm} onClick={handle_confirm}>
            {t("app.web_files.confirm")}
          </AppButton>
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5" aria-label={t("app.web_files.roots")} role="group">
        {roots.map((root) => (
          <AppButton
            key={root.id}
            type="button"
            variant={root.id === active_root_id ? "default" : "outline"}
            size="xs"
            onClick={() => {
              handle_select_root(root);
            }}
          >
            {root.label}
          </AppButton>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <AppButton
          type="button"
          variant="outline"
          size="xs"
          disabled={!can_go_up}
          onClick={handle_go_up}
        >
          <ArrowUp data-icon="inline-start" />
          {t("app.web_files.up")}
        </AppButton>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {listing?.path ?? ""}
        </span>
      </div>

      <div className="max-h-[45vh] min-h-0 flex-1 overflow-auto rounded-lg border border-input/70">
        {status === "loading" ? (
          <p className="px-3 py-6 text-center text-muted-foreground">
            {t("app.web_files.loading")}
          </p>
        ) : status === "failed" ? (
          <p className="px-3 py-6 text-center text-muted-foreground">{t("app.web_files.failed")}</p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted-foreground">{t("app.web_files.empty")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {entries.map((entry) => (
              <li key={entry.name} className="flex items-center gap-2 px-3 py-2">
                {entry.kind === "directory" ? (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                      handle_enter_directory(entry.name);
                    }}
                  >
                    <FolderOpen className="size-4 shrink-0 stroke-[1.8]" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ) : is_file_mode ? (
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0"
                      checked={selected_entry_names.includes(entry.name)}
                      onChange={() => {
                        handle_toggle_entry(entry.name);
                      }}
                    />
                    <span className="truncate">{entry.name}</span>
                  </label>
                ) : (
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <File className="size-4 shrink-0 stroke-[1.8]" />
                    <span className="truncate">{entry.name}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {is_file_mode ? (
        <p className="truncate text-xs text-muted-foreground">
          {selected_labels.length === 0
            ? t("app.web_files.selected_empty")
            : selected_labels.join(" · ")}
        </p>
      ) : null}

      {is_save_mode ? (
        <label className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">{t("app.web_files.file_name")}</span>
          <Input
            value={file_name}
            onChange={(event) => {
              set_file_name(event.target.value);
            }}
          />
        </label>
      ) : null}

      {allows_upload ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <AppButton
              type="button"
              variant="outline"
              size="xs"
              disabled={is_uploading}
              onClick={() => {
                file_input_ref.current?.click();
              }}
            >
              {is_uploading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Upload data-icon="inline-start" />
              )}
              {is_uploading ? t("app.web_files.uploading") : t("app.web_files.upload")}
            </AppButton>
            <AppButton
              type="button"
              variant="outline"
              size="xs"
              disabled={is_uploading}
              onClick={() => {
                directory_input_ref.current?.click();
              }}
            >
              <FolderPlus data-icon="inline-start" />
              {t("app.web_files.upload_directory")}
            </AppButton>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t("app.web_files.upload_hint")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("app.web_files.upload_directory_hint")}
          </p>
          <input
            ref={file_input_ref}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked_files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void handle_upload_files(picked_files);
            }}
          />
          <input
            ref={(element) => {
              directory_input_ref.current = element;
              // 目录选择属性没有 React 类型声明，按原生 HTML 属性设置，浏览器只认属性存在。
              element?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked_files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void handle_upload_directory(picked_files);
            }}
          />
          {upload_failed ? (
            <p className="text-xs text-destructive">{t("app.web_files.upload_failed")}</p>
          ) : null}
          {uploaded_batches.length > 0 || uploaded_materials.length > 0 ? (
            <ul className="grid gap-1">
              {uploaded_batches.map((batch) => (
                <li key={batch.directory_name} className="flex items-center gap-2 px-1">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0"
                      checked={selected_batch_names.includes(batch.directory_name)}
                      onChange={() => {
                        handle_toggle_batch(batch.directory_name);
                      }}
                    />
                    <FolderOpen className="size-4 shrink-0 stroke-[1.8]" />
                    <span className="truncate">{batch.directory_name}</span>
                  </label>
                </li>
              ))}
              {uploaded_materials.map((material) => (
                <li key={material.material_id} className="flex items-center gap-2 px-1">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0"
                      checked={selected_material_ids.includes(material.material_id)}
                      onChange={() => {
                        handle_toggle_material(material.material_id);
                      }}
                    />
                    <span className="truncate">{material.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </AppPageDialog>
  );
}
