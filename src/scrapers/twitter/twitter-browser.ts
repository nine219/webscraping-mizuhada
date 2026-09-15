/**
 * Shared Twitter/X browser layer — mirrors the TikTok/XHS pattern.
 *
 * Persistent Chrome profile at ~/.twitter-scraper-profile stores the session
 * once the operator logs in manually via `npm run twitter:login`. All later
 * scraping runs read that profile, so no credentials live in the codebase and
 * no login flow ever runs unattended (which is what Cloudflare-fingerprinted
 * headless attempts on top of).
 *
 * Env
 *   TWITTER_HEADLESS  headless mode (default: false — see notes below)
 *   TWITTER_PROFILE   override the profile dir (default ~/.twitter-scraper-profile)
 *
 * Note on headless: X detects headless Chrome via various fingerprints. Keep
 * false unless you swap to playwright-extra + stealth plugin.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, BrowserContext, Page } from 'playwright';
import type { PoolClient } from 'pg';
import { socialPool } from '../../db/social-client';

export const LABEL = '[Twitter]';
export const TWITTER_PROFILE_DIR = process.env.TWITTER_PROFILE
  || path.join(os.homedir(), '.twitter-scraper-profile');

// Windows UA on the dev host, undefined (native Linux UA) in the Docker
// scraper container — see desktop-ua.ts. Keeps UA consistent with the runtime
// platform, which matters most for X's aggressive fingerprinting.
import { DESKTOP_UA as UA } from '../desktop-ua';

function findChrome(): string | undefined {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * Launch a persistent context that reuses the local X login. Returns the
 * context so callers can open pages, add response listeners, etc.
 */
export async function launchContext(): Promise<BrowserContext> {
  if (!fs.existsSync(TWITTER_PROFILE_DIR)) {
    fs.mkdirSync(TWITTER_PROFILE_DIR, { recursive: true });
    console.log(`${LABEL} Profile created: ${TWITTER_PROFILE_DIR}`);
  }
  const ctx = await chromium.launchPersistentContext(TWITTER_PROFILE_DIR, {
    headless: process.env.TWITTER_HEADLESS === '1',
    executablePath: findChrome(),
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  return ctx;
}

/**
 * Cheap validity probe. X redirects unauthenticated /home traffic to the
 * login flow; if we stay on /home the session is good.
 */
export async function isSessionValid(page: Page): Promise<boolean> {
  try {
    const r = await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!r) return false;
    const url = page.url();
    if (url.includes('/i/flow/login') || url.includes('/login')) return false;
    // Auth-required cookie set on successful login. Look for it in either domain.
    const cookies = await page.context().cookies(['https://x.com', 'https://twitter.com']);
    return cookies.some((c) => c.name === 'auth_token' && !!c.value);
  } catch {
    return false;
  }
}

// The persistent profile only tolerates one Chrome instance at a time —
// launchPersistentContext throws "Opening in existing browser session" if a
// second launch overlaps a still-open one. cron.ts's withLock only guards
// against overlap *within its own process*; the API server (campaigns.ts
// track-link / scrape-now / search-x) is a separate pm2 process from the
// scheduler, so an in-process-only mutex isn't enough — a manual "Search X"
// click racing the scheduler's own 3h/6h Twitter cron ticks was observed to
// pop the visible Chrome window open/closed and bounce to unrelated pages,
// consistent with two processes fighting over the same profile. Fixed with a
// Postgres session-level advisory lock (both processes already share the
// social DB) layered on top of the existing in-process mutex below — the DB
// lock is the one that actually serializes across processes; the in-process
// mutex just avoids opening a Postgres connection for the common case where
// the queue is empty.
let launchLock: Promise<unknown> = Promise.resolve();

// Arbitrary fixed key — must stay stable across processes/restarts, only
// needs to not collide with any other pg_advisory_lock key this app uses
// (none currently exist).
const TWITTER_PROFILE_LOCK_KEY = 918_273_645;

// Exported (unlike tiktok/instagram/xhs's equivalents) because the login
// flow needs it too: it must use the raw, unlocked launchContext() below
// (launchAndVerify() throws when the session is invalid, which is exactly
// the case a login flow exists to handle) but still needs the same
// cross-process lock — see the 'login' job_type in scraper-runtime/queue-worker.ts.
export async function acquireCrossProcessLock(): Promise<PoolClient> {
  const client = await socialPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [TWITTER_PROFILE_LOCK_KEY]);
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

export async function releaseCrossProcessLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [TWITTER_PROFILE_LOCK_KEY]);
  } finally {
    client.release();
  }
}

/**
 * Convenience wrapper used by scrapers: launch, sanity-check the session,
 * throw if login is required. Mutexed both per-process and cross-process —
 * see notes above.
 */
export async function launchAndVerify(): Promise<BrowserContext> {
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve) => { release = resolve; });
  const previous = launchLock;
  launchLock = acquired;
  await previous;

  const dbLock = await acquireCrossProcessLock();

  // Tracked outside the inner try so the outer catch can close it too —
  // any throw between launchContext() and the "ok" check used to leak the
  // Chrome process holding the profile-dir lock (nothing ever called
  // ctx.close() on that path), wedging every later launch until someone
  // manually killed it.
  let ctx: BrowserContext | undefined;
  try {
    ctx = await launchContext();
    const page = await ctx.newPage();
    const ok = await isSessionValid(page);
    await page.close();
    if (!ok) {
      await ctx.close();
      throw new Error('Twitter session invalid — run `npm run twitter:login` first');
    }
    const originalClose = ctx.close.bind(ctx);
    ctx.close = async () => {
      try {
        await originalClose();
      } finally {
        release();
        await releaseCrossProcessLock(dbLock);
      }
    };
    return ctx;
  } catch (err) {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
    release();
    await releaseCrossProcessLock(dbLock);
    throw err;
  }
}
