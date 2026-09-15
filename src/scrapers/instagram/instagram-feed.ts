import { chromium, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PoolClient } from 'pg';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { createNotification } from '../../notifications/store';

// ── Own-brand Instagram accounts ──────────────────────────────────────────────
// Real own-brand IG handles (confirmed from existing scraped data — 50 clean posts each).
// The scraper also falls back to brands.instagram_handle if a brand isn't listed here.
export const INSTAGRAM_ACCOUNTS = [
  { brandSlug: 'mizumi',        handle: 'mizumi_official' },
  { brandSlug: 'gentle-colors', handle: 'gentlecolors_official' },
  { brandSlug: 'bomi',          handle: 'bomiofficial_th' },
];

// ── Desktop UA ────────────────────────────────────────────────────────────────
// Windows UA on the dev host, undefined (native Linux UA) in the Docker
// scraper container — see desktop-ua.ts.
import { DESKTOP_UA } from '../desktop-ua';

// ── Persistent profile (log in once → automated afterwards) ───────────────────
const IG_PROFILE_DIR = path.join(os.homedir(), '.instagram-scraper-profile');

// launchPersistentContext only tolerates one Chrome instance per profile dir
// at a time. The scheduler's cron (feed, every 6h) and the queue worker
// (manual "Run Now" / ad-hoc scrape) are independent async loops in the same
// scraper-instagram container process — with no coordination between them, a
// cron tick racing a manual trigger can make two Chrome instances fight over
// the same --user-data-dir lock file. TikTok/Twitter/XHS hit the identical
// bug and were fixed with a Postgres advisory lock shared across processes
// (and, within one process, still serializes since the lock query blocks);
// same fix ported here.
const IG_PROFILE_LOCK_KEY = 918_273_648; // arbitrary, must not collide with tiktok/twitter/xhs-browser.ts's keys

async function acquireCrossProcessLock(): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [IG_PROFILE_LOCK_KEY]);
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseCrossProcessLock(client: PoolClient): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [IG_PROFILE_LOCK_KEY]);
  } finally {
    client.release();
  }
}

const CHROME_PATHS: string[] = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

function findChrome(): string | null {
  const override = process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;
  return CHROME_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Probe the on-disk Cookies sqlite mtime — no Chrome launch. Moved here from
 * api/routes/instagram.ts so both the route (pre-split) and the
 * scraper-instagram container (queue-worker's periodic self-check + 'login'
 * job_type) can call it — only the latter can actually see this file now
 * that api has no browser.
 */
export function getInstagramSessionStatus(): { valid: boolean; profileDir: string; checkedAt: string; hint?: string } {
  const now = new Date().toISOString();
  const candidates = [
    path.join(IG_PROFILE_DIR, 'Default', 'Network', 'Cookies'),
    path.join(IG_PROFILE_DIR, 'Default', 'Cookies'),
  ];
  if (!fs.existsSync(IG_PROFILE_DIR)) {
    return { valid: false, profileDir: IG_PROFILE_DIR, checkedAt: now, hint: 'Profile not initialised — click Log in to Instagram.' };
  }
  const cookieFile = candidates.find((p) => fs.existsSync(p));
  if (!cookieFile) {
    return { valid: false, profileDir: IG_PROFILE_DIR, checkedAt: now, hint: 'No Cookies sqlite yet — click Log in to Instagram.' };
  }
  const stat = fs.statSync(cookieFile);
  const ageDays = (Date.now() - stat.mtimeMs) / (24 * 3_600_000);
  if (ageDays > 30) {
    return { valid: false, profileDir: IG_PROFILE_DIR, checkedAt: now, hint: `Cookies last touched ${Math.round(ageDays)}d ago — re-login likely required.` };
  }
  return { valid: true, profileDir: IG_PROFILE_DIR, checkedAt: now, hint: `Cookies file last written ${Math.round(ageDays * 24 * 60) / 60}h ago.` };
}

export async function launchContext(): Promise<{ ctx: BrowserContext; cleanup: () => Promise<void> }> {
  const dbLock = await acquireCrossProcessLock();
  try {
    if (!fs.existsSync(IG_PROFILE_DIR)) {
      fs.mkdirSync(IG_PROFILE_DIR, { recursive: true });
      console.log(`  Profile dir created at ${IG_PROFILE_DIR}`);
      console.log(`  First run: log in to Instagram manually in the browser window, then the scraper continues.`);
    }
    const chromePath = findChrome();
    const ctx = await chromium.launchPersistentContext(IG_PROFILE_DIR, {
      headless: false,
      executablePath: chromePath ?? undefined,
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Bangkok',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
      ],
    });
    await ctx.addInitScript(`
      Object.defineProperty(navigator,'webdriver',{get:()=>false});
      Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
      window.chrome={runtime:{}};
    `);
    return {
      ctx,
      cleanup: async () => {
        try { await ctx.close(); } catch { /* ignore */ }
        await releaseCrossProcessLock(dbLock);
      },
    };
  } catch (err) {
    await releaseCrossProcessLock(dbLock);
    throw err;
  }
}

