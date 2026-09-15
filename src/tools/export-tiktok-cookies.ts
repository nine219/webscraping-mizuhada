/**
 * Opens TikTok in a real browser so you can log in manually.
 * Press Enter after login — all cookies (including HttpOnly) saved to .env.local as TIKTOK_COOKIES.
 *
 * Usage: npx ts-node -r dotenv/config src/tools/export-tiktok-cookies.ts dotenv_config_path=.env.local
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

async function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\n✅ Log into TikTok in the browser, then press Enter here to save cookies...\n', () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  console.log('[TikTokAuth] Launching browser...');

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
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    extraHTTPHeaders: { 'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8' },
  });

  await ctx.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['th-TH','th','en-US','en'] });
    window.chrome = { runtime: {} };
  `);

  const page = await ctx.newPage();
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded' });

  await waitForEnter();

  const cookies = await ctx.cookies('https://www.tiktok.com');
  console.log(`[TikTokAuth] Captured ${cookies.length} cookies`);

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

  if (envContent.includes('TIKTOK_COOKIES=')) {
    envContent = envContent.replace(/^TIKTOK_COOKIES=.*$/m, `TIKTOK_COOKIES=${cookieJson}`);
  } else {
    envContent += `\nTIKTOK_COOKIES=${cookieJson}\n`;
  }

  fs.writeFileSync(envPath, envContent, 'utf-8');
  console.log(`[TikTokAuth] ✓ Saved ${cookies.length} cookies to .env.local`);

  const hasSessionId = cookies.some((c) => c.name === 'sessionid');
  const hasMsToken  = cookies.some((c) => c.name === 'msToken');
  console.log(`[TikTokAuth] sessionid: ${hasSessionId ? '✓ present' : '✗ MISSING — not logged in?'}`);
  console.log(`[TikTokAuth] msToken:   ${hasMsToken  ? '✓ present' : '✗ MISSING'}`);

  if (!hasSessionId) {
    console.warn('\n⚠ sessionid is missing. Make sure you are fully logged in before pressing Enter.');
  } else {
    console.log('\n✓ Cookies look good. Run: npm run scrape:tiktok:comments');
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
