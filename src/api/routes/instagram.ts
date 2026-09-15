import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { WhereBuilder } from '../../db/where-builder';
import { parseDateRange } from '../parse-date-range';
import { enqueueScrapeJob, hasPendingOrRunningJob } from './scrape';
import { createNotification } from '../../notifications/store';
import { readSessionStatus, getNovncUrl } from '../../config/platform-sessions';

const router = Router();

// ── Session status + login flow ─────────────────────────────────────────────
// `api` has no browser after the Docker split — /session reads the status
// scraper-instagram self-reports (platform_sessions table); /login enqueues
// a 'login' job for that container's queue worker — see
// scraper-runtime/queue-worker.ts's dispatchInstagram.

// ── GET /api/instagram/session ──────────────────────────────────────────────
router.get('/session', async (_req: Request, res: Response) => {
  try {
    res.json(await readSessionStatus('instagram'));
  } catch (err) {
    res.status(500).json({ valid: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /api/instagram/login ───────────────────────────────────────────────
router.post('/login', async (_req: Request, res: Response) => {
  try {
    if (await hasPendingOrRunningJob('instagram', 'login')) {
      res.json({ started: false, message: 'Login flow already running.' });
      return;
    }
    const job = await enqueueScrapeJob({ platform: 'instagram', jobType: 'login', message: 'Login flow starting…' });
    res.json({ started: true, jobId: job.id, message: 'Chrome window opening. Log in there.', novncUrl: getNovncUrl('instagram') });
  } catch (err) {
    console.error('[instagram/login]', err);
    res.status(500).json({ started: false, message: 'Failed to start login flow.' });
  }
});

// ── GET /api/instagram/posts ────────────────────────────────────────────────
router.get('/posts', async (req: Request, res: Response) => {
  const {
    page = '1', limit = '50', brand,
    sort = 'date', source_type, media,
  } = req.query as Record<string, string>;
  const range = parseDateRange(req.query as Record<string, string>, 30);

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const offset = (pageNum - 1) * limitNum;

  const SORT_MAP: Record<string, string> = {
    date:         'ig.posted_at DESC',
    brand:        'b.name ASC, ig.posted_at DESC',
    likes:        'ig.likes DESC',
    views:        'ig.views DESC NULLS LAST',
    comments:     'ig.comments_count DESC',
    // IG exposes no view counts → rank by raw interactions (likes + comments)
    engagement:   '(ig.likes + ig.comments_count) DESC',
    interactions: '(ig.likes + ig.comments_count) DESC',
  };
  const orderBy = SORT_MAP[sort] ?? SORT_MAP.date;

  const wb = new WhereBuilder();
  if (brand) {
    wb.add('b.slug = ?', brand);
  } else {
    // No brand filter = "All Brands" from the Feed UI, which only means
    // "all own brands" — competitor rows only ever surface via an explicit
    // ?brand= slug (competitors-tab.tsx auto-selects its first competitor on
    // load, same pattern as tiktok.ts's /posts route).
    wb.addRaw(`b.type = 'own'`);
  }
  if (source_type === 'feed' || source_type === 'search') wb.add('ig.source_type = ?', source_type);
  if (media === 'reel') wb.addRaw(`ig.media_type = 'reel'`);
  else if (media === 'post') wb.addRaw(`ig.media_type IN ('image', 'carousel')`);
  wb.dateRange('ig.posted_at', range);

  const where = wb.where;

  try {
    interface IgRow {
      id: number; post_id: string; media_url: string | null; post_url: string | null;
      caption: string | null; hashtags: string[] | null; mentions: string[] | null;
      media_type: string | null; views: string | null; likes: string; shares: string | null;
      comments_count: string; posted_at: string | null; engagement_rate: string | null;
      scraped_at: string;
      brand_name: string; brand_slug: string; source_type: string; author_handle: string | null;
    }
    interface StatsRow { total: string; total_views: string; avg_engagement: string | null; total_interactions: string; avg_interactions: string | null; last_scraped_at: string | null }

    const [dataRows, statsRows] = await Promise.all([
      query<IgRow>(
        `SELECT ig.id, ig.post_id, ig.media_url, ig.post_url, ig.caption, ig.hashtags, ig.mentions,
                ig.media_type, ig.views, ig.likes, ig.shares, ig.comments_count, ig.posted_at,
                ig.engagement_rate, ig.scraped_at,
                ig.source_type, ig.author_handle,
                b.name AS brand_name, b.slug AS brand_slug
         FROM instagram_posts ig JOIN brands b ON b.id = ig.brand_id
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT $${wb.nextIndex} OFFSET $${wb.nextIndex + 1}`,
        [...wb.values, limitNum, offset],
      ),
      query<StatsRow>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(ig.views), 0) AS total_views,
                AVG(ig.engagement_rate) AS avg_engagement,
                COALESCE(SUM(ig.likes + ig.comments_count), 0) AS total_interactions,
                AVG(ig.likes + ig.comments_count) AS avg_interactions,
                MAX(ig.scraped_at) AS last_scraped_at
         FROM instagram_posts ig JOIN brands b ON b.id = ig.brand_id
         WHERE ${where}`,
        wb.values,
      ),
    ]);

    const stats = statsRows[0];
    res.json({
      data: dataRows.map((r) => ({
        ...r,
        views:          r.views != null ? parseInt(r.views, 10) : null,
        likes:          parseInt(r.likes, 10) || 0,
        shares:         r.shares != null ? parseInt(r.shares, 10) : null,
        comments_count: parseInt(r.comments_count, 10) || 0,
      })),
      page: pageNum,
      limit: limitNum,
      total: parseInt(stats?.total ?? '0', 10),
      stats: {
        total_views:        parseInt(stats?.total_views ?? '0', 10),
        avg_engagement:     stats?.avg_engagement ? parseFloat(stats.avg_engagement) : 0,
        total_interactions: parseInt(stats?.total_interactions ?? '0', 10),
        avg_interactions:   stats?.avg_interactions ? Math.round(parseFloat(stats.avg_interactions)) : 0,
        last_scraped_at:    stats?.last_scraped_at ?? null,
      },
    });
  } catch (err) {
    console.error('[instagram/posts]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/instagram/posts/:postId ────────────────────────────────────────
router.get('/posts/:postId', async (req: Request, res: Response) => {
  const { postId } = req.params;
  const { sentiment } = req.query as { sentiment?: string };
  try {
    interface SentimentRow { sentiment: string | null; count: string }
    interface CommentRow { id: number; content: string; content_translated: string | null; sentiment: string | null; published_at: string | null; likes_count: number }

    const [postRows, sentimentRows, commentRows] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT ig.*, b.name AS brand_name, b.slug AS brand_slug
         FROM instagram_posts ig JOIN brands b ON b.id = ig.brand_id
         WHERE ig.post_id = $1 LIMIT 1`,
        [postId],
      ),
      query<SentimentRow>(
        `SELECT sentiment, COUNT(*) AS count
         FROM social_comments WHERE post_id = $1 AND platform = 'instagram'
           AND (brand_relevance IS NULL OR brand_relevance = 'on_topic')
         GROUP BY sentiment`,
        [postId],
      ),
      query<CommentRow>(
        `SELECT id, content, content_translated, sentiment, published_at, likes_count
         FROM social_comments WHERE post_id = $1 AND platform = 'instagram'
           AND ($2::text IS NULL OR sentiment = $2)
           -- Matches sentimentRows' filter above — otherwise the list shows
           -- comments the sentiment breakdown didn't count, with no explanation.
           AND (brand_relevance IS NULL OR brand_relevance = 'on_topic')
         ORDER BY likes_count DESC NULLS LAST LIMIT 50`,
        [postId, sentiment ?? null],
      ),
    ]);

    if (!postRows.length) return res.status(404).json({ error: 'Post not found' });

    const post = postRows[0];
    res.json({
      post: {
        ...post,
        views:          post.views != null ? parseInt(post.views as string, 10) : null,
        likes:          parseInt((post.likes as string) ?? '0', 10) || 0,
        comments_count: parseInt((post.comments_count as string) ?? '0', 10) || 0,
      },
      sentiments: sentimentRows.map((r) => ({ sentiment: r.sentiment ?? 'unanalyzed', count: parseInt(r.count, 10) })),
      comments:   commentRows,
    });
  } catch (err) {
    console.error('[instagram/posts/:postId]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/instagram/posts/:postId/scrape-comments ───────────────────────
router.post('/posts/:postId/scrape-comments', async (req: Request, res: Response) => {
  const postId = req.params.postId as string;
  try {
    const job = await enqueueScrapeJob({
      platform: 'instagram', brand: postId, jobType: 'comments',
      message: 'Queued Instagram comment scrape...', params: { postId },
    });
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[instagram/posts/:postId/scrape-comments]', err);
    res.status(500).json({ error: 'Failed to enqueue comment scrape' });
  }
});

// ── POST /api/instagram/scrape ──────────────────────────────────────────────
router.post('/scrape', async (req: Request, res: Response) => {
  const { brand } = req.body as { brand?: string };

  try {
    const job = await enqueueScrapeJob({
      platform: 'instagram', brand: brand ?? 'all', jobType: 'feed',
      message: 'Queued Instagram scrape...', params: { brand: brand || undefined },
    });
    createNotification({
      type: 'scrape_job', title: 'Instagram scrape started',
      body: brand ? `Manual IG scrape for ${brand}` : 'Manual IG scrape for all brands',
      payload: { jobId: job.id, platform: 'instagram' },
    }).catch(() => {});
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[instagram/scrape]', err);
    res.status(500).json({ error: 'Failed to enqueue Instagram scrape' });
  }
});

// Instagram UGC/hashtag search was removed (src/scrapers/instagram/instagram-search.ts) —
// unreliable via browser automation (tagged feed) and hashtag search too broad/noisy to
// find real UGC. IG coverage is feed-only now (own-brand accounts + their comments).

// ── POST /api/instagram/scrape/adhoc ────────────────────────────────────────
// Ad-hoc feed scrape for an arbitrary Instagram account (not one of the 3 own
// brands) — paste a profile link or bare handle, e.g. tracking a competitor.
// Mirrors POST /api/tiktok/scrape/adhoc exactly: posts attach to a competitor
// brand row (created if it doesn't exist yet), same find-or-create-by-slug
// upsert as /api/settings/brands.
// Instagram handles are themselves restricted to letters/digits/./_ (IG's own
// rule) — enforcing the same charset here rejects garbage before it reaches
// page.goto() or gets persisted as a permanent brands.instagram_handle row,
// instead of silently 404ing at scrape time and leaving junk in the DB.
const IG_HANDLE_RE = /^[a-zA-Z0-9._]{1,30}$/;

function parseInstagramHandle(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/instagram\.com\/([^/?#]+)/i);
  const raw = urlMatch ? urlMatch[1] : trimmed.replace(/^@/, '');
  const handle = raw.trim();
  return IG_HANDLE_RE.test(handle) ? handle : null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'brand';
}

router.post('/scrape/adhoc', async (req: Request, res: Response) => {
  const input = typeof req.body?.input === 'string' ? req.body.input : '';
  const brandNameInput = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : '';
  // Per-run overrides (Settings → Search "Feed Scrape" card) — 0 = all time.
  // Omitted → falls back to Settings → Thresholds "Feed max post age".
  const lookbackDays = typeof req.body?.lookbackDays === 'number' ? req.body.lookbackDays : undefined;
  const scrapeComments = req.body?.scrapeComments !== false;

  const handle = parseInstagramHandle(input);
  if (!handle) {
    res.status(400).json({ error: 'input (Instagram profile link or handle) is required' });
    return;
  }
  const brandName = brandNameInput || handle;
  const slug = slugify(brandName);

  try {
    const brandRow = await query<{ id: number; slug: string }>(
      `INSERT INTO brands (name, slug, type, instagram_handle)
       VALUES ($1, $2, 'competitor', $3)
       ON CONFLICT (slug) DO UPDATE SET instagram_handle = EXCLUDED.instagram_handle
       RETURNING id, slug`,
      [brandName, slug, handle],
    );
    const brandSlug = brandRow[0].slug;

    const job = await enqueueScrapeJob({
      platform: 'instagram', brand: brandSlug, jobType: 'adhoc-feed',
      message: `Queued ad-hoc feed scrape for @${handle}...`,
      params: { brandSlug, handle, lookbackDays, scrapeComments },
    });
    createNotification({
      type: 'scrape_job', title: 'Instagram ad-hoc feed scrape queued', body: `@${handle} (${brandName})`,
      payload: { jobId: job.id, platform: 'instagram', brandSlug },
    }).catch(() => {});

    res.json({ jobId: job.id, started: true, brandSlug, handle });
  } catch (err) {
    console.error('[instagram/scrape/adhoc]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
