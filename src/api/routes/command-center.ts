import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';
import { WhereBuilder } from '../../db/where-builder';
import { classifyPostThemes, CONTENT_THEMES, ContentTheme } from '../../analysis/post-theme';
import { getKeywords } from '../../config/settings-loader';
import { parseDateRange, describeRange, resolveWindowWithPrior, DateRange } from '../parse-date-range';

// Backend for two dashboard pages: /overview (CommandCenterPage — KPIs, brand
// sentiment, insight feed, topic matrix, negative-comment volume) and /ugc
// (UGC Performance — reuses /top-ugc). Formerly named marketing.ts, which
// didn't describe what's actually here.

// Handles excluded from UGC + influencer surfaces (own brands + already-engaged creators).
// Settings-backed (Settings → Keywords → own brand handles), not a hardcoded constant —
// loadSettings() caches for 60s internally so calling this per-request is cheap.
async function getExcludedUgcHandles(): Promise<string[]> {
  const kw = await getKeywords();
  return [...kw.ownHandlesTiktok, ...kw.ownInfluencers].map((h) => h.toLowerCase());
}

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────
// Per SCOPE v3 (rescope): no invented aggregate scores. Display raw counts only.
// Stakeholders interpret raw numbers; we do not synthesise "health" or "risk" composites.

interface BrandAgg {
  slug: string;
  name: string;
  p: number;
  n: number;
  u: number;
}

/** Per own-brand classified-comment counts over `range`. */
async function brandSentiment(range: DateRange, brand?: string): Promise<BrandAgg[]> {
  const wb = new WhereBuilder([]);
  wb.dateRange('sc.published_at', range);
  const brandIdx = wb.nextIndex;
  const rows = await query<{ slug: string; name: string; p: string; n: string; u: string }>(
    `SELECT b.slug, b.name,
       COUNT(*) FILTER (WHERE sc.sentiment = 'positive') AS p,
       COUNT(*) FILTER (WHERE sc.sentiment = 'negative') AS n,
       COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')  AS u
     FROM brands b
     LEFT JOIN social_comments sc
       ON sc.brand_id = b.id AND ${wb.where}
       AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
     WHERE b.type = 'own'
       AND ($${brandIdx}::text IS NULL OR b.slug = $${brandIdx})
     GROUP BY b.slug, b.name
     ORDER BY b.name`,
    [...wb.values, brand ?? null],
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    p: parseInt(r.p, 10),
    n: parseInt(r.n, 10),
    u: parseInt(r.u, 10),
  }));
}

