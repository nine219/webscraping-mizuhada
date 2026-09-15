/**
 * Per-platform scrape-job queue worker (Docker split, Phase 2+).
 *
 * Each `scraper-<platform>` container runs one of these alongside its cron
 * schedule (both in the same process, so they share the in-process Chrome
 * lock — see scheduler/cron.ts withLock and the per-platform advisory lock in
 * the browser modules). It claims `pending` rows from social-db `scrape_jobs`
 * for its own platform and executes them, writing status/count/message back so
 * the dashboard (polling via api /api/scrape/status/:id) sees live progress.
 *
 * This replaces the old in-process Map in api/routes/scrape.ts for jobs that
 * the `api` container ENQUEUES (via enqueueScrapeJob) instead of running
 * itself. During Phases 0-1, scrapers still run on the host and api still runs
 * Chrome in-process, so nothing starts this worker yet; it is the seam the
 * per-platform migration fills in.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED` so multiple workers (or a future
 * scaled replica) never double-run a job.
 */

import { socialQuery, socialQueryOne, withSocialTransaction } from '../db/social-client';

export type ScrapePlatform = 'tiktok' | 'instagram' | 'twitter' | 'xhs';

export interface ScrapeJobRow {
  id: string;
  platform: string;
  job_type: string;
  brand: string;
  status: string;
  message: string;
  count: number;
  cancel_requested: boolean;
  params: Record<string, unknown>;
}

/** Live handle a runner uses to report progress + observe cooperative cancel. */
export interface JobHandle {
  readonly id: string;
  count: number;
  message: string;
  /**
   * Synchronous cancel check — scraper loops call this between steps and it
   * must not block, so it reads a flag refreshed in the background by a poller
   * (see makeHandle), mirroring the old in-memory job.cancelRequested that
   * scrapers already poll. Matches the scrapers' `ShouldCancel = () => boolean`.
   */
  cancelled(): boolean;
  /** Force one immediate refresh of the cancel flag from the row. */
  refreshCancel(): Promise<boolean>;
  /** Flush count/message to the row (call between steps). */
  flush(): Promise<void>;
  /** Stop the background cancel poller (call once the job settles). */
  dispose(): void;
  /** Payload for job_types the caller needs data back from (track-link, search-x) — set before the dispatch returns, written on the terminal UPDATE in finish(). */
  result?: unknown;
}

// Bounds two latencies: how long a claimed-but-idle worker waits before
// re-polling for a new pending row, and how often the in-flight cancel flag
// refreshes. 1s keeps quick manual actions (e.g. campaign track-link) feeling
// close to the old synchronous-request UX; trivial extra load on scrape_jobs
// at this volume.
const POLL_MS = 1000;

/** Atomically claim the oldest pending job for `platform`, or null if none. */
async function claimNext(platform: ScrapePlatform): Promise<ScrapeJobRow | null> {
  return withSocialTransaction(async (client) => {
    const { rows } = await client.query<ScrapeJobRow>(
      `SELECT * FROM scrape_jobs
        WHERE platform = $1 AND status = 'pending'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [platform],
    );
    const row = rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE scrape_jobs SET status = 'running', started_at = NOW() WHERE id = $1`,
      [row.id],
    );
    return row;
  });
}

function makeHandle(row: ScrapeJobRow): JobHandle {
  let cancelFlag = row.cancel_requested;
  const refresh = async (): Promise<boolean> => {
    const r = await socialQueryOne<{ cancel_requested: boolean }>(
      `SELECT cancel_requested FROM scrape_jobs WHERE id = $1`,
      [row.id],
    );
    cancelFlag = r?.cancel_requested ?? false;
    return cancelFlag;
  };
  const timer = setInterval(() => { void refresh().catch(() => {}); }, POLL_MS);

  return {
    id: row.id,
    count: row.count,
    message: row.message,
    result: undefined,
    cancelled: () => cancelFlag,
    refreshCancel: refresh,
    async flush() {
      await socialQuery(
        `UPDATE scrape_jobs SET count = $2, message = $3 WHERE id = $1`,
        [row.id, this.count, this.message],
      );
    },
    dispose: () => clearInterval(timer),
  };
}

