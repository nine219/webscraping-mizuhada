import { Browser, BrowserContext, Page } from 'playwright';
import { BaseSocialScraper, RawSocialPost } from './base-social';
import { matchBrandSlugXhs } from '../keywords';
import { scrapeNoteComments, commentsEnabled, fetchNoteDetail } from './xhs-comments';
import { upsertXhsPost, loadXhsBrandIds } from './xhs-db';
import { socialQuery as query } from '../../db/social-client';
import { filterIrrelevantPosts } from '../../validators/brand-relevance';
import { getKeywords, getThresholds } from '../../config/settings-loader';
import {
  PLATFORM_SLUG, LABEL, XhsNote,
  launchBrowser, newStealthContext, detectWall, hasXhsCookies, warmUp, handleCaptcha,
  launchPersistentContext, hasPersistentProfile, XHS_OWN_ACCOUNT_NAMES,
} from './xhs-browser';

// Fallback defaults when settings.thresholds.scrapeLimits.xhsSearch isn't loaded yet.
const SCROLL_ROUNDS = 20;
const SCROLL_WAIT_MS = 2_500;
const PAGE_LOAD_WAIT_MS = 5_000;

// ── Cooperative cancellation ─────────────────────────────────────────────────
// Same pattern as tiktok-search.ts's ScrapeCancelledError/ShouldCancel — a
// manual "Stop" click (POST /api/scrape/stop/:jobId) sets job.cancelRequested;
// the scraper polls it between steps (keyword/scroll/detail-fetch/comment) and
// unwinds via this error instead of leaving startScrapeJob's generic catch to
// log it as a hard failure.

/** Thrown to unwind out of a run once the user requests a stop. */
export class ScrapeCancelledError extends Error {
  constructor() {
    super('Scrape cancelled by user');
    this.name = 'ScrapeCancelledError';
  }
}

export type ShouldCancel = () => boolean;

/** Cancellable sleep — checks `shouldCancel` every second instead of blocking the full duration. */
async function cancellableSleep(ms: number, shouldCancel?: ShouldCancel): Promise<void> {
  const step = 1_000;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldCancel?.()) throw new ScrapeCancelledError();
    const chunk = Math.min(step, ms - elapsed);
    await new Promise((r) => setTimeout(r, chunk));
    elapsed += chunk;
  }
}

// Search API sends title only, never desc (confirmed empirically — see CONTEXT).
// For own-brand-targeted keywords (not generic category terms), a title-only
// miss is usually a real mention hiding in the caption body, not noise — visit
// the note to check before dropping it.
//
// Was a flat cap of 30 — silently dropping the vast majority of real mentions
// for any keyword with real volume. Live test (2026-07-23), keyword "mizumi":
// 406 candidate notes, 381 title-only misses, only the first 30 ever got
// checked, 26/30 (87%) turned out to be real mentions once the actual caption
// was read. Extrapolated, the old cap was likely dropping several hundred
// genuine mentions from this one keyword alone.
//
// Below DETAIL_FETCH_FULL_THRESHOLD misses, check every single one — no blind
// spot for the common case. Only a genuinely high-volume outlier (a brand's
// own bare name is the realistic worst case) gets throttled, at
// DETAIL_FETCH_HARD_CAP — bounds worst-case run time (each fetch is a real
// page visit + 1.5-3s delay) without reintroducing the original blind spot
// for anything short of an extreme case. Override without a redeploy via env var.
const DETAIL_FETCH_FULL_THRESHOLD = 200;
const DETAIL_FETCH_HARD_CAP = parseInt(process.env.XHS_MAX_DETAIL_FETCH ?? '500', 10);

// XHS note IDs are MongoDB ObjectIDs: first 8 hex chars = Unix timestamp (seconds).
function noteIdTimestampMs(id: string): number {
  const hex = id.slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(hex)) return 0;
  return parseInt(hex, 16) * 1000;
}

// ── XHS search-notes response shape ──────────────────────────────────────────
interface XhsSearchItem {
  id: string;
  xsec_token?: string;
  note_card?: {
    display_title?: string;
    desc?: string;
    type?: string;
    user?: { nickname?: string; nick_name?: string; avatar?: string };
    time?: string;
    interact_info?: { liked_count?: string; comment_count?: string; collected_count?: string; shared_count?: string };
    cover?: { url_default?: string; url_pre?: string };
  };
}

