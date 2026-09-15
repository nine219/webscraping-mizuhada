import { Router, Request, Response } from 'express';
import { socialQuery as query, socialQueryOne as queryOne } from '../../db/social-client';
import { loadSettings, invalidateSettingsCache, DEFAULT_SETTINGS, AppSettings, getStoredOverride, deepMerge, DeepPartial } from '../../config/settings-loader';
import { reEvaluateAllSpikesQuiet } from '../../analysis/spike-detection';

const router = Router();

// GET /api/settings — current merged settings + defaults for reference
router.get('/', async (_req: Request, res: Response) => {
  try {
    const settings = await loadSettings(true);
    res.json({ settings, defaults: DEFAULT_SETTINGS });
  } catch (err) {
    console.error('/api/settings GET:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/settings — merge into the stored settings override
// Previously this overwrote the whole stored row with req.body, so a save
// from a form that only sends one section (e.g. { keywords: {...} }) would
// silently wipe out any other section's prior override (e.g. thresholds)
// back to defaults. Now merges onto the existing stored override instead.
router.put('/', async (req: Request, res: Response) => {
  const body = req.body as DeepPartial<AppSettings> | undefined;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body must be a settings object' });
    return;
  }
  try {
    const existing = await getStoredOverride();
    const merged = deepMerge(existing as unknown as AppSettings, body);
    await query(
      `INSERT INTO app_settings (id, settings, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    invalidateSettingsCache();
    const settings = await loadSettings(true);
    res.json({ ok: true, settings });

    // Thresholds affect spike_flag on existing rows too — re-apply immediately
    // rather than waiting for the next scrape's detectSpikes() call, so a
    // raised threshold actually clears stale spikes instead of leaving them
    // flagged forever (detectSpikes only ever added flags, never removed them).
    if (body.thresholds) {
      reEvaluateAllSpikesQuiet().catch((err) => console.error('[settings/thresholds] spike re-evaluation failed:', err));
    }
  } catch (err) {
    console.error('/api/settings PUT:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// POST /api/settings/reset — clear DB row, fall back to defaults
router.post('/reset', async (_req: Request, res: Response) => {
  try {
    await query(`UPDATE app_settings SET settings = '{}'::jsonb, updated_at = NOW() WHERE id = 1`);
    invalidateSettingsCache();
    res.json({ ok: true, settings: DEFAULT_SETTINGS });
  } catch (err) {
    console.error('/api/settings/reset:', err);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// ── Brand CRUD ────────────────────────────────────────────────────────────────

interface BrandRow {
  id: number;
  name: string;
  slug: string;
  type: 'own' | 'competitor';
  tiktok_handle: string | null;
  instagram_handle: string | null;
}

router.get('/brands', async (_req: Request, res: Response) => {
  try {
    const rows = await query<BrandRow>(
      `SELECT id, name, slug, type, tiktok_handle, instagram_handle
       FROM brands ORDER BY type DESC, name`
    );
    res.json(rows);
  } catch (err) {
    console.error('/api/settings/brands GET:', err);
    res.status(500).json({ error: 'Failed to list brands' });
  }
});

router.post('/brands', async (req: Request, res: Response) => {
  const { name, slug, type, tiktok_handle, instagram_handle } = req.body ?? {};
  if (!name || !slug || !['own', 'competitor'].includes(type)) {
    res.status(400).json({ error: 'name, slug, type (own|competitor) required' });
    return;
  }
  try {
    // Create-only: reject on slug OR case-insensitive name collision instead of
    // silently upserting (this endpoint has no edit UI today — every caller
    // means "add new"; a same-slug/name hit is a duplicate, not an edit).
    const dupe = await queryOne<{ slug: string; name: string }>(
      `SELECT slug, name FROM brands WHERE slug = $1 OR LOWER(name) = LOWER($2)`,
      [slug, name]
    );
    if (dupe) {
      res.status(409).json({ error: `Brand already exists: "${dupe.name}" (${dupe.slug})` });
      return;
    }
    const row = await queryOne<BrandRow>(
      `INSERT INTO brands (name, slug, type, tiktok_handle, instagram_handle)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, type, tiktok_handle, instagram_handle`,
      [name, slug, type, tiktok_handle ?? null, instagram_handle ?? null]
    );
    res.json(row);
  } catch (err) {
    console.error('/api/settings/brands POST:', err);
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

router.delete('/brands/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    await query(`DELETE FROM brands WHERE slug = $1`, [slug]);
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/settings/brands DELETE:', err);
    res.status(500).json({ error: 'Failed to delete brand (may have references)' });
  }
});

// ── Keyword CRUD (keyword_terms table — replaces the old whole-array
// jsonb overwrite for settings.keywords.{tiktok,tiktokCategory,xhs,twitter}) ──

const KEYWORD_PLATFORMS = ['tiktok', 'tiktok_category', 'twitter', 'xhs'];

router.post('/keywords', async (req: Request, res: Response) => {
  const { platform, brandSlug, keyword } = req.body ?? {};
  if (!KEYWORD_PLATFORMS.includes(platform) || typeof keyword !== 'string' || !keyword.trim()) {
    res.status(400).json({ error: `platform (${KEYWORD_PLATFORMS.join('|')}) and keyword required` });
    return;
  }
  try {
    let brandId: number | null = null;
    if (brandSlug) {
      const brand = await queryOne<{ id: number }>(`SELECT id FROM brands WHERE slug = $1`, [brandSlug]);
      if (!brand) {
        res.status(404).json({ error: `Unknown brand slug: ${brandSlug}` });
        return;
      }
      brandId = brand.id;
    }
    await query(
      `INSERT INTO keyword_terms (platform, brand_id, keyword)
       VALUES ($1, $2, $3)
       ON CONFLICT (platform, COALESCE(brand_id, 0), keyword) DO NOTHING`,
      [platform, brandId, keyword.trim()]
    );
    invalidateSettingsCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/settings/keywords POST:', err);
    res.status(500).json({ error: 'Failed to add keyword' });
  }
});

router.delete('/keywords', async (req: Request, res: Response) => {
  const { platform, brandSlug, keyword } = req.body ?? {};
  if (!KEYWORD_PLATFORMS.includes(platform) || typeof keyword !== 'string' || !keyword.trim()) {
    res.status(400).json({ error: `platform (${KEYWORD_PLATFORMS.join('|')}) and keyword required` });
    return;
  }
  try {
    let brandId: number | null = null;
    if (brandSlug) {
      const brand = await queryOne<{ id: number }>(`SELECT id FROM brands WHERE slug = $1`, [brandSlug]);
      brandId = brand?.id ?? null;
    }
    await query(
      `DELETE FROM keyword_terms WHERE platform = $1 AND COALESCE(brand_id, 0) = COALESCE($2, 0) AND keyword = $3`,
      [platform, brandId, keyword.trim()]
    );
    invalidateSettingsCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('/api/settings/keywords DELETE:', err);
    res.status(500).json({ error: 'Failed to remove keyword' });
  }
});

// ── CSV export ──────────────────────────────────────────────────────────────

function csvField(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Formula-injection guard: scraped comment/caption text flows in here
  // unsanitized, and a leading =/+/-/@ turns into a live formula when the
  // exported file is opened in Excel/Sheets (e.g. `=HYPERLINK(...)`).
  // Prefix with a single quote — Excel/Sheets both render that as a leading
  // apostrophe marking the cell as text, not a formula.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(','));
  }
  return lines.join('\r\n');
}

interface ExportRow {
  platform: string;
  brand: string;
  post_caption: string | null;
  post_url: string | null;
  post_views: string | null;
  post_likes: string | null;
  post_posted_at: string | null;
  comment_content: string | null;
  comment_content_translated: string | null;
  comment_sentiment: string | null;
  comment_topic: string | null;
  comment_urgency: number | null;
  comment_likes: string | null;
  comment_published_at: string | null;
  post_id: string | null;
  external_id: string | null;
}

// Comment-grain: one row per comment, with its parent post's own fields
// (caption/views/likes/url) repeated on every row — the standard flat-CSV shape
// for a 1-post-to-many-comments relationship (posts with zero comments still get
// one row, comment_* columns blank). Twitter has no separate post table (a tweet
// IS the post), so post_* columns are blank there — the tweet body/sentiment live
// in comment_* to keep every row's "content + sentiment" in the same columns.
async function fetchExportRows(start: string, end: string, brand?: string): Promise<ExportRow[]> {
  const params = [start, end, brand ?? null];

  const tiktok = query<ExportRow>(
    `SELECT 'tiktok' AS platform, b.name AS brand,
            tp.caption AS post_caption, tp.post_url AS post_url,
            tp.views::text AS post_views, tp.likes::text AS post_likes, tp.posted_at::text AS post_posted_at,
            sc.content AS comment_content, sc.content_translated AS comment_content_translated,
            sc.sentiment AS comment_sentiment, sc.topic AS comment_topic, sc.urgency AS comment_urgency,
            sc.likes_count::text AS comment_likes, sc.published_at::text AS comment_published_at,
            tp.post_id AS post_id, sc.external_id AS external_id
     FROM tiktok_posts tp
     JOIN brands b ON b.id = tp.brand_id
     LEFT JOIN social_comments sc ON sc.post_id = tp.post_id AND sc.platform = 'tiktok' AND sc.sentiment IS NOT NULL
     WHERE tp.posted_at >= $1::date AND tp.posted_at < ($2::date + INTERVAL '1 day')
       AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)`,
    params,
  );

  const instagram = query<ExportRow>(
    `SELECT 'instagram' AS platform, b.name AS brand,
            ip.caption AS post_caption, ip.post_url AS post_url,
            ip.views::text AS post_views, ip.likes::text AS post_likes, ip.posted_at::text AS post_posted_at,
            sc.content AS comment_content, sc.content_translated AS comment_content_translated,
            sc.sentiment AS comment_sentiment, sc.topic AS comment_topic, sc.urgency AS comment_urgency,
            sc.likes_count::text AS comment_likes, sc.published_at::text AS comment_published_at,
            ip.post_id AS post_id, sc.external_id AS external_id
     FROM instagram_posts ip
     JOIN brands b ON b.id = ip.brand_id
     LEFT JOIN social_comments sc ON sc.post_id = ip.post_id AND sc.platform = 'instagram' AND sc.sentiment IS NOT NULL
     WHERE ip.posted_at >= $1::date AND ip.posted_at < ($2::date + INTERVAL '1 day')
       AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)`,
    params,
  );

  const xhs = query<ExportRow>(
    `SELECT 'xiaohongshu' AS platform, b.name AS brand,
            xp.caption AS post_caption, xp.post_url AS post_url,
            NULL AS post_views, xp.likes_count::text AS post_likes, xp.published_at::text AS post_posted_at,
            sc.content AS comment_content, sc.content_translated AS comment_content_translated,
            sc.sentiment AS comment_sentiment, sc.topic AS comment_topic, sc.urgency AS comment_urgency,
            sc.likes_count::text AS comment_likes, sc.published_at::text AS comment_published_at,
            xp.note_id AS post_id, sc.external_id AS external_id
     FROM xhs_posts xp
     JOIN brands b ON b.id = xp.brand_id
     LEFT JOIN social_comments sc ON sc.post_id = xp.note_id AND sc.platform = 'xiaohongshu' AND sc.sentiment IS NOT NULL
     WHERE xp.published_at >= $1::date AND xp.published_at < ($2::date + INTERVAL '1 day')
       AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)`,
    params,
  );

  const twitter = query<ExportRow>(
    `SELECT 'twitter' AS platform, COALESCE(b.name, '') AS brand,
            NULL AS post_caption, NULL AS post_url,
            sc.views_count::text AS post_views, NULL AS post_likes, NULL AS post_posted_at,
            sc.content AS comment_content, sc.content_translated AS comment_content_translated,
            sc.sentiment AS comment_sentiment, sc.topic AS comment_topic, sc.urgency AS comment_urgency,
            sc.likes_count::text AS comment_likes, sc.published_at::text AS comment_published_at,
            sc.post_id AS post_id, sc.external_id AS external_id
     FROM social_comments sc
     LEFT JOIN brands b ON b.id = sc.brand_id
     WHERE sc.platform = 'twitter' AND sc.sentiment IS NOT NULL
       AND sc.published_at >= $1::date AND sc.published_at < ($2::date + INTERVAL '1 day')
       AND (($3::text IS NULL AND b.type = 'own') OR b.slug = $3)`,
    params,
  );

  const [t, i, x, tw] = await Promise.all([tiktok, instagram, xhs, twitter]);
  return [...t, ...i, ...x, ...tw].sort((a, b) => {
    const da = a.comment_published_at ?? a.post_posted_at ?? '';
    const db = b.comment_published_at ?? b.post_posted_at ?? '';
    return db.localeCompare(da);
  });
}

// GET /api/settings/export-csv?start=YYYY-MM-DD&end=YYYY-MM-DD — mentions/comments
// across all platforms for the date range (inclusive), already-analyzed only
// (sentiment IS NOT NULL — matches what the dashboard actually shows, not the
// raw unprocessed backlog). One row per comment, parent post's own fields
// repeated on each row (posts with zero comments still get one row). Replaces
// the old "email digest to Recipients" idea — self-serve CSV pull for whatever
// window the operator picks.
router.get('/export-csv', async (req: Request, res: Response) => {
  const start = typeof req.query.start === 'string' ? req.query.start : '';
  const end = typeof req.query.end === 'string' ? req.query.end : '';
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    res.status(400).json({ error: 'start=YYYY-MM-DD&end=YYYY-MM-DD required' });
    return;
  }
  if (start > end) {
    res.status(400).json({ error: 'start must be <= end' });
    return;
  }
  // Bound the span — auth (requireApiKey) now covers this route too, but a
  // pathological range (e.g. 2000-01-01..2030-01-01) still forces a full
  // unindexed scan across 4 joined tables buffered entirely in memory before
  // serialization. Data only has 1-month rolling retention anyway (CLAUDE.md),
  // so a year is already generous headroom.
  const MAX_SPAN_DAYS = 366;
  const spanDays = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
  if (spanDays > MAX_SPAN_DAYS) {
    res.status(400).json({ error: `Date range too large — max ${MAX_SPAN_DAYS} days` });
    return;
  }
  const brand = typeof req.query.brand === 'string' ? req.query.brand : undefined;
  try {
    const rows = await fetchExportRows(start, end, brand);
    const csv = toCsv(rows as unknown as Record<string, unknown>[], [
      'platform', 'brand', 'post_id',
      'post_caption', 'post_url', 'post_views', 'post_likes', 'post_posted_at',
      'comment_content', 'comment_content_translated', 'comment_sentiment', 'comment_topic',
      'comment_urgency', 'comment_likes', 'comment_published_at', 'external_id',
    ]);
    const filenameRange = start === end ? start : `${start}_to_${end}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="mentions-${filenameRange}.csv"`);
    // BOM so Excel opens UTF-8 (Thai/Chinese content) correctly instead of mangling it.
    res.send('﻿' + csv);
  } catch (err) {
    console.error('/api/settings/export-csv:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

export default router;
