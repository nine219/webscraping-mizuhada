/**
 * One-off X/Twitter feed backfill — NOT wired into cron.
 *
 * The regular feed walk (own-brand/ambassador timeline crawl) was
 * intentionally removed in favor of manual "Track by link" tracking
 * (see src/scrapers/twitter/twitter-feed.ts header). twitter_posts stalled
 * at whatever the last feed run caught. This script restores just enough
 * of the old walk (git show 986bb61:src/scrapers/twitter/twitter-feed.ts)
 * to do a single deep, no-cutoff pass — max scrolls, no age limit — to pull
 * as much of each handle's history as X's web timeline will still serve.
 *
 * Run once, manually:
 *   npx ts-node -r dotenv/config scripts/twitter-feed-backfill.ts dotenv_config_path=.env.local
 */
import type { BrowserContext, Page } from 'playwright';
import { socialQuery as query } from '../src/db/social-client';
import { launchAndVerify, LABEL } from '../src/scrapers/twitter/twitter-browser';
import { ScrapeCancelledError, RateLimitedError } from '../src/scrapers/twitter/twitter-search';
import { upsertFeedTweet, type FeedTweet } from '../src/scrapers/twitter/twitter-feed';

// No cap — let STALE_SCROLL_LIMIT be the thing that ends the scrape, not an
// arbitrary count. X's own timeline eventually just stops returning new
// items (rest-history cutoff / rate limit), which is the real ceiling.
const MAX_SCROLLS = 100_000;
const MAX_POSTS = 100_000;
const MAX_AGE_DAYS = 0; // 0 = no cutoff, all-time
const SCROLL_WAIT_MS = 2_500;
// Bumped from the old default of 3 — a deep backfill can hit longer runs of
// "nothing new this scroll" than a routine incremental pass before X finally
// serves older items, so give it more patience before giving up.
const STALE_SCROLL_LIMIT = 10;
const HANDLE_DELAY_MS = 45_000;
const RATE_LIMIT_BACKOFF_MS = 90_000;
const RATE_LIMIT_ABORT_THRESHOLD = 3;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Response parser (mirrors old twitter-feed.ts:parseUserTimeline) ─────────
function parseUserTimeline(body: unknown, out: Map<string, FeedTweet>, expectedAuthor: string): void {
  const normalize = (s: string) => s.toLowerCase().replace(/^@/, '');
  const expected = normalize(expectedAuthor);
  const stack: unknown[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;

    const inner = ((o.itemContent as Record<string, unknown> | undefined)?.tweet_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
    if (inner) {
      const legacy = inner.legacy as Record<string, unknown> | undefined;
      const core = inner.core as Record<string, unknown> | undefined;
      const userResult = (core?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
      const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;
      const userCore = userResult?.core as Record<string, unknown> | undefined;
      const id = String((inner.rest_id ?? legacy?.id_str ?? '') as string | number);
      if (id && legacy) {
        const author = String(((userCore?.screen_name ?? userLegacy?.screen_name) ?? '') as string);
        if (normalize(author) !== expected) {
          for (const key of Object.keys(o)) stack.push(o[key]);
          continue;
        }

        const caption = String(legacy.full_text ?? '');
        const entityHashtags = ((legacy.entities as Record<string, unknown> | undefined)?.hashtags as Array<Record<string, unknown>> | undefined) ?? [];
        const hashtagsFromEntities = entityHashtags.map((h) => String(h.text ?? '')).filter(Boolean);
        const hashtagsFromText = Array.from(caption.matchAll(/#(\S+)/g)).map((m) => m[1]);
        const hashtags = Array.from(new Set([...hashtagsFromEntities, ...hashtagsFromText]));

        out.set(id, {
          id,
          author,
          caption,
          hashtags,
          views: Number((inner.views as Record<string, unknown> | undefined)?.count ?? 0) || 0,
          likes: Number(legacy.favorite_count ?? 0),
          retweetsCount: Number(legacy.retweet_count ?? 0),
          replies: Number(legacy.reply_count ?? 0),
          quotesCount: Number(legacy.quote_count ?? 0),
          postedAt: legacy.created_at ? new Date(legacy.created_at as string) : null,
          postUrl: `https://x.com/${author}/status/${id}`,
          rawData: inner,
        });
      }
    }

    for (const key of Object.keys(o)) stack.push(o[key]);
  }
}

// ── Scrape one handle's timeline, deep + no cutoff ───────────────────────────
async function scrapeHandleTimelineDeep(
  ctx: BrowserContext,
  handle: string,
): Promise<{ tweets: FeedTweet[]; rateLimited: boolean }> {
  const page: Page = await ctx.newPage();
  const collected = new Map<string, FeedTweet>();
  let rateLimited = false;

  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!url.includes('/i/api/')) return;
    if (resp.status() === 429) {
      rateLimited = true;
      return;
    }
    if (!url.includes('/i/api/graphql/') || !url.includes('UserTweets')) return;
    if (!resp.ok()) return;
    try {
      const json = await resp.json() as unknown;
      const before = collected.size;
      parseUserTimeline(json, collected, handle);
      const gained = collected.size - before;
      if (gained > 0) {
        console.log(`${LABEL}   [backfill] +${gained} tweets from @${handle} (total ${collected.size})`);
      }
    } catch { /* ignore non-json */ }
  };
  page.on('response', onResponse);

  try {
    console.log(`${LABEL} [backfill] Navigating to @${handle}...`);
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(3_000);

    let stale = 0;
    for (let i = 0; i < MAX_SCROLLS && collected.size < MAX_POSTS; i++) {
      if (rateLimited) break;
      const before = collected.size;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(SCROLL_WAIT_MS);

      if (collected.size === before) {
        if (++stale >= STALE_SCROLL_LIMIT) {
          console.log(`${LABEL}   [backfill] @${handle}: ${STALE_SCROLL_LIMIT} scrolls with no new tweets — assuming end of history`);
          break;
        }
      } else {
        stale = 0;
      }

      if (i > 0 && i % 20 === 0) {
        console.log(`${LABEL}   [backfill] @${handle}: scroll ${i}, ${collected.size} tweets so far`);
      }
    }

    if (rateLimited) {
      console.warn(`${LABEL}   [backfill] @${handle}: 429 rate-limited by X — ${collected.size} tweets kept before throttle hit`);
    } else {
      console.log(`${LABEL}   [backfill] @${handle}: done, ${collected.size} tweets scraped total`);
    }
  } finally {
    page.off('response', onResponse);
    await page.close();
  }

  void MAX_AGE_DAYS; // no-cutoff by design — kept as a documented constant, not read
  return { tweets: Array.from(collected.values()), rateLimited };
}

interface FeedTarget {
  handle: string;
  isAmbassador: boolean;
}

async function loadMizuMiBrand(): Promise<{ id: number; twitterHandle: string } | null> {
  const rows = await query<{ id: number; twitter_handle: string }>(
    `SELECT id, twitter_handle FROM brands WHERE twitter_handle IS NOT NULL AND twitter_handle != '' LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, twitterHandle: rows[0].twitter_handle };
}

async function loadAmbassadorHandles(brandId: number): Promise<string[]> {
  const rows = await query<{ handle: string }>(
    `SELECT DISTINCT unnest(ambassador_handles) AS handle
     FROM campaigns
     WHERE brand_id = $1`, // all campaigns, not just active — this is a one-off deep backfill
    [brandId],
  );
  return rows.map((r) => r.handle).filter(Boolean);
}

async function main() {
  const brand = await loadMizuMiBrand();
  if (!brand) {
    console.warn(`${LABEL} [backfill] No brand has twitter_handle set — nothing to scrape`);
    return;
  }

  const ambassadorHandles = await loadAmbassadorHandles(brand.id);
  const targets: FeedTarget[] = [
    { handle: brand.twitterHandle, isAmbassador: false },
    ...ambassadorHandles.map((h) => ({ handle: h, isAmbassador: true })),
  ];
  console.log(`${LABEL} [backfill] targets: ${targets.map((t) => '@' + t.handle).join(', ')}`);

  const ctx = await launchAndVerify();
  let total = 0;
  const rateLimitedHandles: string[] = [];
  let consecutiveRateLimits = 0;

  try {
    for (const [idx, target] of targets.entries()) {
      let hitRateLimit = false;
      try {
        const { tweets, rateLimited } = await scrapeHandleTimelineDeep(ctx, target.handle);
        hitRateLimit = rateLimited;
        let handleCount = 0;
        for (const tweet of tweets) {
          const r = await upsertFeedTweet(tweet, brand.id, target.isAmbassador);
          if (r === 'inserted' || r === 'updated') handleCount++;
        }
        total += handleCount;
        console.log(`${LABEL} [backfill] @${target.handle}: upserted ${handleCount}/${tweets.length}`);
      } catch (err) {
        if (err instanceof ScrapeCancelledError) throw err;
        console.error(`${LABEL} [backfill] @${target.handle} failed:`, err instanceof Error ? err.message : err);
      }

      if (hitRateLimit) {
        rateLimitedHandles.push(target.handle);
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= RATE_LIMIT_ABORT_THRESHOLD) {
          throw new RateLimitedError(consecutiveRateLimits);
        }
        console.warn(`${LABEL} [backfill] rate-limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s before next handle`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
      } else {
        consecutiveRateLimits = 0;
      }

      if (idx < targets.length - 1) await sleep(HANDLE_DELAY_MS);
    }
  } finally {
    await ctx.close();
  }

  if (rateLimitedHandles.length > 0) {
    console.warn(`${LABEL} [backfill] DONE — total upserted: ${total} — rate-limited on: ${rateLimitedHandles.join(', ')}`);
  } else {
    console.log(`${LABEL} [backfill] DONE — total upserted: ${total}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
