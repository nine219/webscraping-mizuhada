/**
 * Twitter/X single-tweet fetch (Playwright)
 *
 * Feed scraping (walking own-brand/ambassador timelines) was removed —
 * campaign tracking is manual-only now (Track by X link / add-by-id, see
 * api/routes/campaigns.ts), so there's no need to keep crawling timelines
 * for candidate posts. What's left here is the "track by link" path:
 * live-fetch one tweet by URL, verify it's real, and upsert it.
 */
import type { BrowserContext, Page } from 'playwright';
import { socialPool as pool } from '../../db/social-client';
import { launchAndVerify } from './twitter-browser';

export interface FeedTweet {
  id: string;
  author: string;
  caption: string;
  hashtags: string[];
  views: number;
  likes: number;
  retweetsCount: number;
  replies: number;
  quotesCount: number;
  postedAt: Date | null;
  postUrl: string;
  rawData: unknown;
}

// Shared by upsertFeedTweet and updateTweetStats so the definition of
// "engagement rate" can't silently drift between the two write paths.
function computeEngagementRate(views: number, likes: number, replies: number, retweetsCount: number, quotesCount: number): number | null {
  return views > 0
    ? Number((((likes + replies + retweetsCount + quotesCount) / views) * 100).toFixed(4))
    : null;
}

// ── Upsert ───────────────────────────────────────────────────────────────────
// sourceType: 'feed' for MizuMi's own account or a registered campaign
// ambassador; 'search' for anyone else a human manually tracked by link (a
// fan/UGC author is not "our feed" just because someone pasted their tweet —
// conflating the two broke campaign hashtag-search, which assumed
// source_type='feed' meant "our own content").
export async function upsertFeedTweet(
  tweet: FeedTweet, brandId: number, isAmbassador: boolean, sourceType: 'feed' | 'search' = 'feed',
): Promise<'inserted' | 'updated'> {
  const engagementRate = computeEngagementRate(tweet.views, tweet.likes, tweet.replies, tweet.retweetsCount, tweet.quotesCount);
  const res = await pool.query<{ is_new: boolean }>(
    `INSERT INTO twitter_posts (
       brand_id, post_id, post_url, caption, hashtags,
       views, likes, retweets_count, replies, quotes_count,
       posted_at, engagement_rate, source_type, author_handle, raw_data, is_ambassador
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (brand_id, post_id) DO UPDATE SET
       views            = EXCLUDED.views,
       likes            = EXCLUDED.likes,
       retweets_count   = EXCLUDED.retweets_count,
       replies          = EXCLUDED.replies,
       quotes_count     = EXCLUDED.quotes_count,
       engagement_rate  = EXCLUDED.engagement_rate,
       hashtags         = EXCLUDED.hashtags,
       is_ambassador    = EXCLUDED.is_ambassador,
       scraped_at       = NOW()
     RETURNING (xmax = 0) AS is_new`,
    [
      brandId,
      tweet.id,
      tweet.postUrl,
      tweet.caption,
      tweet.hashtags,
      tweet.views,
      tweet.likes,
      tweet.retweetsCount,
      tweet.replies,
      tweet.quotesCount,
      tweet.postedAt,
      engagementRate,
      sourceType,
      tweet.author,
      JSON.stringify(tweet.rawData),
      isAmbassador,
    ],
  );
  return res.rows[0]?.is_new ? 'inserted' : 'updated';
}

