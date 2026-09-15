/**
 * One-off TikTok keyword search — collects posts and writes them straight to
 * a CSV file, never touches the DB (no upsert into tiktok_posts, no brand
 * resolution/relevance filtering). Ad-hoc lookup, not part of the pipeline.
 *
 * Unlike tiktok-search.ts's collectKeyword(), this has no maxPostsPerKeyword
 * cap and a higher empty-scroll tolerance — keeps scrolling until TikTok
 * genuinely stops serving new results, not until an arbitrary count is hit.
 *
 * Run once, manually:
 *   npx ts-node -r dotenv/config scripts/tiktok-keyword-csv-scrape.ts dotenv_config_path=.env.local -- "<keyword>"
 *   (keyword defaults to มาส์กวิตซี if omitted)
 */
import * as fs from 'fs';
import * as path from 'path';
import { launchContext, warmUp, isSessionValid, solveCaptcha } from '../src/scrapers/tiktok/tiktok-browser';

interface TikTokApiItem {
  id: string;
  desc: string;
  createTime: number;
  author?: { uniqueId?: string; id?: string; nickname?: string };
  video?: { playAddr?: string; downloadAddr?: string; cover?: string; dynamicCover?: string; originCover?: string };
  stats?: { playCount?: number; diggCount?: number; shareCount?: number; commentCount?: number };
  authorStats?: { followerCount?: number; heartCount?: number; videoCount?: number };
  challenges?: Array<{ title?: string }>;
}

interface SearchItem { item?: TikTokApiItem; type?: number }
interface TikTokSearchResponse { item_list?: TikTokApiItem[]; data?: SearchItem[] }

function extractItems(body: TikTokSearchResponse): TikTokApiItem[] {
  if (body.data && Array.isArray(body.data)) {
    return body.data.filter((d) => d.type === 1 && d.item?.id).map((d) => d.item!);
  }
  if (body.item_list && Array.isArray(body.item_list)) {
    return body.item_list.filter((i) => i?.id);
  }
  return [];
}

// No cap on collected posts and a much higher empty-scroll tolerance than the
// production scraper's default (3) — "keep scraping" means don't bail early
// just because a few scrolls in a row came back empty.
const MAX_SCROLLS = 1000; // safety ceiling only, not a target
const EMPTY_SCROLL_LIMIT = 8;

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const keyword = process.argv[2] || 'มาส์กวิตซี';
  console.log(`[TikTokKeywordCSV] Searching: "${keyword}"`);

  const collected = new Map<string, TikTokApiItem>();

  const { ctx, cleanup } = await launchContext();
  await warmUp(ctx);

  try {
    const page = await ctx.newPage();

    page.on('response', async (resp) => {
      const url = resp.url();
      if (
        !url.includes('/api/search/') &&
        !url.includes('search_item') &&
        !url.includes('search/general')
      ) return;
      if (!resp.ok()) return;
      try {
        const body = (await resp.json()) as TikTokSearchResponse;
        const items = extractItems(body);
        let added = 0;
        for (const item of items) {
          if (!item?.id || collected.has(item.id)) continue;
          collected.set(item.id, item);
          added++;
        }
        if (added > 0) process.stdout.write(`\r  Collected ${collected.size} posts (+${added})...`);
      } catch { /* ignore parse errors */ }
    });

    const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=1`;
    console.log(`  Navigating: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3_000);

    if (!isSessionValid(page)) {
      console.warn('  Session invalid — run: npm run tiktok:login');
      await page.close();
      return;
    }

    await solveCaptcha(page);

    let emptyScrolls = 0;
    await page.mouse.move(640, 400);
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const before = collected.size;
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(2_500);
      if (i % 3 === 2) await solveCaptcha(page);
      if (collected.size === before) {
        emptyScrolls++;
        if (emptyScrolls >= EMPTY_SCROLL_LIMIT) {
          console.log(`\n  ${EMPTY_SCROLL_LIMIT} empty scrolls in a row — TikTok has no more results, stopping`);
          break;
        }
      } else {
        emptyScrolls = 0;
      }
    }
    console.log();
    await page.close();
  } finally {
    await cleanup();
  }

  console.log(`[TikTokKeywordCSV] Done collecting — ${collected.size} posts total`);

  const header = [
    'post_id', 'author_handle', 'caption', 'views', 'likes', 'shares', 'comments',
    'engagement_rate_pct', 'posted_at', 'hashtags', 'author_followers', 'video_url', 'cover_url', 'post_url',
  ];
  const rows: string[] = [header.join(',')];

  for (const item of collected.values()) {
    const views = item.stats?.playCount ?? 0;
    const likes = item.stats?.diggCount ?? 0;
    const shares = item.stats?.shareCount ?? 0;
    const comments = item.stats?.commentCount ?? 0;
    const engRate = views > 0 ? (((likes + comments + shares) / views) * 100).toFixed(4) : '';
    const postedAt = item.createTime ? new Date(item.createTime * 1000).toISOString() : '';
    const hashtags = (item.challenges ?? []).map((c) => c.title ?? '').filter(Boolean).join(';');
    const handle = item.author?.uniqueId ?? '';
    const postUrl = handle ? `https://www.tiktok.com/@${handle}/video/${item.id}` : '';
    const videoUrl = item.video?.playAddr ?? item.video?.downloadAddr ?? '';
    const coverUrl = item.video?.cover ?? item.video?.dynamicCover ?? item.video?.originCover ?? '';

    rows.push([
      csvEscape(item.id),
      csvEscape(handle),
      csvEscape(item.desc ?? ''),
      csvEscape(views),
      csvEscape(likes),
      csvEscape(shares),
      csvEscape(comments),
      csvEscape(engRate),
      csvEscape(postedAt),
      csvEscape(hashtags),
      csvEscape(item.authorStats?.followerCount ?? ''),
      csvEscape(videoUrl),
      csvEscape(coverUrl),
      csvEscape(postUrl),
    ].join(','));
  }

  const outDir = path.join(process.cwd(), 'scripts', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const safeName = keyword.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40);
  const outPath = path.join(outDir, `tiktok-search-${safeName}-${Date.now()}.csv`);
  fs.writeFileSync(outPath, '﻿' + rows.join('\r\n'), 'utf8'); // BOM so Excel renders Thai correctly

  console.log(`[TikTokKeywordCSV] Wrote ${collected.size} posts → ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