async function finish(id: string, status: 'done' | 'error' | 'cancelled', message: string, count: number, result?: unknown): Promise<void> {
  await socialQuery(
    `UPDATE scrape_jobs SET status = $2, message = $3, count = $4, result = $5, finished_at = NOW() WHERE id = $1`,
    [id, status, message, count, result != null ? JSON.stringify(result) : null],
  );
}

/** Own-brand row shape shared by the tiktok/instagram dispatch branches below. */
interface BrandRow { id: number; slug: string; name: string; type?: string }

async function dispatchTikTok(row: ScrapeJobRow, handle: JobHandle): Promise<void> {
  const p = row.params;
  switch (row.job_type) {
    // params: { keyword?, brand?, forceBrand?: { id, slug, name, type } }
    // forceBrand is set by admin.ts's multi-search fan-out — attribute every
    // result to exactly that brand instead of auto-resolving across all own
    // brands (mirrors the old admin.ts multi-search closure).
    case 'search': {
      const { searchAllBrands, TikTokSearchScraper, ScrapeCancelledError, TikTokSoftBlockError } = await import('../scrapers/tiktok/tiktok-search');
      const { getTikTokSearchTargets } = await import('../config/settings-loader');
      const { createNotification } = await import('../notifications/store');
      const keyword = typeof p.keyword === 'string' ? p.keyword : undefined;
      const brand = typeof p.brand === 'string' ? p.brand : undefined;
      const forceBrand = p.forceBrand as { id: number; slug: string; name: string; type: 'own' | 'competitor' } | undefined;
      const shouldCancel = () => handle.cancelled();
      try {
        if (keyword && forceBrand) {
          const brandIdMap = new Map([[forceBrand.slug, forceBrand.id]]);
          const brandNameMap = new Map([[forceBrand.id, forceBrand.name]]);
          let brandCandidates: import('../scrapers/keywords').BrandMatchCandidate[];
          if (forceBrand.type === 'own') {
            const targets = await getTikTokSearchTargets();
            const target = targets.find((t) => t.brandSlug === forceBrand.slug);
            brandCandidates = [{ slug: forceBrand.slug, type: 'own', name: forceBrand.name, keywords: target?.keywords ?? [] }];
          } else {
            brandCandidates = [{ slug: forceBrand.slug, type: 'competitor', name: forceBrand.name }];
          }
          const scraper = new TikTokSearchScraper('adhoc', [keyword], { skipComments: true, shouldCancel }, brandIdMap, brandNameMap, brandCandidates);
          handle.count = await scraper.run();
        } else if (keyword) {
          const brandRows = await socialQuery<BrandRow>(`SELECT slug, id, name FROM brands WHERE type = 'own'`);
          const brandIdMap = new Map(brandRows.map((r) => [r.slug, r.id]));
          const brandNameMap = new Map(brandRows.map((r) => [r.id, r.name]));
          const targets = await getTikTokSearchTargets();
          const brandCandidates = brandRows.map((r) => ({
            slug: r.slug, type: 'own' as const, name: r.name,
            keywords: targets.find((t) => t.brandSlug === r.slug)?.keywords ?? [],
          }));
          const scraper = new TikTokSearchScraper('adhoc', [keyword], { skipComments: true, shouldCancel }, brandIdMap, brandNameMap, brandCandidates);
          handle.count = await scraper.run();
        } else if (brand) {
          const targets = await getTikTokSearchTargets();
          const target = targets.find((t) => t.brandSlug === brand);
          if (target) {
            handle.message = `Searching "${target.keywords[0]}"...`;
            const scraper = new TikTokSearchScraper(target.brandSlug, target.keywords, { skipComments: true, shouldCancel });
            handle.count = await scraper.run();
          } else {
            handle.message = `No keyword list configured for brand "${brand}" — running all brands`;
            await searchAllBrands(shouldCancel, true);
          }
        } else {
          await searchAllBrands(shouldCancel, true);
        }
        handle.message = 'Search scrape complete';
      } catch (err) {
        if (err instanceof ScrapeCancelledError) {
          handle.message = 'Search stopped by user';
        } else if (err instanceof TikTokSoftBlockError) {
          handle.message = 'Aborted — TikTok looks soft-blocked (empty results repeatedly). Wait before retrying.';
          createNotification({
            type: 'scrape_job', title: 'TikTok search aborted — possible soft-block', body: err.message,
            payload: { jobId: row.id, platform: 'tiktok-search' },
          }).catch(() => {});
          throw err; // preserves the old 'error' terminal status (not 'done')
        } else {
          throw err;
        }
      }
      break;
    }
    // params: { postId }
    case 'comments': {
      const { scrapeCommentsForPost } = await import('../scrapers/tiktok/tiktok-comments');
      await scrapeCommentsForPost(String(p.postId));
      handle.message = 'Comments scraped';
      break;
    }
    // params: { brand? }
    case 'feed': {
      const { TikTokFeedScraper, TIKTOK_ACCOUNTS } = await import('../scrapers/tiktok/tiktok-feed');
      const { getThresholds } = await import('../config/settings-loader');
      const { scrapeCommentsForBrand } = await import('../scrapers/tiktok/tiktok-comments');
      const brand = typeof p.brand === 'string' ? p.brand : undefined;
      const thresholds = await getThresholds().catch(() => null);
      const accounts = brand ? TIKTOK_ACCOUNTS.filter((a) => a.brandSlug === brand) : TIKTOK_ACCOUNTS;

      let total = 0;
      for (const account of accounts) {
        handle.message = `[Feed] @${account.handle}...`;
        try {
          const scraper = new TikTokFeedScraper(account.brandSlug, account.handle, { maxAgeDays: thresholds?.feedMaxAgeDays });
          total += await scraper.run();
        } catch (err: unknown) {
          console.error(`[queue-worker:tiktok:feed] ${account.brandSlug}`, err);
        }
        if (account !== accounts[accounts.length - 1]) await new Promise((r) => setTimeout(r, 5_000));
      }

      handle.message = 'Scraping comments (30 days)...';
      for (const account of accounts) {
        handle.message = `[Comments] @${account.handle}...`;
        await scrapeCommentsForBrand(account.brandSlug, 30)
          .catch((err: unknown) => console.error(`[queue-worker:tiktok:comments] ${account.brandSlug}`, err));
        if (account !== accounts[accounts.length - 1]) await new Promise((r) => setTimeout(r, 15_000));
      }

      handle.count = total;
      handle.message = 'Scrape complete';
      break;
    }
    // params: { brandSlug, handle, lookbackDays?, scrapeComments? }
    case 'adhoc-feed': {
      const { TikTokFeedScraper } = await import('../scrapers/tiktok/tiktok-feed');
      const { getThresholds } = await import('../config/settings-loader');
      const brandSlug = String(p.brandSlug);
      const accountHandle = String(p.handle);
      const lookbackDays = typeof p.lookbackDays === 'number' ? p.lookbackDays : undefined;
      const scrapeComments = p.scrapeComments !== false;
      const thresholds = await getThresholds().catch(() => null);
      const maxAgeDays = lookbackDays ?? thresholds?.feedMaxAgeDays;

      handle.message = `[Feed] @${accountHandle}...`;
      const scraper = new TikTokFeedScraper(brandSlug, accountHandle, { maxAgeDays });
      handle.count = await scraper.run();

      if (scrapeComments) {
        handle.message = `[Comments] @${accountHandle}...`;
        const { scrapeCommentsForBrand } = await import('../scrapers/tiktok/tiktok-comments');
        await scrapeCommentsForBrand(brandSlug, 30).catch((err: unknown) => console.error(`[queue-worker:tiktok:adhoc-comments] ${brandSlug}`, err));
      }
      handle.message = 'Ad-hoc scrape complete';
      break;
    }
    // No params. Moved here from api/routes/tiktok.ts's POST /login — api has
    // no browser after the split. Writes platform_sessions so GET /session
    // sees the outcome without waiting for the next periodic self-check.
    case 'login': {
      const { launchContext, getTikTokSessionStatus } = await import('../scrapers/tiktok/tiktok-browser');
      const { writeSessionStatus } = await import('../config/platform-sessions');
      const force = p.force === true;
      const launched = await launchContext();
      try {
        if (force) {
          // Re-login click: drop the existing session so TikTok actually
          // renders its login form instead of the already-authenticated
          // home feed the persistent profile would otherwise restore.
          await launched.ctx.clearCookies();
          handle.message = 'Forcing fresh login — cleared existing session...';
        }
        const page = await launched.ctx.newPage();
        await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        const existing = await launched.ctx.cookies('https://www.tiktok.com');
        if (!force && existing.some((c) => c.name === 'sessionid' && c.value)) {
          handle.message = 'Already logged in — no action needed.';
        } else {
          handle.message = 'Waiting for manual login (up to 15 min)…';
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline && !handle.cancelled()) {
            await page.waitForTimeout(3_000);
            const cookies = await launched.ctx.cookies('https://www.tiktok.com').catch(() => []);
            if (cookies.some((c) => c.name === 'sessionid' && c.value)) { handle.message = 'Login captured.'; break; }
            if (page.isClosed()) { handle.message = 'Page closed before login completed.'; break; }
          }
        }
      } finally {
        await launched.cleanup().catch(() => {});
      }
      await writeSessionStatus('tiktok', getTikTokSessionStatus());
      break;
    }
    default: {
      const { searchAllBrands } = await import('../scrapers/tiktok/tiktok-search');
      await searchAllBrands();
    }
  }
}

