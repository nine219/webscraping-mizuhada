import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PoolClient } from 'pg';
import { socialPool } from '../../db/social-client';
// Windows UA on the dev host, undefined (native Linux UA) in the Docker
// scraper container — see desktop-ua.ts.
import { DESKTOP_UA } from '../desktop-ua';

// Shared Xiaohongshu browser/session layer — single source of truth for cookies,
// stealth context, and wall detection. Used by xhs-feed, xhs-search, xhs-comments.

export const PLATFORM_SLUG = 'xiaohongshu';
export const LABEL = '[Xiaohongshu]';

// Persistent Chrome profile — same idea as TikTok/Twitter (~/.tiktok-scraper-profile,
// ~/.twitter-scraper-profile). Lets an operator log in once via the Settings UI instead
// of managing XHS_COOKIES/XHS_COOKIE_HEADER env vars by hand.
export const XHS_PROFILE_DIR = path.join(os.homedir(), '.xhs-scraper-profile');

export interface XhsNote {
  id: string;
  title: string;
  desc: string;
  author: string;
  url: string;
  publishedAt?: string;
  // Extra metadata available from the list API
  xsecToken?: string;
  likes?: number;
  commentsCount?: number;  // interact_info.comment_count — real total on XHS
  collectsCount?: number;  // interact_info.collected_count
  sharesCount?: number;    // interact_info.share_count
  noteType?: string;       // 'video' | 'normal'
  coverUrl?: string;
  authorName?: string;
  authorAvatar?: string;
}

export interface XhsComment {
  id: string;
  content: string;
  user_info?: { nickname: string };
  create_time?: number | string;   // v2 comment API returns epoch ms
  like_count?: string | number;
  sub_comments?: XhsComment[];      // nested replies
}

// Own-brand profile pages — used by the feed scraper (brand's own notes).
// Paste each brand's xiaohongshu.com/user/profile/<id> URL.
export const XHS_ACCOUNTS: Array<{ brandSlug: string; handle: string }> = [
  { brandSlug: 'mizumi',        handle: 'https://www.xiaohongshu.com/user/profile/63e604ec0000000026007b62?xsec_token=&xsec_source=pc_search' },
  { brandSlug: 'gentle-colors', handle: 'https://www.xiaohongshu.com/user/profile/69049f940000000037002de2?xsec_token=ABGuy_PVuCz7wIpcgkqjWFyhiZIMrpc78fnxF1rCUhZ-c=&xsec_source=pc_search' },
];

// Display names of the accounts above, as they actually appear in XHS API
// responses (note_card.user.nickname) — search results carry no stable user ID,
// only the nickname, so this is what the search scraper matches against to skip
// posts already covered by the feed scraper. Confirmed from real search data:
// "MizuMi满水美". Gentle Colors' XHS display name isn't confirmed yet — add it
// here once we see a post from that account in search results.
export const XHS_OWN_ACCOUNT_NAMES = new Set([
  'MizuMi满水美',
]);

type XhsCookie = {
  name: string; value: string; domain: string; path: string;
  httpOnly: boolean; secure: boolean; sameSite: 'Lax' | 'None' | 'Strict';
};

// Parse a raw "name=value; name2=value2" cookie header into Playwright cookies.
// Values may contain '=' (base64), so split on the first '=' only.
function parseCookieHeader(header: string): XhsCookie[] {
  return header
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq).trim();
      const value = eq === -1 ? '' : pair.slice(eq + 1).trim();
      return { name, value, domain: '.xiaohongshu.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' as const };
    })
    .filter((c) => c.name && c.value);
}

export function loadXhsCookies(): XhsCookie[] {
  // Preferred: XHS_COOKIES JSON array. Fallback: XHS_COOKIE_HEADER raw string.
  const raw = process.env.XHS_COOKIES;
  if (raw && raw !== 'your_xhs_cookies_json_here') {
    try {
      return JSON.parse(raw) as XhsCookie[];
    } catch {
      console.warn(`${LABEL} XHS_COOKIES is not valid JSON — trying XHS_COOKIE_HEADER`);
    }
  }
  const header = process.env.XHS_COOKIE_HEADER;
  if (header && header.trim()) return parseCookieHeader(header.trim());
  return [];
}

