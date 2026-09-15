/**
 * X campaign wrap-up report — Phase 6 (docs/scope-x-campaigns.md decision 5,
 * CONTEXT.md "Campaign report"). Computed ON-DEMAND from stored rows; no
 * snapshot table. Single source of truth, imported by BOTH the route
 * (api/routes/campaigns.ts GET /:id/report) and the CLI
 * (npm run report:campaign -- <campaignId>).
 *
 * Data sources (see file header comments on each query for detail):
 *   A) Anchor posts   — twitter_posts WHERE campaign_id = :id (owned reach).
 *   B) Replies+quotes — social_comments joined to those anchor posts
 *      (is_reply=true -> reply, is_reply=false -> quote tweet). Owned.
 *   C) Hashtag-UGC    — social_comments (platform='twitter', source_type=
 *      'search') published inside the campaign window and carrying one of
 *      the campaign's hashtags. Counts toward reach/sentiment but these rows
 *      are NOT anchor posts — earned, not owned.
 *
 * Window = [starts_at, ends_at + 3 days] — same tail as campaign-membership's
 * auto-assignment window (scope decision 8).
 *
 * No invented composite scores (SCOPE.md) — every number here is a raw
 * sum/count/group of stored columns or existing Gemini sentiment labels.
 */
import { socialQuery, socialQueryOne } from '../db/social-client';

const TOP_N = 10;

interface CampaignRow {
  id: number;
  brand_id: number;
  name: string;
  hashtags: string[];
  starts_at: string | null;
  ends_at: string | null;
  status: string;
}

export interface SentimentCounts {
  positive: number;
  negative: number;
  neutral: number;
  question: number;
  resale: number;
  unclassified: number;
  total: number;
}

export interface CampaignReport {
  campaign: {
    id: number;
    name: string;
    hashtags: string[];
    starts_at: string | null;
    ends_at: string | null;
    status: string;
    window_end: string | null; // ends_at + 3 days, or null if campaign has no window
  };
  reach: {
    owned: {
      anchor_posts: {
        count: number;
        views: number;
        likes: number;
        retweets: number;
        quotes_meta: number; // twitter_posts.quotes_count metadata (API-reported count)
        replies_meta: number; // twitter_posts.replies metadata (API-reported count)
      };
      replies_count: number; // social_comments rows, is_reply = true
      quote_tweets_count: number; // social_comments rows, is_reply = false
    };
    earned: {
      ugc_count: number;
      views: number;
      likes: number;
      retweets: number;
    };
  };
  sentiment: {
    replies_and_quotes: SentimentCounts; // B
    hashtag_ugc: SentimentCounts; // C
    combined: SentimentCounts; // B + C
  };
  hashtag_volume_curve: Array<{ date: string; count: number }>; // A + C, per day, zero-filled across the window
  top_anchor_posts: Array<{
    post_id: string;
    post_url: string | null;
    caption_snippet: string | null;
    views: number;
    likes: number;
    retweets: number;
    quotes: number;
    quotes_scraped: number;
    replies: number;
    posted_at: string | null;
    author_handle: string | null;
  }>;
  top_quote_tweets: Array<{
    external_id: string | null;
    author_name: string | null;
    post_url: string | null;
    content_snippet: string | null;
    sentiment: string | null;
    likes: number;
    retweets: number;
    views: number;
    published_at: string | null;
    anchor_post_id: string | null;
    anchor_caption_snippet: string | null;
    anchor_post_url: string | null;
  }>;
  top_amplifiers: Array<{
    author_name: string;
    post_count: number;
    total_reach: number;
    followers: number | null;
    top_post_url: string | null;
  }>;
}

const EMPTY_SENTIMENT: SentimentCounts = {
  positive: 0, negative: 0, neutral: 0, question: 0, resale: 0, unclassified: 0, total: 0,
};

function toSentimentCounts(rows: Array<{ sentiment: string | null; count: string }>): SentimentCounts {
  const counts = { ...EMPTY_SENTIMENT };
  for (const r of rows) {
    const n = parseInt(r.count, 10) || 0;
    const key = (r.sentiment ?? 'unclassified') as keyof SentimentCounts;
    if (key in counts && key !== 'total') counts[key] = n;
    counts.total += n;
  }
  return counts;
}

