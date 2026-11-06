#!/usr/bin/env node
/**
 * 移动端文件选择器探针：390 × 844 触屏视口下验证 Web 文件选择器的可达性。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`。
 *
 * 覆盖内容：
 *   1. 窄视口无整体横向溢出，对话框完整位于视口内；
 *   2. 触屏下列举行可点击元素达到 40px 行高，可用按钮补足触摸目标；
 *   3. 文件行可勾选，确认后对话框关闭且工程页恢复；
 *   4. 保存模式：可切换“应用数据”根且无横向溢出；
 *   5. 控制台无错误（GitHub 更新检查 404 是 fork 无 release 的预期行为，按 URL 排除）。
 *
 * 用法：
 *   node buildtools/web-mobile-picker-probe.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("/data/data/com.termux/files/home/.local/share/html-visual-check/node_modules/playwright-core");
const {
  launchOptions,
} = require("/data/data/com.termux/files/home/.local/share/html-visual-check/browser-config.cjs");

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 390, height: 844 }; // 常见 Android 手机逻辑像素
const TOUCH_TARGET_MIN = 40; // 仓库触屏热区标准量级

class VerifyFailure extends Error {}

class Report {
  constructor() {
    this.results = [];
  }

  pass(name, detail) {
    this.results.push({ name, ok: true, detail });
    process.stdout.write(`PASS ${name}${detail === undefined ? "" : `：${detail}`}\n`);
  }

  fail(name, reason) {
    this.results.push({ name, ok: false, reason: String(reason) });
    process.stdout.write(`FAIL ${name}: ${String(reason)}\n`);
  }

  get failed_count() {
    return this.results.filter((result) => !result.ok).length;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wait_for(predicate, timeout_ms, description) {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== false && value !== undefined && value !== null) return value;
    await sleep(100);
  }
  throw new VerifyFailure(`Timed out waiting for: ${description}`);
}

function parse_arguments(argv) {
  const options = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1)
      throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (value === "") throw new Error(`Empty argument value: ${name}`);
    if (name === "keep") options.keep = value === "true";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

class WebServiceProcess {
  constructor(child) {
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    child.stdout.on("data", (chunk) => {
      this.stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
  }

  read_access() {
    const match = this.stdout.match(/访问地址:\s*(\S+?)\/#credential=(\S+)/u);
    if (match === null) return null;
    return { baseUrl: match[1], credential: match[2] };
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await wait_for(
      () => this.child.exitCode !== null,
      SERVICE_STOP_TIMEOUT_MS,
      "Web 服务退出",
    ).catch(() => {
      this.child.kill("SIGKILL");
    });
  }
}

/** 测量页面与对话框的横向溢出：scrollWidth 超过 clientWidth 即存在隐形溢出。 */
async function measure_overflow(page, selector) {
  return await page.evaluate((target) => {
    const element = target === null ? document.documentElement : document.querySelector(target);
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    };
  }, selector);
}

/** 对话框内可见且可用的按钮尺寸；禁用按钮不是触摸目标，不参与断言。 */
async function measure_buttons(page) {
  return await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[role="dialog"] button')].filter(
      (button) => button.offsetParent !== null && !button.disabled,
    );
    return buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        text: (button.textContent ?? "").trim().slice(0, 12),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  });
}

/** 列实行可点击元素的高度；触屏下必须达到 40px 行高。 */
async function measure_row_heights(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll(".web-file-picker__row-target")]
      .slice(0, 5)
      .map((row) => Math.round(row.getBoundingClientRect().height)),
  );
}

