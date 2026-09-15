import cron from 'node-cron';
import { isJobEnabled, ScheduleSettings, loadSettings } from '../config/settings-loader';
import { classifyUnanalyzedComments } from '../analysis/sentiment';
import { translateUntranslatedNotes } from '../analysis/translate';
import { classifyMissingPostThemes } from '../analysis/post-theme';
import { checkNegativeSentimentSpikes, detectTwitterSpikes } from '../analysis/spike-detection';
import { runSocialCleanup } from '../db/social-client';
import { sendMorningDigest } from '../analysis/morning-digest';
import { sendWeeklyDigest } from '../analysis/weekly-digest';
import { createNotification } from '../notifications/store';

// ── Overlap guard ─────────────────────────────────────────────────────────────
// Single-process lock: prevents a slow job from running twice when the next
// cron tick fires before the previous one finishes.
const runningJobs = new Set<string>();

async function withLock(jobName: string, fn: () => Promise<void>): Promise<void> {
  if (runningJobs.has(jobName)) {
    console.log(`[Cron] ${jobName} already running — skipping this tick`);
    return;
  }
  runningJobs.add(jobName);
  try {
    await fn();
  } finally {
    runningJobs.delete(jobName);
  }
}

/**
 * Gate any cron callback on the settings-controlled enable flag. Disabled jobs
 * still register a cron schedule (so toggling on takes effect immediately
 * without restart) but skip the work each tick.
 */
async function ifEnabled(job: keyof ScheduleSettings, fn: () => Promise<void>): Promise<void> {
  try {
    if (!(await isJobEnabled(job))) {
      console.log(`[Cron] ${job} disabled via settings — skipping this tick`);
      return;
    }
  } catch (err) {
    console.error(`[Cron] settings check failed for ${job} — running anyway:`, err);
  }
  await fn();
}

async function runTranslate(): Promise<void> {
  // Comment translation now happens inline inside classifyUnanalyzedComments
  // (same Gemini call does sentiment + non-TH/EN → Thai translation). Only
  // XHS note captions (not comments, so never seen by the classifier) still
  // need their own pass.
  console.log('[Scheduler] Translating XHS note captions...');
  await translateUntranslatedNotes(200).catch((e) => console.error('[Translate/notes]', e));
}

async function runSentiment(): Promise<void> {
  await runTranslate();
  console.log('[Scheduler] Running sentiment classification (includes non-TH/EN → Thai translation)...');
  await classifyUnanalyzedComments(100).catch((e) =>
    console.error('[Sentiment]', e)
  );
  // Negative share can only move once new comments are classified — check right after.
  await checkNegativeSentimentSpikes().catch((e) => console.error('[NegativeSpike]', e));
}

async function runThemeClassification(): Promise<void> {
  console.log('[Scheduler] Running post theme classification...');
  await classifyMissingPostThemes(100).catch((e) =>
    console.error('[PostTheme]', e)
  );
}

/**
 * Pull cron expressions from settings (DB) once at startup so operators can edit
 * the schedule via the Settings page. Editing requires a `pm2 restart scheduler`
 * to take effect — disable/enable does NOT (handled live by `ifEnabled`).
 */
