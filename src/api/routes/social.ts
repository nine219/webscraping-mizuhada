import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { classifyUnanalyzedComments } from '../../analysis/sentiment';
import { noiseExcludeSql } from '../../analysis/comments';
import { sendTestNegativeSpikeAlert } from '../../analysis/spike-detection';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const {
    sentiment,
    platform,
    brand,
    days,
    date,
    from,
    to,
    page = '1',
    limit = '30',
    sort,
    topic,
    urgency,
    search,
  } = req.query as Record<string, string>;
  // Free-text search — Social Listening previously had zero text search
  // (pill/date filters only), unlike UGC Performance and TikTok UGC Search.
  // Matches original + translated content and author, ILIKE (case-insensitive
  // substring), same pattern as tiktok.ts's caption filter.
  const searchQ = search?.trim() || null;
  // Clamp page — unclamped negative/zero page produced a negative SQL OFFSET,
  // which Postgres rejects as an unhandled 500 instead of a graceful fallback
  // to page 1 (matches the Math.min/max pattern already used in
  // command-center.ts's /top-ugc and tiktok-influencers.ts). No upper bound
  // on limit — callers (dashboard tabs) fetch the full filtered set for
  // client-side sort/pagination, same as /api/instagram/posts and
  // /api/xhs/mentions; a 200 cap here silently truncated "All time" once a
  // filtered set grew past it (surfaced by a manual X history backfill).
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit, 10) || 30);
  const offset = (pageNum - 1) * limitNum;
  const daysNum = days ? parseInt(days, 10) : 0;
  const urgencyNum = urgency ? parseInt(urgency, 10) : 0;
  // Exact single-day drill-down (chart click-through) — YYYY-MM-DD, takes
  // priority over `days` when both are somehow set (caller shouldn't send both).
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const dateFilter = date && DATE_RE.test(date) ? date : null;
  // Custom date-range picker (from/to, both YYYY-MM-DD, inclusive) — independent
  // of `days`/`date`; the frontend only ever sends one of the three at a time.
  const fromFilter = from && DATE_RE.test(from) ? from : null;
  const toFilter   = to   && DATE_RE.test(to)   ? to   : null;
  // Comma-separated lists for multi-select platform/sentiment filters —
  // null (not just empty string) means "no filter" so the SQL's
  // `= ANY($n)` OR-with-null-check below can distinguish the two.
  const sentimentList = sentiment ? sentiment.split(',').filter(Boolean) : null;
  const platformList  = platform  ? platform.split(',').filter(Boolean)  : null;
  // 'urgency' sort surfaces the most-urgent negative comments first (Negative
  // Queue). Falls back to the default recency order for any other value.
  const orderBy = sort === 'urgency'
    ? 'sc.urgency DESC NULLS LAST, COALESCE(sc.published_at, sc.scraped_at) DESC'
    : 'COALESCE(sc.published_at, sc.scraped_at) DESC';

  try {
    const rows = await query<{
      id: number;
      post_id: string | null;
      content: string;
      content_translated: string | null;
      brand_name: string;
      brand_slug: string;
      platform: string;
      sentiment: string | null;
      sentiment_score: string | null;
      topic: string | null;
      urgency: number | null;
      post_theme: string | null;
      published_at: Date | null;
      scraped_at: Date;
      post_url: string | null;
      likes_count: string | null;
      views_count: string | null;
      retweets_count: string | null;
      reply_count: string | null;
      author_followers: number | null;
      cover_url: string | null;
      note_type: string | null;
      author_name: string | null;
      author_avatar: string | null;
      original_post_url: string | null;
      tweet_type: string | null;
    }>(
      `SELECT
         sc.id,
         sc.post_id,
         sc.content,
         sc.content_translated,
         b.name  AS brand_name,
         b.slug  AS brand_slug,
         sc.platform,
         sc.sentiment,
         sc.sentiment_score,
         sc.topic,
         sc.urgency,
         sc.brand_relevance,
         sc.original_post_url,
         sc.tweet_type,
         -- Post theme (from post-theme.ts classifier) joined from the parent TikTok post.
         tp.theme AS post_theme,
         sc.published_at,
         sc.scraped_at,
         sc.likes_count,
         sc.views_count,
         sc.retweets_count,
         sc.reply_count,
         sc.author_followers,
         -- XHS comments carry no cover/author of their own — pull from the parent note (xhs_posts).
         COALESCE(sc.cover_url,     xp.cover_url)     AS cover_url,
         COALESCE(sc.note_type,     xp.note_type)     AS note_type,
         COALESCE(sc.author_name,   xp.author_name)   AS author_name,
         COALESCE(sc.author_avatar, xp.author_avatar) AS author_avatar,
         CASE
           WHEN sc.platform = 'tiktok' AND sc.post_id IS NOT NULL AND b.tiktok_handle IS NOT NULL
             THEN 'https://www.tiktok.com/@' || b.tiktok_handle || '/video/' || sc.post_id
           WHEN sc.platform = 'instagram' AND sc.post_id IS NOT NULL
             THEN 'https://www.instagram.com/p/' || sc.post_id || '/'
           WHEN sc.platform = 'twitter' AND COALESCE(sc.external_id, sc.post_id) IS NOT NULL
             -- X accepts /i/status/{id} and redirects to the canonical
             -- /@user/status/{id} URL. Avoids storing screen_name separately.
             -- external_id is the TWEET'S OWN id; post_id is only equal to it
             -- for UGC search rows. Campaign replies/quotes (twitter-comments.ts)
             -- store the ANCHOR post's id in post_id and the reply/quote's own
             -- id in external_id — using post_id here would link every negative
             -- reply/quote to the wrong (anchor) tweet, breaking the manual-DM
             -- flow the Negative-attention queue exists for (CONTEXT.md).
             THEN 'https://x.com/i/status/' || COALESCE(sc.external_id, sc.post_id)
           WHEN sc.platform = 'xiaohongshu' AND sc.post_id IS NOT NULL
             THEN 'https://www.xiaohongshu.com/explore/' || sc.post_id
                  || CASE WHEN xp.xsec_token IS NOT NULL AND xp.xsec_token <> ''
                          THEN '?xsec_token=' || xp.xsec_token || '&xsec_source=pc_user' ELSE '' END
           ELSE NULL
         END AS post_url
       FROM social_comments sc
       JOIN brands b ON b.id = sc.brand_id
       -- A post can legitimately be saved once per brand it mentions (each brand's
       -- UGC search independently discovers it), so tiktok_posts/xhs_posts can hold
       -- multiple rows sharing the same post_id/note_id — one per brand_id. Matching
       -- brand_id here too (not just post_id) picks the one row that's actually this
       -- comment's brand, instead of fanning the comment out once per matching row.
       LEFT JOIN tiktok_posts tp ON sc.platform = 'tiktok' AND tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
       LEFT JOIN xhs_posts xp ON sc.platform = 'xiaohongshu' AND xp.note_id = sc.post_id AND xp.brand_id = sc.brand_id
       WHERE ($1::text[] IS NULL OR sc.sentiment = ANY($1))
         AND ($2::text[] IS NULL OR sc.platform   = ANY($2))
         AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)
         AND ($4::int    IS NULL OR COALESCE(sc.published_at, sc.scraped_at) >= NOW() - INTERVAL '1 day' * $4)
         AND ($7::text   IS NULL OR sc.topic      = $7)
         AND ($8::int    IS NULL OR sc.urgency    = $8)
         AND ($9::date   IS NULL OR COALESCE(sc.published_at, sc.scraped_at)::date = $9)
         AND ($10::date  IS NULL OR COALESCE(sc.published_at, sc.scraped_at) >= $10::date)
         AND ($11::date  IS NULL OR COALESCE(sc.published_at, sc.scraped_at) <  $11::date + INTERVAL '1 day')
         AND ($12::text  IS NULL OR sc.content ILIKE '%' || $12 || '%' OR sc.content_translated ILIKE '%' || $12 || '%' OR sc.author_name ILIKE '%' || $12 || '%')
         AND ${noiseExcludeSql('sc.content')}
         -- Matches /stats's filter (comments about a different brand mentioned in
         -- the same thread) — otherwise the feed shows comments the sentiment
         -- pill counts didn't include, with no explanation on screen.
         AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
       ORDER BY ${orderBy}
       LIMIT $5 OFFSET $6`,
      [sentimentList, platformList, brand ?? null, daysNum > 0 ? daysNum : null, limitNum, offset, topic ?? null, urgencyNum > 0 ? urgencyNum : null, dateFilter, fromFilter, toFilter, searchQ]
    );

    const countRows = await query<{ total: string }>(
      `SELECT COUNT(*) AS total
       FROM social_comments sc
       JOIN brands b ON b.id = sc.brand_id
       WHERE ($1::text[] IS NULL OR sc.sentiment = ANY($1))
         AND ($2::text[] IS NULL OR sc.platform   = ANY($2))
         AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)
         AND ($4::int    IS NULL OR COALESCE(sc.published_at, sc.scraped_at) >= NOW() - INTERVAL '1 day' * $4)
         AND ($5::text   IS NULL OR sc.topic      = $5)
         AND ($6::int    IS NULL OR sc.urgency    = $6)
         AND ($7::date   IS NULL OR COALESCE(sc.published_at, sc.scraped_at)::date = $7)
         AND ($8::date   IS NULL OR COALESCE(sc.published_at, sc.scraped_at) >= $8::date)
         AND ($9::date   IS NULL OR COALESCE(sc.published_at, sc.scraped_at) <  $9::date + INTERVAL '1 day')
         AND ($10::text  IS NULL OR sc.content ILIKE '%' || $10 || '%' OR sc.content_translated ILIKE '%' || $10 || '%' OR sc.author_name ILIKE '%' || $10 || '%')
         AND ${noiseExcludeSql('sc.content')}
         AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')`,
      [sentimentList, platformList, brand ?? null, daysNum > 0 ? daysNum : null, topic ?? null, urgencyNum > 0 ? urgencyNum : null, dateFilter, fromFilter, toFilter, searchQ]
    );

    res.json({
      data:  rows,
      page:  pageNum,
      limit: limitNum,
      total: parseInt(countRows[0]?.total ?? '0', 10),
    });
  } catch (err) {
    console.error('/api/social error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stats', async (req: Request, res: Response) => {
  const { days, platform, brand, sentiment, from, to } = req.query as Record<string, string>;
  const daysNum = days ? parseInt(days, 10) : 0;
  const platformList  = platform  ? platform.split(',').filter(Boolean)  : null;
  const sentimentList = sentiment ? sentiment.split(',').filter(Boolean) : null;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const fromFilter = from && DATE_RE.test(from) ? from : null;
  const toFilter   = to   && DATE_RE.test(to)   ? to   : null;

  // Shared filters ($1 days, $2 platform, $3 brand, $4 sentiment, $5/$6 from/to) —
  // applied across every stat query so the cards/charts honour the same filters as
  // the comments list. $4 is optional: omitted (default) it's a no-op, so the plain
  // call used for the page-wide KPI cards is unaffected; passing sentiment='negative'
  // scopes every query below to just negative comments (used by the Negative Queue
  // tab's side panel, so it reflects what's actually in that queue instead of the
  // whole-page pos/neu/neg mix). $5/$6 (custom range) are independent of $1 (days) —
  // the frontend only ever sends one of the two.
  const params = [
    daysNum > 0 ? daysNum : null,
    platformList,
    brand ?? null,
    sentimentList,
    fromFilter,
    toFilter,
  ];
  const filters = `
        AND ($1::int    IS NULL OR COALESCE(sc.published_at, sc.scraped_at) >= NOW() - INTERVAL '1 day' * $1)
        AND ($2::text[] IS NULL OR sc.platform = ANY($2))
        AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)
        AND ($4::text[] IS NULL OR sc.sentiment = ANY($4))
        AND ($5::date   IS NULL OR COALESCE(sc.published_at, sc.scraped_at) >= $5::date)
        AND ($6::date   IS NULL OR COALESCE(sc.published_at, sc.scraped_at) <  $6::date + INTERVAL '1 day')`;

  try {
    const [sentimentDist, topicDist, brandSentiment, totalRow, topicSentiment, urgencyDistribution] = await Promise.all([
      query<{ sentiment: string; count: string }>(`
        SELECT sc.sentiment, COUNT(*) AS count
        FROM social_comments sc
        JOIN brands b ON b.id = sc.brand_id
        WHERE sc.sentiment IS NOT NULL ${filters}
          AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
        GROUP BY sc.sentiment
        ORDER BY count DESC
      `, params),
      query<{ topic: string; count: string }>(`
        SELECT sc.topic, COUNT(*) AS count
        FROM social_comments sc
        JOIN brands b ON b.id = sc.brand_id
        WHERE sc.topic IS NOT NULL ${filters}
          AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
        GROUP BY sc.topic
        ORDER BY count DESC
        LIMIT 10
      `, params),
      query<{ brand_name: string; sentiment: string; count: string }>(`
        SELECT b.name AS brand_name, sc.sentiment, COUNT(*) AS count
        FROM social_comments sc
        JOIN brands b ON b.id = sc.brand_id
        WHERE sc.sentiment IS NOT NULL ${filters}
          AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
        GROUP BY b.name, sc.sentiment
        ORDER BY b.name, sc.sentiment
      `, params),
      query<{ total: string; last_scraped_at: string | null }>(`
        SELECT COUNT(*) AS total, MAX(sc.scraped_at) AS last_scraped_at
        FROM social_comments sc
        JOIN brands b ON b.id = sc.brand_id
        WHERE 1=1 ${filters}
      `, params),
      // Topic × sentiment matrix — executive "which aspects do people love/complain about".
      // One row per topic with pos/neg/neutral counts so the UI can flag negative-skewed topics.
      query<{ topic: string; positive: string; negative: string; neutral: string; total: string }>(`
        SELECT sc.topic,
               COUNT(*) FILTER (WHERE sc.sentiment = 'positive') AS positive,
               COUNT(*) FILTER (WHERE sc.sentiment = 'negative') AS negative,
               COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')  AS neutral,
               COUNT(*) FILTER (WHERE sc.sentiment IN ('positive','negative','neutral')) AS total
        FROM social_comments sc
        JOIN brands b ON b.id = sc.brand_id
        WHERE sc.topic IS NOT NULL AND sc.sentiment IS NOT NULL ${filters}
          AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
        GROUP BY sc.topic
        HAVING COUNT(*) FILTER (WHERE sc.sentiment IN ('positive','negative','neutral')) > 0
        ORDER BY total DESC
      `, params),
      // Urgency 1-5 breakdown — only meaningful for negative comments (urgency is
      // NULL otherwise). Feeds the Negative Queue tab's side panel.
      query<{ urgency: number; count: string }>(`
        SELECT sc.urgency, COUNT(*) AS count
        FROM social_comments sc
        JOIN brands b ON b.id = sc.brand_id
        WHERE sc.sentiment = 'negative' AND sc.urgency IS NOT NULL ${filters}
          AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
        GROUP BY sc.urgency
        ORDER BY sc.urgency
      `, params),
    ]);

    // Overall brand-image score: net sentiment = (pos − neg) / (pos + neg), −100..+100.
    const sMap = Object.fromEntries(sentimentDist.map((r) => [r.sentiment, parseInt(r.count, 10)]));
    const pos = sMap.positive ?? 0;
    const neg = sMap.negative ?? 0;
    const netSentiment = pos + neg > 0 ? Math.round(((pos - neg) / (pos + neg)) * 100) : 0;

    res.json({
      sentimentDistribution: sentimentDist,
      topicDistribution: topicDist,
      brandSentiment,
      topicSentiment,
      urgencyDistribution,
      netSentiment,
      totalComments: parseInt(totalRow[0]?.total ?? '0', 10),
      lastScrapedAt: totalRow[0]?.last_scraped_at ?? null,
    });
  } catch (err) {
    console.error('/api/social/stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Background analysis job ───────────────────────────────────────────────

let analysisRunning = false;

// Drains the full backlog through the real classifier (src/analysis/sentiment.ts
// — Gemini + fallback, urgency, non-TH/EN translation) instead of the old
// standalone validators/sentiment-pipeline.ts path, which duplicated it.
async function runAnalysis(): Promise<void> {
  try {
    let n = 0;
    do {
      n = await classifyUnanalyzedComments(200);
    } while (n > 0);
    console.log('[SocialAnalysis] Batch complete.');
  } finally {
    analysisRunning = false;
  }
}

// POST /api/social/analyze — trigger async sentiment analysis for NULL-sentiment rows
router.post('/analyze', async (_req: Request, res: Response) => {
  try {
    const pendingRows = await query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM social_comments WHERE sentiment IS NULL`
    );
    const pending = parseInt(pendingRows[0]?.total ?? '0', 10);

    if (analysisRunning) {
      res.json({ started: false, pending, message: 'Analysis already running' });
      return;
    }

    if (pending === 0) {
      res.json({ started: false, pending: 0, message: 'No comments to analyze' });
      return;
    }

    analysisRunning = true;
    // Fire and forget — no await
    runAnalysis().catch((err) => console.error('[SocialAnalysis] Uncaught error:', err));

    res.json({ started: true, pending });
  } catch (err) {
    console.error('/api/social/analyze error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/social/test-negative-spike-alert ────────────────────────────────
// Manual test fire (Settings → Alerts). Sends a real LINE message using current
// data (or a synthetic sample if there's none yet) — highest-negative-share
// brand + its Top 5, regardless of whether it crosses the threshold.
router.post('/test-negative-spike-alert', async (_req: Request, res: Response) => {
  try {
    const sent = await sendTestNegativeSpikeAlert();
    res.json({ sent, message: sent ? undefined : 'LINE not configured — set token/group ID in Settings or env vars.' });
  } catch (err) {
    console.error('/api/social/test-negative-spike-alert error:', err);
    res.status(500).json({ sent: false, message: 'Internal server error' });
  }
});

// ── PATCH /api/social/comments/:id/sentiment ─────────────────────────────────
// Manually override a comment's sentiment and/or topic (when AI gets it
// wrong). Sentiment is a real DB CHECK-constrained enum (schema-social.sql),
// so that list is fixed by design, not something to fetch. Topic is free-text
// assigned by the classifier — no fixed set exists, so the dropdown for it is
// populated from GET /topics (real distinct values), not hardcoded here either.
const VALID_SENTIMENTS = ['positive', 'negative', 'neutral', 'question', 'resale', null] as const;

router.patch('/comments/:id/sentiment', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { sentiment, topic } = req.body as { sentiment?: string | null; topic?: string | null };

  if (sentiment !== undefined && !VALID_SENTIMENTS.includes(sentiment as typeof VALID_SENTIMENTS[number])) {
    return void res.status(400).json({ error: 'Invalid sentiment. Use: positive, negative, neutral, question, resale, or null to reset' });
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (sentiment !== undefined) { sets.push(`sentiment = $${idx++}`); values.push(sentiment); }
  if (topic !== undefined) { sets.push(`topic = $${idx++}`); values.push(topic); }
  if (sets.length === 0) return void res.status(400).json({ error: 'sentiment and/or topic required' });

  try {
    const commentId = parseInt(id as string, 10);
    values.push(commentId);
    // Every other route in this file goes through the query/queryOne wrapper,
    // not the raw pool — matching that convention (still fully parameterized
    // either way, this was style-only).
    const rows = await query<{ id: number; sentiment: string | null; topic: string | null }>(
      `UPDATE social_comments SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, sentiment, topic`,
      values,
    );
    if (rows.length === 0) return void res.status(404).json({ error: 'Comment not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('/api/social/comments/:id/sentiment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/social/topics — every distinct topic currently in use ───────────
// Powers the manual topic-override dropdown — real values from the data, not
// a hardcoded list, since the classifier is free to assign any topic string.
router.get('/topics', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ topic: string }>(
      `SELECT DISTINCT topic FROM social_comments WHERE topic IS NOT NULL AND topic <> '' ORDER BY topic`,
    );
    res.json({ topics: rows.map((r) => r.topic) });
  } catch (err) {
    console.error('/api/social/topics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
