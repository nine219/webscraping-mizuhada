/** One-off manual replica of cron.ts's tiktokSearch job — full run incl. comments + LINE digest. */
import { searchAllBrands } from '../src/scrapers/tiktok/tiktok-search';
import { classifyMissingPostThemes } from '../src/analysis/post-theme';
import { sendScrapeSummary } from '../src/analysis/scrape-summary';

async function main() {
  const runStartedAt = Date.now();
  await searchAllBrands();
  await classifyMissingPostThemes(100).catch((e) => console.error('[PostTheme]', e));
  await sendScrapeSummary('TikTok search (4h)', runStartedAt);
}

main()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
