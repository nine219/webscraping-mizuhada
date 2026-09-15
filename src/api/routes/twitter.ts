import { Router, Request, Response } from 'express';
import { enqueueScrapeJob, hasPendingOrRunningJob } from './scrape';
import { createNotification } from '../../notifications/store';
import { socialQuery as query } from '../../db/social-client';
import { WhereBuilder } from '../../db/where-builder';
import { parseDateRange } from '../parse-date-range';
import { getThresholds, getKeywords } from '../../config/settings-loader';
import { readSessionStatus, getNovncUrl } from '../../config/platform-sessions';

const router = Router();

// /posts + /posts/:postId are MizuMi-only: they read the own-account X FEED
// (twitter_posts, anchored on brands.twitter_handle), and MizuMi is
// currently the only own brand with an X account configured — Gentle
// Colors/Bomi have no twitter_handle. Hardcoded to 'mizumi' rather than
// derived from `twitter_handle IS NOT NULL` since that's the only row today;
// revisit if a second own brand ever gets an X account.
//
// /mentions/stats is NOT brand-restricted — docs/scope-x-campaigns.md
// decision 10 originally scoped X keyword search to MizuMi-only, but that
// was reopened in twitter-search.ts (see its 2026-07-21 comment) to cover
// all 3 own brands; the doc itself was never updated to match. This route
// takes an optional ?brand= to match the Mentions tab's brand pills.

// `api` has no browser after the Docker split — /session reads the status
// scraper-twitter self-reports (platform_sessions table); /login enqueues a
// 'login' job for that container's queue worker — see
// scraper-runtime/queue-worker.ts's dispatchTwitter.

