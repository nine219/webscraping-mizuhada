import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { enqueueScrapeJob } from './scrape';
import { createNotification } from '../../notifications/store';

const router = Router();

// ── POST /api/tiktok/search/run ───────────────────────────────────────────
router.post('/search/run', async (req: Request, res: Response) => {
  const { brand } = req.body as { brand?: string };
  // Optional ad-hoc keyword — search TikTok live for this term instead of a
  // brand's preset list. Resolution (which own brand a result mentions) now
  // happens in the scraper-tiktok container's queue worker — see
  // scraper-runtime/queue-worker.ts dispatchTikTok, job_type 'search'.
  const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : '';

  try {
    const job = await enqueueScrapeJob({
      platform: 'tiktok',
      brand: keyword ? 'all' : (brand ?? 'all'),
      jobType: 'search',
      message: keyword ? `Queued TikTok search for "${keyword}"...` : 'Queued TikTok search...',
      params: { keyword: keyword || undefined, brand: brand || undefined },
    });
    createNotification({
      type: 'scrape_job',
      title: 'TikTok search scrape queued',
      body: keyword ? `Ad-hoc TikTok search: "${keyword}"` : (brand ? `Manual search scrape for ${brand}` : 'Manual search scrape for all brands'),
      payload: { jobId: job.id, platform: 'tiktok', brand: brand ?? 'all', keyword },
    }).catch(() => {});
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[tiktok/search/run]', err);
    res.status(500).json({ error: 'Failed to enqueue TikTok search' });
  }
});

// ── POST /api/tiktok/posts/:postId/scrape-comments ───────────────────────────
router.post('/posts/:postId/scrape-comments', async (req: Request, res: Response) => {
  const postId = req.params.postId as string;
  try {
    const job = await enqueueScrapeJob({
      platform: 'tiktok', brand: postId, jobType: 'comments',
      message: 'Queued comment scrape...', params: { postId },
    });
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[tiktok/posts/:postId/scrape-comments]', err);
    res.status(500).json({ error: 'Failed to enqueue comment scrape' });
  }
});

// ── POST /api/tiktok/scrape ────────────────────────────────────────────────
router.post('/scrape', async (req: Request, res: Response) => {
  const { brand } = req.body as { brand?: string };

  try {
    const job = await enqueueScrapeJob({
      platform: 'tiktok', brand: brand ?? 'all', jobType: 'feed',
      message: 'Queued TikTok feed scrape...', params: { brand: brand || undefined },
    });
    createNotification({
      type: 'scrape_job', title: 'TikTok feed scrape started',
      body: brand ? `Manual feed scrape for ${brand}` : 'Manual feed scrape for all brands',
      payload: { jobId: job.id, platform: 'tiktok' },
    }).catch(() => {});
    res.json({ jobId: job.id, started: true });
  } catch (err) {
    console.error('[tiktok/scrape]', err);
    res.status(500).json({ error: 'Failed to enqueue TikTok feed scrape' });
  }
});

// ── POST /api/tiktok/scrape/adhoc ─────────────────────────────────────────
// Ad-hoc feed scrape for an arbitrary TikTok account (not one of the 3 own
// brands) — paste a profile link or bare handle, e.g. tracking a competitor.
// Posts are attached to a competitor brand row (created if it doesn't exist
// yet), reusing the same find-or-create-by-slug upsert as /api/settings/brands.
function parseTikTokHandle(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/tiktok\.com\/@([^/?#]+)/i);
  const raw = urlMatch ? urlMatch[1] : trimmed.replace(/^@/, '');
  const handle = raw.trim();
  return handle || null;
}

// Returns null (not a static 'brand' fallback) when the input has no
// [a-z0-9] characters at all — e.g. a Thai-only competitor name. The old
// static 'brand' fallback meant two different Thai-named competitors both
// slugified to the literal string 'brand', and ON CONFLICT (slug) DO UPDATE
// silently merged the second one's tiktok_handle onto the first's brand
// row. Callers chain fallbacks (name -> handle -> unique) instead.
function slugify(name: string): string | null {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || null;
}

router.post('/scrape/adhoc', async (req: Request, res: Response) => {
  const input = typeof req.body?.input === 'string' ? req.body.input : '';
  const brandNameInput = typeof req.body?.brandName === 'string' ? req.body.brandName.trim() : '';
  // Per-run overrides (Settings → Search "Feed Scrape" card) — 0 = all time.
  // Omitted → falls back to Settings → Thresholds "Feed max post age".
  const lookbackDays = typeof req.body?.lookbackDays === 'number' ? req.body.lookbackDays : undefined;
  const scrapeComments = req.body?.scrapeComments !== false;

  const handle = parseTikTokHandle(input);
  if (!handle) {
    res.status(400).json({ error: 'input (TikTok profile link or handle) is required' });
    return;
  }
  const brandName = brandNameInput || handle;
  // Fallback chain: slug the display name, then the handle, then a unique
  // suffix — never collapse two different unslugifiable names onto the same
  // static slug (see slugify()'s comment).
  const slug = slugify(brandName) ?? slugify(handle) ?? `brand-${Date.now().toString(36)}`;

  try {
    const brandRow = await query<{ id: number; slug: string }>(
      `INSERT INTO brands (name, slug, type, tiktok_handle)
       VALUES ($1, $2, 'competitor', $3)
       ON CONFLICT (slug) DO UPDATE SET tiktok_handle = EXCLUDED.tiktok_handle
       RETURNING id, slug`,
      [brandName, slug, handle],
    );
    const brandSlug = brandRow[0].slug;

    const job = await enqueueScrapeJob({
      platform: 'tiktok', brand: brandSlug, jobType: 'adhoc-feed',
      message: `Queued ad-hoc feed scrape for @${handle}...`,
      params: { brandSlug, handle, lookbackDays, scrapeComments },
    });
    createNotification({
      type: 'scrape_job', title: 'TikTok ad-hoc feed scrape queued', body: `@${handle} (${brandName})`,
      payload: { jobId: job.id, platform: 'tiktok', brandSlug },
    }).catch(() => {});

    res.json({ jobId: job.id, started: true, brandSlug, handle });
  } catch (err) {
    console.error('[tiktok/scrape/adhoc]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
