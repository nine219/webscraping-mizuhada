/**
 * Opens the Instagram persistent-profile browser so you can log in once.
 * The session is saved to ~/.instagram-scraper-profile and reused by the scraper.
 *
 *   npx ts-node -r dotenv/config src/tools/instagram-login.ts dotenv_config_path=.env.local
 *
 * A Chrome window opens on Instagram. Log in (handle 2FA/checkpoint by hand).
 * The script polls for the session cookie and exits automatically once you're in
 * (or after 15 minutes). Leaves the saved session behind.
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const IG_PROFILE_DIR = path.join(os.homedir(), '.instagram-scraper-profile');
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHROME_PATHS = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

function findChrome(): string | undefined {
  const override = process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;
  return CHROME_PATHS.find((p) => fs.existsSync(p));
}

async function main() {
  if (!fs.existsSync(IG_PROFILE_DIR)) fs.mkdirSync(IG_PROFILE_DIR, { recursive: true });
  console.log(`[IG-login] Opening Instagram in persistent profile:\n  ${IG_PROFILE_DIR}`);

  const ctx = await chromium.launchPersistentContext(IG_PROFILE_DIR, {
    headless: false,
    executablePath: findChrome(),
    userAgent: DESKTOP_UA,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
    // --no-sandbox / --disable-setuid-sandbox required to launch as root in the
    // Docker scraper container (matches instagram-feed.ts launchContext args).
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--no-default-browser-check'],
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('[IG-login] Log in now. Waiting for session (up to 15 min)...');
  const deadline = Date.now() + 15 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://www.instagram.com');
    if (cookies.some((c) => c.name === 'sessionid' && c.value)) { loggedIn = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (loggedIn) {
    console.log('[IG-login] ✓ Logged in — session saved. You can close the window.');
    await page.waitForTimeout(3000);
  } else {
    console.warn('[IG-login] Timed out without a session cookie. Run again and finish logging in.');
  }
  await ctx.close().catch(() => {});
  process.exit(loggedIn ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
