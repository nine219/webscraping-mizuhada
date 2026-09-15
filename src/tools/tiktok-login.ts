/**
 * Opens TikTok in the persistent-profile browser so you can log in once.
 * The session is saved to ~/.tiktok-scraper-profile and reused by all TikTok scrapers.
 *
 *   npx ts-node -r dotenv/config src/tools/tiktok-login.ts dotenv_config_path=.env.local
 *   npm run tiktok:login
 *
 * A Chrome window opens on TikTok. Log in manually (handle 2FA / QR code if prompted).
 * The script polls for the sessionid cookie and exits automatically once you're in
 * (or after 15 minutes). Leaves the saved session in the profile directory.
 *
 * Routes through tiktok-browser.ts's launchContext() rather than calling
 * chromium.launchPersistentContext() directly — this script used to have its
 * own duplicate launch call, which meant it wasn't covered by launchContext()'s
 * cross-process Postgres advisory lock (see that file's TIKTOK_PROFILE_LOCK_KEY
 * comment). Running this while the scheduler or API had a TikTok job in flight
 * collided immediately with Playwright's "Opening in existing browser session"
 * error instead of waiting its turn like every other entry point does.
 */

import { launchContext } from '../scrapers/tiktok/tiktok-browser';

async function main() {
  console.log('[TikTok-login] Opening TikTok in persistent profile...');

  const { ctx, cleanup } = await launchContext();
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Check if already logged in
  const existing = await ctx.cookies('https://www.tiktok.com');
  if (existing.some((c) => c.name === 'sessionid' && c.value)) {
    console.log('[TikTok-login] ✓ Already logged in — session is valid. Nothing to do.');
    await cleanup();
    process.exit(0);
  }

  console.log('[TikTok-login] Log in now. Waiting for session cookie (up to 15 min)...');
  const deadline = Date.now() + 15 * 60 * 1000;
  let loggedIn = false;

  while (Date.now() < deadline) {
    const cookies = await ctx.cookies('https://www.tiktok.com');
    if (cookies.some((c) => c.name === 'sessionid' && c.value)) { loggedIn = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (loggedIn) {
    console.log('[TikTok-login] ✓ Logged in — session saved to profile. Scrapers will reuse it.');
    await page.waitForTimeout(3000);
  } else {
    console.warn('[TikTok-login] Timed out without a session cookie. Run again and finish logging in.');
  }

  await cleanup();
  process.exit(loggedIn ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
