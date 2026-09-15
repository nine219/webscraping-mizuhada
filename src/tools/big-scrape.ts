/**
 * big-scrape — one-off full historical scrape for all brands.
 *
 * Collects up to 6 months of TikTok posts across all brand keywords and category terms.
 * Re-scrapes existing posts to update stats + comments (catches posts that went viral).
 *
 * Usage:
 *   npx ts-node -r dotenv/config --project tsconfig.json src/tools/big-scrape.ts
 *   # or via npm:
 *   npm run big-scrape
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { socialPool as pool } from '../db/social-client';
import { TikTokSearchScraper, ScraperOptions, SEARCH_TARGETS } from '../scrapers/tiktok/tiktok-search';
import { CATEGORY_KEYWORDS } from '../scrapers/keywords';
import { socialQuery as query } from '../db/social-client';

const BIG_SCRAPE_OPTS: ScraperOptions = {
  maxPostAgeDays: 180,   // 6 months
  maxScrolls: 25,        // scroll deep to surface older posts
  rescrapeComments: true, // re-fetch comments for all posts (catches viral spikes)
  // no maxPostsPerKeyword — collect everything
};

async function main() {
  console.log('=== BIG SCRAPE START ===');
  console.log(`Options: ${JSON.stringify(BIG_SCRAPE_OPTS)}`);
  console.log(`Brands: ${SEARCH_TARGETS.map((t) => t.brandSlug).join(', ')}`);
  console.log(`Category keywords: ${CATEGORY_KEYWORDS.length}`);
  console.log('========================\n');

  const brandRows = await query<{ slug: string; id: number; name: string }>(
    `SELECT slug, id, name FROM brands WHERE slug = ANY($1)`,
    [SEARCH_TARGETS.map((t) => t.brandSlug)],
  );
  const brandIdMap  = new Map(brandRows.map((r) => [r.slug, r.id]));
  const brandNameMap = new Map(brandRows.map((r) => [r.id, r.name]));

  let grandTotal = 0;

  // ── Brand-specific searches ──────────────────────────────────────────────────
  for (const target of SEARCH_TARGETS) {
    console.log(`\n====== ${target.brandSlug.toUpperCase()} — ${target.keywords.length} keywords ======`);
    const scraper = new TikTokSearchScraper(
      target.brandSlug,
      target.keywords,
      BIG_SCRAPE_OPTS,
      undefined,
      brandNameMap,
    );
    try {
      const n = await scraper.run();
      grandTotal += n;
      console.log(`[${target.brandSlug}] Subtotal: ${n} posts`);
    } catch (err) {
      console.error(`[${target.brandSlug}] FAILED: ${err}`);
    }
    // 30s cooldown between brands to avoid rate limiting
    if (target !== SEARCH_TARGETS[SEARCH_TARGETS.length - 1]) {
      console.log('Cooling down 30s...');
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  // ── Category / trend keywords ────────────────────────────────────────────────
  if (CATEGORY_KEYWORDS.length > 0) {
    console.log(`\n====== CATEGORY KEYWORDS — ${CATEGORY_KEYWORDS.length} terms ======`);
    const categoryScraper = new TikTokSearchScraper(
      SEARCH_TARGETS[0].brandSlug,
      CATEGORY_KEYWORDS,
      BIG_SCRAPE_OPTS,
      brandIdMap,
      brandNameMap,
    );
    try {
      const n = await categoryScraper.run();
      grandTotal += n;
      console.log(`[category] Subtotal: ${n} posts`);
    } catch (err) {
      console.error(`[category] FAILED: ${err}`);
    }
  }

  console.log(`\n=== BIG SCRAPE DONE — Total upserted: ${grandTotal} posts ===`);
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
