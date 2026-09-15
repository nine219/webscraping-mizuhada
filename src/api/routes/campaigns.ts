import { Router, Request, Response } from 'express';
import { socialQuery as query, socialQueryOne as queryOne } from '../../db/social-client';
import { WhereBuilder } from '../../db/where-builder';
import { syncCampaignStatuses } from '../../analysis/campaign-membership';
import { getCampaignReport } from '../../analysis/campaign-report';
import { enqueueScrapeJob } from './scrape';

const router = Router();

interface CampaignRow {
  id: number;
  brand_id: number;
  name: string;
  hashtags: string[];
  ambassador_handles: string[];
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  created_at: string;
}

function parseHandles(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((h) => String(h).trim()).filter((h) => h.length > 0);
}

function parseHashtags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((h) => String(h).trim()).filter((h) => h.length > 0);
}

// ── POST /api/campaigns ─────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const { name, hashtags, ambassador_handles, starts_at, ends_at } = req.body as {
    name?: string;
    hashtags?: unknown;
    ambassador_handles?: unknown;
    starts_at?: string;
    ends_at?: string;
  };

  if (!name || typeof name !== 'string' || !name.trim()) {
    return void res.status(400).json({ error: 'name is required' });
  }

  try {
    const brand = await queryOne<{ id: number }>(`SELECT id FROM brands WHERE slug = 'mizumi'`);
    if (!brand) return void res.status(500).json({ error: "brand 'mizumi' not found" });

    const row = await queryOne<CampaignRow>(
      `INSERT INTO campaigns (brand_id, name, hashtags, ambassador_handles, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING *`,
      [brand.id, name.trim(), parseHashtags(hashtags), parseHandles(ambassador_handles), starts_at ?? null, ends_at ?? null],
    );
    if (!row) return void res.status(500).json({ error: 'insert failed' });

    // Bring status current immediately (e.g. starts_at already in the past).
    // Membership is manual-only (Track by X link / add-by-id) — no
    // hashtag/ambassador auto-assignment here; hashtags[] still powers the
    // earned-reach (hashtag-UGC) count in the report, just not anchor-post
    // claiming.
    await syncCampaignStatuses();

    const fresh = await queryOne<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [row.id]);
    res.status(201).json({ campaign: fresh, assigned: 0 });
  } catch (err) {
    console.error('[campaigns POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/campaigns ──────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const { status } = req.query as Record<string, string>;
  const wb = new WhereBuilder();
  if (status) wb.add('c.status = ?', status);
  const where = wb.where;

  try {
    interface ListRow extends CampaignRow {
      post_count: string;
    }
    const rows = await query<ListRow>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM twitter_posts tp WHERE tp.campaign_id = c.id) AS post_count
       FROM campaigns c
       WHERE ${where}
       ORDER BY c.created_at DESC`,
      wb.values,
    );
    res.json({
      data: rows.map((r) => ({ ...r, post_count: parseInt(r.post_count, 10) || 0 })),
    });
  } catch (err) {
    console.error('[campaigns GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/campaigns/suggestions ─────────────────────────────────────────
// From MizuMi feed posts (source_type='feed') not yet claimed by any campaign:
// top hashtags by frequency (excluding ones already used by an existing
// campaign) + candidate ambassador handles harvested from @mentions in those
// posts' captions (excluding MizuMi's own handle). Suggest-then-verify per
// scope decision 4 — nothing here is auto-applied.
router.get('/suggestions', async (_req: Request, res: Response) => {
  try {
    const brand = await queryOne<{ id: number; twitter_handle: string | null }>(
      `SELECT id, twitter_handle FROM brands WHERE slug = 'mizumi'`,
    );
    if (!brand) return void res.status(500).json({ error: "brand 'mizumi' not found" });

    const ownHandle = (brand.twitter_handle ?? '').toLowerCase().replace(/^@/, '');

    const [hashtagRows, captionRows, usedHashtagRows] = await Promise.all([
      query<{ hashtag: string; count: string }>(
        `SELECT lower(regexp_replace(h, '^#', '')) AS hashtag, COUNT(*) AS count
         FROM twitter_posts tp
         CROSS JOIN LATERAL unnest(tp.hashtags) AS h
         WHERE tp.brand_id = $1 AND tp.source_type = 'feed' AND tp.campaign_id IS NULL
         GROUP BY 1
         ORDER BY count DESC
         LIMIT 20`,
        [brand.id],
      ),
      query<{ caption: string }>(
        `SELECT caption FROM twitter_posts
         WHERE brand_id = $1 AND source_type = 'feed' AND campaign_id IS NULL AND caption IS NOT NULL`,
        [brand.id],
      ),
      query<{ hashtag: string }>(
        `SELECT DISTINCT lower(regexp_replace(unnest(hashtags), '^#', '')) AS hashtag FROM campaigns`,
      ),
    ]);

    const usedHashtags = new Set(usedHashtagRows.map((r) => r.hashtag));
    const suggestedHashtags = hashtagRows
      .filter((r) => !usedHashtags.has(r.hashtag))
      .map((r) => ({ hashtag: r.hashtag, count: parseInt(r.count, 10) }));

    const mentionCounts = new Map<string, number>();
    const mentionRe = /@(\w+)/g;
    for (const { caption } of captionRows) {
      for (const m of caption.matchAll(mentionRe)) {
        const handle = m[1].toLowerCase();
        if (handle === ownHandle) continue;
        mentionCounts.set(handle, (mentionCounts.get(handle) ?? 0) + 1);
      }
    }
    const suggestedAmbassadors = [...mentionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([handle, count]) => ({ handle, count }));

    res.json({ hashtags: suggestedHashtags, ambassador_handles: suggestedAmbassadors });
  } catch (err) {
    console.error('[campaigns/suggestions]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/campaigns/:id ──────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });

  try {
    const campaign = await queryOne<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    if (!campaign) return void res.status(404).json({ error: 'Campaign not found' });

    interface CountsRow {
      anchor_posts: string;
      replies: string;
      quotes: string;
    }
    const counts = await queryOne<CountsRow>(
      `SELECT
         (SELECT COUNT(*) FROM twitter_posts tp WHERE tp.campaign_id = $1) AS anchor_posts,
         (SELECT COUNT(*) FROM social_comments sc
            JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
            WHERE tp.campaign_id = $1 AND sc.platform = 'twitter' AND sc.is_reply = true) AS replies,
         (SELECT COUNT(*) FROM social_comments sc
            JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
            WHERE tp.campaign_id = $1 AND sc.platform = 'twitter' AND sc.is_reply = false) AS quotes`,
      [id],
    );

    res.json({
      campaign,
      counts: {
        anchor_posts: parseInt(counts?.anchor_posts ?? '0', 10),
        replies: parseInt(counts?.replies ?? '0', 10),
        quotes: parseInt(counts?.quotes ?? '0', 10),
      },
    });
  } catch (err) {
    console.error('[campaigns/:id GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/campaigns/:id/report ───────────────────────────────────────────
// Frozen wrap-up report (scope decision 5, CONTEXT.md "Campaign report").
// Computed on-demand from stored rows — see analysis/campaign-report.ts for
// the aggregation logic (single source of truth, also used by the CLI:
// npm run report:campaign -- <campaignId>).
router.get('/:id/report', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });

  try {
    const report = await getCampaignReport(id);
    if (!report) return void res.status(404).json({ error: 'Campaign not found' });
    res.json(report);
  } catch (err) {
    console.error('[campaigns/:id/report GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/campaigns/:id/scrape-now ──────────────────────────────────────
// Manual trigger: scrape replies + quote tweets for every post already
// claimed by this campaign, right now — instead of waiting for the next 6h
// cron tick (which also skips posts whose (replies+quotes) haven't grown
// since their last scrape). Forces the quote-tweet check regardless of the
// post's cached quotes_count, since that number comes from X's own feed-API
// metadata and can lag — see twitter-comments.ts forceQuotes.
router.post('/:id/scrape-now', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });

  const campaign = await queryOne<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  if (!campaign) return void res.status(404).json({ error: 'Campaign not found' });

  try {
    const job = await enqueueScrapeJob({
      platform: 'twitter', brand: 'mizumi', jobType: 'campaign-comments',
      message: `Queued replies/quotes scrape for "${campaign.name}"…`,
      params: { campaignId: id },
    });
    res.json({ jobId: job.id });
  } catch (err) {
    console.error('[campaigns/:id/scrape-now]', err);
    res.status(500).json({ error: 'Failed to enqueue campaign scrape' });
  }
});

// ── POST /api/campaigns/:id/track-link ──────────────────────────────────────
// Manual "paste an X link" flow — more accurate than hashtag auto-detection
// when the user already knows exactly which post(s) belong to the campaign.
// The live Playwright fetch (confirms the tweet is real, catches typos/
// deleted tweets), upsert+lock, and reply/quote scrape all now run in the
// scraper-twitter container's queue worker (job_type 'track-link' —
// dispatchTwitter in scraper-runtime/queue-worker.ts) since `api` has no
// browser after the Docker split. This route only does the cheap, sync-safe
// checks (campaign exists, URL actually parses) before enqueueing, so a bad
// paste still 400s instantly instead of round-tripping through the queue.
router.post('/:id/track-link', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });
  const { url } = req.body as { url?: string };
  if (!url) return void res.status(400).json({ error: 'url is required' });

  const campaign = await queryOne<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  if (!campaign) return void res.status(404).json({ error: 'Campaign not found' });

  const { parseTweetUrl } = await import('../../scrapers/twitter/twitter-feed');
  const parsed = parseTweetUrl(url);
  if (!parsed) return void res.status(400).json({ error: 'Not a valid x.com/<handle>/status/<id> link' });

  try {
    const job = await enqueueScrapeJob({
      platform: 'twitter', brand: 'mizumi', jobType: 'track-link',
      message: `Verifying ${url}…`,
      params: { campaignId: id, handle: parsed.handle, postId: parsed.postId },
    });
    res.json({ jobId: job.id });
  } catch (err) {
    console.error('[campaigns/:id/track-link POST]', err);
    res.status(500).json({ error: 'Failed to enqueue track-link job' });
  }
});

// ── POST /api/campaigns/:id/search-x ────────────────────────────────────────
// Live X-wide search, ANY author — the thing rejected earlier this session
// for pulling in unrelated third-party noise (a bare "#pondphuwin" search
// returns fan content having nothing to do with MizuMi). Revisited with a
// tighter query: each search is TWO hashtags together ("#mizumi
// #<campaignHashtag>"), which X treats as an AND (space-separated terms) —
// a post has to carry the brand hashtag *and* the campaign hashtag to match,
// which cuts out the generic fan noise the single-hashtag version had.
// Still candidate-review-only: nothing is saved here, "Track" goes through
// the same live-verify+lock+scrape path as pasting a link directly
// (POST /:id/track-link), since these are unverified live results, not
// already-scraped local rows like search-hashtags' candidates are.
//
// The live Playwright search itself moved to the scraper-twitter queue
// worker (job_type 'search-x') for the same api-has-no-browser reason as
// track-link above — this route just validates + enqueues and returns the
// jobId; candidates come back via GET /api/scrape/status/:jobId's `result`
// field once the job is done.
router.post('/:id/search-x', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });

  const campaign = await queryOne<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  if (!campaign) return void res.status(404).json({ error: 'Campaign not found' });
  if (!campaign.hashtags || campaign.hashtags.length === 0) {
    return void res.status(400).json({ error: 'Campaign has no hashtags to search' });
  }

  try {
    const job = await enqueueScrapeJob({
      platform: 'twitter', brand: 'mizumi', jobType: 'search-x',
      message: `Searching X for campaign "${campaign.name}"…`,
      params: { campaignId: id },
    });
    res.json({ jobId: job.id });
  } catch (err) {
    console.error('[campaigns/:id/search-x POST]', err);
    res.status(500).json({ error: 'Failed to enqueue X search' });
  }
});

// ── PATCH /api/campaigns/:id ────────────────────────────────────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });

  const { name, hashtags, ambassador_handles, starts_at, ends_at, status } = req.body as {
    name?: string;
    hashtags?: unknown;
    ambassador_handles?: unknown;
    starts_at?: string | null;
    ends_at?: string | null;
    status?: string;
  };

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (name !== undefined) { sets.push(`name = $${idx++}`); values.push(name); }
  if (hashtags !== undefined) { sets.push(`hashtags = $${idx++}`); values.push(parseHashtags(hashtags)); }
  if (ambassador_handles !== undefined) { sets.push(`ambassador_handles = $${idx++}`); values.push(parseHandles(ambassador_handles)); }
  if (starts_at !== undefined) { sets.push(`starts_at = $${idx++}`); values.push(starts_at); }
  if (ends_at !== undefined) { sets.push(`ends_at = $${idx++}`); values.push(ends_at); }
  if (status !== undefined) {
    if (!['draft', 'active', 'ended'].includes(status)) {
      return void res.status(400).json({ error: "status must be one of draft|active|ended" });
    }
    sets.push(`status = $${idx++}`); values.push(status);
  }

  if (sets.length === 0) return void res.status(400).json({ error: 'No fields to update' });

  try {
    values.push(id);
    const row = await queryOne<CampaignRow>(
      `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (!row) return void res.status(404).json({ error: 'Campaign not found' });

    // Membership is manual-only — editing hashtags/window no longer
    // auto-claims posts, see POST / for why.
    const fresh = await queryOne<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    res.json({ campaign: fresh, assigned: 0 });
  } catch (err) {
    console.error('[campaigns/:id PATCH]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/campaigns/:id/posts ───────────────────────────────────────────
// Manual add: pins a twitter_posts row into the campaign and locks it so
// auto-assignment never re-evaluates it.
router.post('/:id/posts', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });
  const { post_id } = req.body as { post_id?: string };
  if (!post_id) return void res.status(400).json({ error: 'post_id is required' });

  try {
    const campaign = await queryOne<{ id: number }>(`SELECT id FROM campaigns WHERE id = $1`, [id]);
    if (!campaign) return void res.status(404).json({ error: 'Campaign not found' });

    const row = await queryOne<{ id: number }>(
      `UPDATE twitter_posts
       SET campaign_id = $1, campaign_locked = true
       WHERE post_id = $2
       RETURNING id`,
      [id, post_id],
    );
    if (!row) return void res.status(404).json({ error: 'Post not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[campaigns/:id/posts POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/campaigns/:id/posts/:postId ─────────────────────────────────
// Manual remove: clears campaign_id and locks the row so auto-assignment
// won't re-add it on the next sync tick.
router.delete('/:id/posts/:postId', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });
  const { postId } = req.params;

  try {
    const row = await queryOne<{ id: number }>(
      `UPDATE twitter_posts
       SET campaign_id = NULL, campaign_locked = true
       WHERE post_id = $1 AND campaign_id = $2
       RETURNING id`,
      [postId, id],
    );
    if (!row) return void res.status(404).json({ error: 'Post not found in this campaign' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[campaigns/:id/posts/:postId DELETE]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/campaigns/:id ───────────────────────────────────────────────
// Deletes the campaign row only. twitter_posts.campaign_id has ON DELETE SET
// NULL (schema-social.sql) — anchor posts and their scraped replies/quotes
// stay in the DB, just unassigned from the campaign, same as manually
// removing every post first (DELETE /:id/posts/:postId) but in one step.
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) return void res.status(400).json({ error: 'Invalid id' });

  try {
    const row = await queryOne<{ id: number }>(`DELETE FROM campaigns WHERE id = $1 RETURNING id`, [id]);
    if (!row) return void res.status(404).json({ error: 'Campaign not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[campaigns/:id DELETE]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
