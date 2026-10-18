import { TranslationProgressAccumulator } from "./core/progress-accumulator";
import crypto from "node:crypto";
import {
  normalize_batch_translation_progress,
  type BatchTranslationProgress,
  type BatchTranslationRequestState,
  type BatchTranslationStopSource,
  type BatchTranslationSource,
  type BatchTranslationResult,
  type BatchTranslationOperation,
  type BatchTranslationSnapshot,
  type BatchTranslationSnapshotListener,
} from "../../domain/batch-translation";
import type { ProjectDatabase } from "../database/database-operations";
import type { ProjectSessionState } from "../project/project-session-state";
import type { RuntimeLease, RuntimeOperationGate } from "../runtime-operation-gate";
import type { BatchTranslationConfig } from "../../domain/batch-translation";
import { AppError } from "../../shared/error";

/** 已开始或已停止的运行失败同时携带终态统计与原始异常，供调用方落实用户意图并判断下一次请求。 */
export class BatchTranslationCompletionError extends Error {
  /** 将终态与原始失败绑定到同一完成链。 */
  public constructor(
    public readonly result: BatchTranslationResult,
    cause: unknown,
  ) {
    super("Batch translation failed.", { cause });
    this.name = "BatchTranslationCompletionError";
  }
}

export const BATCH_TRANSLATION_REQUEST_STATE_PUBLISH_INTERVAL_MS = 500;
export type BatchTranslationRunHandle = Readonly<{
  run_id: string;
  signal: AbortSignal;
  completion: Promise<BatchTranslationResult>;
}>;

/** 崩溃恢复线索的 meta 键：running 表示上次运行没有走到终态收尾。 */
const TRANSLATION_RUN_STATE_META_KEY = "translation_run_state";
/** 命令账本只服务进程寿命内的重复提交，按受理顺序淘汰最旧终态。 */
export const COMMAND_RESULT_LIMIT = 64;

/** 持久化运行标记，终态收尾后复位，避免下次启动把已完成工程误判为中断。 */
type TranslationRunStateMeta =
  | { status: "running"; operation: BatchTranslationOperation; started_at: number }
  | { status: "idle"; finished_at: number };

/** 读取运行标记：只认完整 running 形状，idle 与坏值都不产生恢复提示。 */
function normalize_translation_run_state(
  value: unknown,
): Extract<TranslationRunStateMeta, { status: "running" }> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const operation = record["operation"];
  const started_at = record["started_at"];
  if (
    record["status"] === "running" &&
    (operation === "translate" || operation === "retranslate") &&
    typeof started_at === "number" &&
    Number.isFinite(started_at)
  )
    return { status: "running", operation, started_at };
  return null;
}

type ActiveRun = {
  handle: BatchTranslationRunHandle;
  controller: AbortController;
  lease: RuntimeLease | null;
  detach_parent: () => void;
  previous: BatchTranslationSnapshot;
  ready: Promise<void>;
  attached: boolean;
  command_id?: string; // 公开受理命令身份，只属于本次预约
  run_state_write: Promise<void>; // 本次运行标记写入，终态收尾前等待它完成
  stop_source?: BatchTranslationStopSource; // 首次取消决定来源，属于当前 run
  resolve: (result: BatchTranslationResult) => void;
  reject: (error: unknown) => void;
};

/** 活动翻译、父取消和唯一完成链的拥有者；Agent lease 由 Agent round 释放。 */
export class BatchTranslationRuntime {
  private snapshot: BatchTranslationSnapshot = {
    revision: 0,
    status: "idle",
    source: null,
    request_in_flight_count: 0,
    request_recovery: null,
    progress: normalize_batch_translation_progress({}),
    pending_item_ids: [],
  };
  private active_run: ActiveRun | null = null;
  private disposed = false;
  private readonly listeners = new Set<BatchTranslationSnapshotListener>();
  private readonly completions = new Set<Promise<BatchTranslationResult>>();
  private request_state_timer: ReturnType<typeof setTimeout> | null = null;
  private request_state_flush: Promise<void> = Promise.resolve();
  private readonly publication_errors: unknown[] = [];
  /** 在途命令身份，预约期间阻止同一命令重复新建运行。 */
  private readonly in_flight_commands = new Set<string>();
  /** 已终结命令的终态快照，重复提交只回放结果，容量满时淘汰最旧。 */
  private readonly command_results = new Map<string, BatchTranslationSnapshot>();
  private readonly unsubscribe_session: () => void;

