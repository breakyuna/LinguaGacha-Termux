process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = require('/data/data/com.termux/files/home/.local/share/html-visual-check/node_modules/playwright-core');
const { launchOptions } = require('/data/data/com.termux/files/home/.local/share/html-visual-check/browser-config.cjs');

const base = process.argv[2] ?? 'http://127.0.0.1:8426';
const credential = process.argv[3] ?? '';
const output = process.argv[4] ?? '/data/data/com.termux/files/home/lg-web-mobile.png';
const width = Number(process.argv[5] ?? 390);
const height = Number(process.argv[6] ?? 844);

async function verifyPage() {
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const console_errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') console_errors.push(message.text().slice(0, 200));
    });
    page.on('pageerror', (error) => console_errors.push(`pageerror: ${error.message.slice(0, 200)}`));

    // 1) 无凭据访问：应停在访问凭据录入视图
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const gate_visible = await page.locator('.web-access-gate').count();
    console.log(`access gate without credential: ${gate_visible > 0}`);
    await page.screenshot({ path: `${output}.gate.png`, fullPage: true });

    // 2) 带凭据进入：全新上下文模拟用户首次打开完整链接
    await context.close();
    const credentialed_context = await browser.newContext({ viewport: { width, height } });
    const credentialed_page = await credentialed_context.newPage();
    credentialed_page.on('console', (message) => {
      if (message.type() === 'error') console_errors.push(message.text().slice(0, 200));
    });
    credentialed_page.on('pageerror', (error) => console_errors.push(`pageerror: ${error.message.slice(0, 200)}`));
    await credentialed_page.goto(`${base}/#credential=${credential}`, { waitUntil: 'networkidle' });
    await credentialed_page.waitForTimeout(5000);
    const hash_after = await credentialed_page.evaluate(() => window.location.hash);
    const title = await credentialed_page.title();
    const root_children = await credentialed_page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0);
    const gate_count = await credentialed_page.locator('.web-access-gate').count();
    const nav_count = await credentialed_page.locator('nav, aside, [data-slot="sidebar"]').count();
    const body_text = await credentialed_page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log(`hash cleared: ${hash_after === ''}`);
    console.log(`title: ${title}`);
    console.log(`root children: ${root_children}, gate: ${gate_count}, nav-ish nodes: ${nav_count}`);
    console.log(`body text: ${body_text.replace(/\n/g, ' | ').slice(0, 240)}`);
    await credentialed_page.screenshot({ path: output, fullPage: true });

    // 3) 深链接刷新：工程页应恢复
    await credentialed_page.goto(`${base}/project`, { waitUntil: 'networkidle' });
    await credentialed_page.waitForTimeout(4000);
    const deep_ok = await credentialed_page.evaluate(() => document.body.innerText.length > 50);
    const deep_gate = await credentialed_page.locator('.web-access-gate').count();
    console.log(`deep link /project rendered: ${deep_ok}, gate: ${deep_gate}`);
    await credentialed_page.screenshot({ path: `${output}.project.png`, fullPage: true });
    await credentialed_context.close();

    console.log(`console errors: ${console_errors.length}`);
    for (const error of console_errors.slice(0, 8)) console.log(`  - ${error}`);
  } finally {
    await browser.close();
  }
}

verifyPage().catch((error) => {
  console.error(error);
  process.exit(1);
});
