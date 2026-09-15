/**
 * One-off X/Twitter keyword-search backfill — NOT wired into cron.
 *
 * Regular runTwitterSearchAllBrands() (twitter-search.ts, cron every 2h) only
 * looks back TWITTER_SINCE_DAYS (default 7) and caps results per keyword via
 * Settings thresholds. This script reuses the exact same keyword lists
 * (getTwitterSearchTargets — live Settings, same as production) and the same
 * searchTwitterKeyword()/verify/upsert pipeline, but with the since-date and
 * per-keyword caps blown wide open, to pull as much of X's search history as
 * it will still serve for each brand's UGC keywords.
 *
 * Run once, manually:
 *   npx ts-node -r dotenv/config scripts/twitter-search-backfill.ts dotenv_config_path=.env.local
 */
import { getTwitterSearchTargets } from '../src/config/settings-loader';
import { launchAndVerify, LABEL } from '../src/scrapers/twitter/twitter-browser';
import {
  searchTwitterKeyword,
  ScrapeCancelledError,
  RateLimitedError,
  KEYWORD_DELAY_MS,
} from '../src/scrapers/twitter/twitter-search';

// X's search index doesn't go back forever regardless of what we ask for,
// but there's no reason to cap it ourselves — since: just needs to be older
// than anything X could plausibly still serve.
const SINCE_DAYS = 3650;
// No practical cap — scrollRounds/staleness inside searchKeyword is what
// actually ends each keyword's pull.
const MAX_TWEETS_PER_KEYWORD = 5000;
const SCROLL_ROUNDS = 500;

// Same cooldown philosophy as the live cron (twitter-search.ts) — a backfill
// hammering every keyword back-to-back is the fastest way to get 429'd
// mid-run, which would undercut the whole point of "as much as possible".
const BRAND_DELAY_MS = parseInt(process.env.TWITTER_BRAND_DELAY_MS ?? '600000', 10);
const RATE_LIMIT_BACKOFF_MS = parseInt(process.env.TWITTER_RATE_LIMIT_BACKOFF_MS ?? '90000', 10);
const RATE_LIMIT_ABORT_THRESHOLD = parseInt(process.env.TWITTER_RATE_LIMIT_ABORT_THRESHOLD ?? '3', 10);

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const targets = await getTwitterSearchTargets();
  console.log(`${LABEL} [search-backfill] brands: ${targets.map((t) => t.brandSlug).join(', ')}`);

  const ctx = await launchAndVerify();
  let total = 0;
  const rateLimitedKeywords: string[] = [];
  let consecutiveRateLimits = 0;

  try {
    for (const [brandIdx, { brandSlug, keywords }] of targets.entries()) {
      console.log(`${LABEL} [search-backfill] === ${brandSlug}: ${keywords.length} keywords ===`);
      for (const [kwIdx, kw] of keywords.entries()) {
        let hitRateLimit = false;
        try {
          const r = await searchTwitterKeyword(kw, {
            ctx,
            sinceDays: SINCE_DAYS,
            maxTweets: MAX_TWEETS_PER_KEYWORD,
            scrollRounds: SCROLL_ROUNDS,
          });
          total += r.kept;
          hitRateLimit = r.rateLimited;
          console.log(`${LABEL} [search-backfill] "${kw}": hits=${r.totalHits} kept=${r.kept}`);
        } catch (err) {
          if (err instanceof ScrapeCancelledError) throw err;
          console.error(`${LABEL} [search-backfill] "${kw}" failed:`, err instanceof Error ? err.message : err);
        }

        if (hitRateLimit) {
          rateLimitedKeywords.push(kw);
          consecutiveRateLimits++;
          if (consecutiveRateLimits >= RATE_LIMIT_ABORT_THRESHOLD) {
            throw new RateLimitedError(consecutiveRateLimits);
          }
          console.warn(`${LABEL} [search-backfill] rate-limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s before next keyword`);
          await sleep(RATE_LIMIT_BACKOFF_MS);
        } else {
          consecutiveRateLimits = 0;
        }

        if (kwIdx < keywords.length - 1) await sleep(KEYWORD_DELAY_MS);
      }
      if (brandIdx < targets.length - 1) {
        console.log(`${LABEL} [search-backfill] [${brandSlug}] done — waiting ${BRAND_DELAY_MS / 1000}s before next brand...`);
        await sleep(BRAND_DELAY_MS);
      }
    }
  } finally {
    await ctx.close();
  }

  if (rateLimitedKeywords.length > 0) {
    console.warn(`${LABEL} [search-backfill] DONE — total upserted: ${total} — rate-limited on: ${rateLimitedKeywords.join(', ')}`);
  } else {
    console.log(`${LABEL} [search-backfill] DONE — total upserted: ${total}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
