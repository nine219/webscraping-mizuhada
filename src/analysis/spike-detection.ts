import { socialQuery as query } from '../db/social-client';
import { sendLineFlex, Flex, FLEX_COLORS as C, truncateText as truncate, kpiTile, platformColor, platformStripe, isMultiColorPlatform, sanitizeCarousel } from '../alerts/line';
import { getThresholds } from '../config/settings-loader';

export interface SpikeResult {
  postId: string;
  brandSlug: string;
  engagementRate: number;
  views: number;
  rule: 'viral' | 'high-engagement';
}

// Defaults applied only if settings load fails; live values pulled from settings.thresholds.
const DEFAULT_MIN_VIEWS_FOR_SPIKE  = 100_000;
const DEFAULT_VIRAL_VIEWS          = 500_000;
const DEFAULT_VIRAL_ENGAGEMENT_PCT = 2.0;
const DEFAULT_MIN_ENGAGEMENT_PCT   = 3.0;

export interface SpikedPostRow {
  post_id: string;
  engagement_rate: string;
  caption: string | null;
  views: string;
  likes: string;
  shares: string;
  comments_count: string;
  post_url: string | null;
  author_handle: string | null;
  tiktok_handle: string | null;
  posted_at: string | null;
}

// LINE alerts only fire for posts published within this window — an old post
// (1-3+ years) that's always been sitting above threshold, only just now
// discovered/re-scraped, isn't a real-time spike worth paging anyone about.
// spike_flag itself stays age-agnostic (see evaluateSpikesForBrand comment)
// so the dashboard badge/filter still surfaces old viral posts when browsing;
// this only gates the push notification.
const SPIKE_ALERT_MAX_AGE_DAYS = 30;

function isWithinAlertWindow(postedAt: string | null): boolean {
  if (!postedAt) return true; // unknown age — don't silently suppress, alert as before
  const ageMs = Date.now() - new Date(postedAt).getTime();
  return ageMs <= SPIKE_ALERT_MAX_AGE_DAYS * 86_400_000;
}

/** post_url is sometimes empty at scrape time — fall back to author (or brand) handle + post_id. */
function resolvePostUrl(post: SpikedPostRow): string | null {
  if (post.post_url) return post.post_url;
  const handle = post.author_handle || post.tiktok_handle;
  return handle ? `https://www.tiktok.com/@${handle}/video/${post.post_id}` : null;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** Same visual language as the morning/weekly digests — one spike per bubble. `headerLabel` lets detectSpikes() distinguish an initial spike from a resurgence alert. */
export function spikeBubble(brandSlug: string, post: SpikedPostRow, engRate: number, views: number, rule: 'viral' | 'high-engagement', headerLabel = '🚀 TikTok Spike'): Flex {
  const likes    = parseInt(post.likes, 10);
  const shares   = parseInt(post.shares, 10);
  const comments = parseInt(post.comments_count, 10);

  const ruleLabel = rule === 'viral' ? '🔥 Viral views' : '📈 High engagement';

  const body: Flex[] = [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        kpiTile(`${engRate.toFixed(2)}%`, 'Engagement'),
        kpiTile(formatNumber(views), 'Views'),
      ],
    },
    { type: 'text', text: ruleLabel, size: 'xxs', color: C.muted, margin: 'sm' },
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: truncate(post.caption || '(ไม่มีแคปชั่น)'), size: 'xs', color: C.text, wrap: true, margin: 'lg' },
    {
      type: 'text', size: 'xs', color: C.navy, weight: 'bold', margin: 'sm',
      text: `👁 ${formatNumber(views)}   ❤️ ${formatNumber(likes)}   ↗️ ${formatNumber(shares)}   💬 ${formatNumber(comments)}`,
    },
  ];

  const headerContents: Flex[] = [
    platformStripe('tiktok', '4px'),
    { type: 'text', text: headerLabel, color: C.white, weight: 'bold', size: 'lg', margin: 'md' },
    { type: 'text', text: brandSlug, color: '#25F4EE', size: 'sm', margin: 'xs' },
  ];
  if (post.author_handle) {
    headerContents.push({ type: 'text', text: `@${post.author_handle}`, color: '#fff7ed', size: 'xs', margin: 'xs' });
  }

  const bubble: Flex = {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#000000', paddingAll: '14px', contents: headerContents },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
  };

  const url = resolvePostUrl(post);
  if (url && /^https?:\/\//.test(url)) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'button', style: 'primary', color: C.blue, height: 'sm',
        action: { type: 'uri', label: 'ดูโพสต์', uri: url },
      }],
    };
  }

  return bubble;
}

interface SpikeEvaluation {
  newlyFlagged: SpikedPostRow[];
  unflaggedCount: number;
}

