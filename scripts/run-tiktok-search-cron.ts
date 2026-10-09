/** One-off manual replica of cron.ts's tiktokSearch job — full run incl. comments. */
import { searchAllBrands } from '../src/scrapers/tiktok/tiktok-search';
import { classifyMissingPostThemes } from '../src/analysis/post-theme';

async function main() {
  await searchAllBrands();
  await classifyMissingPostThemes(100).catch((e) => console.error('[PostTheme]', e));
}

main()
  .then(() => { console.log('done'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
