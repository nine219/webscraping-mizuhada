/**
 * Twitter/X reply + quote-tweet scraper (Playwright) — Phase 4 of X campaign
 * tracking (docs/scope-x-campaigns.md decisions 2 + 8).
 *
 * For each anchor feed post (twitter_posts, source_type='feed' — own-brand
 * MizuMi or ambassador), captures:
 *   - Replies    → https://x.com/<author>/status/<id>            (TweetDetail XHR)
 *   - Quote tweets → https://x.com/<author>/status/<id>/quotes    (timeline XHR)
 *
 * Both land as `social_comments` rows keyed off the anchor post (post_id =
 * anchor's twitter_posts.post_id, parent_comment_id = same — FK-by-value,
 * mirrors tiktok-comments.ts). They are distinguished purely by `is_reply`
 * (true = reply, false = quote tweet) — no new column, per scope decision 2.
 * `source_type='profile'` on BOTH (they hang off our own feed, contrasting
 * with UGC mentions which use source_type='search' — see twitter-search.ts).
 * `sentiment` stays NULL at insert; classifyUnanalyzedComments (analysis/
 * sentiment.ts) picks these rows up on its normal 2h cron, same as every
 * other platform's comments.
 *
 * NOTE — scope boundary: this scrapes comments for EVERY recent feed post
 * (own-brand + ambassador), not just posts belonging to an Active campaign.
 * campaign_id assignment/membership is Phase 5. MizuMi's feed volume is small
 * enough that scraping all of it is cheap; narrowing to Active-campaign posts
 * only is a later optimization, not a Phase 4 concern.
 */
import type { BrowserContext, Page } from 'playwright';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { getThresholds } from '../../config/settings-loader';
import { shouldKeepComment } from '../../analysis/comments';
import { needsTranslation } from '../../analysis/lang-detect';
import { launchAndVerify, LABEL } from './twitter-browser';
import { ScrapeCancelledError, RateLimitedError } from './twitter-search';
import { parseTweetById, updateTweetStats, type FeedTweet } from './twitter-feed';

type ShouldCancel = () => boolean;

// Fallbacks for direct-CLI invocation before settings.thresholds.scrapeLimits.twitterComments
// loads — the live run path (runTwitterCommentsScrape) always passes the settings values.
// Campaign tracking wants EVERY reply/quote on a tracked post, not a capped
// sample — anchor-post volume is low (manual track-link/add-by-id only), so
// there's no real cost to scrolling until X stops returning anything new.
// maxScrolls/maxItems are set high enough to never be the thing that cuts a
// scrape short — STALE_SCROLL_LIMIT (no new items for N scrolls straight) is
// the actual stopping condition in practice. See docs/scope-x-campaigns.md.
const DEFAULT_MAX_SCROLLS = parseInt(process.env.TWITTER_COMMENTS_SCROLL_ROUNDS ?? '500', 10);
const DEFAULT_MAX_ITEMS = parseInt(process.env.TWITTER_COMMENTS_MAX_ITEMS ?? '5000', 10);
// Tested bumping these (4_000/10) to chase a quotes-tab under-count (X
// reported quotes_count=71, we only ever surfaced ~33) — no more quotes
// showed up, just a slower scrape. Confirmed X's public quotes timeline
// itself stops serving past that point, not a scroll-timing issue — reverted.
const SCROLL_WAIT_MS = 2_500;
const STALE_SCROLL_LIMIT = 6;
const GATING_WINDOW_DAYS = 35;
const GATING_GROWTH_THRESHOLD = 5;

// Same cooldown/backoff philosophy as twitter-search.ts / twitter-feed.ts — X
// throttles the whole session, not just one endpoint, so pace between posts.
const POST_DELAY_MS = parseInt(process.env.TWITTER_COMMENTS_POST_DELAY_MS ?? '20000', 10);
const RATE_LIMIT_BACKOFF_MS = parseInt(process.env.TWITTER_RATE_LIMIT_BACKOFF_MS ?? '90000', 10);
const RATE_LIMIT_ABORT_THRESHOLD = parseInt(process.env.TWITTER_RATE_LIMIT_ABORT_THRESHOLD ?? '3', 10);

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

interface CommentTweet {
  id: string;
  content: string;
  author: string;
  authorName: string | null;
  authorFollowers: number | null;
  likes: number;
  retweets: number;
  replies: number;
  views: number | null;
  createdAt: string | null;
}

