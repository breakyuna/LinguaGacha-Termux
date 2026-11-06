import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const TYPECHECK_ENTRY = fileURLToPath(new URL("./typecheck.mjs", import.meta.url));
const CHECK_TIMEOUT_MS = 30_000;

it.each([
  { name: "合法类型", source: "export const value: number = 1;", status: 0 },
  { name: "错误赋值", source: 'export const value: number = "invalid";', status: 1 },
])("仓库外调用类型检查入口保留 $name 的真实退出码", async ({ source, status }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lg-typecheck-test-"));
  try {
    const fixture = path.join(directory, "fixture.ts");
    await writeFile(fixture, source);
    const result = spawnSync(
      process.execPath,
      [
        TYPECHECK_ENTRY,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--target",
        "ES2025",
        "--lib",
        "ES2025",
        fixture,
      ],
      { cwd: directory, encoding: "utf8", timeout: CHECK_TIMEOUT_MS },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    if (status === 1) expect(result.stdout).toContain("TS2322");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
