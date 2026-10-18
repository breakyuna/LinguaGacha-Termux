import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ChromiumBrowser,
  resolve_chromium_executable_path,
  type ChromiumPage,
  type ChromiumPageSource,
} from "./chromium-browser";
import { create_chromium_image_host } from "./chromium-image-host";
import { create_chromium_pdf_host } from "./chromium-pdf-host";
import type { AgentImageHostOperation } from "../shared/agent-image";

/**
 * Chromium 宿主的真实浏览器弹性证据。
 *
 * 录制页面单元测试覆盖阶段顺序、串行队列与假页面上的取消；本文件用真实 Chromium 进程
 * 证明同一契约在真实 CDP 通道上的三个边界：调用方取消、任务级超时与宿主进程崩溃。
 * 取消与超时必须命中真实工作途中，因此夹具使用软件编码成本高的合成图与多页文档。
 */

/** 合成图边长：软件 WebP 编码需要数秒，取消与超时才能在真实工作途中命中。 */
const PROBE_IMAGE_EDGE = 3000;

/** 任务级超时预算：必须小于一次真实编码 / 打印的耗时，否则用例会空转通过。 */
const IMAGE_TASK_TIMEOUT_MS = 400;
const PDF_TASK_TIMEOUT_MS = 1_200;

/**
 * 多页合成文档的页数：实测单页打印约 400ms、900 页约 3s，
 * 超时预算落在打印途中，而用例末尾的单页跟进打印有约 3 倍余量。
 */
const PRINT_PAGE_COUNT = 900;

/** 真实浏览器用例的统一超时：启动、编码与打印都由软件渲染的 Chromium 实际完成。 */
const CASE_TIMEOUT_MS = 120_000;
const FIXTURE_TIMEOUT_MS = 60_000;

const PRINT_FONT_FILES = [
  "LGBaseFont-Regular.woff2",
  "LGBaseFont-Bold.woff2",
  "MonaspaceNeon.woff2",
] as const;

/** 三个字体名共用一份可加载的小字体：字体能否加载决定 assets 阶段是否收敛，字形排版另有视觉验收。 */
const PRINT_FONT_SOURCE = fileURLToPath(
  new URL("../../public/fonts/MonaspaceNeon.woff2", import.meta.url),
);
/** 复用应用打印样式源文件，让多页文档走真实分页规则。 */
const PRINT_STYLES_SOURCE = fileURLToPath(
  new URL("../../src/backend/file/pdf/pdf-print.css", import.meta.url),
);

/** 策略只服务本测试：不缩放、不降采样，阶段耗时全部来自真实像素。 */
const PROBE_IMAGE_POLICY = {
  maxEdge: PROBE_IMAGE_EDGE,
  maxPixels: PROBE_IMAGE_EDGE * PROBE_IMAGE_EDGE + 1,
  maxBytes: 48_000_000,
  quality: 0.8,
} as const;

const temporary_directories: string[] = [];
/** 用例自建的浏览器在失败路径也要释放，统一在这里兜底 dispose。 */
const case_disposables: Array<{ dispose: () => Promise<void> }> = [];
/** 进入本文件前已存在的产品浏览器属于其它实例，断言与清理都不触碰。 */
const foreign_profiles = new Set<string>();
let shared_browser: ChromiumBrowser | null = null;
let probe_image: Uint8Array = new Uint8Array();
let small_image: Uint8Array = new Uint8Array();

function png_chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * 生成确定性合成 PNG：整幅图由同一条噪声行重复而成。
 * 行间重复让压缩极快，水平高频噪声让 Chromium 的 WebP 编码承担真实成本。
 */
function create_synthetic_png(edge: number): Uint8Array {
  const row = Buffer.allocUnsafe(1 + edge * 3);
  row[0] = 0; // 滤波类型 none
  let state = 0x12345678;
  for (let index = 1; index < row.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    row[index] = state & 0xff;
  }
  const raw = Buffer.concat(Array.from({ length: edge }, () => row));
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(edge, 0);
  ihdr.writeUInt32BE(edge, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    png_chunk("IHDR", ihdr),
    png_chunk("IDAT", deflateSync(raw, { level: 1 })),
    png_chunk("IEND", new Uint8Array()),
  ]);
}

interface ChromiumProcess {
  pid: number;
  profile: string;
  args: string;
}

