import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { create_chromium_pdf_host } from "./chromium-pdf-host";
import type { ChromiumPage, ChromiumPageSource } from "./chromium-browser";

const PRINT_FONT_FILES = [
  "LGBaseFont-Regular.woff2",
  "LGBaseFont-Bold.woff2",
  "MonaspaceNeon.woff2",
];

const temporary_directories: string[] = [];

/** 按调用内容识别宿主阶段，避免把脚本文本当契约断言。 */
function classify_expression(expression: string): string {
  if (expression.includes("document.open()")) return "document";
  if (expression.includes("createElement('style')")) return "styles";
  if (expression.includes("document.fonts.ready")) return "assets";
  if (expression.includes(".pdf-document figure")) return "layout";
  return "unknown";
}

interface FakeRecorder {
  pages: ChromiumPageSource;
  events: string[];
  style_expressions: string[];
  document_expressions: string[];
  print_options: { printBackground: boolean; preferCSSPageSize: boolean }[];
  release_print: () => void;
  counts: () => { opened: number; closed: number; dispose_calls: number };
}

/** 记录每次打印的阶段顺序；`gate_print` 让测试控制打印完成时机。 */
function create_fake_pages(options?: { gate_print?: boolean }): FakeRecorder {
  const events: string[] = [];
  const style_expressions: string[] = [];
  const document_expressions: string[] = [];
  const print_options: { printBackground: boolean; preferCSSPageSize: boolean }[] = [];
  const print_gate = Promise.withResolvers<void>();
  let opened = 0;
  let closed = 0;
  let dispose_calls = 0;
  const pages: ChromiumPageSource = {
    open_page: async () => {
      const id = opened;
      opened += 1;
      events.push(`open:${id}`);
      const page: ChromiumPage = {
        navigate: async () => {
          events.push(`navigate:${id}`);
        },
        evaluate: async (expression: string) => {
          const kind = classify_expression(expression);
          events.push(`evaluate:${id}:${kind}`);
          if (kind === "styles") style_expressions.push(expression);
          if (kind === "document") document_expressions.push(expression);
          return undefined;
        },
        print_to_pdf: async (print) => {
          events.push(`print:${id}`);
          print_options.push({ ...print });
          if (options?.gate_print === true) await print_gate.promise;
          events.push(`printed:${id}`);
          return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        },
        close: async () => {
          closed += 1;
          events.push(`close:${id}`);
        },
      };
      return page;
    },
    dispose: async () => {
      dispose_calls += 1;
      events.push("dispose");
    },
  };
  return {
    pages,
    events,
    style_expressions,
    document_expressions,
    print_options,
    release_print: () => print_gate.resolve(),
    counts: () => ({ opened, closed, dispose_calls }),
  };
}

function create_print_resources(): { stylesPath: string; fontsDirectory: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "lg-pdf-host-test-"));
  temporary_directories.push(directory);
  const fonts_directory = path.join(directory, "fonts");
  mkdirSync(fonts_directory, { recursive: true });
  for (const file of PRINT_FONT_FILES) {
    writeFileSync(path.join(fonts_directory, file), `font:${file}`);
  }
  const styles_path = path.join(directory, "pdf-print.css");
  writeFileSync(styles_path, ".pdf-document{font-family:LGBaseFont}");
  return { stylesPath: styles_path, fontsDirectory: fonts_directory };
}

/** 轮询等待条件成立，避免用固定睡眠拖慢用例。 */
async function wait_for(predicate: () => boolean, timeout_ms = 2_000): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached in time");
}

