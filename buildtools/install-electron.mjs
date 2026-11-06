import { spawnSync } from "node:child_process";

// Termux 与 Web 部署不需要 Electron 二进制；平台或显式开关命中时跳过下载，其余平台保持桌面安装行为。
const skip_reasons = [];
if (process.platform === "android") {
  skip_reasons.push("android 平台没有 Electron 发行二进制");
}
if (process.env["LINGUAGACHA_SKIP_ELECTRON"] === "1") {
  skip_reasons.push("LINGUAGACHA_SKIP_ELECTRON=1");
}

if (skip_reasons.length > 0) {
  process.stdout.write(
    `[postinstall] skip Electron binary download (${skip_reasons.join("; ")}). Use npm run build:web for the Termux web runtime.\n`,
  );
  process.exit(0);
}

const result = spawnSync("install-electron", [], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error !== undefined) {
  process.stderr.write(`[postinstall] failed to run install-electron: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