/**
 * Flags posts that newly qualify AND unflags posts that no longer qualify
 * under the current thresholds — both directions, so a saved threshold
 * change (looser or stricter) is fully reflected instead of only ever
 * adding flags and never removing stale ones. Pure DB update, no
 * notifications — callers decide whether newlyFlagged should alert.
 *
 * Two flat conditions (OR), no per-brand baseline/multiplier — that layer
 * was confusing (silently varied the effective bar per brand) and dropped
 * in favor of thresholds you can read straight off the Settings page:
 *   A) views >= minViewsForSpike AND engagement >= minEngagementPct
 *   B) views >= viralViewsThreshold AND engagement >= viralEngagementPct
 */
async function evaluateSpikesForBrand(brandId: number, brandSlug: string): Promise<SpikeEvaluation> {
  const th = await getThresholds().catch(() => null);
  const MIN_VIEWS_FOR_SPIKE   = th?.minViewsForSpike    ?? DEFAULT_MIN_VIEWS_FOR_SPIKE;
  const VIRAL_VIEWS_THRESHOLD = th?.viralViewsThreshold ?? DEFAULT_VIRAL_VIEWS;
  const VIRAL_ENGAGEMENT_PCT  = th?.viralEngagementPct  ?? DEFAULT_VIRAL_ENGAGEMENT_PCT;
  const MIN_ENGAGEMENT_PCT    = th?.minEngagementPct    ?? DEFAULT_MIN_ENGAGEMENT_PCT;

  const qualifies = `((tp.views >= $2 AND tp.engagement_rate >= $3) OR (tp.views >= $4 AND tp.engagement_rate >= $5))`;
  const params = [brandId, MIN_VIEWS_FOR_SPIKE, MIN_ENGAGEMENT_PCT, VIRAL_VIEWS_THRESHOLD, VIRAL_ENGAGEMENT_PCT];

  // No posted_at cutoff — an old post can go viral later (re-scraped metrics
  // catch up on views/engagement over time), and that's exactly the kind of
  // spike we want surfaced, not silently skipped because it's not "fresh."
  // detectSpikes() (cron path) will LINE-alert on these same as any new spike.
  const newlyFlagged = await query<SpikedPostRow>(
    `UPDATE tiktok_posts tp
     SET spike_flag = true, spike_detected_at = NOW(), last_alert_views = tp.views, last_alert_at = NOW()
     FROM brands b
     WHERE tp.brand_id = $1
       AND b.id = tp.brand_id
       AND tp.spike_flag = false
       AND tp.engagement_rate IS NOT NULL
       AND ${qualifies}
     RETURNING tp.post_id, tp.engagement_rate, tp.caption, tp.views, tp.likes, tp.shares, tp.comments_count,
               tp.post_url, tp.author_handle, b.tiktok_handle, tp.posted_at`,
    params,
  );

  // Un-flag posts that no longer meet the (possibly now stricter) thresholds —
  // otherwise raising a threshold never actually removes old spikes. Same
  // no-cutoff reasoning as the flag query above, symmetrically. Also clears the
  // resurgence baseline (last_alert_views/at) so a later re-flag starts fresh
  // instead of comparing against a stale snapshot from this run.
  const unflagged = await query<{ post_id: string }>(
    `UPDATE tiktok_posts tp
     SET spike_flag = false, spike_detected_at = NULL, last_alert_views = NULL, last_alert_at = NULL
     FROM brands b
     WHERE tp.brand_id = $1
       AND b.id = tp.brand_id
       AND tp.spike_flag = true
       AND NOT ${qualifies}
     RETURNING tp.post_id`,
    params,
  );

  return { newlyFlagged, unflaggedCount: unflagged.length };
}

const RESURGENCE_GROWTH_PCT = 0.5; // must grow at least 50% over its last-alerted view count
const RESURGENCE_MIN_VIEWS_DELTA = 50_000; // guards small posts from tripping the % bar on a tiny base
const RESURGENCE_COOLDOWN_HOURS = 6; // don't re-alert the same growth burst across back-to-back scrapes

/**
 * Already-flagged posts (spike_flag=true) whose views grew meaningfully since
 * the last time we alerted on them — the "old post spiking again" case that
 * evaluateSpikesForBrand()'s spike_flag=false filter can never catch (it only
 * ever flags a post once). Updates last_alert_views/at for matched rows in the
 * same statement, so this baseline moves forward and a follow-up scrape 10
 * minutes later doesn't immediately re-fire on the same growth.
 */
async function detectResurgence(brandId: number): Promise<SpikedPostRow[]> {
  return query<SpikedPostRow>(
    `UPDATE tiktok_posts tp
     SET last_alert_views = tp.views, last_alert_at = NOW()
     FROM brands b
     WHERE tp.brand_id = $1
       AND b.id = tp.brand_id
       AND tp.spike_flag = true
       AND tp.last_alert_views IS NOT NULL
       AND tp.last_alert_at <= NOW() - INTERVAL '${RESURGENCE_COOLDOWN_HOURS} hours'
       AND tp.views >= tp.last_alert_views * ${1 + RESURGENCE_GROWTH_PCT}
       AND tp.views - tp.last_alert_views >= ${RESURGENCE_MIN_VIEWS_DELTA}
     RETURNING tp.post_id, tp.engagement_rate, tp.caption, tp.views, tp.likes, tp.shares, tp.comments_count,
               tp.post_url, tp.author_handle, b.tiktok_handle, tp.posted_at`,
    [brandId],
  );
}