// ── Normalized post ───────────────────────────────────────────────────────────
export interface IgPost {
  postId: string;          // shortcode
  externalId: string | null;  // numeric media pk (null if the node lacked pk/id)
  mediaUrl: string | null;
  caption: string;
  hashtags: string[];
  mentions: string[];
  mediaType: 'image' | 'video' | 'carousel' | 'reel';
  views: number | null;
  likes: number;
  commentsCount: number;
  postedAt: Date | null;
  engagementRate: number | null;
  authorHandle: string | null;
  rawData: unknown;
}

// IG returns several shapes (api/v1 items, xdt graphql nodes, legacy graphql nodes).
// This reads whichever fields are present.
export function normalizeIg(raw: Record<string, unknown>): IgPost | null {
  const r = raw as any;
  const code: string | undefined = r.code ?? r.shortcode;
  if (!code) return null;

  // Media pk: present on api/v1 + xdt-graphql nodes; legacy graphql exposes only `id`.
  // Store NULL (not '') when neither exists so the comment scraper's IS NOT NULL filter is honest.
  const externalId: string | null = (r.pk ?? r.id) != null ? String(r.pk ?? r.id) : null;
  const caption: string =
    r.caption?.text ??
    r.edge_media_to_caption?.edges?.[0]?.node?.text ??
    (typeof r.caption === 'string' ? r.caption : '') ??
    '';

  const likes: number = r.like_count ?? r.edge_liked_by?.count ?? r.edge_media_preview_like?.count ?? 0;
  const comments: number = r.comment_count ?? r.edge_media_to_comment?.count ?? r.edge_media_to_parent_comment?.count ?? 0;

  const isVideo: boolean = r.is_video ?? (r.media_type === 2);
  const isCarousel: boolean = r.__typename === 'GraphSidecar' || r.media_type === 8 || Array.isArray(r.carousel_media);
  const isClip: boolean = r.product_type === 'clips';
  const mediaType: IgPost['mediaType'] = isCarousel ? 'carousel' : isClip ? 'reel' : isVideo ? 'video' : 'image';

  const views: number | null =
    r.play_count ?? r.view_count ?? r.video_view_count ?? (mediaType === 'image' ? null : null);

  // Tagged/usertags graphql nodes omit taken_at — the post time lives on caption.created_at.
  const takenAt: number | undefined =
    r.taken_at ?? r.taken_at_timestamp ?? r.caption?.created_at ?? r.caption?.created_at_utc;
  const mediaUrl: string | null =
    r.image_versions2?.candidates?.[0]?.url ?? r.display_url ?? r.thumbnail_url ?? r.thumbnail_src ?? null;
  const authorHandle: string | null = r.user?.username ?? r.owner?.username ?? null;

  const hashtags = Array.from(new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.slice(1))));
  const mentions = Array.from(new Set((caption.match(/@[\w.]+/g) ?? []).map((m) => m.slice(1))));

  const engagementRate = views && views > 0
    ? Number((((likes + comments) / views) * 100).toFixed(4))
    : null;

  return {
    postId: code,
    externalId,
    mediaUrl,
    caption,
    hashtags,
    mentions,
    mediaType,
    views: views ?? null,
    likes,
    commentsCount: comments,
    postedAt: takenAt ? new Date(takenAt * 1000) : null,
    engagementRate,
    authorHandle,
    rawData: raw,
  };
}

