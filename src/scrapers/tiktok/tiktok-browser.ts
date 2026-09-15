/**
 * Shared TikTok browser utilities — used by feed, comments, and search scrapers.
 *
 * Auth: run `npm run tiktok:login` once to log in. The session is saved in the
 * persistent profile at ~/.tiktok-scraper-profile and reused automatically.
 * Falls back to TIKTOK_COOKIE_HEADER env var if the profile has no active session.
 *
 * Pattern mirrors instagram-feed.ts / instagram-login.ts.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PoolClient } from 'pg';
import { solveTikTokCaptcha } from './tiktok-captcha';
import { buildCookieHeader } from './tiktok-auth';
import { socialPool } from '../../db/social-client';

export const TIKTOK_PROFILE_DIR = path.join(os.homedir(), '.tiktok-scraper-profile');

// launchPersistentContext only tolerates one Chrome instance per profile dir
// at a time. The scheduler's cron jobs (feed/search/stats-refresh) and the
// API process (manual "Run Search Now", ad-hoc scrape, comment scrape,
// tiktok:login) are separate pm2 processes that all launch against the same
// default TIKTOK_PROFILE_DIR with no coordination between them — a manual
// trigger racing a cron tick can make two Chrome instances fight over the
// same --user-data-dir lock file. Twitter hit the identical bug
// (twitter-browser.ts) and was fixed with a Postgres advisory lock shared
// across processes; same fix ported here. Only applies to the *default*
// shared profile — callers passing a custom profileDir (parallel comment
// workers) already get isolation by having their own profile dir, so they
// skip this lock entirely.
const TIKTOK_PROFILE_LOCK_KEY = 918_273_646; // arbitrary, must not collide with twitter-browser.ts's key

async function acquireCrossProcessLock(): Promise<PoolClient> {
  const client = await socialPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [TIKTOK_PROFILE_LOCK_KEY]);
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseCrossProcessLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [TIKTOK_PROFILE_LOCK_KEY]);
  } finally {
    client.release();
  }
}

// Shared UA: Windows string on the dev host, undefined (native Linux UA) in
// the Docker scraper container — see desktop-ua.ts for why.
import { DESKTOP_UA } from '../desktop-ua';

const CHROME_PATHS: string[] = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

export function findChrome(): string | null {
  const override = process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;
  return CHROME_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Probe the on-disk Cookies sqlite mtime — no Chrome launch (would fight an
 * in-progress login window). Moved here from api/routes/tiktok.ts so both
 * the `api` route (pre-Docker-split) and the scraper-tiktok container
 * (queue-worker's periodic self-check + 'login' job_type) can call it — only
 * the latter can actually see this file now that api has no browser.
 */
export function getTikTokSessionStatus(): { valid: boolean; profileDir: string; checkedAt: string; hint?: string } {
  const now = new Date().toISOString();
  const candidates = [
    path.join(TIKTOK_PROFILE_DIR, 'Default', 'Network', 'Cookies'),
    path.join(TIKTOK_PROFILE_DIR, 'Default', 'Cookies'),
  ];
  if (!fs.existsSync(TIKTOK_PROFILE_DIR)) {
    return { valid: false, profileDir: TIKTOK_PROFILE_DIR, checkedAt: now, hint: 'Profile not initialised — click Log in to TikTok.' };
  }
  const cookieFile = candidates.find((p) => fs.existsSync(p));
  if (!cookieFile) {
    return { valid: false, profileDir: TIKTOK_PROFILE_DIR, checkedAt: now, hint: 'No Cookies sqlite yet — click Log in to TikTok.' };
  }
  const stat = fs.statSync(cookieFile);
  const ageDays = (Date.now() - stat.mtimeMs) / (24 * 3_600_000);
  if (ageDays > 30) {
    return { valid: false, profileDir: TIKTOK_PROFILE_DIR, checkedAt: now, hint: `Cookies last touched ${Math.round(ageDays)}d ago — re-login likely required.` };
  }
  return { valid: true, profileDir: TIKTOK_PROFILE_DIR, checkedAt: now, hint: `Cookies file last written ${Math.round(ageDays * 24 * 60) / 60}h ago.` };
}

