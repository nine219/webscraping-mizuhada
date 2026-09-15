import { BrowserContext } from 'playwright';
import { solveTikTokCaptcha } from './tiktok-captcha';
import { detectShopContent } from './shop-detection';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { detectSpikes } from '../../analysis/spike-detection';
import { launchContext } from './tiktok-browser';
import { createNotification } from '../../notifications/store';

// ── Account list ──────────────────────────────────────────────────────────────
export const TIKTOK_ACCOUNTS = [
  { brandSlug: 'mizumi',        handle: 'mizumi_official' },
  { brandSlug: 'mizumi',        handle: 'mizumi.mini' },
  { brandSlug: 'mizumi',        handle: 'mizumiglobal' },
  { brandSlug: 'gentle-colors', handle: 'gentlecolorsofficial' },
  { brandSlug: 'gentle-colors', handle: 'gentlecolorsglobal' },
  { brandSlug: 'bomi',          handle: 'bomiofficial_th' },
];

// ── TikTok API response shapes ────────────────────────────────────────────────
interface TikTokApiItem {
  id: string;
  desc: string;
  createTime: number;
  author?: { uniqueId?: string; id?: string };
  video?: { playAddr?: string; downloadAddr?: string; cover?: string; dynamicCover?: string; originCover?: string };
  stats?: {
    playCount?: number;
    diggCount?: number;
    shareCount?: number;
    commentCount?: number;
  };
  challenges?: Array<{ title?: string }>;
  textExtra?: Array<{ awemeId?: string }>;
}

interface TikTokApiResponse {
  itemList?: TikTokApiItem[];
  hasMore?: boolean;
  cursor?: number;
}

interface TikTokPost {
  postId: string;
  videoUrl: string | null;
  coverUrl: string | null;
  caption: string;
  hashtags: string[];
  productLinks: string[];
  views: number;
  likes: number;
  shares: number;
  commentsCount: number;
  postedAt: Date | null;
  engagementRate: number | null;
  rawData: TikTokApiItem;
  isShopContent: boolean;
  shopSignal: string | null;
}

// ── Normalizer ────────────────────────────────────────────────────────────────
function normalizeItem(item: TikTokApiItem): TikTokPost {
  const views  = item.stats?.playCount    ?? 0;
  const likes  = item.stats?.diggCount    ?? 0;
  const shares = item.stats?.shareCount   ?? 0;
  const comms  = item.stats?.commentCount ?? 0;
  const engagementRate = views > 0
    ? Number((((likes + comms + shares) / views) * 100).toFixed(4))
    : null;
  const hashtags     = (item.challenges ?? []).map((c) => c.title ?? '').filter(Boolean);
  const productLinks = (item.textExtra   ?? []).map((t) => t.awemeId ?? '').filter(Boolean);
  const videoUrl     = item.video?.playAddr ?? item.video?.downloadAddr ?? null;
  // Signed CDN URL — expires ~2-3 weeks after scrape (TikTok's x-expires param),
  // not a permanent thumbnail host. Captured best-effort at scrape time; the
  // dashboard falls back to a placeholder once it 404s. No proxying/caching —
  // out of scope, see viral-post-card.tsx.
  const coverUrl     = item.video?.cover ?? item.video?.dynamicCover ?? item.video?.originCover ?? null;
  const { isShop, signal } = detectShopContent(item, item.desc ?? null);
  return {
    postId: item.id,
    videoUrl,
    coverUrl,
    caption: item.desc ?? '',
    hashtags,
    productLinks,
    views, likes, shares,
    commentsCount: comms,
    postedAt: item.createTime ? new Date(item.createTime * 1000) : null,
    engagementRate,
    rawData: item,
    isShopContent: isShop,
    shopSignal: signal,
  };
}

// ── Scraper class ─────────────────────────────────────────────────────────────
export class TikTokFeedScraper {
  constructor(private brandSlug: string, private handle: string, private opts: { maxScrolls?: number; maxPosts?: number; maxAgeDays?: number } = {}) {}