async function dispatchInstagram(row: ScrapeJobRow, handle: JobHandle): Promise<void> {
  const p = row.params;
  switch (row.job_type) {
    // params: { postId }
    case 'comments': {
      const { scrapeIgCommentsForPost } = await import('../scrapers/instagram/instagram-comments');
      handle.count = await scrapeIgCommentsForPost(String(p.postId));
      handle.message = `Scraped ${handle.count} comments`;
      break;
    }
    // params: { brand? }
    case 'feed': {
      const { scrapeAllInstagram, InstagramFeedScraper, INSTAGRAM_ACCOUNTS } = await import('../scrapers/instagram/instagram-feed');
      const brand = typeof p.brand === 'string' ? p.brand : undefined;
      if (brand) {
        const acc = INSTAGRAM_ACCOUNTS.find((a) => a.brandSlug === brand);
        if (acc) {
          handle.message = `Scraping @${acc.handle}...`;
          const { getThresholds } = await import('../config/settings-loader');
          const thresholds = await getThresholds().catch(() => null);
          const scraper = new InstagramFeedScraper(acc.brandSlug, acc.handle, { maxAgeDays: thresholds?.feedMaxAgeDays });
          handle.count = await scraper.run();
        } else {
          handle.message = `No IG account for "${brand}" — scraping all`;
          await scrapeAllInstagram();
        }
      } else {
        await scrapeAllInstagram();
      }
      handle.message = 'Instagram scrape complete';
      break;
    }
    // params: { brandSlug, handle, lookbackDays?, scrapeComments? }
    case 'adhoc-feed': {
      const { InstagramFeedScraper } = await import('../scrapers/instagram/instagram-feed');
      const { getThresholds } = await import('../config/settings-loader');
      const brandSlug = String(p.brandSlug);
      const accountHandle = String(p.handle);
      const lookbackDays = typeof p.lookbackDays === 'number' ? p.lookbackDays : undefined;
      const scrapeComments = p.scrapeComments !== false;
      const thresholds = await getThresholds().catch(() => null);
      const maxAgeDays = lookbackDays ?? thresholds?.feedMaxAgeDays;

      handle.message = `[Feed] @${accountHandle}...`;
      const scraper = new InstagramFeedScraper(brandSlug, accountHandle, { maxAgeDays });
      handle.count = await scraper.run();

      if (scrapeComments) {
        handle.message = `[Comments] @${accountHandle}...`;
        const { scrapeIgCommentsForBrand } = await import('../scrapers/instagram/instagram-comments');
        await scrapeIgCommentsForBrand(brandSlug, 30).catch((err: unknown) => console.error(`[queue-worker:instagram:adhoc-comments] ${brandSlug}`, err));
      }
      handle.message = 'Ad-hoc scrape complete';
      break;
    }
    // No params. Moved here from api/routes/instagram.ts's POST /login.
    case 'login': {
      const { launchContext, getInstagramSessionStatus } = await import('../scrapers/instagram/instagram-feed');
      const { writeSessionStatus } = await import('../config/platform-sessions');
      const launched = await launchContext();
      try {
        const page = await launched.ctx.newPage();
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        const existing = await launched.ctx.cookies('https://www.instagram.com');
        if (existing.some((c) => c.name === 'sessionid' && c.value)) {
          handle.message = 'Already logged in — no action needed.';
        } else {
          handle.message = 'Waiting for manual login (up to 15 min)…';
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline && !handle.cancelled()) {
            await page.waitForTimeout(3_000);
            const cookies = await launched.ctx.cookies('https://www.instagram.com').catch(() => []);
            if (cookies.some((c) => c.name === 'sessionid' && c.value)) { handle.message = 'Login captured.'; break; }
            if (page.isClosed()) { handle.message = 'Page closed before login completed.'; break; }
          }
        }
      } finally {
        await launched.cleanup().catch(() => {});
      }
      await writeSessionStatus('instagram', getInstagramSessionStatus());
      break;
    }
    default: {
      const { scrapeAllInstagram } = await import('../scrapers/instagram/instagram-feed');
      await scrapeAllInstagram();
    }
  }
}