interface XhsSearchResponse {
  data?: { items?: XhsSearchItem[] };
}

function toInt(v?: string): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── Diagnostic summary for a 0-result run ────────────────────────────────────
interface KeywordRunStats {
  collected: number;
  apiHits: number;
  apiAuthDenied: number;
  sawAnySnsApi: boolean;
}

function logKeywordResult(keyword: string, s: KeywordRunStats): void {
  if (s.collected > 0) {
    console.log(`${LABEL}   "${keyword}": ${s.collected} notes (api hits=${s.apiHits})`);
    return;
  }
  if (s.apiAuthDenied > 0) {
    console.warn(`${LABEL} "${keyword}": 0 notes — auth was denied ${s.apiAuthDenied}× (refresh XHS_COOKIES; see CN_SOCIAL_SETUP.md).`);
  } else if (s.apiHits === 0 && !s.sawAnySnsApi) {
    console.warn(`${LABEL} "${keyword}": 0 notes — NO XHS API calls observed (page likely blocked by anti-bot before requests fired).`);
  } else if (s.apiHits === 0 && s.sawAnySnsApi) {
    console.warn(`${LABEL} "${keyword}": 0 notes — saw other /api/sns/ traffic but never the search-notes endpoint (XHS may have shifted the path).`);
  } else {
    console.warn(`${LABEL} "${keyword}": 0 notes — ${s.apiHits} search-notes call(s) succeeded but returned empty items (genuine no-result OR shape change).`);
  }
}

// ── Note item → XhsNote ──────────────────────────────────────────────────────
function parseSearchItem(item: XhsSearchItem): XhsNote | null {
  if (!item?.id) return null;
  const card = item.note_card ?? {};
  return {
    id: item.id,
    title: card.display_title ?? '',
    desc: card.desc ?? '',
    author: card.user?.nickname ?? card.user?.nick_name ?? '',
    url: `https://www.xiaohongshu.com/explore/${item.id}`,
    publishedAt: card.time,
    xsecToken: item.xsec_token,
    likes: toInt(card.interact_info?.liked_count),
    commentsCount: toInt(card.interact_info?.comment_count),
    collectsCount: toInt(card.interact_info?.collected_count),
    sharesCount: toInt(card.interact_info?.shared_count),
    noteType: card.type,
    coverUrl: card.cover?.url_default ?? card.cover?.url_pre,
    authorName: card.user?.nickname ?? card.user?.nick_name,
    authorAvatar: card.user?.avatar,
  };
}