  // Scrape using a pre-existing context (for multi-account runs sharing one browser).
  async runWithContext(context: BrowserContext): Promise<number> {
    const collected = new Map<string, TikTokApiItem>();
    const page = await context.newPage();
    const MAX_AGE_DAYS = this.opts.maxAgeDays ?? 30;
    // 0 = no cutoff (all time) — Settings → Thresholds "Feed max post age".
    const AGE_CUTOFF_MS = MAX_AGE_DAYS > 0 ? Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000 : 0;

    // Intercept item_list responses — browser sends X-Bogus automatically.
    // TikTok uses /api/preload/item_list/ (newer) and /api/post/item_list/ (older).
    // Filter by author handle to exclude recommendation/sidebar posts from other accounts.
    const expectedHandle = this.handle.toLowerCase();
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('tiktok.com/api/') && process.env.TIKTOK_DEBUG === '1') {
        console.log(`\n  [net] ${resp.status()} ${url.replace(/https?:\/\/[^/]+/, '')}`);
      }
      if (
        !url.includes('item_list') &&
        !url.includes('/api/item/detail/') &&
        !url.includes('/api/user/post')
      ) return;
      if (!resp.ok()) return;
      try {
        const body = await resp.json() as TikTokApiResponse & { items?: TikTokApiItem[] };
        // /api/user/post uses `items`, /api/post/item_list uses `itemList`
        const items = body.itemList ?? body.items ?? [];
        // Normalize handle for comparison: "cosrx.th" == "cosrx_th" == "cosrxth"
        const normalize = (s: string) => s.toLowerCase().replace(/[._\-]/g, '');
        const normalizedExpected = normalize(expectedHandle);

        let skipped = 0;
        for (const item of items) {
          if (!item?.id) continue;
          const rawAuthor = item.author?.uniqueId ?? '';
          const authorHandle = normalize(rawAuthor);
          if (authorHandle && authorHandle !== normalizedExpected) {
            skipped++;
            continue;
          }
          collected.set(item.id, item);
        }
        if (skipped > 0) {
          console.log(`\n  [filter] Dropped ${skipped} recommendation posts (not @${this.handle})`);
        }
        if (collected.size > 0) {
          process.stdout.write(`\r  Collected ${collected.size} posts...`);
        }
      } catch { /* ignore */ }
    });

    const profileUrl = `https://www.tiktok.com/@${this.handle}`;
    console.log(`  Navigating to ${profileUrl}...`);
    try {
      try {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(4000);
      } catch (err) {
        console.warn(`  Navigation failed: ${err}`);
        return 0;
      }

      // Check for login redirect
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('loginType')) {
        console.warn(`  Session invalid — redirected to login. Re-copy TIKTOK_COOKIE_HEADER.`);
        return 0;
      }

      // CAPTCHA: try auto-solve via SadCaptcha API first, fall back to manual wait.
      const captchaSolved = await solveTikTokCaptcha(page);
      if (!captchaSolved) {
        // No API key or solve failed — wait for manual solve
        console.log('  [CAPTCHA] Waiting up to 3 min for manual solve...');
        await page.waitForFunction(
          () => !document.querySelector('#captcha_container, [class*="secsdk-captcha"], [id*="captcha-verify"]'),
          { timeout: 180_000 },
        ).catch(() => console.warn('  [CAPTCHA] Timeout — proceeding anyway'));
        await page.waitForTimeout(2000);
      }

      // Scroll to trigger lazy-loaded item_list batches.
      // Desktop layout: TikTok's profile feed scrolls on document.documentElement.
      // Check only per-scroll NEW posts for the age cutoff — avoids pinned-post false stops.
      const MAX_SCROLLS = this.opts.maxScrolls ?? 50;
      const MAX_POSTS   = this.opts.maxPosts ?? Number.POSITIVE_INFINITY;
      let emptyScrolls = 0;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        if (collected.size >= MAX_POSTS) {
          console.log(`\n  Hit MAX_POSTS=${MAX_POSTS} — stopping`);
          break;
        }
        const beforeIds = new Set(collected.keys());
        const before = collected.size;
        await page.evaluate(() => { window.scrollBy(0, 5000); });
        await page.waitForTimeout(2500);

        if (collected.size === before) {
          emptyScrolls++;
          if (emptyScrolls >= 5) {
            console.log(`\n  5 consecutive empty scrolls — stopping`);
            break;
          }
        } else {
          emptyScrolls = 0;
          const newPosts = Array.from(collected.values()).filter((item) => !beforeIds.has(item.id));
          const hitOld = AGE_CUTOFF_MS > 0 && newPosts.some((item) => item.createTime && item.createTime * 1000 < AGE_CUTOFF_MS);
          if (hitOld) {
            console.log(`\n  Reached posts older than ${MAX_AGE_DAYS} days — stopping`);
            break;
          }
        }
      }

      // SSR fallback: TikTok bakes profile posts into __UNIVERSAL_DATA_FOR_REHYDRATION__
      // when it decides not to fire item_list API (bot detection, rate-limit, CDN cache).
      if (collected.size === 0) {
        console.log(`  API interception yielded 0 — trying SSR extraction...`);
        try {
          const ssrItems = await page.evaluate(() => {
            const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (!el?.textContent) return null;
            const root = JSON.parse(el.textContent) as Record<string, unknown>;
            const scope = root['__DEFAULT_SCOPE__'] as Record<string, unknown> | undefined;
            if (!scope) return null;
            // Try multiple known paths TikTok has used across versions
            const userPost = scope['webapp.user-post'] as Record<string, unknown> | undefined;
            const itemList = (userPost?.['itemList'] ?? userPost?.['items']) as unknown[] | undefined;
            if (itemList && itemList.length > 0) return itemList;
            // Older SSR shape: items nested under a feed key
            for (const val of Object.values(scope)) {
              const v = val as Record<string, unknown> | undefined;
              const il = v?.['itemList'] as unknown[] | undefined;
              if (il && il.length > 0) return il;
            }
            return null;
          });

          if (ssrItems && ssrItems.length > 0) {
            const normalize = (s: string) => s.toLowerCase().replace(/[._\-]/g, '');
            const normalizedExpected = normalize(this.handle.toLowerCase());
            let ssrSkipped = 0;
            for (const raw of ssrItems) {
              const item = raw as TikTokApiItem;
              if (!item?.id) continue;
              const authorHandle = normalize(item.author?.uniqueId ?? '');
              if (authorHandle && authorHandle !== normalizedExpected) { ssrSkipped++; continue; }
              collected.set(item.id, item);
            }
            console.log(`  SSR: extracted ${collected.size} posts (${ssrSkipped} skipped — other accounts)`);
          } else {
            const scope = await page.evaluate(() => {
              const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
              if (!el?.textContent) return 'NO_ELEMENT';
              try {
                const root = JSON.parse(el.textContent) as Record<string, unknown>;
                const s = root['__DEFAULT_SCOPE__'] as Record<string, unknown> | undefined;
                return s ? Object.keys(s).join(', ') : 'NO_DEFAULT_SCOPE';
              } catch { return 'PARSE_ERROR'; }
            });
            console.warn(`  SSR: no itemList — scope keys: ${scope}`);
          }
        } catch (err) {
          console.warn(`  SSR extraction failed: ${err}`);
        }
      }

      console.log();
    } finally {
      await page.close().catch(() => {});
    }

    if (collected.size === 0) {
      console.warn(
        `[TikTok/${this.brandSlug}] 0 posts. ` +
        `Handle may be wrong or session expired (check sessionid cookie).`
      );
      return 0;
    }

    // Resolve brand_id
    const brandRows = await query<{ id: number }>(
      `SELECT id FROM brands WHERE slug = $1 LIMIT 1`,
      [this.brandSlug]
    );
    if (brandRows.length === 0) {
      console.warn(`[TikTok/${this.brandSlug}] Brand not in DB — run: npm run db:seed`);
      return 0;
    }
    const brandId = brandRows[0].id;

    // Upsert posts within the age cutoff only (0 = all time, no filter)
    const cutoff = AGE_CUTOFF_MS > 0 ? new Date(AGE_CUTOFF_MS) : null;
    const allCollected = Array.from(collected.values()).map(normalizeItem);
    const filtered = allCollected.filter((p) => !cutoff || !p.postedAt || p.postedAt >= cutoff);
    if (allCollected.length !== filtered.length)
      console.log(`  Filtered ${allCollected.length - filtered.length} posts older than ${MAX_AGE_DAYS} days`);
    const posts = filtered;
    let upsertCount = 0;
    for (const post of posts) {
      try {
        const result = await pool.query<{ is_new: boolean }>(
          `INSERT INTO tiktok_posts (
            brand_id, post_id, video_url, cover_url, caption, hashtags, product_links,
            views, likes, shares, comments_count, posted_at, engagement_rate, raw_data,
            source_type, author_handle, is_shop_content, shop_signal
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (brand_id, post_id) DO UPDATE SET
            views           = EXCLUDED.views,
            likes           = EXCLUDED.likes,
            shares          = EXCLUDED.shares,
            comments_count  = EXCLUDED.comments_count,
            engagement_rate = EXCLUDED.engagement_rate,
            hashtags        = EXCLUDED.hashtags,
            author_handle   = EXCLUDED.author_handle,
            cover_url       = EXCLUDED.cover_url,
            scraped_at      = NOW()
          RETURNING (xmax = 0) AS is_new`,
          [brandId, post.postId, post.videoUrl, post.coverUrl, post.caption, post.hashtags,
           post.productLinks, post.views, post.likes, post.shares,
           post.commentsCount, post.postedAt, post.engagementRate,
           JSON.stringify(post.rawData),
           'feed', this.handle, post.isShopContent, post.shopSignal]
        );
        const isNew = result.rows[0]?.is_new ?? true;
        if (isNew) {
          createNotification({
            type: 'new_post_feed',
            title: 'New TikTok feed post',
            body: `@${this.handle} posted a new video`,
            relatedPostId: post.postId,
            payload: { brandSlug: this.brandSlug, handle: this.handle, caption: post.caption },
          }).catch(() => {});
        }
        upsertCount++;
      } catch (err) {
        console.error(`  Upsert failed for post ${post.postId}: ${err}`);
      }
    }
    console.log(`[TikTok/${this.brandSlug}] Upserted ${upsertCount}/${posts.length} posts`);

    // Spike detection
    try {
      const spikes = await detectSpikes(brandId, this.brandSlug);
      if (spikes.length > 0) console.log(`[TikTok/${this.brandSlug}] ${spikes.length} spike(s) detected`);
    } catch (err) {
      console.error(`  Spike detection failed: ${err}`);
    }

    return upsertCount;
  }

  // Convenience wrapper for single-account use (creates and closes its own context).
  async run(): Promise<number> {
    const { ctx, cleanup } = await launchContext();
    try {
      return await this.runWithContext(ctx);
    } finally {
      await cleanup();
    }
  }
}

