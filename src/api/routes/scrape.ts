import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createNotification } from '../../notifications/store';

// 'pending' only ever comes from a scrape_jobs row that a scraper container
// hasn't claimed yet; in-process Map jobs start at 'running'.
export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  brand: string;
  platform: string;
  status: JobStatus;
  message: string;
  count: number;
  startedAt: string;
  finishedAt?: string;
  cancelRequested?: boolean;
  /** Payload for job_types the caller needs data back from (e.g. 'track-link', 'search-x'). Only ever set on enqueued (DB) jobs — the queue worker writes it. */
  result?: unknown;
}

export const jobs = new Map<string, Job>();
// GET /jobs only ever displays the most recent 30, but the Map itself was
// never pruned — on a long-lived process with frequent manual scrape
// triggers this grew unbounded. Cap finished jobs, oldest-first; running
// jobs are never pruned regardless of count.
const MAX_FINISHED_JOBS = 100;

// ── Durable mirror to social-db `scrape_jobs` (Docker split, Phase 0) ─────────
// The in-memory Map above is still the authoritative live object for jobs that
// run IN this process (today: every manual trigger runs Chrome inside `api`).
// We additionally write-through each job's lifecycle to `scrape_jobs` so its
// status is durable and visible from other containers — the seam the
// per-platform scraper containers will read/write once execution moves out of
// `api` (Phase 2+). Best-effort and fully decoupled: lazy dynamic import so
// this module never statically pulls in social-client (which throws at import
// when SOCIAL_DATABASE_URL is unset — e.g. in unit tests), and every failure
// is swallowed so a DB hiccup can never break an in-process scrape.
function mirrorJob(job: Job): void {
  if (!process.env.SOCIAL_DATABASE_URL) return; // no DB configured (tests) — skip silently
  void (async () => {
    try {
      const { socialQuery } = await import('../../db/social-client');
      await socialQuery(
        `INSERT INTO scrape_jobs (id, platform, brand, status, message, count, cancel_requested, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           status           = EXCLUDED.status,
           message          = EXCLUDED.message,
           count            = EXCLUDED.count,
           cancel_requested = EXCLUDED.cancel_requested,
           finished_at      = EXCLUDED.finished_at`,
        [
          job.id, job.platform, job.brand, job.status, job.message, job.count,
          job.cancelRequested ?? false, job.startedAt, job.finishedAt ?? null,
        ],
      );
    } catch (err) {
      console.error(`[scrape_jobs mirror] ${job.id}:`, err);
    }
  })();
}