export function hasXhsCookies(): boolean {
  return loadXhsCookies().length > 0 || hasPersistentProfile();
}

// The persistent profile only tolerates one Chrome instance at a time —
// launchPersistentContext throws "Opening in existing browser session" if a
// second launch overlaps a still-open one. XHS is triggered from both the
// api process (manual "Run Search"/"Feed Scrape" buttons) and the scheduler
// process — two separate pm2 processes can each launch this and race over
// the same profile dir, same failure class already fixed for Twitter/TikTok
// (see twitter-browser.ts's launchAndVerify). A Postgres advisory lock (both
// processes already share the social DB) serializes across processes; the
// in-process mutex below just avoids a DB round-trip for the common
// same-process case.
let launchLock: Promise<unknown> = Promise.resolve();

// Arbitrary fixed key — must stay stable across processes/restarts, and not
// collide with twitter-browser.ts's (918_273_645) or tiktok-browser.ts's
// (918_273_646).
const XHS_PROFILE_LOCK_KEY = 918_273_647;

async function acquireCrossProcessLock(): Promise<PoolClient> {
  const client = await socialPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [XHS_PROFILE_LOCK_KEY]);
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseCrossProcessLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [XHS_PROFILE_LOCK_KEY]);
  } finally {
    client.release();
  }
}

/**
 * Launch a persistent XHS browser context — the login-flow counterpart to
 * newStealthContext(). Reuses the same UA/locale/timezone/stealth args so
 * scraping behavior doesn't regress once a profile exists. Unlike
 * launchBrowser()+newStealthContext() (throwaway Browser + Context), this
 * launches directly into a persistent context (IS the context, no separate
 * Browser object) — mirrors chromium/twitter-browser.ts's launchContext().
 *
 * Mutexed both per-process and cross-process — see notes above. All 5
 * current call sites (xhs-feed.ts x2, xhs-search.ts, xhs-comments.ts) close
 * the returned context via `ctx.close()` in a `finally` block already, so
 * wrapping `close` here to also release the lock covers every caller with
 * no changes needed on their end.
 */
