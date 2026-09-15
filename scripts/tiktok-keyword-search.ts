/**
 * Standalone TikTok keyword search → CSV export.
 * No DB required. Metadata only (no comment scraping).
 *
 * Usage:
 *   npx ts-node scripts/tiktok-keyword-search.ts "keyword1" "keyword2"
 *   npx ts-node scripts/tiktok-keyword-search.ts --out results.csv --max 100 "มิซึมิ" "mizumi"
 *
 * Options:
 *   --out <file>   Output CSV path (default: tiktok-search-YYYYMMDD-HHmm.csv)
 *   --max <n>      Max posts per keyword (default: 200)
 *   --scrolls <n>  Max scroll rounds per keyword (default: 15)
 */

import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { TikTokBrowser } from '../src/scrapers/tiktok/tiktok-browser';
import { buildCookieHeader } from '../src/scrapers/tiktok/tiktok-auth';

// ── Types (mirrors tiktok-search.ts) ─────────────────────────────────────────

interface TikTokApiItem {
  id: string;
  desc: string;
  createTime: number;
  author?: { uniqueId?: string; nickname?: string };
  stats?: {
    playCount?: number;
    diggCount?: number;
    shareCount?: number;
    commentCount?: number;
  };
  challenges?: Array<{ title?: string }>;
}

interface SearchResponse {
  item_list?: TikTokApiItem[];
  data?: Array<{ type?: number; item?: TikTokApiItem }>;
}

interface Row {
  post_id:      string;
  keyword:      string;
  author:       string;
  nickname:     string;
  caption:      string;
  hashtags:     string;
  views:        number;
  likes:        number;
  shares:       number;
  comments:     number;
  engagement:   string;
  posted_at:    string;
  post_url:     string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractItems(body: SearchResponse): TikTokApiItem[] {
  if (body.data) return body.data.filter((d) => d.type === 1 && d.item?.id).map((d) => d.item!);
  if (body.item_list) return body.item_list.filter((i) => i?.id);
  return [];
}

function escapeCsv(val: string | number): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Row[]): string {
  const headers: (keyof Row)[] = [
    'post_id', 'keyword', 'author', 'nickname', 'caption', 'hashtags',
    'views', 'likes', 'shares', 'comments', 'engagement', 'posted_at', 'post_url',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCsv(r[h])).join(','));
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let outFile = '';
  let maxPosts = 200;
  let maxScrolls = 15;
  const keywords: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) { outFile = args[++i]; }
    else if (args[i] === '--max' && args[i + 1]) { maxPosts = parseInt(args[++i], 10); }
    else if (args[i] === '--scrolls' && args[i + 1]) { maxScrolls = parseInt(args[++i], 10); }
    else if (!args[i].startsWith('--') && !/^\w+=/.test(args[i])) { keywords.push(args[i]); }
  }

  if (keywords.length === 0) {
    console.error('Usage: ts-node scripts/tiktok-keyword-search.ts [--out file.csv] [--max N] [--scrolls N] "keyword1" "keyword2" ...');
    process.exit(1);
  }

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  if (!outFile) outFile = `tiktok-search-${stamp}.csv`;

  const cookieHeader = buildCookieHeader();
  if (!cookieHeader) {
    console.error('No TIKTOK_COOKIE_HEADER in .env.local — required');
    process.exit(1);
  }

  console.log(`Keywords: ${keywords.join(', ')}`);
  console.log(`Max posts/keyword: ${maxPosts} | Max scrolls: ${maxScrolls}`);
  console.log(`Output: ${outFile}\n`);

  const browser = new TikTokBrowser();
  const ctx = await browser.launch(cookieHeader);
  await browser.warmUp();

  const allRows: Row[] = [];

  try {
    for (const keyword of keywords) {
      const collected = new Map<string, TikTokApiItem>();
      console.log(`\n[search] "${keyword}"`);

      const page = await ctx.newPage();

      page.on('response', async (resp) => {
        const url = resp.url();
        if (!url.includes('/api/search/') && !url.includes('search_item') && !url.includes('search/general')) return;
        if (!resp.ok()) return;
        try {
          const body = await resp.json() as SearchResponse;
          const items = extractItems(body);
          let added = 0;
          for (const item of items) {
            if (!item?.id || collected.size >= maxPosts) continue;
            if (!collected.has(item.id)) { collected.set(item.id, item); added++; }
          }
          if (added > 0) process.stdout.write(`\r  Collected ${collected.size} posts...`);
        } catch { /* ignore */ }
      });

      const url = `https://www.tiktok.com/search/video?q=${encodeURIComponent(keyword)}&t=1`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3_000);

      if (!TikTokBrowser.isSessionValid(page)) {
        console.warn(`\n  Session invalid — skipping keyword`);
        await page.close();
        continue;
      }

      await TikTokBrowser.solveCaptcha(page);
      await page.mouse.move(640, 400);

      let emptyRounds = 0;
      for (let i = 0; i < maxScrolls; i++) {
        if (collected.size >= maxPosts) break;
        const before = collected.size;
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(2_500);
        if (i % 3 === 2) await TikTokBrowser.solveCaptcha(page);
        if (collected.size === before) {
          emptyRounds++;
          if (emptyRounds >= 3) { console.log(`\n  3 empty scrolls — stopping`); break; }
        } else {
          emptyRounds = 0;
        }
      }

      await page.close();
      console.log(`\n  → ${collected.size} posts collected`);

      // Convert to rows
      for (const item of collected.values()) {
        const views    = item.stats?.playCount  ?? 0;
        const likes    = item.stats?.diggCount  ?? 0;
        const shares   = item.stats?.shareCount ?? 0;
        const comments = item.stats?.commentCount ?? 0;
        const eng      = views > 0 ? (((likes + shares + comments) / views) * 100).toFixed(2) : '0.00';
        const hashtags = (item.challenges ?? []).map((c) => c.title ?? '').filter(Boolean).join(' ');
        const handle   = item.author?.uniqueId ?? '';
        const postedAt = item.createTime
          ? new Date(item.createTime * 1000).toISOString().replace('T', ' ').slice(0, 19)
          : '';
        const postUrl  = handle
          ? `https://www.tiktok.com/@${handle}/video/${item.id}`
          : `https://www.tiktok.com/video/${item.id}`;

        allRows.push({
          post_id:    item.id,
          keyword,
          author:     handle,
          nickname:   item.author?.nickname ?? '',
          caption:    item.desc ?? '',
          hashtags,
          views, likes, shares, comments,
          engagement: `${eng}%`,
          posted_at:  postedAt,
          post_url:   postUrl,
        });
      }

      if (keyword !== keywords[keywords.length - 1]) await new Promise((r) => setTimeout(r, 5_000));
    }
  } finally {
    await browser.close();
  }

  // Dedupe by post_id (keep first keyword match)
  const seen = new Set<string>();
  const dedupedRows = allRows.filter((r) => { if (seen.has(r.post_id)) return false; seen.add(r.post_id); return true; });

  const csv = rowsToCsv(dedupedRows);
  fs.writeFileSync(path.resolve(outFile), csv, 'utf8');

  console.log(`\nDone. ${dedupedRows.length} unique posts → ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