// Stats-only update for an already-tracked post — used when we already have
// fresh views/likes/retweets/replies/quotes from a TweetDetail response
// fetched for another reason (twitter-comments.ts's reply scrape hits the
// same URL and used to discard the anchor tweet's own stats). Deliberately
// narrower than upsertFeedTweet: never touches caption/hashtags/source_type/
// is_ambassador, since the caller here doesn't know those values and
// overwriting them with a guess would be wrong.
//
// Scoped by (brand_id, post_id) — twitter_posts' actual uniqueness (schema:
// UNIQUE (brand_id, post_id)) — not post_id alone. The same tweet can
// legitimately be tracked under two different brands (e.g. a shared
// ambassador post), and a post_id-only WHERE would clobber the other
// brand's row with data from a scrape it never ran this cycle.
//
// Sets stats_refreshed_at, a dedicated freshness signal separate from
// comments_scraped_at (which means "replies/quotes were scraped", a
// different question) — twitter-stats-refresh.ts's backstop reads this
// column specifically so it never mistakes "we visited the page" for
// "we actually wrote fresh stats."
export async function updateTweetStats(
  postId: string,
  brandId: number,
  stats: { views: number; likes: number; retweetsCount: number; replies: number; quotesCount: number },
): Promise<void> {
  const engagementRate = computeEngagementRate(stats.views, stats.likes, stats.replies, stats.retweetsCount, stats.quotesCount);
  await pool.query(
    `UPDATE twitter_posts SET
       views              = $3,
       likes              = $4,
       retweets_count     = $5,
       replies            = $6,
       quotes_count       = $7,
       engagement_rate    = $8,
       scraped_at         = NOW(),
       stats_refreshed_at = NOW()
     WHERE post_id = $1 AND brand_id = $2`,
    [postId, brandId, stats.views, stats.likes, stats.retweetsCount, stats.replies, stats.quotesCount, engagementRate],
  );
}

// ── Manual single-tweet fetch (campaign "track by link") ────────────────────
// Live-fetches ONE tweet by URL and returns its current metadata, or null if
// the URL doesn't parse or the tweet doesn't resolve (deleted/private/typo).
// Used by POST /api/campaigns/:id/track-link — a human pasted a link, we
// verify it's real before saving it as an anchor post, rather than trusting
// hashtag auto-detection to have found the right thing.
export function parseTweetUrl(url: string): { handle: string; postId: string } | null {
  const m = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i);
  if (!m) return null;
  return { handle: m[1], postId: m[2] };
}

export function parseTweetById(body: unknown, postId: string): FeedTweet | null {
  const stack: unknown[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;
    const inner = ((o.itemContent as Record<string, unknown> | undefined)?.tweet_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
    if (inner) {
      const legacy = inner.legacy as Record<string, unknown> | undefined;
      const id = String((inner.rest_id ?? legacy?.id_str ?? '') as string | number);
      if (id === postId && legacy) {
        const core = inner.core as Record<string, unknown> | undefined;
        const userResult = (core?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
        const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;
        const userCore = userResult?.core as Record<string, unknown> | undefined;
        const author = String(((userCore?.screen_name ?? userLegacy?.screen_name) ?? '') as string);
        const caption = String(legacy.full_text ?? '');
        const entityHashtags = ((legacy.entities as Record<string, unknown> | undefined)?.hashtags as Array<Record<string, unknown>> | undefined) ?? [];
        const hashtagsFromEntities = entityHashtags.map((h) => String(h.text ?? '')).filter(Boolean);
        const hashtagsFromText = Array.from(caption.matchAll(/#(\S+)/g)).map((mm) => mm[1]);
        const hashtags = Array.from(new Set([...hashtagsFromEntities, ...hashtagsFromText]));
        return {
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
        };
      }
    }
    for (const key of Object.keys(o)) stack.push(o[key]);
  }
  return null;
}

export async function fetchSingleTweet(authorHandle: string, postId: string, ctx?: BrowserContext): Promise<FeedTweet | null> {
  const ownCtx = ctx ?? await launchAndVerify();
  const page: Page = await ownCtx.newPage();
  let found: FeedTweet | null = null;
  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!url.includes('/i/api/graphql/') || !url.includes('TweetDetail')) return;
    if (!resp.ok()) return;
    try {
      const json = await resp.json() as unknown;
      const tw = parseTweetById(json, postId);
      if (tw) found = tw;
    } catch { /* ignore non-json */ }
  };
  page.on('response', onResponse);
  try {
    await page.goto(`https://x.com/${authorHandle}/status/${postId}`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    // Poll instead of a fixed 3s wait — under X throttling the TweetDetail
    // XHR can land well after 3s, which previously caused a valid tweet to
    // be misreported as "not found" (campaigns.ts then marks the tracked
    // post 'failed' and stops refreshing its stats). Exit early the moment
    // the response is parsed; give slow responses up to 10s total.
    const deadline = Date.now() + 10_000;
    while (!found && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }
  } finally {
    page.off('response', onResponse);
    await page.close();
    if (!ctx) await ownCtx.close();
  }
  return found;
}
