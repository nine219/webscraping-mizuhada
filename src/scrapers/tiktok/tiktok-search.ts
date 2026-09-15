/**
 * TikTok Search Scraper
 *
 * Searches TikTok for brand keywords (e.g. "mizumi", "มิซึมิ") and collects
 * posts from ANY user that mentions the brand — user-generated content (UGC).
 * These are brand mentions, not the brand's own posts.
 *
 * Two-phase execution:
 *   Phase 1 — Collection (single browser, sequential per keyword):
 *     Navigate search, intercept XHR, collect post metadata → upsert DB
 *   Phase 2 — Comments (N parallel browsers, shared task queue):
 *     Each worker pops tasks from the queue, scrapes comments independently.
 *     Default: 1 workers
 *
 * Posts saved to tiktok_posts with source_type='search'.
 *
 * Usage:
 *   npm run scrape:tiktok:search                    # all own brands
 *   TIKTOK_SEARCH_BRAND=mizumi npm run scrape:tiktok:search  # single brand
 */

import * as os from 'os';
import * as path from 'path';
import { BrowserContext } from 'playwright';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { launchContext, warmUp, isSessionValid, solveCaptcha } from './tiktok-browser';
import { scrapePostComments, upsertComments } from './tiktok-comments';
import { SEARCH_TARGETS, CATEGORY_KEYWORDS, OWN_BRAND_HANDLES, matchBrandSlug, BrandMatchCandidate, containsKeyword } from '../keywords';
import { loadSettings, getTikTokSearchTargets, getCompetitorTikTokKeywords } from '../../config/settings-loader';
import { filterIrrelevantPosts, RelevanceInput } from '../../validators/brand-relevance';
import { createNotification } from '../../notifications/store';
import { detectSpikes } from '../../analysis/spike-detection';
import { detectShopContent } from './shop-detection';

export { SEARCH_TARGETS };

// TikTok search API response shapes
interface SearchItem {
  item?: TikTokApiItem;
  type?: number;
}

interface TikTokApiItem {
  id: string;
  desc: string;
  createTime: number;
  author?: { uniqueId?: string; id?: string; nickname?: string };
  video?: { playAddr?: string; downloadAddr?: string; cover?: string; dynamicCover?: string; originCover?: string };
  stats?: {
    playCount?: number;
    diggCount?: number;
    shareCount?: number;
    commentCount?: number;
  };
  // Creator-level stats — basis for influencer reach-vs-engagement tiers.
  authorStats?: {
    followerCount?: number;
    heartCount?: number;   // total likes across the creator's videos
    videoCount?: number;
  };
  challenges?: Array<{ title?: string }>;
  textExtra?: Array<{ awemeId?: string }>;
}

interface TikTokSearchResponse {
  item_list?: TikTokApiItem[];
  data?: SearchItem[];
  has_more?: number | boolean;
  cursor?: string | number;
  log_pb?: unknown;
}

/** A post queued for comment scraping in Phase 2. */
interface CommentTask {
  postId: string;
  authorHandle: string;
  brandId: number;
}

function extractItems(body: TikTokSearchResponse): TikTokApiItem[] {
  // /api/search/general/full/ uses `data[].item`
  if (body.data && Array.isArray(body.data)) {
    return body.data
      .filter((d) => d.type === 1 && d.item?.id)
      .map((d) => d.item!);
  }
  // /api/search/item/full/ uses `item_list`
  if (body.item_list && Array.isArray(body.item_list)) {
    return body.item_list.filter((i) => i?.id);
  }
  return [];
}

// ── Cooperative cancellation ─────────────────────────────────────────────────
// Same pattern as twitter-search.ts's ScrapeCancelledError/ShouldCancel — a
// manual "Stop" click (POST /api/scrape/stop/:jobId) sets job.cancelRequested;
// the scraper polls it between steps and unwinds via this error instead of
// leaving startScrapeJob's generic catch to log it as a hard failure.

/** Thrown to unwind out of a run once the user requests a stop. */
export class ScrapeCancelledError extends Error {
  constructor() {
    super('Scrape cancelled by user');
    this.name = 'ScrapeCancelledError';
  }
}

type ShouldCancel = () => boolean;

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