export async function detectSpikes(brandId: number, brandSlug: string): Promise<SpikeResult[]> {
  // Spike detection + LINE alerts are an own-brand feature only. Competitor
  // rows (e.g. mockup/benchmark brands like Her Hyness) get scraped for raw
  // data but should never be flagged or trigger an alert.
  const brandRows = await query<{ type: string }>(`SELECT type FROM brands WHERE id = $1`, [brandId]);
  if (brandRows[0]?.type !== 'own') return [];

  const th = await getThresholds().catch(() => null);
  const VIRAL_VIEWS_THRESHOLD = th?.viralViewsThreshold ?? DEFAULT_VIRAL_VIEWS;
  const VIRAL_ENGAGEMENT_PCT  = th?.viralEngagementPct  ?? DEFAULT_VIRAL_ENGAGEMENT_PCT;

  const { newlyFlagged } = await evaluateSpikesForBrand(brandId, brandSlug);
  const resurging = await detectResurgence(brandId);

  const results: SpikeResult[] = [];

  for (const post of newlyFlagged) {
    if (!isWithinAlertWindow(post.posted_at)) continue; // flagged in DB, but too old to page anyone about

    const engRate = parseFloat(post.engagement_rate);
    const views   = parseInt(post.views, 10);
    const rule: 'viral' | 'high-engagement' =
      views >= VIRAL_VIEWS_THRESHOLD && engRate >= VIRAL_ENGAGEMENT_PCT ? 'viral' : 'high-engagement';

    const altText = `🚀 TikTok Spike — ${brandSlug} · ${engRate.toFixed(2)}% engagement`;
    await sendLineFlex(altText, spikeBubble(brandSlug, post, engRate, views, rule));

    results.push({ postId: post.post_id, brandSlug, engagementRate: engRate, views, rule });
  }

  // Resurgence bypasses the 30-day age window on purpose — an old post
  // genuinely spiking again right now IS the fresh event worth paging on;
  // the age cap above only exists to stop a stale post's *first* discovery
  // from reading as breaking news.
  for (const post of resurging) {
    const engRate = parseFloat(post.engagement_rate);
    const views   = parseInt(post.views, 10);
    const rule: 'viral' | 'high-engagement' =
      views >= VIRAL_VIEWS_THRESHOLD && engRate >= VIRAL_ENGAGEMENT_PCT ? 'viral' : 'high-engagement';

    const altText = `🔥 TikTok Resurgence — ${brandSlug} · ${engRate.toFixed(2)}% engagement`;
    await sendLineFlex(altText, spikeBubble(brandSlug, post, engRate, views, rule, '🔥 TikTok Resurgence'));

    results.push({ postId: post.post_id, brandSlug, engagementRate: engRate, views, rule });
  }

  return results;
}

/**
 * Re-applies current thresholds to all own brands' recent posts, silently —
 * no LINE alerts. Meant to be called right after thresholds are saved so
 * the change is felt immediately instead of waiting for the next scrape's
 * detectSpikes() call, and so raising a threshold actually clears stale
 * spikes instead of leaving them flagged forever.
 */
export async function reEvaluateAllSpikesQuiet(): Promise<{ flagged: number; unflagged: number }> {
  const brands = await query<{ id: number; slug: string }>(
    `SELECT id, slug FROM brands WHERE type = 'own'`,
  );
  let flagged = 0;
  let unflagged = 0;
  for (const b of brands) {
    const result = await evaluateSpikesForBrand(b.id, b.slug);
    flagged += result.newlyFlagged.length;
    unflagged += result.unflaggedCount;
  }
  return { flagged, unflagged };
}

// ── X (Twitter) engagement spike detection ──────────────────────────────────
// Mirrors the TikTok spike logic above (evaluateSpikesForBrand/detectSpikes),
// but against twitter_posts using the X-specific thresholds
// (xMinViewsForSpike/xViralViewsThreshold/xViralEngagementPct/xMinEngagementPct
// — see settings-loader.ts ThresholdSettings) and hard-gated to
// brands.slug = 'mizumi' (X scope is MizuMi-only — docs/scope-x-campaigns.md
// decision 10 — not just type='own', since another own brand could exist
// later without ever getting X coverage).
//
// Previously operated on frozen data: twitter-feed.ts's upsertFeedTweet only
// ran once, at "Track by X link"/add-by-id time, and twitter-comments.ts's
// recurring scrape only ever touched social_comments (replies/quotes), never
// the anchor post's own views/likes/retweets_count/engagement_rate. Now kept
// fresh two ways: (1) twitter-comments.ts's reply-scrape reuses the same
// TweetDetail response it already loads for replies to capture the anchor's
// own stats "for free" whenever its own gating makes it visit a post
// (scrapePostReplies / updateTweetStats in twitter-feed.ts); (2)
// scrapers/twitter/twitter-stats-refresh.ts is the backstop for posts that
// don't trip that gate (a post can gain views/likes with zero new
// replies/quotes) — it re-fetches via the same single-tweet fetch used at
// track time, skipping anything comments-scrape already refreshed recently.
// Wired into scheduler/cron.ts's dedicated twitterStatsRefresh cron (every
// 3h), which calls the refresh then this detection immediately after — same
// shape as TikTok's scrape-then-detectSpikes() pattern above.

