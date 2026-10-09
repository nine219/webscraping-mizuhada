/**
 * Runtime settings loader.
 *
 * Reads the single row in `app_settings`, deep-merges over baked-in defaults,
 * caches for 60 s. Scrapers / cron / alerts call the typed getters below so
 * a missing key transparently falls back to the original hardcoded value.
 */

import { socialQuery, socialQueryOne } from '../db/social-client';
import {
  OWN_BRAND_HANDLES as DEFAULT_OWN_TIKTOK_HANDLES,
  OWN_INFLUENCERS as DEFAULT_OWN_INFLUENCERS,
} from '../scrapers/keywords';

export interface KeywordsSettings {
  tiktok: Record<string, string[]>;       // own-brand slug → keywords
  tiktokCategory: string[];
  xhs: string[];
  twitter: Record<string, string[]>;      // own-brand slug → keywords (X/Twitter)
  // Competitor slug → curated keywords (optional refinement — a competitor
  // with no rows here falls back to a bare brand-name match, see keywords.ts
  // matchBrandSlug()). Separate from `tiktok` above because searchAllBrands()
  // treats every `tiktok` entry as a dedicated own-brand search target, which
  // competitors must never be.
  competitorTiktok: Record<string, string[]>;
  ownHandlesTiktok: string[];
  ownHandlesTwitter: string[];            // X screen_names to skip in UGC results
  ownInfluencers: string[];
}

export interface ThresholdSettings {
  commentMinViews: number;       // skip comment scrape if views below
  commentMinCount: number;       // require >= this many comments
  minViewsForSpike: number;
  viralViewsThreshold: number;
  viralEngagementPct: number;
  minEngagementPct: number;
  // X (Twitter) equivalents of the four TikTok thresholds above. X's view/
  // engagement scale is much smaller than TikTok's for this account, so
  // these are NOT reused TikTok numbers — an initial guess (~1/10th the
  // TikTok view-count defaults) pending real X data, not a measured baseline.
  xMinViewsForSpike: number;
  xViralViewsThreshold: number;
  xViralEngagementPct: number;
  xMinEngagementPct: number;
  negativeSpikePct: number;      // alert when neg % above this
  // How far back own-brand feed scrapers (TikTok/Instagram/Twitter) look —
  // unifies what used to be 3 separate hardcoded "31 days" cutoffs. 0 = no
  // cutoff (all time). XHS has no age-based cutoff (note/scroll caps only),
  // so this doesn't apply there.
  feedMaxAgeDays: number;
  // Re-scrape a post's comments once its comment-count metadata has grown by
  // at least this many since the last scrape — unifies 4 previously-separate
  // hardcoded `>= 5` deltas (TikTok feed + search, Instagram, Twitter/X).
  commentGrowthDelta: number;
  // Per-platform scrape caps. Lower values = faster runs + less bot risk; higher = deeper coverage.
  scrapeLimits: {
    tiktokFeed:     { maxScrolls: number; maxPosts: number };
    tiktokSearch:   { maxScrolls: number; maxPosts: number };
    instagramFeed:  { maxScrolls: number; maxPosts: number };
    twitterSearch:  { maxScrolls: number; maxPosts: number };
    twitterComments: { maxScrolls: number; maxPosts: number };
    xhsFeed:        { maxScrolls: number; maxPosts: number };
    xhsSearch:      { maxScrolls: number; maxPosts: number };
  };
}

export interface AlertSettings {
  lineToken: string;
  lineGroupId: string;
}

export interface AiSettings {
  provider: 'gemini' | 'deepseek'; // which provider handles sentiment/translate/theme/relevance calls
}

export interface ScheduleEntry {
  enabled: boolean;
  label: string;
  cron: string;
}

