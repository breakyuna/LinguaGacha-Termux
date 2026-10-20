#!/usr/bin/env node
/**
 * 小说闭环浏览器验证：EPUB 导入到导出 + 多语言译文下载边界（TW-05 / R-12）。
 *
 * 前置条件：已执行 `node buildtools/build-web.mjs`。
 *
 * 覆盖内容：
 *   1. 真实启动 Web 服务（临时数据根），Playwright Core 驱动本机 Chromium；
 *   2. 工程页经“点击或拖拽源文件 → 选择文件 → 上传文件”上传合成 EPUB，
 *      摘要确认后创建工程，保存选择器按默认名落盘；
 *   3. 工作台显示 EPUB 文件与条目，命令栏“生成译文”→ 确认 → 下载清单；
 *      捕获浏览器下载并校验文件内容包含 EPUB 正文；
 *   4. 侧栏语言菜单切换为 English 后再次生成并下载：新语言输出目录可下载，
 *      且下载清单同时列出既有语言与新语言的输出文件（R-12 决策 C）；
 *   5. 旧语言输出目录的下载边界经 REST 直查（切换后仍位于允许集，决策 C 落地）；
 *   6. 停止服务后退出码 0，无遗留 Chromium 进程与 profile。
 *
 * 用法：
 *   node buildtools/web-novel-loop-verify.mjs [--keep]
 * 退出码：全部通过 0，任一失败 1，用法错误 2。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SERVER_ENTRY = path.join(PROJECT_ROOT, "build", "web", "index.mjs");

// 本机验证约定：禁用 Playwright 浏览器注册表查找，使用系统 Chromium。
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const require = createRequire(import.meta.url);
const {
  chromium,
} = require("/data/data/com.termux/files/home/.local/share/html-visual-check/node_modules/playwright-core");
const {
  launchOptions,
} = require("/data/data/com.termux/files/home/.local/share/html-visual-check/browser-config.cjs");

const SERVICE_START_TIMEOUT_MS = 90_000;
const SERVICE_STOP_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 60_000;

const EPUB_CHAPTER_TEXT = "第一章正文：主角走进城门。";
const EPUB_NAME = "book.epub";

const ZH_GENERATION_LABELS = {
  dialog_pattern: "是否确认生成当前可用译文|检查到.*校对警告",
  continue_label: "继续生成",
  confirm_label: "确认",
};
const EN_GENERATION_LABELS = {
  dialog_pattern: "Confirm generating|Detected.*proofreading warning",
  continue_label: "Generate Anyway",
  confirm_label: "Confirm",
};

class VerifyFailure extends Error {}

/** 每个检查独立计数，失败不影响后续检查，便于一次运行拿到完整结论。 */
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

/** 轮询页面文本，等待界面进入预期状态。 */
async function wait_for_text(page, pattern, timeout_ms, description) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "u");
  const found = await wait_for(
    async () => {
      const text = await page.evaluate(() => document.body.innerText);
      return regex.test(text) ? text : false;
    },
    timeout_ms,
    description,
  );
  return found;
}