/**
 * A fixed delay repeated thousands of times (12s, exactly, every keyword) is
 * itself a bot signature — real human browsing doesn't pause for precisely
 * the same duration between every search. Widens `baseMs` to a random point
 * in [baseMs, baseMs * (1 + jitterPct)] so consecutive gaps vary.
 */
function withJitter(baseMs: number, jitterPct = 0.5): number {
  return Math.round(baseMs * (1 + Math.random() * jitterPct));
}

// ── Soft-block detection ─────────────────────────────────────────────────────
// TikTok search has no visible 429 the way X does (see twitter-search.ts) —
// a soft-block here instead looks like the search API genuinely returning
// zero raw items (not just zero after OUR brand-relevance filter — a category
// keyword filtering down to 0 is normal, see docs) for keyword after keyword,
// or an outright 403/429/455 on the search endpoints themselves. Tracked
// across the WHOLE run (every brand + the shared category pass hit the same
// IP/session) via one tracker instance threaded through searchAllBrands(), so
// a streak building on brand A's last keyword carries into brand B's first.
const SOFT_BLOCK_WARN_STREAK  = parseInt(process.env.TIKTOK_SOFT_BLOCK_WARN_STREAK  ?? '5', 10);
const SOFT_BLOCK_ABORT_STREAK = parseInt(process.env.TIKTOK_SOFT_BLOCK_ABORT_STREAK ?? '10', 10);
const SOFT_BLOCK_BACKOFF_MS   = parseInt(process.env.TIKTOK_SOFT_BLOCK_BACKOFF_MS   ?? String(5 * 60_000), 10);

/** Thrown to abort the whole run once TikTok looks soft-blocked — retrying harder only digs the session in deeper. */
export class TikTokSoftBlockError extends Error {
  constructor(streak: number) {
    super(`TikTok search returned 0 raw results ${streak}x in a row — likely soft-blocked, aborting run`);
    this.name = 'TikTokSoftBlockError';
  }
}

export class SoftBlockTracker {
  private consecutiveEmpty = 0;
  private warnedAt = -1; // streak value we last backed off at — avoids re-sleeping every keyword once past the threshold

  /** Call once per keyword. rawCount = items TikTok's API itself returned (pre brand-filter) — a true 0 here is the block signal, not "filtered out". */
  record(rawCount: number, hadBlockedStatus: boolean): void {
    if (rawCount > 0 && !hadBlockedStatus) {
      this.consecutiveEmpty = 0;
      this.warnedAt = -1;
      return;
    }
    this.consecutiveEmpty++;
  }

  /** Throws once the streak crosses the abort threshold — call right after record(). */
  assertNotBlocked(): void {
    if (this.consecutiveEmpty >= SOFT_BLOCK_ABORT_STREAK) {
      throw new TikTokSoftBlockError(this.consecutiveEmpty);
    }
  }

  /** Extra cooldown once we suspect a block — only sleeps once per streak, not every keyword past the threshold. */
  async maybeBackoff(shouldCancel?: ShouldCancel): Promise<void> {
    if (this.consecutiveEmpty >= SOFT_BLOCK_WARN_STREAK && this.warnedAt !== this.consecutiveEmpty) {
      this.warnedAt = this.consecutiveEmpty;
      console.warn(`\n[TikTokSearch] ${this.consecutiveEmpty} consecutive empty results — possible soft-block. Backing off ${Math.round(SOFT_BLOCK_BACKOFF_MS / 60_000)}min...`);
      await cancellableSleep(SOFT_BLOCK_BACKOFF_MS, shouldCancel);
    }
  }
}

// ── Scraper class ─────────────────────────────────────────────────────────────

