/**
 * Opens Xiaohongshu in a real browser so you can log in manually (QR / phone).
 * Press Enter after login — all cookies (including HttpOnly) saved to .env.local as XHS_COOKIES.
 *
 * Usage: npm run xhs:auth
 *   (= npx ts-node -r dotenv/config src/tools/export-xhs-cookies.ts dotenv_config_path=.env.local)
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

async function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\n✅ Log into xiaohongshu.com in the browser (QR or phone), then press Enter here to save cookies...\n', () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  console.log('[XhsAuth] Launching browser...');

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
  });

  await ctx.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en-US','en'] });
    window.chrome = { runtime: {} };
  `);

  const page = await ctx.newPage();
  await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });

  await waitForEnter();

  const cookies = await ctx.cookies('https://www.xiaohongshu.com');
  console.log(`[XhsAuth] Captured ${cookies.length} cookies`);

  const cookieJson = JSON.stringify(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ?? 'Lax',
    }))
  );

  const envPath = path.join(process.cwd(), '.env.local');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  if (envContent.includes('XHS_COOKIES=')) {
    envContent = envContent.replace(/^XHS_COOKIES=.*$/m, `XHS_COOKIES=${cookieJson}`);
  } else {
    envContent += `\nXHS_COOKIES=${cookieJson}\n`;
  }

  fs.writeFileSync(envPath, envContent, 'utf-8');
  console.log(`[XhsAuth] ✓ Saved ${cookies.length} cookies to .env.local (XHS_COOKIES)`);

  const hasWebSession = cookies.some((c) => c.name === 'web_session' && c.value);
  console.log(`[XhsAuth] web_session: ${hasWebSession ? '✓ present' : '✗ MISSING — not logged in?'}`);

  if (!hasWebSession) {
    console.warn('\n⚠ web_session is missing. Make sure you are fully logged in before pressing Enter.');
  } else {
    console.log('\n✓ Cookies look good. Run: npm run scrape:xhs:feed');
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
