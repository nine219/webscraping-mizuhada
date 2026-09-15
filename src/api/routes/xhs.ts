import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { WhereBuilder } from '../../db/where-builder';
import { parseDateRange } from '../parse-date-range';
import { enqueueScrapeJob, hasPendingOrRunningJob } from './scrape';
import { createNotification } from '../../notifications/store';
import { readSessionStatus } from '../../config/platform-sessions';

const router = Router();

const PLATFORM = 'xiaohongshu';

// ── Session status + login flow ─────────────────────────────────────────────
// `api` has no browser after the Docker split — /session reads the status
// the host's XHS scraper-entry self-reports (platform_sessions table);
// /login enqueues a 'login' job for its queue worker — see
// scraper-runtime/queue-worker.ts's dispatch(), 'xhs' case. XHS runs on the host (not a
// container — blocked by anti-bot there), but goes through the exact same
// queue mechanism as the other three.

// ── GET /api/xhs/session ─────────────────────────────────────────────────────
router.get('/session', async (_req: Request, res: Response) => {
  try {
    res.json(await readSessionStatus('xhs'));
  } catch (err) {
    res.status(500).json({ valid: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/xhs/login ──────────────────────────────────────────────────────
router.post('/login', async (_req: Request, res: Response) => {
  try {
    if (await hasPendingOrRunningJob('xhs', 'login')) {
      res.json({ started: false, message: 'Login flow already running.' });
      return;
    }
    const job = await enqueueScrapeJob({ platform: 'xhs', jobType: 'login', message: 'Login flow starting…' });
    res.json({ started: true, jobId: job.id, message: 'Chrome window opening. Log in there.' });
  } catch (err) {
    console.error('[xhs/login]', err);
    res.status(500).json({ started: false, message: 'Failed to start login flow.' });
  }
});

// ── GET /api/xhs/mentions ──────────────────────────────────────────────────
// Brand Monitor feed = NOTES (xhs_posts), the XHS analogue of the TikTok feed.
router.get('/mentions', async (req: Request, res: Response) => {
  const {
    page      = '1',
    limit     = '25',
    brand,
    sentiment,
    topic,
    keyword,
    author,
    searchKeyword,
    source,
    sort      = 'date',
  } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 30);

  const pageNum  = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const offset   = (pageNum - 1) * limitNum;

  const SORT_MAP: Record<string, string> = {
    date:   'COALESCE(xp.published_at, xp.scraped_at) DESC',
    oldest: 'COALESCE(xp.published_at, xp.scraped_at) ASC',
    likes:  'xp.likes_count DESC NULLS LAST',
  };
  const orderBy = SORT_MAP[sort] ?? SORT_MAP.date;

  const wb = new WhereBuilder();
  if (brand) {
    wb.add('b.slug = ?', brand);
  } else {
    // No brand filter = "All Brands" from the Feed/Search UI, which only
    // means "all own brands" — competitor rows only ever surface via an
    // explicit ?brand= slug (competitors-tab.tsx auto-selects its first
    // competitor on load, same pattern as tiktok.ts's /posts route).
    wb.addRaw(`b.type = 'own'`);
  }
  if (sentiment) wb.add('xp.sentiment = ?', sentiment);
  if (topic)     wb.add('xp.topic = ?', topic);
  if (keyword)   wb.add('xp.caption ILIKE ?', `%${keyword}%`);
  if (author)    wb.add(`COALESCE(xp.author_handle, xp.author_name, '') ILIKE ?`, `%${author}%`);
  // Exact match — mirrors the keyword-breakdown stat (GROUP BY search_keyword),
  // so clicking a keyword bar shows exactly that bar's note count.
  if (searchKeyword) wb.add('xp.search_keyword = ?', searchKeyword);
  if (source === 'profile' || source === 'search') wb.add('xp.source_type = ?', source);
  wb.dateRange('COALESCE(xp.published_at, xp.scraped_at)', range);

  const where = wb.where;

  try {
    interface MentionRow {
      id: number; note_id: string; caption: string; caption_translated: string | null;
      sentiment: string | null; topic: string | null; published_at: string | null; scraped_at: string;
      likes_count: string | null; cover_url: string | null; note_type: string | null;
      author_name: string | null; xsec_token: string | null; search_keyword: string | null;
      brand_name: string | null; brand_slug: string | null; comment_count: string;
    }
    interface CountRow { count: string }

    const [dataRows, countRows] = await Promise.all([
      query<MentionRow>(
        `SELECT xp.id, xp.note_id, xp.caption, xp.caption_translated,
                xp.sentiment, xp.topic, xp.published_at, xp.scraped_at,
                xp.likes_count, xp.cover_url, xp.note_type, xp.author_name, xp.xsec_token,
                xp.search_keyword,
                b.name AS brand_name, b.slug AS brand_slug,
                -- real total from XHS metadata; fall back to how many we've scraped
                COALESCE(xp.comments_count,
                         (SELECT COUNT(*) FROM social_comments sc
                           WHERE sc.platform = $${wb.nextIndex} AND sc.post_id = xp.note_id)) AS comment_count
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT $${wb.nextIndex + 1} OFFSET $${wb.nextIndex + 2}`,
        [...wb.values, PLATFORM, limitNum, offset],
      ),
      query<CountRow>(
        `SELECT COUNT(*) AS count
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE ${where}`,
        wb.values,
      ),
    ]);

    res.json({
      data: dataRows.map((r) => ({
        id:           r.id,
        note_id:      r.note_id,
        note_url:     `https://www.xiaohongshu.com/explore/${r.note_id}` +
                        (r.xsec_token ? `?xsec_token=${r.xsec_token}&xsec_source=pc_user` : ''),
        is_note:      true,
        content:      r.caption,
        content_translated: r.caption_translated,
        sentiment:    r.sentiment,
        topic:        r.topic,
        published_at: r.published_at,
        scraped_at:   r.scraped_at,
        likes_count:  r.likes_count ? parseInt(r.likes_count, 10) : null,
        cover_url:    r.cover_url,
        note_type:    r.note_type,
        author_name:  r.author_name,
        search_keyword: r.search_keyword,
        comment_count: parseInt(r.comment_count ?? '0', 10),
        brand_name:   r.brand_name,
        brand_slug:   r.brand_slug,
      })),
      page:  pageNum,
      limit: limitNum,
      total: parseInt(countRows[0]?.count ?? '0', 10),
    });
  } catch (err) {
    console.error('[xhs/mentions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/xhs/note/:noteId ──────────────────────────────────────────────
router.get('/note/:noteId', async (req: Request, res: Response) => {
  const { noteId } = req.params;
  const { sentiment } = req.query as { sentiment?: string };
  // 'unanalyzed' is a UI pseudo-label for NULL sentiment, not a real stored
  // value — needs its own IS NULL clause rather than an equality match.
  const sentimentFilter = sentiment === 'unanalyzed' ? null : sentiment ?? null;
  const filterUnanalyzed = sentiment === 'unanalyzed';
  try {
    interface NoteRow {
      id: number; caption: string; caption_translated: string | null;
      sentiment: string | null; sentiment_score: string | null; topic: string | null;
      published_at: string | null; scraped_at: string; likes_count: string | null;
      cover_url: string | null; note_type: string | null; author_name: string | null;
      author_avatar: string | null; xsec_token: string | null; source_type: string | null;
      brand_name: string | null; brand_slug: string | null;
    }
    interface SentimentRow { sentiment: string | null; count: string }
    interface CommentRow { id: number; content: string; content_translated: string | null; sentiment: string | null; published_at: string | null; likes_count: number }

    const [postRows, sentimentRows, commentRows] = await Promise.all([
      query<NoteRow>(
        `SELECT xp.id, xp.caption, xp.caption_translated, xp.sentiment, xp.sentiment_score,
                xp.topic, xp.published_at, xp.scraped_at, xp.likes_count, xp.cover_url, xp.note_type,
                xp.author_name, xp.author_avatar, xp.xsec_token, xp.source_type,
                b.name AS brand_name, b.slug AS brand_slug
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE xp.note_id = $1
         LIMIT 1`,
        [noteId],
      ),
      query<SentimentRow>(
        `SELECT sentiment, COUNT(*) AS count
         FROM social_comments
         WHERE platform = $1 AND post_id = $2
           AND (brand_relevance IS NULL OR brand_relevance = 'on_topic')
         GROUP BY sentiment`,
        [PLATFORM, noteId],
      ),
      query<CommentRow>(
        `SELECT id, content, content_translated, sentiment, published_at, likes_count
         FROM social_comments
         WHERE platform = $1 AND post_id = $2
           AND ($4::boolean IS NOT TRUE OR sentiment IS NULL)
           AND ($3::text IS NULL OR sentiment = $3)
           -- Matches sentimentRows' filter above — otherwise the list shows
           -- comments the sentiment breakdown didn't count, with no explanation.
           AND (brand_relevance IS NULL OR brand_relevance = 'on_topic')
         ORDER BY likes_count DESC NULLS LAST
         LIMIT 50`,
        [PLATFORM, noteId, sentimentFilter, filterUnanalyzed],
      ),
    ]);

    if (!postRows.length) return res.status(404).json({ error: 'Note not found' });

    const r = postRows[0];
    res.json({
      post: {
        id: r.id,
        note_id: noteId,
        note_url: `https://www.xiaohongshu.com/explore/${noteId}` +
          (r.xsec_token ? `?xsec_token=${r.xsec_token}&xsec_source=pc_user` : ''),
        content: r.caption,
        content_translated: r.caption_translated,
        sentiment: r.sentiment,
        sentiment_score: r.sentiment_score ? parseFloat(r.sentiment_score) : null,
        topic: r.topic,
        published_at: r.published_at,
        scraped_at: r.scraped_at,
        likes_count: r.likes_count ? parseInt(r.likes_count, 10) : null,
        cover_url: r.cover_url,
        note_type: r.note_type,
        author_name: r.author_name,
        author_avatar: r.author_avatar,
        source_type: r.source_type,
        brand_name: r.brand_name,
        brand_slug: r.brand_slug,
      },
      sentiments: sentimentRows.map((s) => ({ sentiment: s.sentiment ?? 'unanalyzed', count: parseInt(s.count, 10) })),
      comments: commentRows,
    });
  } catch (err) {
    console.error('[xhs/note]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/xhs/stats ─────────────────────────────────────────────────────
router.get('/stats', async (req: Request, res: Response) => {
  const { brand, source } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 30);

  // Note-scope filters apply to xhs_posts (xp). Comment queries join sc → xp on
  // post_id so they inherit the same brand/source/day scope as the notes.
  const wb = new WhereBuilder();
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  if (source === 'profile' || source === 'search') wb.add('xp.source_type = ?', source);
  wb.dateRange('COALESCE(xp.published_at, xp.scraped_at)', range);
  const noteWhere = wb.where;
  const params = wb.values;

  try {
    const [totalRows, sentimentRows, topicRows, brandRows, trendRows, keywordRows, authorRows] = await Promise.all([
      // notes from xhs_posts; mentions = comments on those notes
      query<{ notes: string; mentions: string; last_scraped_at: string | null }>(
        `SELECT COUNT(*) AS notes,
                (SELECT COUNT(*) FROM social_comments sc
                   JOIN xhs_posts xp2 ON xp2.note_id = sc.post_id
                   LEFT JOIN brands b ON b.id = xp2.brand_id
                  WHERE sc.platform = $${wb.nextIndex}
                    AND ${noteWhere.replace(/xp\./g, 'xp2.')}) AS mentions,
                MAX(xp.scraped_at) AS last_scraped_at
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE ${noteWhere}`,
        [...params, PLATFORM],
      ),
      // Joins on brand_id too, not just note_id — a note mentioning multiple own
      // brands gets one xhs_posts row per brand, and without the brand_id match
      // this would double-count a comment's sentiment once per brand mentioned.
      query<{ sentiment: string; count: string }>(
        `SELECT sc.sentiment, COUNT(*) AS count
         FROM social_comments sc
         JOIN xhs_posts xp ON xp.note_id = sc.post_id AND xp.brand_id = sc.brand_id
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE sc.platform = $${wb.nextIndex} AND sc.sentiment IS NOT NULL AND ${noteWhere}
           AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
         GROUP BY sc.sentiment`,
        [...params, PLATFORM],
      ),
      query<{ topic: string; count: string }>(
        `SELECT sc.topic, COUNT(*) AS count
         FROM social_comments sc
         JOIN xhs_posts xp ON xp.note_id = sc.post_id AND xp.brand_id = sc.brand_id
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE sc.platform = $${wb.nextIndex} AND sc.topic IS NOT NULL AND sc.topic <> '' AND ${noteWhere}
         GROUP BY sc.topic ORDER BY count DESC LIMIT 12`,
        [...params, PLATFORM],
      ),
      query<{ brand_slug: string; brand_name: string; count: string }>(
        `SELECT b.slug AS brand_slug, b.name AS brand_name, COUNT(*) AS count
         FROM xhs_posts xp
         JOIN brands b ON b.id = xp.brand_id
         WHERE ${noteWhere}
         GROUP BY b.slug, b.name ORDER BY count DESC`,
        params,
      ),
      query<{ date: string; count: string }>(
        `SELECT DATE(COALESCE(xp.published_at, xp.scraped_at)) AS date, COUNT(*) AS count
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE ${noteWhere}
         GROUP BY 1 ORDER BY 1 ASC`,
        params,
      ),
      // Keyword breakdown — over the full filtered set, not just the current
      // page, so clicking a bar filters to exactly that bar's note count.
      query<{ keyword: string; post_count: string; total_likes: string }>(
        `SELECT xp.search_keyword AS keyword, COUNT(*) AS post_count,
                COALESCE(SUM(xp.likes_count), 0) AS total_likes
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE ${noteWhere} AND xp.search_keyword IS NOT NULL AND xp.search_keyword <> ''
         GROUP BY xp.search_keyword ORDER BY post_count DESC LIMIT 20`,
        params,
      ),
      // Top authors — real aggregate over the full filtered set (not the
      // client-computed "current page only" approximation this used to be).
      query<{ handle: string; mention_count: string; total_likes: string }>(
        `SELECT COALESCE(NULLIF(xp.author_handle, ''), xp.author_name) AS handle,
                COUNT(*) AS mention_count, COALESCE(SUM(xp.likes_count), 0) AS total_likes
         FROM xhs_posts xp
         LEFT JOIN brands b ON b.id = xp.brand_id
         WHERE ${noteWhere} AND COALESCE(xp.author_handle, xp.author_name) IS NOT NULL
         GROUP BY COALESCE(NULLIF(xp.author_handle, ''), xp.author_name)
         ORDER BY mention_count DESC, total_likes DESC LIMIT 10`,
        params,
      ),
    ]);

    const sMap = Object.fromEntries(sentimentRows.map((r) => [r.sentiment, parseInt(r.count, 10)]));

    res.json({
      total_mentions: parseInt(totalRows[0]?.mentions ?? '0', 10),
      total_notes:    parseInt(totalRows[0]?.notes ?? '0', 10),
      last_scraped_at: totalRows[0]?.last_scraped_at ?? null,
      sentiment: {
        positive: sMap.positive ?? 0,
        negative: sMap.negative ?? 0,
        neutral:  sMap.neutral  ?? 0,
        question: sMap.question ?? 0,
        total:    (sMap.positive ?? 0) + (sMap.negative ?? 0) + (sMap.neutral ?? 0) + (sMap.question ?? 0),
      },
      topic_breakdown: topicRows.map((r) => ({ topic: r.topic, count: parseInt(r.count, 10) })),
      brand_breakdown: brandRows.map((r) => ({ brand_slug: r.brand_slug, brand_name: r.brand_name, count: parseInt(r.count, 10) })),
      daily_trend: trendRows.map((r) => ({ date: r.date, count: parseInt(r.count, 10) })),
      keyword_breakdown: keywordRows.map((r) => ({ keyword: r.keyword, post_count: parseInt(r.post_count, 10), total_likes: parseInt(r.total_likes, 10) })),
      top_authors: authorRows.map((r) => ({ handle: r.handle, mention_count: parseInt(r.mention_count, 10), total_likes: parseInt(r.total_likes, 10) })),
    });
  } catch (err) {
    console.error('[xhs/stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/xhs/run ──────────────────────────────────────────────────────
// Enqueues a job; the scraper-xhs container's queue worker claims + runs it
// (api has no browser after the Docker split). Dashboard polls status via
// /api/scrape/status/:jobId, which now falls back to the scrape_jobs row.
router.post('/run', async (_req: Request, res: Response) => {
  try {
    const job = await enqueueScrapeJob({
      platform: 'xhs', brand: 'all', jobType: 'feed',
      message: 'Queued Xiaohongshu feed scrape...',
    });
    createNotification({ type: 'scrape_job', title: 'Xiaohongshu scrape queued', body: 'Manual XHS feed scrape for all brands', payload: { jobId: job.id, platform: 'xhs' } }).catch(() => {});
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[xhs/run]', err);
    res.status(500).json({ error: 'Failed to enqueue XHS scrape' });
  }
});

// ── POST /api/xhs/search/run ───────────────────────────────────────────────
router.post('/search/run', (req: Request, res: Response) => {
  // Optional ad-hoc keyword — search XHS live for this term instead of the preset list.
  const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : '';
  // Optional recency filter — only collect notes published after this timestamp.
  const sinceMs = typeof req.body?.sinceMs === 'number' ? req.body.sinceMs : undefined;

  enqueueScrapeJob({
    platform: 'xhs', brand: 'all', jobType: 'search',
    message: keyword ? `Queued XHS search for "${keyword}"...` : 'Queued Xiaohongshu search...',
    params: { keyword: keyword || undefined, sinceMs },
  })
    .then((job) => {
      createNotification({ type: 'scrape_job', title: 'Xiaohongshu search queued', body: keyword ? `Ad-hoc XHS search: "${keyword}"` : 'XHS keyword search (preset list)', payload: { jobId: job.id, platform: 'xhs', keyword, sinceMs } }).catch(() => {});
      res.json({ jobId: job.id, started: true });
    })
    .catch((err) => {
      console.error('[xhs/search/run]', err);
      res.status(500).json({ error: 'Failed to enqueue XHS search' });
    });
});

// ── POST /api/xhs/scrape/adhoc ─────────────────────────────────────────────
// Ad-hoc feed scrape for an arbitrary XHS account (not one of the 2 own
// brands) — mirrors POST /api/tiktok/scrape/adhoc and /api/instagram/scrape/adhoc,
// but XHS has no @handle: own-brand accounts are keyed by the full
// xiaohongshu.com/user/profile/<id>?xsec_token=... URL (see XHS_ACCOUNTS in
// xhs-browser.ts), so `input` here must be that URL pasted whole. Not persisted
// on the brand row — brands has no xhs-equivalent of tiktok_handle/instagram_handle
// (XHS own-accounts were never DB-driven), so this profile URL is only used for
// this one scrape run.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'brand';
}

router.post('/scrape/adhoc', async (req: Request, res: Response) => {
  const input = typeof req.body?.input === 'string' ? req.body.input.trim() : '';
  const brandNameInput = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : '';
  // "Scrape comments" toggle (Settings → Search "Feed Scrape" card) — explicit
  // override of the XHS_SCRAPE_COMMENTS env var for this one run. lookbackDays
  // is intentionally not accepted here: XHS notes have no age-based cutoff.
  const scrapeComments = typeof req.body?.scrapeComments === 'boolean' ? req.body.scrapeComments : undefined;

  if (!input || !/xiaohongshu\.com\/user\/profile\//i.test(input)) {
    res.status(400).json({ error: 'input must be a full xiaohongshu.com/user/profile/<id> URL' });
    return;
  }

  const brandName = brandNameInput || 'XHS account';
  const slug = slugify(brandName === 'XHS account' ? `xhs-${Date.now()}` : brandName);

  try {
    const brandRow = await query<{ id: number; slug: string }>(
      `INSERT INTO brands (name, slug, type)
       VALUES ($1, $2, 'competitor')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug`,
      [brandName, slug],
    );
    const { id: brandId, slug: brandSlug } = brandRow[0];

    const job = await enqueueScrapeJob({
      platform: 'xhs', brand: brandSlug, jobType: 'adhoc-feed',
      message: 'Queued ad-hoc XHS feed scrape...',
      params: { brandId, brandSlug, input, scrapeComments },
    });
    createNotification({ type: 'scrape_job', title: 'Xiaohongshu ad-hoc feed scrape queued', body: brandName, payload: { jobId: job.id, platform: 'xhs', brandSlug } }).catch(() => {});

    res.json({ jobId: job.id, started: true, brandSlug });
  } catch (err) {
    console.error('[xhs/scrape/adhoc]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