// ── GET /api/command-center/overview ────────────────────────────────────────
// Command Center top-of-page: KPI cards, brand-health bars, insight feed.
router.get('/overview', async (req: Request, res: Response) => {
  const range = parseDateRange(req.query as Record<string, string>, 30);
  const window = resolveWindowWithPrior(range);
  // Command Center previously had no brand filter at all — every other main
  // page (Social Listening, TikTok/XHS/Instagram/X, UGC Performance) has one.
  // Narrows every KPI/insight/chart on this page to one own-brand; undefined
  // (All Brands) keeps the existing cross-brand aggregate behavior.
  const brand = (req.query.brand as string | undefined) || undefined;

  try {
    const excludedHandles = await getExcludedUgcHandles();

    const engWb = new WhereBuilder([]);
    engWb.dateRange('tp.posted_at', range);
    const engBrandIdx = engWb.nextIndex;
    const platWb = new WhereBuilder([`b.type = 'own'`]);
    platWb.dateRange('sc.published_at', range);
    const platBrandIdx = platWb.nextIndex;

    const [sent, engRows, mentionRows, xMentionRows, spikeRows, platformRows] = await Promise.all([
      brandSentiment(range, brand),
      // Per-brand avg engagement over the window
      query<{ slug: string; avg_eng: string | null }>(
        `SELECT b.slug, AVG(tp.engagement_rate) AS avg_eng
         FROM brands b
         LEFT JOIN tiktok_posts tp
           ON tp.brand_id = b.id AND ${engWb.where}
         WHERE b.type = 'own'
           AND ($${engBrandIdx}::text IS NULL OR b.slug = $${engBrandIdx})
         GROUP BY b.slug`,
        [...engWb.values, brand ?? null],
      ),
      // Social mentions (UGC search posts) in the selected window vs the preceding window of equal length.
      // Same filters as GET /top-ugc (brand join, excluded handles, engagement sanity cap) so this KPI
      // and the UGC page's "Total UGC Posts" count always agree — see docs/agents notes on the mismatch.
      query<{ recent: string; prior: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE tp.posted_at >= $1 AND tp.posted_at <= $4) AS recent,
           COUNT(*) FILTER (WHERE tp.posted_at >= $3 AND tp.posted_at < $1) AS prior
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE tp.source_type = 'search'
           AND LOWER(COALESCE(tp.author_handle, '')) <> ALL($2::text[])
           AND (tp.engagement_rate IS NULL OR tp.engagement_rate <= 100)
           AND ($5::text IS NULL OR b.slug = $5)`,
        [window.from, excludedHandles, window.priorFrom, window.to, brand ?? null],
      ),
      // X/Twitter equivalent of the TikTok UGC-mentions KPI above — own-account
      // posts already excluded at scrape time (twitter-search.ts checks
      // settings.keywords.ownHandlesTwitter before insert), so no read-time
      // handle filter needed here unlike the TikTok query.
      query<{ recent: string; prior: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE sc.published_at >= $1 AND sc.published_at <= $3) AS recent,
           COUNT(*) FILTER (WHERE sc.published_at >= $2 AND sc.published_at < $1) AS prior
         FROM social_comments sc
         JOIN brands b ON b.id = sc.brand_id
         WHERE sc.platform = 'twitter' AND sc.source_type = 'search' AND b.type = 'own'
           AND ($4::text IS NULL OR b.slug = $4)`,
        [window.from, window.priorFrom, window.to, brand ?? null],
      ),
      // Recent engagement spikes → insight feed. Capped at the last 7 days —
      // this feed is "what's fresh right now," not a full spike archive
      // (that's the TikTok Viral tab's job). Only narrows further if the
      // page's own date filter is already tighter than 7 days (e.g. Today,
      // 3D); a wider filter (30D/90D/All time) does NOT pull older spikes
      // into this feed. Viral-tier filtering happens after the query, once
      // thresholds are loaded below.
      query<{
        post_id: string; caption: string | null; author_handle: string | null;
        views: string; engagement_rate: string | null; brand_name: string; brand_slug: string; spike_detected_at: string | null;
      }>(
        `SELECT tp.post_id, tp.caption, tp.author_handle, tp.views, tp.engagement_rate,
                b.name AS brand_name, b.slug AS brand_slug, tp.spike_detected_at
         FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
         WHERE tp.spike_flag = true AND b.type = 'own'
           AND tp.spike_detected_at >= $1 AND tp.spike_detected_at <= $2
           AND ($3::text IS NULL OR b.slug = $3)
         ORDER BY tp.spike_detected_at DESC
         LIMIT 20`,
        [
          new Date(Math.max(window.from.getTime(), window.to.getTime() - 7 * 86_400_000)),
          window.to,
          brand ?? null,
        ],
      ),
      // Mentions by platform — Executive Digest platform mix + per-platform
      // sentiment split, so "Negative Mentions" / "Sentiment Split" (both
      // cross-platform aggregates) can be broken out per platform in the UI.
      query<{ platform: string; count: string; positive: string; negative: string; neutral: string }>(
        `SELECT sc.platform, COUNT(*) AS count,
                COUNT(*) FILTER (WHERE sc.sentiment = 'positive') AS positive,
                COUNT(*) FILTER (WHERE sc.sentiment = 'negative') AS negative,
                COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')  AS neutral
         FROM social_comments sc
         JOIN brands b ON b.id = sc.brand_id
         WHERE ${platWb.where}
           AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')
           AND ($${platBrandIdx}::text IS NULL OR b.slug = $${platBrandIdx})
         GROUP BY sc.platform
         ORDER BY count DESC`,
        [...platWb.values, brand ?? null],
      ),
    ]);

    const engMap = Object.fromEntries(engRows.map((r) => [r.slug, parseFloat(r.avg_eng ?? '0') || 0]));

    // Per-brand raw summary (no composite scores). Stakeholders read raw counts.
    const brandSummary = sent.map((b) => {
      const avgEng = engMap[b.slug] ?? 0;
      const classified = b.p + b.n + b.u;
      return {
        slug: b.slug,
        name: b.name,
        positive: b.p,
        negative: b.n,
        neutral: b.u,
        classified,
        avg_engagement: Math.round(avgEng * 10) / 10,
      };
    });

    // KPIs ------------------------------------------------------------------
    const totalP = sent.reduce((s, b) => s + b.p, 0);
    const totalN = sent.reduce((s, b) => s + b.n, 0);
    const totalU = sent.reduce((s, b) => s + b.u, 0);
    const totalClassified = totalP + totalN + totalU || 1;

    const negativeRecentTotal = brandSummary.reduce((s, b) => s + b.negative, 0);
    const brandsWithNegativesRecent = brandSummary.filter((b) => b.negative > 0).length;

    const mentionRecent = parseInt(mentionRows[0]?.recent ?? '0', 10);
    const mentionPrior = parseInt(mentionRows[0]?.prior ?? '0', 10);
    const mentionDelta = mentionPrior > 0
      ? Math.round(((mentionRecent - mentionPrior) / mentionPrior) * 1000) / 10
      : 0;

    const xMentionRecent = parseInt(xMentionRows[0]?.recent ?? '0', 10);
    const xMentionPrior = parseInt(xMentionRows[0]?.prior ?? '0', 10);
    const xMentionDelta = xMentionPrior > 0
      ? Math.round(((xMentionRecent - xMentionPrior) / xMentionPrior) * 1000) / 10
      : 0;

    // Combined UGC total — one KPI tile instead of a separate TikTok-only and
    // X-only card; the per-platform split still shows as a sub-line using the
    // two numbers above, but the headline number/delta is the real total.
    const ugcMentionsRecent = mentionRecent + xMentionRecent;
    const ugcMentionsPrior = mentionPrior + xMentionPrior;
    const ugcMentionsDelta = ugcMentionsPrior > 0
      ? Math.round(((ugcMentionsRecent - ugcMentionsPrior) / ugcMentionsPrior) * 1000) / 10
      : 0;

    const avgEngAll = brandSummary.length
      ? Math.round((brandSummary.reduce((s, b) => s + b.avg_engagement, 0) / brandSummary.length) * 10) / 10
      : 0;

    const platformMix = platformRows.map((r) => ({
      platform: r.platform,
      count: parseInt(r.count, 10),
      positive: parseInt(r.positive, 10),
      negative: parseInt(r.negative, 10),
      neutral: parseInt(r.neutral, 10),
    }));
    const platformTotal = platformMix.reduce((s, p) => s + p.count, 0) || 1;

    // Insight feed — urgent triggers only. Negative-comment insights use the
    // same negative-share bar the digest's "Needs Attention" section uses
    // (negative>=5 AND negShare>=20%). Spike insights show every spike
    // discovered in the window (spikeRows is already scoped to spike_flag +
    // own brands + spike_detected_at within the last 7 days, above) — used
    // to ALSO require clearing a separate, higher "viral tier" (views>=500K
    // AND engagement>=2%) on top of spike_flag, which silently hid real
    // spikes (e.g. a 264K-view post that tripped the 100K spike threshold)
    // from this feed even though the Viral tab already considered it one.

    const insights: {
      severity: 'negative' | 'warning' | 'info';
      title: string;
      detail: string;
      brand: string;
      platform: string;
      when: string | null;
      href: string;
      cta: string;
    }[] = [];

    for (const b of brandSummary.filter((x) => x.negative >= 5 && x.classified > 0 && x.negative / x.classified >= 0.2)) {
      insights.push({
        severity: 'warning',
        title: `${b.name}: ${b.negative} negative comment${b.negative === 1 ? '' : 's'} (${describeRange(range)})`,
        detail: `${b.negative} of ${b.classified} classified comments were negative — ${Math.round((b.negative / b.classified) * 100)}%.`,
        brand: b.name,
        platform: 'All platforms',
        when: null,
        href: '/social',
        cta: 'Review in Social Listening',
      });
    }

    for (const s of spikeRows) {
      const views = parseInt(s.views, 10) || 0;
      insights.push({
        severity: 'info',
        title: `Engagement spike: ${s.author_handle ? '@' + s.author_handle : s.brand_name} post hit ${fmtCompact(views)} views`,
        detail: (s.caption ?? '').slice(0, 160) || 'A post for this brand crossed its spike threshold — a creator may be driving a surge.',
        brand: s.brand_name,
        platform: 'TikTok',
        when: s.spike_detected_at,
        href: `/tiktok/${s.post_id}`,
        cta: 'Inspect post',
      });
    }

    res.json({
      kpis: {
        ugc_mentions_recent: ugcMentionsRecent,
        ugc_mentions_delta: ugcMentionsDelta,
        social_mentions_recent: mentionRecent,
        social_mentions_delta: mentionDelta,
        x_mentions_recent: xMentionRecent,
        x_mentions_delta: xMentionDelta,
        sentiment_split: {
          positive: Math.round((totalP / totalClassified) * 100),
          negative: Math.round((totalN / totalClassified) * 100),
          neutral: Math.round((totalU / totalClassified) * 100),
        },
        avg_engagement: avgEngAll,
        negative_mentions_recent: negativeRecentTotal,
        brands_with_negatives_recent: brandsWithNegativesRecent,
        active_spikes_recent: spikeRows.length,
      },
      brand_summary: brandSummary,
      insights: insights.slice(0, 8),
      platform_mix: platformMix.map((p) => ({ ...p, pct: Math.round((p.count / platformTotal) * 100) })),
    });
  } catch (err) {
    console.error('[command-center/overview]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/command-center/sentiment-trend ─────────────────────────────────
router.get('/sentiment-trend', async (req: Request, res: Response) => {
  const range = parseDateRange(req.query as Record<string, string>, 30);
  const brand = req.query.brand as string | undefined;
  const wb = new WhereBuilder();
  wb.dateRange('sc.published_at', range);
  wb.addRaw('sc.sentiment IS NOT NULL');
  wb.addRaw("(sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')");
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  try {
    const rows = await query<{ date: string; positive: string; negative: string; neutral: string }>(
      `SELECT to_char(date_trunc('day', sc.published_at), 'YYYY-MM-DD') AS date,
         COUNT(*) FILTER (WHERE sc.sentiment = 'positive') AS positive,
         COUNT(*) FILTER (WHERE sc.sentiment = 'negative') AS negative,
         COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')  AS neutral
       FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
       WHERE ${wb.where}
       GROUP BY 1 ORDER BY 1`,
      wb.values,
    );
    res.json({
      data: rows.map((r) => ({
        date: r.date,
        positive: parseInt(r.positive, 10),
        negative: parseInt(r.negative, 10),
        neutral: parseInt(r.neutral, 10),
      })),
    });
  } catch (err) {
    console.error('[command-center/sentiment-trend]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/command-center/topic-matrix ────────────────────────────────────
router.get('/topic-matrix', async (req: Request, res: Response) => {
  const range = parseDateRange(req.query as Record<string, string>, 30);
  const brand = req.query.brand as string | undefined;
  const wb = new WhereBuilder();
  wb.dateRange('sc.published_at', range);
  wb.addRaw('sc.sentiment IS NOT NULL');
  wb.addRaw('sc.topic IS NOT NULL');
  wb.addRaw("(sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')");
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  try {
    const rows = await query<{ topic: string; positive: string; negative: string; neutral: string; total: string }>(
      `SELECT COALESCE(NULLIF(sc.topic, ''), 'other') AS topic,
         COUNT(*) FILTER (WHERE sc.sentiment = 'positive') AS positive,
         COUNT(*) FILTER (WHERE sc.sentiment = 'negative') AS negative,
         COUNT(*) FILTER (WHERE sc.sentiment = 'neutral')  AS neutral,
         COUNT(*) AS total
       FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
       WHERE ${wb.where}
       GROUP BY 1 ORDER BY total DESC LIMIT 8`,
      wb.values,
    );
    res.json({
      data: rows.map((r) => ({
        topic: r.topic,
        positive: parseInt(r.positive, 10),
        negative: parseInt(r.negative, 10),
        neutral: parseInt(r.neutral, 10),
        total: parseInt(r.total, 10),
      })),
    });
  } catch (err) {
    console.error('[command-center/topic-matrix]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/command-center/crisis ──────────────────────────────────────────
// Feeds the "Negative Comment Volume" card on /overview — per-brand negative
// share + a negative-volume timeline. Not a standalone page (that one was
// removed as a duplicate, see sidebar.tsx).
router.get('/crisis', async (req: Request, res: Response) => {
  const range = parseDateRange(req.query as Record<string, string>, 30);
  const brand = req.query.brand as string | undefined;

  try {
    // Only brandSentiment + the timeline query are used — the dashboard's
    // "Negative Comment Volume" card (overview/page.tsx) reads just
    // `brands` + `timeline`. A third query fetching up to 40 full negative
    // comments used to run here for a "recent negatives" list that no page
    // ever rendered (the standalone Crisis Center page was removed, see
    // sidebar.tsx) — dropped rather than paying for unused rows.
    const timelineWb = new WhereBuilder([`b.type = 'own'`]);
    timelineWb.dateRange('sc.published_at', range);
    if (brand) timelineWb.add('b.slug = ?', brand);

    const [sent, timelineRows] = await Promise.all([
      brandSentiment(range),
      query<{ date: string; negative: string; total: string }>(
        `SELECT to_char(date_trunc('day', sc.published_at), 'YYYY-MM-DD') AS date,
           COUNT(*) FILTER (WHERE sc.sentiment = 'negative' AND (sc.brand_relevance IS NULL OR sc.brand_relevance = 'on_topic')) AS negative,
           COUNT(*) AS total
         FROM social_comments sc JOIN brands b ON b.id = sc.brand_id
         WHERE ${timelineWb.where}
         GROUP BY 1 ORDER BY 1`,
        timelineWb.values,
      ),
    ]);

    const brands = sent.map((b) => {
      const classified = b.p + b.n + b.u;
      const negShare = classified > 0 ? b.n / classified : 0;
      return {
        slug: b.slug,
        name: b.name,
        negative: b.n,
        classified,
        neg_share: Math.round(negShare * 1000) / 10,
      };
    });

    res.json({
      brands,
      timeline: timelineRows.map((r) => ({
        date: r.date,
        negative: parseInt(r.negative, 10),
        total: parseInt(r.total, 10),
      })),
    });
  } catch (err) {
    console.error('[command-center/crisis]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/command-center/top-ugc ─────────────────────────────────────────
// UGC Performance: top creator posts mentioning own brands, with sentiment mix.
router.get('/top-ugc', async (req: Request, res: Response) => {
  const range = parseDateRange(req.query as Record<string, string>, 30);
  const brand = req.query.brand as string | undefined;
  const search = (req.query.search as string | undefined)?.trim().toLowerCase();
  const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10));
  const limit = Math.min(parseInt((req.query.limit as string) ?? '24', 10), 100);
  const sort = (req.query.sort as string) ?? 'engagement';
  const offset = (page - 1) * limit;

  const ORDER: Record<string, string> = {
    engagement: '(tp.likes + tp.shares + tp.comments_count) DESC',
    views: 'tp.views DESC',
    likes: 'tp.likes DESC',
    recent: 'tp.posted_at DESC',
  };
  const orderBy = ORDER[sort] ?? ORDER.engagement;

  const excludedHandles = await getExcludedUgcHandles();
  const wb = new WhereBuilder([`tp.source_type = 'search'`]);
  wb.dateRange('tp.posted_at', range);
  // Exclude own brand accounts + already-engaged creators (Settings → Keywords).
  wb.add(`LOWER(COALESCE(tp.author_handle, '')) <> ALL(?::text[])`, excludedHandles);
  // >100% is a data anomaly (bot-inflated likes/shares vs undercounted view
  // metadata), not a real spike — drop it so it doesn't distort avg/top-post stats.
  wb.addRaw(`(tp.engagement_rate IS NULL OR tp.engagement_rate <= 100)`);

  // No specific brand picked ("All Brands") must still mean "all OWN brands",
  // not literally every brand row — competitor posts land in tiktok_posts too
  // (category-keyword search attributes them there, see tiktok-search.ts),
  // and this endpoint's whole purpose is own-brand UGC. Mirrors the same
  // fallback already on GET /api/tiktok/search.
  if (brand) wb.add('b.slug = ?', brand);
  else wb.addRaw(`b.type = 'own'`);
  if (req.query.spike === 'true') wb.addRaw('tp.spike_flag = true');

  if (search) {
    // Hashtags are stored without the leading '#' — strip it so "#mizumi" and
    // "mizumi" both match the same hashtag entries.
    const hashtagSearch = search.replace(/^#+/, '');
    const i = wb.nextIndex; // reused by every LIKE below except the hashtag one ($i+1)
    wb.addRaw(`(
      LOWER(tp.caption) LIKE $${i}
      OR LOWER(tp.author_handle) LIKE $${i}
      OR LOWER(tp.post_id) LIKE $${i}
      OR LOWER(COALESCE(tp.theme, 'other')) LIKE $${i}
      OR EXISTS (
        SELECT 1 FROM unnest(tp.hashtags) h
        WHERE LOWER(h) LIKE $${i + 1}
      )
      OR EXISTS (
        SELECT 1 FROM social_comments sc
        WHERE sc.post_id = tp.post_id AND sc.platform = 'tiktok'
          AND LOWER(sc.content) LIKE $${i}
      )
    )`);
    wb.pushValues(`%${search}%`, `%${hashtagSearch}%`);
  }

  const where = wb.where;

  try {
    type Row = {
      post_id: string; caption: string | null; author_handle: string | null; hashtags: string[] | null;
      views: string; likes: string; shares: string; comments_count: string;
      engagement_rate: string | null; spike_flag: boolean; posted_at: string | null;
      brand_name: string; brand_slug: string; post_url: string | null; theme: string | null;
      pos: string; neg: string; neu: string;
    };

    const [rows, countRows, themeRows, statsRows, topPostRows] = await Promise.all([
      query<Row>(
        `SELECT tp.post_id, tp.caption, tp.author_handle, tp.hashtags,
                tp.views, tp.likes, tp.shares, tp.comments_count,
                tp.engagement_rate, tp.spike_flag, tp.posted_at, tp.theme,
                b.name AS brand_name, b.slug AS brand_slug,
                CASE WHEN tp.author_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || tp.author_handle || '/video/' || tp.post_id
                  ELSE NULL END AS post_url,
                COUNT(sc.*) FILTER (WHERE sc.sentiment = 'positive') AS pos,
                COUNT(sc.*) FILTER (WHERE sc.sentiment = 'negative') AS neg,
                COUNT(sc.*) FILTER (WHERE sc.sentiment = 'neutral')  AS neu
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         LEFT JOIN social_comments sc ON sc.post_id = tp.post_id AND sc.platform = 'tiktok'
         WHERE ${where}
         GROUP BY tp.id, b.name, b.slug
         ORDER BY ${orderBy}
         LIMIT $${wb.nextIndex} OFFSET $${wb.nextIndex + 1}`,
        [...wb.values, limit, offset],
      ),
      query<{ total: string }>(
        `SELECT COUNT(DISTINCT tp.id) AS total
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         LEFT JOIN social_comments sc ON sc.post_id = tp.post_id AND sc.platform = 'tiktok'
         WHERE ${where}`,
        wb.values,
      ),
      query<{ theme: string | null; post_count: string; avg_engagement: string | null }>(
        // Same filter as the post list (search included) — otherwise this
        // panel shows theme counts for the whole date range while the total
        // it's divided against (pct = post_count/total in the UI) is the
        // search-filtered total, producing nonsense percentages.
        `SELECT COALESCE(tp.theme, 'Other') AS theme, COUNT(DISTINCT tp.id) AS post_count,
                AVG(tp.engagement_rate) AS avg_engagement
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         WHERE ${where}
         GROUP BY COALESCE(tp.theme, 'Other')
         ORDER BY post_count DESC`,
        wb.values,
      ),
      // Aggregate over the FULL filtered set (not just this page) — the Avg
      // Engagement / UGC Sentiment stat cards were previously computed
      // client-side from only the current page's 24 rows, which skewed hard
      // depending on sort order and silently showed 0% whenever page 1
      // happened to contain no classified comments.
      query<{ avg_engagement: string | null; total_views: string; pos: string; neg: string; neu: string }>(
        `SELECT AVG(tp.engagement_rate) AS avg_engagement,
                COALESCE(SUM(tp.views), 0) AS total_views,
                COUNT(DISTINCT sc.id) FILTER (WHERE sc.sentiment = 'positive') AS pos,
                COUNT(DISTINCT sc.id) FILTER (WHERE sc.sentiment = 'negative') AS neg,
                COUNT(DISTINCT sc.id) FILTER (WHERE sc.sentiment = 'neutral')  AS neu
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         LEFT JOIN social_comments sc ON sc.post_id = tp.post_id AND sc.platform = 'tiktok'
         WHERE ${where}`,
        wb.values,
      ),
      // Top post over the full filtered set, spike-flagged posts first (a
      // post that's actually spiking right now is a stronger "top performer"
      // signal than raw engagement %, which a low-view post can win on a
      // fluke), then by interactions as the tiebreak/fallback.
      query<Row>(
        `SELECT tp.post_id, tp.caption, tp.author_handle, tp.hashtags,
                tp.views, tp.likes, tp.shares, tp.comments_count,
                tp.engagement_rate, tp.spike_flag, tp.posted_at, tp.theme,
                b.name AS brand_name, b.slug AS brand_slug,
                CASE WHEN tp.author_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || tp.author_handle || '/video/' || tp.post_id
                  ELSE NULL END AS post_url,
                COUNT(sc.*) FILTER (WHERE sc.sentiment = 'positive') AS pos,
                COUNT(sc.*) FILTER (WHERE sc.sentiment = 'negative') AS neg,
                COUNT(sc.*) FILTER (WHERE sc.sentiment = 'neutral')  AS neu
         FROM tiktok_posts tp
         JOIN brands b ON b.id = tp.brand_id
         LEFT JOIN social_comments sc ON sc.post_id = tp.post_id AND sc.platform = 'tiktok'
         WHERE ${where}
         GROUP BY tp.id, b.name, b.slug
         ORDER BY tp.spike_flag DESC, (tp.likes + tp.shares + tp.comments_count) DESC
         LIMIT 1`,
        wb.values,
      ),
    ]);

    // On-demand theme classification for posts missing a theme
    const missingThemes = rows
      .filter((r) => !r.theme)
      .map((r) => r.post_id);
    if (missingThemes.length > 0) {
      try {
        await classifyPostThemes(missingThemes);
        // Refresh themes for the rows we just classified
        const classified = await query<{ post_id: string; theme: string | null }>(
          `SELECT post_id, theme FROM tiktok_posts WHERE post_id = ANY($1::text[])`,
          [missingThemes],
        );
        const themeMap = new Map(classified.map((c) => [c.post_id, c.theme]));
        for (const r of rows) {
          if (!r.theme && themeMap.has(r.post_id)) {
            r.theme = themeMap.get(r.post_id) ?? null;
          }
        }
      } catch (err) {
        console.warn('[command-center/top-ugc] Theme classification failed:', err);
      }
    }

    const total = parseInt(countRows[0]?.total ?? '0', 10);

    const themeStats = themeRows.map((r) => ({
      theme: (r.theme as ContentTheme) ?? 'Other',
      post_count: parseInt(r.post_count, 10),
      avg_engagement: r.avg_engagement ? parseFloat(r.avg_engagement) : 0,
    }));

    const mapRow = (r: Row) => {
      const pos = parseInt(r.pos, 10);
      const neg = parseInt(r.neg, 10);
      const neu = parseInt(r.neu, 10);
      const classified = pos + neg + neu;
      return {
        post_id: r.post_id,
        caption: r.caption,
        author_handle: r.author_handle,
        hashtags: r.hashtags ?? [],
        views: parseInt(r.views, 10) || 0,
        likes: parseInt(r.likes, 10) || 0,
        shares: parseInt(r.shares, 10) || 0,
        comments_count: parseInt(r.comments_count, 10) || 0,
        engagement_rate: r.engagement_rate ? parseFloat(r.engagement_rate) : 0,
        spike_flag: r.spike_flag,
        posted_at: r.posted_at,
        brand_name: r.brand_name,
        brand_slug: r.brand_slug,
        post_url: r.post_url,
        theme: r.theme ?? 'Other',
        sentiment: {
          positive: pos,
          negative: neg,
          neutral: neu,
          positive_pct: classified > 0 ? Math.round((pos / classified) * 100) : 0,
          neutral_pct: classified > 0 ? Math.round((neu / classified) * 100) : 0,
          negative_pct: classified > 0 ? Math.round((neg / classified) * 100) : 0,
        },
      };
    };

    const agg = statsRows[0];
    const aggPos = parseInt(agg?.pos ?? '0', 10);
    const aggNeg = parseInt(agg?.neg ?? '0', 10);
    const aggNeu = parseInt(agg?.neu ?? '0', 10);
    const aggClassified = aggPos + aggNeg + aggNeu;

    res.json({
      data: rows.map(mapRow),
      page,
      limit,
      total,
      themes: themeStats,
      stats: {
        avg_engagement: agg?.avg_engagement ? parseFloat(agg.avg_engagement) : 0,
        total_views: parseInt(agg?.total_views ?? '0', 10),
        sentiment: {
          positive: aggPos,
          negative: aggNeg,
          neutral: aggNeu,
          positive_pct: aggClassified > 0 ? Math.round((aggPos / aggClassified) * 100) : 0,
          neutral_pct: aggClassified > 0 ? Math.round((aggNeu / aggClassified) * 100) : 0,
          negative_pct: aggClassified > 0 ? Math.round((aggNeg / aggClassified) * 100) : 0,
        },
      },
      top_post: topPostRows[0] ? mapRow(topPostRows[0]) : null,
    });
  } catch (err) {
    console.error('[command-center/top-ugc]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export default router;