function addSentimentCounts(a: SentimentCounts, b: SentimentCounts): SentimentCounts {
  return {
    positive: a.positive + b.positive,
    negative: a.negative + b.negative,
    neutral: a.neutral + b.neutral,
    question: a.question + b.question,
    resale: a.resale + b.resale,
    unclassified: a.unclassified + b.unclassified,
    total: a.total + b.total,
  };
}

/**
 * Formats a Postgres `DATE` column value as YYYY-MM-DD. node-pg decodes the
 * `date` OID into a JS Date object at LOCAL midnight (not UTC midnight) — so
 * calling toISOString() on it (which converts to UTC) shifts the date by one
 * day whenever the host's local timezone isn't UTC. Read local getters
 * instead, since that's the calendar day node-pg actually encoded.
 */
function pgDateToISO(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function snippet(text: string | null, len = 200): string | null {
  if (!text) return null;
  return text.length > len ? `${text.slice(0, len)}…` : text;
}

/** Normalizes campaign.hashtags into `%#tag%` ILIKE patterns. Empty array if the campaign has no hashtags. */
function hashtagPatterns(hashtags: string[]): string[] {
  return (hashtags ?? [])
    .map((h) => h.replace(/^#/, '').trim().toLowerCase())
    .filter((h) => h.length > 0)
    .map((h) => `%#${h}%`);
}

/**
 * Builds the wrap-up report for one campaign. Returns null if the campaign
 * doesn't exist. A campaign with no starts_at/ends_at still gets a report —
 * owned reach (A+B) is always computable from campaign_id membership; earned
 * reach (C) is simply empty (hashtag-UGC needs a window to bound the ILIKE
 * scan against social_comments' full retention, not just this campaign).
 */
export async function getCampaignReport(campaignId: number): Promise<CampaignReport | null> {
  const campaign = await socialQueryOne<CampaignRow>(
    `SELECT id, brand_id, name, hashtags, starts_at, ends_at, status FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  if (!campaign) return null;

  // starts_at is the only hard requirement for a window — ends_at IS NULL
  // means "ongoing": the window is open-ended, so earned-reach/volume-curve
  // queries bound the far end at NOW() instead of ends_at+3 days.
  const hasWindow = !!campaign.starts_at;
  const isOngoing = hasWindow && !campaign.ends_at;
  const effectiveEnd: string = campaign.ends_at ?? new Date().toISOString();
  const patterns = hashtagPatterns(campaign.hashtags);
  const hasUgcScope = hasWindow && patterns.length > 0;

  // ── A) Anchor posts — owned reach + engagement metadata ──────────────────
  const anchorReach = await socialQueryOne<{
    anchor_count: string; views: string; likes: string; retweets: string; quotes_meta: string; replies_meta: string;
  }>(
    `SELECT COUNT(*) AS anchor_count,
            COALESCE(SUM(views), 0) AS views,
            COALESCE(SUM(likes), 0) AS likes,
            COALESCE(SUM(retweets_count), 0) AS retweets,
            COALESCE(SUM(quotes_count), 0) AS quotes_meta,
            COALESCE(SUM(replies), 0) AS replies_meta
     FROM twitter_posts
     WHERE campaign_id = $1`,
    [campaignId],
  );

  // ── B) Replies + quote tweets — counts + sentiment, joined to anchor posts.
  // JOIN idiom (post_id + brand_id) matches the existing GET /api/campaigns/:id
  // counts query — a post_id can theoretically repeat across brands, so the
  // brand_id match avoids cross-brand double-joins.
  const [bCounts, bSentimentRows] = await Promise.all([
    socialQueryOne<{ replies_count: string; quotes_count: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE sc.is_reply = true)  AS replies_count,
         COUNT(*) FILTER (WHERE sc.is_reply = false) AS quotes_count
       FROM social_comments sc
       JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
       WHERE tp.campaign_id = $1 AND sc.platform = 'twitter'`,
      [campaignId],
    ),
    socialQuery<{ sentiment: string | null; count: string }>(
      `SELECT sc.sentiment, COUNT(*) AS count
       FROM social_comments sc
       JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
       WHERE tp.campaign_id = $1 AND sc.platform = 'twitter'
       GROUP BY sc.sentiment`,
      [campaignId],
    ),
  ]);

  // ── C) Hashtag-UGC — earned reach + sentiment, bounded to [starts_at, ends_at+3d]
  // and matched by ILIKE ANY(%#tag%) against content. Not joined to twitter_posts
  // at all — these are third-party posts, not anchor posts.
  let ugcReach = { ugc_count: 0, views: 0, likes: 0, retweets: 0 };
  let cSentimentRows: Array<{ sentiment: string | null; count: string }> = [];
  if (hasUgcScope) {
    const [reachRow, sentimentRows] = await Promise.all([
      socialQueryOne<{ ugc_count: string; views: string; likes: string; retweets: string }>(
        `SELECT COUNT(*) AS ugc_count,
                COALESCE(SUM(views_count), 0) AS views,
                COALESCE(SUM(likes_count), 0) AS likes,
                COALESCE(SUM(retweets_count), 0) AS retweets
         FROM social_comments
         WHERE platform = 'twitter' AND source_type = 'search' AND brand_id = $1
           AND published_at >= $2 AND published_at <= $3::timestamptz + INTERVAL '3 days'
           AND content ILIKE ANY($4::text[])`,
        [campaign.brand_id, campaign.starts_at, effectiveEnd, patterns],
      ),
      socialQuery<{ sentiment: string | null; count: string }>(
        `SELECT sentiment, COUNT(*) AS count
         FROM social_comments
         WHERE platform = 'twitter' AND source_type = 'search' AND brand_id = $1
           AND published_at >= $2 AND published_at <= $3::timestamptz + INTERVAL '3 days'
           AND content ILIKE ANY($4::text[])
         GROUP BY sentiment`,
        [campaign.brand_id, campaign.starts_at, effectiveEnd, patterns],
      ),
    ]);
    if (reachRow) {
      ugcReach = {
        ugc_count: parseInt(reachRow.ugc_count, 10) || 0,
        views: parseInt(reachRow.views, 10) || 0,
        likes: parseInt(reachRow.likes, 10) || 0,
        retweets: parseInt(reachRow.retweets, 10) || 0,
      };
    }
    cSentimentRows = sentimentRows;
  }

  // ── hashtag_volume_curve — posts-per-day across A + C, zero-filled over the window.
  const [aDailyRows, cDailyRows] = await Promise.all([
    socialQuery<{ date: string; count: string }>(
      `SELECT DATE(posted_at) AS date, COUNT(*) AS count
       FROM twitter_posts WHERE campaign_id = $1 AND posted_at IS NOT NULL
       GROUP BY 1`,
      [campaignId],
    ),
    hasUgcScope
      ? socialQuery<{ date: string; count: string }>(
          `SELECT DATE(published_at) AS date, COUNT(*) AS count
           FROM social_comments
           WHERE platform = 'twitter' AND source_type = 'search' AND brand_id = $1
             AND published_at >= $2 AND published_at <= $3::timestamptz + INTERVAL '3 days'
             AND content ILIKE ANY($4::text[])
           GROUP BY 1`,
          [campaign.brand_id, campaign.starts_at, effectiveEnd, patterns],
        )
      : Promise.resolve([]),
  ]);

  const dailyMap = new Map<string, number>();
  for (const r of [...aDailyRows, ...cDailyRows]) {
    const date = pgDateToISO(r.date);
    dailyMap.set(date, (dailyMap.get(date) ?? 0) + (parseInt(r.count, 10) || 0));
  }
  // Zero-fill every day in the window so the curve has no gaps, when a window exists.
  if (hasWindow) {
    const start = new Date(campaign.starts_at as string);
    const end = new Date(new Date(effectiveEnd).getTime() + (isOngoing ? 0 : 3 * 86_400_000));
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
         d.getTime() <= end.getTime();
         d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      if (!dailyMap.has(key)) dailyMap.set(key, 0);
    }
  }
  const hashtagVolumeCurve = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, count]) => ({ date, count }));

  // ── top_anchor_posts — by engagement (likes+retweets+quotes+replies), tie-break on views.
  // quotes_scraped is the ACTUAL count of quote tweets we captured into
  // social_comments — kept alongside quotes_count (X's own metadata) since
  // the two can diverge a lot on posts with many quotes; the report should
  // show both rather than imply the scrape is complete when it isn't.
  const topAnchorRows = await socialQuery<{
    post_id: string; post_url: string | null; caption: string | null;
    views: string; likes: string; retweets_count: string; quotes_count: string; replies: string;
    posted_at: string | null; author_handle: string | null; quotes_scraped: string;
  }>(
    `SELECT tp.post_id, tp.post_url, tp.caption, tp.views, tp.likes, tp.retweets_count, tp.quotes_count, tp.replies,
            tp.posted_at, tp.author_handle,
            (SELECT COUNT(*) FROM social_comments sc
               WHERE sc.post_id = tp.post_id AND sc.brand_id = tp.brand_id AND sc.is_reply = false) AS quotes_scraped
     FROM twitter_posts tp
     WHERE tp.campaign_id = $1
     ORDER BY (tp.likes + tp.retweets_count + tp.quotes_count + tp.replies) DESC, tp.views DESC
     LIMIT ${TOP_N}`,
    [campaignId],
  );

  // ── top_quote_tweets — by engagement (likes+retweets+views), B is_reply=false only.
  // Pulls the anchor post's own caption/URL alongside each quote tweet so the
  // report doesn't show a quote in isolation — the reader needs to see what
  // it's quoting to make sense of it (context was getting scattered before).
  // No LIMIT — used to cap at 50 (TOP_QUOTES_N), which silently hid every
  // quote ranked below it (e.g. a low-engagement but genuinely on-message
  // fan quote) with no way to reach it, defeating the point of the
  // dashboard's per-anchor-post filter + pagination (campaigns-tab.tsx),
  // which expects the full set and slices client-side.
  const topQuoteRows = await socialQuery<{
    external_id: string | null; author_name: string | null; content: string | null; sentiment: string | null;
    likes_count: string | null; retweets_count: string | null; views_count: string | null;
    published_at: string | null; anchor_post_id: string | null;
    anchor_caption: string | null; anchor_post_url: string | null;
  }>(
    `SELECT sc.external_id, sc.author_name, sc.content, sc.sentiment,
            sc.likes_count, sc.retweets_count, sc.views_count, sc.published_at,
            tp.post_id AS anchor_post_id, tp.caption AS anchor_caption, tp.post_url AS anchor_post_url
     FROM social_comments sc
     JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
     WHERE tp.campaign_id = $1 AND sc.platform = 'twitter' AND sc.is_reply = false
     ORDER BY (COALESCE(sc.likes_count,0) + COALESCE(sc.retweets_count,0) + COALESCE(sc.views_count,0)) DESC`,
    [campaignId],
  );

  // ── top_amplifiers — quote-tweet authors (B, is_reply=false) + UGC authors (C),
  // grouped by author_name, summed reach (likes+retweets+views), MAX(followers).
  // Also carries each author's single highest-reach post (external_id — the
  // tweet's own id, not the anchor's) so the UI can link to a real tweet for
  // human verification instead of just naming the author.
  const topAmplifierRows = await socialQuery<{
    author: string; post_count: string; total_reach: string; followers: string | null; top_post_url: string | null;
  }>(
    `WITH combined AS (
       SELECT sc.author_name AS author, sc.external_id, sc.likes_count, sc.retweets_count, sc.views_count, sc.author_followers,
              (COALESCE(sc.likes_count,0) + COALESCE(sc.retweets_count,0) + COALESCE(sc.views_count,0)) AS reach
       FROM social_comments sc
       JOIN twitter_posts tp ON tp.post_id = sc.post_id AND tp.brand_id = sc.brand_id
       WHERE tp.campaign_id = $1 AND sc.platform = 'twitter' AND sc.is_reply = false
       ${hasUgcScope ? `
       UNION ALL
       SELECT sc.author_name AS author, sc.external_id, sc.likes_count, sc.retweets_count, sc.views_count, sc.author_followers,
              (COALESCE(sc.likes_count,0) + COALESCE(sc.retweets_count,0) + COALESCE(sc.views_count,0)) AS reach
       FROM social_comments sc
       WHERE sc.platform = 'twitter' AND sc.source_type = 'search' AND sc.brand_id = $2
         AND sc.published_at >= $3 AND sc.published_at <= $4::timestamptz + INTERVAL '3 days'
         AND sc.content ILIKE ANY($5::text[])
       ` : ''}
     ),
     top_post_per_author AS (
       SELECT DISTINCT ON (author) author, external_id
       FROM combined
       WHERE author IS NOT NULL AND author != '' AND external_id IS NOT NULL
       ORDER BY author, reach DESC
     )
     SELECT c.author,
            COUNT(*) AS post_count,
            COALESCE(SUM(COALESCE(c.likes_count,0) + COALESCE(c.retweets_count,0) + COALESCE(c.views_count,0)), 0) AS total_reach,
            MAX(c.author_followers) AS followers,
            CASE WHEN tpa.external_id IS NOT NULL THEN 'https://x.com/' || c.author || '/status/' || tpa.external_id END AS top_post_url
     FROM combined c
     LEFT JOIN top_post_per_author tpa ON tpa.author = c.author
     WHERE c.author IS NOT NULL AND c.author != ''
     GROUP BY c.author, tpa.external_id
     ORDER BY total_reach DESC
     LIMIT ${TOP_N}`,
    hasUgcScope
      ? [campaignId, campaign.brand_id, campaign.starts_at, effectiveEnd, patterns]
      : [campaignId],
  );

  const bSentiment = toSentimentCounts(bSentimentRows);
  const cSentiment = toSentimentCounts(cSentimentRows);

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      hashtags: campaign.hashtags,
      starts_at: campaign.starts_at,
      ends_at: campaign.ends_at,
      status: campaign.status,
      // null for both a windowless campaign and an ongoing one (no defined
      // end) — the dashboard shows "ongoing" for the latter via status/ends_at.
      window_end: hasWindow && campaign.ends_at
        ? new Date(new Date(campaign.ends_at as string).getTime() + 3 * 86_400_000).toISOString()
        : null,
    },
    reach: {
      owned: {
        anchor_posts: {
          count: parseInt(anchorReach?.anchor_count ?? '0', 10),
          views: parseInt(anchorReach?.views ?? '0', 10),
          likes: parseInt(anchorReach?.likes ?? '0', 10),
          retweets: parseInt(anchorReach?.retweets ?? '0', 10),
          quotes_meta: parseInt(anchorReach?.quotes_meta ?? '0', 10),
          replies_meta: parseInt(anchorReach?.replies_meta ?? '0', 10),
        },
        replies_count: parseInt(bCounts?.replies_count ?? '0', 10),
        quote_tweets_count: parseInt(bCounts?.quotes_count ?? '0', 10),
      },
      earned: ugcReach,
    },
    sentiment: {
      replies_and_quotes: bSentiment,
      hashtag_ugc: cSentiment,
      combined: addSentimentCounts(bSentiment, cSentiment),
    },
    hashtag_volume_curve: hashtagVolumeCurve,
    top_anchor_posts: topAnchorRows.map((r) => ({
      post_id: r.post_id,
      post_url: r.post_url,
      caption_snippet: snippet(r.caption),
      views: parseInt(r.views, 10) || 0,
      likes: parseInt(r.likes, 10) || 0,
      retweets: parseInt(r.retweets_count, 10) || 0,
      quotes: parseInt(r.quotes_count, 10) || 0,
      quotes_scraped: parseInt(r.quotes_scraped, 10) || 0,
      replies: parseInt(r.replies, 10) || 0,
      posted_at: r.posted_at,
      author_handle: r.author_handle,
    })),
    top_quote_tweets: topQuoteRows.map((r) => ({
      external_id: r.external_id,
      author_name: r.author_name,
      post_url: r.author_name && r.external_id ? `https://x.com/${r.author_name}/status/${r.external_id}` : null,
      content_snippet: snippet(r.content),
      sentiment: r.sentiment,
      likes: parseInt(r.likes_count ?? '0', 10) || 0,
      retweets: parseInt(r.retweets_count ?? '0', 10) || 0,
      views: parseInt(r.views_count ?? '0', 10) || 0,
      published_at: r.published_at,
      anchor_post_id: r.anchor_post_id,
      anchor_caption_snippet: snippet(r.anchor_caption, 120),
      anchor_post_url: r.anchor_post_url,
    })),
    top_amplifiers: topAmplifierRows.map((r) => ({
      author_name: r.author,
      post_count: parseInt(r.post_count, 10) || 0,
      total_reach: parseInt(r.total_reach, 10) || 0,
      followers: r.followers != null ? parseInt(r.followers, 10) : null,
      top_post_url: r.top_post_url,
    })),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
// Usage: npm run report:campaign -- <campaignId>
if (require.main === module) {
  // Last CLI arg is the campaign id — npm's "-- <id>" is appended after the
  // dotenv_config_path=.env.local arg already baked into the package.json
  // script, so process.argv[2] is NOT reliably the id; take the tail instead.
  const idArg = process.argv[process.argv.length - 1];
  const campaignId = parseInt(idArg, 10);
  if (Number.isNaN(campaignId)) {
    console.error('Usage: npm run report:campaign -- <campaignId>');
    process.exit(1);
  }
  getCampaignReport(campaignId)
    .then((report) => {
      if (!report) {
        console.error(`Campaign ${campaignId} not found`);
        process.exit(1);
      }
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