// ── Scroll the search page until results stop coming in ──────────────────────
// `earlyStop` — optional predicate; when it returns true (e.g. old posts found
// with sort=time_descending), scrolling stops immediately.
async function scrollUntilStale(page: Page, getCount: () => number, earlyStop?: () => boolean, maxScrolls = SCROLL_ROUNDS, shouldCancel?: ShouldCancel): Promise<void> {
  let prev = 0;
  let staleRounds = 0;
  for (let i = 0; i < maxScrolls; i++) {
    if (shouldCancel?.()) throw new ScrapeCancelledError();
    // XHS redirects off /search_result to a verify wall after a few scrolls.
    // Notes already captured via API by then — stop and keep what we have.
    if (!page.url().includes('/search_result')) {
      console.warn(`${LABEL} redirected off search after ${i} scroll(s) — keeping ${getCount()}`);
      return;
    }
    if (earlyStop?.()) {
      console.log(`${LABEL} early stop after ${i} scroll(s) — past sinceMs window — keeping ${getCount()}`);
      return;
    }
    // document.body can be transiently null between navigations (same class of
    // issue as the bodyText check in collectNotesForKeyword) — skip this scroll
    // tick instead of throwing and aborting the whole keyword.
    await page.evaluate(() => { if (document.body) window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
    await page.waitForTimeout(SCROLL_WAIT_MS);
    let cur = getCount();
    if (cur === prev) {
      staleRounds++;
      // Before declaring terminal-stale, give lazy-load one more longer beat —
      // a slow batch can land just after the wait (mirrors xhs-feed.ts's
      // scroll loop, which had this guard but this search path didn't,
      // causing search results to under-collect vs the feed scraper whenever
      // XHS's lazy-load timing ran slow).
      if (staleRounds < 3) {
        await page.waitForTimeout(SCROLL_WAIT_MS);
        cur = getCount();
      }
      if (cur === prev && staleRounds >= 3) return;
      if (cur > prev) staleRounds = 0;
    } else {
      staleRounds = 0;
    }
    prev = cur;
  }
}

// ── XHS search filter helpers ──────────────────────────────────────────
// XHS SPA always sends sort="general" regardless of URL params. The actual
// sort and filters live in the `filters` array of the POST body, injected
// by route interception (see below).
//
// Available sort values (from XHS JS enum):
//   general (综合), time_descending (最新), popularity_descending (热门)
//
// Available filter_note_type tags (hardcoded, confirmed from page HTML):
//   不限/全部 (all), 视频 (video), 图文 (image-text)
//
// Available filter_note_time tags (from XHS filters API):
//   不限, 一天内(1d), 一周内(7d), 一月内(30d), 半年内(180d)
//
// Available filter_note_range tags (from XHS filters API):
//   不限, 看过 (viewed), 未看过 (not viewed) — common values, verify via UI
//
// Available filter_pos_distance tags (from XHS filters API):
//   不限, 10km, 50km, 100km — common values, verify via UI
//
// All filter defaults can be overridden via env vars:
//   XHS_SEARCH_SORT, XHS_FILTER_NOTE_TYPE, XHS_FILTER_NOTE_RANGE,
//   XHS_FILTER_POS_DISTANCE

const ENV_SORT  = () => process.env.XHS_SEARCH_SORT || 'time_descending';
const ENV_TYPE  = () => process.env.XHS_FILTER_NOTE_TYPE || '不限';
const ENV_RANGE = () => process.env.XHS_FILTER_NOTE_RANGE || '不限';
const ENV_DIST  = () => process.env.XHS_FILTER_POS_DISTANCE || '不限';

// Map sinceMs (ms timestamp) to the closest XHS filter_note_time label.
function timeFilterLabel(sinceMs: number): string {
  if (sinceMs <= 0) return '不限';
  const hoursAgo = (Date.now() - sinceMs) / 3_600_000;
  if (hoursAgo <= 24) return '一天内';
  if (hoursAgo <= 7 * 24) return '一周内';
  if (hoursAgo <= 30 * 24) return '一月内';
  return '半年内';
}

// Build the filters array for the XHS search API POST body.
// Each entry matches what XHS SPA sends when the corresponding UI filter
// dropdown is set to a specific value.
function buildSearchFilters(sortValue: string, sinceMs: number): Array<{ tags: string[]; type: string }> {
  return [
    { tags: [sortValue],            type: 'sort_type' },
    { tags: [ENV_TYPE()],           type: 'filter_note_type' },
    { tags: [timeFilterLabel(sinceMs)], type: 'filter_note_time' },
    { tags: [ENV_RANGE()],          type: 'filter_note_range' },
    { tags: [ENV_DIST()],           type: 'filter_pos_distance' },
  ];
}

// ── Scrape XHS search results for one keyword ────────────────────────────────
// sinceMs: only keep notes published after this timestamp (ms). 0 = no filter.
export async function collectNotesForKeyword(page: Page, keyword: string, sinceMs = 0, maxScrolls = SCROLL_ROUNDS, shouldCancel?: ShouldCancel): Promise<XhsNote[]> {
  const encoded = encodeURIComponent(keyword);
  const sortValue = ENV_SORT();
  const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encoded}`;
  // Windows PM2 console mangles non-ASCII display. Log the encoded URL form too —
  // that bypasses console encoding and shows whether the actual string is intact.
  const timeLabel = timeFilterLabel(sinceMs);
  console.log(`${LABEL} Searching: ${keyword} (encoded=${encoded}, sort=${sortValue}, time=${timeLabel}, since=${sinceMs ? new Date(sinceMs).toISOString().slice(0, 19) : 'any'})`);

  const collected = new Map<string, XhsNote>();
  // Track the newest note timestamp seen across all API responses, so we can
  // detect when the search scrolls past the sinceMs window and stop early.
  let anyOldPostFound = false;
  const stats: KeywordRunStats = { collected: 0, apiHits: 0, apiAuthDenied: 0, sawAnySnsApi: false };

  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (url.includes('/api/sns/')) {
      stats.sawAnySnsApi = true;
      if (process.env.XHS_DEBUG === '1') {
        console.log(`${LABEL} [sns] ${resp.status()} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      }
    }
    if (!resp.ok()) {
      if ((resp.status() === 461 || resp.status() === 401 || resp.status() === 403) && url.includes('/api/sns/')) {
        stats.apiAuthDenied++;
        console.warn(`${LABEL} Auth denied (${resp.status()}) on ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      }
      return;
    }
    // XHS shifts the search-notes path occasionally (v1 → v2 → …) — match
    // anything in /api/sns/ that mentions "search" and "notes".
    if (!/\/api\/sns\/.*search.*notes?/i.test(url)) return;
    stats.apiHits++;
    try {
      const body = await resp.json() as XhsSearchResponse;
      for (const item of body?.data?.items ?? []) {
        if (collected.has(item?.id ?? '')) continue;
        // Skip posts older than the sinceMs cutoff (derived from MongoDB ObjectID)
        if (sinceMs > 0 && item.id && noteIdTimestampMs(item.id) < sinceMs) {
          anyOldPostFound = true;
          continue;
        }
        const note = parseSearchItem(item);
        if (note) collected.set(note.id, note);
      }
    } catch { /* ignore non-JSON */ }
  };
  page.on('response', onResponse);

  // Route interceptor: override the filters array + sort in the search API POST
  // body. The XHS SPA ignores URL sort params and always sends sort="general"
  // with no time filter. This interceptor catches the POST body in-flight and
  // applies our configured sort + time window via the official filters format.
  const sortRoute = async (route: import('playwright').Route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    body.sort = 'general';
    body.filters = buildSearchFilters(sortValue, sinceMs);
    await route.continue({ postData: JSON.stringify(body) });
  };
  await page.route('**/api/sns/web/v2/search/notes', sortRoute);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(PAGE_LOAD_WAIT_MS);
    await handleCaptcha(page); // pause for manual solve (headful) if the security panel appears

    // document.body can be transiently null right after navigation (SPA still
    // hydrating, or a blank interstitial XHS serves under load) — don't crash
    // the whole keyword loop over it, just treat it as "can't tell yet".
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '');
    const wall = detectWall(bodyText);
    if (wall === 'login') {
      console.warn(`${LABEL} Login wall — XHS_COOKIES may be missing or expired`);
      return [];
    }
    if (wall === 'captcha') {
      console.warn(`${LABEL} Captcha/anti-bot challenge — continuing with partial data`);
    }

    // Stop scrolling as soon as XHS starts returning posts older than sinceMs.
    // With sort=time_descending, the first batch is newest; subsequent scrolls
    // load progressively older posts.
    if (sinceMs > 0) {
      await scrollUntilStale(page, () => collected.size, () => anyOldPostFound, maxScrolls, shouldCancel);
    } else {
      await scrollUntilStale(page, () => collected.size, undefined, maxScrolls, shouldCancel);
    }
  } finally {
    page.off('response', onResponse);
    page.unroute('**/api/sns/web/v2/search/notes', sortRoute);
  }

  stats.collected = collected.size;
  logKeywordResult(keyword, stats);
  return Array.from(collected.values());
}

// ── Brand relevance verifier ─────────────────────────────────────────────────
// Same pattern as src/scrapers/tiktok/tiktok-search.ts → filterIrrelevantPosts(): infer
// the brand from each note's caption via matchBrandSlugXhs (XHS-only matcher —
// excludes Bomi, see keywords.ts), then ask Gemini whether the post genuinely
// refers to that brand. Notes without an inferred brand are dropped (we cannot
// verify them; this matches TikTok category-search behaviour).
async function verifyNotesAreRelevant(notes: XhsNote[]): Promise<Map<string, string>> {
  const candidates: { note: XhsNote; slug: string }[] = [];
  for (const note of notes) {
    const slug = matchBrandSlugXhs(`${note.title} ${note.desc}`);
    if (slug) candidates.push({ note, slug });
  }
  if (candidates.length === 0) return new Map();

  // Group by brand so each Gemini batch has a single "is this about brand X?" question.
  const byBrand = new Map<string, { note: XhsNote; slug: string }[]>();
  for (const c of candidates) {
    let bucket = byBrand.get(c.slug);
    if (!bucket) { bucket = []; byBrand.set(c.slug, bucket); }
    bucket.push(c);
  }

  // Cache brand display names (1 row each, but avoid N round-trips inside the loop).
  const slugs = Array.from(byBrand.keys());
  const rows = await query<{ slug: string; name: string }>(
    `SELECT slug, name FROM brands WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const brandName = new Map(rows.map((r) => [r.slug, r.name]));

  // Output map keyed by note id → resolved brand slug. Only IDs Gemini deemed
  // genuinely brand-relevant make it in.
  const relevant = new Map<string, string>();
  for (const [slug, items] of byBrand) {
    const name = brandName.get(slug) ?? slug;
    console.log(`${LABEL} [verify] Checking ${items.length} notes for brand "${name}"...`);
    const okIds = await filterIrrelevantPosts(
      items.map((i) => ({ id: i.note.id, text: `${i.note.title} ${i.note.desc}` })),
      name,
      slug,
    );
    let kept = 0;
    for (const i of items) {
      if (okIds.has(i.note.id)) {
        relevant.set(i.note.id, slug);
        kept++;
      }
    }
    console.log(`${LABEL} [verify] "${name}": ${kept}/${items.length} kept`);
  }
  return relevant;
}

// ── Scraper ──────────────────────────────────────────────────────────────────
// Resolve sinceMs: env var wins, then constructor param, then 0 (no filter).
function resolveSinceMs(ctorSinceMs?: number): number {
  const envMs = process.env.XHS_SEARCH_SINCE_MS;
  if (envMs) {
    const n = parseInt(envMs, 10);
    if (Number.isFinite(n)) return n;
  }
  return ctorSinceMs ?? 0;
}

export class XhsSearchScraper extends BaseSocialScraper {
  // Optional ad-hoc keyword(s) — overrides the preset CN_SEARCH_KEYWORDS list.
  constructor(
    private keywordOverride?: string,
    private sinceMs?: number,
    /** Polled between keywords/scrolls/detail-fetches; throws ScrapeCancelledError when true. */
    private shouldCancel?: ShouldCancel,
  ) {
    super({ platformSlug: PLATFORM_SLUG, defaultSourceType: 'search' });
  }

  private async resolveKeywords(): Promise<string[]> {
    const single = this.keywordOverride?.trim() || process.env.XHS_SEARCH_KEYWORD;
    if (single) return [single];
    const kw = await getKeywords();
    return kw.xhs;
  }

  private lastSinceMs(): number {
    return resolveSinceMs(this.sinceMs);
  }

  async fetchPosts(): Promise<RawSocialPost[]> {
    if (!hasXhsCookies()) {
      console.warn(`${LABEL} No XHS_COOKIES set. XHS requires auth — see CN_SOCIAL_SETUP.md`);
      return [];
    }

    const usePersistent = hasPersistentProfile();
    let browser: Browser | undefined;
    let ctx: BrowserContext;
    if (usePersistent) {
      ctx = await launchPersistentContext();
    } else {
      browser = await launchBrowser();
      ctx = await newStealthContext(browser);
    }
    const out: RawSocialPost[] = [];
    const sinceMs = this.lastSinceMs();

    try {
      const page = await ctx.newPage();
      await warmUp(page);

      const keywords = await this.resolveKeywords();
      const withComments = commentsEnabled();
      const brandIds = await loadXhsBrandIds();
      const limits = (await getThresholds()).scrapeLimits.xhsSearch;

      for (const keyword of keywords) {
        if (this.shouldCancel?.()) throw new ScrapeCancelledError();
        // One keyword hitting a transient page/network hiccup (blank interstitial,
        // XHS rate-limiting, a captcha that never clears) used to throw and abort
        // every keyword after it in the list — log and move on instead.
        try {
          const rawNotes = (await collectNotesForKeyword(page, keyword, sinceMs, limits.maxScrolls, this.shouldCancel)).slice(0, limits.maxPosts);
          // Posts from our own accounts are already captured by the feed scraper —
          // skip them here so search results stay UGC-only (mirrors TikTok's
          // own-handle exclusion, see OWN_BRAND_HANDLES).
          const allNotes = rawNotes.filter((n) => !XHS_OWN_ACCOUNT_NAMES.has(n.author));
          const ownSkipped = rawNotes.length - allNotes.length;
          if (ownSkipped > 0) {
            console.log(`${LABEL} "${keyword}": skipped ${ownSkipped} own-account note(s) (already covered by feed scraper)`);
          }

          // Detail-fetch pre-pass: only for own-brand-targeted keywords (this
          // exact keyword resolves to a brand on its own — "mizumi", ambassador
          // names, etc, not a generic category term). Title-only misses on those
          // are usually real mentions hiding in the caption XHS never sends over
          // the list API — visit the note and merge in the real desc BEFORE the
          // relevance check below. Category-keyword misses are left alone —
          // unmeasured, lower prior likelihood of a hit, and visiting all of
          // those too would double this pass's cost.
          const keywordBrandSlug = matchBrandSlugXhs(keyword);
          if (keywordBrandSlug) {
            const misses = allNotes.filter((note) => !matchBrandSlugXhs(`${note.title} ${note.desc}`));
            const fetchLimit = misses.length <= DETAIL_FETCH_FULL_THRESHOLD ? misses.length : DETAIL_FETCH_HARD_CAP;
            if (misses.length > DETAIL_FETCH_FULL_THRESHOLD) {
              console.warn(`${LABEL} "${keyword}": ${misses.length} title-only misses — high-volume outlier, capping detail-fetch at ${fetchLimit} (rest skipped)`);
            }

            let detailFetched = 0;
            let detailRecovered = 0;
            for (const note of misses) {
              if (detailFetched >= fetchLimit) break;
              if (this.shouldCancel?.()) throw new ScrapeCancelledError();
              const detail = await fetchNoteDetail(page, note);
              detailFetched++;
              if (detail?.desc) {
                note.desc = detail.desc;
                if (matchBrandSlugXhs(`${note.title} ${note.desc}`)) detailRecovered++;
              }
              await this.delay(1500 + Math.floor(Math.random() * 1500));
            }
            if (detailFetched > 0) {
              console.log(`${LABEL} "${keyword}": detail-fetched ${detailFetched}/${misses.length} title-only-miss note(s), ${detailRecovered} recovered as relevant`);
            }
          }

          // Verifier: keep only notes Gemini judges as genuinely about one of our
          // own brands. Notes without an inferred brand are dropped (cannot verify).
          const relevant = await verifyNotesAreRelevant(allNotes);
          const kept = allNotes.filter((n) => relevant.has(n.id));
          const dropped = allNotes.length - kept.length;
          if (dropped > 0) {
            console.log(`${LABEL} "${keyword}": dropped ${dropped} irrelevant notes (no brand match / failed verification)`);
          }

          for (const note of kept) {
            if (this.shouldCancel?.()) throw new ScrapeCancelledError();
            const slug = relevant.get(note.id)!;
            const brandId = brandIds.get(slug) ?? null;
            try {
              await upsertXhsPost(brandId, note, 'search', keyword); // note → xhs_posts
            } catch (err) {
              console.error(`${LABEL} "${keyword}": failed to save note ${note.id}: ${err}`);
              continue;
            }
            if (withComments) {
              const rows = await scrapeNoteComments(page, note);
              for (const r of rows) r.brandSlug = slug;            // inherit note's brand
              out.push(...rows);                                    // comments → social_comments
              await this.delay(2000 + Math.floor(Math.random() * 2000));
            }
          }
          console.log(`${LABEL} "${keyword}": ${kept.length} relevant notes upserted, ${out.length} comment rows so far`);
        } catch (err) {
          if (err instanceof ScrapeCancelledError) throw err; // let cancellation propagate — don't swallow it as a keyword failure
          console.error(`${LABEL} "${keyword}": keyword failed, skipping — ${err instanceof Error ? err.message : err}`);
        }
        await cancellableSleep(4000, this.shouldCancel);
      }

      return out;
    } finally {
      if (browser) await browser.close();
      else await ctx.close();
    }
  }
}

export async function runXhsSearch(keyword?: string, sinceMs?: number, shouldCancel?: ShouldCancel): Promise<void> {
  await new XhsSearchScraper(keyword, sinceMs, shouldCancel).run();
}

if (require.main === module) {
  runXhsSearch()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
