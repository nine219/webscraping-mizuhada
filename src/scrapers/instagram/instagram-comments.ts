import { chromium, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { shouldKeepComment } from '../../analysis/comments';
import { needsTranslation } from '../../analysis/lang-detect';

import { DESKTOP_UA } from '../desktop-ua';
const IG_PROFILE_DIR = path.join(os.homedir(), '.instagram-scraper-profile');
const IG_APP_ID = '936619743392459';

const CHROME_PATHS: string[] = process.platform === 'win32'
  ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
     'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
     `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

function findChrome(): string | undefined {
  const override = process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return override;
  return CHROME_PATHS.find((p) => fs.existsSync(p));
}

async function launchContext(): Promise<{ ctx: BrowserContext; cleanup: () => Promise<void> }> {
  if (!fs.existsSync(IG_PROFILE_DIR)) fs.mkdirSync(IG_PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(IG_PROFILE_DIR, {
    headless: false,
    executablePath: findChrome(),
    userAgent: DESKTOP_UA,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--no-first-run', '--no-default-browser-check'],
  });
  return { ctx, cleanup: async () => { try { await ctx.close(); } catch { /* ignore */ } } };
}

export interface IgComment { pk: string; text: string; username: string | null; likes: number; created: number | null }

const IG_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function shortcodeToMediaId(shortcode: string): string {
  let id = 0n;
  for (const ch of shortcode) id = id * 64n + BigInt(IG_BASE64.indexOf(ch));
  return id.toString();
}

// Fetch comments via the in-page web API (cookies + same-origin auto-applied).
export async function fetchComments(page: import('playwright').Page, pk: string, maxPages = 20): Promise<IgComment[]> {
  return page.evaluate(async ({ mediaPk, appId, pages }) => {
    const all: IgComment[] = [];
    let minId = '';
    for (let i = 0; i < pages; i++) {
      const url = `https://www.instagram.com/api/v1/media/${mediaPk}/comments/?can_support_threading=true&permalink_enabled=false`
        + (minId ? `&min_id=${encodeURIComponent(minId)}` : '');
      let body: any;
      try {
        const res = await fetch(url, { headers: { 'x-ig-app-id': appId }, credentials: 'include' });
        if (!res.ok) break;
        body = await res.json();
      } catch { break; }
      const push = (c: any) => all.push({
        pk: String(c.pk),
        text: c.text ?? '',
        username: c.user?.username ?? null,
        likes: c.comment_like_count ?? 0,
        created: c.created_at ?? null,
      });
      for (const c of (body.comments ?? [])) {
        push(c);
        // include inline reply previews (IG returns a few replies nested per parent)
        for (const rc of (c.preview_child_comments ?? [])) push(rc);
      }
      if (!body.has_more_comments || !body.next_min_id) break;
      minId = body.next_min_id;
      await new Promise((r) => setTimeout(r, 800));
    }
    return all;
  }, { mediaPk: pk, appId: IG_APP_ID, pages: maxPages });
}