export interface ScraperOptions {
  /** Cap posts collected per keyword. Default: no limit. */
  maxPostsPerKeyword?: number;
  /** Skip posts older than N days. Default: no limit. */
  maxPostAgeDays?: number;
  /** Number of scroll attempts per keyword. Default: 8. */
  maxScrolls?: number;
  /** Own-brand TikTok handles to exclude from UGC results. Falls back to module default. */
  ownHandles?: Set<string>;
  /** Runtime comment-scrape gating thresholds. Falls back to module defaults. */
  commentThresholds?: { minViews: number; minComments: number; delta: number };
  /** Re-scrape comments for ALL posts, not just new/recent ones. Default: false. */
  rescrapeComments?: boolean;
  /**
   * Number of parallel Chrome instances for Phase 2 comment scraping.
   * Each worker gets its own profile dir so sessions are independent.
   * Default: 2. Set to 1 to disable parallelism.
   */
  commentWorkers?: number;
  /** Skip Phase 2 entirely — collect + save posts only, no comment scraping. Default: false. */
  skipComments?: boolean;
  /** Polled between keywords/scrolls; throws ScrapeCancelledError when true. */
  shouldCancel?: ShouldCancel;
  /** Shared across brands by searchAllBrands() to detect a soft-block spanning the whole run. Omit for a one-off/ad-hoc search — the streak just won't be tracked. */
  softBlockTracker?: SoftBlockTracker;
}

export class TikTokSearchScraper {
  private opts: ScraperOptions;
  constructor(
    private brandSlug: string,
    private keywords: string[],
    opts: ScraperOptions | number = {},
    private brandIdMap?: Map<string, number>,
    private brandNameMap?: Map<number, string>,
    /** Candidate list for matchBrandSlug() when brandIdMap has multiple entries (category mode). Own brands carry their live keyword list; competitors are matched by name — see BrandMatchCandidate. */
    private brandCandidates?: BrandMatchCandidate[],
  ) {
    // Back-compat: old callers passed maxPostsPerKeyword as a number
    this.opts = typeof opts === 'number' ? { maxPostsPerKeyword: opts } : opts;
  }

  async run(): Promise<number> {
    // For category searches (brandIdMap provided), brand is resolved per-post — skip global lookup.
    let brandId = -1;
    if (!this.brandIdMap) {
      const brandRows = await query<{ id: number }>(
        `SELECT id FROM brands WHERE slug = $1 LIMIT 1`,
        [this.brandSlug]
      );
      if (brandRows.length === 0) {
        console.warn(`[TikTokSearch/${this.brandSlug}] Brand not in DB — run: npm run db:seed`);
        return 0;
      }
      brandId = brandRows[0].id;
    }

    // ── Phase 1: collect all posts (single browser, sequential) ──────────────
    const { ctx, cleanup } = await launchContext();
    await warmUp(ctx);

    let totalUpserted = 0;
    const allTasks: CommentTask[] = [];

    try {
      for (const keyword of this.keywords) {
        if (this.opts.shouldCancel?.()) throw new ScrapeCancelledError();
        console.log(`\n[TikTokSearch/${this.brandSlug}] Searching: "${keyword}"`);
        const { upserted, tasks, rawCount, blockedStatus } = await this.collectKeyword(ctx, brandId, keyword);
        totalUpserted += upserted;
        allTasks.push(...tasks);
        console.log(`  → ${upserted} posts saved, ${tasks.length} queued for comments`);

        this.opts.softBlockTracker?.record(rawCount, blockedStatus);
        this.opts.softBlockTracker?.assertNotBlocked(); // throws TikTokSoftBlockError — let it unwind through finally below

        if (keyword !== this.keywords[this.keywords.length - 1]) {
          // 18-27s (was a flat 12s) — see withJitter()'s doc comment on why a
          // fixed interval is itself a tell.
          const delayMs = withJitter(18_000, 0.5);
          console.log(`  Waiting ${Math.round(delayMs / 1000)}s before next keyword...`);
          await cancellableSleep(delayMs, this.opts.shouldCancel);
          await this.opts.softBlockTracker?.maybeBackoff(this.opts.shouldCancel);
        }
      }
    } finally {
      await cleanup();
    }

    console.log(`[TikTokSearch/${this.brandSlug}] Phase 1 done: ${totalUpserted} posts`);

    // ── Phase 2: comment scraping (parallel workers) ──────────────────────────
    if (this.opts.skipComments) {
      console.log(`[TikTokSearch/${this.brandSlug}] skipComments set — leaving ${allTasks.length} post(s) unscraped for comments`);
    } else {
      const parallelism = Math.max(1, this.opts.commentWorkers ?? 1); // change here if you want pararell worker (might trigger bot detection easier)
      await this.runCommentWorkers(allTasks, parallelism);
    }

    return totalUpserted;
  }