// Pull media nodes out of any IG feed/graphql response body.
// Covers: api/v1 user feed, timeline graphql, and the Reels-tab clips connection.
export function extractItems(body: any): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.items)) return body.items.map((it: any) => it.media ?? it);
  // Hashtag pages return media grouped in `sections[].layout_content.medias[].media`.
  if (Array.isArray(body.sections)) {
    return body.sections.flatMap((s: any) =>
      (s?.layout_content?.medias ?? s?.layout_content?.one_by_two_item?.clips?.items ?? [])
        .map((m: any) => m.media ?? m),
    ).filter(Boolean);
  }
  const conn = body.data?.xdt_api__v1__feed__user_timeline_graphql_connection
    ?? body.data?.xdt_api__v1__clips__user__connection_v2
    ?? body.data?.xdt_api__v1__feed__timeline__connection   // hashtag explore feed
    ?? body.data?.xdt_api__v1__tags__sections     // hashtag graphql (alt)
    ?? body.data?.xdt_api__v1__usertags__user_id__feed_connection  // tagged feed graphql
    ?? body.data?.user?.edge_owner_to_timeline_media
    ?? body.data?.user?.edge_user_to_photos_of_you; // legacy tagged feed
  // grid node IS the media; clips-v2 node WRAPS media at node.media.
  if (conn?.edges) return conn.edges.map((e: any) => e.node?.media ?? e.media ?? e.node).filter(Boolean);
  if (Array.isArray(conn?.items)) return conn.items.map((it: any) => it.media ?? it);
  if (Array.isArray(conn?.sections)) {
    return conn.sections.flatMap((s: any) => (s?.layout_content?.medias ?? []).map((m: any) => m.media ?? m)).filter(Boolean);
  }
  return [];
}

export class InstagramFeedScraper {
  constructor(private brandSlug: string, private handle: string, private opts: { maxScrolls?: number; maxPosts?: number; maxAgeDays?: number } = {}) {}

