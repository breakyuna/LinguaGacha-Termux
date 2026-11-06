process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = require('/data/data/com.termux/files/home/.local/share/html-visual-check/node_modules/playwright-core');
const { launchOptions } = require('/data/data/com.termux/files/home/.local/share/html-visual-check/browser-config.cjs');

const base = process.argv[2] ?? 'http://127.0.0.1:8427';
const credential = process.argv[3] ?? '';
const output_prefix = process.argv[4] ?? '/data/data/com.termux/files/home/lg-web';

async function verifyPages() {
  const browser = await chromium.launch(launchOptions);
  const failures = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const console_errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') console_errors.push(message.text().slice(0, 160));
    });
    page.on('pageerror', (error) => console_errors.push(`pageerror: ${error.message.slice(0, 160)}`));
    await page.goto(`${base}/#credential=${credential}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);

    async function open_sidebar_item(label) {
      await page.locator('button', { hasText: label }).first().click();
    }

    const pages = [
      { label: '模型管理', name: 'model', expect: /模型|Model/ },
      { label: 'AGENT', name: 'agent', expect: /AGENT|对话/ },
      { label: '基础设置', name: 'basic-settings', expect: /语言|设置|Language/ },
      { label: '日志', name: 'logs', expect: /日志|Log/ },
    ];

    for (const target of pages) {
      await open_sidebar_item(target.label);
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const has_failure = /加载失败|内容暂不可用/.test(text);
      const has_expected = target.expect.test(text);
      console.log(`${target.name}: expected=${has_expected} failureText=${has_failure} length=${text.length}`);
      if (has_failure) failures.push(`${target.name} shows failure text`);
      await page.screenshot({ path: `${output_prefix}-${target.name}.png`, fullPage: false });
    }

    // 日志窗口模式
    const log_page = await context.newPage();
    await log_page.goto(`${base}/?window=logs`, { waitUntil: 'networkidle' });
    await log_page.waitForTimeout(3000);
    const log_text = await log_page.evaluate(() => document.body.innerText.slice(0, 200));
    const log_gate = await log_page.locator('.web-access-gate').count();
    console.log(`log window: gate=${log_gate} text=${log_text.replace(/\n/g, ' | ').slice(0, 120)}`);
    await log_page.screenshot({ path: `${output_prefix}-log-window.png`, fullPage: false });

    // 刷新恢复：同一文档重新加载后应回到应用而不是凭据页
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3500);
    const gate_after_reload = await page.locator('.web-access-gate').count();
    const reload_text_length = await page.evaluate(() => document.body.innerText.length);
    console.log(`after reload: gate=${gate_after_reload} textLength=${reload_text_length}`);
    if (gate_after_reload > 0) failures.push('reload fell back to the access gate');

    console.log(`console errors: ${console_errors.length}`);
    for (const error of console_errors.slice(0, 6)) console.log(`  - ${error}`);
    if (failures.length > 0) {
      console.log(`FAILURES: ${failures.join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

verifyPages().catch((error) => {
  console.error(error);
  process.exit(1);
});
