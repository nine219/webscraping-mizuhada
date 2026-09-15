import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { getKeywords } from '../../config/settings-loader';
import { WhereBuilder } from '../../db/where-builder';
import { parseDateRange } from '../parse-date-range';

type DateRange = { days?: number; from?: string; to?: string };
const rangeKey = (r: DateRange): string => (r.from && r.to ? `${r.from}_${r.to}` : `d${r.days ?? 0}`);

const router = Router();

// ── GET /api/tiktok/influencers ────────────────────────────────────────────
// Heavy GROUP BY across tiktok_posts. Cached in-memory for 5min keyed by
// (brand, days, minPosts) — sort is applied AFTER cache hit so re-sorting is free.
// No manual-invalidation endpoint exists — the only ways to force a refresh
// are waiting out the 5min TTL or restarting the API process.
type InfluencerRow = Awaited<ReturnType<typeof computeInfluencers>>[number];
const INFLUENCER_CACHE = new Map<string, { computedAt: number; rows: InfluencerRow[] }>();
const INFLUENCER_CACHE_TTL_MS = 5 * 60_000;
const INFLUENCER_CACHE_MAX = 24;

async function computeInfluencers(opts: { brand?: string; range: DateRange; minPosts: number }): Promise<{
  handle: string; url: string; posts: number; followers: number | null;
  tier: 'nano' | 'micro' | 'mid' | 'macro' | 'mega' | 'unknown';
  total_views: number; best_views: number; total_likes: number;
  avg_engagement_pct: number; follower_engagement_pct: number | null;
  brands: string[]; brand_count: number; last_seen: string | null;
  posts_last_30d: number; is_ambassador: boolean; engagement_outlier: boolean;
  sentiment: { positive: number; negative: number; neutral: number; label: 'positive' | 'negative' | 'mixed' | 'unknown'; positivePct: number | null };
}[]> {
  const { brand, range, minPosts } = opts;
  const kw = await getKeywords();
  // Ambassador accounts (kw.ownInfluencers, e.g. 'nuimizumi') used to be
  // folded into the exclude list below alongside ownHandlesTiktok. Per
  // product decision, ambassadors now stay IN the leaderboard — they're
  // real creators worth tracking, just ones we already work with — and are
  // tagged via is_ambassador below instead of being hidden.
  const excludeHandles = [...kw.ownHandlesTiktok].map((h) => h.toLowerCase());
  const ambassadorHandles = new Set(kw.ownInfluencers.map((h) => h.toLowerCase()));

  // Own + competitor brand TikTok accounts, read live from the `brands`
  // table rather than a hardcoded list — same philosophy as
  // competitors-tab.tsx ("driven by the live brands table, not a hardcoded
  // list"), so adding a new competitor via Settings → Brands automatically
  // excludes their account from the creator leaderboard too, no code
  // change needed. Kept as a separate clause alongside the static
  // ownHandlesTiktok exclusion above (belt-and-suspenders) — the two
  // mostly overlap for own brands, but the live table is the authoritative
  // source going forward (e.g. it already includes herhynessbeauty, which
  // the static keywords list has no concept of).
  const brandHandleRows = await query<{ tiktok_handle: string }>(
    `SELECT tiktok_handle FROM brands WHERE tiktok_handle IS NOT NULL`,
  );
  const liveBrandHandles = brandHandleRows.map((b) => b.tiktok_handle.toLowerCase());

  const wb = new WhereBuilder([
    `tp.source_type = 'search'`,
    `tp.author_handle IS NOT NULL AND tp.author_handle <> ''`,
  ]);
  wb.add('LOWER(tp.author_handle) <> ALL(?::text[])', excludeHandles);
  wb.add('LOWER(tp.author_handle) <> ALL(?::text[])', liveBrandHandles);
  wb.dateRange('COALESCE(tp.posted_at, tp.scraped_at)', range);
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  const havingIdx = wb.nextIndex;
  wb.pushValues(minPosts);
  const params = wb.values;

  const rows = await query<{
    handle: string; posts: string; followers: string | null;
    total_views: string; best_views: string; total_likes: string;
    avg_engagement_pct: string | null; brands: string[]; brand_count: string;
    last_seen: string | null; posts_last_30d: string;
    sent_positive: string; sent_negative: string; sent_neutral: string;
  }>(
    `WITH posts AS (
       SELECT tp.author_handle      AS handle,
              tp.post_id,
              tp.views, tp.likes, tp.shares, tp.comments_count,
              tp.author_followers, tp.posted_at, tp.scraped_at,
              b.slug AS brand_slug
       FROM tiktok_posts tp
       JOIN brands b ON b.id = tp.brand_id
       WHERE ${wb.where}
     ),
     latest_followers AS (
       SELECT DISTINCT ON (handle) handle, author_followers
       FROM posts
       WHERE author_followers IS NOT NULL
       ORDER BY handle, COALESCE(posted_at, scraped_at) DESC
     ),
     comment_sentiment AS (
       -- Sentiment of comments left under this creator's posts about our brands —
       -- reuses the same post set as the posts CTE above (already deduped by handle/date/brand).
       SELECT p.handle,
              COUNT(*) FILTER (WHERE sc.sentiment = 'positive') AS positive,
              COUNT(*) FILTER (WHERE sc.sentiment = 'negative') AS negative,
              COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')  AS neutral
       FROM posts p
       JOIN social_comments sc ON sc.post_id = p.post_id AND sc.platform = 'tiktok' AND sc.sentiment IS NOT NULL
         AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
       GROUP BY p.handle
     )
     SELECT p.handle,
            COUNT(DISTINCT p.post_id)::text                          AS posts,
            lf.author_followers::text                                 AS followers,
            COALESCE(SUM(p.views), 0)::text                           AS total_views,
            COALESCE(MAX(p.views), 0)::text                           AS best_views,
            COALESCE(SUM(p.likes), 0)::text                           AS total_likes,
            COALESCE(AVG(
              CASE WHEN p.views > 0
                THEN ((p.likes + p.shares + p.comments_count)::numeric / p.views) * 100
                ELSE NULL END
            ), 0)::text                                               AS avg_engagement_pct,
            ARRAY_AGG(DISTINCT p.brand_slug)                          AS brands,
            COUNT(DISTINCT p.brand_slug)::text                        AS brand_count,
            MAX(COALESCE(p.posted_at, p.scraped_at))::text            AS last_seen,
            -- Trailing-30-day post count — a consistency signal alongside raw
            -- mention totals: "recurring creator" vs. "one-off mention long ago".
            COALESCE(COUNT(DISTINCT p.post_id) FILTER (
              WHERE COALESCE(p.posted_at, p.scraped_at) >= NOW() - INTERVAL '30 days'
            ), 0)::text                                               AS posts_last_30d,
            COALESCE(MAX(cs.positive), 0)::text                       AS sent_positive,
            COALESCE(MAX(cs.negative), 0)::text                       AS sent_negative,
            COALESCE(MAX(cs.neutral), 0)::text                        AS sent_neutral
     FROM posts p
     LEFT JOIN latest_followers lf USING (handle)
     LEFT JOIN comment_sentiment cs USING (handle)
     GROUP BY p.handle, lf.author_followers
     HAVING COUNT(DISTINCT p.post_id) >= $${havingIdx}`,
    params,
  );

  const tierOf = (f: number | null): 'nano' | 'micro' | 'mid' | 'macro' | 'mega' | 'unknown' => {
    if (f == null) return 'unknown';
    if (f < 10_000) return 'nano';
    if (f < 100_000) return 'micro';
    if (f < 500_000) return 'mid';
    if (f < 1_000_000) return 'macro';
    return 'mega';
  };

  const mapped = rows.map((r) => {
    const posts = Number(r.posts);
    const followers = r.followers == null ? null : Number(r.followers);
    const totalViews = Number(r.total_views);
    const bestViews = Number(r.best_views);
    const totalLikes = Number(r.total_likes);
    const avgEng = Number(r.avg_engagement_pct ?? 0);
    const followerEng = followers && followers > 0
      ? Number(((totalLikes / posts / followers) * 100).toFixed(2))
      : null;
    const sentPositive = Number(r.sent_positive);
    const sentNegative = Number(r.sent_negative);
    const sentNeutral = Number(r.sent_neutral);
    // Plain majority of positive vs. negative comments (neutral excluded from
    // the ratio — it's not a lean either way): e.g. 64% positive → "positive".
    // "unknown" means no classified comments exist yet (not zero sentiment);
    // "mixed" covers an exact 50/50 split or zero pos+neg with neutral present.
    let sentimentLabel: 'positive' | 'negative' | 'mixed' | 'unknown' = 'unknown';
    let sentimentPct: number | null = null;
    if (sentPositive + sentNegative + sentNeutral > 0) {
      const posNegTotal = sentPositive + sentNegative;
      if (posNegTotal > 0) {
        const positivePct = (sentPositive / posNegTotal) * 100;
        sentimentPct = Math.round(positivePct);
        if (positivePct > 50) sentimentLabel = 'positive';
        else if (positivePct < 50) sentimentLabel = 'negative';
        else sentimentLabel = 'mixed';
      } else {
        sentimentLabel = 'mixed';
      }
    }
    return {
      handle: r.handle,
      url: `https://www.tiktok.com/@${r.handle}`,
      posts,
      followers,
      tier: tierOf(followers),
      total_views: totalViews,
      best_views: bestViews,
      total_likes: totalLikes,
      avg_engagement_pct: Number(avgEng.toFixed(2)),
      follower_engagement_pct: followerEng,
      brands: r.brands ?? [],
      brand_count: Number(r.brand_count),
      last_seen: r.last_seen,
      posts_last_30d: Number(r.posts_last_30d),
      is_ambassador: ambassadorHandles.has(r.handle.toLowerCase()),
      sentiment: { positive: sentPositive, negative: sentNegative, neutral: sentNeutral, label: sentimentLabel, positivePct: sentimentPct },
    };
  });

  // Basic authenticity signal, not a hard filter — a human still decides
  // whether to act on it. Flags creators whose engagement rate is a large
  // multiple of the median across this result set: the classic shape of
  // bought/bot engagement (likes+shares+comments inflated relative to
  // views) rather than organic reach. 5x is deliberately generous — this
  // is meant to catch only egregious outliers, not creators who simply had
  // one unusually good post. Skipped for small result sets (<5 creators)
  // since a median from 2-3 data points is noise, not signal.
  const OUTLIER_MULTIPLIER = 5;
  const MIN_CREATORS_FOR_MEDIAN = 5;
  let medianEngagement = 0;
  if (mapped.length >= MIN_CREATORS_FOR_MEDIAN) {
    const sortedEng = mapped.map((r) => r.avg_engagement_pct).sort((a, b) => a - b);
    const mid = Math.floor(sortedEng.length / 2);
    medianEngagement = sortedEng.length % 2 === 0
      ? (sortedEng[mid - 1] + sortedEng[mid]) / 2
      : sortedEng[mid];
  }

  return mapped.map((r) => ({
    ...r,
    engagement_outlier: medianEngagement > 0 && r.avg_engagement_pct > medianEngagement * OUTLIER_MULTIPLIER,
  }));
}

