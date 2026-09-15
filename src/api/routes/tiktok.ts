import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { WhereBuilder } from '../../db/where-builder';
import { parseDateRange } from '../parse-date-range';
import { CONTENT_THEMES } from '../../analysis/post-theme';
import { readSessionStatus, getNovncUrl } from '../../config/platform-sessions';
import { enqueueScrapeJob, hasPendingOrRunningJob } from './scrape';

const router = Router();

// ── Session status + login flow ─────────────────────────────────────────────
// `api` has no browser after the Docker split — it can't stat the Cookies
// sqlite file itself (that lives in scraper-tiktok's own profile volume) or
// launch Chrome for a login flow. /session reads the status the
// scraper-tiktok container self-reports (platform_sessions table, written by
// its periodic self-check + after every 'login' job); /login enqueues a
// 'login' job for that container's queue worker to run — see
// scraper-runtime/queue-worker.ts's dispatchTikTok.

// ── GET /api/tiktok/session ────────────────────────────────────────────────
router.get('/session', async (_req: Request, res: Response) => {
  try {
    res.json(await readSessionStatus('tiktok'));
  } catch (err) {
    res.status(500).json({ valid: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/tiktok/login ─────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  try {
    if (await hasPendingOrRunningJob('tiktok', 'login')) {
      res.json({ started: false, message: 'Login flow already running.' });
      return;
    }
    const force = req.body?.force === true;
    const job = await enqueueScrapeJob({
      platform: 'tiktok',
      jobType: 'login',
      message: force ? 'Forcing fresh login…' : 'Login flow starting…',
      params: { force },
    });
    res.json({ started: true, jobId: job.id, message: 'Chrome window opening. Log in there.', novncUrl: getNovncUrl('tiktok') });
  } catch (err) {
    console.error('[tiktok/login]', err);
    res.status(500).json({ started: false, message: 'Failed to start login flow.' });
  }
});

// ── GET /api/tiktok/posts ──────────────────────────────────────────────────
router.get('/posts', async (req: Request, res: Response) => {
  const {
    page        = '1',
    limit       = '50',
    brand,
    spike,
    watchlist,
    sort        = 'date',
    source_type,
  } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 30);

  // Clamp page — unclamped negative/zero page produced a negative SQL OFFSET
  // (unhandled 500 instead of a graceful fallback to page 1). No upper bound
  // on limit — the dashboard's feed/competitors/viral tabs fetch the full
  // filtered set for client-side sort/pagination, same as
  // /api/instagram/posts and /api/xhs/mentions; a 200 cap here silently
  // truncated any filtered set once it grew past it.
  const pageNum   = Math.max(1, parseInt(page, 10) || 1);
  const limitNum  = Math.max(1, parseInt(limit, 10) || 50);
  const offset    = (pageNum - 1) * limitNum;

  const SORT_MAP: Record<string, string> = {
    date:     'tp.posted_at DESC',
    brand:    'b.name ASC, tp.posted_at DESC',
    likes:    'tp.likes DESC',
    views:    'tp.views DESC',
    shares:   'tp.shares DESC',
    comments: '(SELECT COUNT(*) FROM social_comments sc WHERE sc.post_id = tp.post_id AND sc.platform = \'tiktok\') DESC',
  };
  const orderBy = SORT_MAP[sort] ?? SORT_MAP.date;

  const wb = new WhereBuilder();
  if (brand) {
    wb.add('b.slug = ?', brand);
  } else {
    // No brand filter = "All Brands" from the Feed UI, which only means
    // "all own brands" — competitor rows (e.g. Her Hyness, scraped as a
    // proof-of-concept) only ever surface via an explicit ?brand= slug
    // (see competitors-tab.tsx).
    wb.addRaw(`b.type = 'own'`);
  }
  if (spike === 'true') wb.add('tp.spike_flag = ?', true);
  else if (spike === 'false') wb.add('tp.spike_flag = ?', false);
  if (source_type === 'profile' || source_type === 'feed' || source_type === 'search') {
    wb.add('tp.source_type = ?', source_type);
  }
  if (watchlist === 'true') wb.addRaw('tp.watchlist = true');
  wb.dateRange('tp.posted_at', range);

  const where = wb.where;

  try {
    interface TikTokPostRow {
      id: number;
      post_id: string;
      video_url: string | null;
      cover_url: string | null;
      post_url: string | null;
      caption: string | null;
      hashtags: string[] | null;
      product_links: string[] | null;
      views: string;
      likes: string;
      shares: string;
      comments_count: string;
      posted_at: string | null;
      engagement_rate: string | null;
      spike_flag: boolean;
      spike_detected_at: string | null;
      watchlist: boolean;
      scraped_at: string;
      brand_name: string;
      brand_slug: string;
      source_type: string;
      author_handle: string | null;
      is_shop_content: boolean;
      shop_signal: string | null;
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

    const [dataRows, statsRows] = await Promise.all([
      query<TikTokPostRow>(
         `SELECT
            tp.id, tp.post_id, tp.video_url, tp.cover_url, tp.caption, tp.hashtags, tp.product_links,
            tp.views, tp.likes, tp.shares, tp.comments_count, tp.posted_at,
            tp.engagement_rate, tp.spike_flag, tp.spike_detected_at, tp.watchlist, tp.scraped_at,
            tp.source_type, tp.author_handle, tp.is_shop_content, tp.shop_signal,
            b.name AS brand_name, b.slug AS brand_slug,
            CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
              THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
              ELSE NULL
            END AS post_url,
            (SELECT sc2.sentiment FROM social_comments sc2
             WHERE sc2.post_id = tp.post_id AND sc2.platform = 'tiktok' AND sc2.sentiment IS NOT NULL
               AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')
             GROUP BY sc2.sentiment ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_sentiment,
            (SELECT COUNT(*) FILTER (WHERE sentiment = 'positive') FROM social_comments sc2 WHERE sc2.post_id = tp.post_id AND sc2.platform = 'tiktok' AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_positive,
            (SELECT COUNT(*) FILTER (WHERE sentiment = 'negative') FROM social_comments sc2 WHERE sc2.post_id = tp.post_id AND sc2.platform = 'tiktok' AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_negative,
            (SELECT COUNT(*) FILTER (WHERE sentiment = 'neutral') FROM social_comments sc2 WHERE sc2.post_id = tp.post_id AND sc2.platform = 'tiktok' AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_neutral,
            (SELECT COUNT(*) FILTER (WHERE sentiment = 'question') FROM social_comments sc2 WHERE sc2.post_id = tp.post_id AND sc2.platform = 'tiktok' AND (sc2.brand_relevance IS NULL OR sc2.brand_relevance = 'on_topic')) AS sentiment_question
          FROM tiktok_posts tp
          JOIN brands b ON b.id = tp.brand_id
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT $${wb.nextIndex} OFFSET $${wb.nextIndex + 1}`,
        [...wb.values, limitNum, offset]
      ),
      // Aggregates over the full filtered set (not just this page) — drives the stat cards
      query<StatsRow>(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(tp.views), 0) AS total_views,
           AVG(tp.engagement_rate) AS avg_engagement,
           COUNT(*) FILTER (WHERE tp.spike_flag) AS spike_count,
           MAX(tp.scraped_at) AS last_scraped_at
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}`,
        wb.values
      ),
    ]);

    const stats = statsRows[0];

    res.json({
      data: dataRows.map((r) => ({
        ...r,
        views:          parseInt(r.views, 10) || 0,
        likes:          parseInt(r.likes, 10) || 0,
        shares:         parseInt(r.shares, 10) || 0,
        comments_count: parseInt(r.comments_count, 10) || 0,
        sentiment_positive: parseInt(r.sentiment_positive, 10) || 0,
        sentiment_negative: parseInt(r.sentiment_negative, 10) || 0,
        sentiment_neutral:  parseInt(r.sentiment_neutral, 10) || 0,
        sentiment_question: parseInt(r.sentiment_question, 10) || 0,
      })),
      page:  pageNum,
      limit: limitNum,
      total: parseInt(stats?.total ?? '0', 10),
      stats: {
        total_views:    parseInt(stats?.total_views ?? '0', 10),
        avg_engagement: stats?.avg_engagement ? parseFloat(stats.avg_engagement) : 0,
        spike_count:    parseInt(stats?.spike_count ?? '0', 10),
        last_scraped_at: stats?.last_scraped_at ?? null,
      },
    });
  } catch (err) {
    console.error('[tiktok/posts]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/tiktok/posts/:postId ─────────────────────────────────────────
router.get('/posts/:postId', async (req: Request, res: Response) => {
  const { postId } = req.params;
  const { sentiment } = req.query as { sentiment?: string };
  // 'unanalyzed' is a UI pseudo-label for NULL sentiment (see sentimentRows.map
  // below) — it isn't a real value stored in the column, so it needs its own
  // IS NULL clause rather than an equality match.
  const sentimentFilter = sentiment === 'unanalyzed' ? null : sentiment ?? null;
  const filterUnanalyzed = sentiment === 'unanalyzed';
  try {
    interface PostDetailRow {
      id: number; post_id: string; video_url: string | null; post_url: string | null;
      caption: string | null; views: string; likes: string; shares: string;
      comments_count: string; posted_at: string | null; engagement_rate: string | null;
      spike_flag: boolean; watchlist: boolean; brand_name: string; brand_slug: string;
      source_type: string; author_handle: string | null; theme: string | null;
      is_shop_content: boolean; shop_signal: string | null;
    }
    interface SentimentRow { sentiment: string | null; count: string }
    interface CommentRow { content: string; content_translated: string | null; sentiment: string | null; published_at: string | null; likes_count: number; brand_relevance: string | null }

    const [postRows, sentimentRows, commentRows] = await Promise.all([
      query<PostDetailRow>(
        `SELECT tp.id, tp.post_id, tp.video_url, tp.caption,
                tp.views, tp.likes, tp.shares, tp.comments_count,
                tp.posted_at, tp.engagement_rate, tp.spike_flag, tp.watchlist,
                tp.source_type, tp.author_handle, tp.theme, tp.is_shop_content, tp.shop_signal,
                b.name AS brand_name, b.slug AS brand_slug,
                CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                  ELSE NULL END AS post_url
         FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
         WHERE tp.post_id = $1 LIMIT 1`,
        [postId],
      ),
      query<SentimentRow>(
        `SELECT sentiment, COUNT(*) AS count
         FROM social_comments
         WHERE post_id = $1 AND platform = 'tiktok'
           AND (brand_relevance IS NULL OR brand_relevance = 'on_topic')
         GROUP BY sentiment`,
        [postId],
      ),
      query<CommentRow>(
        `SELECT content, content_translated, sentiment, published_at, likes_count, brand_relevance
         FROM social_comments
         WHERE post_id = $1 AND platform = 'tiktok'
           AND ($3::boolean IS NOT TRUE OR sentiment IS NULL)
           AND ($2::text IS NULL OR sentiment = $2)
         ORDER BY likes_count DESC NULLS LAST
         LIMIT 30`,
        [postId, sentimentFilter, filterUnanalyzed],
      ),
    ]);

    if (!postRows.length) return res.status(404).json({ error: 'Post not found' });

    const post = postRows[0];
    res.json({
      post: {
        ...post,
        views:          parseInt(post.views, 10) || 0,
        likes:          parseInt(post.likes, 10) || 0,
        shares:         parseInt(post.shares, 10) || 0,
        comments_count: parseInt(post.comments_count, 10) || 0,
      },
      sentiments: sentimentRows.map((r) => ({ sentiment: r.sentiment ?? 'unanalyzed', count: parseInt(r.count, 10) })),
      comments:   commentRows,
    });
  } catch (err) {
    console.error('[tiktok/posts/:postId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/tiktok/posts/:postId ─────────────────────────────────────────
router.delete('/posts/:postId', async (req: Request, res: Response) => {
  const { postId } = req.params;
  try {
    await query(`DELETE FROM social_comments WHERE post_id = $1`, [postId]);
    const result = await query<{ id: number }>(
      `DELETE FROM tiktok_posts WHERE post_id = $1 RETURNING id`,
      [postId],
    );
    if (result.length === 0) return void res.status(404).json({ error: 'Post not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tiktok/posts DELETE]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/tiktok/posts/:postId/watchlist ─────────────────────────────────
router.patch('/posts/:postId/watchlist', async (req: Request, res: Response) => {
  const { postId } = req.params;
  try {
    const result = await query<{ watchlist: boolean }>(
      `UPDATE tiktok_posts SET watchlist = NOT watchlist WHERE post_id = $1 RETURNING watchlist`,
      [postId],
    );
    if (result.length === 0) return void res.status(404).json({ error: 'Post not found' });
    res.json({ watchlist: result[0].watchlist });
  } catch (err) {
    console.error('[tiktok/posts PATCH watchlist]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/tiktok/posts/:postId/theme ─────────────────────────────────────
router.patch('/posts/:postId/theme', async (req: Request, res: Response) => {
  const { postId } = req.params;
  const { theme } = req.body as { theme?: string };
  if (!theme || !CONTENT_THEMES.includes(theme as (typeof CONTENT_THEMES)[number])) {
    return void res.status(400).json({ error: 'Invalid theme', allowed: CONTENT_THEMES });
  }
  try {
    const result = await query<{ theme: string }>(
      `UPDATE tiktok_posts SET theme = $2 WHERE post_id = $1 RETURNING theme`,
      [postId, theme],
    );
    if (result.length === 0) return void res.status(404).json({ error: 'Post not found' });
    res.json({ theme: result[0].theme });
  } catch (err) {
    console.error('[tiktok/posts PATCH theme]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/tiktok/spikes ─────────────────────────────────────────────────
router.get('/spikes', async (req: Request, res: Response) => {
  const {
    page  = '1',
    limit = '50',
    brand,
  } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 0);

  const pageNum  = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 50);
  const offset   = (pageNum - 1) * limitNum;

  const wb = new WhereBuilder(['tp.spike_flag = true']);
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  wb.dateRange('tp.spike_detected_at', range);

  const where = wb.where;

  try {
    interface TikTokPostRow {
      id: number;
      post_id: string;
      video_url: string | null;
      post_url: string | null;
      caption: string | null;
      hashtags: string[] | null;
      product_links: string[] | null;
      views: string;
      likes: string;
      shares: string;
      comments_count: string;
      posted_at: string | null;
      engagement_rate: string | null;
      spike_flag: boolean;
      spike_detected_at: string | null;
      scraped_at: string;
      brand_name: string;
      brand_slug: string;
    }

    interface CountRow { count: string }

    const dataRows = await query<TikTokPostRow>(
      `SELECT
         tp.id, tp.post_id, tp.video_url, tp.caption, tp.hashtags, tp.product_links,
         tp.views, tp.likes, tp.shares, tp.comments_count, tp.posted_at,
         tp.engagement_rate, tp.spike_flag, tp.spike_detected_at, tp.scraped_at,
         b.name AS brand_name, b.slug AS brand_slug,
         CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
           THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
           ELSE NULL
         END AS post_url
       FROM tiktok_posts tp
       JOIN brands b ON b.id = tp.brand_id
       WHERE ${where}
       ORDER BY tp.spike_detected_at DESC
       LIMIT $${wb.nextIndex} OFFSET $${wb.nextIndex + 1}`,
      [...wb.values, limitNum, offset]
    );

    const countRows = await query<CountRow>(
      `SELECT COUNT(*) AS count
       FROM tiktok_posts tp
       JOIN brands b ON b.id = tp.brand_id
       WHERE ${where}`,
      wb.values
    );

    res.json({
      data: dataRows.map((r) => ({
        ...r,
        views:          parseInt(r.views, 10) || 0,
        likes:          parseInt(r.likes, 10) || 0,
        shares:         parseInt(r.shares, 10) || 0,
        comments_count: parseInt(r.comments_count, 10) || 0,
      })),
      page:  pageNum,
      limit: limitNum,
      total: parseInt(countRows[0]?.count ?? '0', 10),
    });
  } catch (err) {
    console.error('[tiktok/spikes]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/tiktok/hashtags ───────────────────────────────────────────────
router.get('/hashtags', async (req: Request, res: Response) => {
  const { brand } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 7);

  const wb = new WhereBuilder();
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  wb.dateRange('tp.posted_at', range);

  const where = wb.where;

  try {
    interface HashtagRow {
      hashtag: string;
      count: string;
      brand_slug: string | null;
    }

    const rows = await query<HashtagRow>(
      `SELECT
         unnest(tp.hashtags) AS hashtag,
         COUNT(*) AS count
         ${brand ? ', b.slug AS brand_slug' : ', NULL::text AS brand_slug'}
       FROM tiktok_posts tp
       JOIN brands b ON b.id = tp.brand_id
       WHERE ${where}
       GROUP BY hashtag${brand ? ', b.slug' : ''}
       ORDER BY count DESC
       LIMIT 50`,
      wb.values
    );

    res.json({
      data: rows.map((r) => ({
        hashtag:    r.hashtag,
        count:      parseInt(r.count, 10),
        brand_slug: r.brand_slug ?? undefined,
      })),
    });
  } catch (err) {
    console.error('[tiktok/hashtags]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/tiktok/trending-hashtags ─────────────────────────────────────
router.get('/trending-hashtags', async (_req: Request, res: Response) => {
  try {
    interface TrendingHashtagRow {
      hashtag: string;
      category: string;
      brand_slug: string | null;
      view_count: string | null;
      post_count: number | null;
      scraped_at: string;
    }

    interface BrandHashtagRow {
      hashtag: string;
      brand_slug: string;
      brand_name: string;
      count: string;
    }

    // Fetch scraped trending hashtags (last scrape run)
    const trendingRows = await query<TrendingHashtagRow>(
      `SELECT hashtag, category, brand_slug, view_count, post_count, scraped_at
       FROM trending_hashtags
       WHERE scraped_at >= (SELECT MAX(scraped_at) - INTERVAL '1 hour' FROM trending_hashtags)
       ORDER BY view_count DESC NULLS LAST, post_count DESC NULLS LAST
       LIMIT 50`
    );

    // Brand hashtags aggregated from tiktok_posts
    const brandRows = await query<BrandHashtagRow>(
      `SELECT
         unnest(tp.hashtags) AS hashtag,
         b.slug AS brand_slug,
         b.name AS brand_name,
         COUNT(*) AS count
       FROM tiktok_posts tp
       JOIN brands b ON b.id = tp.brand_id
       WHERE tp.posted_at >= NOW() - INTERVAL '30 days'
         AND tp.hashtags IS NOT NULL
       GROUP BY 1, 2, 3
       ORDER BY count DESC
       LIMIT 50`
    );

    res.json({
      trending: trendingRows.map((r) => ({
        hashtag:    r.hashtag,
        category:   r.category,
        brand_slug: r.brand_slug ?? null,
        view_count: r.view_count ? parseInt(r.view_count, 10) : null,
        post_count: r.post_count ?? null,
        scraped_at: r.scraped_at,
      })),
      brand_hashtags: brandRows.map((r) => ({
        hashtag:    r.hashtag,
        brand_slug: r.brand_slug,
        brand_name: r.brand_name,
        count:      parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    console.error('[tiktok/trending-hashtags]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/tiktok/search/stats ─────────────────────────────────────────
router.get('/search/stats', async (req: Request, res: Response) => {
  const { brand } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 7);

  const wb = new WhereBuilder(["tp.source_type = 'search'"]);
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  wb.dateRange('tp.posted_at', range);
  const where = wb.where;

  try {
    const [keywordRows, authorRows, sentimentRows, trendRows] = await Promise.all([
      // keyword breakdown
      query<{ keyword: string; post_count: string; total_views: string }>(
        `SELECT kw AS keyword, COUNT(*) AS post_count, COALESCE(SUM(tp.views),0) AS total_views
         FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
         CROSS JOIN LATERAL unnest(tp.search_keywords) AS kw
         WHERE ${where}
         GROUP BY kw ORDER BY post_count DESC`,
        wb.values,
      ),
      // top authors
      query<{ handle: string; mention_count: string; total_views: string; total_likes: string }>(
        `SELECT tp.author_handle AS handle, COUNT(*) AS mention_count,
                COALESCE(SUM(tp.views),0) AS total_views, COALESCE(SUM(tp.likes),0) AS total_likes
         FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
         WHERE ${where} AND tp.author_handle IS NOT NULL
         GROUP BY tp.author_handle ORDER BY mention_count DESC, total_views DESC LIMIT 10`,
        wb.values,
      ),
      // sentiment counts from comments on search posts. Joins on brand_id too, not
      // just post_id — a post mentioning multiple own brands gets one tiktok_posts
      // row per brand, and without the brand_id match this would double-count a
      // comment's sentiment once per brand the post happens to mention.
      query<{ sentiment: string; count: string }>(
        `SELECT sc.sentiment, COUNT(*) AS count
         FROM social_comments sc
         JOIN tiktok_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where} AND sc.sentiment IS NOT NULL AND sc.platform = 'tiktok'
           AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
         GROUP BY sc.sentiment`,
        wb.values,
      ),
      // daily trend
      query<{ date: string; post_count: string; total_views: string; total_engagement: string }>(
        `SELECT DATE(tp.posted_at) AS date, COUNT(*) AS post_count,
                COALESCE(SUM(tp.views),0) AS total_views,
                COALESCE(SUM(tp.likes + tp.shares + tp.comments_count),0) AS total_engagement
         FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}
         GROUP BY DATE(tp.posted_at) ORDER BY date ASC`,
        wb.values,
      ),
    ]);

    const sentimentMap = Object.fromEntries(sentimentRows.map((r) => [r.sentiment, parseInt(r.count, 10)]));

    res.json({
      keyword_breakdown: keywordRows.map((r) => ({
        keyword:     r.keyword,
        post_count:  parseInt(r.post_count, 10),
        total_views: parseInt(r.total_views, 10),
      })),
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
        total:    (sentimentMap.positive ?? 0) + (sentimentMap.negative ?? 0) + (sentimentMap.neutral ?? 0) + (sentimentMap.question ?? 0),
      },
      daily_trend: trendRows.map((r) => ({
        date:             r.date,
        post_count:       parseInt(r.post_count, 10),
        total_views:      parseInt(r.total_views, 10),
        total_engagement: parseInt(r.total_engagement, 10),
      })),
    });
  } catch (err) {
    console.error('[tiktok/search/stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/tiktok/search ────────────────────────────────────────────────
router.get('/search', async (req: Request, res: Response) => {
  const {
    page    = '1',
    limit   = '25',
    brand,
    spike,
    watchlist,
    keyword,
    sort    = 'date',
    author,
    caption,
  } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 7);

  const pageNum  = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 25);
  const offset   = (pageNum - 1) * limitNum;

  const SORT_MAP: Record<string, string> = {
    date:     'tp.posted_at DESC',
    likes:    'tp.likes DESC',
    views:    'tp.views DESC',
    shares:   'tp.shares DESC',
    comments: '(SELECT COUNT(*) FROM social_comments sc WHERE sc.post_id = tp.post_id AND sc.platform = \'tiktok\') DESC',
  };
  const orderBy = SORT_MAP[sort] ?? SORT_MAP.date;

  const wb = new WhereBuilder(["tp.source_type = 'search'"]);
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  if (spike === 'true') wb.add('tp.spike_flag = ?', true);
  else if (spike === 'false') wb.add('tp.spike_flag = ?', false);
  if (watchlist === 'true') wb.addRaw('tp.watchlist = true');
  if (keyword) {
    // Exact array-element match — mirrors the keyword-breakdown stat (GROUP BY kw),
    // so clicking a keyword bar shows exactly that bar's post count (not a substring superset).
    wb.add('? = ANY(tp.search_keywords)', keyword);
  }
  if (author) wb.add('tp.author_handle ILIKE ?', `%${author.replace(/^@/, '')}%`);
  if (caption) wb.add('tp.caption ILIKE ?', `%${caption}%`);
  wb.dateRange('tp.posted_at', range);

  const where = wb.where;

  try {
    interface SearchPostRow {
      id: number;
      post_id: string;
      post_url: string | null;
      caption: string | null;
      hashtags: string[] | null;
      views: string;
      likes: string;
      shares: string;
      comments_count: string;
      posted_at: string | null;
      engagement_rate: string | null;
      scraped_at: string;
      brand_name: string;
      brand_slug: string;
      author_handle: string | null;
      search_keywords: string[];
      spike_flag: boolean;
      watchlist: boolean;
      is_shop_content: boolean;
      shop_signal: string | null;
    }
    interface CountRow { count: string; total_views: string; avg_engagement: string | null; last_scraped_at: string | null }

    const [dataRows, countRows] = await Promise.all([
      query<SearchPostRow>(
        `SELECT
           tp.id, tp.post_id, tp.caption, tp.hashtags,
           tp.views, tp.likes, tp.shares, tp.comments_count,
           tp.posted_at, tp.engagement_rate, tp.scraped_at,
           tp.author_handle, tp.search_keywords, tp.spike_flag, tp.watchlist, tp.is_shop_content, tp.shop_signal,
           b.name AS brand_name, b.slug AS brand_slug,
           CASE WHEN tp.author_handle IS NOT NULL
             THEN 'https://www.tiktok.com/@' || tp.author_handle || '/video/' || tp.post_id
             ELSE NULL
           END AS post_url
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT $${wb.nextIndex} OFFSET $${wb.nextIndex + 1}`,
        [...wb.values, limitNum, offset],
      ),
      // Aggregates over the full filtered set (not just this page) — drive the stat cards
      query<CountRow>(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(tp.views), 0) AS total_views,
                AVG(tp.engagement_rate) AS avg_engagement,
                MAX(tp.scraped_at) AS last_scraped_at
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}`,
        wb.values,
      ),
    ]);

    res.json({
      data: dataRows.map((r) => ({
        ...r,
        views:          parseInt(r.views, 10) || 0,
        likes:          parseInt(r.likes, 10) || 0,
        shares:         parseInt(r.shares, 10) || 0,
        comments_count: parseInt(r.comments_count, 10) || 0,
      })),
      page:  pageNum,
      limit: limitNum,
      total: parseInt(countRows[0]?.count ?? '0', 10),
      stats: {
        total_views:    parseInt(countRows[0]?.total_views ?? '0', 10),
        avg_engagement: countRows[0]?.avg_engagement ? parseFloat(countRows[0].avg_engagement) : 0,
        last_scraped_at: countRows[0]?.last_scraped_at ?? null,
      },
    });
  } catch (err) {
    console.error('[tiktok/search]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
