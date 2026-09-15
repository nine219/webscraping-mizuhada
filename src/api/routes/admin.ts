import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { socialQuery } from '../../db/social-client';
import { getAiSettings } from '../../config/settings-loader';
import { hasGeminiKey } from '../../analysis/gemini-client';
import { hasDeepSeekKey, activeProviderName } from '../../analysis/llm-client';
import { getAiUsageSummary, getRecentAiUsage, getAiUsageLogCount, getAiUsageTotals, getAiUsageByPurpose, getAiUsageByModel, getAiUsageDaily } from '../../analysis/ai-usage';
import { enqueueScrapeJob } from './scrape';
import { createNotification } from '../../notifications/store';

const router = Router();

// ── GET /api/admin/env — runtime config presence (no values, secrets stay secret) ──
// Replaces the old cron-jobs health table (schedule editing/enable-disable
// already lives in Settings → Schedules; this section was a stale duplicate
// read straight from the notification log). Env vars aren't editable from the
// dashboard at all — they're process-level, set before PM2/node starts — so
// this only reports presence and points at the file to hand-edit.
const ENV_VARS: { key: string; label: string; desc: string }[] = [
  { key: 'SOCIAL_DATABASE_URL', label: 'Social DB', desc: 'Port 5433 — all active social data (1-month rolling retention).' },
  { key: 'DATABASE_URL', label: 'Legacy main DB', desc: 'Port 5432 — used only by RAG/chat, not social listening.' },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key', desc: 'Sentiment/translation/theme/relevance classification + captcha vision.' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek key', desc: 'Text-completion fallback when Gemini is quota-exhausted.' },
  { key: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'LINE token', desc: 'Flex-message alerts (spike, urgent-negative, digests). Log-only if unset.' },
  { key: 'LINE_GROUP_ID', label: 'LINE group', desc: 'Target group for the LINE alerts above.' },
];

// Repo root is three levels up from src/api/routes/ — same place `npm run` /
// pm2 commands are invoked from, and where .env.local actually lives.
const ENV_FILE_PATH = path.resolve(__dirname, '..', '..', '..', '.env.local');

router.get('/env', (_req: Request, res: Response) => {
  const vars = ENV_VARS.map((v) => ({ ...v, present: !!process.env[v.key] && process.env[v.key] !== '' }));
  res.json({ vars, envFilePath: ENV_FILE_PATH });
});

// ── PUT /api/admin/env — write one var to .env.local ──────────────────────────
// Whitelist-only (ENV_VARS above) so this can never be used to inject an
// arbitrary env var or overwrite an unrelated line in the file. Values are
// accepted but never echoed back or logged — GET /env only ever reports
// presence. Editing here does NOT hot-reload other PM2 processes (dotenv only
// reads at startup) — pair with POST /restart-services or restart manually.
router.put('/env', (req: Request, res: Response) => {
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  const value = typeof req.body?.value === 'string' ? req.body.value : '';
  if (!ENV_VARS.some((v) => v.key === key)) {
    res.status(400).json({ error: 'Unknown or non-editable variable' });
    return;
  }
  if (!value.trim()) {
    res.status(400).json({ error: 'value is required — this endpoint sets a value, it does not clear one' });
    return;
  }
  // Whitelist covers the key, but the value is written as a raw KEY=value
  // line — a newline in it would let a caller inject a second, arbitrary env
  // var into the file (e.g. value = "x\nEVIL_VAR=1"). Reject rather than
  // strip, so this stays a clean write-what-you-see, not silent mangling.
  if (value.includes('\n') || value.includes('\r')) {
    res.status(400).json({ error: 'value cannot contain newlines' });
    return;
  }
  try {
    let content = '';
    try { content = fs.readFileSync(ENV_FILE_PATH, 'utf8'); } catch { /* file may not exist yet */ }
    const lines = content.length ? content.split('\n') : [];
    const linePattern = new RegExp(`^${key}=`);
    let found = false;
    const nextLines = lines.map((line) => {
      if (linePattern.test(line)) { found = true; return `${key}=${value}`; }
      return line;
    });
    if (!found) nextLines.push(`${key}=${value}`);
    fs.writeFileSync(ENV_FILE_PATH, nextLines.join('\n'));
    process.env[key] = value; // takes effect immediately in THIS (api) process only
    res.json({ ok: true, key });
  } catch (err) {
    console.error('/api/admin/env PUT: failed to write env file', err); // never log `value`
    res.status(500).json({ error: 'Failed to write .env.local' });
  }
});