afterEach(() => {
  while (temporary_directories.length > 0) {
    const directory = temporary_directories.pop();
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("chromium pdf host", () => {
  it("按加载、写文档、注入样式、等资源、测量、打印顺序执行", async () => {
    const recorder = create_fake_pages();
    const host = create_chromium_pdf_host(create_print_resources(), recorder.pages);

    const bytes = await host({ kind: "print_pdf", html: "<p>译文</p>" });

    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(recorder.events).toEqual([
      "open:0",
      "navigate:0",
      "evaluate:0:document",
      "evaluate:0:styles",
      "evaluate:0:assets",
      "evaluate:0:layout",
      "print:0",
      "printed:0",
      "close:0",
    ]);
    expect(recorder.print_options).toEqual([{ printBackground: true, preferCSSPageSize: true }]);
    expect(recorder.counts().closed).toBe(1);
  });

  it("调用方 HTML 经 CSP 文档写入，样式内嵌字体与数学样式", async () => {
    const recorder = create_fake_pages();
    const resources = create_print_resources();
    const host = create_chromium_pdf_host(resources, recorder.pages);

    await host({ kind: "print_pdf", html: "<p>正文</p>" });

    expect(recorder.document_expressions).toHaveLength(1);
    expect(recorder.document_expressions[0]).toContain("<p>正文</p>");
    expect(recorder.document_expressions[0]).toContain("default-src 'none'");
    expect(recorder.style_expressions).toHaveLength(1);
    for (const file of PRINT_FONT_FILES) {
      expect(recorder.style_expressions[0]).toContain(
        Buffer.from(`font:${file}`).toString("base64"),
      );
    }
    expect(recorder.style_expressions[0]).toContain(".pdf-document{font-family:LGBaseFont}");
  });

  it("打印样式只在首次打印时生成，字体文件后续改动不影响已缓存样式", async () => {
    const recorder = create_fake_pages();
    const resources = create_print_resources();
    const host = create_chromium_pdf_host(resources, recorder.pages);

    await host({ kind: "print_pdf", html: "<p>一</p>" });
    writeFileSync(path.join(resources.fontsDirectory, "MonaspaceNeon.woff2"), "font:changed");
    await host({ kind: "print_pdf", html: "<p>二</p>" });

    expect(recorder.style_expressions).toHaveLength(2);
    expect(recorder.style_expressions[1]).toBe(recorder.style_expressions[0]);
    expect(recorder.style_expressions[1]).toContain(
      Buffer.from("font:MonaspaceNeon.woff2").toString("base64"),
    );
    expect(recorder.style_expressions[1]).not.toContain(
      Buffer.from("font:changed").toString("base64"),
    );
  });

  it("并发打印串行，前一页面回收后才打开下一页面", async () => {
    const recorder = create_fake_pages({ gate_print: true });
    const host = create_chromium_pdf_host(create_print_resources(), recorder.pages);

    const first = host({ kind: "print_pdf", html: "<p>一</p>" });
    await wait_for(() => recorder.events.includes("print:0"));
    const second = host({ kind: "print_pdf", html: "<p>二</p>" });
    await wait_for(() => recorder.events.includes("close:0") === false);
    expect(recorder.counts().opened).toBe(1);

    recorder.release_print();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(recorder.counts()).toEqual({ opened: 2, closed: 2, dispose_calls: 0 });
  });

  it("排队中的取消在取得页面前完成，后续打印仍可工作", async () => {
    const recorder = create_fake_pages({ gate_print: true });
    const host = create_chromium_pdf_host(create_print_resources(), recorder.pages);

    const first = host({ kind: "print_pdf", html: "<p>一</p>" });
    await wait_for(() => recorder.events.includes("print:0"));
    const queued_controller = new AbortController();
    const queued = host({ kind: "print_pdf", html: "<p>二</p>" }, queued_controller.signal);
    queued_controller.abort(new Error("queued cancelled"));
    await expect(queued).rejects.toThrow("queued cancelled");
    expect(recorder.counts().opened).toBe(1);

    recorder.release_print();
    await expect(first).resolves.toBeDefined();
    await expect(host({ kind: "print_pdf", html: "<p>三</p>" })).resolves.toBeDefined();
    expect(recorder.counts().opened).toBe(2);
  });

  it("活动打印取消后释放页面，后续打印仍可工作", async () => {
    const recorder = create_fake_pages({ gate_print: true });
    const host = create_chromium_pdf_host(create_print_resources(), recorder.pages);
    const controller = new AbortController();

    const active = host({ kind: "print_pdf", html: "<p>一</p>" }, controller.signal);
    await wait_for(() => recorder.events.includes("print:0"));
    controller.abort(new Error("active cancelled"));
    await expect(active).rejects.toThrow("active cancelled");
    expect(recorder.events).toContain("close:0");

    recorder.release_print();
    await expect(host({ kind: "print_pdf", html: "<p>二</p>" })).resolves.toBeDefined();
    expect(recorder.counts().closed).toBe(2);
  });

  it("dispose 中断活动与排队任务，之后不再受理打印", async () => {
    const recorder = create_fake_pages({ gate_print: true });
    const host = create_chromium_pdf_host(create_print_resources(), recorder.pages);

    const active = host({ kind: "print_pdf", html: "<p>一</p>" });
    await wait_for(() => recorder.events.includes("print:0"));
    const queued = host({ kind: "print_pdf", html: "<p>二</p>" });
    const disposing = host.dispose();

    await expect(active).rejects.toThrow();
    await expect(queued).rejects.toThrow();
    await expect(disposing).resolves.toBeUndefined();
    await expect(host({ kind: "print_pdf", html: "<p>三</p>" })).rejects.toThrow();
    expect(recorder.counts().dispose_calls).toBe(1);
    expect(recorder.events.at(-1)).toBe("dispose");
  });
});