async function registerSchedules(): Promise<void> {
  const cfg = (await loadSettings().catch(() => null))?.schedules;
  const cronOf = (job: keyof ScheduleSettings, fallback: string): string =>
    cfg?.[job]?.cron || fallback;

  // ── Role gating (Docker per-platform split) ──────────────────────────────
  // SCHEDULER_ROLE=core         → non-browser jobs only (sentiment, theme,
  //                               digests, cleanup, campaignSync, spikes).
  // SCHEDULER_ROLE=scraper +    → only that one platform's browser jobs.
  //   SCRAPER_PLATFORM=<p>
  // Unset (legacy host/PM2)     → wantCore true AND every platform true, i.e.
  //                               the original all-in-one single process.
  const ROLE = process.env.SCHEDULER_ROLE;                 // 'core' | 'scraper' | undefined
  const PLATFORM = process.env.SCRAPER_PLATFORM;           // 'tiktok'|'instagram'|'twitter'|'xhs'
  const legacyAllInOne = !ROLE;
  const wantCore = ROLE === 'core' || legacyAllInOne;
  const isScraper = (p: string): boolean =>
    legacyAllInOne || (ROLE === 'scraper' && PLATFORM === p);
  const wantTikTok = isScraper('tiktok');
  const wantInstagram = isScraper('instagram');
  const wantTwitter = isScraper('twitter');
  const wantXhs = ROLE === 'scraper' && PLATFORM === 'xhs'; // XHS never ran on the legacy scheduler

// Every 2 hours — sentiment classification
if (wantCore) cron.schedule(cronOf('sentiment', '0 */2 * * *'), () => {
  ifEnabled('sentiment', async () => {
    createNotification({ type: 'schedule', title: 'Sentiment analysis started', body: 'Scheduled sentiment classification is running.', payload: { job: 'sentiment' } }).catch(() => {});
    await withLock('sentiment', runSentiment);
  }).catch((e) => console.error('[Cron] sentiment error:', e));
});

// Hourly — post theme classification (Gemini/DB-only). Previously ran inline
// inside the TikTok search job; pulled out so it lives with the other
// non-browser work in scheduler-core and the scraper-tiktok container needs
// no Gemini creds. withLock keeps it from stacking on a slow prior run.
if (wantCore) cron.schedule('30 * * * *', () => {
  withLock('theme', runThemeClassification).catch((e) => console.error('[Cron] theme error:', e));
});

// Every Monday 08:00 Bangkok — LINE weekly digest
if (wantCore) cron.schedule(cronOf('weeklyDigest', '0 8 * * 1'), () => {
  ifEnabled('weeklyDigest', sendWeeklyDigest).catch((e) => console.error('[Cron] digest error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Daily 03:00 Bangkok — purge social data older than 6 months
if (wantCore) cron.schedule(cronOf('cleanup', '0 3 * * *'), () => {
  ifEnabled('cleanup', async () => {
    createNotification({ type: 'schedule', title: 'Social DB cleanup started', body: 'Scheduled daily cleanup is running.', payload: { job: 'cleanup' } }).catch(() => {});
    try {
      const deleted = await runSocialCleanup();
      console.log(`[Cron] Social DB cleanup: ${deleted} old rows deleted`);
    } catch (e) {
      console.error('[Cron] social cleanup error:', e);
    }
  }).catch((e) => console.error('[Cron] cleanup error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 6 hours — TikTok feed (own brand posts from @mizumi_official etc.).
// Hours 1/7/13/19 :15 — deliberately NOT on 0/6/12/18 so it never lands on the same hour
// as TikTok search (0/4/8/12/16/20). Feed + search share one Chrome profile, so they also
// share the 'tiktok' lock: if one overruns into the other's slot, the later one skips this
// tick instead of clashing over the profile.
if (wantTikTok) cron.schedule(cronOf('tiktokFeed', '15 1,7,13,19 * * *'), () => {
  ifEnabled('tiktokFeed', async () => {
    createNotification({ type: 'schedule', title: 'TikTok feed scrape started', body: 'Scheduled 6-hour feed scrape is running.', payload: { job: 'tiktok-feed' } }).catch(() => {});
    await withLock('tiktok', async () => {
      const { scrapeAllTikTok } = await import('../scrapers/tiktok/tiktok-feed');
      await scrapeAllTikTok();

      // Kick off feed comment scraping as soon as feed metadata is done.
      createNotification({ type: 'schedule', title: 'Feed comment scrape started', body: 'Scraping comments for recent feed posts.', payload: { job: 'feed-comments' } }).catch(() => {});
      withLock('feed-comments', async () => {
        const { scrapeAllComments } = await import('../scrapers/tiktok/tiktok-comments');
        await scrapeAllComments();
      }).catch((e) => console.error('[Cron] feed-comments error:', e));
    });
  }).catch((e) => console.error('[Cron] tiktok-feed error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 4 hours — TikTok search mentions. No date-sort on TikTok web search, so we
// re-scan keywords every run; DB post_id dedupe skips already-saved posts.
// 4h spacing to reduce chance of TikTok rate/anti-bot blocks.
if (wantTikTok) cron.schedule(cronOf('tiktokSearch', '0 */4 * * *'), () => {
  ifEnabled('tiktokSearch', async () => {
    createNotification({ type: 'schedule', title: 'TikTok search scrape started', body: 'Scheduled 4-hour UGC search is running.', payload: { job: 'tiktok-search' } }).catch(() => {});
    const runStartedAt = Date.now();
    await withLock('tiktok', async () => {                  // shared with feed — same Chrome profile
      const { searchAllBrands } = await import('../scrapers/tiktok/tiktok-search');
      await searchAllBrands();
      // Post theme classification moved to its own core (non-browser) cron so
      // the scraper-tiktok container doesn't need Gemini creds — see below.
      const { sendScrapeSummary } = await import('../analysis/scrape-summary');
      await sendScrapeSummary('TikTok search (4h)', runStartedAt).catch((e) =>
        console.error('[Cron] scrape summary error:', e)
      );
    });
  }).catch((e) => console.error('[Cron] tiktok-search error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Weekly, Monday 05:40 Bangkok — re-fetches views/likes/shares/comments (+cover_url)
// for TikTok posts that are watchlisted or spike-flagged, rather than leaving those
// numbers frozen at whatever the feed/search cron last happened to catch. Shares the
// 'tiktok' lock with feed/search — same Chrome profile.
if (wantTikTok) cron.schedule(cronOf('tiktokStatsRefresh', '40 5 * * 1'), () => {
  ifEnabled('tiktokStatsRefresh', async () => {
    await withLock('tiktok', async () => {
      const { refreshWatchlistAndSpikeStats } = await import('../scrapers/tiktok/tiktok-stats-refresh');
      const { refreshed, failed } = await refreshWatchlistAndSpikeStats();
      if (refreshed > 0 || failed > 0) {
        console.log(`[Cron] TikTok stats refresh: ${refreshed} refreshed, ${failed} failed`);
      }
    });
  }).catch((e) => console.error('[Cron] tiktok-stats-refresh error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 6h — Instagram: feed metadata → feed comments. Feed-only — UGC search was removed
// (unreliable tagged-feed automation, hashtag search too broad/noisy for real UGC).
// All IG scrapers share one persistent Chrome profile, so they MUST run sequentially under
// a single lock. Scheduled at hours 3/9/15/21 :30 — deliberately offset from every TikTok
// job (feed 0/6/12/18:15, search 0/4/8/12/16/20:00) so two heavy Chrome runs don't start
// together and fight over memory.
if (wantInstagram) cron.schedule(cronOf('instagram', '30 3,9,15,21 * * *'), () => {
  ifEnabled('instagram', async () => {
    createNotification({ type: 'schedule', title: 'Instagram scrape started', body: 'Scheduled 6-hour Instagram feed + comments run.', payload: { job: 'instagram' } }).catch(() => {});
    await withLock('instagram', async () => {
      const { scrapeAllInstagram } = await import('../scrapers/instagram/instagram-feed');
      await scrapeAllInstagram();
      const { scrapeAllIgComments } = await import('../scrapers/instagram/instagram-comments');
      await scrapeAllIgComments(30);
    });
  }).catch((e) => console.error('[Cron] instagram error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 2h at :45 — Twitter/X search. Playwright + persistent Chrome profile
// (scrapers/twitter/twitter-browser.ts) — the twscrape-based microservice
// approach was abandoned after Cloudflare blocked it even from clean IPs.
// Offset to :45 (not :00) so it never coincides with tiktokSearch's 0/4/8/
// 12/16/20:00 run — two Playwright/Chrome scrapes racing for CPU/memory at
// once is what caused the trouble this offset avoids.
if (wantTwitter) cron.schedule(cronOf('twitterSearch', '45 */2 * * *'), () => {
  ifEnabled('twitterSearch', async () => {
    createNotification({ type: 'schedule', title: 'Twitter search started', body: 'Scheduled 2-hour X keyword search.', payload: { job: 'twitter-search' } }).catch(() => {});
    await withLock('twitter', async () => {  // shared with comments — same Chrome profile
      const { runTwitterSearchAllBrands } = await import('../scrapers/twitter/twitter-search');
      await runTwitterSearchAllBrands();
    });
  }).catch((e) => console.error('[Cron] twitter-search error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 6 hours at :35 — Twitter/X reply + quote-tweet scrape for campaign
// posts (Track by link / add-by-id, see api/routes/campaigns.ts). Shares the
// same 'twitter' lock as search — both drive the one persistent Chrome
// profile, and taking separate locks per job risks two of them racing to
// open it at once. X campaign tracking is manual-only now (feed-scraping was
// removed — see docs/scope-x-campaigns.md decisions 2/8).
if (wantTwitter) cron.schedule(cronOf('twitterComments', '35 */6 * * *'), () => {
  ifEnabled('twitterComments', async () => {
    createNotification({ type: 'schedule', title: 'Twitter comments scrape started', body: 'Scheduled 6-hour X reply/quote-tweet scrape is running.', payload: { job: 'twitter-comments' } }).catch(() => {});
    await withLock('twitter', async () => {  // shared with search — same Chrome profile
      const { runTwitterCommentsScrape } = await import('../scrapers/twitter/twitter-comments');
      await runTwitterCommentsScrape();
    });
  }).catch((e) => console.error('[Cron] twitter-comments error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every hour on the hour — X campaign status sync only. Cheap, DB-only (no
// Chrome/Playwright involved). Keeps campaigns.status current (draft ->
// active -> ended, +3-day tail). Membership is manual-only (Track by X link
// / add-by-id, api/routes/campaigns.ts) — hashtag/ambassador auto-assignment
// (analysis/campaign-membership.ts:assignCampaignMembership) is deliberately
// NOT called here anymore; auto-claiming by hashtag was misattributing posts
// (a hashtag can appear on unrelated content), so tracking is opt-in per post.
if (wantCore) cron.schedule(cronOf('campaignSync', '0 * * * *'), () => {
  ifEnabled('campaignSync', async () => {
    const { syncCampaignStatuses } = await import('../analysis/campaign-membership');
    try {
      const { activated, ended } = await syncCampaignStatuses();
      if (activated || ended) {
        console.log(`[Cron] campaign sync: ${activated} activated, ${ended} ended`);
      }
    } catch (e) {
      console.error('[Cron] campaign-sync error:', e);
    }
  }).catch((e) => console.error('[Cron] campaign-sync error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 3h — re-fetches each tracked tweet's own views/likes/retweets/replies
// (scrapers/twitter/twitter-stats-refresh.ts), then runs X spike detection
// against the now-current numbers. Closes the gap the campaignSync tick used
// to paper over: nothing previously refreshed a twitter_posts row's own stats
// after "Track by X link"/add-by-id first saved it, so detectTwitterSpikes()
// was evaluating data frozen at track time. Uses Chrome (single-tweet fetch
// per tracked post), so it needs the 'twitter' lock — shared with
// twitter-comments/twitter-search so they never fight over the same profile.
if (wantTwitter) cron.schedule(cronOf('twitterStatsRefresh', '20 */3 * * *'), () => {
  ifEnabled('twitterStatsRefresh', async () => {
    await withLock('twitter', async () => {
      const { refreshTrackedTweetStats } = await import('../scrapers/twitter/twitter-stats-refresh');
      const { refreshed, failed } = await refreshTrackedTweetStats();
      if (refreshed > 0 || failed > 0) {
        console.log(`[Cron] X stats refresh: ${refreshed} refreshed, ${failed} failed`);
      }

      try {
        const spikes = await detectTwitterSpikes();
        if (spikes.length > 0) {
          console.log(`[Cron] X spike detection: ${spikes.length} newly flagged`);
        }
      } catch (e) {
        console.error('[Cron] twitter-spike-detection error:', e);
      }
    });
  }).catch((e) => console.error('[Cron] twitter-stats-refresh error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Every 6h at :10 (hours 2/8/14/20) — XHS feed → search → comments. Only
// registered in the scraper-xhs container; the legacy scheduler never ran XHS
// on a cron (was API/CLI-only). All three share one XHS Chrome profile, so
// they run sequentially under a single 'xhs' lock.
if (wantXhs) cron.schedule(cronOf('xhs', '10 2,8,14,20 * * *'), () => {
  ifEnabled('xhs', async () => {
    createNotification({ type: 'schedule', title: 'XHS scrape started', body: 'Scheduled XHS feed + search + comments run.', payload: { job: 'xhs' } }).catch(() => {});
    await withLock('xhs', async () => {
      const { runXhsFeed } = await import('../scrapers/xhs/xhs-feed');
      await runXhsFeed();
      const { runXhsSearch } = await import('../scrapers/xhs/xhs-search');
      await runXhsSearch();
      const { runXhsComments } = await import('../scrapers/xhs/xhs-comments');
      await runXhsComments();
    });
  }).catch((e) => console.error('[Cron] xhs error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

// Daily 07:00 Bangkok — LINE morning digest
if (wantCore) cron.schedule(cronOf('morningDigest', '0 7 * * *'), () => {
  ifEnabled('morningDigest', async () => {
    createNotification({ type: 'schedule', title: 'LINE morning digest started', body: 'Scheduled morning digest is running.', payload: { job: 'morning-digest' } }).catch(() => {});
    await withLock('morning-digest', sendMorningDigest);
  }).catch((e) => console.error('[Cron] morning digest error:', e));
}, {
  timezone: 'Asia/Bangkok',
});

  console.log('[Scheduler] Started — schedules loaded from app_settings (defaults applied on missing keys).');
}

// Boot: register cron schedules then kick off the startup runs.
// Morning digest deliberately NOT run here — it sends a LINE push, and this
// block fires on every scheduler restart (deploys, crashes, manual
// restarts), not just once a day. It has its own '0 7 * * *' cron entry
// above; let the clock be the only thing that triggers it.
registerSchedules()
  .then(() => {
    // Startup catch-up runs are core (non-browser) work — only fire them in
    // scheduler-core (or the legacy all-in-one process), never in a per-
    // platform scraper container, whose every restart would otherwise kick a
    // full Gemini sentiment+theme pass.
    if (process.env.SCHEDULER_ROLE === 'core' || !process.env.SCHEDULER_ROLE) {
      runSentiment().catch((e) => console.error('[Startup] sentiment error:', e));
      runThemeClassification().catch((e) => console.error('[Startup] theme error:', e));
    }
  })
  .catch((err) => console.error('[Scheduler] failed to register schedules:', err));