/** 低于触摸目标的条目摘要，空数组表示全部达标。 */
function below_touch_target(heights) {
  return heights.filter((height) => height < TOUCH_TARGET_MIN);
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-mobile-picker-"));
  const data_root = path.join(artifacts, "data-root");
  mkdirSync(data_root, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  const service = new WebServiceProcess(
    spawn(process.execPath, [WEB_SERVER_ENTRY, "--port=0", `--data-root=${data_root}`], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  let browser = null;
  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    process.stdout.write(`[verify] Web 服务 ${access.baseUrl}\n`);

    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: true,
      hasTouch: true, // 触屏设备：hover 媒体特性为 none
      isMobile: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    const console_errors = [];
    const failed_responses = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // 资源加载失败由 failed_responses 按 URL 断言。
      if (/Failed to load resource/u.test(message.text())) return;
      console_errors.push(message.text().slice(0, 200));
    });
    page.on("pageerror", (error) =>
      console_errors.push(`pageerror: ${error.message.slice(0, 200)}`),
    );
    // fork 无 release 时更新检查的 GitHub 404 是预期行为。
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("api.github.com"))
        failed_responses.push(`${response.status()} ${response.url().slice(0, 140)}`);
    });

    await page.goto(`${access.baseUrl}/#credential=${access.credential}`, {
      waitUntil: "networkidle",
    });
    await wait_for(
      () =>
        page
          .getByText(/新建工程/)
          .first()
          .isVisible(),
      PAGE_TIMEOUT_MS,
      "工程页渲染",
    );

    // 首启更新提示可能遮挡界面。
    const cancel_update = page.getByRole("button", { name: "取消", exact: true }).first();
    try {
      await cancel_update.waitFor({ state: "visible", timeout: 10_000 });
      await cancel_update.click();
    } catch {
      // 未出现更新提示时继续。
    }

    // 1) 整页无横向溢出。
    const page_overflow = await measure_overflow(page, null);
    report.pass(
      "窄视口整页无横向溢出",
      page_overflow === null
        ? "无法测量"
        : `scrollWidth=${page_overflow.scrollWidth} clientWidth=${page_overflow.clientWidth}`,
    );
    if (page_overflow !== null && page_overflow.scrollWidth > page_overflow.clientWidth)
      report.fail(
        "窄视口整页无横向溢出",
        `scrollWidth=${page_overflow.scrollWidth} > clientWidth=${page_overflow.clientWidth}`,
      );

    // 2) 文件模式：打开选择器并测量对话框与触摸目标。
    await page.getByText("点击或拖拽源文件").first().click();
    await wait_for(
      () =>
        page
          .getByText(/选择文件/)
          .first()
          .isVisible(),
      PAGE_TIMEOUT_MS,
      "源文件菜单",
    );
    await page.getByText("选择文件", { exact: true }).last().click();
    await wait_for(
      () =>
        page
          .getByText(/上传文件/)
          .first()
          .isVisible(),
      PAGE_TIMEOUT_MS,
      "选择器对话框",
    );

    const dialog_overflow = await measure_overflow(page, '[role="dialog"]');
    report.pass(
      "对话框无横向溢出",
      dialog_overflow === null
        ? "无法测量"
        : `scrollWidth=${dialog_overflow.scrollWidth} clientWidth=${dialog_overflow.clientWidth}`,
    );
    if (dialog_overflow !== null && dialog_overflow.scrollWidth > dialog_overflow.clientWidth)
      report.fail(
        "对话框无横向溢出",
        `scrollWidth=${dialog_overflow.scrollWidth} > clientWidth=${dialog_overflow.clientWidth}`,
      );
    if (
      dialog_overflow !== null &&
      (dialog_overflow.rect.left < 0 || dialog_overflow.rect.right > VIEWPORT.width)
    )
      report.fail("对话框位于视口内", `rect=${JSON.stringify(dialog_overflow.rect)}`);
    else if (dialog_overflow !== null)
      report.pass("对话框位于视口内", JSON.stringify(dialog_overflow.rect));

    // 列实行可点击元素的触摸高度。
    const row_heights = await measure_row_heights(page);
    report.pass("列实行触摸高度", row_heights.join(", "));
    const short_rows = below_touch_target(row_heights);
    if (row_heights.length === 0) report.fail("列实行触摸高度", "没有可测量的列实行");
    else if (short_rows.length > 0)
      report.fail("列实行触摸高度", `低于 ${TOUCH_TARGET_MIN}px 的行：${short_rows.join(", ")}`);

    // 对话框可用按钮的触摸尺寸。
    const buttons = await measure_buttons(page);
    const small_buttons = buttons.filter((button) => button.height < TOUCH_TARGET_MIN);
    report.pass(
      "对话框按钮触摸尺寸",
      `${buttons.length} 个可用按钮；低于 ${TOUCH_TARGET_MIN}px：${small_buttons.map((b) => `${b.text}(${b.width}×${b.height})`).join(", ") || "无"}`,
    );
    if (small_buttons.length > 0)
      report.fail(
        "对话框按钮触摸尺寸",
        `${small_buttons.length} 个按钮低于 ${TOUCH_TARGET_MIN}px：${small_buttons.map((b) => `${b.text}(${b.width}×${b.height})`).join(", ")}`,
      );

    // 3) 经选择器的上传入口暂存一个合成小说文件，确认后工程页应认出 1 个源文件。
    //    （直接勾选用户主目录里的任意文件不保证是有效源，摘要为 0 时创建工程保持禁用，
    //    那是正确产品行为；上传入口同时覆盖移动端上传路径。）
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "mobile-probe.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("移动端探针正文第一行。\n移动端探针正文第二行。\n", "utf8"),
      });
    await wait_for(
      () =>
        page
          .getByText(/mobile-probe/)
          .first()
          .isVisible(),
      PAGE_TIMEOUT_MS,
      "上传材料出现在选择器",
    );
    report.pass("选择器内上传暂存", "mobile-probe.txt 已暂存并选中");
    await page.getByRole("button", { name: "选择", exact: true }).last().click();
    await wait_for(
      () =>
        page
          .getByText(/已选择/)
          .first()
          .isVisible(),
      PAGE_TIMEOUT_MS,
      "确认后回到工程页",
    );
    report.pass("确认后回到工程页", "摘要显示已选择源文件");

    // 4) 保存模式：创建工程流程中的保存选择器。
    const create_button = page.getByRole("button", { name: "创建工程", exact: true }).first();
    await wait_for(() => create_button.isEnabled(), PAGE_TIMEOUT_MS, "创建工程按钮可用");
    await create_button.click();
    await wait_for(
      () =>
        page
          .getByText(/选择保存位置/)
          .first()
          .isVisible(),
      PAGE_TIMEOUT_MS,
      "保存选择器",
    );
    const save_overflow = await measure_overflow(page, '[role="dialog"]');
    report.pass(
      "保存选择器无横向溢出",
      save_overflow === null
        ? "无法测量"
        : `scrollWidth=${save_overflow.scrollWidth} clientWidth=${save_overflow.clientWidth}`,
    );
    if (save_overflow !== null && save_overflow.scrollWidth > save_overflow.clientWidth)
      report.fail(
        "保存选择器无横向溢出",
        `scrollWidth=${save_overflow.scrollWidth} > clientWidth=${save_overflow.clientWidth}`,
      );
    const save_rows = await measure_row_heights(page);
    report.pass("保存选择器行触摸高度", save_rows.join(", ") || "空目录");
    const short_save_rows = below_touch_target(save_rows);
    if (short_save_rows.length > 0)
      report.fail(
        "保存选择器行触摸高度",
        `低于 ${TOUCH_TARGET_MIN}px 的行：${short_save_rows.join(", ")}`,
      );
    const app_data_root = page.getByRole("button", { name: "应用数据", exact: true }).first();
    if (await app_data_root.isVisible()) {
      await app_data_root.click();
      report.pass("保存选择器可切换应用数据根", "已点击");
    } else {
      report.fail("保存选择器可切换应用数据根", "未找到应用数据根按钮");
    }

    report.pass(
      "控制台",
      console_errors.length === 0 && failed_responses.length === 0
        ? "零错误"
        : `${console_errors.length} 个错误 / ${failed_responses.length} 个失败请求`,
    );
    for (const error of console_errors.slice(0, 5)) process.stdout.write(`  - ${error}\n`);
    for (const failure of failed_responses.slice(0, 5)) process.stdout.write(`  - ${failure}\n`);
    if (console_errors.length > 0) report.fail("控制台", console_errors[0]);
    if (failed_responses.length > 0) report.fail("控制台", `失败请求：${failed_responses[0]}`);
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    await browser?.close();
    await service.stop();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-2_000)}\n`);
    }
    if (!options.keep) rmSync(artifacts, { recursive: true, force: true });
    else process.stdout.write(`[verify] 保留产物目录 ${artifacts}\n`);
  }

  process.stdout.write(`\n[verify] 失败项 ${report.failed_count}\n`);
  process.exit(report.failed_count === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`[verify] 未处理异常：${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