  /**
   * Phase 1: navigate search, collect post metadata, upsert to DB.
   * Returns upserted count and CommentTasks for Phase 2.
   * Does NOT scrape comments.
   */
  private async collectKeyword(
    ctx: BrowserContext,
    brandId: number,
    keyword: string,
  ): Promise<{ upserted: number; tasks: CommentTask[]; rawCount: number; blockedStatus: boolean }> {
    const collected = new Map<string, { item: TikTokApiItem; keyword: string }>();
    const page = await ctx.newPage();
    // Set inside the response handler below — 403/429/455 on the search endpoints
    // themselves is a much stronger soft-block signal than "0 raw items" alone.
    let hadBlockedStatus = false;

    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('tiktok.com/api/') && process.env.TIKTOK_DEBUG === '1') {
        console.log(`\n  [net] ${resp.status()} ${url.replace(/https?:\/\/[^/]+/, '')}`);
      }
      if (
        !url.includes('/api/search/') &&
        !url.includes('search_item') &&
        !url.includes('search/general')
      ) return;
      console.log(`\n  [search-api] ${resp.status()} ${url.replace(/https?:\/\/[^/]+/, '').slice(0, 80)}`);
      if (resp.status() === 403 || resp.status() === 429 || resp.status() === 455) hadBlockedStatus = true;
      if (!resp.ok()) return;
      try {
        const body = await resp.json() as TikTokSearchResponse;
        const items = extractItems(body);
        let addedThisBatch = 0;
        const maxAgMs = this.opts.maxPostAgeDays ? this.opts.maxPostAgeDays * 86_400_000 : null;
        for (const item of items) {
          if (!item?.id) continue;
          if (this.opts.maxPostsPerKeyword && collected.size >= this.opts.maxPostsPerKeyword) continue;
          const ownSet = this.opts.ownHandles ?? OWN_BRAND_HANDLES;
          if (item.author?.uniqueId && ownSet.has(item.author.uniqueId)) continue;
          if (maxAgMs && item.createTime && (Date.now() - item.createTime * 1000) > maxAgMs) continue;
          collected.set(item.id, { item, keyword });
          addedThisBatch++;
        }
        if (addedThisBatch > 0) {
          process.stdout.write(`\r    Collected ${collected.size} posts (+${addedThisBatch})...`);
        }
      } catch { /* ignore parse errors */ }
    });

    try {
      const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=1`;
      console.log(`  Navigating to search: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3_000);

      if (!isSessionValid(page)) {
        console.warn(`  Session invalid — run: npm run tiktok:login`);
        return { upserted: 0, tasks: [], rawCount: 0, blockedStatus: false };
      }

      await solveCaptcha(page);

      // NOTE: TikTok search only responds to wheel events, not window.scrollTo().
      // See original comments in git history for full explanation.
      const MAX_SCROLLS = this.opts.maxScrolls ?? 8;
      let emptyScrolls = 0;
      await page.mouse.move(640, 400);
      for (let i = 0; i < MAX_SCROLLS; i++) {
        if (this.opts.shouldCancel?.()) throw new ScrapeCancelledError();
        if (this.opts.maxPostsPerKeyword && collected.size >= this.opts.maxPostsPerKeyword) break;
        const before = collected.size;
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(2_500);
        if (i % 3 === 2) await solveCaptcha(page);
        if (collected.size === before) {
          emptyScrolls++;
          if (emptyScrolls >= 3) {
            console.log(`\n  3 empty scrolls — stopping`);
            break;
          }
        } else {
          emptyScrolls = 0;
        }
      }
      console.log();
    } catch (err) {
      if (err instanceof ScrapeCancelledError) throw err; // let cancellation propagate — don't swallow it as a nav failure
      console.warn(`  Search navigation failed: ${err}`);
    } finally {
      await page.close();
    }

    if (collected.size === 0) return { upserted: 0, tasks: [], rawCount: 0, blockedStatus: hadBlockedStatus };

    // Load known IDs for is_new flag
    const knownIds = new Set(
      (await query<{ post_id: string }>(
        `SELECT post_id FROM tiktok_posts WHERE post_id = ANY($1)`,
        [[...collected.keys()]],
      )).map((r) => r.post_id),
    );

    // Gemini brand relevance check — filters false positives like bomi K-pop before DB upsert.
    // Runs for brand-specific searches only (not category). Falls back to allow-all if Gemini unavailable.
    let relevantIds: Set<string> | null = null;
    if (!this.brandIdMap) {
      const brandRow = await query<{ name: string }>(`SELECT name FROM brands WHERE id = $1`, [brandId]);
      const brandName = brandRow[0]?.name ?? this.brandSlug;
      const candidates: RelevanceInput[] = [];
      for (const { item } of collected.values()) {
        if (knownIds.has(item.id)) continue;
        const text = `${item.desc ?? ''} ${(item.challenges ?? []).map((c) => c.title ?? '').join(' ')}`;
        // this.keywords is the live per-brand list already (target.keywords from
        // Settings) — not the static BRAND_KEYWORDS dict, so a keyword added via
        // Settings → Keywords counts here immediately, no code change needed.
        if (this.keywords.some((term) => containsKeyword(text, term))) {
          candidates.push({ id: item.id, text });
        }
      }
      if (candidates.length > 0) {
        console.log(`  [relevance] Checking ${candidates.length} new posts against brand "${brandName}"...`);
        relevantIds = await filterIrrelevantPosts(candidates, brandName, this.brandSlug);
      }
    }

    let upserted = 0;
    const tasks: CommentTask[] = [];

    for (const { item, keyword: kw } of collected.values()) {
      try {
        // Whenever a brandIdMap is supplied (category search, or admin's
        // ad-hoc multi-search scoped to one brand) resolve brand from post
        // CONTENT via matchBrandSlug(), using brandCandidates — own brands
        // checked against their live keyword list, competitors checked
        // against just their bare name (see BrandMatchCandidate). We used to
        // blindly force-attribute every result to the caller's picked brand
        // when brandIdMap.size === 1 — but an ad-hoc keyword can be generic
        // (e.g. "มาสก์หน้าเซเว่น") and match posts with zero relation to the
        // picked brand, mislabeling them. Never skip the content check.
        let resolvedBrandId = brandId;
        if (this.brandIdMap) {
          const slug = matchBrandSlug(item.desc ?? '', this.brandCandidates ?? []);
          if (!slug || !this.brandIdMap.has(slug)) continue;
          resolvedBrandId = this.brandIdMap.get(slug)!;
        } else {
          const text = `${item.desc ?? ''} ${(item.challenges ?? []).map((c) => c.title ?? '').join(' ')}`;
          // this.keywords is the live per-brand list already — see the identical comment above.
          if (!this.keywords.some((term) => containsKeyword(text, term))) continue;
          if (relevantIds !== null && !relevantIds.has(item.id)) continue;
        }

        const views        = item.stats?.playCount    ?? 0;
        const likes        = item.stats?.diggCount    ?? 0;
        const shares       = item.stats?.shareCount   ?? 0;
        const comms        = item.stats?.commentCount ?? 0;
        const engRate      = views > 0
          ? Number((((likes + comms + shares) / views) * 100).toFixed(4))
          : null;
        const hashtags     = (item.challenges ?? []).map((c) => c.title ?? '').filter(Boolean);
        const productLinks = (item.textExtra  ?? []).map((t) => t.awemeId ?? '').filter(Boolean);
        const videoUrl     = item.video?.playAddr ?? item.video?.downloadAddr ?? null;
        // Signed CDN URL — expires a few weeks after scrape, refreshed on every
        // re-scrape via ON CONFLICT below. See tiktok-feed.ts's coverUrl comment.
        const coverUrl     = item.video?.cover ?? item.video?.dynamicCover ?? item.video?.originCover ?? null;
        const postedAt     = item.createTime ? new Date(item.createTime * 1000) : null;
        const authorHandle = item.author?.uniqueId ?? null;
        const authorFollowers  = item.authorStats?.followerCount ?? null;
        const authorHearts     = item.authorStats?.heartCount    ?? null;
        const authorVideoCount = item.authorStats?.videoCount    ?? null;
        const { isShop: isShopContent, signal: shopSignal } = detectShopContent(item, item.desc ?? null);

        const result = await pool.query<{ is_new: boolean; comments_scraped_at: Date | null; comments_meta_at_scrape: string | number | null }>(
          `INSERT INTO tiktok_posts (
            brand_id, post_id, video_url, cover_url, caption, hashtags, product_links,
            views, likes, shares, comments_count, posted_at, engagement_rate, raw_data,
            source_type, author_handle, search_keywords,
            author_followers, author_hearts, author_video_count, is_shop_content, shop_signal
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
          ON CONFLICT (brand_id, post_id) DO UPDATE SET
            views           = EXCLUDED.views,
            likes           = EXCLUDED.likes,
            shares          = EXCLUDED.shares,
            comments_count  = EXCLUDED.comments_count,
            engagement_rate = EXCLUDED.engagement_rate,
            hashtags        = EXCLUDED.hashtags,
            author_handle   = EXCLUDED.author_handle,
            cover_url       = EXCLUDED.cover_url,
            author_followers   = COALESCE(EXCLUDED.author_followers, tiktok_posts.author_followers),
            author_hearts      = COALESCE(EXCLUDED.author_hearts, tiktok_posts.author_hearts),
            author_video_count = COALESCE(EXCLUDED.author_video_count, tiktok_posts.author_video_count),
            search_keywords = ARRAY(
              SELECT DISTINCT unnest(tiktok_posts.search_keywords || EXCLUDED.search_keywords)
            ),
            scraped_at      = NOW()
          RETURNING (xmax = 0) AS is_new,
            comments_scraped_at,
            comments_meta_at_scrape`,
          [
            resolvedBrandId, item.id, videoUrl, coverUrl, item.desc ?? '', hashtags, productLinks,
            views, likes, shares, comms, postedAt, engRate,
            JSON.stringify(item),
            'search', authorHandle, [kw],
            authorFollowers, authorHearts, authorVideoCount,
            isShopContent, shopSignal,
          ],
        );
        const row = result.rows[0];
        const isNew = row?.is_new ?? true;
        if (isNew) {
          const brandName = this.brandNameMap?.get(resolvedBrandId) ?? this.brandSlug;
          createNotification({
            type: 'new_post_search',
            title: 'New TikTok mention found',
            body: `@${authorHandle ?? 'unknown'} posted about ${brandName}`,
            relatedPostId: item.id,
            payload: { brandSlug: this.brandSlug, brandName, authorHandle, keyword: kw, caption: item.desc },
          }).catch(() => {});
        }

        // Phase 2 cap: comment scraping (open page + scroll + captcha) is the expensive,
        // bot-risky step — metadata above is cheap. So gate it tightly.
        // Hard threshold (first scrape AND re-scrape): ≥50k views, post <1 month old, ≥5 comments.
        const _th = this.opts.commentThresholds;
        const COMMENT_MIN_VIEWS = _th?.minViews ?? 50_000;
        const MIN_COMMENTS      = _th?.minComments ?? 5;
        const COMMENT_DELTA     = _th?.delta ?? 5;            // re-scrape only if comments grew ≥delta
        const MAX_POST_AGE_MS   = 30 * 24 * 60 * 60 * 1000;   // post posted <1 month ago
        const postAgeMs = item.createTime ? Date.now() - item.createTime * 1000 : Infinity;
        const meetsThreshold = postAgeMs < MAX_POST_AGE_MS
          && comms  >= MIN_COMMENTS
          && views  >= COMMENT_MIN_VIEWS;
        // Never scraped → scrape on threshold. Already scraped → only if the API comment
        // metadata grew ≥5 vs the count captured at the last scrape (cheap metadata compare
        // against our DB, no extra page loads).
        const prevScrapedAt = row?.comments_scraped_at ?? null;
        const prevMeta      = Number(row?.comments_meta_at_scrape ?? 0);
        const neverScraped  = prevScrapedAt === null;
        const grewEnough    = comms - prevMeta >= COMMENT_DELTA;
        const shouldScrapeComments = meetsThreshold
          && (this.opts.rescrapeComments || neverScraped || grewEnough);
        if (shouldScrapeComments && authorHandle) {
          tasks.push({ postId: item.id, authorHandle, brandId: resolvedBrandId });
        }
        upserted++;
      } catch (err) {
        console.error(`  Upsert failed for post ${item.id}: ${err}`);
      }
    }

    return { upserted, tasks, rawCount: collected.size, blockedStatus: hadBlockedStatus };
  }

  /**
   * Phase 2: drain the comment task queue using N parallel browser instances.
   * Worker i uses profile ~/.tiktok-comments-worker-i — separate from the search
   * profile so each has an independent TikTok rate-limit bucket.
   * Workers stagger startup by 5s each to avoid simultaneous captcha checks.
   */
  private async runCommentWorkers(
    tasks: CommentTask[],
    parallelism: number,
  ): Promise<void> {
    if (tasks.length === 0) return;

    console.log(`\n[TikTokSearch] Phase 2: ${tasks.length} posts → ${parallelism} comment workers`);

    // Shared atomic index — safe in single-threaded Node.js
    let idx = 0;
    const nextTask = (): CommentTask | null => tasks[idx++] ?? null;

    const workerFn = async (workerId: number): Promise<void> => {
      const profileDir = path.join(os.homedir(), `.tiktok-comments-worker-${workerId}`);
      const { ctx, cleanup: workerCleanup } = await launchContext(profileDir);
      await warmUp(ctx);

      // Stagger: worker 1 waits 5s, worker 2 waits 10s, etc.
      if (workerId > 0) await new Promise((r) => setTimeout(r, workerId * 5_000));

      try {
        let task: CommentTask | null;
        while ((task = nextTask()) !== null) {
          try {
            process.stdout.write(`  [W${workerId}] ${task.postId} (@${task.authorHandle})...`);
            const { comments, blocked } = await scrapePostComments(ctx, task.authorHandle, task.postId);
            const saved = await upsertComments(task.brandId, task.postId, comments);
            // blocked=false means we got a real (non-CAPTCHA) answer — a genuine 0-comment
            // result is still a real result. stats alone can't signal this (loads from page
            // HTML regardless of whether the comment API itself was CAPTCHA-blocked).
            if (!blocked) {
              // comments_count stays = API metadata; snapshot it into comments_meta_at_scrape
              // so the re-scrape gate compares metadata-to-metadata (scraped rows undercount
              // metadata — no replies — so they can't be the baseline). Stamp the scrape time.
              await pool.query(
                `UPDATE tiktok_posts SET
                   comments_meta_at_scrape = comments_count,
                   comments_scraped_at     = NOW()
                 WHERE post_id = $1`,
                [task.postId],
              );
            }
            console.log(` ${saved} comments`);
          } catch (err) {
            console.log(` failed: ${err}`);
          }
          await new Promise((r) => setTimeout(r, 4_000 + Math.random() * 3_000));
        }
      } finally {
        await workerCleanup();
      }

      console.log(`  [W${workerId}] done`);
    };

    await Promise.all(Array.from({ length: parallelism }, (_, i) => workerFn(i)));
    console.log('[TikTokSearch] Phase 2 done');
  }
}