// ── GET /api/twitter/session ──────────────────────────────────────────────
router.get('/session', async (_req: Request, res: Response) => {
  try {
    res.json(await readSessionStatus('twitter'));
  } catch (err) {
    res.status(500).json({ valid: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/twitter/login ───────────────────────────────────────────────
router.post('/login', async (_req: Request, res: Response) => {
  try {
    if (await hasPendingOrRunningJob('twitter', 'login')) {
      res.json({ started: false, message: 'Login flow already running.' });
      return;
    }
    const job = await enqueueScrapeJob({ platform: 'twitter', jobType: 'login', message: 'Login flow starting…' });
    res.json({ started: true, jobId: job.id, message: 'Chrome window opening. Log in there.', novncUrl: getNovncUrl('twitter') });
  } catch (err) {
    console.error('[twitter/login]', err);
    res.status(500).json({ started: false, message: 'Failed to start login flow.' });
  }
});

// ── POST /api/twitter/search/run ──────────────────────────────────────────
// Rate-limit/cancel handling now lives in the scraper-twitter container's
// queue worker — see scraper-runtime/queue-worker.ts dispatchTwitter,
// job_type 'search'.
router.post('/search/run', async (req: Request, res: Response) => {
  const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : '';

  try {
    const job = await enqueueScrapeJob({
      platform: 'twitter', brand: 'all', jobType: 'search',
      message: keyword ? `Queued X search for "${keyword}"...` : 'Queued Twitter search (preset keywords)...',
      params: { keyword: keyword || undefined },
    });
    createNotification({
      type: 'scrape_job', title: 'Twitter search queued',
      body: keyword ? `Ad-hoc X search: "${keyword}"` : 'X keyword search (preset list)',
      payload: { jobId: job.id, platform: 'twitter-search', keyword },
    }).catch(() => {});
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[twitter/search/run]', err);
    res.status(500).json({ error: 'Failed to enqueue Twitter search' });
  }
});

// ── GET /api/twitter/posts ──────────────────────────────────────────────────
// Mirrors GET /api/tiktok/posts' response shape (api/routes/tiktok.ts),
// adapted to X's columns (retweets_count/quotes_count/replies instead of
// shares; campaign_id/is_ambassador/campaign_locked instead of
// source_type-based feed/search). Filters: campaign_id, spike.
//
// Per commit 986bb61's fetch-all + client-sort architecture — already the
// established pattern for X (e.g. GET /api/campaigns has no pagination/sort
// param either) — this returns the FULL filtered set: no page/limit/offset,
// no ?sort param. Default date range is all-time (fallbackDays=0) rather
// than TikTok's 30-day default, since campaign tracking is manual/low-volume
// — hiding older tracked posts by default would be surprising here.
router.get('/posts', async (req: Request, res: Response) => {
  const { campaign_id, spike } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 0);

  const wb = new WhereBuilder([`b.slug = 'mizumi'`]);
  if (campaign_id) {
    const id = parseInt(campaign_id, 10);
    if (!Number.isNaN(id)) wb.add('tp.campaign_id = ?', id);
  }
  if (spike === 'true') wb.add('tp.spike_flag = ?', true);
  else if (spike === 'false') wb.add('tp.spike_flag = ?', false);
  wb.dateRange('tp.posted_at', range);
  const where = wb.where;

  try {
    interface TwitterPostRow {
      id: number;
      post_id: string;
      post_url: string | null;
      caption: string | null;
      hashtags: string[] | null;
      views: string;
      likes: string;
      retweets_count: string;
      replies: string;
      quotes_count: string;
      posted_at: string | null;
      engagement_rate: string | null;
      spike_flag: boolean;
      spike_detected_at: string | null;
      scraped_at: string;
      source_type: string;
      author_handle: string | null;
      campaign_id: number | null;
      is_ambassador: boolean;
      campaign_locked: boolean;
      brand_name: string;
      brand_slug: string;
      dominant_sentiment: string | null;
      sentiment_positive: string;
      sentiment_negative: string;
      sentiment_neutral: string;
      sentiment_question: string;
    }
    interface StatsRow {
      total: string;
      total_views: string;
      avg_engagement: string | null;
      spike_count: string;
      last_scraped_at: string | null;
    }

    // Sentiment subqueries join on post_id + brand_id (not just post_id) —
    // same convention as campaign-report.ts/campaigns.ts's twitter joins,
    // since a post_id can theoretically repeat across brands. Also apply the
    // brand_relevance gate (M3, sentiment.ts territory — read here, not
    // edited) so an "other_brand" comment doesn't count toward this post's
    // own-brand tally once that column starts getting populated; NULL
    // (not yet classified) still counts, same convention as everywhere else.
    const [dataRows, statsRows] = await Promise.all([
      query<TwitterPostRow>(
        `SELECT
           tp.id, tp.post_id, tp.post_url, tp.caption, tp.hashtags,
           tp.views, tp.likes, tp.retweets_count, tp.replies, tp.quotes_count,
           tp.posted_at, tp.engagement_rate, tp.spike_flag, tp.spike_detected_at, tp.scraped_at,
           tp.source_type, tp.author_handle, tp.campaign_id, tp.is_ambassador, tp.campaign_locked,
           b.name AS brand_name, b.slug AS brand_slug,
           (SELECT sc2.sentiment FROM social_comments sc2
            WHERE sc2.post_id = tp.post_id AND sc2.brand_id = tp.brand_id AND sc2.platform = 'twitter'
              AND sc2.sentiment IS NOT NULL AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')
            GROUP BY sc2.sentiment ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_sentiment,
           (SELECT COUNT(*) FILTER (WHERE sentiment = 'positive') FROM social_comments sc2
            WHERE sc2.post_id = tp.post_id AND sc2.brand_id = tp.brand_id AND sc2.platform = 'twitter'
              AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_positive,
           (SELECT COUNT(*) FILTER (WHERE sentiment = 'negative') FROM social_comments sc2
            WHERE sc2.post_id = tp.post_id AND sc2.brand_id = tp.brand_id AND sc2.platform = 'twitter'
              AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_negative,
           (SELECT COUNT(*) FILTER (WHERE sentiment = 'neutral') FROM social_comments sc2
            WHERE sc2.post_id = tp.post_id AND sc2.brand_id = tp.brand_id AND sc2.platform = 'twitter'
              AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_neutral,
           (SELECT COUNT(*) FILTER (WHERE sentiment = 'question') FROM social_comments sc2
            WHERE sc2.post_id = tp.post_id AND sc2.brand_id = tp.brand_id AND sc2.platform = 'twitter'
              AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_question
         FROM twitter_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}
         ORDER BY tp.posted_at DESC NULLS LAST`,
        wb.values,
      ),
      // Aggregates over the same filtered set — with fetch-all there's no
      // "full set vs. this page" distinction anymore, but keeping this as a
      // separate SQL aggregate (vs. computing client-side) still matches
      // GET /api/tiktok/posts' response shape for a future dashboard KPI row.
      query<StatsRow>(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(tp.views), 0) AS total_views,
           AVG(tp.engagement_rate) AS avg_engagement,
           COUNT(*) FILTER (WHERE tp.spike_flag) AS spike_count,
           MAX(tp.scraped_at) AS last_scraped_at
         FROM twitter_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}`,
        wb.values,
      ),
    ]);

    const stats = statsRows[0];

    res.json({
      data: dataRows.map((r) => ({
        ...r,
        views:              parseInt(r.views, 10) || 0,
        likes:              parseInt(r.likes, 10) || 0,
        retweets_count:     parseInt(r.retweets_count, 10) || 0,
        replies:            parseInt(r.replies, 10) || 0,
        quotes_count:       parseInt(r.quotes_count, 10) || 0,
        sentiment_positive: parseInt(r.sentiment_positive, 10) || 0,
        sentiment_negative: parseInt(r.sentiment_negative, 10) || 0,
        sentiment_neutral:  parseInt(r.sentiment_neutral, 10) || 0,
        sentiment_question: parseInt(r.sentiment_question, 10) || 0,
      })),
      total: parseInt(stats?.total ?? '0', 10),
      stats: {
        total_views:     parseInt(stats?.total_views ?? '0', 10),
        avg_engagement:  stats?.avg_engagement ? parseFloat(stats.avg_engagement) : 0,
        spike_count:     parseInt(stats?.spike_count ?? '0', 10),
        last_scraped_at: stats?.last_scraped_at ?? null,
      },
    });
  } catch (err) {
    console.error('[twitter/posts]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/twitter/posts/:postId ──────────────────────────────────────────
// Single anchor post + its replies/quotes. Replies and quote tweets both
// land in social_comments with source_type='profile' and post_id = the
// anchor's post_id (see twitter-comments.ts file header) — distinguished
// from each other purely by is_reply.
router.get('/posts/:postId', async (req: Request, res: Response) => {
  const { postId } = req.params;
  try {
    interface PostDetailRow {
      id: number; post_id: string; post_url: string | null; caption: string | null;
      hashtags: string[] | null; views: string; likes: string; retweets_count: string;
      replies: string; quotes_count: string; posted_at: string | null; engagement_rate: string | null;
      spike_flag: boolean; spike_detected_at: string | null; source_type: string; author_handle: string | null;
      campaign_id: number | null; is_ambassador: boolean; campaign_locked: boolean;
      brand_name: string; brand_slug: string;
    }
    interface CommentRow {
      external_id: string | null; content: string; sentiment: string | null; published_at: string | null;
      likes_count: number | null; retweets_count: number | null; views_count: number | null;
      author_name: string | null; is_reply: boolean;
    }
    interface SentimentRow { sentiment: string | null; count: string }

    const [postRows, commentRows, sentimentRows] = await Promise.all([
      query<PostDetailRow>(
        `SELECT tp.id, tp.post_id, tp.post_url, tp.caption, tp.hashtags,
                tp.views, tp.likes, tp.retweets_count, tp.replies, tp.quotes_count,
                tp.posted_at, tp.engagement_rate, tp.spike_flag, tp.spike_detected_at,
                tp.source_type, tp.author_handle, tp.campaign_id, tp.is_ambassador, tp.campaign_locked,
                b.name AS brand_name, b.slug AS brand_slug
         FROM twitter_posts tp JOIN brands b ON b.id = tp.brand_id
         WHERE tp.post_id = $1 AND b.slug = 'mizumi' LIMIT 1`,
        [postId],
      ),
      query<CommentRow>(
        `SELECT sc.external_id, sc.content, sc.sentiment, sc.published_at,
                sc.likes_count, sc.retweets_count, sc.views_count, sc.author_name, sc.is_reply
         FROM social_comments sc
         JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
         JOIN brands b ON b.id = tp.brand_id
         WHERE sc.post_id = $1 AND sc.platform = 'twitter' AND sc.source_type = 'profile' AND b.slug = 'mizumi'
         ORDER BY (COALESCE(sc.likes_count,0) + COALESCE(sc.retweets_count,0)) DESC, sc.published_at DESC NULLS LAST
         LIMIT 100`,
        [postId],
      ),
      query<SentimentRow>(
        `SELECT sc.sentiment, COUNT(*) AS count
         FROM social_comments sc
         JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
         JOIN brands b ON b.id = tp.brand_id
         WHERE sc.post_id = $1 AND sc.platform = 'twitter' AND sc.source_type = 'profile' AND b.slug = 'mizumi'
         GROUP BY sc.sentiment`,
        [postId],
      ),
    ]);

    if (!postRows.length) { res.status(404).json({ error: 'Post not found' }); return; }
    const post = postRows[0];

    const withUrl = (c: CommentRow) => ({
      ...c,
      post_url: c.author_name && c.external_id ? `https://x.com/${c.author_name}/status/${c.external_id}` : null,
    });

    res.json({
      post: {
        ...post,
        views:          parseInt(post.views, 10) || 0,
        likes:          parseInt(post.likes, 10) || 0,
        retweets_count: parseInt(post.retweets_count, 10) || 0,
        replies:        parseInt(post.replies, 10) || 0,
        quotes_count:   parseInt(post.quotes_count, 10) || 0,
      },
      replies: commentRows.filter((c) => c.is_reply).map(withUrl),
      quotes:  commentRows.filter((c) => !c.is_reply).map(withUrl),
      sentiments: sentimentRows.map((r) => ({ sentiment: r.sentiment ?? 'unanalyzed', count: parseInt(r.count, 10) })),
    });
  } catch (err) {
    console.error('[twitter/posts/:postId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/twitter/mentions/stats ─────────────────────────────────────────
// Mirrors GET /api/tiktok/search/stats' shape (top authors, sentiment
// counts, daily trend) over social_comments WHERE platform='twitter' AND
// source_type='search' (UGC mentions found by keyword search — see
// twitter-search.ts).
//
// NOTE — no keyword_breakdown here, unlike the TikTok version: tiktok_posts
// has a search_keywords[] column recording which keyword(s) matched each
// post; social_comments (where X UGC mentions live) has no equivalent column
// — twitter-search.ts's upsertTweet never records which keyword found a
// given tweet. Adding that would be a scraper-side change (out of scope for
// this milestone, which is read-only API work over existing columns) —
// flagged as a gap rather than guessed at.
//
// is_high_reach (decision 2, milestone doc): a derived, NOT stored, flag —
// deliberately not a social_comments column since that table is shared
// across every platform and X-specific spike semantics there risk touching
// TikTok/XHS rows. A mention counts as high-reach if its views cross the
// same viral-views bar used for X spike detection (thresholds.
// xViralViewsThreshold) OR its retweet count alone clears
// HIGH_REACH_MIN_RETWEETS — retweets are a stronger organic-amplification
// signal than views for a single mention, since view counts can be inflated
// by algorithmic impressions with no real endorsement behind them.
const HIGH_REACH_MIN_RETWEETS = 100;

router.get('/mentions/stats', async (req: Request, res: Response) => {
  const range = parseDateRange(req.query as Record<string, string>, 7);
  const brand = typeof req.query.brand === 'string' ? req.query.brand : undefined;
  const th = await getThresholds().catch(() => null);
  const viralViews = th?.xViralViewsThreshold ?? 50_000;
  // Both values here are trusted server-side numbers (settings/local
  // constant), never request input — safe to interpolate directly, same
  // convention as campaign-report.ts's `LIMIT ${TOP_N}`.
  const highReachSql = `(COALESCE(sc.views_count,0) >= ${viralViews} OR COALESCE(sc.retweets_count,0) >= ${HIGH_REACH_MIN_RETWEETS})`;

  // Defense-in-depth own-handle exclusion: source_type='search' rows are
  // SUPPOSED to already exclude own-brand authors — twitter-search.ts's
  // searchTwitterKeyword() pre-filters against getTwitterOwnHandles()
  // (settings.keywords.ownHandlesTwitter) before ever inserting a row. But
  // that list defaults empty (DEFAULT_SETTINGS.keywords.ownHandlesTwitter =
  // []) and nothing seeds it with MizuMi's own handle, so verifying this
  // endpoint against the real DB surfaced MizuMi's own promotional tweets
  // showing up as a "top UGC author" of its own mentions — not sensible for
  // an endpoint whose whole point is third-party reach. Same dynamic
  // brands.twitter_handle + settings ownHandlesTwitter combo as
  // twitter-creators.ts's computeCreators, applied here too so this
  // endpoint doesn't silently trust an upstream filter that's currently a
  // no-op for X.
  const kw = await getKeywords();
  const brandHandleRows = await query<{ twitter_handle: string | null }>(
    `SELECT twitter_handle FROM brands WHERE twitter_handle IS NOT NULL`,
  );
  const excludeHandles = [
    ...brandHandleRows.map((r) => (r.twitter_handle ?? '').toLowerCase()),
    ...kw.ownHandlesTwitter.map((h) => h.toLowerCase().replace(/^@/, '')),
  ].filter(Boolean);

  // Not MizuMi-only anymore — X keyword search covers all 3 own brands
  // (twitter-search.ts's loadOwnBrandCandidates() is type='own'-scoped, so
  // these rows are never a competitor's regardless of ?brand=). Optional
  // ?brand= narrows to one; omitted shows all three, matching what the
  // Mentions tab's brand pills actually filter by (GET /api/social, already
  // multi-brand) — this endpoint's high-reach threshold/top-authors/trend
  // should track the same scope, not silently stay pinned to MizuMi.
  const wb = new WhereBuilder([`sc.platform = 'twitter'`, `sc.source_type = 'search'`]);
  if (brand) wb.add('b.slug = ?', brand);
  wb.add('LOWER(COALESCE(sc.author_name, \'\')) <> ALL(?::text[])', excludeHandles);
  wb.dateRange('sc.published_at', range);
  const where = wb.where;

  try {
    const [authorRows, sentimentRows, trendRows, highReachCountRows, topHighReachRows] = await Promise.all([
      query<{ handle: string; mention_count: string; total_views: string; total_likes: string }>(
        `SELECT sc.author_name AS handle, COUNT(*) AS mention_count,
                COALESCE(SUM(sc.views_count),0) AS total_views, COALESCE(SUM(sc.likes_count),0) AS total_likes
         FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
         WHERE ${where} AND sc.author_name IS NOT NULL AND sc.author_name <> ''
         GROUP BY sc.author_name ORDER BY mention_count DESC, total_views DESC LIMIT 10`,
        wb.values,
      ),
      // brand_relevance gate — same M3 convention as GET /posts above.
      query<{ sentiment: string; count: string }>(
        `SELECT sc.sentiment, COUNT(*) AS count
         FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
         WHERE ${where} AND sc.sentiment IS NOT NULL
           AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
         GROUP BY sc.sentiment`,
        wb.values,
      ),
      query<{ date: string; post_count: string; total_views: string; total_engagement: string }>(
        `SELECT DATE(sc.published_at) AS date, COUNT(*) AS post_count,
                COALESCE(SUM(sc.views_count),0) AS total_views,
                COALESCE(SUM(COALESCE(sc.likes_count,0) + COALESCE(sc.retweets_count,0) + COALESCE(sc.reply_count,0)),0) AS total_engagement
         FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
         WHERE ${where}
         GROUP BY DATE(sc.published_at) ORDER BY date ASC`,
        wb.values,
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) FILTER (WHERE ${highReachSql}) AS count
         FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
         WHERE ${where}`,
        wb.values,
      ),
      query<{
        external_id: string | null; author_name: string | null; content: string | null;
        views_count: string | null; retweets_count: string | null; likes_count: string | null; published_at: string | null;
      }>(
        `SELECT sc.external_id, sc.author_name, sc.content, sc.views_count, sc.retweets_count, sc.likes_count, sc.published_at
         FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
         WHERE ${where} AND ${highReachSql}
         ORDER BY COALESCE(sc.views_count,0) DESC, COALESCE(sc.retweets_count,0) DESC
         LIMIT 10`,
        wb.values,
      ),
    ]);

    const sentimentMap = Object.fromEntries(sentimentRows.map((r) => [r.sentiment, parseInt(r.count, 10)]));

    res.json({
      top_authors: authorRows.map((r) => ({
        handle:        r.handle,
        mention_count: parseInt(r.mention_count, 10),
        total_views:   parseInt(r.total_views, 10),
        total_likes:   parseInt(r.total_likes, 10),
      })),
      sentiment: {
        positive: sentimentMap.positive ?? 0,
        negative: sentimentMap.negative ?? 0,
        neutral:  sentimentMap.neutral  ?? 0,
        question: sentimentMap.question ?? 0,
        resale:   sentimentMap.resale   ?? 0,
        total: Object.values(sentimentMap).reduce((a: number, b: number) => a + b, 0),
      },
      daily_trend: trendRows.map((r) => ({
        date:             r.date,
        post_count:       parseInt(r.post_count, 10),
        total_views:      parseInt(r.total_views, 10),
        total_engagement: parseInt(r.total_engagement, 10),
      })),
      high_reach: {
        count:              parseInt(highReachCountRows[0]?.count ?? '0', 10),
        threshold_views:    viralViews,
        threshold_retweets: HIGH_REACH_MIN_RETWEETS,
      },
      top_high_reach_mentions: topHighReachRows.map((r) => ({
        external_id:     r.external_id,
        author_name:     r.author_name,
        post_url:        r.author_name && r.external_id ? `https://x.com/${r.author_name}/status/${r.external_id}` : null,
        content_snippet: r.content && r.content.length > 200 ? `${r.content.slice(0, 200)}…` : r.content,
        views_count:     parseInt(r.views_count ?? '0', 10) || 0,
        retweets_count:  parseInt(r.retweets_count ?? '0', 10) || 0,
        likes_count:     parseInt(r.likes_count ?? '0', 10) || 0,
        published_at:    r.published_at,
        is_high_reach:   true,
      })),
    });
  } catch (err) {
    console.error('[twitter/mentions/stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