export async function launchPersistentContext(): Promise<BrowserContext> {
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve) => { release = resolve; });
  const previous = launchLock;
  launchLock = acquired;
  await previous;

  const dbLock = await acquireCrossProcessLock();

  if (!fs.existsSync(XHS_PROFILE_DIR)) {
    fs.mkdirSync(XHS_PROFILE_DIR, { recursive: true });
    console.log(`${LABEL} Profile created: ${XHS_PROFILE_DIR}`);
  }

  // Tracked outside the inner try so the outer catch can close it too — any
  // throw between launchPersistentContext() and returning used to leak the
  // Chrome process holding the profile-dir lock (nothing ever called
  // ctx.close() on that path), wedging every later launch until someone
  // manually killed it (same fix as twitter-browser.ts's launchAndVerify).
  let ctx: BrowserContext | undefined;
  try {
    ctx = await chromium.launchPersistentContext(XHS_PROFILE_DIR, {
      headless: false,
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
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

/**
 * Cheap on-disk probe — mirrors getTwitterSessionStatus() in twitter-search.ts.
 * Chrome/Chromium 122+ stores cookies at `<profile>/Default/Network/Cookies`;
 * older versions used `<profile>/Default/Cookies`. Existence (not mtime) is
 * enough to know "a persistent-profile login flow has been used here" — the
 * mtime-based freshness call happens in the /session route.
 */
export function hasPersistentProfile(): boolean {
  if (!fs.existsSync(XHS_PROFILE_DIR)) return false;
  const candidates = [
    path.join(XHS_PROFILE_DIR, 'Default', 'Network', 'Cookies'),
    path.join(XHS_PROFILE_DIR, 'Default', 'Cookies'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

// Legacy auth path — XHS originally had no persistent-profile concept, auth
// was 100% via these env vars. Checked only when no persistent profile
// exists yet, same fallback logic previously in admin.ts's inspectXhsCookies().
function inspectXhsEnvCookies(): { valid: boolean; hint: string } {
  const raw = process.env.XHS_COOKIES;
  if (!raw || raw === 'your_xhs_cookies_json_here') {
    if (process.env.XHS_COOKIE_HEADER) {
      return { valid: true, hint: 'XHS_COOKIE_HEADER env var set (legacy auth path).' };
    }
    return { valid: false, hint: 'No persistent profile and no XHS_COOKIES/XHS_COOKIE_HEADER set — click Log in to Xiaohongshu.' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { valid: true, hint: 'XHS_COOKIES env var set (legacy auth path).' };
    }
  } catch { /* fall through */ }
  return { valid: false, hint: 'XHS_COOKIES env var is set but not valid JSON.' };
}

/**
 * Probe the on-disk Cookies sqlite mtime, falling back to the legacy env-var
 * cookie check if no persistent profile exists yet. Moved here from
 * api/routes/xhs.ts so both the route (pre-split) and whichever process
 * actually holds the XHS profile (host, via queue-worker's periodic
 * self-check + 'login' job_type) can call it.
 */
export function getXhsSessionStatus(): { valid: boolean; profileDir: string; checkedAt: string; hint?: string } {
  const now = new Date().toISOString();
  if (hasPersistentProfile()) {
    const candidates = [
      path.join(XHS_PROFILE_DIR, 'Default', 'Network', 'Cookies'),
      path.join(XHS_PROFILE_DIR, 'Default', 'Cookies'),
    ];
    const cookieFile = candidates.find((p) => fs.existsSync(p));
    if (!cookieFile) {
      return { valid: false, profileDir: XHS_PROFILE_DIR, checkedAt: now, hint: 'Profile exists but no Cookies sqlite yet — click Log in to Xiaohongshu.' };
    }
    const stat = fs.statSync(cookieFile);
    const ageDays = (Date.now() - stat.mtimeMs) / (24 * 3_600_000);
    if (ageDays > 30) {
      return { valid: false, profileDir: XHS_PROFILE_DIR, checkedAt: now, hint: `Cookies last touched ${Math.round(ageDays)}d ago — re-login likely required.` };
    }
    return { valid: true, profileDir: XHS_PROFILE_DIR, checkedAt: now, hint: `Cookies file last written ${Math.round(ageDays * 24 * 60) / 60}h ago.` };
  }
  const envStatus = inspectXhsEnvCookies();
  return { valid: envStatus.valid, profileDir: XHS_PROFILE_DIR, checkedAt: now, hint: envStatus.hint };
}

// export async function launchBrowser(headless = process.env.XHS_DEBUG !== '1'): Promise<Browser> {
export async function launchBrowser(headless = false): Promise<Browser> {
  return chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

export async function newStealthContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    userAgent: DESKTOP_UA,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
  });

  const cookies = loadXhsCookies();
  if (cookies.length > 0) {
    await ctx.addCookies(cookies);
    console.log(`${LABEL} Injected ${cookies.length} auth cookies`);
  }
  return ctx;
}

// Prime the session by visiting the explore homepage before hitting profiles/search.
// Reduces anti-bot challenges on the first real navigation.
export async function warmUp(page: import('playwright').Page): Promise<void> {
  try {
    await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(4000 + Math.floor(Math.random() * 3000));
  } catch { /* best-effort */ }
}

// Classify the page state from its visible text.
export function detectWall(bodyText: string): 'login' | 'captcha' | 'ok' {
  if (bodyText.includes('登录') || bodyText.includes('注册')) return 'login';
  if (bodyText.includes('验证') || bodyText.includes('滑块') || bodyText.includes('captcha')) return 'captcha';
  return 'ok';
}

// ── Captcha handling ──────────────────────────────────────────────────────
// XHS "安全验证" — pick the images matching a Chinese prompt (semantic VQA).
// Detect by its panel-only text: 安全验证 / 换一换 (refresh) / 请选择…图片 / slider.
// These strings don't appear on normal note/feed/search pages, so a body-text
// check is a reliable detector without brittle DOM selectors.
export async function detectCaptcha(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const t = document.body?.innerText ?? '';
      return t.includes('安全验证')
        || t.includes('换一换')
        || t.includes('滑动验证')
        || (t.includes('请选择') && t.includes('图片'));
    });
  } catch {
    return false;
  }
}

// Called from 4 different scrape entry points (feed/search/comments x2) with
// no shared deadline — a PM2 cron run hitting captchas on several keywords
// in sequence could previously stack up 180s waits with no human present and
// silently hang 15+ minutes. This caps *total* manual-wait time across a
// "burst" of consecutive captcha encounters (idle-reset after
// BUDGET_IDLE_RESET_MS with no captcha seen, so a later, separate run still
// gets the full budget rather than a lifetime-exhausted one).
const CAPTCHA_BUDGET_MS = 5 * 60_000;
const CAPTCHA_BUDGET_IDLE_RESET_MS = 10 * 60_000;
let captchaBudgetWindowStart = 0;
let captchaBudgetUsedMs = 0;

// Headful: block until the human solves it (panel text disappears), up to
// timeoutMs or whatever's left of the run's shared captcha-wait budget,
// whichever is smaller.
export async function waitForManualCaptcha(page: Page, timeoutMs = 180_000): Promise<boolean> {
  const now = Date.now();
  if (now - captchaBudgetWindowStart > CAPTCHA_BUDGET_IDLE_RESET_MS) {
    captchaBudgetWindowStart = now;
    captchaBudgetUsedMs = 0;
  }
  if (captchaBudgetUsedMs >= CAPTCHA_BUDGET_MS) {
    console.warn(`${LABEL} Manual-wait budget (${CAPTCHA_BUDGET_MS / 1000}s) exhausted for this run — skipping wait, continuing (data may be partial).`);
    return false;
  }

  const budgetRemaining = CAPTCHA_BUDGET_MS - captchaBudgetUsedMs;
  const effectiveTimeout = Math.min(timeoutMs, budgetRemaining);
  const start = Date.now();
  console.warn(`${LABEL} ⚠ Captcha detected — please solve it in the browser window (waiting up to ${Math.round(effectiveTimeout / 1000)}s)...`);
  try {
    while (Date.now() - start < effectiveTimeout) {
      await page.waitForTimeout(2500);
      if (!(await detectCaptcha(page))) {
        console.log(`${LABEL} ✓ Captcha cleared — resuming.`);
        return true;
      }
    }
    console.warn(`${LABEL} Captcha not solved within timeout — continuing (data may be partial).`);
    return false;
  } finally {
    captchaBudgetUsedMs += Date.now() - start;
  }
}

// Auto-solve via a vision-LLM (Qwen2.5-VL on OpenRouter). Enabled with
// XHS_CAPTCHA_SOLVER=1. Lazy-imported to avoid pulling the LLM client unless used.
export async function solveCaptchaWithVlm(page: Page): Promise<boolean> {
  const { solveXhsCaptcha } = await import('./xhs-captcha-solver');
  return solveXhsCaptcha(page, detectCaptcha);
}

// Unified entry point: call after any navigation. Returns true if the page is
// clear to use (no captcha, or it was solved/cleared); false if blocked.
//
// Flow: try VLM auto-solve → if it fails, fall back to manual solve (XHS runs
// headful, so the operator can click the tiles). XHS_CAPTCHA_SOLVER=0 skips
// auto-solve and goes straight to manual. XHS_CAPTCHA_MANUAL=0 disables the
// manual fallback (headless / CI use).
export async function handleCaptcha(page: Page): Promise<boolean> {
  if (!(await detectCaptcha(page))) return true;

  if (process.env.XHS_CAPTCHA_SOLVER !== '0') {
    if (await solveCaptchaWithVlm(page).catch((e) => { console.warn(`${LABEL} solver error:`, e instanceof Error ? e.message : e); return false; })) {
      return true;
    }
    console.warn(`${LABEL} auto-solver failed — waiting for manual solve in the browser window.`);
  } else {
    console.log(`${LABEL} auto-solver disabled — waiting for manual solve.`);
  }

  if (process.env.XHS_CAPTCHA_MANUAL === '0') {
    console.warn(`${LABEL} XHS_CAPTCHA_MANUAL=0 — aborting instead of waiting.`);
    return false;
  }
  return waitForManualCaptcha(page);
}
