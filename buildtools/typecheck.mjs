import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ANDROID_COMPILER = Object.freeze({
  version: "7.0.2",
  commit: "2bd066d87f5bafd315be9f40889d0a60b9e58e0b",
  sha256: "5ccb47dbb3f68cd0da58b71e6f445eee36a50bd3e9f9f330cc23a97b88500119",
  revision: "android-1", // 平台补丁变化时更换缓存身份，避免复用旧二进制。
});
const DOWNLOAD_TIMEOUT_MS = 90_000;
const BUILD_ENV = Object.freeze({
  GOOS: "android",
  GOARCH: "arm64",
  CGO_ENABLED: "0",
  GOTOOLCHAIN: "local",
  GOMAXPROCS: "2",
  GOMEMLIMIT: "768MiB",
});

/** 子进程保留标准流与失败状态；类型错误不能被启动器吞掉。 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    // 首次编译也可能被用户停止；等待 Go 退出后才能回收它正在读取的临时源码。
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal !== null) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

/** 只移植上游 Android 监视器修复，保留 7.0.2 的类型检查实现和内嵌标准库。 */
async function patch_android_watchers(source_root) {
  const fanotify_path = path.join(source_root, "internal/fswatch/fanotify_linux.go");
  const watcher_path = path.join(source_root, "internal/fswatch/watcher.go");
  const fanotify = await readFile(fanotify_path, "utf8");
  const watcher = await readFile(watcher_path, "utf8");
  if (!fanotify.startsWith("//go:build linux\n") || !watcher.includes('case "linux":\n'))
    throw new Error("TypeScript Android patch no longer matches the pinned source.");
  // Android 的 seccomp 会终止调用 fanotify_init 的进程，连 --version 也无法运行。
  await writeFile(
    fanotify_path,
    fanotify.replace("//go:build linux\n", "//go:build linux && !android\n"),
  );
  await writeFile(
    watcher_path,
    watcher.replace('case "linux":\n', 'case "android":\n\t\treturn Inotify()\n\tcase "linux":\n'),
  );
}

async function prepare_android_compiler() {
  if (process.arch !== "arm64") throw new Error("Android typecheck currently requires arm64.");
  const installed = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "node_modules/typescript/package.json"), "utf8"),
  );
  if (
    installed.version !== ANDROID_COMPILER.version ||
    installed.gitHead !== ANDROID_COMPILER.commit
  )
    throw new Error(
      "Update the pinned Android compiler recipe together with the TypeScript dependency.",
    );
  const directory = path.join(
    PROJECT_ROOT,
    "build/toolchains/typescript",
    `${ANDROID_COMPILER.version}-${ANDROID_COMPILER.revision}-${process.arch}`,
  );
  const executable = path.join(directory, "tsc");
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
  } catch (cause) {
    throw new Error(
      "Android typecheck needs Go 1.26 or newer for its first build. Run: pkg install golang",
      { cause },
    );
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "lg-typescript-build-"));
  try {
    process.stdout.write(
      `[typecheck] Building TypeScript ${ANDROID_COMPILER.version} for Android arm64.\n`,
    );
    const response = await fetch(
      `https://codeload.github.com/microsoft/typescript-go/tar.gz/${ANDROID_COMPILER.commit}`,
      { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error(`TypeScript source download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== ANDROID_COMPILER.sha256)
      throw new Error("TypeScript source SHA256 mismatch.");
    const archive_path = path.join(temporary, "source.tgz");
    await writeFile(archive_path, archive);
    execFileSync("tar", ["-xzf", archive_path, "-C", temporary]);
    const source_root = path.join(temporary, `typescript-go-${ANDROID_COMPILER.commit}`);
    await patch_android_watchers(source_root);
    const staged = path.join(temporary, "tsc");
    const code = await run(
      "go",
      ["build", "-p", "2", "-trimpath", "-ldflags=-s -w", "-o", staged, "./cmd/tsgo"],
      { cwd: source_root, env: { ...process.env, ...BUILD_ENV } },
    );
    if (code !== 0) throw new Error(`Android TypeScript build failed with exit code ${code}.`);
    const version = execFileSync(staged, ["--version"], { encoding: "utf8" }).trim();
    if (version !== `Version ${ANDROID_COMPILER.version}`)
      throw new Error(`Unexpected Android compiler version: ${version}`);
    await mkdir(directory, { recursive: true });
    // 原子发布完整二进制；并发首用各自编译相同版本，不暴露半成品给另一个调用者。
    await rename(staged, executable);
    return executable;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (process.platform === "android") {
    const executable = await prepare_android_compiler();
    return run(executable, args, {
      env: {
        ...process.env,
        GOMAXPROCS: process.env.GOMAXPROCS ?? "2",
        GOMEMLIMIT: process.env.GOMEMLIMIT ?? "1GiB",
      },
    });
  }
  return run(process.execPath, [
    path.join(PROJECT_ROOT, "node_modules/typescript/lib/tsc.js"),
    ...args,
  ]);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
