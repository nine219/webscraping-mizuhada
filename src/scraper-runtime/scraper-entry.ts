/**
 * Entrypoint for a `scraper-<platform>` Docker container (Phase 2+).
 *
 * One process per platform that does two things, sharing the same in-process
 * Chrome lock (withLock) and the per-platform Postgres advisory lock:
 *   1. Registers that platform's cron schedule — importing scheduler/cron.ts
 *      runs registerSchedules(), which reads SCHEDULER_ROLE=scraper +
 *      SCRAPER_PLATFORM=<p> and registers ONLY that platform's browser jobs.
 *   2. Runs the queue worker so API-triggered ("Run Search Now") jobs the api
 *      container enqueues into scrape_jobs get claimed and executed here.
 *
 * Launched under xvfb-run by Dockerfile.scraper so headless:false renders to a
 * virtual framebuffer. Not used by the host/PM2 setup (that runs the monolith
 * scheduler with no role env).
 */

import { startQueueWorker, type ScrapePlatform } from './queue-worker';

const PLATFORM = process.env.SCRAPER_PLATFORM as ScrapePlatform | undefined;
const VALID: ScrapePlatform[] = ['tiktok', 'instagram', 'twitter', 'xhs'];

if (!PLATFORM || !VALID.includes(PLATFORM)) {
  console.error(`[scraper-entry] SCRAPER_PLATFORM must be one of ${VALID.join('|')} — got '${PLATFORM ?? ''}'`);
  process.exit(1);
}
if (process.env.SCHEDULER_ROLE !== 'scraper') {
  console.error(`[scraper-entry] SCHEDULER_ROLE must be 'scraper' — got '${process.env.SCHEDULER_ROLE ?? ''}'`);
  process.exit(1);
}

// `api` has no browser after the Docker split, so it can no longer stat a
// platform's Cookies sqlite file itself for GET /session — whichever process
// actually holds the profile (this one) self-reports into the
// platform_sessions table instead. Cheap (just a file stat, no Chrome), so a
// plain interval is fine — no need to route it through the job queue like
// 'login'.
const SESSION_CHECK_MS = 5 * 60_000;

async function checkAndWriteSession(platform: ScrapePlatform): Promise<void> {
  try {
    const { writeSessionStatus } = await import('../config/platform-sessions');
    switch (platform) {
      case 'tiktok': {
        const { getTikTokSessionStatus } = await import('../scrapers/tiktok/tiktok-browser');
        await writeSessionStatus('tiktok', getTikTokSessionStatus());
        break;
      }
      case 'instagram': {
        const { getInstagramSessionStatus } = await import('../scrapers/instagram/instagram-feed');
        await writeSessionStatus('instagram', getInstagramSessionStatus());
        break;
      }
      case 'twitter': {
        const { getTwitterSessionStatus } = await import('../scrapers/twitter/twitter-search');
        await writeSessionStatus('twitter', await getTwitterSessionStatus());
        break;
      }
      case 'xhs': {
        const { getXhsSessionStatus } = await import('../scrapers/xhs/xhs-browser');
        await writeSessionStatus('xhs', getXhsSessionStatus());
        break;
      }
    }
  } catch (err) {
    console.error(`[scraper-entry] session self-check failed for ${platform}:`, err);
  }
}

function startSessionSelfCheck(platform: ScrapePlatform): () => void {
  void checkAndWriteSession(platform); // report immediately on boot, don't wait a full interval
  const timer = setInterval(() => { void checkAndWriteSession(platform); }, SESSION_CHECK_MS);
  return () => clearInterval(timer);
}

// Side-effect import: registers this platform's cron jobs (role/platform gated
// inside cron.ts) and kicks off its schedule loop.
import('../scheduler/cron')
  .then(() => {
    const stopQueue = startQueueWorker(PLATFORM);
    const stopSessionCheck = startSessionSelfCheck(PLATFORM);
    const shutdown = () => { stopQueue(); stopSessionCheck(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log(`[scraper-entry] ${PLATFORM} container up — cron + queue worker + session self-check running`);
  })
  .catch((err) => {
    console.error('[scraper-entry] failed to start:', err);
    process.exit(1);
  });