async function dispatchTwitter(row: ScrapeJobRow, handle: JobHandle): Promise<void> {
  const p = row.params;
  switch (row.job_type) {
    // params: { keyword? }
    case 'search': {
      const { searchTwitterKeyword, runTwitterSearchAllBrands, ScrapeCancelledError, RateLimitedError } =
        await import('../scrapers/twitter/twitter-search');
      const { createNotification } = await import('../notifications/store');
      const keyword = typeof p.keyword === 'string' ? p.keyword : undefined;
      const shouldCancel = () => handle.cancelled();
      let rateLimitedKeywords: string[] = [];
      try {
        if (keyword) {
          const r = await searchTwitterKeyword(keyword, { shouldCancel });
          handle.count = r.kept;
          if (r.rateLimited) rateLimitedKeywords = [keyword];
        } else {
          const r = await runTwitterSearchAllBrands(shouldCancel);
          handle.count = r.total;
          rateLimitedKeywords = r.rateLimitedKeywords;
        }
        if (rateLimitedKeywords.length > 0) {
          handle.message = `Complete, but X rate-limited (429) on ${rateLimitedKeywords.length} keyword(s): ${rateLimitedKeywords.slice(0, 5).join(', ')}${rateLimitedKeywords.length > 5 ? '…' : ''}. Results are partial for those.`;
          createNotification({
            type: 'scrape_job', title: 'X search rate-limited',
            body: `X returned 429 (Too Many Requests) on ${rateLimitedKeywords.length} keyword(s) — session is being throttled. Consider slowing down search frequency or waiting before the next run.`,
            payload: { jobId: row.id, platform: 'twitter-search', rateLimitedKeywords },
          }).catch(() => {});
        } else {
          handle.message = 'Twitter search complete';
        }
      } catch (err) {
        if (err instanceof ScrapeCancelledError) {
          handle.message = 'Search stopped by user';
        } else if (err instanceof RateLimitedError) {
          handle.message = 'Aborted — X rate-limited (429) repeatedly. Wait before retrying.';
          createNotification({
            type: 'scrape_job', title: 'X search aborted — rate-limited', body: err.message,
            payload: { jobId: row.id, platform: 'twitter-search' },
          }).catch(() => {});
          throw err; // preserves the old 'error' terminal status (not 'done')
        } else {
          throw err;
        }
      }
      break;
    }
    // params: { campaignId, handle: authorHandle, postId } — live-fetches the
    // tweet to confirm it's real (was campaigns.ts's synchronous
    // fetchSingleTweet call before the Docker split), locks it to the
    // campaign, then chains straight into the replies/quotes scrape below —
    // same one job, no second enqueue. handle.result carries the verified
    // post back so the dashboard can render it once done.
    case 'track-link': {
      const { fetchSingleTweet, upsertFeedTweet } = await import('../scrapers/twitter/twitter-feed');
      const { runTwitterCommentsScrape } = await import('../scrapers/twitter/twitter-comments');
      const campaignId = Number(p.campaignId);
      const authorHandle = String(p.handle);
      const postId = String(p.postId);

      const campaign = await socialQueryOne<{ id: number; brand_id: number; ambassador_handles: string[] }>(
        `SELECT id, brand_id, ambassador_handles FROM campaigns WHERE id = $1`, [campaignId],
      );
      if (!campaign) throw new Error('Campaign not found');

      const tweet = await fetchSingleTweet(authorHandle, postId);
      if (!tweet) throw new Error('Tweet not found, deleted, or inaccessible — double-check the link');

      const brandRow = await socialQueryOne<{ twitter_handle: string | null }>(
        `SELECT twitter_handle FROM brands WHERE id = $1`, [campaign.brand_id],
      );
      const ownHandle = (brandRow?.twitter_handle ?? '').toLowerCase().replace(/^@/, '');
      const authorLower = tweet.author.toLowerCase();
      const isOwnAccount = authorLower === ownHandle;
      // Only a handle actually listed on this campaign's ambassador_handles
      // counts as an ambassador — mirrors campaigns.ts's original check.
      const isAmbassador = !isOwnAccount && (campaign.ambassador_handles ?? [])
        .some((h) => h.toLowerCase().replace(/^@/, '') === authorLower);
      const sourceType: 'feed' | 'search' = (isOwnAccount || isAmbassador) ? 'feed' : 'search';
      await upsertFeedTweet(tweet, campaign.brand_id, isAmbassador, sourceType);
      await socialQuery(
        `UPDATE twitter_posts SET campaign_id = $1, campaign_locked = true WHERE brand_id = $2 AND post_id = $3`,
        [campaignId, campaign.brand_id, tweet.id],
      );

      handle.result = { post_id: tweet.id, author_handle: tweet.author, caption: tweet.caption };
      handle.message = 'Verified — scraping replies/quotes…';

      const commentResult = await runTwitterCommentsScrape(() => handle.cancelled(), { campaignId });
      handle.count = commentResult.total;
      handle.message = `Done — ${commentResult.total} saved`;
      break;
    }
    // params: { campaignId } — live X search, was campaigns.ts's synchronous
    // launchAndVerify()+searchKeyword() loop before the split. Candidates are
    // NOT persisted (review-only, same as before) — handle.result carries
    // them back for the dashboard to render.
    case 'search-x': {
      const campaignId = Number(p.campaignId);
      const campaign = await socialQueryOne<{ id: number; hashtags: string[] }>(
        `SELECT id, hashtags FROM campaigns WHERE id = $1`, [campaignId],
      );
      if (!campaign) throw new Error('Campaign not found');
      if (!campaign.hashtags || campaign.hashtags.length === 0) throw new Error('Campaign has no hashtags to search');

      const hashtagsToSearch = campaign.hashtags
        .map((h) => h.replace(/^#/, '').trim())
        .filter((h) => h.length > 0 && h.toLowerCase() !== 'mizumi')
        .slice(0, 5);

      const { launchAndVerify } = await import('../scrapers/twitter/twitter-browser');
      const { searchKeyword, KEYWORD_DELAY_MS } = await import('../scrapers/twitter/twitter-search');

      const ctx = await launchAndVerify();
      const collected = new Map<string, {
        id: string; url: string; author: string; authorName: string | null;
        content: string; likes: number; retweets: number; views: number | null; createdAt: string | null;
        isRetweet: boolean;
      }>();
      try {
        for (const [idx, hashtag] of hashtagsToSearch.entries()) {
          if (handle.cancelled()) break;
          const { tweets } = await searchKeyword(ctx, `#mizumi #${hashtag}`, 30, 'th');
          for (const t of tweets) {
            collected.set(t.id, {
              id: t.id, url: t.url, author: t.author, authorName: t.authorName,
              content: t.content, likes: t.likes, retweets: t.retweets, views: t.views, createdAt: t.createdAt,
              isRetweet: t.isRetweet,
            });
          }
          if (idx < hashtagsToSearch.length - 1) await new Promise((r) => setTimeout(r, KEYWORD_DELAY_MS));
        }
      } finally {
        await ctx.close();
      }

      const alreadyTracked = await socialQuery<{ post_id: string }>(
        `SELECT post_id FROM twitter_posts WHERE campaign_id = $1 AND post_id = ANY($2::text[])`,
        [campaignId, [...collected.keys()]],
      );
      const trackedIds = new Set(alreadyTracked.map((r) => r.post_id));
      const candidates = [...collected.values()].filter((c) => !trackedIds.has(c.id));

      handle.result = { candidates };
      handle.count = candidates.length;
      handle.message = `Found ${candidates.length} candidate(s)`;
      break;
    }
    // No params. Moved here from api/routes/twitter.ts's POST /login. Uses
    // the raw, unlocked launchContext() (launchAndVerify() throws on an
    // invalid session — exactly the case this flow exists to handle) wrapped
    // manually in the same cross-process advisory lock every other Twitter
    // browser launch goes through.
    case 'login': {
      const { launchContext, isSessionValid, acquireCrossProcessLock, releaseCrossProcessLock } =
        await import('../scrapers/twitter/twitter-browser');
      const { getTwitterSessionStatus } = await import('../scrapers/twitter/twitter-search');
      const { writeSessionStatus } = await import('../config/platform-sessions');
      const dbLock = await acquireCrossProcessLock();
      try {
        const ctx = await launchContext();
        try {
          const page = await ctx.newPage();
          if (await isSessionValid(page)) {
            handle.message = 'Already logged in — no action needed.';
          } else {
            await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
            handle.message = 'Waiting for manual login (up to 5 min)…';
            const deadline = Date.now() + 5 * 60_000;
            while (Date.now() < deadline && !handle.cancelled()) {
              await page.waitForTimeout(3_000);
              const cookies = await ctx.cookies(['https://x.com', 'https://twitter.com']).catch(() => []);
              if (cookies.some((c) => c.name === 'auth_token' && !!c.value)) { handle.message = 'Login captured.'; break; }
              if (page.isClosed()) { handle.message = 'Page closed before login completed.'; break; }
            }
          }
        } finally {
          await ctx.close().catch(() => {});
        }
      } finally {
        await releaseCrossProcessLock(dbLock);
      }
      await writeSessionStatus('twitter', await getTwitterSessionStatus());
      break;
    }
    // params: { campaignId } — replies/quotes for every post claimed by this campaign.
    case 'campaign-comments': {
      const { runTwitterCommentsScrape } = await import('../scrapers/twitter/twitter-comments');
      const campaignId = Number(p.campaignId);
      const result = await runTwitterCommentsScrape(() => handle.cancelled(), { campaignId });
      handle.count = result.total;
      handle.message = result.rateLimitedPosts.length > 0
        ? `Done — ${result.total} saved, rate-limited on ${result.rateLimitedPosts.length} post(s)`
        : `Done — ${result.total} saved`;
      break;
    }
    default: {
      const { runTwitterSearchAllBrands } = await import('../scrapers/twitter/twitter-search');
      await runTwitterSearchAllBrands();
    }
  }
}

/**
 * Dispatch a claimed job to the right scraper. The per-platform route closures
 * that used to live directly in api/routes/{admin,tiktok,tiktok-jobs,instagram,
 * twitter,campaigns,xhs}.ts have moved here — those routes now only
 * enqueueScrapeJob() with a job_type + params, since `api` has no browser
 * after the Docker split.
 */
async function dispatch(row: ScrapeJobRow, handle: JobHandle): Promise<void> {
  switch (row.platform as ScrapePlatform) {
    case 'xhs': {
      const p = row.params;
      switch (row.job_type) {
        case 'feed': {
          const { runXhsFeed } = await import('../scrapers/xhs/xhs-feed');
          await runXhsFeed();
          break;
        }
        case 'adhoc-feed': {
          const { runXhsAdhocFeed } = await import('../scrapers/xhs/xhs-feed');
          handle.count = await runXhsAdhocFeed(
            Number(p.brandId), String(p.brandSlug), String(p.input), undefined,
            typeof p.scrapeComments === 'boolean' ? p.scrapeComments : undefined,
          );
          break;
        }
        // No params. Moved here from api/routes/xhs.ts's POST /login — same
        // reasoning as the other three, even though XHS runs on the host,
        // not a container: api still has no browser to run this itself.
        case 'login': {
          const { launchPersistentContext, detectWall, getXhsSessionStatus } = await import('../scrapers/xhs/xhs-browser');
          const { writeSessionStatus } = await import('../config/platform-sessions');
          const ctx = await launchPersistentContext();
          try {
            const page = await ctx.newPage();
            await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
            await page.waitForTimeout(3_000);
            const readWall = async () => detectWall(await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''));
            if ((await readWall()) === 'ok') {
              handle.message = 'Already logged in — no action needed.';
            } else {
              handle.message = 'Waiting for manual login (QR / password, up to 15 min)…';
              const deadline = Date.now() + 15 * 60_000;
              while (Date.now() < deadline && !handle.cancelled()) {
                await page.waitForTimeout(3_000);
                if ((await readWall()) === 'ok') { handle.message = 'Login wall cleared.'; break; }
                if (page.isClosed()) { handle.message = 'Page closed before login completed.'; break; }
              }
            }
          } finally {
            await ctx.close().catch(() => {});
          }
          await writeSessionStatus('xhs', getXhsSessionStatus());
          break;
        }
        case 'search':
        default: {
          const { runXhsSearch } = await import('../scrapers/xhs/xhs-search');
          const keyword = typeof p.keyword === 'string' ? p.keyword : undefined;
          const sinceMs = typeof p.sinceMs === 'number' ? p.sinceMs : undefined;
          await runXhsSearch(keyword, sinceMs, () => handle.cancelled());
          break;
        }
      }
      break;
    }
    case 'tiktok':
      await dispatchTikTok(row, handle);
      break;
    case 'instagram':
      await dispatchInstagram(row, handle);
      break;
    case 'twitter':
      await dispatchTwitter(row, handle);
      break;
    default:
      throw new Error(`queue-worker: unknown platform '${row.platform}'`);
  }
}

/**
 * Start the poll loop for one platform. Returns a stop() function. The scraper
 * container's entrypoint calls this once at boot (Phase 2+).
 */
export function startQueueWorker(platform: ScrapePlatform): () => void {
  let stopped = false;
  console.log(`[queue-worker:${platform}] started (poll ${POLL_MS}ms)`);

  (async () => {
    while (!stopped) {
      let row: ScrapeJobRow | null = null;
      try {
        row = await claimNext(platform);
      } catch (err) {
        console.error(`[queue-worker:${platform}] claim failed:`, err);
      }
      if (!row) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      const handle = makeHandle(row);
      try {
        if (await handle.refreshCancel()) {
          await finish(row.id, 'cancelled', 'Cancelled before start', 0);
          continue;
        }
        await dispatch(row, handle);
        const status = handle.cancelled() ? 'cancelled' : 'done';
        await finish(row.id, status, handle.message || (status === 'cancelled' ? 'Cancelled' : 'Complete'), handle.count, handle.result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[queue-worker:${platform}] job ${row.id} failed:`, err);
        await finish(row.id, 'error', msg, handle.count).catch(() => {});
      } finally {
        handle.dispose();
      }
    }
  })();

  return () => { stopped = true; };
}