/** 从命令行读取宿主自有的临时 profile 目录名；非本产品进程返回 null。 */
function read_chromium_profile(args: string): string | null {
  const marker = "--user-data-dir=";
  const start = args.indexOf(marker);
  if (start === -1) return null;
  const value = args.slice(start + marker.length).split(" ")[0] ?? "";
  const name = path.basename(value);
  return name.startsWith("lg-chromium-") ? name : null;
}

/**
 * 列出产品启动的 Chromium 进程。
 * Termux 的 chromium-headless 包装脚本会 exec 成 chrome，命令行不含原始可执行文件路径，
 * 因此按 profile 标记识别；渲染等子进程带 `--type=`，主进程不带。
 */
function list_chromium_processes(): ChromiumProcess[] {
  const completed = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  if (completed.error !== undefined || completed.status !== 0) return [];
  const processes: ChromiumProcess[] = [];
  for (const line of String(completed.stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const separator = trimmed.search(/\s/u);
    if (separator === -1) continue;
    const pid = Number(trimmed.slice(0, separator));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const args = trimmed.slice(separator).trim();
    const profile = read_chromium_profile(args);
    if (profile === null) continue;
    processes.push({ pid, profile, args });
  }
  return processes;
}

/** 向整个进程组发信号：宿主以独立进程组启动，只杀主进程会留下仍在写 profile 的渲染子进程。 */
function kill_chromium_process_group(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // 进程组已不存在时退回单进程信号。
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 进程已退出，无需处理。
  }
}