const DEFAULT_X_MIN_VIEWS_FOR_SPIKE  = 10_000;
const DEFAULT_X_VIRAL_VIEWS          = 50_000;
const DEFAULT_X_VIRAL_ENGAGEMENT_PCT = 0.2;
const DEFAULT_X_MIN_ENGAGEMENT_PCT   = 0.3;

export interface SpikedTwitterPostRow {
  post_id: string;
  engagement_rate: string;
  caption: string | null;
  views: string;
  likes: string;
  retweets_count: string;
  replies: string;
  quotes_count: string;
  post_url: string | null;
  author_handle: string | null;
  twitter_handle: string | null;
  posted_at: string | null;
}

/** post_url is sometimes empty at scrape time — fall back to author (or brand) handle + post_id. */
function resolveTwitterPostUrl(post: SpikedTwitterPostRow): string | null {
  if (post.post_url) return post.post_url;
  const handle = post.author_handle || post.twitter_handle;
  return handle ? `https://x.com/${handle}/status/${post.post_id}` : null;
}

/** Same visual language as spikeBubble() above, X-flavored (🚀 X Spike, retweets/replies instead of shares/comments). */
export function xSpikeBubble(brandSlug: string, post: SpikedTwitterPostRow, engRate: number, views: number, rule: 'viral' | 'high-engagement'): Flex {
  const likes    = parseInt(post.likes, 10);
  const retweets = parseInt(post.retweets_count, 10);
  const replies  = parseInt(post.replies, 10);

  const ruleLabel = rule === 'viral' ? '🔥 Viral views' : '📈 High engagement';

  const body: Flex[] = [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        kpiTile(`${engRate.toFixed(2)}%`, 'Engagement'),
        kpiTile(formatNumber(views), 'Views'),
      ],
    },
    { type: 'text', text: ruleLabel, size: 'xxs', color: C.muted, margin: 'sm' },
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: truncate(post.caption || '(no caption)'), size: 'xs', color: C.text, wrap: true, margin: 'lg' },
    {
      type: 'text', size: 'xs', color: C.navy, weight: 'bold', margin: 'sm',
      text: `👁 ${formatNumber(views)}   ❤️ ${formatNumber(likes)}   🔁 ${formatNumber(retweets)}   💬 ${formatNumber(replies)}`,
    },
  ];

  const headerContents: Flex[] = [
    platformStripe('twitter', '4px'),
    { type: 'text', text: '🚀 X Spike', color: C.white, weight: 'bold', size: 'lg', margin: 'md' },
    { type: 'text', text: brandSlug, color: '#1D9BF0', size: 'sm', margin: 'xs' },
  ];
  if (post.author_handle) {
    headerContents.push({ type: 'text', text: `@${post.author_handle}`, color: '#fff7ed', size: 'xs', margin: 'xs' });
  }

  const bubble: Flex = {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#000000', paddingAll: '14px', contents: headerContents },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
  };

  const url = resolveTwitterPostUrl(post);
  if (url && /^https?:\/\//.test(url)) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'button', style: 'primary', color: C.blue, height: 'sm',
        action: { type: 'uri', label: 'ดูโพสต์', uri: url },
      }],
    };
  }

  return bubble;
}

interface TwitterSpikeEvaluation {
  newlyFlagged: SpikedTwitterPostRow[];
  unflaggedCount: number;
}

/**
 * Same two-flat-condition (OR), flag-and-unflag-both-directions philosophy as
 * evaluateSpikesForBrand above, against twitter_posts. b.slug = 'mizumi' is
 * asserted directly in the SQL (not just relied on via the caller's brandId
 * lookup) per this milestone's hard MizuMi-only constraint.
 */