router.get('/influencers', async (req: Request, res: Response) => {
  const brand = typeof req.query.brand === 'string' ? req.query.brand : undefined;
  const range = parseDateRange(req.query as Record<string, string>, 90);
  const sort = typeof req.query.sort === 'string' ? req.query.sort.split(':')[0] : 'posts';
  const minPosts = Math.max(1, parseInt(String(req.query.minPosts ?? '1'), 10) || 1);
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  const tier = typeof req.query.tier === 'string' ? req.query.tier : '';
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const perPage = Math.max(1, Math.min(200, parseInt(String(req.query.perPage ?? '50'), 10) || 50));

  const cacheKey = `${brand ?? ''}|${rangeKey(range)}|${minPosts}`;
  let cached = INFLUENCER_CACHE.get(cacheKey);
  const stale = !cached || (Date.now() - cached.computedAt) > INFLUENCER_CACHE_TTL_MS;
  if (stale) {
    const t0 = Date.now();
    const rows = await computeInfluencers({ brand, range, minPosts });
    cached = { computedAt: Date.now(), rows };
    INFLUENCER_CACHE.set(cacheKey, cached);
    // Drop oldest entries when the map gets too large
    if (INFLUENCER_CACHE.size > INFLUENCER_CACHE_MAX) {
      const oldestKey = INFLUENCER_CACHE.keys().next().value;
      if (oldestKey) INFLUENCER_CACHE.delete(oldestKey);
    }
    console.log(`[influencers] computed ${rows.length} rows in ${Date.now() - t0}ms (key=${cacheKey})`);
  }
  let influencers = cached!.rows.slice();

  // Search filter (case-insensitive handle substring match)
  if (search) {
    influencers = influencers.filter((r) => r.handle.toLowerCase().includes(search));
  }

  // Compute aggregate stats from the full filtered set (before tier / pagination)
  const tierCounts: Record<string, number> = {};
  for (const k of ['nano', 'micro', 'mid', 'macro', 'mega', 'unknown']) tierCounts[k] = 0;
  let mostMentions: typeof influencers[number] | null = null;
  let mostViews: typeof influencers[number] | null = null;
  let multiBrandCount = 0;
  for (const r of influencers) {
    tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
    if (!mostMentions || r.posts > mostMentions.posts) mostMentions = r;
    if (!mostViews || (r.total_views ?? 0) > (mostViews.total_views ?? 0)) mostViews = r;
    if (r.brand_count >= 2) multiBrandCount++;
  }

  // Tier filter (applied after aggregate stats)
  if (tier) {
    influencers = influencers.filter((r) => r.tier === tier);
  }

  const sortKey: Record<string, (a: typeof influencers[number], b: typeof influencers[number]) => number> = {
    engagement: (a, b) => b.avg_engagement_pct - a.avg_engagement_pct,
    followers:  (a, b) => (b.followers ?? -1) - (a.followers ?? -1),
    posts:      (a, b) => b.posts - a.posts,
    views:      (a, b) => b.total_views - a.total_views,
  };
  influencers.sort(sortKey[sort] ?? sortKey.posts);

  const total = influencers.length;
  const offset = (page - 1) * perPage;
  const paged = influencers.slice(offset, offset + perPage);

  res.json({
    influencers: paged, total, page, perPage,
    tierCounts,
    headline: {
      mostMentions: mostMentions ? { handle: mostMentions.handle, url: mostMentions.url, posts: mostMentions.posts, followers: mostMentions.followers, avg_engagement_pct: mostMentions.avg_engagement_pct } : null,
      mostViews: mostViews ? { handle: mostViews.handle, url: mostViews.url, total_views: mostViews.total_views, posts: mostViews.posts, followers: mostViews.followers } : null,
      multiBrandCount,
    },
  });
});