// The Postgres advisory lock above only proves no OTHER process is trying to
// launch right now — it says nothing about whether the PREVIOUS holder's
// actual chrome.exe (plus its child renderer/GPU processes) has fully torn
// down yet. cleanup() releases the lock right after `ctx.close()` resolves,
// but on Windows that resolution can race ahead of real OS-level process
// exit by up to a couple seconds, especially with many subprocesses. A
// second launch can lose to Chrome's own singleton check in that window even
// though the lock says "free" — reproduced directly: pg_try_advisory_lock
// returned true (unlocked) while a previous launch's chrome.exe was still
// alive, and the very next launchPersistentContext() call still hit
// "Opening in existing browser session." Retrying the launch itself (not
// just the lock) is what actually closes this gap.
// ~60s total budget — matches this file's existing "wait 60s between brands"
// pacing convention elsewhere in the search scraper, since real Chrome
// teardown (full process tree: renderer/GPU/utility subprocesses) competing
// with other Chrome instances on the same machine can genuinely take longer
// than a couple seconds, not just a brief race.
const LAUNCH_RETRY_ATTEMPTS = 15;
const LAUNCH_RETRY_DELAY_MS = 4_000;

async function launchWithRetry(profileDir: string, chromePath: string | null): Promise<BrowserContext> {
  const opts = {
    headless: false,
    executablePath: chromePath ?? undefined,
    userAgent: DESKTOP_UA,
    viewport: { width: 1280, height: 800 },
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
    ],
  };

  for (let attempt = 1; attempt <= LAUNCH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await chromium.launchPersistentContext(profileDir, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSingletonClash = msg.includes('Opening in existing browser session');
      if (!isSingletonClash || attempt === LAUNCH_RETRY_ATTEMPTS) throw err;
      console.warn(`  [browser] Profile still tearing down from a previous session (attempt ${attempt}/${LAUNCH_RETRY_ATTEMPTS}) — retrying in ${LAUNCH_RETRY_DELAY_MS}ms...`);
      await new Promise((r) => setTimeout(r, LAUNCH_RETRY_DELAY_MS));
    }
  }
  throw new Error('unreachable'); // loop always returns or throws
}

/**
 * Launch a persistent TikTok browser context.
 *
 * profileDir defaults to the shared main profile (~/.tiktok-scraper-profile).
 * Pass a custom dir for parallel comment workers so each worker has an independent
 * TikTok rate-limit bucket without fighting over the same profile lock.
 */
export async function launchContext(
  profileDir = TIKTOK_PROFILE_DIR,
): Promise<{ ctx: BrowserContext; cleanup: () => Promise<void> }> {
  const usesSharedProfile = profileDir === TIKTOK_PROFILE_DIR;
  const dbLock = usesSharedProfile ? await acquireCrossProcessLock() : undefined;

  try {
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
      if (profileDir === TIKTOK_PROFILE_DIR) {
        console.log(`  [browser] Profile created: ${profileDir}`);
        console.log(`  [browser] First run: log in via 'npm run tiktok:login'`);
      }
    }

    const chromePath = findChrome();
    const ctx = await launchWithRetry(profileDir, chromePath);

    await ctx.addInitScript(`
      Object.defineProperty(navigator,'webdriver',{get:()=>false});
      Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
      window.chrome={runtime:{}};
    `);

    // Cookie fallback: inject TIKTOK_COOKIE_HEADER if the profile has no active session.
    const header = buildCookieHeader();
    if (header) {
      const existing = await ctx.cookies('https://www.tiktok.com');
      if (!existing.some((c) => c.name === 'sessionid' && c.value)) {
        const cookies = header.split(';').flatMap((part) => {
          const eqIdx = part.indexOf('=');
          if (eqIdx === -1) return [];
          const name  = part.slice(0, eqIdx).trim();
          const value = part.slice(eqIdx + 1).trim();
          if (!name || !value) return [];
          return [{ name, value, domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' as const }];
        });
        try { await ctx.addCookies(cookies); } catch { /* ignore stale */ }
        console.log(`  [browser] No session in profile — injected ${cookies.length} cookies from env`);
      } else {
        console.log('  [browser] Profile has active session');
      }
    } else {
      console.warn('  [browser] No session and no TIKTOK_COOKIE_HEADER — run: npm run tiktok:login');
    }

    return {
      ctx,
      cleanup: async () => {
        try { await ctx.close(); } catch { /* ignore */ }
        if (dbLock) await releaseCrossProcessLock(dbLock);
      },
    };
  } catch (err) {
    if (dbLock) await releaseCrossProcessLock(dbLock);
    throw err;
  }
}

/** Open tiktok.com home page before the real task to prime the session. */
export async function warmUp(ctx: BrowserContext): Promise<void> {
  try {
    const page = await ctx.newPage();
    await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(3_000);
    await solveCaptcha(page);
    await page.close();
    console.log('  [browser] Warm-up done');
  } catch { /* ignore */ }
}

/** Returns true if TikTok has NOT redirected to the login page. */
export function isSessionValid(page: Page): boolean {
  const url = page.url();
  return !url.includes('/login') && !url.includes('loginType');
}

export async function solveCaptcha(page: Page): Promise<boolean> {
  return solveTikTokCaptcha(page);
}