async function evaluateTwitterSpikesForBrand(brandId: number): Promise<TwitterSpikeEvaluation> {
  const th = await getThresholds().catch(() => null);
  const MIN_VIEWS_FOR_SPIKE   = th?.xMinViewsForSpike    ?? DEFAULT_X_MIN_VIEWS_FOR_SPIKE;
  const VIRAL_VIEWS_THRESHOLD = th?.xViralViewsThreshold ?? DEFAULT_X_VIRAL_VIEWS;
  const VIRAL_ENGAGEMENT_PCT  = th?.xViralEngagementPct  ?? DEFAULT_X_VIRAL_ENGAGEMENT_PCT;
  const MIN_ENGAGEMENT_PCT    = th?.xMinEngagementPct    ?? DEFAULT_X_MIN_ENGAGEMENT_PCT;

  const qualifies = `((tp.views >= $2 AND tp.engagement_rate >= $3) OR (tp.views >= $4 AND tp.engagement_rate >= $5))`;
  const params = [brandId, MIN_VIEWS_FOR_SPIKE, MIN_ENGAGEMENT_PCT, VIRAL_VIEWS_THRESHOLD, VIRAL_ENGAGEMENT_PCT];

  const newlyFlagged = await query<SpikedTwitterPostRow>(
    `UPDATE twitter_posts tp
     SET spike_flag = true, spike_detected_at = NOW()
     FROM brands b
     WHERE tp.brand_id = $1
       AND b.id = tp.brand_id
       AND b.slug = 'mizumi'
       AND tp.spike_flag = false
       AND tp.engagement_rate IS NOT NULL
       AND ${qualifies}
     RETURNING tp.post_id, tp.engagement_rate, tp.caption, tp.views, tp.likes, tp.retweets_count, tp.replies, tp.quotes_count,
               tp.post_url, tp.author_handle, b.twitter_handle, tp.posted_at`,
    params,
  );

  const unflagged = await query<{ post_id: string }>(
    `UPDATE twitter_posts tp
     SET spike_flag = false, spike_detected_at = NULL
     FROM brands b
     WHERE tp.brand_id = $1
       AND b.id = tp.brand_id
       AND b.slug = 'mizumi'
       AND tp.spike_flag = true
       AND NOT ${qualifies}
     RETURNING tp.post_id`,
    params,
  );

  return { newlyFlagged, unflaggedCount: unflagged.length };
}

/**
 * X equivalent of detectSpikes() above. Hard-gated to brands.slug = 'mizumi'
 * (not type='own' — see file-section header). Called from scheduler/cron.ts's
 * existing hourly campaignSync tick — see that call site for why there, not a
 * dedicated schedule.
 */
export async function detectTwitterSpikes(): Promise<SpikeResult[]> {
  const brandRows = await query<{ id: number; slug: string }>(`SELECT id, slug FROM brands WHERE slug = 'mizumi'`);
  if (brandRows.length === 0) return [];
  const { id: brandId, slug: brandSlug } = brandRows[0];

  const th = await getThresholds().catch(() => null);
  const VIRAL_VIEWS_THRESHOLD = th?.xViralViewsThreshold ?? DEFAULT_X_VIRAL_VIEWS;
  const VIRAL_ENGAGEMENT_PCT  = th?.xViralEngagementPct  ?? DEFAULT_X_VIRAL_ENGAGEMENT_PCT;

  const { newlyFlagged } = await evaluateTwitterSpikesForBrand(brandId);
  if (newlyFlagged.length === 0) return [];

  const results: SpikeResult[] = [];

  for (const post of newlyFlagged) {
    if (!isWithinAlertWindow(post.posted_at)) continue; // flagged in DB, but too old to page anyone about

    const engRate = parseFloat(post.engagement_rate);
    const views   = parseInt(post.views, 10);
    const rule: 'viral' | 'high-engagement' =
      views >= VIRAL_VIEWS_THRESHOLD && engRate >= VIRAL_ENGAGEMENT_PCT ? 'viral' : 'high-engagement';

    const altText = `🚀 X Spike — ${brandSlug} · ${engRate.toFixed(2)}% engagement`;
    await sendLineFlex(altText, xSpikeBubble(brandSlug, post, engRate, views, rule));

    results.push({
      postId: post.post_id,
      brandSlug,
      engagementRate: engRate,
      views,
      rule,
    });
  }

  return results;
}

// ── Negative sentiment spike (LINE alert) ───────────────────────────────────
// Cross-platform: unlike engagement spikes (TikTok-only, tiktok_posts), this
// reads social_comments — every platform's comments land there.

const DEFAULT_NEGATIVE_SPIKE_PCT = 35;
const NEGATIVE_SPIKE_MIN_SAMPLE = 5; // don't alert off a handful of comments
const NEGATIVE_SPIKE_WINDOW_SQL = `INTERVAL '24 hours'`;
const NEGATIVE_SPIKE_TOP_N = 5;
const NEGATIVE_SPIKE_MIN_URGENCY = 3;

interface NegativeSpikeRow {
  brand_id: string;
  brand_slug: string;
  brand_name: string;
  total: string;
  negative: string;
}

interface NegativeSpikeBrand {
  brandId: number;
  brandName: string;
  negPct: number;
  negative: number;
  total: number;
}

interface NegativeSpikeComment {
  content: string;
  topic: string | null;
  urgency: number;
  brand_name: string;
  platform: string;
  post_url: string | null;
}

const SPIKE_BRANDS_SQL = `
  SELECT b.id::text AS brand_id, b.slug AS brand_slug, b.name AS brand_name,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE sc.sentiment = 'negative')::text AS negative
  FROM social_comments sc
  JOIN brands b ON b.id = sc.brand_id
  WHERE b.type = 'own' AND sc.sentiment IS NOT NULL
    AND sc.published_at >= NOW() - ${NEGATIVE_SPIKE_WINDOW_SQL}
  GROUP BY b.id, b.slug, b.name`;

