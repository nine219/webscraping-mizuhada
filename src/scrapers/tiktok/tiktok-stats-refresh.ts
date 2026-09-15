/**
 * TikTok watchlist + spike-post stats refresh — metadata only (views/likes/
 * shares/comments/engagement + cover_url), weekly cadence. Per explicit
 * request: prioritize watchlisted and spike-flagged posts for re-scraping
 * instead of leaving their numbers frozen at whatever the feed/search cron
 * last happened to catch — these are exactly the posts someone is actively
 * watching or that already proved newsworthy once.
 *
 * Single-post fetch via the video-detail page's SSR payload
 * (__UNIVERSAL_DATA_FOR_REHYDRATION__ → webapp.video-detail.itemInfo.itemStruct),
 * same technique used for the one-off jobjab-post relevance investigation
 * earlier — cheap (one page load, no scrolling) compared to a full feed/
 * search re-scrape.
 */
import type { BrowserContext, Page } from 'playwright';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { detectShopContent } from './shop-detection';
import { launchContext, warmUp, isSessionValid, solveCaptcha } from './tiktok-browser';

const POST_DELAY_MS = parseInt(process.env.TIKTOK_STATS_REFRESH_DELAY_MS ?? '4000', 10);
const MAX_POSTS_PER_RUN = parseInt(process.env.TIKTOK_STATS_REFRESH_MAX_POSTS ?? '150', 10);

interface TargetPost {
  post_id: string;
  author_handle: string | null;
  tiktok_handle: string | null;
}

async function findTargetPosts(): Promise<TargetPost[]> {
  return query<TargetPost>(
    `SELECT tp.post_id, tp.author_handle, b.tiktok_handle
     FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
     WHERE (tp.watchlist = true OR tp.spike_flag = true)
       AND (tp.author_handle IS NOT NULL OR b.tiktok_handle IS NOT NULL)
     ORDER BY tp.scraped_at ASC
     LIMIT $1`,
    [MAX_POSTS_PER_RUN],
  );
}

interface FetchedStats {
  views: number;
  likes: number;
  shares: number;
  comments: number;
  coverUrl: string | null;
  caption: string | null;
  rawItem: unknown;
}

async function fetchPostStats(page: Page, handle: string, postId: string): Promise<FetchedStats | null> {
  await page.goto(`https://www.tiktok.com/@${handle}/video/${postId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_500);

  if (!isSessionValid(page)) {
    await solveCaptcha(page);
    await page.waitForTimeout(2_000);
  }

  const data = await page.evaluate(() => {
    const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el?.textContent) return null;
    try { return JSON.parse(el.textContent) as unknown; } catch { return null; }
  });
  if (!data) return null;

  const defaultScope = (data as Record<string, unknown>)?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined;
  const videoDetail = defaultScope?.['webapp.video-detail'] as Record<string, unknown> | undefined;
  const itemInfo = (videoDetail?.itemInfo as Record<string, unknown> | undefined)?.itemStruct as Record<string, unknown> | undefined;
  if (!itemInfo) return null;

  const stats = (itemInfo.stats as Record<string, number> | undefined) ?? {};
  const video = (itemInfo.video as Record<string, string> | undefined) ?? {};

  return {
    views: stats.playCount ?? 0,
    likes: stats.diggCount ?? 0,
    shares: stats.shareCount ?? 0,
    comments: stats.commentCount ?? 0,
    coverUrl: video.cover ?? video.dynamicCover ?? video.originCover ?? null,
    caption: (itemInfo.desc as string | undefined) ?? null,
    rawItem: itemInfo,
  };
}

export async function refreshWatchlistAndSpikeStats(): Promise<{ refreshed: number; failed: number }> {
  const posts = await findTargetPosts();
  if (posts.length === 0) {
    console.log('[TikTok] [stats-refresh] No watchlisted/spike posts need a refresh');
    return { refreshed: 0, failed: 0 };
  }

  const { ctx, cleanup } = await launchContext();
  let refreshed = 0;
  let failed = 0;

  try {
    await warmUp(ctx);

    for (const [idx, post] of posts.entries()) {
      const handle = post.author_handle || post.tiktok_handle;
      if (!handle) { failed++; continue; }

      const page = await ctx.newPage();
      try {
        const stats = await fetchPostStats(page, handle, post.post_id);
        if (!stats) {
          failed++;
          console.warn(`[TikTok] [stats-refresh] ${post.post_id}: not found (deleted/private?)`);
        } else {
          const engagementRate = stats.views > 0
            ? Number((((stats.likes + stats.shares + stats.comments) / stats.views) * 100).toFixed(4))
            : null;
          const { isShop, signal } = detectShopContent(stats.rawItem, stats.caption);
          await pool.query(
            `UPDATE tiktok_posts
             SET views = $2, likes = $3, shares = $4, comments_count = $5,
                 engagement_rate = $6, cover_url = COALESCE($7, cover_url),
                 is_shop_content = $8, shop_signal = $9, scraped_at = NOW()
             WHERE post_id = $1`,
            [post.post_id, stats.views, stats.likes, stats.shares, stats.comments,
             engagementRate, stats.coverUrl, isShop, signal],
          );
          refreshed++;
        }
      } catch (err) {
        failed++;
        console.error(`[TikTok] [stats-refresh] ${post.post_id} failed:`, err instanceof Error ? err.message : err);
      } finally {
        await page.close().catch(() => {});
      }

      if (idx < posts.length - 1) await new Promise((r) => setTimeout(r, POST_DELAY_MS));
    }
  } finally {
    await cleanup();
  }

  console.log(`[TikTok] [stats-refresh] done — refreshed ${refreshed}, failed ${failed}`);
  return { refreshed, failed };
}

if (require.main === module) {
  refreshWatchlistAndSpikeStats()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