// ── Run all own brands ────────────────────────────────────────────────────────

export async function searchAllBrands(shouldCancel?: ShouldCancel, skipComments?: boolean): Promise<void> {
  const settings = await loadSettings();
  const allTargets = await getTikTokSearchTargets();
  const categoryKw = settings.keywords.tiktokCategory;
  const ownHandles = new Set(settings.keywords.ownHandlesTiktok);
  const commentThresholds = {
    minViews: settings.thresholds.commentMinViews,
    minComments: settings.thresholds.commentMinCount,
    delta: settings.thresholds.commentGrowthDelta,
  };

  const targetBrand = process.env.TIKTOK_SEARCH_BRAND;
  const targets = targetBrand
    ? allTargets.filter((t) => t.brandSlug === targetBrand)
    : allTargets;

  if (targets.length === 0) {
    console.warn(`[TikTokSearch] No matching brand for TIKTOK_SEARCH_BRAND="${targetBrand}"`);
    return;
  }

  console.log(`[TikTokSearch] Running for ${targets.length} brand(s)...`);

  const brandRows = await query<{ slug: string; id: number; name: string }>(
    `SELECT slug, id, name FROM brands WHERE slug = ANY($1)`,
    [allTargets.map((t) => t.brandSlug)],
  );
  const brandNameMap = new Map(brandRows.map((r) => [r.id, r.name]));
  const brandIdMap = new Map(brandRows.map((r) => [r.slug, r.id]));

  // Shared across every brand + the category pass below — a soft-block streak
  // building on one brand's last keyword carries straight into the next.
  const softBlockTracker = new SoftBlockTracker();

  const limits = settings.thresholds.scrapeLimits.tiktokSearch;
  for (const target of targets) {
    if (shouldCancel?.()) throw new ScrapeCancelledError();
    const scraper = new TikTokSearchScraper(target.brandSlug, target.keywords, { ownHandles, commentThresholds, maxScrolls: limits.maxScrolls, maxPostsPerKeyword: limits.maxPosts, shouldCancel, skipComments, softBlockTracker }, undefined, brandNameMap);
    try {
      await scraper.run();
    } catch (err) {
      if (err instanceof ScrapeCancelledError) throw err; // stop the whole run, don't move on to the next brand
      if (err instanceof TikTokSoftBlockError) throw err; // same — no point trying the next brand while blocked
      console.error(`[TikTokSearch] ${target.brandSlug} failed: ${err}`);
    }
    const brandId = brandIdMap.get(target.brandSlug);
    if (brandId) {
      try {
        const spikes = await detectSpikes(brandId, target.brandSlug);
        if (spikes.length > 0) {
          console.log(`[TikTokSearch] ${target.brandSlug} detected ${spikes.length} spike(s)`);
        }
      } catch (err) {
        console.error(`[TikTokSearch] spike detection failed for ${target.brandSlug}: ${err}`);
      }
    }
    if (target !== targets[targets.length - 1]) {
      // 90-135s (was a flat 60s) — same anti-fingerprint reasoning as the
      // per-keyword delay above, just at the per-brand scale.
      const brandDelayMs = withJitter(90_000, 0.5);
      console.log(`  Waiting ${Math.round(brandDelayMs / 1000)}s before next brand...`);
      await cancellableSleep(brandDelayMs, shouldCancel);
    }
  }

      // Category keyword searches — only run when not filtering to a single brand
      if (!targetBrand && categoryKw.length > 0) {
        const categoryDelayMs = withJitter(120_000, 0.5);
        console.log(`\n[TikTokSearch] Waiting ${Math.round(categoryDelayMs / 1000)}s before category keywords...`);
        await cancellableSleep(categoryDelayMs, shouldCancel);

        console.log(`\n[TikTokSearch] Category keywords (${categoryKw.length} terms)...`);

        // Competitor brands get a shot at category-keyword attribution too —
        // own brands are verified against their live Settings keyword list;
        // competitors use their curated keyword_terms rows if any exist,
        // falling back to a bare brand-name match otherwise (see matchBrandSlug()).
        const competitorRows = await query<{ slug: string; id: number; name: string }>(
          `SELECT slug, id, name FROM brands WHERE type = 'competitor'`,
        );
        const competitorKeywords = await getCompetitorTikTokKeywords();
        const categoryBrandIdMap = new Map(brandIdMap);
        const categoryBrandNameMap = new Map(brandNameMap);
        for (const r of competitorRows) {
          categoryBrandIdMap.set(r.slug, r.id);
          categoryBrandNameMap.set(r.id, r.name);
        }
        const brandCandidates: BrandMatchCandidate[] = [
          ...allTargets.map((t) => ({
            slug: t.brandSlug,
            type: 'own' as const,
            name: brandNameMap.get(brandIdMap.get(t.brandSlug) ?? -1) ?? t.brandSlug,
            keywords: t.keywords,
          })),
          ...competitorRows.map((r) => ({
            slug: r.slug,
            type: 'competitor' as const,
            name: r.name,
            keywords: competitorKeywords[r.slug],
          })),
        ];

        const categoryScraper = new TikTokSearchScraper(
          'category',
          categoryKw,
          { ownHandles, commentThresholds, maxScrolls: limits.maxScrolls, maxPostsPerKeyword: limits.maxPosts, shouldCancel, skipComments, softBlockTracker },
          categoryBrandIdMap,
          categoryBrandNameMap,
          brandCandidates,
        );
    try {
      await categoryScraper.run();
    } catch (err) {
      if (err instanceof ScrapeCancelledError) throw err;
      if (err instanceof TikTokSoftBlockError) throw err;
      console.error(`[TikTokSearch] category search failed: ${err}`);
    }
  }

  console.log('[TikTokSearch] Done');
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (require.main === module) {
  searchAllBrands()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