function toSpikeBrand(row: NegativeSpikeRow): NegativeSpikeBrand {
  const total = parseInt(row.total, 10);
  const negative = parseInt(row.negative, 10);
  return { brandId: parseInt(row.brand_id, 10), brandName: row.brand_name, negPct: total > 0 ? (negative / total) * 100 : 0, negative, total };
}

/**
 * Top negative comments (urgency >= 3) for the given brands over the last 24h,
 * ordered urgency 5→4→3, then topic สุขภาพ → คุณภาพ → everything else, then
 * newest first. Each resolved to its parent post's URL where possible.
 */
async function fetchTopNegativeComments(brandIds: number[]): Promise<NegativeSpikeComment[]> {
  const rows = await query<{
    content: string; topic: string | null; urgency: number; brand_name: string; platform: string;
    post_id: string | null; post_url: string | null; author_handle: string | null;
  }>(
    `SELECT sc.content, sc.topic, sc.urgency, b.name AS brand_name, sc.platform, sc.post_id,
            COALESCE(NULLIF(tp.post_url,''), NULLIF(twp.post_url,''), NULLIF(ip.post_url,''), NULLIF(xp.post_url,''), NULLIF(sc.original_post_url,'')) AS post_url,
            COALESCE(tp.author_handle, twp.author_handle) AS author_handle
     FROM social_comments sc
     JOIN brands b ON b.id = sc.brand_id
     LEFT JOIN tiktok_posts tp ON sc.platform = 'tiktok' AND tp.brand_id = sc.brand_id AND tp.post_id = sc.post_id
     LEFT JOIN twitter_posts twp ON sc.platform = 'twitter' AND twp.brand_id = sc.brand_id AND twp.post_id = sc.post_id
     LEFT JOIN instagram_posts ip ON sc.platform = 'instagram' AND ip.brand_id = sc.brand_id AND ip.post_id = sc.post_id
     LEFT JOIN xhs_posts xp ON sc.platform IN ('xhs', 'xiaohongshu') AND xp.note_id = sc.post_id
     WHERE sc.brand_id = ANY($1::int[])
       AND sc.sentiment = 'negative' AND sc.urgency >= $2
       AND sc.published_at >= NOW() - ${NEGATIVE_SPIKE_WINDOW_SQL}
     ORDER BY sc.urgency DESC,
              CASE sc.topic WHEN 'สุขภาพ' THEN 0 WHEN 'คุณภาพ' THEN 1 ELSE 2 END,
              sc.published_at DESC
     LIMIT $3`,
    [brandIds, NEGATIVE_SPIKE_MIN_URGENCY, NEGATIVE_SPIKE_TOP_N],
  );
  return rows.map((r) => {
    let postUrl = r.post_url;
    if (!postUrl && r.post_id) {
      if (r.platform === 'tiktok' && r.author_handle) postUrl = `https://www.tiktok.com/@${r.author_handle}/video/${r.post_id}`;
      else if (r.platform === 'twitter' && r.author_handle) postUrl = `https://x.com/${r.author_handle}/status/${r.post_id}`;
      else if (r.platform === 'instagram') postUrl = `https://www.instagram.com/p/${r.post_id}/`;
      else if (r.platform === 'xhs' || r.platform === 'xiaohongshu') postUrl = `https://www.xiaohongshu.com/explore/${r.post_id}`;
    }
    return { content: r.content, topic: r.topic, urgency: r.urgency, brand_name: r.brand_name, platform: r.platform, post_url: postUrl };
  });
}

function urgencyColor(urgency: number): string {
  if (urgency >= 5) return C.neg;
  if (urgency === 4) return C.ques;
  return C.muted;
}

/**
 * One bubble per run: every brand over the threshold (header rows), then the
 * Top 5 negative comments across those brands, each row tappable → its post.
 */
