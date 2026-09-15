import { describe, it, expect, vi, beforeEach } from 'vitest';

// scrape.ts imports createNotification for the `notify` option — mock it so
// tests never touch the real DB. Path must match the import inside scrape.ts.
vi.mock('../src/notifications/store', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

import { startScrapeJob, jobs } from '../src/api/routes/scrape';
import scrapeRouter from '../src/api/routes/scrape';
import { createNotification } from '../src/notifications/store';

// Express's Router type doesn't expose `.stack` publicly — it's how the
// router actually stores registered routes internally, and is stable enough
// to read in a test without spinning up a real HTTP server.
interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } }
function findHandler(method: 'get' | 'post', path: string): (req: unknown, res: unknown) => void {
  const layer = (scrapeRouter as unknown as { stack: RouteLayer[] }).stack
    .find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle;
}

// Every route (tiktok.ts, instagram.ts, xhs.ts, twitter.ts, admin.ts) now
// funnels its "trigger a scrape" endpoint through startScrapeJob() instead of
// hand-rolling the jobId/jobs.set/status lifecycle 9 times. These tests cover
// that shared function directly — it's what all 9 call sites actually depend
// on, and is cheap to test without a live DB, Chrome, or Express server.

function flush(): Promise<void> {
  // Let the fire-and-forget promise chain inside startScrapeJob settle.
  return new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  jobs.clear();
  vi.mocked(createNotification).mockClear();
});

describe('startScrapeJob', () => {
  it('registers a running job synchronously, before fn resolves', () => {
    const job = startScrapeJob(
      { brand: 'mizumi', platform: 'tiktok', message: 'Starting...' },
      () => new Promise(() => {}), // never resolves — job must still be visible now
    );

    expect(job.status).toBe('running');
    expect(job.brand).toBe('mizumi');
    expect(job.platform).toBe('tiktok');
    expect(job.count).toBe(0);
    expect(job.finishedAt).toBeUndefined();
    expect(jobs.get(job.id)).toBe(job); // same object the caller got back
  });

  it('marks the job done and sets finishedAt when fn resolves', async () => {
    const job = startScrapeJob(
      { brand: 'all', platform: 'xhs-feed', message: 'Starting...' },
      async (job) => { job.count = 5; job.message = 'complete'; },
    );

    await flush();

    expect(job.status).toBe('done');
    expect(job.count).toBe(5);
    expect(job.message).toBe('complete');
    expect(job.finishedAt).toBeDefined();
  });

  it('marks the job error and records the message when fn throws', async () => {
    const job = startScrapeJob(
      { brand: 'all', platform: 'instagram', message: 'Starting...' },
      async () => { throw new Error('boom'); },
    );

    await flush();

    expect(job.status).toBe('error');
    expect(job.message).toBe('boom');
    expect(job.finishedAt).toBeDefined();
  });

  it('does not overwrite a status fn already set itself (e.g. cancelled)', async () => {
    const job = startScrapeJob(
      { brand: 'all', platform: 'twitter-search', message: 'Starting...' },
      async (job) => { job.status = 'cancelled'; job.message = 'Search stopped by user'; },
    );

    await flush();

    expect(job.status).toBe('cancelled');
    expect(job.message).toBe('Search stopped by user');
  });

  it('fires a notification with jobId/platform merged into payload when notify is set', () => {
    const job = startScrapeJob(
      {
        brand: 'all',
        platform: 'tiktok-search',
        message: 'Starting...',
        notify: { title: 'TikTok search started', body: 'Manual search scrape for all brands', payload: { keyword: 'mizumi' } },
      },
      () => new Promise(() => {}),
    );

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'scrape_job',
      title: 'TikTok search started',
      payload: { jobId: job.id, platform: 'tiktok-search', keyword: 'mizumi' },
    }));
  });

  it('does not fire a notification when notify is omitted', () => {
    startScrapeJob(
      { brand: 'all', platform: 'xhs-search', message: 'Starting...' },
      () => new Promise(() => {}),
    );

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('gives every job a distinct id', () => {
    const a = startScrapeJob({ brand: 'all', platform: 'tiktok', message: 'x' }, () => new Promise(() => {}));
    const b = startScrapeJob({ brand: 'all', platform: 'tiktok', message: 'x' }, () => new Promise(() => {}));
    expect(a.id).not.toBe(b.id);
  });
});

describe('scrape.ts routes', () => {
  // Router handlers are plain (req, res) functions with no Express app
  // wiring needed here — fake just the res methods each handler calls.
  function fakeRes() {
    const res: { statusCode: number; body: unknown; status: (n: number) => typeof res; json: (b: unknown) => typeof res } = {
      statusCode: 200,
      body: undefined,
      status(n: number) { this.statusCode = n; return this; },
      json(b: unknown) { this.body = b; return this; },
    };
    return res;
  }

  it('GET /status/:jobId returns 404 for an unknown job', () => {
    const handler = findHandler('get', '/status/:jobId');
    const res = fakeRes();
    handler({ params: { jobId: 'does-not-exist' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('GET /status/:jobId returns the job for a known id', () => {
    const job = startScrapeJob({ brand: 'all', platform: 'tiktok', message: 'x' }, () => new Promise(() => {}));
    const handler = findHandler('get', '/status/:jobId');
    const res = fakeRes();
    handler({ params: { jobId: job.id } }, res);
    expect(res.body).toBe(job);
  });

  it('POST /stop/:jobId flags cancelRequested on a running job', () => {
    const job = startScrapeJob({ brand: 'all', platform: 'tiktok', message: 'x' }, () => new Promise(() => {}));
    const handler = findHandler('post', '/stop/:jobId');
    const res = fakeRes();
    handler({ params: { jobId: job.id } }, res);
    expect(job.cancelRequested).toBe(true);
    expect(res.body).toEqual({ stopped: true });
  });

  it('POST /stop/:jobId refuses to stop a job that already finished', async () => {
    const job = startScrapeJob({ brand: 'all', platform: 'tiktok', message: 'x' }, async () => {});
    await flush(); // job.status is now 'done'
    const handler = findHandler('post', '/stop/:jobId');
    const res = fakeRes();
    handler({ params: { jobId: job.id } }, res);
    expect(res.body).toEqual({ stopped: false, message: 'Job already done' });
  });
});