// ── Shared tweet-result extractor ────────────────────────────────────────────
// Same envelope shape as twitter-search.ts:parseSearchTimeline's inner-node
// extraction (tweet_results.result → legacy/core/user), trimmed to the fields
// a reply/quote row needs. Kept local (not imported) because search's version
// also concatenates retweeted/quoted text into `content`, which we don't want
// here — a reply/quote's own full_text is the content we sentiment.
function tweetFromResult(inner: Record<string, unknown>): CommentTweet | null {
  const legacy = inner.legacy as Record<string, unknown> | undefined;
  if (!legacy) return null;
  const core = inner.core as Record<string, unknown> | undefined;
  const userResult = (core?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
  const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;
  const userCore = userResult?.core as Record<string, unknown> | undefined;
  const id = String((inner.rest_id ?? legacy.id_str ?? '') as string | number);
  if (!id) return null;
  const author = String(((userCore?.screen_name ?? userLegacy?.screen_name) ?? '') as string);
  return {
    id,
    content: String(legacy.full_text ?? ''),
    author,
    authorName: ((userCore?.name ?? userLegacy?.name) as string | undefined) ?? null,
    authorFollowers: (userLegacy?.followers_count as number | undefined) ?? null,
    likes: Number(legacy.favorite_count ?? 0),
    retweets: Number(legacy.retweet_count ?? 0),
    replies: Number(legacy.reply_count ?? 0),
    views: Number((inner.views as Record<string, unknown> | undefined)?.count ?? 0) || null,
    createdAt: (legacy.created_at as string | undefined) ?? null,
  };
}

// ── Reply parser (TweetDetail) ───────────────────────────────────────────────
// TweetDetail's conversation timeline wraps the anchor tweet as a standalone
// "tweet-<id>" entry, then one "conversationthread-<id>" TimelineTimelineModule
// per reply thread. A module's `items[]` holds the direct reply FIRST,
// followed by nested replies-to-that-reply. We walk every item in the
// module (not just items[0]) so nested reply threads are captured too, not
// only the first-level reply — flat into `out` like every other comment,
// since social_comments doesn't model thread depth (parent_comment_id is
// always the anchor post, per file header). Standalone TimelineTimelineItem
// entries that aren't the root (e.g. the author's own self-thread
// continuations) are also captured as top-level.
function parseTweetDetailReplies(body: unknown, rootId: string, out: Map<string, CommentTweet>): void {
  const root = body as Record<string, unknown> | null;
  const data = root?.data as Record<string, unknown> | undefined;
  const threaded = data?.threaded_conversation_with_injections_v2 as Record<string, unknown> | undefined;
  const instructions = (threaded?.instructions as Array<Record<string, unknown>> | undefined) ?? [];

  const extractFromItemContent = (itemContent: Record<string, unknown> | undefined): CommentTweet | null => {
    const result = ((itemContent?.tweet_results as Record<string, unknown> | undefined)?.result) as Record<string, unknown> | undefined;
    return result ? tweetFromResult(result) : null;
  };

  for (const instr of instructions) {
    if (instr.type !== 'TimelineAddEntries') continue;
    const entries = (instr.entries as Array<Record<string, unknown>> | undefined) ?? [];
    for (const entry of entries) {
      const entryId = String(entry.entryId ?? '');
      const content = entry.content as Record<string, unknown> | undefined;
      if (!content) continue;
      const entryType = content.entryType as string | undefined;

      if (entryType === 'TimelineTimelineItem') {
        if (entryId === `tweet-${rootId}`) continue; // skip the anchor itself
        const tw = extractFromItemContent(content.itemContent as Record<string, unknown> | undefined);
        if (tw && tw.id !== rootId) out.set(tw.id, tw);
      } else if (entryType === 'TimelineTimelineModule') {
        const items = (content.items as Array<Record<string, unknown>> | undefined) ?? [];
        for (const item of items) {
          const itemContent = (item?.item as Record<string, unknown> | undefined)?.itemContent as Record<string, unknown> | undefined;
          const tw = extractFromItemContent(itemContent);
          if (tw && tw.id !== rootId) out.set(tw.id, tw);
        }
      }
    }
  }
}

// ── Quote-tweet parser (/status/:id/quotes timeline) ─────────────────────────
// The quotes tab returns a flat SearchTimeline-shaped envelope (same shape
// twitter-search.ts walks) — no top-level/nested distinction needed, so a
// generic deep stack-walk is enough.
function parseQuoteTimeline(body: unknown, out: Map<string, CommentTweet>): void {
  const stack: unknown[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;
    const inner = ((o.itemContent as Record<string, unknown> | undefined)?.tweet_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
    if (inner) {
      const tw = tweetFromResult(inner);
      if (tw) out.set(tw.id, tw);
    }
    for (const key of Object.keys(o)) stack.push(o[key]);
  }
}

// ── Scrape replies for one anchor post ───────────────────────────────────────
export async function scrapePostReplies(
  ctx: BrowserContext,
  authorHandle: string,
  postId: string,
  shouldCancel?: ShouldCancel,
  maxScrolls = DEFAULT_MAX_SCROLLS,
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<{ tweets: CommentTweet[]; rateLimited: boolean; anchorStats: FeedTweet | null }> {
  const page: Page = await ctx.newPage();
  const collected = new Map<string, CommentTweet>();
  let rateLimited = false;
  // This page load is the exact same TweetDetail response fetchSingleTweet()
  // (twitter-feed.ts) hits separately for stats-refresh — capture the
  // anchor's own current stats here for free instead of discarding them.
  // Always overwritten with the LATEST match, not just the first — a long
  // scroll session for a viral post can run minutes past the initial load,
  // and locking in the earliest snapshot would persist stale numbers under
  // a "just refreshed" timestamp.
  let anchorStats: FeedTweet | null = null;

  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!url.includes('/i/api/')) return;
    if (resp.status() === 429) {
      rateLimited = true;
      return;
    }
    if (!url.includes('/i/api/graphql/') || !url.includes('TweetDetail')) return;
    if (!resp.ok()) return;
    try {
      const json = await resp.json() as unknown;
      const before = collected.size;
      parseTweetDetailReplies(json, postId, collected);
      const gained = collected.size - before;
      if (gained > 0 && process.env.TWITTER_DEBUG === '1') {
        console.log(`${LABEL}   [replies xhr] +${gained} replies on ${postId}`);
      }
      const found = parseTweetById(json, postId);
      if (found) anchorStats = found;
    } catch { /* ignore non-json */ }
  };
  page.on('response', onResponse);

  try {
    const url = `https://x.com/${authorHandle}/status/${postId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(3_000);

    let stale = 0;
    for (let i = 0; i < maxScrolls && collected.size < maxItems; i++) {
      if (shouldCancel?.()) throw new ScrapeCancelledError();
      if (rateLimited) break;
      const before = collected.size;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(SCROLL_WAIT_MS);
      if (collected.size === before) {
        if (++stale >= STALE_SCROLL_LIMIT) break;
      } else {
        stale = 0;
      }
    }

    if (rateLimited) {
      console.warn(`${LABEL}   [replies] ${postId}: 429 rate-limited by X — ${collected.size} kept before throttle hit`);
    } else {
      console.log(`${LABEL}   [replies] ${postId}: ${collected.size} replies scraped`);
    }
  } finally {
    page.off('response', onResponse);
    await page.close();
  }

  return { tweets: Array.from(collected.values()).slice(0, maxItems), rateLimited, anchorStats };
}

// ── Scrape quote tweets for one anchor post ──────────────────────────────────
export async function scrapePostQuotes(
  ctx: BrowserContext,
  authorHandle: string,
  postId: string,
  shouldCancel?: ShouldCancel,
  maxScrolls = DEFAULT_MAX_SCROLLS,
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<{ tweets: CommentTweet[]; rateLimited: boolean }> {
  const page: Page = await ctx.newPage();
  const collected = new Map<string, CommentTweet>();
  let rateLimited = false;

  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!url.includes('/i/api/')) return;
    if (resp.status() === 429) {
      rateLimited = true;
      return;
    }
    if (!url.includes('/i/api/graphql/') || !url.includes('SearchTimeline')) return;
    if (!resp.ok()) return;
    try {
      const json = await resp.json() as unknown;
      const before = collected.size;
      parseQuoteTimeline(json, collected);
      const gained = collected.size - before;
      if (gained > 0 && process.env.TWITTER_DEBUG === '1') {
        console.log(`${LABEL}   [quotes xhr] +${gained} quotes on ${postId}`);
      }
    } catch { /* ignore non-json */ }
  };
  page.on('response', onResponse);

  try {
    const url = `https://x.com/${authorHandle}/status/${postId}/quotes`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(3_000);

    let stale = 0;
    for (let i = 0; i < maxScrolls && collected.size < maxItems; i++) {
      if (shouldCancel?.()) throw new ScrapeCancelledError();
      if (rateLimited) break;
      const before = collected.size;
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(SCROLL_WAIT_MS);
      if (collected.size === before) {
        if (++stale >= STALE_SCROLL_LIMIT) break;
      } else {
        stale = 0;
      }
    }

    if (rateLimited) {
      console.warn(`${LABEL}   [quotes] ${postId}: 429 rate-limited by X — ${collected.size} kept before throttle hit`);
    } else {
      console.log(`${LABEL}   [quotes] ${postId}: ${collected.size} quote tweets scraped`);
    }
  } finally {
    page.off('response', onResponse);
    await page.close();
  }

  return { tweets: Array.from(collected.values()).slice(0, maxItems), rateLimited };
}

// ── Target-post gating ───────────────────────────────────────────────────────
// Mirrors tiktok-comments.ts findTargetPosts: never-scraped OR engagement grew
// >= GATING_GROWTH_THRESHOLD since the last scrape's metadata snapshot.
// Deliberately covers ALL recent feed posts (own + ambassador), not just
// Active-campaign posts — see file header note. campaign_id filtering is
// Phase 5.
interface TargetPost {
  post_id: string;
  author_handle: string | null;
  replies: number;
  quotes_count: number;
}

async function findTargetPosts(brandId: number, campaignId?: number, growthDelta = GATING_GROWTH_THRESHOLD): Promise<TargetPost[]> {
  // Scoped to one campaign (manual "Scrape Now" trigger, campaigns.ts): every
  // post already claimed by that campaign, growth gate bypassed — the user
  // just confirmed the campaign and wants replies/quotes now, not on the next
  // 6h cron tick.
  if (campaignId != null) {
    return query<TargetPost>(
      `SELECT post_id, author_handle, replies, quotes_count
       FROM twitter_posts
       WHERE brand_id = $1 AND campaign_id = $2
       ORDER BY posted_at DESC`,
      [brandId, campaignId],
    );
  }
  return query<TargetPost>(
    `SELECT post_id, author_handle, replies, quotes_count
     FROM twitter_posts
     WHERE brand_id = $1
       -- source_type='feed' covers own/ambassador posts as before. Also
       -- include campaign_id IS NOT NULL regardless of source_type — a
       -- campaign "Track by link" anchor on a third-party fan/UGC post
       -- (source_type='search') otherwise only ever gets scraped once, at
       -- track-time, and the recurring cron would never revisit it again to
       -- pick up new replies/quotes.
       AND (source_type = 'feed' OR campaign_id IS NOT NULL)
       AND posted_at >= NOW() - ($2 || ' days')::INTERVAL
       AND (
         comments_scraped_at IS NULL
         OR (replies + quotes_count) - comments_meta_at_scrape >= $3
       )
     ORDER BY posted_at DESC`,
    [brandId, GATING_WINDOW_DAYS, growthDelta],
  );
}

async function loadMizuMiBrand(): Promise<{ id: number } | null> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM brands WHERE twitter_handle IS NOT NULL LIMIT 1`,
  );
  return rows.length ? { id: rows[0].id } : null;
}

// ── Upsert ───────────────────────────────────────────────────────────────────
async function upsertCommentRow(
  tweet: CommentTweet,
  brandId: number,
  anchorPostId: string,
  isReply: boolean,
): Promise<'inserted' | 'updated' | 'skipped'> {
  // allowMentionOnly for quote tweets (isReply=false) — a quote tweet's whole
  // content being "@ourbrand 😍" is someone's own tweet tagging us while
  // quoting our post, not a reply-thread ping to a friend. Replies keep the
  // strict check — "@friend look at this" under our post really is noise.
  if (!shouldKeepComment(tweet.content, { allowMentionOnly: !isReply })) return 'skipped';
  const res = await pool.query<{ inserted: boolean }>(
    `INSERT INTO social_comments
       (brand_id, platform, external_id, content, published_at, post_id, likes_count,
        author_name, views_count, retweets_count, reply_count, author_followers,
        content_translated, source_type, is_reply, parent_comment_id)
     VALUES ($1, 'twitter', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'profile', $13, $14)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       likes_count       = EXCLUDED.likes_count,
       views_count       = EXCLUDED.views_count,
       retweets_count    = EXCLUDED.retweets_count,
       reply_count       = EXCLUDED.reply_count,
       author_followers  = EXCLUDED.author_followers,
       author_name       = EXCLUDED.author_name
     RETURNING (xmax = 0) AS inserted`,
    [
      brandId,
      tweet.id,
      tweet.content,
      tweet.createdAt ? new Date(tweet.createdAt) : null,
      anchorPostId,
      tweet.likes ?? 0,
      // author_name renders as "@{value}" in the UI — store the handle, not
      // the display name, same convention as twitter-search.ts upsertTweet.
      tweet.author || tweet.authorName,
      tweet.views,
      tweet.retweets,
      tweet.replies,
      tweet.authorFollowers,
      needsTranslation(tweet.content) ? null : '',
      isReply,
      anchorPostId,
    ],
  );
  return res.rows[0]?.inserted ? 'inserted' : 'updated';
}

// socialPool's max is 10 connections (social-client.ts) — capping well
// below that leaves headroom for the API/scheduler's other concurrent DB
// work instead of saturating the whole pool during a big comment batch.
const UPSERT_CONCURRENCY = 5;

async function upsertCommentRowsConcurrently(
  tweets: CommentTweet[], brandId: number, anchorPostId: string, isReply: boolean,
): Promise<number> {
  let saved = 0;
  for (let i = 0; i < tweets.length; i += UPSERT_CONCURRENCY) {
    const batch = tweets.slice(i, i + UPSERT_CONCURRENCY);
    const results = await Promise.all(
      batch.map((t) => upsertCommentRow(t, brandId, anchorPostId, isReply)),
    );
    saved += results.filter((r) => r === 'inserted' || r === 'updated').length;
  }
  return saved;
}

// ── Per-post scrape + upsert + gating stamp ──────────────────────────────────
async function scrapeAndUpsertPost(
  ctx: BrowserContext,
  brandId: number,
  post: TargetPost,
  shouldCancel: ShouldCancel | undefined,
  limits: { maxScrolls?: number; maxPosts?: number } | undefined,
  forceQuotes = false,
): Promise<{ saved: number; rateLimited: boolean }> {
  if (!post.author_handle) {
    console.log(`${LABEL} [comments] ${post.post_id} — skipped (no author_handle)`);
    return { saved: 0, rateLimited: false };
  }

  const { tweets: replyTweets, rateLimited: repliesRateLimited, anchorStats } = await scrapePostReplies(
    ctx, post.author_handle, post.post_id, shouldCancel, limits?.maxScrolls, limits?.maxPosts,
  );
  let quoteTweets: CommentTweet[] = [];
  let quotesRateLimited = false;
  // quotes_count is X's own feed-API metadata, which can lag/undercount —
  // forceQuotes (campaign "Scrape Now") always checks the quotes tab instead
  // of trusting that number, since a human just asked for the full picture.
  if (post.quotes_count > 0 || forceQuotes) {
    await cancellableSleep(5_000, shouldCancel);
    ({ tweets: quoteTweets, rateLimited: quotesRateLimited } = await scrapePostQuotes(
      ctx, post.author_handle, post.post_id, shouldCancel, limits?.maxScrolls, limits?.maxPosts,
    ));
  } else {
    console.log(`${LABEL}   [quotes] ${post.post_id}: skipped (quotes_count=0)`);
  }
  const rateLimited = repliesRateLimited || quotesRateLimited;

  // Bounded-concurrency instead of one row per DB round-trip serially — a
  // viral post with thousands of replies previously made this loop run for
  // tens of minutes while holding the cross-process Twitter browser lock
  // (twitter-browser.ts) the whole time, blocking every other operator
  // action that needed it (manual search, track-link, login). pool.query
  // already pools connections, so this is safe at a modest concurrency —
  // not a full rewrite to a bulk multi-row INSERT, which risks more for a
  // feature verified live just this session.
  const saved = (await Promise.all([
    upsertCommentRowsConcurrently(replyTweets, brandId, post.post_id, true),
    upsertCommentRowsConcurrently(quoteTweets, brandId, post.post_id, false),
  ])).reduce((a, b) => a + b, 0);

  // These two writes are gated independently, not by the same `rateLimited`
  // flag — anchorStats comes from the replies fetch alone, so a 429 on the
  // (separate) quotes tab shouldn't throw away a perfectly good stats
  // snapshot the replies fetch already got. The comments-gate stamp still
  // needs the combined `rateLimited` since it summarizes both replies AND
  // quotes counts. Run concurrently since they touch disjoint columns with
  // no ordering dependency between them.
  const writes: Promise<unknown>[] = [];
  if (!rateLimited) {
    // Only stamp the gate when the run wasn't rate-limited — a 429'd attempt
    // isn't a real "we checked and found N" result, so let the next tick
    // retry it rather than silently locking in a stale/undercounted snapshot.
    writes.push(pool.query(
      `UPDATE twitter_posts SET
         comments_meta_at_scrape = $3,
         comments_scraped_at     = NOW()
       WHERE post_id = $1 AND brand_id = $2`,
      [post.post_id, brandId, post.replies + post.quotes_count],
    ));
  }
  if (!repliesRateLimited && anchorStats) {
    // Free refresh of the anchor's own views/likes/retweets/replies/quotes —
    // this page load already had them (twitter-stats-refresh.ts fetches the
    // same TweetDetail response separately for posts this scrape doesn't
    // happen to visit).
    writes.push(updateTweetStats(post.post_id, brandId, {
      views: anchorStats.views,
      likes: anchorStats.likes,
      retweetsCount: anchorStats.retweetsCount,
      replies: anchorStats.replies,
      quotesCount: anchorStats.quotesCount,
    }));
  }
  if (writes.length > 0) {
    await Promise.all(writes);
  }

  return { saved, rateLimited };
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function runTwitterCommentsScrape(
  shouldCancel?: ShouldCancel,
  opts?: { campaignId?: number },
): Promise<{ total: number; rateLimitedPosts: string[] }> {
  const brand = await loadMizuMiBrand();
  if (!brand) {
    console.warn(`${LABEL} [comments] No brand has twitter_handle set — nothing to scrape`);
    return { total: 0, rateLimitedPosts: [] };
  }

  const growthDelta = (await getThresholds().catch(() => null))?.commentGrowthDelta ?? GATING_GROWTH_THRESHOLD;
  const posts = await findTargetPosts(brand.id, opts?.campaignId, growthDelta);
  if (posts.length === 0) {
    console.log(`${LABEL} [comments] No feed posts need reply/quote scraping`);
    return { total: 0, rateLimitedPosts: [] };
  }

  const limits = (await getThresholds().catch(() => null))?.scrapeLimits.twitterComments;
  const ctx = await launchAndVerify();
  let total = 0;
  const rateLimitedPosts: string[] = [];
  let consecutiveRateLimits = 0;
  const forceQuotes = opts?.campaignId != null;

  try {
    for (const [idx, post] of posts.entries()) {
      if (shouldCancel?.()) throw new ScrapeCancelledError();
      let hitRateLimit = false;
      try {
        const { saved, rateLimited } = await scrapeAndUpsertPost(ctx, brand.id, post, shouldCancel, limits, forceQuotes);
        total += saved;
        hitRateLimit = rateLimited;
        console.log(`${LABEL} [comments] ${post.post_id}: upserted ${saved}`);
      } catch (err) {
        if (err instanceof ScrapeCancelledError) throw err;
        console.error(`${LABEL} [comments] ${post.post_id} failed:`, err instanceof Error ? err.message : err);
      }

      if (hitRateLimit) {
        rateLimitedPosts.push(post.post_id);
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= RATE_LIMIT_ABORT_THRESHOLD) {
          throw new RateLimitedError(consecutiveRateLimits);
        }
        console.warn(`${LABEL} [comments] rate-limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s before next post`);
        await cancellableSleep(RATE_LIMIT_BACKOFF_MS, shouldCancel);
      } else {
        consecutiveRateLimits = 0;
      }

      if (idx < posts.length - 1) await cancellableSleep(POST_DELAY_MS, shouldCancel);
    }
  } finally {
    await ctx.close();
  }

  if (rateLimitedPosts.length > 0) {
    console.warn(`${LABEL} [comments] done — total upserted: ${total} — rate-limited on ${rateLimitedPosts.length} post(s): ${rateLimitedPosts.join(', ')}`);
  } else {
    console.log(`${LABEL} [comments] done — total upserted: ${total}`);
  }
  return { total, rateLimitedPosts };
}

if (require.main === module) {
  runTwitterCommentsScrape()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