function negativeSpikeBubble(brands: NegativeSpikeBrand[], thresholdPct: number, comments: NegativeSpikeComment[], subtitle: string): Flex {
  const body: Flex[] = brands.map((b, i) => ({
    type: 'box', layout: 'horizontal', margin: i === 0 ? 'none' : 'sm',
    contents: [
      { type: 'text', text: b.brandName, size: 'sm', weight: 'bold', color: C.navy, flex: 3, wrap: true },
      { type: 'text', text: `${b.negPct.toFixed(0)}% ลบ`, size: 'sm', weight: 'bold', color: C.neg, flex: 2, align: 'end' },
      { type: 'text', text: `${b.negative}/${b.total}`, size: 'xs', color: C.muted, flex: 2, align: 'end', gravity: 'center' },
    ],
  }));
  body.push({ type: 'text', text: `คอมเมนต์ 24 ชม. · Threshold ${thresholdPct}%`, size: 'xxs', color: C.muted, margin: 'sm' });
  body.push({ type: 'separator', margin: 'lg' });
  body.push({ type: 'text', text: `Top ${NEGATIVE_SPIKE_TOP_N} คอมเมนต์ลบ (U5→U3 · สุขภาพ→คุณภาพ→อื่นๆ)`, size: 'xs', color: C.muted, margin: 'lg', wrap: true });

  if (comments.length === 0) {
    body.push({ type: 'text', text: `ไม่มีคอมเมนต์ระดับ U${NEGATIVE_SPIKE_MIN_URGENCY} ขึ้นไป`, size: 'xs', color: C.text, margin: 'md' });
  }
  comments.forEach((c, i) => {
    const rowContents: Flex[] = [
      { type: 'text', text: `U${c.urgency} · ${c.topic || 'อื่นๆ'} · ${c.brand_name} · ${c.platform}`, size: 'xxs', weight: 'bold', color: urgencyColor(c.urgency), wrap: true },
      { type: 'text', text: truncate(c.content), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
    ];
    const hasUrl = !!c.post_url && /^https?:\/\//.test(c.post_url);
    if (hasUrl) rowContents.push({ type: 'text', text: '🔗 ดูโพสต์', size: 'xs', color: C.blue, weight: 'bold', margin: 'xs' });
    if (i > 0) body.push({ type: 'separator', margin: 'md' });
    const row: Flex = { type: 'box', layout: 'vertical', margin: 'md', contents: rowContents };
    if (hasUrl) row.action = { type: 'uri', label: 'ดูโพสต์', uri: c.post_url as string };
    body.push(row);
  });

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.neg, paddingAll: '14px',
      contents: [
        { type: 'text', text: '⚠️ Negative Sentiment Spike', color: C.white, weight: 'bold', size: 'lg' },
        { type: 'text', text: subtitle, color: '#fff1f2', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
  };
}

function bangkokStamp(): string {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Checks each own brand's negative-comment share over the last 24h against
 * thresholds.negativeSpikePct. If any brand is over, sends ONE LINE bubble:
 * the over-threshold brands + their Top 5 negative comments (U5→U3, สุขภาพ →
 * คุณภาพ → อื่นๆ) with post links. Runs on its own cron (negativeSpikeDigest,
 * default 07:00/12:00/18:00 Bangkok) — at most one push per round, so no
 * per-day dedupe needed. Sends nothing when no brand is over the threshold.
 */
export async function checkNegativeSentimentSpikes(): Promise<{ alerted: string[] }> {
  const th = await getThresholds().catch(() => null);
  const thresholdPct = th?.negativeSpikePct ?? DEFAULT_NEGATIVE_SPIKE_PCT;

  const rows = await query<NegativeSpikeRow>(SPIKE_BRANDS_SQL);
  const spiking = rows
    .map((r) => ({ row: r, b: toSpikeBrand(r) }))
    .filter(({ b }) => b.total >= NEGATIVE_SPIKE_MIN_SAMPLE && b.negPct >= thresholdPct)
    .sort((x, y) => y.b.negPct - x.b.negPct);

  if (spiking.length === 0) {
    console.log('[NegativeSpike] No brand over threshold — skipping.');
    return { alerted: [] };
  }

  const brands = spiking.map((s) => s.b);
  const comments = await fetchTopNegativeComments(brands.map((b) => b.brandId));
  const top = brands[0];
  const altText = `⚠️ Negative sentiment spike — ${brands.map((b) => `${b.brandName} ${b.negPct.toFixed(0)}%`).join(', ')}`
    + (comments[0] ? ` · Top: U${comments[0].urgency} ${comments[0].topic || 'อื่นๆ'}` : '');
  console.log(`[NegativeSpike] Alerting ${brands.length} brand(s), top ${top.brandName} ${top.negPct.toFixed(0)}%, ${comments.length} comment(s).`);
  await sendLineFlex(altText, negativeSpikeBubble(brands, thresholdPct, comments, bangkokStamp()));

  return { alerted: spiking.map((s) => s.row.brand_slug) };
}

// ── Urgent negative comment (per-comment LINE alert) ────────────────────────
// Separate from checkNegativeSentimentSpikes() above (24h ratio across a
// brand). This pages immediately on a SINGLE comment/tweet with urgency>=4
// (see sentiment.ts's urgency rubric — 4=counterfeit/refund-threat/public
// complaint, 5=health/safety/viral risk). Cross-platform, own-brand only.

const URGENT_NEGATIVE_MIN_URGENCY = 4;

export interface UrgentNegativeRow {
  id: number;
  content: string;
  topic: string | null;
  urgency: number;
  brand_name: string;
  brand_slug: string;
  platform: string;
  postUrl?: string | null;
}

// LINE carousel containers cap out at 12 bubbles.
const CAROUSEL_MAX_BUBBLES = 12;

function urgentNegativeBubble(row: UrgentNegativeRow): Flex {
  const body: Flex[] = [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        kpiTile(`U${row.urgency}`, 'Urgency'),
        kpiTile(row.platform, 'Platform'),
      ],
    },
    { type: 'text', text: row.topic ? `Topic: ${row.topic}` : '', size: 'xxs', color: C.muted, margin: 'sm' },
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: truncate(row.content), size: 'xs', color: C.text, wrap: true, margin: 'lg' },
  ];

  const multiColor = isMultiColorPlatform(row.platform);
  const headerContents: Flex[] = multiColor
    ? [
        platformStripe(row.platform, '4px'),
        { type: 'text', text: '🚨 Urgent Negative Comment', color: C.white, weight: 'bold', size: 'lg', margin: 'md' },
        { type: 'text', text: `${row.brand_name} · ${row.platform}`, color: platformColor(row.platform), size: 'sm', margin: 'xs' },
      ]
    : [
        { type: 'text', text: '🚨 Urgent Negative Comment', color: C.white, weight: 'bold', size: 'lg' },
        { type: 'text', text: `${row.brand_name} · ${row.platform}`, color: '#fff1f2', size: 'sm', margin: 'xs' },
      ];

  const bubble: Flex = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical',
      backgroundColor: multiColor ? '#000000' : platformColor(row.platform, C.neg),
      paddingAll: '14px', contents: headerContents,
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
  };

  if (row.postUrl && /^https?:\/\//.test(row.postUrl)) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'button', style: 'primary', color: C.blue, height: 'sm',
        action: { type: 'uri', label: 'ดูโพสต์', uri: row.postUrl },
      }],
    };
  }

  return bubble;
}