// ── POST /api/admin/restart-services — apply .env.local changes everywhere ────
// Fixed command, zero user input reaches the shell — restarts the 3 processes
// that actually read these vars at startup (api restarts itself too, which is
// fine: the response is sent first, then the restart fires after a short delay).
router.post('/restart-services', (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Restarting api, scheduler, dashboard…' });
  setTimeout(() => {
    exec('pm2 restart api scheduler dashboard', (err) => {
      if (err) console.error('[admin/restart-services]', err);
    });
  }, 300);
});

const MULTI_SEARCH_PLATFORMS = ['tiktok', 'xhs', 'twitter'] as const;
type MultiSearchPlatform = typeof MULTI_SEARCH_PLATFORMS[number];

// ── POST /api/admin/multi-search ──────────────────────────────────────────────
// Ad-hoc single-keyword search fanned out across platforms in one call. Reuses
// each platform's existing ad-hoc-keyword path exactly as-is (same
// per-post own-brand attribution + relevance filtering the scheduled UGC
// search already does — this is NOT a free/unfiltered search, results still
// only get saved if they mention MizuMi/Gentle Colors/Bomi). Instagram is
// excluded: it has no ad-hoc keyword search, only a configured hashtag list.
router.post('/multi-search', async (req: Request, res: Response) => {
  const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : '';
  const brandSlug = typeof req.body?.brandSlug === 'string' ? req.body.brandSlug.trim() : '';
  const requested = Array.isArray(req.body?.platforms)
    ? (req.body.platforms as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const targets = requested.filter((p): p is MultiSearchPlatform =>
    (MULTI_SEARCH_PLATFORMS as readonly string[]).includes(p));

  if (!keyword) { res.status(400).json({ error: 'keyword is required' }); return; }
  if (!brandSlug) { res.status(400).json({ error: 'brandSlug is required' }); return; }
  if (targets.length === 0) {
    res.status(400).json({ error: `at least one platform required: ${MULTI_SEARCH_PLATFORMS.join(', ')}` });
    return;
  }

  // Any brand — own or competitor. TikTok force-attributes every result to
  // this exact brand (see below), so a competitor works the same as an own
  // brand there. XHS/Twitter still only auto-detect the 3 own brands
  // internally regardless of this pick (see their branches below).
  const brandRow = await socialQuery<{ slug: string; id: number; name: string; type: string }>(
    `SELECT slug, id, name, type FROM brands WHERE slug = $1`,
    [brandSlug],
  );
  if (brandRow.length === 0) { res.status(400).json({ error: `Unknown brand: ${brandSlug}` }); return; }
  const brand = brandRow[0];

  // Each platform's search logic now lives in its own scraper container's
  // queue worker (scraper-runtime/queue-worker.ts) — this just enqueues one
  // 'search' job per requested platform. TikTok gets `forceBrand` so the
  // worker attributes results to exactly the picked brand (own or
  // competitor) instead of auto-resolving across all own brands — same
  // content-verification-not-blind-attribution behavior as before (see
  // dispatchTikTok's 'search' case). XHS/Twitter still auto-attribute
  // internally; brand.slug isn't forwarded to them, same as previously.
  try {
    const jobs = await Promise.all(targets.map(async (platform) => {
      const params: Record<string, unknown> = { keyword };
      if (platform === 'tiktok') {
        params.forceBrand = { id: brand.id, slug: brand.slug, name: brand.name, type: brand.type };
      }
      const job = await enqueueScrapeJob({
        platform, brand: brand.slug, jobType: 'search',
        message: `Queued ${platform} search for "${keyword}"...`,
        params,
      });
      createNotification({
        type: 'scrape_job', title: `Multi-platform search: ${platform}`,
        body: `Ad-hoc "${keyword}" search on ${platform} (${brand.name})`,
        payload: { jobId: job.id, platform, keyword },
      }).catch(() => {});
      return { platform, jobId: job.id };
    }));
    res.json({ started: true, jobs });
  } catch (err) {
    console.error('[admin/multi-search]', err);
    res.status(500).json({ error: 'Failed to enqueue multi-search' });
  }
});

// ── GET /api/admin/status ─────────────────────────────────────────────────────
// Session tracking moved to Settings > Account Management (per-platform
// /session + /login routes on tiktok.ts, instagram.ts, xhs.ts, twitter.ts).
router.get('/status', async (_req: Request, res: Response) => {
  try {
    // Job runs are inferred from user_notifications rows we emit on each cron
    // tick start (see scheduler/cron.ts). One row per (job, started_at).
    type JobName = 'sentiment' | 'cleanup' | 'tiktok-feed' | 'feed-comments' | 'tiktok-search' | 'instagram' | 'morning-digest';
    const KNOWN_JOBS: { job: JobName; schedule: string; label: string }[] = [
      { job: 'sentiment',      schedule: 'every 2h',     label: 'Sentiment classification' },
      { job: 'tiktok-feed',    schedule: '01:15 BKK ×4', label: 'TikTok feed scrape'        },
      { job: 'feed-comments',  schedule: 'after feed',   label: 'Feed comment scrape'       },
      { job: 'tiktok-search',  schedule: 'every 4h',     label: 'TikTok UGC search'         },
      { job: 'instagram',      schedule: '03:30 BKK ×4', label: 'Instagram feed + comments' },
      { job: 'morning-digest', schedule: '07:00 BKK',    label: 'LINE morning digest'       },
      { job: 'cleanup',        schedule: '03:00 BKK',    label: 'Social DB cleanup'         },
    ];
    const rows = await socialQuery<{ job: string; last_run: string }>(
      `SELECT payload->>'job' AS job, MAX(created_at)::text AS last_run
       FROM user_notifications
       WHERE type = 'schedule' AND payload->>'job' IS NOT NULL
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY payload->>'job'`,
    );
    const lastRunByJob = new Map(rows.map((r) => [r.job, r.last_run]));
    const jobs = KNOWN_JOBS.map((k) => {
      const lastRun = lastRunByJob.get(k.job) ?? null;
      const ageHours = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 3_600_000 : null;
      // "Healthy" if seen within roughly 2× expected interval. Crude but readable.
      const status: 'ok' | 'stale' | 'never' =
        ageHours == null ? 'never' :
        ageHours <= 24 ? 'ok' : 'stale';
      return {
        job: k.job,
        label: k.label,
        schedule: k.schedule,
        last_run: lastRun,
        age_hours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
        status,
      };
    });

    const ai = await getAiSettings();
    const ai_provider = {
      provider: ai.provider,
      hasGeminiKey: hasGeminiKey(),
      hasDeepSeekKey: hasDeepSeekKey(),
      activeFallback: activeProviderName(), // llm-client's auto-selected OpenRouter/DeepSeek fallback
    };

    res.json({ jobs, ai_provider });
  } catch (err) {
    console.error('[admin/status]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/admin/ai-usage — cost-analysis dashboard data ────────────────────
router.get('/ai-usage', async (req: Request, res: Response) => {
  try {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    // days=0 is a real value (DateRangePicker's "All time" preset sends it
    // explicitly) — must not collapse to undefined the way `Number(x) || undefined` would.
    const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
    const from = typeof req.query.from === 'string' && DATE_RE.test(req.query.from) ? req.query.from : undefined;
    const to   = typeof req.query.to   === 'string' && DATE_RE.test(req.query.to)   ? req.query.to   : undefined;
    // Single-day drill-down from clicking a bar on the daily-cost chart — wins
    // over days/from/to for everything except the chart itself (see
    // getAiUsageDaily's doc comment: it always reflects the full range so the
    // chart doesn't collapse to one bar once a day is selected).
    const date = typeof req.query.date === 'string' && DATE_RE.test(req.query.date) ? req.query.date : undefined;
    // Default to 30 days when the caller passes nothing at all (first page
    // load) — an explicit days=0 or from/to="all time" request still means
    // "all time", so only fall back when NONE of the range params showed up.
    const noRangeGiven = days == null && from == null && to == null;
    const effDays = noRangeGiven ? 30 : days;
    const filter = { days: effDays, from, to, date };
    const chartFilter = { days: effDays, from, to };
    // Request-log-only filters — the table has action-type and success
    // columns but no way to filter by them, despite 50 pages of history.
    const purpose = typeof req.query.purpose === 'string' && req.query.purpose ? req.query.purpose : undefined;
    const failedOnly = req.query.failedOnly === 'true';
    const recentFilter = { ...filter, purpose, failedOnly };

    const recentLimit = 25;
    const recentPage = Math.max(1, Number(req.query.recentPage) || 1);
    const [summary, recent, recentTotal, totals, byPurpose, byModel, daily] = await Promise.all([
      getAiUsageSummary(filter),
      getRecentAiUsage(recentFilter, recentLimit, (recentPage - 1) * recentLimit),
      getAiUsageLogCount(recentFilter),
      getAiUsageTotals(filter),
      getAiUsageByPurpose(filter),
      getAiUsageByModel(filter),
      getAiUsageDaily(chartFilter),
    ]);
    res.json({
      tracked: true, summary, recent, totals, by_purpose: byPurpose, by_model: byModel, daily,
      recent_page: recentPage, recent_limit: recentLimit, recent_total: recentTotal,
      applied_filter: { days: days ?? null, from: from ?? null, to: to ?? null, date: date ?? null },
    });
  } catch (err) {
    console.error('[admin/ai-usage]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
