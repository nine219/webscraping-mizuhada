// One-off mockup: competitor tracking for a single brand (Her Hyness), TikTok only.
// Feed scrape (own account) + keyword search ("her hyness"), no comment scraping.
// Run: npx ts-node src/tools/mock-her-hyness.ts
import { TikTokFeedScraper } from './../scrapers/tiktok/tiktok-feed';
import { TikTokSearchScraper } from './../scrapers/tiktok/tiktok-search';
import { launchContext } from './../scrapers/tiktok/tiktok-browser';
import { BRAND_KEYWORDS } from './../scrapers/keywords';

const BRAND_SLUG = 'her-hyness';
const HANDLE = 'herhynessbeauty';

// BRAND_KEYWORDS only has the 3 own brands checked in — the search scraper's
// brand-specific mode gates saves on this map, so a competitor mockup needs a
// local entry. Process-only mutation, does not touch keywords.ts on disk.
BRAND_KEYWORDS[BRAND_SLUG] = ['her hyness', 'herhyness', 'her hyness beauty'];

async function main() {
  let feedCount = 0;
  if (!process.argv.includes('--search-only')) {
    console.log(`\n=== Her Hyness feed scrape (@${HANDLE}) ===`);
    const { ctx, cleanup } = await launchContext();
    try {
      const feedScraper = new TikTokFeedScraper(BRAND_SLUG, HANDLE, { maxScrolls: 15 });
      feedCount = await feedScraper.runWithContext(ctx);
    } finally {
      await cleanup();
    }
    console.log(`Feed: ${feedCount} posts saved`);
  } else {
    console.log('--search-only: skipping feed scrape');
  }

  console.log(`\n=== Her Hyness keyword search ("her hyness") ===`);
  const searchScraper = new TikTokSearchScraper(BRAND_SLUG, ['her hyness'], { skipComments: true, maxScrolls: 8 });
  const searchCount = await searchScraper.run();
  console.log(`Search: ${searchCount} posts saved`);

  console.log(`\nDone. Feed=${feedCount} Search=${searchCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