function pruneFinishedJobs(): void {
  const finished = Array.from(jobs.values())
    .filter((j) => j.status !== 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const excess = finished.length - MAX_FINISHED_JOBS;
  for (let i = 0; i < excess; i++) {
    jobs.delete(finished[i].id);
  }
}

const router = Router();

export interface StartJobOpts {
  brand: string;
  platform: string;
  message: string;
  /** Fires a dashboard notification when the job starts. */
  notify?: { title: string; body: string; payload?: Record<string, unknown> };
}

/**
 * Registers a job and runs `fn` in the background — the single place that
 * owns the create/track/finish lifecycle every scrape-trigger route used to
 * hand-roll (jobId, jobs.set, success/error/finally). `fn` should mutate
 * `job.count`/`job.message` as it progresses; it may also set `job.status`
 * itself (e.g. 'cancelled') — otherwise status becomes 'done' on resolve or
 * 'error' on throw, and `finishedAt` is always set exactly once, here.
 */
export function startScrapeJob(opts: StartJobOpts, fn: (job: Job) => Promise<void>): Job {
  const job: Job = {
    id: randomUUID(),
    brand: opts.brand,
    platform: opts.platform,
    status: 'running',
    message: opts.message,
    count: 0,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  mirrorJob(job); // durable INSERT (best-effort)

  if (opts.notify) {
    createNotification({
      type: 'scrape_job',
      title: opts.notify.title,
      body: opts.notify.body,
      payload: { jobId: job.id, platform: opts.platform, ...opts.notify.payload },
    }).catch(() => {});
  }

  fn(job)
    .then(() => {
      if (job.status === 'running') job.status = 'done';
    })
    .catch((err: unknown) => {
      job.status = 'error';
      job.message = err instanceof Error ? err.message : String(err);
      console.error(`[job:${job.platform}]`, err);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      mirrorJob(job); // durable UPDATE with terminal status + finishedAt
      pruneFinishedJobs();
    });

  return job;
}

/**
 * Enqueue-only variant for the post-split world (Docker Phase 2+): inserts a
 * `pending` row into `scrape_jobs` and returns it WITHOUT running anything in
 * this process. The matching per-platform scraper container's queue worker
 * (src/scraper-runtime/queue-worker.ts) claims and executes it. Callers in the
 * `api` container will switch to this once a platform's Chrome work has moved
 * out of `api`; until then the in-process startScrapeJob path above stays.
 */
export async function enqueueScrapeJob(opts: {
  platform: string;
  brand?: string;
  jobType?: string;
  message?: string;
  params?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { socialQueryOne } = await import('../../db/social-client');
  const row = await socialQueryOne<{ id: string }>(
    `INSERT INTO scrape_jobs (platform, brand, job_type, message, params, status)
     VALUES ($1,$2,$3,$4,$5,'pending')
     RETURNING id`,
    [opts.platform, opts.brand ?? '', opts.jobType ?? 'scrape', opts.message ?? '', JSON.stringify(opts.params ?? {})],
  );
  if (!row) throw new Error('enqueueScrapeJob: insert returned no row');
  return row;
}

/**
 * Replaces the old in-memory `let xLoginInFlight` flag each platform's
 * /login route used to guard against double-clicks — that flag lived in the
 * `api` process, which no longer does the actual work, so it can't see
 * whether a login job is already running in the owning container/host.
 */
export async function hasPendingOrRunningJob(platform: string, jobType: string): Promise<boolean> {
  const { socialQueryOne } = await import('../../db/social-client');
  const row = await socialQueryOne<{ id: string }>(
    `SELECT id FROM scrape_jobs WHERE platform = $1 AND job_type = $2 AND status IN ('pending','running') LIMIT 1`,
    [platform, jobType],
  );
  return !!row;
}

// ── DB-backed job lookups (Docker split) ──────────────────────────────────
// Jobs the api container ENQUEUES (enqueueScrapeJob) run in a scraper
// container and exist only as `scrape_jobs` rows — never in this process's
// Map. So status/stop/jobs must fall back to the DB. In-process jobs (the
// legacy path) stay in the Map and are checked first, synchronously, so the
// unit tests (no DB configured) and current behavior are unchanged. DB access
// is skipped entirely when SOCIAL_DATABASE_URL is unset (tests).
const hasDb = (): boolean => !!process.env.SOCIAL_DATABASE_URL;

interface ScrapeJobDbRow {
  id: string; platform: string; brand: string; status: JobStatus;
  message: string; count: number; cancel_requested: boolean;
  // pg returns timestamptz as a JS Date (or null), NOT a string — coerce in
  // rowToJob so downstream string ops (localeCompare in /jobs sort) don't throw.
  started_at: Date | string | null; finished_at: Date | string | null;
  result: unknown;
}

const toIso = (v: Date | string | null): string | undefined => {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
};

function rowToJob(r: ScrapeJobDbRow): Job {
  return {
    id: r.id, brand: r.brand, platform: r.platform, status: r.status,
    message: r.message, count: r.count, cancelRequested: r.cancel_requested,
    startedAt: toIso(r.started_at) ?? '', finishedAt: toIso(r.finished_at),
    result: r.result ?? undefined,
  };
}

async function fetchJobRow(id: string): Promise<Job | null> {
  if (!hasDb()) return null;
  const { socialQueryOne } = await import('../../db/social-client');
  const r = await socialQueryOne<ScrapeJobDbRow>(`SELECT * FROM scrape_jobs WHERE id = $1`, [id]);
  return r ? rowToJob(r) : null;
}

// GET /api/scrape/status/:jobId
router.get('/status/:jobId', async (req: Request, res: Response) => {
  const jobId = typeof req.params.jobId === 'string' ? req.params.jobId : req.params.jobId[0] ?? '';
  const inProc = jobs.get(jobId);
  if (inProc) { res.json(inProc); return; }          // sync Map path (also the tests' path)
  if (!hasDb()) { res.status(404).json({ error: 'Job not found' }); return; }
  const job = await fetchJobRow(jobId);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(job);
});

// POST /api/scrape/stop/:jobId — request cooperative cancellation.
// Scraper loops poll `job.cancelRequested` between steps (keyword/scroll) and
// bail out; we cannot kill an in-flight Playwright call, so status flips to
// 'cancelled' only once the loop notices, not immediately. For enqueued jobs
// the flag lives in the row; the scraper container's queue worker polls it.
router.post('/stop/:jobId', async (req: Request, res: Response) => {
  const jobId = typeof req.params.jobId === 'string' ? req.params.jobId : req.params.jobId[0] ?? '';
  const job = jobs.get(jobId);
  if (job) {
    if (job.status !== 'running') {
      res.json({ stopped: false, message: `Job already ${job.status}` });
      return;
    }
    job.cancelRequested = true;
    job.message = 'Stop requested — finishing current step…';
    res.json({ stopped: true });
    return;
  }
  // Not in-process — try the DB (enqueued job running in a scraper container).
  if (!hasDb()) { res.status(404).json({ error: 'Job not found' }); return; }
  const row = await fetchJobRow(jobId);
  if (!row) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (row.status !== 'running' && row.status !== 'pending') {
    res.json({ stopped: false, message: `Job already ${row.status}` });
    return;
  }
  const { socialQuery } = await import('../../db/social-client');
  await socialQuery(`UPDATE scrape_jobs SET cancel_requested = true WHERE id = $1`, [jobId]);
  res.json({ stopped: true });
});

// GET /api/scrape/jobs — list recent jobs (in-process Map ∪ recent DB rows).
router.get('/jobs', async (_req: Request, res: Response) => {
  const inProc = Array.from(jobs.values());
  let all = inProc;
  if (hasDb()) {
    try {
      const { socialQuery } = await import('../../db/social-client');
      const rows = await socialQuery<ScrapeJobDbRow>(
        `SELECT * FROM scrape_jobs ORDER BY created_at DESC LIMIT 30`,
      );
      const seen = new Set(inProc.map((j) => j.id));
      all = inProc.concat(rows.filter((r) => !seen.has(r.id)).map(rowToJob));
    } catch (err) {
      console.error('[scrape/jobs] DB fetch failed, returning in-process only:', err);
    }
  }
  const recent = all
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, 30);
  res.json(recent);
});

export default router;