  async runWithContext(context: BrowserContext): Promise<number> {
    const collected = new Map<string, Record<string, unknown>>();
    // shortcode → play_count. The grid feed hides view counts; the Reels tab
    // (api/v1/clips/user/) exposes play_count, which is IG's "Views" number.
    const reelViews = new Map<string, number>();
    const page = await context.newPage();
    const MAX_AGE_DAYS = this.opts.maxAgeDays ?? 30;
    // 0 = no cutoff (all time) — Settings → Thresholds "Feed max post age".
    const AGE_CUTOFF_MS = MAX_AGE_DAYS > 0 ? Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000 : 0;

    page.on('response', async (resp) => {
      const url = resp.url();
      if (!/\/api\/v1\/feed\/user\//.test(url) && !/\/graphql\/query/.test(url) && !/\/api\/v1\/clips\/user\//.test(url)) return;
      if (!resp.ok()) return;
      try {
        const body = await resp.json();
        // Clips-tab nodes are lightweight (no date/caption) — use them ONLY to harvest
        // play_count. Posts come from the grid feed, which has full metadata.
        const isClips = !!body?.data?.xdt_api__v1__clips__user__connection_v2;
        const items = extractItems(body);
        if (process.env.IG_DEBUG === '1') {
          const pth = url.replace(/https?:\/\/[^/]+/, '').split('?')[0];
          const f = items[0] as any;
          const dataKeys = body?.data ? Object.keys(body.data).join(',') : '-';
          console.log(`\n  [resp] ${pth} items=${items.length} play0=${f?.play_count ?? f?.view_count ?? 'n/a'} dataKeys=${dataKeys}`);
        }
        if (items.length === 0) return;
        for (const it of items) {
          const m = it as any;
          const code = m.code ?? m.shortcode;
          if (!code) continue;
          const pc = m.play_count ?? m.ig_play_count ?? m.view_count ?? m.video_view_count;
          if (typeof pc === 'number' && pc > 0) reelViews.set(String(code), pc);
          if (!isClips) collected.set(String(code), it); // grid only → posts have date + caption
        }
        process.stdout.write(`\r  Collected ${collected.size} posts (${reelViews.size} with views)...`);
      } catch { /* ignore non-JSON */ }
    });

    const profileUrl = `https://www.instagram.com/${this.handle}/`;
    console.log(`  Navigating to ${profileUrl}...`);
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(4000);

      const cur = page.url();
      if (cur.includes('/accounts/login') || cur.includes('/challenge')) {
        console.warn(`  Not logged in (redirected to ${cur}). Log in manually in the profile window, then re-run.`);
        return 0;
      }

      // Scroll to trigger lazy-loaded batches; stop on the age cutoff or empty scrolls.
      const MAX_SCROLLS = this.opts.maxScrolls ?? 40;
      const MAX_POSTS   = this.opts.maxPosts ?? Number.POSITIVE_INFINITY;
      let emptyScrolls = 0;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        if (collected.size >= MAX_POSTS) {
          console.log(`\n  Hit MAX_POSTS=${MAX_POSTS} — stopping`);
          break;
        }
        const beforeIds = new Set(collected.keys());
        const before = collected.size;
        await page.evaluate(() => window.scrollBy(0, 4000));
        await page.waitForTimeout(2500);

        if (collected.size === before) {
          if (++emptyScrolls >= 5) { console.log(`\n  5 empty scrolls — stopping`); break; }
        } else {
          emptyScrolls = 0;
          const fresh = Array.from(collected.entries())
            .filter(([k]) => !beforeIds.has(k))
            .map(([, v]) => normalizeIg(v))
            .filter((p): p is IgPost => !!p);
          if (AGE_CUTOFF_MS > 0 && fresh.some((p) => p.postedAt && p.postedAt.getTime() < AGE_CUTOFF_MS)) {
            console.log(`\n  Reached posts older than ${MAX_AGE_DAYS} days — stopping`);
            break;
          }
        }
      }
      console.log();

      // Reels-tab pass — collect play_count (real "Views") for reels via clips/user.
      try {
        console.log(`  Loading Reels tab for view counts...`);
        await page.goto(`https://www.instagram.com/${this.handle}/reels/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(3000);
        for (let i = 0; i < 12; i++) {
          const before = reelViews.size;
          await page.evaluate(() => window.scrollBy(0, 4000));
          await page.waitForTimeout(2000);
          if (reelViews.size === before && i > 2) break;
        }
        console.log(`\n  Got view counts for ${reelViews.size} reels`);
      } catch (err) {
        console.warn(`  Reels-tab pass failed (views skipped): ${err}`);
      }
    } catch (err) {
      console.warn(`  Navigation/scrape failed: ${err}`);
    } finally {
      await page.close().catch(() => {});
    }

    if (collected.size === 0) {
      console.warn(`[IG/${this.brandSlug}] 0 posts — handle may be wrong, profile private, or session expired.`);
      return 0;
    }

    const brandRows = await query<{ id: number }>(`SELECT id FROM brands WHERE slug = $1 LIMIT 1`, [this.brandSlug]);
    if (brandRows.length === 0) { console.warn(`[IG/${this.brandSlug}] Brand not in DB`); return 0; }
    const brandId = brandRows[0].id;

    const cutoff = AGE_CUTOFF_MS > 0 ? new Date(AGE_CUTOFF_MS) : null;
    const posts = Array.from(collected.values())
      .map(normalizeIg)
      .filter((p): p is IgPost => !!p)
      .filter((p) => !cutoff || !p.postedAt || p.postedAt >= cutoff)
      .map((p) => {
        // Backfill reel views from the clips pass; recompute engagement % where available.
        const v = reelViews.get(p.postId);
        if (v != null && v > 0) {
          p.views = v;
          p.engagementRate = Number((((p.likes + p.commentsCount) / v) * 100).toFixed(4));
        }
        return p;
      });

    let upsertCount = 0;
    for (const post of posts) {
      const isReel = post.mediaType === 'reel';
      const postUrl = `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${post.postId}/`;
      try {
        const result = await pool.query<{ is_new: boolean }>(
          `INSERT INTO instagram_posts (
             brand_id, post_id, external_id, media_url, post_url, caption,
             hashtags, mentions, media_type, views, likes, comments_count,
             posted_at, engagement_rate, raw_data, source_type, author_handle
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'feed',$16)
           ON CONFLICT (brand_id, post_id) DO UPDATE SET
             likes           = EXCLUDED.likes,
             comments_count  = EXCLUDED.comments_count,
             views           = EXCLUDED.views,
             engagement_rate = EXCLUDED.engagement_rate,
             media_url       = EXCLUDED.media_url,
             -- Backfill media pk for rows first inserted by an older scraper (NULL pk),
             -- and refresh raw_data so stale normalized blobs get the real IG node.
             external_id     = COALESCE(NULLIF(EXCLUDED.external_id, ''), instagram_posts.external_id),
             raw_data        = EXCLUDED.raw_data,
             scraped_at      = NOW()
           RETURNING (xmax = 0) AS is_new`,
          [
            brandId, post.postId, post.externalId, post.mediaUrl, postUrl, post.caption,
            post.hashtags, post.mentions, post.mediaType, post.views, post.likes, post.commentsCount,
            post.postedAt, post.engagementRate, JSON.stringify(post.rawData), post.authorHandle ?? this.handle,
          ],
        );
        if (result.rows[0]?.is_new) {
          createNotification({
            type: 'new_post_feed',
            title: 'New Instagram post',
            body: `@${this.handle} posted on Instagram`,
            relatedPostId: post.postId,
            payload: { brandSlug: this.brandSlug, handle: this.handle, caption: post.caption },
          }).catch(() => {});
        }
        upsertCount++;
      } catch (err) {
        console.error(`  Upsert failed for ${post.postId}: ${err}`);
      }
    }
    console.log(`[IG/${this.brandSlug}] Upserted ${upsertCount}/${posts.length} posts`);
    return upsertCount;
  }

  async run(): Promise<number> {
    const { ctx, cleanup } = await launchContext();
    try {
      return await this.runWithContext(ctx);
    } finally {
      await cleanup();
    }
  }
}

// ── Scrape all own-brand IG accounts ──────────────────────────────────────────
export async function scrapeAllInstagram(): Promise<void> {
  // Merge configured accounts with any brands.instagram_handle set in the DB.
  const dbRows = await query<{ slug: string; instagram_handle: string | null }>(
    `SELECT slug, instagram_handle FROM brands WHERE type = 'own' AND instagram_handle IS NOT NULL`,
  );
  const merged = new Map<string, { brandSlug: string; handle: string }>();
  for (const a of INSTAGRAM_ACCOUNTS) merged.set(`${a.brandSlug}:${a.handle}`, a);
  for (const r of dbRows) if (r.instagram_handle) merged.set(`${r.slug}:${r.instagram_handle}`, { brandSlug: r.slug, handle: r.instagram_handle });

  const accounts = Array.from(merged.values());
  if (accounts.length === 0) { console.warn('[IG] No accounts configured'); return; }

  const { getThresholds } = await import('../../config/settings-loader');
  const thresholds = await getThresholds().catch(() => null);
  const limits = thresholds?.scrapeLimits.instagramFeed;

  const { ctx, cleanup } = await launchContext();
  try {
    for (const acc of accounts) {
      console.log(`\n[IG/${acc.brandSlug}] @${acc.handle}`);
      const scraper = new InstagramFeedScraper(acc.brandSlug, acc.handle, { maxScrolls: limits?.maxScrolls, maxPosts: limits?.maxPosts, maxAgeDays: thresholds?.feedMaxAgeDays });
      await scraper.runWithContext(ctx).catch((e) => console.error(`[IG/${acc.brandSlug}]`, e));
      await new Promise((r) => setTimeout(r, 8_000)); // pacing between profiles
    }
  } finally {
    await cleanup();
  }
}

if (require.main === module) {
  scrapeAllInstagram()
    .then(() => { console.log('Done'); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