export interface ScheduleSettings {
  sentiment: ScheduleEntry;
  tiktokFeed: ScheduleEntry;
  tiktokSearch: ScheduleEntry;
  instagram: ScheduleEntry;
  twitterSearch: ScheduleEntry;
  twitterComments: ScheduleEntry;
  twitterStatsRefresh: ScheduleEntry;
  tiktokStatsRefresh: ScheduleEntry;
  xhs: ScheduleEntry;
  campaignSync: ScheduleEntry;
  cleanup: ScheduleEntry;
  morningDigest: ScheduleEntry;
  weeklyDigest: ScheduleEntry;
  tiktokSpikeDigest: ScheduleEntry;
}

export interface AppSettings {
  keywords: KeywordsSettings;
  thresholds: ThresholdSettings;
  alerts: AlertSettings;
  schedules: ScheduleSettings;
  ai: AiSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  keywords: {
    // tiktok/tiktokCategory/xhs/twitter are no longer settings-blob-backed —
    // loadSettings() overwrites these with keyword_terms table rows below.
    // Empty stubs here only matter if that DB fetch itself fails.
    tiktok: {},
    tiktokCategory: [],
    xhs: [],
    twitter: {},
    competitorTiktok: {},
    ownHandlesTiktok: [...DEFAULT_OWN_TIKTOK_HANDLES],
    ownHandlesTwitter: [],
    ownInfluencers: [...DEFAULT_OWN_INFLUENCERS],
  },
  thresholds: {
    commentMinViews: 50_000,
    commentMinCount: 5,
    minViewsForSpike: 100_000,
    viralViewsThreshold: 500_000,
    viralEngagementPct: 2.0,
    minEngagementPct: 3.0,
    // Initial guess pending real X data, not a measured baseline (see ThresholdSettings comment).
    xMinViewsForSpike: 10_000,
    xViralViewsThreshold: 50_000,
    xViralEngagementPct: 0.2,
    xMinEngagementPct: 0.3,
    negativeSpikePct: 35,
    feedMaxAgeDays: 30,
    commentGrowthDelta: 5,
    scrapeLimits: {
      tiktokFeed:      { maxScrolls: 50, maxPosts: 200 },
      tiktokSearch:    { maxScrolls: 8,  maxPosts: 100 },
      instagramFeed:   { maxScrolls: 40, maxPosts: 150 },
      twitterSearch:   { maxScrolls: 15, maxPosts: 40 },
      // Campaign tracking wants every reply/quote on a tracked post, not a
      // capped sample — see twitter-comments.ts STALE_SCROLL_LIMIT comment.
      twitterComments: { maxScrolls: 500, maxPosts: 5000 },
      xhsFeed:         { maxScrolls: 30, maxPosts: 100 },
      xhsSearch:       { maxScrolls: 20, maxPosts: 80 },
    },
  },
  alerts: {
    // LINE_CHANNEL_ACCESS_TOKEN is the actual deployed var name (Messaging API
    // push token) — LINE_NOTIFY_TOKEN kept as a fallback for the older/deprecated
    // LINE Notify product name, in case an older .env still uses it.
    lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_NOTIFY_TOKEN ?? '',
    lineGroupId: process.env.LINE_GROUP_ID ?? '',
  },
  schedules: {
    sentiment:     { enabled: true, label: 'Sentiment classification',  cron: '0 */2 * * *' },
    tiktokFeed:    { enabled: true, label: 'TikTok feed scrape',        cron: '15 1,7,13,19 * * *' },
    tiktokSearch:  { enabled: true, label: 'TikTok UGC search',         cron: '0 */4 * * *' },
    instagram:     { enabled: true, label: 'Instagram feed + comments', cron: '30 3,9,15,21 * * *' },
    twitterSearch: { enabled: true, label: 'Twitter/X keyword search', cron: '45 */2 * * *' },
    twitterComments: { enabled: true, label: 'Twitter/X replies + quote tweets', cron: '35 */6 * * *' },
    twitterStatsRefresh: { enabled: true, label: 'X tracked-tweet stats refresh + spike check', cron: '20 */3 * * *' },
    tiktokStatsRefresh: { enabled: true, label: 'TikTok watchlist/spike stats refresh', cron: '40 5 * * 1' },
    // XHS (Xiaohongshu) feed → search → comments. Only registered in the
    // scraper-xhs container (SCRAPER_PLATFORM=xhs); the legacy all-in-one
    // scheduler never ran XHS on a cron, so this stays dormant there.
    xhs:           { enabled: true, label: 'XHS feed + search + comments', cron: '10 2,8,14,20 * * *' },
    campaignSync:  { enabled: true, label: 'X campaign status + membership sync', cron: '0 * * * *' },
    cleanup:       { enabled: true, label: 'Social DB cleanup',         cron: '0 3 * * *' },
    morningDigest: { enabled: true, label: 'LINE morning digest',       cron: '0 7 * * *' },
    weeklyDigest:  { enabled: true, label: 'Weekly digest',             cron: '0 8 * * 1' },
    tiktokSpikeDigest: { enabled: true, label: 'TikTok daily top-5 spike digest', cron: '0 18 * * *' },
  },
  ai: {
    provider: 'gemini',
  },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function deepMerge<T>(base: T, override: DeepPartial<T> | undefined | null): T {
  if (!override) return base;
  if (Array.isArray(base)) {
    return (Array.isArray(override) ? override : base) as T;
  }
  if (typeof base !== 'object' || base === null) {
    return (override as unknown as T) ?? base;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal)) {
      out[k] = deepMerge(baseVal, v as DeepPartial<typeof baseVal>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

interface CacheEntry {
  settings: AppSettings;
  loadedAt: number;
}

let cache: CacheEntry | null = null;
const TTL_MS = 60_000;

interface SettingsRow {
  settings: Record<string, unknown>;
}

interface KeywordTermRow {
  platform: string;
  brand_slug: string | null;
  brand_type: 'own' | 'competitor' | null;
  keyword: string;
}

async function loadKeywordTerms(): Promise<{
  tiktok: Record<string, string[]>;
  tiktokCategory: string[];
  xhs: string[];
  twitter: Record<string, string[]>;
  competitorTiktok: Record<string, string[]>;
}> {
  const tiktok: Record<string, string[]> = {};
  const twitter: Record<string, string[]> = {};
  const tiktokCategory: string[] = [];
  const xhs: string[] = [];
  const competitorTiktok: Record<string, string[]> = {};
  try {
    const rows = await socialQuery<KeywordTermRow>(
      `SELECT kt.platform, b.slug AS brand_slug, b.type AS brand_type, kt.keyword
       FROM keyword_terms kt
       LEFT JOIN brands b ON b.id = kt.brand_id
       ORDER BY kt.id`
    );
    for (const r of rows) {
      if (r.platform === 'tiktok' && r.brand_slug) {
        const bucket = r.brand_type === 'competitor' ? competitorTiktok : tiktok;
        (bucket[r.brand_slug] ??= []).push(r.keyword);
      } else if (r.platform === 'twitter' && r.brand_slug) {
        (twitter[r.brand_slug] ??= []).push(r.keyword);
      } else if (r.platform === 'tiktok_category') {
        tiktokCategory.push(r.keyword);
      } else if (r.platform === 'xhs') {
        xhs.push(r.keyword);
      }
    }
  } catch (err) {
    console.error('[settings-loader] keyword_terms fetch failed, keywords empty:', err);
  }
  return { tiktok, tiktokCategory, xhs, twitter, competitorTiktok };
}

export async function loadSettings(force = false): Promise<AppSettings> {
  if (!force && cache && Date.now() - cache.loadedAt < TTL_MS) {
    return cache.settings;
  }
  let stored: Record<string, unknown> = {};
  try {
    const row = await socialQueryOne<SettingsRow>(
      'SELECT settings FROM app_settings WHERE id = 1'
    );
    if (row?.settings) stored = row.settings;
  } catch (err) {
    console.error('[settings-loader] load failed, using defaults:', err);
  }
  const merged = deepMerge(DEFAULT_SETTINGS, stored as DeepPartial<AppSettings>);
  const kw = await loadKeywordTerms();
  merged.keywords.tiktok = kw.tiktok;
  merged.keywords.tiktokCategory = kw.tiktokCategory;
  merged.keywords.xhs = kw.xhs;
  merged.keywords.twitter = kw.twitter;
  merged.keywords.competitorTiktok = kw.competitorTiktok;
  cache = { settings: merged, loadedAt: Date.now() };
  return merged;
}

// TikTok competitor keyword lists (slug -> keywords) — used only by
// tiktok-search.ts's category-keyword competitor-attribution pass. A
// competitor with no rows here has no curated list; matchBrandSlug() falls
// back to matching the bare brand name in that case (see keywords.ts).
export async function getCompetitorTikTokKeywords(): Promise<Record<string, string[]>> {
  return (await loadSettings()).keywords.competitorTiktok;
}

// Raw stored override (pre-defaults-merge), for PUT /api/settings to merge
// a partial save into rather than overwrite outright — loadSettings()
// returns the defaults-merged view, which isn't safe to write back as-is
// (would permanently bake every default into the DB row).
export async function getStoredOverride(): Promise<Record<string, unknown>> {
  try {
    const row = await socialQueryOne<SettingsRow>(
      'SELECT settings FROM app_settings WHERE id = 1'
    );
    return row?.settings ?? {};
  } catch (err) {
    console.error('[settings-loader] getStoredOverride failed:', err);
    return {};
  }
}

export function invalidateSettingsCache(): void {
  cache = null;
}

// ── Typed getters used by scrapers/cron ───────────────────────────────────────

export async function getThresholds(): Promise<ThresholdSettings> {
  return (await loadSettings()).thresholds;
}

export async function getKeywords(): Promise<KeywordsSettings> {
  return (await loadSettings()).keywords;
}

export async function getAlerts(): Promise<AlertSettings> {
  return (await loadSettings()).alerts;
}

export async function getAiSettings(): Promise<AiSettings> {
  return (await loadSettings()).ai;
}

export async function isJobEnabled(job: keyof ScheduleSettings): Promise<boolean> {
  return (await loadSettings()).schedules[job].enabled;
}

export async function getTikTokSearchTargets(): Promise<Array<{ brandSlug: string; keywords: string[] }>> {
  const kw = await getKeywords();
  return Object.entries(kw.tiktok).map(([brandSlug, keywords]) => ({ brandSlug, keywords }));
}

export async function getTwitterSearchTargets(): Promise<Array<{ brandSlug: string; keywords: string[] }>> {
  const kw = await getKeywords();
  // Scope decision 10 (docs/scope-x-campaigns.md) narrowed X search to
  // MizuMi-only after Gentle Colors/Bomi keywords caused real 429s + a full
  // run-abort on 2026-07-13 (one shared X session, easy to overload). Staged
  // re-opening 2026-07-21: MizuMi-only ran 8 clean days, then Gentle Colors
  // went back on and also ran clean. A full 3-brand dry-run sweep (all of
  // MizuMi/Gentle Colors/Bomi's real keyword lists, production pacing) hit
  // zero rate-limits and the Gemini relevance verifier checked out clean on
  // everything it saved — so Bomi is back on too. Still filtering explicitly
  // (not "all of kw.twitter") so the allowlist stays the enforcement point;
  // watch `logs/scheduler-err.log` for "rate-limited by X" going forward.
  const ALLOWED = new Set(['mizumi', 'gentle-colors', 'bomi']);
  return Object.entries(kw.twitter)
    .filter(([brandSlug]) => ALLOWED.has(brandSlug))
    .map(([brandSlug, keywords]) => ({ brandSlug, keywords }));
}

export async function getTwitterOwnHandles(): Promise<Set<string>> {
  const kw = await getKeywords();
  return new Set(kw.ownHandlesTwitter.map((h) => h.toLowerCase().replace(/^@/, '')));
}
