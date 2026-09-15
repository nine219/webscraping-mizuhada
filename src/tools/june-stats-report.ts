/**
 * Generate a markdown report of everything we scraped in June 2026.
 *
 * Output: docs/stats-june-2026.md
 *
 * Usage:  node -r ts-node/register -r dotenv/config src/tools/june-stats-report.ts dotenv_config_path=.env.local
 */
import * as fs from 'fs';
import * as path from 'path';
import { socialQuery } from '../db/social-client';

const START = '2026-06-01';
const END   = '2026-07-01'; // exclusive upper bound → covers all of June

const OUT_PATH = path.join(process.cwd(), 'docs', `stats-june-2026.md`);

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '—';
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return socialQuery<T>(sql, params);
}

async function main(): Promise<void> {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push(
    `# Mizuhada Social Listening — June 2026 Stats`,
    ``,
    `**Window**: ${START} → 2026-06-30 (inclusive)`,
    `**Generated**: ${new Date().toISOString()}`,
    ``,
    `> All numbers reflect what our scrapers captured — not raw platform totals. Sentiment is Gemini-classified per comment; every un-classified row shows up under "Unclassified".`,
    ``,
  );

  // ── Platform overview ─────────────────────────────────────────────────────
  push(`## 1. Platform overview`, ``);
  const tikTokPosts = await q<{ n: string; feed: string; search: string }>(
    `SELECT COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE source_type IN ('profile','feed'))::text AS feed,
            COUNT(*) FILTER (WHERE source_type = 'search')::text AS search
     FROM tiktok_posts
     WHERE COALESCE(posted_at, scraped_at) >= $1 AND COALESCE(posted_at, scraped_at) < $2`,
    [START, END],
  );
  const igPosts = await q<{ n: string; feed: string; search: string }>(
    `SELECT COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE source_type IN ('profile','feed'))::text AS feed,
            COUNT(*) FILTER (WHERE source_type = 'search')::text AS search
     FROM instagram_posts
     WHERE COALESCE(posted_at, scraped_at) >= $1 AND COALESCE(posted_at, scraped_at) < $2`,
    [START, END],
  );
  const xhsNotes = await q<{ n: string; feed: string; search: string }>(
    `SELECT COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE source_type = 'profile')::text AS feed,
            COUNT(*) FILTER (WHERE source_type = 'search')::text AS search
     FROM xhs_posts
     WHERE COALESCE(published_at, scraped_at) >= $1 AND COALESCE(published_at, scraped_at) < $2`,
    [START, END],
  );
  const commentsByPlatform = await q<{ platform: string; n: string; sent: string }>(
    `SELECT platform,
            COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE sentiment IS NOT NULL)::text AS sent
     FROM social_comments
     WHERE COALESCE(published_at, scraped_at) >= $1 AND COALESCE(published_at, scraped_at) < $2
     GROUP BY platform ORDER BY COUNT(*) DESC`,
    [START, END],
  );

  const tk = tikTokPosts[0]; const ig = igPosts[0]; const xh = xhsNotes[0];
  const cmt = new Map(commentsByPlatform.map((r) => [r.platform, r]));

  push(
    `| Platform | Posts / Notes | Feed (own) | UGC (search) | Comments | Classified |`,
    `|---|---:|---:|---:|---:|---:|`,
    `| TikTok        | ${fmt(+tk.n)} | ${fmt(+tk.feed)} | ${fmt(+tk.search)} | ${fmt(+(cmt.get('tiktok')?.n ?? '0'))}       | ${fmt(+(cmt.get('tiktok')?.sent ?? '0'))} |`,
    `| Instagram     | ${fmt(+ig.n)} | ${fmt(+ig.feed)} | ${fmt(+ig.search)} | ${fmt(+(cmt.get('instagram')?.n ?? '0'))}    | ${fmt(+(cmt.get('instagram')?.sent ?? '0'))} |`,
    `| Xiaohongshu   | ${fmt(+xh.n)} | ${fmt(+xh.feed)} | ${fmt(+xh.search)} | ${fmt(+(cmt.get('xiaohongshu')?.n ?? '0'))}  | ${fmt(+(cmt.get('xiaohongshu')?.sent ?? '0'))} |`,
    `| X (Twitter)   | — (tweets stored as comments) | — | — | ${fmt(+(cmt.get('twitter')?.n ?? '0'))}      | ${fmt(+(cmt.get('twitter')?.sent ?? '0'))} |`,
    ``,
  );

  // ── Per-brand breakdown ───────────────────────────────────────────────────
  push(`## 2. Per-brand mentions`, ``);
  const perBrand = await q<{ brand: string; slug: string; tiktok: string; ig: string; xhs: string; tweets: string; comments: string }>(
    `WITH tp AS (
       SELECT brand_id, COUNT(*) AS n FROM tiktok_posts
       WHERE COALESCE(posted_at, scraped_at) >= $1 AND COALESCE(posted_at, scraped_at) < $2
       GROUP BY brand_id
     ),
     ip AS (
       SELECT brand_id, COUNT(*) AS n FROM instagram_posts
       WHERE COALESCE(posted_at, scraped_at) >= $1 AND COALESCE(posted_at, scraped_at) < $2
       GROUP BY brand_id
     ),
     xp AS (
       SELECT brand_id, COUNT(*) AS n FROM xhs_posts
       WHERE COALESCE(published_at, scraped_at) >= $1 AND COALESCE(published_at, scraped_at) < $2
       GROUP BY brand_id
     ),
     sc AS (
       SELECT brand_id,
              COUNT(*) FILTER (WHERE platform = 'twitter') AS tweets,
              COUNT(*) FILTER (WHERE platform <> 'twitter') AS comments
       FROM social_comments
       WHERE COALESCE(published_at, scraped_at) >= $1 AND COALESCE(published_at, scraped_at) < $2
       GROUP BY brand_id
     )
     SELECT b.name AS brand, b.slug,
            COALESCE(tp.n, 0)::text AS tiktok,
            COALESCE(ip.n, 0)::text AS ig,
            COALESCE(xp.n, 0)::text AS xhs,
            COALESCE(sc.tweets, 0)::text AS tweets,
            COALESCE(sc.comments, 0)::text AS comments
     FROM brands b
     LEFT JOIN tp ON tp.brand_id = b.id
     LEFT JOIN ip ON ip.brand_id = b.id
     LEFT JOIN xp ON xp.brand_id = b.id
     LEFT JOIN sc ON sc.brand_id = b.id
     WHERE b.type = 'own'
     ORDER BY b.name`,
    [START, END],
  );

  push(
    `| Brand | TikTok posts | IG posts | XHS notes | X tweets | Comments (all platforms) |`,
    `|---|---:|---:|---:|---:|---:|`,
    ...perBrand.map((r) =>
      `| ${r.brand} | ${fmt(+r.tiktok)} | ${fmt(+r.ig)} | ${fmt(+r.xhs)} | ${fmt(+r.tweets)} | ${fmt(+r.comments)} |`,
    ),
    ``,
  );

  // ── Sentiment ─────────────────────────────────────────────────────────────
  push(`## 3. Sentiment breakdown (comments + tweets)`, ``);
  const sentiment = await q<{ platform: string; positive: string; negative: string; neutral: string; question: string; unclassified: string }>(
    `SELECT platform,
            COUNT(*) FILTER (WHERE sentiment = 'positive')::text AS positive,
            COUNT(*) FILTER (WHERE sentiment = 'negative')::text AS negative,
            COUNT(*) FILTER (WHERE sentiment = 'neutral')::text  AS neutral,
            COUNT(*) FILTER (WHERE sentiment = 'question')::text AS question,
            COUNT(*) FILTER (WHERE sentiment IS NULL)::text      AS unclassified
     FROM social_comments
     WHERE COALESCE(published_at, scraped_at) >= $1 AND COALESCE(published_at, scraped_at) < $2
     GROUP BY platform ORDER BY platform`,
    [START, END],
  );
  push(
    `| Platform | Positive | Negative | Neutral | Question | Unclassified | Total |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...sentiment.map((s) => {
      const total = +s.positive + +s.negative + +s.neutral + +s.question + +s.unclassified;
      return `| ${s.platform} | ${fmt(+s.positive)} (${pct(+s.positive, total)}) | ${fmt(+s.negative)} (${pct(+s.negative, total)}) | ${fmt(+s.neutral)} | ${fmt(+s.question)} | ${fmt(+s.unclassified)} | ${fmt(total)} |`;
    }),
    ``,
  );

  const sentimentByBrand = await q<{ brand: string; positive: string; negative: string; neutral: string; question: string }>(
    `SELECT b.name AS brand,
            COUNT(*) FILTER (WHERE sc.sentiment = 'positive')::text AS positive,
            COUNT(*) FILTER (WHERE sc.sentiment = 'negative')::text AS negative,
            COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')::text  AS neutral,
            COUNT(*) FILTER (WHERE sc.sentiment = 'question')::text AS question
     FROM social_comments sc
     JOIN brands b ON b.id = sc.brand_id
     WHERE COALESCE(sc.published_at, sc.scraped_at) >= $1
       AND COALESCE(sc.published_at, sc.scraped_at) < $2
       AND b.type = 'own'
     GROUP BY b.name ORDER BY b.name`,
    [START, END],
  );
  push(`### Per own brand`, ``);
  push(
    `| Brand | Positive | Negative | Neutral | Question |`,
    `|---|---:|---:|---:|---:|`,
    ...sentimentByBrand.map((s) => `| ${s.brand} | ${fmt(+s.positive)} | ${fmt(+s.negative)} | ${fmt(+s.neutral)} | ${fmt(+s.question)} |`),
    ``,
  );

  // ── Top posts ─────────────────────────────────────────────────────────────
  push(`## 4. Top TikTok posts by views`, ``);
  const topTiktok = await q<{ brand: string; author_handle: string | null; caption: string | null; views: string; likes: string; comments_count: string; post_id: string; posted_at: string | null }>(
    `SELECT b.name AS brand, tp.author_handle, tp.caption,
            tp.views::text, tp.likes::text, tp.comments_count::text,
            tp.post_id, tp.posted_at::text
     FROM tiktok_posts tp
     JOIN brands b ON b.id = tp.brand_id
     WHERE COALESCE(tp.posted_at, tp.scraped_at) >= $1
       AND COALESCE(tp.posted_at, tp.scraped_at) < $2
     ORDER BY tp.views DESC NULLS LAST
     LIMIT 10`,
    [START, END],
  );
  push(
    `| Brand | Author | Caption (first 60 chars) | Views | Likes | Comments |`,
    `|---|---|---|---:|---:|---:|`,
    ...topTiktok.map((r) =>
      `| ${r.brand} | @${r.author_handle ?? '—'} | ${(r.caption ?? '').replace(/\|/g, '/').slice(0, 60)}${(r.caption?.length ?? 0) > 60 ? '…' : ''} | ${fmt(+r.views)} | ${fmt(+r.likes)} | ${fmt(+r.comments_count)} |`,
    ),
    ``,
  );

  push(`## 5. Top TikTok creators (by mentions)`, ``);
  const topCreators = await q<{ handle: string; mentions: string; total_views: string; brands: string[] }>(
    `SELECT tp.author_handle AS handle,
            COUNT(DISTINCT tp.post_id)::text AS mentions,
            COALESCE(SUM(tp.views), 0)::text AS total_views,
            ARRAY_AGG(DISTINCT b.name) AS brands
     FROM tiktok_posts tp
     JOIN brands b ON b.id = tp.brand_id
     WHERE tp.source_type = 'search'
       AND tp.author_handle IS NOT NULL AND tp.author_handle <> ''
       AND COALESCE(tp.posted_at, tp.scraped_at) >= $1
       AND COALESCE(tp.posted_at, tp.scraped_at) < $2
     GROUP BY tp.author_handle
     HAVING COUNT(DISTINCT tp.post_id) > 1
     ORDER BY COUNT(DISTINCT tp.post_id) DESC, SUM(tp.views) DESC
     LIMIT 10`,
    [START, END],
  );
  push(
    `| Creator | Mentions | Total views | Brands |`,
    `|---|---:|---:|---|`,
    ...topCreators.map((r) => `| @${r.handle} | ${r.mentions} | ${fmt(+r.total_views)} | ${(r.brands ?? []).join(', ')} |`),
    ``,
  );

  // ── Daily trend ───────────────────────────────────────────────────────────
  push(`## 6. Daily mention volume`, ``);
  const daily = await q<{ day: string; tiktok: string; xhs: string; twitter: string; ig: string }>(
    `WITH days AS (SELECT generate_series($1::date, $2::date - INTERVAL '1 day', INTERVAL '1 day')::date AS day),
     tk AS (
       SELECT posted_at::date AS d, COUNT(*) AS n
       FROM tiktok_posts
       WHERE posted_at >= $1 AND posted_at < $2
       GROUP BY 1
     ),
     xh AS (
       SELECT published_at::date AS d, COUNT(*) AS n
       FROM xhs_posts
       WHERE published_at >= $1 AND published_at < $2
       GROUP BY 1
     ),
     tw AS (
       SELECT published_at::date AS d, COUNT(*) AS n
       FROM social_comments
       WHERE platform = 'twitter' AND published_at >= $1 AND published_at < $2
       GROUP BY 1
     ),
     ig AS (
       SELECT posted_at::date AS d, COUNT(*) AS n
       FROM instagram_posts
       WHERE posted_at >= $1 AND posted_at < $2
       GROUP BY 1
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            COALESCE(tk.n, 0)::text AS tiktok,
            COALESCE(xh.n, 0)::text AS xhs,
            COALESCE(tw.n, 0)::text AS twitter,
            COALESCE(ig.n, 0)::text AS ig
     FROM days
     LEFT JOIN tk ON tk.d = days.day
     LEFT JOIN xh ON xh.d = days.day
     LEFT JOIN tw ON tw.d = days.day
     LEFT JOIN ig ON ig.d = days.day
     ORDER BY days.day`,
    [START, END],
  );
  push(
    `| Day | TikTok | Xiaohongshu | X | Instagram |`,
    `|---|---:|---:|---:|---:|`,
    ...daily.map((r) => `| ${r.day} | ${fmt(+r.tiktok)} | ${fmt(+r.xhs)} | ${fmt(+r.twitter)} | ${fmt(+r.ig)} |`),
    ``,
  );

  // ── Spike alerts + engagement ─────────────────────────────────────────────
  push(`## 7. TikTok spike alerts`, ``);
  const spikes = await q<{ brand: string; handle: string | null; views: string; engagement_rate: string | null; detected: string | null; post_id: string }>(
    `SELECT b.name AS brand, tp.author_handle AS handle,
            tp.views::text, tp.engagement_rate::text, tp.spike_detected_at::text, tp.post_id
     FROM tiktok_posts tp
     JOIN brands b ON b.id = tp.brand_id
     WHERE tp.spike_flag = true
       AND tp.spike_detected_at >= $1 AND tp.spike_detected_at < $2
     ORDER BY tp.views DESC NULLS LAST
     LIMIT 20`,
    [START, END],
  );
  if (spikes.length === 0) {
    push(`_No spike alerts fired in June._`, ``);
  } else {
    push(
      `| Brand | Creator | Views | Engagement % | Detected |`,
      `|---|---|---:|---:|---|`,
      ...spikes.map((s) => `| ${s.brand} | @${s.handle ?? '—'} | ${fmt(+s.views)} | ${s.engagement_rate ? Number(s.engagement_rate).toFixed(2) + '%' : '—'} | ${s.detected?.slice(0, 10) ?? '—'} |`),
      ``,
    );
  }

  // ── Topics ────────────────────────────────────────────────────────────────
  push(`## 8. Top comment topics (Gemini-classified)`, ``);
  const topics = await q<{ topic: string; n: string; pos: string; neg: string }>(
    `SELECT topic,
            COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE sentiment = 'positive')::text AS pos,
            COUNT(*) FILTER (WHERE sentiment = 'negative')::text AS neg
     FROM social_comments
     WHERE COALESCE(published_at, scraped_at) >= $1
       AND COALESCE(published_at, scraped_at) < $2
       AND topic IS NOT NULL AND topic <> ''
     GROUP BY topic
     ORDER BY COUNT(*) DESC
     LIMIT 15`,
    [START, END],
  );
  push(
    `| Topic | Total | Positive | Negative |`,
    `|---|---:|---:|---:|`,
    ...topics.map((t) => `| ${t.topic} | ${fmt(+t.n)} | ${fmt(+t.pos)} | ${fmt(+t.neg)} |`),
    ``,
  );

  // ── Post themes (TikTok) ──────────────────────────────────────────────────
  push(`## 9. TikTok post themes (post-theme.ts classifier)`, ``);
  const themes = await q<{ theme: string; n: string }>(
    `SELECT COALESCE(theme, 'unclassified') AS theme,
            COUNT(*)::text AS n
     FROM tiktok_posts
     WHERE COALESCE(posted_at, scraped_at) >= $1 AND COALESCE(posted_at, scraped_at) < $2
     GROUP BY COALESCE(theme, 'unclassified')
     ORDER BY COUNT(*) DESC
     LIMIT 15`,
    [START, END],
  );
  push(
    `| Theme | Posts |`,
    `|---|---:|`,
    ...themes.map((t) => `| ${t.theme} | ${fmt(+t.n)} |`),
    ``,
  );

  // ── Aggregate engagement ──────────────────────────────────────────────────
  push(`## 10. Aggregate engagement`, ``);
  const eng = await q<{ views: string; likes: string; shares: string; comments: string; posts: string; avg_eng: string | null }>(
    `SELECT COALESCE(SUM(views), 0)::text AS views,
            COALESCE(SUM(likes), 0)::text AS likes,
            COALESCE(SUM(shares), 0)::text AS shares,
            COALESCE(SUM(comments_count), 0)::text AS comments,
            COUNT(*)::text AS posts,
            AVG(engagement_rate)::text AS avg_eng
     FROM tiktok_posts
     WHERE COALESCE(posted_at, scraped_at) >= $1 AND COALESCE(posted_at, scraped_at) < $2`,
    [START, END],
  );
  const e = eng[0];
  push(
    `**TikTok** — ${fmt(+e.posts)} posts · ${fmt(+e.views)} total views · ${fmt(+e.likes)} likes · ${fmt(+e.shares)} shares · ${fmt(+e.comments)} comments (metadata) · avg engagement ${e.avg_eng ? Number(e.avg_eng).toFixed(2) + '%' : '—'}`,
    ``,
  );

  // ── Footer ────────────────────────────────────────────────────────────────
  push(
    `---`,
    ``,
    `_Generated by \`src/tools/june-stats-report.ts\` from live production DB. All Gemini sentiment classifications ran on the same 6-month rolling window; older rows are purged nightly._`,
  );

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
  console.log(`✓ wrote ${OUT_PATH}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