// Fetch a post's taken_at (post date) + caption via the media info endpoint.
// Tagged-grid nodes omit the timestamp; this recovers it for any media pk.
export async function fetchMediaInfo(
  page: import('playwright').Page,
  pk: string,
): Promise<{ takenAt: number | null; caption: string | null }> {
  return page.evaluate(async ({ mediaPk, appId }) => {
    try {
      const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaPk}/info/`, {
        headers: { 'x-ig-app-id': appId }, credentials: 'include',
      });
      if (!res.ok) return { takenAt: null, caption: null };
      const body = await res.json();
      const item = body?.items?.[0];
      return {
        takenAt: item?.taken_at ?? item?.caption?.created_at ?? null,
        caption: item?.caption?.text ?? null,
      };
    } catch { return { takenAt: null, caption: null }; }
  }, { mediaPk: pk, appId: IG_APP_ID });
}

export async function upsertComments(brandId: number, postId: string, comments: IgComment[]): Promise<number> {
  let count = 0;
  for (const c of comments) {
    if (!shouldKeepComment(c.text)) continue; // see analysis/comments.ts
    try {
      await pool.query(
        `INSERT INTO social_comments (brand_id, platform, external_id, content, published_at, post_id, likes_count, author_name, content_translated)
         VALUES ($1,'instagram',$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (platform, external_id) DO UPDATE SET likes_count = EXCLUDED.likes_count, author_name = EXCLUDED.author_name`,
        [brandId, c.pk, c.text, c.created ? new Date(c.created * 1000) : null, postId, c.likes, c.username, needsTranslation(c.text) ? null : ''],
      );
      count++;
    } catch (err) {
      console.error(`  IG comment upsert failed (${c.pk}): ${err}`);
    }
  }
  return count;
}

// Scrape comments for a single IG post (by shortcode). Used by the per-post button.
export async function scrapeIgCommentsForPost(postId: string, ctx?: BrowserContext): Promise<number> {
  const rows = await query<{ brand_id: number; external_id: string | null }>(
    `SELECT brand_id, external_id FROM instagram_posts WHERE post_id = $1 LIMIT 1`,
    [postId],
  );
  if (rows.length === 0) { console.warn(`[IG-comments] Post ${postId} not found`); return 0; }
  let { brand_id, external_id } = rows[0];
  if (!external_id) {
    external_id = shortcodeToMediaId(postId);
    console.log(`[IG-comments] Derived media pk ${external_id} from shortcode ${postId}`);
    await pool.query(
      `UPDATE instagram_posts SET external_id = $1 WHERE brand_id = $2 AND post_id = $3`,
      [external_id, brand_id, postId],
    ).catch(() => {});
  }

  const own = ctx ? { ctx, cleanup: async () => {} } : await launchContext();
  const page = await own.ctx.newPage();
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const comments = await fetchComments(page, external_id);
    const saved = await upsertComments(brand_id, postId, comments);
    // fetchComments only reaches here without throwing on a real fetch — 0 comments is a
    // valid result, not a failure, so always stamp. A thrown error skips this whole block
    // (propagates to caller), leaving comments_scraped_at NULL so the post retries.
    await pool.query(
      `UPDATE instagram_posts SET comments_meta_at_scrape = comments_count, comments_scraped_at = NOW()
       WHERE brand_id = $1 AND post_id = $2`,
      [brand_id, postId],
    );
    console.log(`[IG-comments] ${postId}: ${saved} comments saved`);
    return saved;
  } finally {
    await page.close().catch(() => {});
    await own.cleanup();
  }
}

// Scrape comments for a brand's recent IG posts that have comments.
export async function scrapeIgCommentsForBrand(
  brandSlug: string,
  days = 30,
  ctx?: BrowserContext,
): Promise<void> {
  const brandRows = await query<{ id: number }>(`SELECT id FROM brands WHERE slug = $1 LIMIT 1`, [brandSlug]);
  if (brandRows.length === 0) { console.warn(`[IG-comments/${brandSlug}] Brand not in DB`); return; }
  const brandId = brandRows[0].id;

  // Same feed gate as TikTok (findTargetPosts): comments_count holds API metadata.
  // INITIAL (never scraped) → scrape every feed post, full stop — no comment_count gate,
  // it's unreliable API metadata that can under-report as 0 on a post with real comments.
  // UPDATE (already scraped) → re-scrape only when metadata grew >= growthDelta (Settings →
  // Thresholds "Comment re-scrape delta"), within recency. Separate knob from
  // commentMinViews/commentMinCount, which gate UGC search comment-scraping only; feed
  // always scrapes every post's comments regardless of those, so it must not share them.
  const { getThresholds } = await import('../../config/settings-loader');
  const growthDelta = (await getThresholds().catch(() => null))?.commentGrowthDelta ?? 5;
  const posts = await query<{ post_id: string; external_id: string | null }>(
    `SELECT post_id, external_id FROM instagram_posts
     WHERE brand_id = $1
       AND source_type = 'feed'
       AND posted_at >= NOW() - INTERVAL '1 month'   -- hard cap
       AND (
         comments_scraped_at IS NULL
         OR (
           comments_scraped_at IS NOT NULL
           AND comments_count - comments_meta_at_scrape >= $3
           AND posted_at >= NOW() - INTERVAL '1 day' * $2
         )
       )
     ORDER BY posted_at DESC`,
    [brandId, days, growthDelta],
  );
  if (posts.length === 0) { console.log(`[IG-comments/${brandSlug}] No posts with comments in window`); return; }

  const own = ctx ? { ctx, cleanup: async () => {} } : await launchContext();
  const page = await own.ctx.newPage();
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    let total = 0;
    for (const p of posts) {
      const mediaPk = p.external_id ?? shortcodeToMediaId(p.post_id);
      if (!p.external_id && mediaPk) {
        await pool.query(
          `UPDATE instagram_posts SET external_id = $1 WHERE brand_id = $2 AND post_id = $3`,
          [mediaPk, brandId, p.post_id],
        ).catch(() => {});
      }
      let comments: IgComment[];
      try {
        comments = await fetchComments(page, mediaPk);
      } catch (err) {
        console.warn(`\n  [${brandSlug}] ${p.post_id}: fetch failed, will retry next run: ${err}`);
        await new Promise((r) => setTimeout(r, 1500)); // pacing
        continue; // comments_scraped_at stays NULL — retried next run
      }
      const saved = await upsertComments(brandId, p.post_id, comments);
      total += saved;
      // fetchComments returned without throwing — 0 comments is a valid result, not a
      // failure, so always stamp. Only a real error (caught above) skips the stamp.
      await pool.query(
        `UPDATE instagram_posts SET comments_meta_at_scrape = comments_count, comments_scraped_at = NOW()
         WHERE brand_id = $1 AND post_id = $2`,
        [brandId, p.post_id],
      );
      process.stdout.write(`\r  [${brandSlug}] ${p.post_id}: ${saved} comments (total ${total})   `);
      await new Promise((r) => setTimeout(r, 1500)); // pacing
    }
    console.log(`\n[IG-comments/${brandSlug}] Saved ${total} comments across ${posts.length} posts`);
  } finally {
    await page.close().catch(() => {});
    await own.cleanup();
  }
}

// All own brands, sharing one browser context.
export async function scrapeAllIgComments(days = 30): Promise<void> {
  const brands = await query<{ slug: string }>(
    `SELECT slug FROM brands WHERE type = 'own' AND instagram_handle IS NOT NULL ORDER BY slug`,
  );
  if (brands.length === 0) { console.warn('[IG-comments] No IG brands'); return; }

  const { ctx, cleanup } = await launchContext();
  try {
    for (const b of brands) {
      console.log(`\n[IG-comments/${b.slug}]`);
      await scrapeIgCommentsForBrand(b.slug, days, ctx).catch((e) => console.error(`[IG-comments/${b.slug}]`, e));
    }
  } finally {
    await cleanup();
  }
}

if (require.main === module) {
  scrapeAllIgComments(Number(process.env.IG_COMMENT_DAYS ?? '30'))
    .then(() => { console.log('Done'); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
