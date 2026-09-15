/**
 * X tweet stats refresh (Playwright) — closes the gap documented in
 * analysis/spike-detection.ts's detectTwitterSpikes() header comment: nothing
 * refreshed a tracked tweet's own views/likes/retweets_count/engagement_rate
 * after "Track by X link" / add-by-id first saved it.
 *
 * twitter-comments.ts's recurring reply-scrape now captures the anchor's own
 * stats too (it loads the same TweetDetail response, see scrapePostReplies /
 * updateTweetStats) whenever its own gating condition makes it visit a post's
 * page — so most tracked posts get refreshed "for free" there. But that gate
 * only fires on reply/quote-count growth, which a post can miss entirely
 * while still gaining views/likes/reshares (embeds, algorithmic push). This
 * job is the backstop for exactly those posts: it re-fetches each tracked
 * post via the same single-tweet fetch used at track time
 * (twitter-feed.ts:fetchSingleTweet) and upserts it, but skips any post the
 * comments-scrape already refreshed within this job's own cadence — see
 * findTrackedPosts' stats_refreshed_at condition below. Deliberately reads
 * stats_refreshed_at, not comments_scraped_at: the latter is stamped
 * whenever replies/quotes were scraped, which can happen even when the
 * anchor's own stats failed to parse out of that same response — reusing it
 * as a freshness signal would make this backstop skip a post that actually
 * still needs refreshing.
 */
import { socialQuery as query } from '../../db/social-client';
import { launchAndVerify, LABEL } from './twitter-browser';
import { fetchSingleTweet, upsertFeedTweet } from './twitter-feed';

// Same horizon as twitter-comments.ts's GATING_WINDOW_DAYS — bounds cost to
// posts anyone still plausibly cares about, not the full lifetime archive.
const REFRESH_WINDOW_DAYS = 35;
const POST_DELAY_MS = parseInt(process.env.TWITTER_STATS_REFRESH_DELAY_MS ?? '15000', 10);
const MAX_POSTS_PER_RUN = parseInt(process.env.TWITTER_STATS_REFRESH_MAX_POSTS ?? '50', 10);

async function loadMizuMiBrand(): Promise<{ id: number } | null> {
  const rows = await query<{ id: number }>(`SELECT id FROM brands WHERE twitter_handle IS NOT NULL LIMIT 1`);
  return rows.length ? { id: rows[0].id } : null;
}

interface TrackedPost {
  post_id: string;
  author_handle: string | null;
  is_ambassador: boolean;
}

async function findTrackedPosts(brandId: number): Promise<TrackedPost[]> {
  return query<TrackedPost>(
    `SELECT post_id, author_handle, is_ambassador
     FROM twitter_posts
     WHERE brand_id = $1
       AND source_type = 'feed'
       AND posted_at >= NOW() - ($2 || ' days')::INTERVAL
       AND author_handle IS NOT NULL
       -- Skip posts twitter-comments.ts already refreshed (via the same
       -- TweetDetail response it fetches for replies) within this job's own
       -- cadence — no need to pay for another page load of the same data.
       -- stats_refreshed_at only gets set when updateTweetStats() actually
       -- ran (twitter-feed.ts), unlike comments_scraped_at which is stamped
       -- regardless of whether the anchor's own stats were captured.
       AND (stats_refreshed_at IS NULL OR stats_refreshed_at < NOW() - INTERVAL '3 hours')
     ORDER BY posted_at DESC
     LIMIT $3`,
    [brandId, REFRESH_WINDOW_DAYS, MAX_POSTS_PER_RUN],
  );
}

export async function refreshTrackedTweetStats(): Promise<{ refreshed: number; failed: number }> {
  const brand = await loadMizuMiBrand();
  if (!brand) {
    console.warn(`${LABEL} [stats-refresh] No brand has twitter_handle set — nothing to refresh`);
    return { refreshed: 0, failed: 0 };
  }

  const posts = await findTrackedPosts(brand.id);
  if (posts.length === 0) {
    console.log(`${LABEL} [stats-refresh] No tracked posts need a refresh`);
    return { refreshed: 0, failed: 0 };
  }

  const ctx = await launchAndVerify();
  let refreshed = 0;
  let failed = 0;

  try {
    for (const [idx, post] of posts.entries()) {
      try {
        const fresh = await fetchSingleTweet(post.author_handle!, post.post_id, ctx);
        if (fresh) {
          await upsertFeedTweet(fresh, brand.id, post.is_ambassador, 'feed');
          refreshed++;
        } else {
          failed++;
          console.warn(`${LABEL} [stats-refresh] ${post.post_id}: not found (deleted/private?)`);
        }
      } catch (err) {
        failed++;
        console.error(`${LABEL} [stats-refresh] ${post.post_id} failed:`, err instanceof Error ? err.message : err);
      }
      if (idx < posts.length - 1) await new Promise((r) => setTimeout(r, POST_DELAY_MS));
    }
  } finally {
    await ctx.close();
  }

  console.log(`${LABEL} [stats-refresh] done — refreshed ${refreshed}, failed ${failed}`);
  return { refreshed, failed };
}

if (require.main === module) {
  refreshTrackedTweetStats()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
