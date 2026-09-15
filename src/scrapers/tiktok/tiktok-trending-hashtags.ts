/**
 * TikTok Trending Hashtags Scraper
 *
 * Primary strategy: Aggregate brand-specific hashtags from existing tiktok_posts rows
 * (always works, no Playwright needed).
 *
 * Secondary strategy (hook point): Navigate to https://www.tiktok.com/explore via
 * Playwright and intercept the explore item_list API. This is gated behind the
 * TIKTOK_TRENDING_SCRAPE=1 env var. If TikTok's explore page structure changes,
 * disable it with TIKTOK_TRENDING_SCRAPE=0 (default) to fall back to DB aggregation.
 */

import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { buildCookieHeader } from './tiktok-auth';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExploreHashtagItem {
  hashtag?: string;
  challengeInfo?: { challengeName?: string; stats?: { videoCount?: number } };
}

interface TrendingRow {
  hashtag: string;
  category: 'trending' | 'brand';
  brand_slug: string | null;
  view_count: number | null;
  post_count: number | null;
}

// ── Playwright scrape of TikTok Explore (optional) ───────────────────────────

async function scrapeExploreHashtags(): Promise<TrendingRow[]> {
  const cookieHeader = buildCookieHeader();
  if (!cookieHeader) {
    console.warn('[TrendingHashtags] No TIKTOK_COOKIE_HEADER — skipping Playwright explore scrape');
    return [];
  }

  let browser: import('playwright').Browser | null = null;
  const results: TrendingRow[] = [];

  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: process.env.TIKTOK_DEBUG !== '1',
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      viewport: { width: 393, height: 852 },
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
    });

    // Inject cookies
    const cookies = cookieHeader.split(';').flatMap((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return [];
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name || !value) return [];
      return [{ name, value, domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' as const }];
    });
    if (cookies.length > 0) await ctx.addCookies(cookies);

    const page = await ctx.newPage();
    const intercepted: ExploreHashtagItem[] = [];

    // Intercept explore API responses
    page.on('response', async (resp) => {
      const url = resp.url();
      if (!url.includes('/api/explore/item_list') && !url.includes('/explore/item_list')) return;
      if (!resp.ok()) return;
      try {
        const body = await resp.json() as { itemList?: unknown[] };
        const items = (body.itemList ?? []) as ExploreHashtagItem[];
        intercepted.push(...items);
      } catch { /* ignore */ }
    });

    console.log('  [TrendingHashtags] Navigating to TikTok Explore...');
    await page.goto('https://www.tiktok.com/explore', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(5000);

    // Also try scraping challenge/hashtag cards from the DOM
    try {
      const domHashtags = await page.$$eval(
        '[data-e2e="explore-card"] a[href*="/tag/"], a[href*="/challenge/"]',
        (els: Element[]) =>
          els.map((el) => {
            const href = (el as HTMLAnchorElement).href ?? '';
            const match = href.match(/\/(?:tag|challenge)\/([^/?]+)/);
            return match ? match[1] : null;
          }).filter(Boolean)
      );
      for (const tag of domHashtags) {
        if (tag) {
          results.push({ hashtag: tag, category: 'trending', brand_slug: null, view_count: null, post_count: null });
        }
      }
    } catch { /* DOM structure may vary */ }

    // Process intercepted API items
    for (const item of intercepted) {
      const name = item.challengeInfo?.challengeName ?? item.hashtag;
      const views = item.challengeInfo?.stats?.videoCount ?? null;
      if (name) {
        results.push({ hashtag: name, category: 'trending', brand_slug: null, view_count: views, post_count: null });
      }
    }

    await ctx.close();
  } catch (err) {
    console.warn(`  [TrendingHashtags] Playwright explore scrape failed: ${err}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }

  return results;
}

// ── Brand hashtag aggregation from DB ────────────────────────────────────────

async function aggregateBrandHashtags(): Promise<TrendingRow[]> {
  interface BrandHashtagRow {
    hashtag: string;
    brand_slug: string;
    count: string;
  }

  const rows = await query<BrandHashtagRow>(
    `SELECT
       unnest(tp.hashtags) AS hashtag,
       b.slug AS brand_slug,
       COUNT(*) AS count
     FROM tiktok_posts tp
     JOIN brands b ON b.id = tp.brand_id
     WHERE tp.posted_at >= NOW() - INTERVAL '30 days'
       AND tp.hashtags IS NOT NULL
     GROUP BY 1, 2
     ORDER BY count DESC
     LIMIT 100`
  );

  return rows.map((r) => ({
    hashtag:    r.hashtag,
    category:   'brand' as const,
    brand_slug: r.brand_slug,
    view_count: null,
    post_count: parseInt(r.count, 10),
  }));
}

// ── Upsert into trending_hashtags ─────────────────────────────────────────────

async function upsertTrendingHashtags(rows: TrendingRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    for (const r of rows) {
      await client.query(
        `INSERT INTO trending_hashtags (hashtag, category, brand_slug, view_count, post_count, scraped_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [r.hashtag, r.category, r.brand_slug ?? null, r.view_count ?? null, r.post_count ?? null]
      );
    }
    console.log(`  [TrendingHashtags] Inserted ${rows.length} rows`);
  } finally {
    client.release();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[TrendingHashtags] Starting...');

  const trendingRows: TrendingRow[] = [];

  // Optional: Playwright explore scrape
  if (process.env.TIKTOK_TRENDING_SCRAPE === '1') {
    console.log('  [TrendingHashtags] Running Playwright explore scrape (TIKTOK_TRENDING_SCRAPE=1)');
    const exploreResults = await scrapeExploreHashtags();
    console.log(`  [TrendingHashtags] Explore scrape returned ${exploreResults.length} hashtags`);
    trendingRows.push(...exploreResults);
  } else {
    console.log('  [TrendingHashtags] Explore scrape skipped (set TIKTOK_TRENDING_SCRAPE=1 to enable)');
  }

  // Always: brand hashtag aggregation from DB
  console.log('  [TrendingHashtags] Aggregating brand hashtags from DB...');
  const brandRows = await aggregateBrandHashtags();
  console.log(`  [TrendingHashtags] Found ${brandRows.length} brand hashtag rows`);
  trendingRows.push(...brandRows);

  // Upsert all
  await upsertTrendingHashtags(trendingRows);

  console.log('[TrendingHashtags] Done');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}

export { main as scrapeHashtags };