/** 轮询等待条件成立，避免用固定睡眠拖慢用例或制造竞态。 */
async function wait_for(
  predicate: () => boolean,
  timeout_ms: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

interface StageProbe {
  pages: ChromiumPageSource;
  navigated: () => boolean;
  printing: () => boolean;
}

/** 装饰真实页面来源：只记录阶段到达时刻，用于在真实工作途中触发取消。 */
function create_stage_probe(pages: ChromiumPageSource): StageProbe {
  const state = { navigated: false, printing: false };
  return {
    pages: {
      open_page: async () => {
        const page = await pages.open_page();
        const probed: ChromiumPage = {
          navigate: async (url: string) => {
            await page.navigate(url);
            state.navigated = true;
          },
          evaluate: (expression: string) => page.evaluate(expression),
          print_to_pdf: async (options: {
            printBackground: boolean;
            preferCSSPageSize: boolean;
          }) => {
            state.printing = true;
            return await page.print_to_pdf(options);
          },
          close: () => page.close(),
        };
        return probed;
      },
      dispose: () => pages.dispose(),
    },
    navigated: () => state.navigated,
    printing: () => state.printing,
  };
}

function create_print_resources(): { stylesPath: string; fontsDirectory: string } {
  // 夹具目录名不得以 lg-chromium- 开头：那是宿主临时 profile 的前缀，会被残留断言误报。
  const directory = mkdtempSync(path.join(tmpdir(), "lg-print-resources-"));
  temporary_directories.push(directory);
  const fonts_directory = path.join(directory, "fonts");
  mkdirSync(fonts_directory, { recursive: true });
  for (const file of PRINT_FONT_FILES)
    copyFileSync(PRINT_FONT_SOURCE, path.join(fonts_directory, file));
  return { stylesPath: PRINT_STYLES_SOURCE, fontsDirectory: fonts_directory };
}

/** 多页合成文档：每节强制分页，打印阶段的工作量随页数增长。 */
function create_multi_page_html(page_count: number): string {
  return Array.from(
    { length: page_count },
    (_, index) =>
      `<section class="pdf-document" style="break-after:page"><h2>第 ${index + 1} 页</h2><p>${"译文正文与术语条目。".repeat(24)}</p></section>`,
  ).join("");
}

function create_image_operation(bytes: Uint8Array): AgentImageHostOperation {
  return { kind: "prepare_image", bytes, mimeType: "image/png", policy: PROBE_IMAGE_POLICY };
}

/** 真实 PDF 字节证据：文件头必须是 `%PDF-`。 */
function expect_pdf_header(bytes: Uint8Array): void {
  expect(Array.from(bytes.subarray(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
}

const chromium_executable = resolve_chromium_executable_path();

if (chromium_executable === null) {
  // 没有 Chromium 的环境不运行真实浏览器用例；能力缺失的投影由其它测试覆盖。
  describe.skip("chromium 宿主弹性（真实浏览器）", () => {});
} else {
  describe("chromium 宿主弹性（真实浏览器）", () => {
    function own_chromium_processes(): ChromiumProcess[] {
      return list_chromium_processes().filter((process) => !foreign_profiles.has(process.profile));
    }

    function own_chromium_main_pids(): number[] {
      return own_chromium_processes()
        .filter((process) => !process.args.includes("--type="))
        .map((process) => process.pid);
    }

    function own_profile_directories(): string[] {
      try {
        return readdirSync(tmpdir()).filter(
          (name) => name.startsWith("lg-chromium-") && !foreign_profiles.has(name),
        );
      } catch {
        return [];
      }
    }

    function require_shared_browser(): ChromiumBrowser {
      if (shared_browser === null) throw new Error("Shared Chromium browser was not created.");
      return shared_browser;
    }

    function shared_page_source(): ChromiumPageSource {
      const browser = require_shared_browser();
      return { open_page: () => browser.open_page(), dispose: () => browser.dispose() };
    }

    beforeAll(() => {
      // 先记录外来实例，再把本文件的创建与清理都限定在自有 profile 上。
      for (const process of list_chromium_processes()) foreign_profiles.add(process.profile);
      probe_image = create_synthetic_png(PROBE_IMAGE_EDGE);
      small_image = create_synthetic_png(32);
      shared_browser = new ChromiumBrowser({ executablePath: chromium_executable });
    }, FIXTURE_TIMEOUT_MS);

    afterEach(async () => {
      // 兜底释放用例自建的浏览器：用例已失败时清理异常不改变结论，残留由 afterAll 按组回收。
      for (const disposable of case_disposables.splice(0, case_disposables.length)) {
        await disposable.dispose().catch(() => undefined);
      }
      while (temporary_directories.length > 0) {
        const directory = temporary_directories.pop();
        if (directory === undefined) continue;
        rmSync(directory, { recursive: true, force: true });
      }
    });

    afterAll(async () => {
      await shared_browser?.dispose();
      // 释放后仍存在的本文件进程只可能是泄漏：按进程组收尾，避免遗留任务拥有的浏览器。
      for (const process of own_chromium_processes()) kill_chromium_process_group(process.pid);
    });

    it(
      "取消进行中的图片编码：按调用方原因收敛，浏览器可继续完成后续编码",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const probe = create_stage_probe(shared_page_source());
        const controller = new AbortController();

        const in_flight = create_chromium_image_host(probe.pages)(
          create_image_operation(probe_image),
          controller.signal,
        );
        await wait_for(probe.navigated, 30_000, "图片宿主加载内嵌文档");
        const cancelled_at = Date.now();
        controller.abort(new Error("cancelled by caller"));

        await expect(in_flight).rejects.toThrow("cancelled by caller");
        const cancel_elapsed_ms = Date.now() - cancelled_at;

        // 同一浏览器进程完成下一次完整编码：取消释放了页面，宿主没有留在半坏状态。
        const follow_up_started_at = Date.now();
        const encoded = await create_chromium_image_host(probe.pages)(
          create_image_operation(probe_image),
          new AbortController().signal,
        );
        expect(encoded).toMatchObject({
          width: PROBE_IMAGE_EDGE,
          height: PROBE_IMAGE_EDGE,
          originalWidth: PROBE_IMAGE_EDGE,
          originalHeight: PROBE_IMAGE_EDGE,
        });
        // 取消不等被放弃的编码跑完：收敛耗时必须短于一次完整编码。
        expect(cancel_elapsed_ms).toBeLessThan(Date.now() - follow_up_started_at);
      },
    );

    it(
      "图片编码超过任务超时：按超时失败并释放页面，浏览器可继续使用",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const probe = create_stage_probe(shared_page_source());
        const host = create_chromium_image_host(probe.pages, {
          timeoutMs: IMAGE_TASK_TIMEOUT_MS,
        });

        const failure = await host(
          create_image_operation(probe_image),
          new AbortController().signal,
        )
          .then(() => null)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DOMException);
        expect((failure as DOMException).name).toBe("TimeoutError");
        expect((failure as DOMException).message).toContain("timed out");

        // 超时后页面已释放：同一浏览器完成一次小图编码。
        const encoded = await create_chromium_image_host(probe.pages)(
          create_image_operation(small_image),
          new AbortController().signal,
        );
        expect(encoded).toMatchObject({
          width: 32,
          height: 32,
          originalWidth: 32,
          originalHeight: 32,
        });
      },
    );

    it(
      "取消进行中的打印：按调用方原因收敛，后续打印仍可完成",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const probe = create_stage_probe(shared_page_source());
        const host = create_chromium_pdf_host(create_print_resources(), probe.pages);
        const controller = new AbortController();

        const in_flight = host(
          { kind: "print_pdf", html: create_multi_page_html(PRINT_PAGE_COUNT) },
          controller.signal,
        );
        await wait_for(probe.printing, 60_000, "打印阶段开始");
        controller.abort(new Error("cancelled by caller"));

        await expect(in_flight).rejects.toThrow("cancelled by caller");

        // 取消后队列与页面都恢复：同一宿主完成一次小文档打印并产出真实 PDF 字节。
        const bytes = await host({ kind: "print_pdf", html: "<p>取消后的后续打印</p>" });
        expect_pdf_header(bytes);
      },
    );

    it(
      "打印超过任务超时：按超时失败并释放页面，后续打印仍可完成",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const probe = create_stage_probe(shared_page_source());
        const host = create_chromium_pdf_host(create_print_resources(), probe.pages, {
          timeoutMs: PDF_TASK_TIMEOUT_MS,
        });

        const failure = await host({
          kind: "print_pdf",
          html: create_multi_page_html(PRINT_PAGE_COUNT),
        })
          .then(() => null)
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DOMException);
        expect((failure as DOMException).name).toBe("TimeoutError");

        const bytes = await host({ kind: "print_pdf", html: "<p>超时后的后续打印</p>" });
        expect_pdf_header(bytes);
      },
    );

    it(
      "dispose 结束后没有遗留的浏览器进程与临时 profile",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        await require_shared_browser().dispose();

        await wait_for(() => own_chromium_processes().length === 0, 30_000, "浏览器进程退出");
        expect(own_profile_directories()).toEqual([]);
      },
    );

    it(
      "宿主进程崩溃：在途任务立即失败，宿主不再受理且 dispose 干净收尾",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const crashed_browser = new ChromiumBrowser({ executablePath: chromium_executable });
        case_disposables.push(crashed_browser);
        const image_host = create_chromium_image_host(crashed_browser);
        const pdf_host = create_chromium_pdf_host(create_print_resources(), crashed_browser);
        const probe = create_stage_probe({
          open_page: () => crashed_browser.open_page(),
          dispose: () => crashed_browser.dispose(),
        });

        const in_flight = create_chromium_image_host(probe.pages)(
          create_image_operation(probe_image),
          new AbortController().signal,
        );
        await wait_for(probe.navigated, 60_000, "图片宿主加载内嵌文档");

        // 先证明产品代码确实启动了真实浏览器，再杀死整个进程组模拟宿主崩溃。
        const main_pids = own_chromium_main_pids();
        expect(main_pids.length).toBeGreaterThan(0);
        for (const pid of main_pids) kill_chromium_process_group(pid);

        await expect(in_flight).rejects.toMatchObject({
          code: "runtime.internal_invariant",
          // 进程退出与调试通道断开都可能先到，两者都表示宿主进程消失。
          diagnostic_context: {
            reason: expect.stringMatching(/^chromium_(exited|debug_socket_closed)$/),
          },
        });

        // 崩溃后宿主不可用：新请求快速失败，不把队列留在永久等待中。
        const after_crash_started_at = Date.now();
        await expect(
          image_host(create_image_operation(small_image), new AbortController().signal),
        ).rejects.toMatchObject({ code: "runtime.internal_invariant" });
        await expect(
          pdf_host({ kind: "print_pdf", html: "<p>崩溃后的打印</p>" }),
        ).rejects.toThrow();
        expect(Date.now() - after_crash_started_at).toBeLessThan(30_000);

        await expect(crashed_browser.dispose()).resolves.toBeUndefined();
        await wait_for(
          () => own_chromium_processes().length === 0,
          30_000,
          "崩溃后的浏览器进程退出",
        );
        expect(own_profile_directories()).toEqual([]);
      },
    );
  });
}