  /** 绑定工程世代切换，清空上一工程的运行展示。 */
  public constructor(
    private readonly session_state: ProjectSessionState,
    private readonly database: ProjectDatabase,
    private readonly runtime_gate: RuntimeOperationGate,
  ) {
    this.unsubscribe_session = session_state.subscribe_change(async (change) => {
      if (this.disposed) return;
      if (this.active_run !== null) throw new AppError("runtime.internal_invariant");
      this.snapshot = {
        ...this.snapshot,
        status: "idle",
        source: null,
        config: undefined,
        operation: undefined,
        run_progress: undefined,
        stop_source: undefined,
        pending_item_ids: [],
        request_in_flight_count: 0,
        request_recovery: null,
      };
      await this.publish_snapshot();
      // 命令身份与终态账本归属上一工程世代，切换后重复提交去重重新开始。
      this.command_results.clear();
      this.in_flight_commands.clear();
      // 新加载工程核对一次崩溃线索，中断提示不随每次快照查询重复出现。
      if (change.loaded) await this.restore_interrupted_run();
    });
  }
  /** 注册快照消费者；返回本次订阅的释放入口。 */
  public subscribe(listener: BatchTranslationSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** 累计进度始终读取当前工程已提交的 meta。 */
  public async read_progress(): Promise<BatchTranslationProgress> {
    const state = this.session_state.snapshot();
    return normalize_batch_translation_progress(
      state.loaded && state.projectPath !== ""
        ? (await this.database.get_all_meta(state.projectPath))["translation_extras"]
        : {},
    );
  }
  /** 本轮计数只在成功提交后推进，供异常收尾恢复已完成结果。 */
  public read_run_progress(): BatchTranslationProgress | undefined {
    return this.snapshot.run_progress === undefined ? undefined : { ...this.snapshot.run_progress };
  }
  /** 在异步读取累计进度前固定运行快照，目标与本轮计数来自同一版本。 */
  public async build_snapshot(): Promise<BatchTranslationSnapshot> {
    return { ...this.clone_snapshot(this.snapshot), progress: await this.read_progress() };
  }
  /** 快照离开运行态前隔离数组与可选对象引用，避免调用方共享内部结构。 */
  private clone_snapshot(snapshot: BatchTranslationSnapshot): BatchTranslationSnapshot {
    return {
      ...snapshot,
      run_progress: snapshot.run_progress === undefined ? undefined : { ...snapshot.run_progress },
      ...(snapshot.config === undefined ? {} : { config: { ...snapshot.config } }),
      pending_item_ids: [...snapshot.pending_item_ids],
    };
  }
  /** 独立运行原子取得全局 lease 后预约翻译。 */
  public begin_standalone(
    operation: BatchTranslationOperation = "translate",
    command_id?: string,
  ): BatchTranslationRunHandle {
    this.assert_available();
    return this.reserve(
      "standalone",
      this.runtime_gate.begin_runtime("batch_translation"),
      operation,
      undefined,
      command_id,
    );
  }
  /** 复用当前 Agent lease，并连接工具的父取消信号。 */
  public begin_under_agent(
    lease: RuntimeLease,
    signal: AbortSignal,
    operation: BatchTranslationOperation = "translate",
  ): BatchTranslationRunHandle {
    this.assert_available();
    this.runtime_gate.assert_current_runtime(lease, "agent");
    return this.reserve("agent", null, operation, signal);
  }
  /** 预约前检查关闭状态与单 run 互斥。 */
  private assert_available(): void {
    if (this.disposed) throw new AppError("runtime.disposed");
    if (this.active_run !== null) throw new AppError("runtime.busy");
  }
  /** 同步登记运行句柄和完成链，随后发布受理快照。 */
  private reserve(
    source: BatchTranslationSource,
    lease: RuntimeLease | null,
    operation: BatchTranslationOperation,
    parent?: AbortSignal,
    command_id?: string,
  ): BatchTranslationRunHandle {
    const controller = new AbortController();
    let resolve!: (result: BatchTranslationResult) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<BatchTranslationResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const handle = Object.freeze({
      run_id: crypto.randomUUID(),
      signal: controller.signal,
      completion,
    });
    // 父信号只取消本轮翻译，取消来源由 cancel_run 首次登记。
    const abort = () => this.cancel_run(run, "parent");
    const run: ActiveRun = {
      handle,
      controller,
      lease,
      resolve,
      reject,
      previous: this.snapshot,
      detach_parent: () => parent?.removeEventListener("abort", abort),
      ready: Promise.resolve(),
      run_state_write: Promise.resolve(),
      attached: false,
      ...(command_id === undefined ? {} : { command_id }),
    };
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    // 命令身份先登记在途，受理查询与重复提交都以此为准。
    if (command_id !== undefined) this.in_flight_commands.add(command_id);
    this.active_run = run;
    this.completions.add(completion);
    // 首次异步发布前登记 completion，dispose 与同步停止均覆盖预约阶段。
    void completion.then(
      () => this.completions.delete(completion),
      () => this.completions.delete(completion),
    );
    this.snapshot = {
      ...this.snapshot,
      status: "requested",
      source,
      config: undefined,
      operation,
      run_progress: undefined,
      stop_source: run.stop_source,
      pending_item_ids: [],
      request_in_flight_count: 0,
      request_recovery: null,
    };
    // 运行标记与受理快照并行落库，发布链保持原有时序；完成链在终态前等待本次写入。
    run.run_state_write = this.write_run_state_meta({
      status: "running",
      operation,
      started_at: Date.now(),
    });
    run.ready = this.publish_snapshot().then(() => undefined);
    void run.ready.catch(() => undefined); // 原始拒绝由 execute 的完成链消费。
    return handle;
  }
  /** 按命令身份查询受理事实：在途返回当前快照，终态返回留存结果，未受理返回 null。 */
  public find_command(
    command_id: string,
  ): { in_flight: boolean; snapshot: BatchTranslationSnapshot } | null {
    if (this.in_flight_commands.has(command_id))
      return { in_flight: true, snapshot: this.clone_snapshot(this.snapshot) };
    const stored = this.command_results.get(command_id);
    return stored === undefined
      ? null
      : { in_flight: false, snapshot: this.clone_snapshot(stored) };
  }
  /** 终态快照按命令身份留存，重复提交回放结果而不新建运行。 */
  private remember_command_result(command_id: string, snapshot: BatchTranslationSnapshot): void {
    this.command_results.delete(command_id); // 重新受理同一命令时刷新留存顺序
    this.command_results.set(command_id, snapshot);
    while (this.command_results.size > COMMAND_RESULT_LIMIT) {
      const oldest = this.command_results.keys().next();
      if (oldest.done !== true) this.command_results.delete(oldest.value);
    }
  }
  /** 配置由 Runner 从执行快照投影，并归属于当前 run。 */
  public async publish_config(
    handle: BatchTranslationRunHandle,
    config: BatchTranslationConfig,
  ): Promise<void> {
    if (!this.is_current(handle.run_id)) return;
    this.snapshot = { ...this.snapshot, config: Object.freeze({ ...config }) };
    await this.publish_snapshot();
  }

  /** 同步接管预约；运行结果和收尾始终通过 handle.completion 读取。 */
  public async execute(
    handle: BatchTranslationRunHandle,
    runner: () => Promise<BatchTranslationResult>,
  ): Promise<void> {
    const run = this.active_run;
    if (run?.handle !== handle || run.attached) throw new AppError("runtime.internal_invariant");
    run.attached = true;
    void this.complete_run(run, runner);
    try {
      await run.ready;
    } catch {
      await handle.completion;
    }
  }
  /** 等待执行与快照发布收束，释放自有 lease 后结算唯一 completion。 */
  private async complete_run(
    run: ActiveRun,
    runner: () => Promise<BatchTranslationResult>,
  ): Promise<void> {
    const errors: unknown[] = [];
    let started = false;
    let result: BatchTranslationResult | undefined;
    try {
      await run.ready;
      started = true;
      const output = await runner();
      result = Object.freeze({
        status: output.status,
        ...(output.run_progress === undefined
          ? {}
          : { run_progress: Object.freeze({ ...output.run_progress }) }),
        progress: Object.freeze({ ...output.progress }),
      });
    } catch (error) {
      errors.push(error);
    }
    try {
      if (this.request_state_timer !== null) {
        this.clear_request_state_timer();
        try {
          await this.publish_snapshot();
        } catch (error) {
          errors.push(error);
        }
      }
      await this.request_state_flush;
      errors.push(...this.publication_errors.splice(0));
      if (!started) {
        this.snapshot = { ...run.previous, revision: this.snapshot.revision };
        await this.publish_snapshot();
      } else {
        const run_progress = result?.run_progress ?? this.read_run_progress();
        if (result === undefined) {
          // 进度读取失败仍走统一终态收尾，原始错误保留在完成链。
          const progress = await this.read_progress().catch((error: unknown) => {
            errors.push(error);
            return this.snapshot.progress;
          });
          result = Object.freeze({
            status: "error",
            progress: Object.freeze({ ...progress }),
            ...(run_progress === undefined ? {} : { run_progress }),
          });
        }
        // 最后一次异步收尾后冻结结果；此刻之前受理的停止都属于本轮。
        result = Object.freeze({
          ...result,
          ...(run_progress === undefined ? {} : { run_progress }),
          status:
            result.status === "error"
              ? "error"
              : run.stop_source === undefined
                ? result.status
                : "stopped",
          ...(run.stop_source === undefined ? {} : { stop_source: run.stop_source }),
        });
        this.snapshot = {
          ...this.snapshot,
          status: result.status,
          stop_source: run.stop_source,
          request_in_flight_count: 0,
          request_recovery: null,
          pending_item_ids: [],
          progress: { ...result.progress },
          run_progress: result.run_progress === undefined ? undefined : { ...result.run_progress },
        };
        const published = await this.publish_snapshot(result.progress);
        // 终态事实按命令身份留存，重复提交回放这一快照而不新建运行。
        if (run.command_id !== undefined) this.remember_command_result(run.command_id, published);
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.active_run = null;
      // 在途登记终态才移除；预约失败同样移除，避免该命令再也无法受理。
      if (run.command_id !== undefined) this.in_flight_commands.delete(run.command_id);
      // 先等待本次运行标记落库再写 idle 复位，避免快速运行把终态标记回写成 running。
      await run.run_state_write;
      await this.write_run_state_meta({ status: "idle", finished_at: Date.now() });
      run.detach_parent();
      try {
        if (run.lease !== null) this.runtime_gate.finish_runtime(run.lease);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      const run_progress = result?.run_progress ?? this.read_run_progress();
      const cause =
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, "Batch translation completion failed.", {
              cause: errors[0],
            });
      // 预约失败且无人停止时没有本轮事实，原始异常直接交给启动方。
      run.reject(
        started || run.stop_source !== undefined
          ? new BatchTranslationCompletionError(
              Object.freeze({
                status: "error",
                ...(run.stop_source === undefined ? {} : { stop_source: run.stop_source }),
                // 预约尚未执行时沿用前置进度，停止事实仍随完成链返回。
                progress: result?.progress ?? Object.freeze({ ...run.previous.progress }),
                ...(run_progress === undefined ? {} : { run_progress }),
              }),
              cause,
            )
          : cause,
      );
    } else if (result !== undefined) run.resolve(result);
    else run.reject(new AppError("runtime.internal_invariant"));
  }
  /** 按 run 身份拦截迟到的提交与进度。 */
  public is_current(run_id: string): boolean {
    return this.active_run?.handle.run_id === run_id;
  }
  /** 取消优先于 running，发布失败进入完成链。 */
  public async publish_status(
    handle: BatchTranslationRunHandle,
    status: "running" | "stopping",
  ): Promise<void> {
    if (!this.is_current(handle.run_id)) return;
    this.snapshot = {
      ...this.snapshot,
      status: handle.signal.aborted ? "stopping" : status,
      stop_source: this.active_run?.stop_source,
    };
    try {
      await this.publish_snapshot();
    } catch (error) {
      this.publication_errors.push(error);
      throw error;
    }
  }
  /** 只取消仍活跃的 run，终态发布期间保留收尾链。 */
  public async request_stop(): Promise<boolean> {
    const run = this.active_run;
    if (run === null || !["requested", "running", "stopping"].includes(this.snapshot.status))
      return false;
    if (run.stop_source !== undefined) return false;
    this.cancel_run(run, "user");
    await this.publish_status(run.handle, "stopping");
    return true;
  }
  /** 取消来源先于信号冻结，父取消和重复请求共同遵循首次受理语义。 */
  private cancel_run(run: ActiveRun, source: BatchTranslationStopSource): void {
    if (run.stop_source !== undefined) return;
    run.stop_source = source;
    this.snapshot = { ...this.snapshot, request_recovery: null };
    run.controller.abort();
  }
  /** 实际目标与本轮总量一次发布，预约条件不进入运行快照。 */
  public async publish_targets(
    handle: BatchTranslationRunHandle,
    target_ids: ReadonlySet<number>,
  ): Promise<BatchTranslationProgress> {
    const run_progress = TranslationProgressAccumulator.empty(target_ids.size);
    if (!this.is_current(handle.run_id)) return run_progress;
    this.snapshot = { ...this.snapshot, pending_item_ids: [...target_ids], run_progress };
    try {
      await this.publish_snapshot();
    } catch (error) {
      this.publication_errors.push(error);
      throw error;
    }
    return { ...run_progress };
  }
  /** 已提交结果退出待处理范围，同值结果也完成本轮尝试。 */
  public async publish_progress(
    handle: BatchTranslationRunHandle,
    committed_ids: number[] = [],
    run_progress?: BatchTranslationProgress,
  ): Promise<void> {
    if (!this.is_current(handle.run_id)) return;
    this.clear_request_state_timer();
    const done = new Set(committed_ids);
    this.snapshot = {
      ...this.snapshot,
      ...(run_progress === undefined ? {} : { run_progress: { ...run_progress } }),
      pending_item_ids: this.snapshot.pending_item_ids.filter((id) => !done.has(id)),
    };
    try {
      await this.publish_snapshot();
    } catch (error) {
      this.publication_errors.push(error);
      throw error;
    }
  }
  /** 请求数与恢复阶段来自同一次调度，复用一个窗口发布；取消后拒绝重新挂起恢复提示。 */
  public update_request_state(
    handle: BatchTranslationRunHandle,
    state: BatchTranslationRequestState,
  ): void {
    if (!this.is_current(handle.run_id)) return;
    this.snapshot = {
      ...this.snapshot,
      request_in_flight_count: state.request_in_flight_count,
      request_recovery:
        handle.signal.aborted || state.request_recovery === null
          ? null
          : Object.freeze({ ...state.request_recovery }),
    };
    if (this.request_state_timer !== null) return;
    this.request_state_timer = setTimeout(() => {
      this.request_state_timer = null;
      this.request_state_flush = this.request_state_flush
        .then(async () => {
          if (this.is_current(handle.run_id)) await this.publish_snapshot();
        })
        .catch((error) => {
          this.publication_errors.push(error);
        });
    }, BATCH_TRANSLATION_REQUEST_STATE_PUBLISH_INTERVAL_MS);
  }
  /** 撤销待发布窗口，终态收尾负责冲刷计数。 */
  private clear_request_state_timer(): void {
    if (this.request_state_timer !== null) clearTimeout(this.request_state_timer);
    this.request_state_timer = null;
  }
  /** 推进 revision 并等待全部消费者，汇总发布异常；返回本次发布的快照供命令账本留存。 */
  private async publish_snapshot(
    progress?: Readonly<BatchTranslationProgress>,
  ): Promise<BatchTranslationSnapshot> {
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    const snapshot =
      progress === undefined
        ? await this.build_snapshot()
        : {
            ...this.snapshot,
            progress: { ...progress },
            run_progress: this.read_run_progress(),
            pending_item_ids: [...this.snapshot.pending_item_ids],
          };
    const results = await Promise.allSettled(
      [...this.listeners].map(async (listener) => {
        await listener(snapshot);
      }),
    );
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    if (errors.length > 0)
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Batch translation snapshot publication failed.");
    return snapshot;
  }
  /**
   * 崩溃恢复：上次运行未走终态收尾时，把当前工程快照标记为中断并清除线索。
   * 恢复线索只是提示来源，读取与发布失败都保持当前快照，不阻塞工程加载。
   */
  public async restore_interrupted_run(): Promise<void> {
    if (this.disposed || this.active_run !== null) return;
    const session = this.session_state.snapshot();
    if (!session.loaded || session.projectPath === "") return;
    const state = await this.database
      .get_all_meta(session.projectPath)
      .then((meta) => normalize_translation_run_state(meta[TRANSLATION_RUN_STATE_META_KEY]))
      .catch(() => null);
    if (state === null) return;
    this.snapshot = {
      ...this.snapshot,
      status: "interrupted",
      operation: state.operation,
      run_progress: undefined,
      stop_source: undefined,
      pending_item_ids: [],
      request_in_flight_count: 0,
      request_recovery: null,
    };
    await this.publish_snapshot().catch(() => undefined);
    // 恢复期间已有新运行受理时保留其运行标记，只放弃本次过期提示。
    if (this.active_run !== null) return;
    await this.write_run_state_meta({ status: "idle", finished_at: Date.now() });
  }
  /** 运行标记写入当前工程 meta；失败只丢失崩溃提示，不影响受理、执行与终态。 */
  private async write_run_state_meta(state: TranslationRunStateMeta): Promise<void> {
    const session = this.session_state.snapshot();
    if (!session.loaded || session.projectPath === "") return;
    try {
      await this.database.transaction(session.projectPath, (writer) =>
        writer.set_meta(session.projectPath, TRANSLATION_RUN_STATE_META_KEY, { ...state }),
      );
    } catch {
      // 工程未加载或写入失败时没有可恢复线索，本次运行本身不受影响。
    }
  }
  /** 关闭受理并取消运行，等待预约与执行共享的完成链。 */
  public async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe_session();
    const run = this.active_run;
    if (run !== null) this.cancel_run(run, "shutdown");
    if (run !== null && !run.attached) {
      run.attached = true;
      void this.complete_run(run, async () => ({
        status: "stopped",
        progress: await this.read_progress(),
      }));
    }
    await Promise.allSettled(this.completions);
    this.clear_request_state_timer();
    this.listeners.clear();
  }
}