// ── GET /api/tiktok/creators/:handle ────────────────────────────────────────
// Per-creator detail page: aggregate stats + recent posts mentioning our brands.
// Handle lookup is case-insensitive.
router.get('/creators/:handle', async (req: Request, res: Response) => {
  // Strip leading @ so both /creators/foo and /creators/@foo work from links.
  const rawHandle = String(req.params.handle ?? '').replace(/^@+/, '').trim();
  if (!rawHandle) { res.status(400).json({ error: 'handle required' }); return; }

  try {
    // This route is a direct single-handle lookup, not a leaderboard scan —
    // it has no exclusion list of its own (unlike computeInfluencers above),
    // so there's nothing to extend with the dynamic brands-table check;
    // looking up a brand's own handle here just returns that handle's raw
    // post stats, same as before. is_ambassador IS worth computing, though
    // — it's a single-handle membership test with no population needed —
    // so the detail page can show the same "Ambassador" tag as the
    // leaderboard.
    const kw = await getKeywords();
    const isAmbassador = kw.ownInfluencers.some((h) => h.toLowerCase() === rawHandle.toLowerCase());

    const agg = await query<{
      handle: string; posts: string; followers: string | null;
      total_views: string; total_likes: string; total_shares: string; total_comments: string;
      avg_engagement_pct: string | null;
      first_seen: string | null; last_seen: string | null;
      brands: string[]; posts_last_30d: string;
    }>(
      `WITH posts AS (
         SELECT tp.author_handle AS handle,
                tp.post_id, tp.views, tp.likes, tp.shares, tp.comments_count,
                tp.author_followers, tp.posted_at, tp.scraped_at,
                b.slug AS brand_slug
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE tp.source_type = 'search'
           AND LOWER(tp.author_handle) = LOWER($1)
       )
       SELECT $1 AS handle,
              COUNT(DISTINCT post_id)::text                          AS posts,
              MAX(author_followers)::text                             AS followers,
              COALESCE(SUM(views), 0)::text                           AS total_views,
              COALESCE(SUM(likes), 0)::text                           AS total_likes,
              COALESCE(SUM(shares), 0)::text                          AS total_shares,
              COALESCE(SUM(comments_count), 0)::text                  AS total_comments,
              COALESCE(AVG(
                CASE WHEN views > 0
                  THEN ((likes + shares + comments_count)::numeric / views) * 100
                  ELSE NULL END
              ), 0)::text                                             AS avg_engagement_pct,
              MIN(COALESCE(posted_at, scraped_at))::text              AS first_seen,
              MAX(COALESCE(posted_at, scraped_at))::text              AS last_seen,
              COALESCE(ARRAY_AGG(DISTINCT brand_slug), '{}')          AS brands,
              COALESCE(COUNT(DISTINCT post_id) FILTER (
                WHERE COALESCE(posted_at, scraped_at) >= NOW() - INTERVAL '30 days'
              ), 0)::text                                             AS posts_last_30d
       FROM posts`,
      [rawHandle],
    );

    const a = agg[0];
    if (!a || Number(a.posts) === 0) {
      res.status(404).json({ error: 'creator not found or no posts mentioning own brands' });
      return;
    }

    const posts = await query<{
      id: number; post_id: string; caption: string | null; hashtags: string[] | null;
      views: string; likes: string; shares: string; comments_count: string;
      engagement_rate: string | null; posted_at: string | null; spike_flag: boolean;
      brand_name: string; brand_slug: string; theme: string | null;
    }>(
      `SELECT tp.id, tp.post_id, tp.caption, tp.hashtags,
              tp.views, tp.likes, tp.shares, tp.comments_count,
              tp.engagement_rate, tp.posted_at, tp.spike_flag,
              tp.theme, b.name AS brand_name, b.slug AS brand_slug
       FROM tiktok_posts tp
       JOIN brands b ON b.id = tp.brand_id
       WHERE tp.source_type = 'search'
         AND LOWER(tp.author_handle) = LOWER($1)
       ORDER BY tp.posted_at DESC NULLS LAST
       LIMIT 100`,
      [rawHandle],
    );

    const followers = a.followers == null ? null : Number(a.followers);
    const tierOf = (f: number | null): 'nano' | 'micro' | 'mid' | 'macro' | 'mega' | 'unknown' => {
      if (f == null) return 'unknown';
      if (f < 10_000) return 'nano';
      if (f < 100_000) return 'micro';
      if (f < 500_000) return 'mid';
      if (f < 1_000_000) return 'macro';
      return 'mega';
    };

    // Sentiment on comments under THIS creator's posts about our brands — the
    // clearest "would sponsoring them land well" signal we have. Joins on
    // brand_id too — a post mentioning multiple own brands gets one tiktok_posts
    // row per brand, and without the brand_id match this would double-count a
    // comment's sentiment once per brand mentioned.
    const sentimentRows = await query<{ sentiment: string; cnt: string }>(
      `SELECT sc.sentiment, COUNT(*)::text AS cnt
       FROM social_comments sc
       JOIN tiktok_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id AND sc.platform = 'tiktok'
       WHERE LOWER(tp.author_handle) = LOWER($1) AND tp.source_type = 'search'
         AND sc.sentiment IS NOT NULL
         AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
       GROUP BY sc.sentiment`,
      [rawHandle],
    );
    const sentiment = { positive: 0, negative: 0, neutral: 0, question: 0 };
    for (const row of sentimentRows) {
      const s = row.sentiment as keyof typeof sentiment;
      if (s in sentiment) sentiment[s] = parseInt(row.cnt, 10);
    }

    // Topic breakdown within positive/negative comments only — feeds the
    // click-through on the sentiment donut ("what are people praising/complaining about").
    const topicRows = await query<{ sentiment: string; topic: string; cnt: string }>(
      `SELECT sc.sentiment, sc.topic, COUNT(*)::text AS cnt
       FROM social_comments sc
       JOIN tiktok_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id AND sc.platform = 'tiktok'
       WHERE LOWER(tp.author_handle) = LOWER($1) AND tp.source_type = 'search'
         AND sc.sentiment IN ('positive', 'negative') AND sc.topic IS NOT NULL
         AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
       GROUP BY sc.sentiment, sc.topic
       ORDER BY cnt DESC`,
      [rawHandle],
    );
    const positiveTopics: { topic: string; count: number }[] = [];
    const negativeTopics: { topic: string; count: number }[] = [];
    for (const row of topicRows) {
      const bucket = row.sentiment === 'positive' ? positiveTopics : row.sentiment === 'negative' ? negativeTopics : null;
      bucket?.push({ topic: row.topic, count: parseInt(row.cnt, 10) });
    }

    res.json({
      creator: {
        handle: rawHandle,
        url: `https://www.tiktok.com/@${rawHandle}`,
        followers,
        tier: tierOf(followers),
        posts: Number(a.posts),
        total_views: Number(a.total_views),
        total_likes: Number(a.total_likes),
        total_shares: Number(a.total_shares),
        total_comments: Number(a.total_comments),
        avg_engagement_pct: Number(Number(a.avg_engagement_pct ?? 0).toFixed(2)),
        brands: a.brands ?? [],
        first_seen: a.first_seen,
        last_seen: a.last_seen,
        posts_last_30d: Number(a.posts_last_30d),
        is_ambassador: isAmbassador,
        sentiment: { ...sentiment, positiveTopics, negativeTopics },
      },
      posts: posts.map((p) => ({
        id: p.id,
        post_id: p.post_id,
        post_url: `https://www.tiktok.com/@${rawHandle}/video/${p.post_id}`,
        caption: p.caption,
        hashtags: p.hashtags ?? [],
        views: parseInt(p.views, 10) || 0,
        likes: parseInt(p.likes, 10) || 0,
        shares: parseInt(p.shares, 10) || 0,
        comments_count: parseInt(p.comments_count, 10) || 0,
        engagement_rate: p.engagement_rate ? parseFloat(p.engagement_rate) : 0,
        posted_at: p.posted_at,
        spike_flag: p.spike_flag,
        theme: p.theme,
        brand_name: p.brand_name,
        brand_slug: p.brand_slug,
      })),
    });
  } catch (err) {
    console.error('[creators/:handle]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
