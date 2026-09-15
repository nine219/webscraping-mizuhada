/**
 * Opens Xiaohongshu in the persistent-profile browser so you can log in once.
 * The session is saved to the XHS profile dir (~/.xhs-scraper-profile, a named
 * Docker volume in the scraper-xhs container) and reused by all XHS scrapers.
 *
 *   npm run xhs:login
 *
 * In Docker this runs inside scraper-xhs under Xvfb + noVNC — open the noVNC URL
 * (see docker/scraper-login.sh), log in via QR/phone in the Chrome window, and
 * the script polls for the web_session cookie and exits automatically once you
 * are in (or after 15 minutes). Mirrors tiktok-login.ts.
 *
 * Unlike xhs:auth (export-xhs-cookies.ts, which writes XHS_COOKIES to
 * .env.local from a throwaway context), this populates the PERSISTENT profile —
 * the right shape for the per-platform profile volume in the Docker split.
 */

import { launchPersistentContext } from '../scrapers/xhs/xhs-browser';

async function main(): Promise<void> {
  console.log('[XHS-login] Opening Xiaohongshu in persistent profile...');

  const ctx = await launchPersistentContext();
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' }).catch(() => {});

  const hasSession = async (): Promise<boolean> => {
    const cookies = await ctx.cookies('https://www.xiaohongshu.com');
    return cookies.some((c) => c.name === 'web_session' && !!c.value);
  };

  if (await hasSession()) {
    console.log('[XHS-login] ✓ Already logged in — session is valid. Nothing to do.');
    await ctx.close();
    process.exit(0);
  }

  console.log('[XHS-login] Log in now (QR / phone). Waiting for web_session cookie (up to 15 min)...');
  const deadline = Date.now() + 15 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    if (await hasSession()) { loggedIn = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (loggedIn) {
    console.log('[XHS-login] ✓ Logged in — session saved to profile. Scrapers will reuse it.');
    await page.waitForTimeout(3000);
  } else {
    console.warn('[XHS-login] Timed out without web_session. Run again and finish logging in.');
  }

  await ctx.close();
  process.exit(loggedIn ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