// ── Scrape all accounts ───────────────────────────────────────────────────────
export async function scrapeAllTikTok(): Promise<void> {
  const target = process.env.TIKTOK_HANDLE;
  const accounts = target
    ? TIKTOK_ACCOUNTS.filter((a) => a.handle === target || a.brandSlug === target)
    : TIKTOK_ACCOUNTS;

  if (accounts.length === 0) {
    console.warn(`[TikTok] No matching account for TIKTOK_HANDLE="${target}"`);
    return;
  }

  console.log(`[TikTok] Scraping ${accounts.length} account(s)...`);
  const { getThresholds } = await import('../../config/settings-loader');
  const thresholds = await getThresholds().catch(() => null);
  const limits = thresholds?.scrapeLimits.tiktokFeed;
  const { ctx, cleanup } = await launchContext();
  try {
    for (const account of accounts) {
      const scraper = new TikTokFeedScraper(account.brandSlug, account.handle, { maxScrolls: limits?.maxScrolls, maxPosts: limits?.maxPosts, maxAgeDays: thresholds?.feedMaxAgeDays });
      try {
        const count = await scraper.runWithContext(ctx);
        console.log(`[TikTok] ${account.brandSlug} (@${account.handle}): ${count} posts`);
      } catch (err) {
        console.error(`[TikTok] ${account.brandSlug} failed: ${err}`);
      }
    }
  } finally {
    await cleanup();
  }
  console.log('[TikTok] Done');
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeAllTikTok()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