/** 合成最小 EPUB：mimetype + container + opf + 一章 xhtml。 */
async function create_epub_bytes() {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.file(
    "OPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata/>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`,
  );
  zip.file(
    "OPS/chapter.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><p>${EPUB_CHAPTER_TEXT}</p><p>第二章正文：夜色降临。</p></body>
</html>`,
  );
  return zip.generateAsync({ compression: "STORE", type: "nodebuffer" });
}

function list_chromium_processes() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("--user-data-dir=") && line.includes("lg-chromium-"));
}

function list_chromium_profiles() {
  try {
    return readdirSync(os.tmpdir()).filter((name) => name.startsWith("lg-chromium-"));
  } catch {
    return [];
  }
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

/** 点击按钮文字精确匹配的按钮；SPA 渲染期间允许重试。 */
async function click_button(page, name, timeout_ms = PAGE_TIMEOUT_MS) {
  const locator = page.getByRole("button", { name, exact: true });
  await locator.first().waitFor({ state: "visible", timeout: timeout_ms });
  await locator.first().click();
}

/**
 * 译文生成确认弹窗有两种形态：无校对警告时主按钮是“确认”，
 * 有警告时是“继续生成”。等待弹窗描述出现后点击实际存在的主按钮。
 */
async function confirm_generation(page, labels) {
  await wait_for_text(page, new RegExp(labels.dialog_pattern), 30_000, "译文生成确认弹窗");
  const text = await page.evaluate(() => document.body.innerText);
  const label = text.includes(labels.continue_label) ? labels.continue_label : labels.confirm_label;
  await click_button(page, label);
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
    switch (name) {
      case "keep":
        options.keep = value === "true";
        break;
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }
  return options;
}

async function main() {
  const options = parse_arguments(process.argv.slice(2));
  const report = new Report();
  const artifacts = mkdtempSync(path.join(os.tmpdir(), "lg-web-novel-loop-"));
  const data_root = path.join(artifacts, "data-root");
  const download_dir = path.join(artifacts, "downloads");
  mkdirSync(data_root, { recursive: true });
  mkdirSync(download_dir, { recursive: true });
  process.stdout.write(`[verify] 产物目录 ${artifacts}\n`);

  const service = new WebServiceProcess(
    spawn(process.execPath, [WEB_SERVER_ENTRY, "--port=0", `--data-root=${data_root}`], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  let browser = null;
  let cookie = "";
  try {
    const access = await wait_for(
      () => service.read_access(),
      SERVICE_START_TIMEOUT_MS,
      "Web 服务打印访问地址",
    );
    process.stdout.write(`[verify] Web 服务 ${access.baseUrl}\n`);

    const session = await fetch(`${access.baseUrl}/api/web/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: access.credential }),
    });
    cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    if (session.status !== 204 || cookie === "")
      throw new VerifyFailure(`Access session failed: HTTP ${session.status}`);
    report.pass("访问会话", `HTTP ${session.status}`);

    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    const console_errors = [];
    page.on("console", (message) => {
      // 资源加载失败由 failed_responses 按 URL 断言（可区分已知 GitHub 404），
      // 这里只收其余控制台错误，避免同一事件双算。
      if (message.type() !== "error") return;
      if (/Failed to load resource/u.test(message.text())) return;
      console_errors.push(message.text().slice(0, 200));
    });
    page.on("pageerror", (error) =>
      console_errors.push(`pageerror: ${error.message.slice(0, 200)}`),
    );
    // 更新检查指向本地仓库：fork 未发布 release 时 GitHub API 返回 404，
    // 浏览器把它记为一条资源加载错误（真实用户无感，仅在 devtools 可见）。
    // 这是 C2 决策后的预期行为，断言只关心除此以外的控制台错误。
    const failed_responses = [];
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().includes("api.github.com"))
        failed_responses.push(`${response.status()} ${response.url().slice(0, 140)}`);
    });

    // 1) 带凭据进入，等待应用外壳与工程页就绪。
    await page.goto(`${access.baseUrl}/#credential=${access.credential}`, {
      waitUntil: "networkidle",
    });
    await wait_for_text(page, /新建工程/, 30_000, "工程页渲染");
    report.pass("登录进入工程页", "无凭据页已越过");

    // 首启更新提示会遮挡界面：真实用户先取消，再继续业务流程。
    const cancel_update = page.getByRole("button", { name: "取消", exact: true }).first();
    try {
      await cancel_update.waitFor({ state: "visible", timeout: 25_000 });
      await cancel_update.click();
      report.pass("取消首启更新提示", "更新弹窗已关闭");
    } catch {
      report.pass("取消首启更新提示", "未出现更新提示");
    }

    // 2) 上传 EPUB：源文件卡片 → 选择文件 → 上传文件 → 选择。
    await page.getByText("点击或拖拽源文件").first().click();
    await wait_for_text(page, /选择文件/, 10_000, "源文件菜单");
    await page.getByText("选择文件", { exact: true }).last().click();
    await wait_for_text(page, /上传文件/, 10_000, "文件选择器打开");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: EPUB_NAME,
        mimeType: "application/epub+zip",
        buffer: await create_epub_bytes(),
      });
    await wait_for_text(page, new RegExp(EPUB_NAME), 30_000, "上传材料出现在列表");
    await click_button(page, "选择");
    await wait_for_text(page, /已选择\s*1\s*个源文件/, 30_000, "源文件摘要");
    report.pass("EPUB 上传与摘要", "摘要显示 1 个源文件");

    // 3) 创建工程：保存选择器切到“应用数据”根，工程落临时数据根内。
    await click_button(page, "创建工程");
    await wait_for_text(page, /选择保存位置/, 15_000, "保存选择器打开");
    await page.getByRole("button", { name: "应用数据", exact: true }).first().click();
    await wait_for_text(
      page,
      new RegExp(data_root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      15_000,
      "保存位置切换到数据根",
    );
    await click_button(page, "选择");
    await wait_for_text(page, /生成译文/, 60_000, "工程创建后进入应用");
    report.pass("工程创建", "保存选择器确认后进入应用");

    // 新建后应用落在 AGENT 页：显式进入工作台核对文件事实。
    await page.getByRole("button", { name: "工作台", exact: true }).first().click();
    await wait_for_text(page, new RegExp(EPUB_NAME), 60_000, "工作台显示 EPUB 文件");
    report.pass("工作台文件与条目", `文件表显示 ${EPUB_NAME}`);

    // 5) 生成译文并捕获浏览器下载。
    await click_button(page, "生成译文");
    await confirm_generation(page, ZH_GENERATION_LABELS);
    await wait_for_text(page, /下载译文/, 60_000, "下载清单出现");

    const first_download_link = page.locator("a[download]").first();
    const first_href = await first_download_link.getAttribute("href");
    const download_promise = page.waitForEvent("download", { timeout: PAGE_TIMEOUT_MS });
    await first_download_link.click();
    const first_download = await download_promise;
    const first_file = path.join(download_dir, first_download.suggestedFilename());
    await first_download.saveAs(first_file);
    const first_content = readFileSync(first_file, "utf8");
    report.pass(
      "译文下载（中文目录）",
      `${first_download.suggestedFilename()} ${first_content.length} 字节`,
    );
    if (!first_content.includes(EPUB_CHAPTER_TEXT))
      report.fail("译文下载（中文目录）", `文件内容不含 EPUB 正文：${first_content.slice(0, 120)}`);
    await click_button(page, "关闭");

    // 6) R-12：切换界面语言后重新生成，新语言目录可下载。
    await page.getByRole("button", { name: "字字珠玑", exact: true }).first().click();
    await wait_for_text(page, /English/, 10_000, "语言菜单");
    await page.getByText("English", { exact: true }).last().click();
    await wait_for_text(page, /Generate Translation/, 30_000, "界面语言切换");
    report.pass("界面语言切换", "侧栏语言菜单切换到 English");

    // 界面已全英文：按钮与弹窗改用英文标签定位。
    await click_button(page, "Generate Translation");
    await confirm_generation(page, EN_GENERATION_LABELS);
    await wait_for_text(page, /Download the translation/, 60_000, "英文下载清单");

    // R-12 决策 C：下载清单同时列出既有语言与新语言的输出文件。
    const output_links = page.locator("a[download]");
    const output_link_count = await output_links.count();
    report.pass("跨语言下载清单", `${output_link_count} 个文件`);
    if (output_link_count < 2)
      report.fail("跨语言下载清单", "切换语言后清单未包含既有语言的输出文件（决策 C 未生效）");
    const output_hrefs = await output_links.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") ?? ""),
    );
    if (typeof first_href === "string" && first_href !== "" && !output_hrefs.includes(first_href))
      report.fail("跨语言下载清单", "清单中找不到中文输出目录的文件");

    const english_link = page.locator("a[download]").first();
    const english_download_promise = page.waitForEvent("download", { timeout: PAGE_TIMEOUT_MS });
    await english_link.click();
    const english_download = await english_download_promise;
    const english_file = path.join(download_dir, `en-${english_download.suggestedFilename()}`);
    await english_download.saveAs(english_file);
    const english_content = readFileSync(english_file, "utf8");
    report.pass(
      "译文下载（英文目录）",
      `${english_download.suggestedFilename()} ${english_content.length} 字节`,
    );
    if (!english_content.includes(EPUB_CHAPTER_TEXT))
      report.fail(
        "译文下载（英文目录）",
        `文件内容不含 EPUB 正文：${english_content.slice(0, 120)}`,
      );
    await click_button(page, "Close");

    // 7) R-12 决策 C：切换语言后旧语言输出目录仍位于下载允许集内。
    if (typeof first_href === "string" && first_href !== "") {
      const stale = await fetch(first_href, { headers: { cookie } });
      report.pass("旧语言目录边界", `HTTP ${stale.status}`);
      if (stale.status !== 200)
        report.fail("旧语言目录边界", `切换语言后旧语言输出目录不可下载：HTTP ${stale.status}`);
    }

    report.pass(
      "浏览器控制台",
      console_errors.length === 0 && failed_responses.length === 0
        ? "零错误"
        : `${console_errors.length} 个错误 / ${failed_responses.length} 个失败请求`,
    );
    for (const error of console_errors.slice(0, 5)) process.stdout.write(`  - ${error}\n`);
    for (const failure of failed_responses.slice(0, 5)) process.stdout.write(`  - ${failure}\n`);
    if (console_errors.length > 0) report.fail("浏览器控制台", console_errors[0]);
    if (failed_responses.length > 0)
      report.fail("浏览器控制台", `失败请求：${failed_responses[0]}`);
  } catch (error) {
    report.fail("编排", error instanceof Error ? error.message : String(error));
    if (service.stderr !== "") process.stdout.write(`[service:err] ${service.stderr}\n`);
  } finally {
    if (browser !== null) await browser.close();
    await service.stop();
    if (service.stderr !== "") {
      process.stdout.write(`[service:err tail]\n${service.stderr.slice(-4_000)}\n`);
    }

    const processes = list_chromium_processes();
    const profiles = list_chromium_profiles();
    report.pass("进程与 profile 回收", `profile=${profiles.length} process=${processes.length}`);
    if (profiles.length > 0)
      report.fail("进程与 profile 回收", `残留 profile：${profiles.join(", ")}`);
    if (processes.length > 0)
      report.fail("进程与 profile 回收", `残留进程：${processes[0].slice(0, 160)}`);

    const exit_code = service.child.exitCode;
    report.pass("服务正常停止", `exitCode=${exit_code}`);
    if (exit_code !== 0) report.fail("服务正常停止", `exitCode=${exit_code}`);

    if (options.keep) process.stdout.write(`[verify] 保留产物目录 ${artifacts}\n`);
    else rmSync(artifacts, { recursive: true, force: true });
  }

  process.stdout.write("---- 汇总 ----\n");
  for (const result of report.results)
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.name}\n`);
  process.stdout.write(
    `通过 ${report.results.length - report.failed_count}/${report.results.length}\n`,
  );
  return report.failed_count === 0 ? 0 : 1;
}

process.exitCode = await main();
