import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  build_chromium_launch_arguments,
  CHROMIUM_BLOCKED_URL_PATTERNS,
  resolve_chromium_executable_path,
} from "./chromium-browser";

const temporary_directories: string[] = [];

/** 创建测试自有的临时目录，断言只依赖目录内自建的候选文件。 */
function make_temporary_directory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "lg-chromium-test-"));
  temporary_directories.push(directory);
  return directory;
}

afterEach(() => {
  delete process.env["PATH"];
  while (temporary_directories.length > 0) {
    const directory = temporary_directories.pop();
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("chromium executable resolution", () => {
  it("显式路径存在时优先使用", () => {
    const directory = make_temporary_directory();
    const executable = path.join(directory, "my-chromium");
    writeFileSync(executable, "");
    expect(resolve_chromium_executable_path(executable)).toBe(executable);
  });

  it("显式路径缺失时返回 null，不静默回退到其他候选", () => {
    const directory = make_temporary_directory();
    expect(resolve_chromium_executable_path(path.join(directory, "missing"))).toBeNull();
  });

  it("按 PATH 顺序取第一个存在的裸命令名", () => {
    const first = make_temporary_directory();
    const second = make_temporary_directory();
    process.env["PATH"] = [first, second].join(path.delimiter);
    writeFileSync(path.join(second, "chromium-headless"), "");
    expect(resolve_chromium_executable_path("chromium-headless")).toBe(
      path.join(second, "chromium-headless"),
    );
    mkdirSync(path.join(first, "chromium-headless"), { recursive: true });
    // 同名目录不算可执行文件，继续向后查找。
    expect(resolve_chromium_executable_path("chromium-headless")).toBe(
      path.join(second, "chromium-headless"),
    );
  });

  it("PATH 中没有匹配命令名时返回 null", () => {
    process.env["PATH"] = make_temporary_directory();
    expect(resolve_chromium_executable_path("chromium-headless")).toBeNull();
  });

  it("空 PATH 段被忽略", () => {
    const only = make_temporary_directory();
    process.env["PATH"] = ["", only, ""].join(path.delimiter);
    writeFileSync(path.join(only, "chromium-headless"), "");
    expect(resolve_chromium_executable_path("chromium-headless")).toBe(
      path.join(only, "chromium-headless"),
    );
  });
});

describe("chromium launch arguments", () => {
  const arguments_list = build_chromium_launch_arguments(path.join(path.sep, "tmp", "profile"));

  it("使用独立 profile 与回环调试端口", () => {
    expect(arguments_list).toContain(`--user-data-dir=${path.join(path.sep, "tmp", "profile")}`);
    expect(arguments_list).toContain("--remote-debugging-port=0");
    expect(arguments_list).toContain("--remote-debugging-address=127.0.0.1");
  });

  it("无头运行且禁用同步、扩展与组件更新", () => {
    expect(arguments_list).toContain("--headless=new");
    expect(arguments_list).toContain("--disable-sync");
    expect(arguments_list).toContain("--disable-extensions");
    expect(arguments_list).toContain("--disable-component-update");
  });

  it("按 sRGB 与 1x 缩放采样，保证编码与打印结果跨宿主一致", () => {
    expect(arguments_list).toContain("--force-color-profile=srgb");
    expect(arguments_list).toContain("--force-device-scale-factor=1");
  });

  it("以空白页启动，首个目标由宿主显式创建", () => {
    expect(arguments_list.at(-1)).toBe("about:blank");
  });
});

describe("chromium blocked url patterns", () => {
  /** CDP 的 URL 模式只支持 `*` 通配；按同样语义判断某个 URL 是否被拦截。 */
  function is_blocked(pattern: string, url: string): boolean {
    const expression = new RegExp(`^${pattern.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
    return expression.test(url);
  }

  it("不拦截进程内数据，打印图片与内嵌字体才能加载", () => {
    // 通配 `*` 曾把 data: 图片与字体一并拦掉，打印静默回退到默认字体且无报错。
    for (const url of [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:font/woff2;base64,d09GMg==",
      "blob:https://example.com/6f1c4a9e-1c1a-4f6e-9a0f-2b7c1d3e5f60",
    ]) {
      for (const pattern of CHROMIUM_BLOCKED_URL_PATTERNS)
        expect(is_blocked(pattern, url), `${pattern} 不应拦截 ${url}`).toBe(false);
    }
  });

  it("可离开本机的协议全部被拦截", () => {
    for (const url of [
      "http://example.com/image.png",
      "https://example.com/font.woff2",
      "ws://example.com/socket",
      "wss://example.com/socket",
      "ftp://example.com/file",
      "file:///etc/hosts",
    ]) {
      const blocked = CHROMIUM_BLOCKED_URL_PATTERNS.some((pattern) => is_blocked(pattern, url));
      expect(blocked, `${url} 应被拦截`).toBe(true);
    }
  });
});