/**
 * Called from classifyUnanalyzedComments right after a batch is freshly
 * classified — that function only ever selects sentiment IS NULL rows, so
 * each comment passes through here at most once. No separate dedup needed.
 *
 * Multiple urgent comments from the same classify batch are combined into
 * one LINE carousel message (one bubble per comment) instead of one push per
 * comment — a single classify pass finding 5 urgent comments should read as
 * one alert with 5 cards, not 5 separate notifications.
 */
export async function alertUrgentNegativeComments(rows: UrgentNegativeRow[]): Promise<number> {
  const qualifying = rows.filter((r) => r.urgency >= URGENT_NEGATIVE_MIN_URGENCY);
  if (qualifying.length === 0) return 0;

  for (let i = 0; i < qualifying.length; i += CAROUSEL_MAX_BUBBLES) {
    const chunk = qualifying.slice(i, i + CAROUSEL_MAX_BUBBLES);
    const bubbles = sanitizeCarousel(chunk.map(urgentNegativeBubble));
    const altText = chunk.length === 1
      ? `🚨 Urgent negative comment — ${chunk[0].brand_name} (U${chunk[0].urgency})`
      : `🚨 ${chunk.length} urgent negative comments found`;
    const contents = bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles };
    await sendLineFlex(altText, contents);
  }
  return qualifying.length;
}

/**
 * Manual test trigger (Settings → Alerts → "Send test negative-spike LINE
 * alert" button) — fires a real LINE message immediately using whichever own
 * brand currently has the highest negative share (last 24h), regardless of
 * whether it actually crosses the configured threshold. Falls back to a
 * synthetic sample if there's no classified data yet, so the button always
 * proves the LINE wiring works even on a fresh DB. Returns whether LINE was
 * actually configured (true) or the message just got logged as a stub (false).
 */
export async function sendTestNegativeSpikeAlert(): Promise<boolean> {
  const th = await getThresholds().catch(() => null);
  const thresholdPct = th?.negativeSpikePct ?? DEFAULT_NEGATIVE_SPIKE_PCT;

  const rows = await query<NegativeSpikeRow>(SPIKE_BRANDS_SQL);
  const top = rows.map(toSpikeBrand).filter((b) => b.total > 0).sort((x, y) => y.negPct - x.negPct)[0];

  if (!top) {
    const sample: NegativeSpikeComment[] = [
      { content: 'ใช้แล้วแพ้ หน้าแดงเป็นผื่น', topic: 'สุขภาพ', urgency: 5, brand_name: 'Test Brand', platform: 'tiktok', post_url: null },
      { content: 'ได้ของปลอมมา ขวดไม่เหมือนของจริง', topic: 'คุณภาพ', urgency: 4, brand_name: 'Test Brand', platform: 'twitter', post_url: null },
    ];
    return sendLineFlex(
      '🧪 Test alert — Negative Sentiment Spike',
      negativeSpikeBubble([{ brandId: 0, brandName: 'Test Brand (no data yet)', negPct: 42, negative: 5, total: 12 }], thresholdPct, sample, `🧪 TEST · ${bangkokStamp()}`),
    );
  }

  const comments = await fetchTopNegativeComments([top.brandId]);
  return sendLineFlex(
    `🧪 Test alert — ${top.brandName} · ${top.negPct.toFixed(0)}% negative`,
    negativeSpikeBubble([{ ...top, brandName: `${top.brandName} (TEST)` }], thresholdPct, comments, `🧪 TEST · ${bangkokStamp()}`),
  );
}
