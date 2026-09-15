// Server-side (SSR / route handlers) and browser resolve the API base
// differently once the dashboard runs in a Docker container: in the container
// "localhost" is the dashboard itself, so server-side calls must reach the api
// container by its compose service name (API_INTERNAL_URL=http://api:3001).
// The browser, which runs on the user's machine, keeps using the host-published
// NEXT_PUBLIC_API_URL (localhost:3001) or its relative-path/ngrok override.
// On the host/PM2 setup neither var forces anything and both fall back to
// localhost:3001, so behavior there is unchanged.
const BASE =
  typeof window === 'undefined'
    ? (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001')
    : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001');
// Matches src/api/require-api-key.ts on the backend — only enforced there
// when API_KEY is actually set, so leaving this unset locally still works.
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Free ngrok tunnels show a "you're about to visit..." interstitial
      // HTML page to the first request from a browser/session instead of
      // proxying through — since every request here is a fresh hit to the
      // tunnel (relative /api/... paths resolve to the same ngrok origin,
      // not localhost), this header unconditionally skips that. No-op for
      // any real backend, so safe to always send.
      'ngrok-skip-browser-warning': 'true',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Surface the server's JSON {error} message when there is one (e.g. the
    // settings/brands 409 duplicate-name response) instead of just the status code.
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `API ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Calendar range picker (dashboard/components/date-range-picker.tsx) emits
// either {days} or {from,to} — every list/stats fetch below accepts both
// shapes via this shared appender so pages can just spread `...range` into
// their params object without per-page plumbing.
export interface DateRange { days?: number; from?: string; to?: string }

function appendDateRange(qs: URLSearchParams, params?: DateRange): void {
  if (params?.from && params?.to) {
    qs.set('from', params.from);
    qs.set('to', params.to);
  } else if (params?.days) {
    qs.set('days', String(params.days));
  } else if (params?.days === 0) {
    // "All time" preset (DateRangePicker's 0-days pill). There's no
    // days=unlimited concept server-side — days<=0 there just falls back to
    // that route's own default — so send an explicit wide from/to instead,
    // which every route's WhereBuilder.dateRange() honours as a real range.
    qs.set('from', '2000-01-01');
    qs.set('to', new Date().toISOString().slice(0, 10));
  }
}

export interface OverviewStats {
  totalProducts: number;
  activeBrands: number;
  avgThreatLevel: number;
  alertsToday: number;
  newProducts7d: number;
}

export interface PriceMatrixRow {
  brand_name: string;
  brand_slug: string;
  threat_level: string;
  platform_slug: string;
  avg_price: string;
  min_price: string;
  product_count: string;
}

export interface RecentChange {
  product_name: string;
  brand_name: string;
  brand_slug: string;
  platform_slug: string;
  curr_price: string;
  prev_price: string;
  change_pct: string;
  direction: string;
  time: string;
  product_url: string | null;
}

export interface OverviewResponse {
  stats: OverviewStats;
  priceMatrix: PriceMatrixRow[];
  recentChanges: RecentChange[];
}

export async function fetchOverview(): Promise<OverviewResponse> {
  return apiFetch('/api/overview');
}

export interface PriceRow {
  product_id: number;
  product_name: string;
  brand_name: string;
  brand_slug: string;
  platform_slug: string;
  category: string;
  current_price: string;
  currency: string;
  last_seen_at: string;
  url: string | null;
  image_url: string | null;
}

export async function fetchPrices(params?: {
  brand?: string;
  platform?: string;
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{ data: PriceRow[]; page: number; limit: number; total: number }> {
  const qs = new URLSearchParams();
  if (params?.brand)    qs.set('brand', params.brand);
  if (params?.platform) qs.set('platform', params.platform);
  if (params?.category) qs.set('category', params.category);
  if (params?.search)   qs.set('search', params.search);
  if (params?.page)     qs.set('page', String(params.page));
  if (params?.limit)    qs.set('limit', String(params.limit));
  return apiFetch(`/api/prices?${qs}`);
}

export async function fetchPriceHistory(
  productId: number,
  days = 30
): Promise<{ history: Array<{ time: string; price: string; discount_pct: string | null; sold_count: string | null }> }> {
  return apiFetch(`/api/prices/history/${productId}?days=${days}`);
}

export async function fetchSoldHistory(
  productId: number,
  days = 30
): Promise<{ history: Array<{ day: string; sold_count: number | null }> }> {
  return apiFetch(`/api/prices/sold-history/${productId}?days=${days}`);
}

export interface SocialComment {
  id: number;
  post_id: string | null;
  content: string;
  content_translated: string | null;
  brand_name: string;
  brand_slug: string;
  platform: string;
  sentiment: string | null;
  sentiment_score: string | null;
  topic: string | null;
  urgency: number | null;
  /** 'other_brand' when this comment is actually about a different brand mentioned in the same post/thread. */
  brand_relevance: 'on_topic' | 'other_brand' | null;
  post_theme: string | null;
  published_at: string | null;
  scraped_at: string;
  post_url: string | null;
  likes_count: string | null;
  views_count: string | null;
  retweets_count: string | null;
  reply_count: string | null;
  author_followers: number | null;
  cover_url: string | null;
  note_type: string | null;
  author_name: string | null;
  author_avatar: string | null;
  /** X only: link to the reply-parent / quoted / retweeted-of tweet, if this one is any of those. */
  original_post_url: string | null;
  /** X only: 'original' | 'reply' | 'quote' | 'retweet'. Null for rows scraped before this existed, or non-Twitter platforms. */
  tweet_type: 'original' | 'reply' | 'quote' | 'retweet' | null;
}

// platform/sentiment accept either a single value or an array (multi-select
// filters join to a comma-separated list; the API splits it back apart).
export async function fetchSocial(params?: {
  sentiment?: string | string[];
  platform?: string | string[];
  brand?: string;
  page?: number;
  days?: number;
  /** Custom calendar range (YYYY-MM-DD, inclusive both ends) — wins over `days`. */
  from?: string;
  to?: string;
  /** Exact single day (YYYY-MM-DD) — chart drill-down. Takes priority over `days`/`from`/`to`. */
  date?: string;
  sort?: string;
  topic?: string;
  urgency?: number;
  limit?: number;
  search?: string;
}): Promise<{ data: SocialComment[]; page: number; limit: number; total: number }> {
  const qs = new URLSearchParams();
  if (params?.sentiment?.length) qs.set('sentiment', [params.sentiment].flat().join(','));
  if (params?.platform?.length)  qs.set('platform', [params.platform].flat().join(','));
  if (params?.brand)     qs.set('brand', params.brand);
  appendDateRange(qs, params);
  if (params?.date)      qs.set('date', params.date);
  if (params?.page)      qs.set('page', String(params.page));
  if (params?.sort)      qs.set('sort', params.sort);
  if (params?.topic)     qs.set('topic', params.topic);
  if (params?.urgency)   qs.set('urgency', String(params.urgency));
  if (params?.limit)     qs.set('limit', String(params.limit));
  if (params?.search)    qs.set('search', params.search);
  return apiFetch(`/api/social?${qs}`);
}

export interface SocialStats {
  sentimentDistribution: Array<{ sentiment: string; count: string }>;
  topicDistribution: Array<{ topic: string; count: string }>;
  brandSentiment: Array<{ brand_name: string; sentiment: string; count: string }>;
  topicSentiment: Array<{ topic: string; positive: string; negative: string; neutral: string; total: string }>;
  urgencyDistribution: Array<{ urgency: number; count: string }>;
  netSentiment: number;
  totalComments: number;
  lastScrapedAt: string | null;
}

export async function fetchSocialStats(params?: { days?: number; from?: string; to?: string; platform?: string | string[]; brand?: string; sentiment?: string | string[] }): Promise<SocialStats> {
  const qs = new URLSearchParams();
  appendDateRange(qs, params);
  if (params?.platform?.length)  qs.set('platform', [params.platform].flat().join(','));
  if (params?.brand)     qs.set('brand', params.brand);
  if (params?.sentiment?.length) qs.set('sentiment', [params.sentiment].flat().join(','));
  return apiFetch(`/api/social/stats${qs.toString() ? '?' + qs : ''}`);
}


export async function fetchChangeFeed(
  limit = 50,
  minChangePct = 3
): Promise<{ data: RecentChange[] }> {
  return apiFetch(`/api/change-feed?limit=${limit}&minChangePct=${minChangePct}`);
}

export async function sendChatMessage(message: string): Promise<{ reply: string }> {
  return apiFetch('/api/chat', { method: 'POST', body: JSON.stringify({ message }) });
}

export interface Brand {
  id: number;
  name: string;
  slug: string;
  type: string;
  threat_level: string | null;
  product_count?: string;
  avg_price?: string;
  min_price?: string;
  max_price?: string;
  platforms?: string[];
  website_url: string | null;
  shopee_url: string | null;
  notes: string | null;
}

export interface BrandDetail {
  brand: Brand;
  products: PriceRow[];
  priceHistory: Array<{ time: string; avg_price: string; product_count: string }>;
}

export async function fetchBrands(): Promise<Brand[]> {
  return apiFetch('/api/brands');
}

export async function fetchBrand(slug: string): Promise<BrandDetail> {
  return apiFetch(`/api/brands/${slug}`);
}

// ── Search Rankings ────────────────────────────────────────────────────

export interface SearchKeyword {
  keyword: string;
  label: string;
  relevantBrands: string[];
  group: 'mizumi' | 'bomi' | 'gentle-colors' | 'competitor';
}

export interface RankingResult {
  position: number;
  external_id: string;
  product_name: string;
  brand_id: number | null;
  brand_name: string | null;
  brand_slug: string | null;
  shop_id: string;
  price: string | null;
  sold_count: number | null;
  rating: string | null;
  review_count: number | null;
  is_ad: boolean;
  badge: string | null;
  image_url: string | null;
  product_url: string;
  gemini_category: string | null;
}

export interface RankingsResponse {
  keyword: string;
  platform: string;
  scraped_at: string | null;
  results: RankingResult[];
}

export interface BrandAppearance {
  keyword: string;
  position: number;
  product_name: string;
  price: string | null;
  sold_count: number | null;
  is_ad: boolean;
  badge: string | null;
  scraped_at: string;
  gemini_category: string | null;
}

export async function fetchKeywords(): Promise<{ keywords: SearchKeyword[] }> {
  return apiFetch('/api/rankings/keywords');
}

export async function fetchRankings(keyword: string, platform = 'shopee_th'): Promise<RankingsResponse> {
  return apiFetch(`/api/rankings?keyword=${encodeURIComponent(keyword)}&platform=${platform}`);
}

export async function fetchBrandRankings(slug: string): Promise<{ brand_slug: string; appearances: BrandAppearance[] }> {
  return apiFetch(`/api/rankings/brand/${slug}`);
}

// ── TikTok ─────────────────────────────────────────────────────────────────

export interface TikTokPost {
  id: number;
  post_id: string;
  video_url: string | null;
  cover_url: string | null;
  post_url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  views: number;
  likes: number;
  shares: number;
  comments_count: number;
  posted_at: string | null;
  engagement_rate: string | null;
  spike_flag: boolean;
  spike_detected_at: string | null;
  is_shop_content: boolean;
  shop_signal: string | null;
  watchlist: boolean;
  scraped_at: string;
  brand_name: string;
  brand_slug: string;
  source_type: string;
  author_handle: string | null;
  theme?: string | null;
  dominant_sentiment: string | null;
  sentiment_positive: number;
  sentiment_negative: number;
  sentiment_neutral: number;
  sentiment_question: number;
}

// Content-type tags — keep in sync with CONTENT_THEMES in src/analysis/post-theme.ts
export const CONTENT_THEMES = [
  'Product Review',
  'Tutorial / How-to',
  'Unboxing',
  'Comparison',
  'Routine / GRWM',
  'Before / After',
  'Challenge / Trend',
  'Educational',
  'Lifestyle / Vlog',
  'Promotion / Sale',
  'Podcast',
  'Other',
] as const;

export interface TikTokTrendingHashtag {
  hashtag: string;
  category: string;
  brand_slug: string | null;
  view_count: number | null;
  post_count: number | null;
  scraped_at: string;
}

export interface TikTokBrandHashtag {
  hashtag: string;
  brand_slug: string;
  brand_name: string;
  count: number;
}

export interface TikTokHashtag {
  hashtag: string;
  count: number;
  brand_slug?: string;
}

export interface TikTokPostsResponse {
  data: TikTokPost[];
  page: number;
  limit: number;
  total: number;
  stats?: { total_views: number; avg_engagement: number; spike_count: number; last_scraped_at: string | null };
}

export interface TikTokPostDetail {
  post: TikTokPost;
  sentiments: Array<{ sentiment: string; count: number }>;
  comments: Array<{ id: number; content: string; content_translated: string | null; sentiment: string | null; published_at: string | null; likes_count: number; brand_relevance: 'on_topic' | 'other_brand' | null }>;
}

export async function fetchTikTokPosts(params?: {
  page?: number; limit?: number; brand?: string; spike?: boolean; watchlist?: boolean;
  days?: number; from?: string; to?: string; sort?: string; source_type?: string;
}): Promise<TikTokPostsResponse> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.brand) qs.set('brand', params.brand);
  if (params?.spike !== undefined) qs.set('spike', String(params.spike));
  if (params?.watchlist) qs.set('watchlist', 'true');
  appendDateRange(qs, params);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.source_type) qs.set('source_type', params.source_type);
  return apiFetch(`/api/tiktok/posts?${qs}`);
}

export async function deletePost(postId: string): Promise<void> {
  await apiFetch(`/api/tiktok/posts/${postId}`, { method: 'DELETE' });
}

export async function toggleWatchlist(postId: string): Promise<{ watchlist: boolean }> {
  return apiFetch(`/api/tiktok/posts/${postId}/watchlist`, { method: 'PATCH' });
}

export async function updatePostTheme(postId: string, theme: string): Promise<{ theme: string }> {
  return apiFetch(`/api/tiktok/posts/${postId}/theme`, { method: 'PATCH', body: JSON.stringify({ theme }) });
}

export async function triggerPostCommentScrape(postId: string): Promise<{ jobId: string; started: boolean }> {
  return apiFetch(`/api/tiktok/posts/${postId}/scrape-comments`, { method: 'POST' });
}

export async function fetchTikTokPost(postId: string, sentiment?: string): Promise<TikTokPostDetail> {
  const qs = sentiment ? `?sentiment=${encodeURIComponent(sentiment)}` : '';
  return apiFetch(`/api/tiktok/posts/${postId}${qs}`);
}

export interface TikTokCreatorDetail {
  creator: {
    handle: string;
    url: string;
    followers: number | null;
    tier: 'nano' | 'micro' | 'mid' | 'macro' | 'mega' | 'unknown';
    posts: number;
    total_views: number;
    total_likes: number;
    total_shares: number;
    total_comments: number;
    avg_engagement_pct: number;
    brands: string[];
    first_seen: string | null;
    last_seen: string | null;
    /** Posts in the trailing 30 days — recurring creator vs. one-off mention. */
    posts_last_30d: number;
    /** True if this handle is in the ambassador allowlist (kw.ownInfluencers) — shown, not excluded. */
    is_ambassador: boolean;
    sentiment: {
      positive: number; negative: number; neutral: number; question: number;
      positiveTopics: { topic: string; count: number }[];
      negativeTopics: { topic: string; count: number }[];
    };
  };
  posts: Array<{
    id: number;
    post_id: string;
    post_url: string;
    caption: string | null;
    hashtags: string[];
    views: number;
    likes: number;
    shares: number;
    comments_count: number;
    engagement_rate: number;
    posted_at: string | null;
    spike_flag: boolean;
    theme: string | null;
    brand_name: string;
    brand_slug: string;
  }>;
}

export async function fetchTikTokCreator(handle: string): Promise<TikTokCreatorDetail> {
  return apiFetch(`/api/tiktok/creators/${encodeURIComponent(handle)}`);
}

export async function fetchTikTokSpikes(params?: { page?: number; limit?: number; brand?: string; days?: number; from?: string; to?: string }): Promise<TikTokPostsResponse> {
  const qs = new URLSearchParams();
  if (params?.page)    qs.set('page', String(params.page));
  if (params?.limit)   qs.set('limit', String(params.limit));
  if (params?.brand)   qs.set('brand', params.brand);
  appendDateRange(qs, params);
  return apiFetch(`/api/tiktok/spikes?${qs}`);
}

export async function fetchTikTokHashtags(params?: { brand?: string; days?: number; from?: string; to?: string }): Promise<{ data: TikTokHashtag[] }> {
  const qs = new URLSearchParams();
  if (params?.brand) qs.set('brand', params.brand);
  appendDateRange(qs, params);
  return apiFetch(`/api/tiktok/hashtags?${qs}`);
}


export async function fetchTikTokTrendingHashtags(): Promise<{
  trending: TikTokTrendingHashtag[];
  brand_hashtags: TikTokBrandHashtag[];
}> {
  return apiFetch('/api/tiktok/trending-hashtags');
}

export async function updateCommentSentiment(
  commentId: number,
  patch: { sentiment?: string | null; topic?: string | null },
): Promise<{ id: number; sentiment: string | null; topic: string | null }> {
  return apiFetch(`/api/social/comments/${commentId}/sentiment`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function fetchSocialTopics(): Promise<string[]> {
  const r = await apiFetch<{ topics: string[] }>('/api/social/topics');
  return r.topics;
}

// ── TikTok Search Mentions ─────────────────────────────────────────────────

export interface TikTokSearchPost {
  id: number;
  post_id: string;
  post_url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  views: number;
  likes: number;
  shares: number;
  comments_count: number;
  posted_at: string | null;
  engagement_rate: string | null;
  scraped_at: string;
  brand_name: string;
  brand_slug: string;
  author_handle: string | null;
  search_keywords: string[];
  spike_flag: boolean;
  watchlist: boolean;
  is_shop_content: boolean;
  shop_signal: string | null;
}

export async function fetchTikTokSearchMentions(params?: {
  page?: number; limit?: number; brand?: string; spike?: boolean; watchlist?: boolean; days?: number; from?: string; to?: string;
  keyword?: string; sort?: string; author?: string; caption?: string;
}): Promise<{ data: TikTokSearchPost[]; page: number; limit: number; total: number; stats?: { total_views: number; avg_engagement: number; last_scraped_at: string | null } }> {
  const qs = new URLSearchParams();
  if (params?.page)    qs.set('page', String(params.page));
  if (params?.limit)   qs.set('limit', String(params.limit));
  if (params?.brand)   qs.set('brand', params.brand);
  if (params?.spike != null) qs.set('spike', String(params.spike));
  if (params?.watchlist) qs.set('watchlist', 'true');
  appendDateRange(qs, params);
  if (params?.keyword) qs.set('keyword', params.keyword);
  if (params?.sort)    qs.set('sort', params.sort);
  if (params?.author)  qs.set('author', params.author);
  if (params?.caption) qs.set('caption', params.caption);
  return apiFetch(`/api/tiktok/search?${qs}`);
}

export interface TikTokSearchStats {
  keyword_breakdown: { keyword: string; post_count: number; total_views: number }[];
  top_authors:       { handle: string; mention_count: number; total_views: number; total_likes: number }[];
  sentiment:         { positive: number; negative: number; neutral: number; question: number; total: number };
  daily_trend:       { date: string; post_count: number; total_views: number; total_engagement: number }[];
}

export async function fetchTikTokSearchStats(params?: {
  brand?: string;
  days?: number;
  from?: string;
  to?: string;
}): Promise<TikTokSearchStats> {
  const q = new URLSearchParams();
  if (params?.brand) q.set('brand', params.brand);
  appendDateRange(q, params);
  return apiFetch(`/api/tiktok/search/stats${q.toString() ? '?' + q : ''}`);
}

// ── Xiaohongshu (XHS) ──────────────────────────────────────────────────────
export interface XhsMention {
  id: number;
  note_id: string;
  note_url: string;
  is_note: boolean;
  content: string;
  content_translated: string | null;
  sentiment: 'positive' | 'negative' | 'neutral' | 'question' | null;
  topic: string | null;
  published_at: string | null;
  scraped_at: string;
  likes_count: number | null;
  cover_url: string | null;
  note_type: string | null;
  author_name: string | null;
  search_keyword: string | null;
  comment_count: number;
  brand_name: string | null;
  brand_slug: string | null;
}

export async function fetchXhsMentions(params?: {
  page?: number; limit?: number; brand?: string; days?: number; from?: string; to?: string;
  sentiment?: string; topic?: string; keyword?: string; author?: string; searchKeyword?: string;
  source?: string; sort?: string;
}): Promise<{ data: XhsMention[]; page: number; limit: number; total: number }> {
  const qs = new URLSearchParams();
  if (params?.page)      qs.set('page', String(params.page));
  if (params?.limit)     qs.set('limit', String(params.limit));
  if (params?.brand)     qs.set('brand', params.brand);
  appendDateRange(qs, params);
  if (params?.sentiment) qs.set('sentiment', params.sentiment);
  if (params?.topic)     qs.set('topic', params.topic);
  if (params?.keyword)   qs.set('keyword', params.keyword);
  if (params?.author)    qs.set('author', params.author);
  if (params?.searchKeyword) qs.set('searchKeyword', params.searchKeyword);
  if (params?.source)    qs.set('source', params.source);
  if (params?.sort)      qs.set('sort', params.sort);
  return apiFetch(`/api/xhs/mentions?${qs}`);
}

export interface XhsNotePost {
  id: number;
  note_id: string;
  note_url: string;
  content: string;
  content_translated: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  topic: string | null;
  published_at: string | null;
  scraped_at: string;
  likes_count: number | null;
  cover_url: string | null;
  note_type: string | null;
  author_name: string | null;
  author_avatar: string | null;
  source_type: string | null;
  brand_name: string | null;
  brand_slug: string | null;
}

export interface XhsNoteDetail {
  post: XhsNotePost;
  sentiments: Array<{ sentiment: string; count: number }>;
  comments: Array<{ id: number; content: string; content_translated: string | null; sentiment: string | null; published_at: string | null; likes_count: number }>;
}

export async function fetchXhsNote(noteId: string, sentiment?: string): Promise<XhsNoteDetail> {
  const qs = sentiment ? `?sentiment=${encodeURIComponent(sentiment)}` : '';
  return apiFetch(`/api/xhs/note/${noteId}${qs}`);
}

export interface XhsStats {
  total_mentions: number;
  total_notes: number;
  last_scraped_at: string | null;
  sentiment: { positive: number; negative: number; neutral: number; question: number; total: number };
  topic_breakdown: { topic: string; count: number }[];
  brand_breakdown: { brand_slug: string; brand_name: string; count: number }[];
  daily_trend: { date: string; count: number }[];
  keyword_breakdown: { keyword: string; post_count: number; total_likes: number }[];
  top_authors: { handle: string; mention_count: number; total_likes: number }[];
}

export interface Influencer {
  handle: string;
  url: string;
  posts: number;
  followers: number | null;
  tier: 'nano' | 'micro' | 'mid' | 'macro' | 'mega' | 'unknown';
  total_views: number;
  best_views: number;
  total_likes: number;
  avg_engagement_pct: number;
  follower_engagement_pct: number | null;
  brands: string[];
  brand_count: number;
  last_seen: string | null;
  /** Posts in the trailing 30 days — recurring creator vs. one-off mention. */
  posts_last_30d: number;
  /** True if this handle is in the ambassador allowlist (kw.ownInfluencers) — shown, not excluded. */
  is_ambassador: boolean;
  /** Soft signal: avg_engagement_pct is a large multiple of the result set's median. Not a filter. */
  engagement_outlier: boolean;
  sentiment: { positive: number; negative: number; neutral: number; label: 'positive' | 'negative' | 'mixed' | 'unknown'; positivePct: number | null };
}

export interface InfluencerHeadline {
  mostMentions: { handle: string; url: string; posts: number; followers: number | null; avg_engagement_pct: number } | null;
  mostViews: { handle: string; url: string; total_views: number; posts: number; followers: number | null } | null;
  multiBrandCount: number;
}

export interface InfluencerResponse {
  influencers: Influencer[];
  total: number;
  page: number;
  perPage: number;
  tierCounts: Record<string, number>;
  headline: InfluencerHeadline;
}

export async function fetchInfluencers(params?: {
  brand?: string; days?: number; from?: string; to?: string; sort?: string; minPosts?: number;
  search?: string; tier?: string; page?: number; perPage?: number;
}): Promise<InfluencerResponse> {
  const qs = new URLSearchParams();
  if (params?.brand)    qs.set('brand', params.brand);
  appendDateRange(qs, params);
  if (params?.sort)     qs.set('sort', params.sort);
  if (params?.minPosts) qs.set('minPosts', String(params.minPosts));
  if (params?.search)   qs.set('search', params.search);
  if (params?.tier)     qs.set('tier', params.tier);
  if (params?.page)     qs.set('page', String(params.page));
  if (params?.perPage)  qs.set('perPage', String(params.perPage));
  return apiFetch(`/api/tiktok/influencers${qs.toString() ? '?' + qs : ''}`);
}

export async function fetchXhsStats(params?: { brand?: string; days?: number; from?: string; to?: string; source?: string }): Promise<XhsStats> {
  const q = new URLSearchParams();
  if (params?.brand)  q.set('brand', params.brand);
  appendDateRange(q, params);
  if (params?.source) q.set('source', params.source);
  return apiFetch(`/api/xhs/stats${q.toString() ? '?' + q : ''}`);
}

export interface TwitterSession {
  valid: boolean;
  profileDir?: string;
  checkedAt?: string;
  hint?: string;
}

export async function fetchTwitterSession(): Promise<TwitterSession> {
  return apiFetch('/api/twitter/session');
}

export async function triggerTwitterLogin(): Promise<{ started: boolean; jobId?: string; message: string; novncUrl?: string }> {
  return apiFetch('/api/twitter/login', { method: 'POST', body: JSON.stringify({}) });
}

// ── X (Twitter) posts — feed/anchor posts, spike flag ───────────────────────
// Mirrors InstagramPost/fetchInstagramPosts' shape (src/api/routes/twitter.ts's
// GET /posts docstring: mirrors GET /api/tiktok/posts, adapted to X's columns).
// MizuMi-only server-side (docs/scope-x-campaigns.md decision 10) — no brand
// param, unlike TikTok/Instagram. Fetch-all architecture (no page/limit/sort
// param) per commit 986bb61's already-established X convention.
export interface TwitterPost {
  id: number;
  post_id: string;
  post_url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  views: number;
  likes: number;
  retweets_count: number;
  replies: number;
  quotes_count: number;
  posted_at: string | null;
  engagement_rate: string | null;
  spike_flag: boolean;
  spike_detected_at: string | null;
  scraped_at: string;
  source_type: string;
  author_handle: string | null;
  campaign_id: number | null;
  is_ambassador: boolean;
  campaign_locked: boolean;
  brand_name: string;
  brand_slug: string;
  dominant_sentiment: string | null;
  sentiment_positive: number;
  sentiment_negative: number;
  sentiment_neutral: number;
  sentiment_question: number;
}

export interface TwitterPostsResponse {
  data: TwitterPost[];
  total: number;
  stats: { total_views: number; avg_engagement: number; spike_count: number; last_scraped_at: string | null };
}

export async function fetchTwitterPosts(params?: {
  campaign_id?: number; spike?: boolean; days?: number; from?: string; to?: string;
}): Promise<TwitterPostsResponse> {
  const qs = new URLSearchParams();
  if (params?.campaign_id != null) qs.set('campaign_id', String(params.campaign_id));
  if (params?.spike != null) qs.set('spike', String(params.spike));
  appendDateRange(qs, params);
  return apiFetch(`/api/twitter/posts${qs.toString() ? '?' + qs : ''}`);
}

// ── X (Twitter) UGC mentions/stats ───────────────────────────────────────────
// Mirrors GET /api/tiktok/search/stats' shape. high_reach/top_high_reach_mentions
// are read-time-derived (not a stored column) — src/api/routes/twitter.ts's
// GET /mentions/stats docstring: a mention counts as high-reach if its views
// clear thresholds.xViralViewsThreshold OR its retweets clear a flat 100 —
// scoped server-side to source_type='search' UGC mentions only. Optional
// ?brand= narrows to one own brand (X UGC search only ever attributes rows
// to MizuMi/Gentle Colors/Bomi, never a competitor); omitted covers all 3.
export interface TwitterMentionsStats {
  top_authors: { handle: string; mention_count: number; total_views: number; total_likes: number }[];
  sentiment: { positive: number; negative: number; neutral: number; question: number; resale: number; total: number };
  daily_trend: { date: string; post_count: number; total_views: number; total_engagement: number }[];
  high_reach: { count: number; threshold_views: number; threshold_retweets: number };
  top_high_reach_mentions: {
    external_id: string | null; author_name: string | null; post_url: string | null;
    content_snippet: string | null; views_count: number; retweets_count: number; likes_count: number;
    published_at: string | null; is_high_reach: true;
  }[];
}

export async function fetchTwitterMentionsStats(params?: { days?: number; from?: string; to?: string; brand?: string }): Promise<TwitterMentionsStats> {
  const qs = new URLSearchParams();
  appendDateRange(qs, params);
  if (params?.brand) qs.set('brand', params.brand);
  return apiFetch(`/api/twitter/mentions/stats${qs.toString() ? '?' + qs : ''}`);
}

// ── Account Management (Settings tab) — session status + login flow ────────
// Same shape across all 4 scraped platforms (TikTok, Instagram, XHS mirror
// Twitter's session/login pattern above).
export interface PlatformSession {
  valid: boolean;
  profileDir?: string;
  checkedAt?: string;
  hint?: string;
}

export async function fetchTikTokSession(): Promise<PlatformSession> {
  return apiFetch('/api/tiktok/session');
}

export async function triggerTikTokLogin(opts?: { force?: boolean }): Promise<{ started: boolean; jobId?: string; message: string; novncUrl?: string }> {
  return apiFetch('/api/tiktok/login', { method: 'POST', body: JSON.stringify({ force: !!opts?.force }) });
}

// Ad-hoc single-account feed scrape — pull ALL recent posts from one account
// by profile link/handle (XHS: full profile URL, no @handle) into a
// competitor brand row. Same shape across all 3 platforms that support it —
// X/Twitter has no feed-scrape concept (no own-account post puller), so it's
// excluded here same as it is from Multi-Platform Search.
export type FeedScrapePlatform = 'tiktok' | 'instagram' | 'xhs';

export async function triggerAdhocFeedScrape(
  platform: FeedScrapePlatform,
  input: string,
  brandName?: string,
  opts?: {
    /** 0 = all time. Omit to use the Settings → Thresholds default. Ignored for XHS (no age cutoff). */
    lookbackDays?: number;
    /** Default true server-side if omitted. */
    scrapeComments?: boolean;
  },
): Promise<{ jobId: string; started: boolean; brandSlug: string; handle?: string }> {
  return apiFetch(`/api/${platform}/scrape/adhoc`, {
    method: 'POST',
    body: JSON.stringify({ input, brandName, ...opts }),
  });
}

export async function fetchInstagramSession(): Promise<PlatformSession> {
  return apiFetch('/api/instagram/session');
}

export async function triggerInstagramLogin(): Promise<{ started: boolean; jobId?: string; message: string; novncUrl?: string }> {
  return apiFetch('/api/instagram/login', { method: 'POST', body: JSON.stringify({}) });
}

export async function fetchXhsSession(): Promise<PlatformSession> {
  return apiFetch('/api/xhs/session');
}

export async function triggerXhsLogin(): Promise<{ started: boolean; jobId?: string; message: string }> {
  return apiFetch('/api/xhs/login', { method: 'POST', body: JSON.stringify({}) });
}

export interface ScrapeJobStatus {
  id: string;
  brand: string;
  platform: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  message: string;
  count: number;
  startedAt: string;
  finishedAt?: string;
  /** Job-type-specific payload (e.g. TrackLinkResult, SearchXResult) — only ever set on job_types that need data back, not just a count. */
  result?: unknown;
}

export async function fetchScrapeJobStatus(jobId: string): Promise<ScrapeJobStatus> {
  return apiFetch(`/api/scrape/status/${jobId}`);
}

/** Cooperative cancellation — the scraper notices between steps (keyword/scroll), not instantly. Currently honored by TikTok and X search jobs; XHS has no cancel support yet. */
export async function stopScrapeJob(jobId: string): Promise<{ stopped: boolean; message?: string }> {
  return apiFetch(`/api/scrape/stop/${jobId}`, { method: 'POST' });
}

/** Recent jobs (running + last ~30 finished) — used to detect a platform's browser already in use. */
export async function fetchScrapeJobs(): Promise<ScrapeJobStatus[]> {
  return apiFetch('/api/scrape/jobs');
}

export type MultiSearchPlatform = 'tiktok' | 'xhs' | 'twitter';

export async function triggerMultiSearch(
  keyword: string,
  platforms: MultiSearchPlatform[],
  brandSlug: string,
): Promise<{ started: boolean; jobs: { platform: MultiSearchPlatform; jobId: string }[] }> {
  return apiFetch('/api/admin/multi-search', { method: 'POST', body: JSON.stringify({ keyword, platforms, brandSlug }) });
}

// ── Social DB brands (settings-managed own/competitor rows) ──────────────────
// Distinct from `Brand`/`fetchBrands` above, which is the legacy main-DB
// (price-scraping) brand table. This is the Social DB `brands` table behind
// /api/settings/brands — own brands (MizuMi/Gentle Colors/Bomi) + any
// competitor rows created ad-hoc via Feed Scrape / this picker.
export interface SocialBrand {
  id: number;
  name: string;
  slug: string;
  type: 'own' | 'competitor';
  tiktok_handle: string | null;
  instagram_handle: string | null;
}

export async function fetchSocialBrands(): Promise<SocialBrand[]> {
  return apiFetch('/api/settings/brands');
}

export async function createSocialBrand(form: {
  name: string;
  slug: string;
  type: 'own' | 'competitor';
  tiktok_handle?: string;
  instagram_handle?: string;
}): Promise<SocialBrand> {
  return apiFetch('/api/settings/brands', { method: 'POST', body: JSON.stringify(form) });
}

export interface UserNotification {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  related_post_id: string | null;
  created_at: string;
}

export async function fetchNotifications(params?: { userId?: string; limit?: number; unreadOnly?: boolean }): Promise<{ notifications: UserNotification[]; unreadCount: number }> {
  const qs = new URLSearchParams();
  if (params?.userId) qs.set('user_id', params.userId);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.unreadOnly) qs.set('unreadOnly', 'true');
  return apiFetch(`/api/notifications?${qs}`);
}

export async function markNotificationRead(id: number, userId?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH', body: JSON.stringify({ user_id: userId }) });
}

export async function markAllNotificationsRead(userId?: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({ user_id: userId }) });
}

// ── Instagram ─────────────────────────────────────────────────────────────────

export interface InstagramPost {
  id: number;
  post_id: string;
  media_url: string | null;
  post_url: string | null;
  caption: string | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  media_type: string | null;
  views: number | null;
  likes: number;
  shares: number | null;
  comments_count: number;
  posted_at: string | null;
  engagement_rate: string | null;
  scraped_at: string;
  brand_name: string;
  brand_slug: string;
  source_type: string;
  author_handle: string | null;
}

export interface InstagramPostsResponse {
  data: InstagramPost[];
  page: number;
  limit: number;
  total: number;
  stats?: { total_views: number; avg_engagement: number; total_interactions: number; avg_interactions: number; last_scraped_at: string | null };
}

export async function fetchInstagramPosts(params?: {
  page?: number; limit?: number; brand?: string;
  days?: number; from?: string; to?: string; sort?: string; source_type?: string; media?: string;
}): Promise<InstagramPostsResponse> {
  const qs = new URLSearchParams();
  if (params?.page)        qs.set('page',        String(params.page));
  if (params?.limit)       qs.set('limit',       String(params.limit));
  if (params?.brand)       qs.set('brand',       params.brand);
  appendDateRange(qs, params);
  if (params?.sort)        qs.set('sort',        params.sort);
  if (params?.source_type) qs.set('source_type', params.source_type);
  if (params?.media)       qs.set('media',       params.media);
  return apiFetch(`/api/instagram/posts?${qs}`);
}

// ─── Marketing Command Center ───────────────────────────────────────────────

// Per SCOPE v3 (rescope): raw counts only. No composite scores or risk labels.

export interface BrandSummary {
  slug: string;
  name: string;
  positive: number;
  negative: number;
  neutral: number;
  classified: number;
  avg_engagement: number;
}

export interface MarketingInsight {
  severity: 'negative' | 'warning' | 'info';
  title: string;
  detail: string;
  brand: string;
  platform: string;
  when: string | null;
  href: string;
  cta: string;
}

export interface CommandCenterOverview {
  kpis: {
    ugc_mentions_recent: number;
    ugc_mentions_delta: number;
    social_mentions_recent: number;
    social_mentions_delta: number;
    x_mentions_recent: number;
    x_mentions_delta: number;
    sentiment_split: { positive: number; negative: number; neutral: number };
    avg_engagement: number;
    negative_mentions_recent: number;
    brands_with_negatives_recent: number;
    active_spikes_recent: number;
  };
  brand_summary: BrandSummary[];
  insights: MarketingInsight[];
  platform_mix: Array<{ platform: string; count: number; pct: number; positive: number; negative: number; neutral: number }>;
}

export interface SentimentTrendPoint {
  date: string;
  positive: number;
  negative: number;
  neutral: number;
}

export interface TopicMatrixRow {
  topic: string;
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

export interface CrisisBrand {
  slug: string;
  name: string;
  negative: number;
  classified: number;
  neg_share: number;
}

export interface CrisisTimelinePoint {
  date: string;
  negative: number;
  total: number;
}

export interface CrisisData {
  brands: CrisisBrand[];
  timeline: CrisisTimelinePoint[];
}

export interface UgcPost {
  post_id: string;
  caption: string | null;
  author_handle: string | null;
  hashtags: string[];
  views: number;
  likes: number;
  shares: number;
  comments_count: number;
  engagement_rate: number;
  spike_flag: boolean;
  posted_at: string | null;
  brand_name: string;
  brand_slug: string;
  post_url: string | null;
  theme: string;
  sentiment: {
    positive: number;
    negative: number;
    neutral: number;
    positive_pct: number;
    neutral_pct: number;
    negative_pct: number;
  };
}

export interface UgcThemeStat {
  theme: string;
  post_count: number;
  avg_engagement: number;
}

export interface UgcResponse {
  data: UgcPost[];
  page: number;
  limit: number;
  total: number;
  themes: UgcThemeStat[];
  // Aggregated over the FULL date-range-filtered set (not just this page) —
  // avg_engagement/sentiment used to be computed client-side from only the
  // current page's rows, which skewed with sort order and could show 0%
  // sentiment whenever page 1 happened to have no classified comments.
  stats: {
    avg_engagement: number;
    total_views: number;
    sentiment: { positive: number; negative: number; neutral: number; positive_pct: number; neutral_pct: number; negative_pct: number };
  };
  top_post: UgcPost | null;
}

export function fetchCommandCenterOverview(range: DateRange = { days: 30 }, brand?: string): Promise<CommandCenterOverview> {
  const qs = new URLSearchParams();
  appendDateRange(qs, range);
  if (brand) qs.set('brand', brand);
  return apiFetch(`/api/command-center/overview?${qs}`);
}

export function fetchSentimentTrend(params?: { days?: number; from?: string; to?: string; brand?: string }): Promise<{ data: SentimentTrendPoint[] }> {
  const qs = new URLSearchParams();
  appendDateRange(qs, params);
  if (params?.brand) qs.set('brand', params.brand);
  return apiFetch(`/api/command-center/sentiment-trend?${qs}`);
}

export function fetchTopicMatrix(params?: { days?: number; from?: string; to?: string; brand?: string }): Promise<{ data: TopicMatrixRow[] }> {
  const qs = new URLSearchParams();
  appendDateRange(qs, params);
  if (params?.brand) qs.set('brand', params.brand);
  return apiFetch(`/api/command-center/topic-matrix?${qs}`);
}

export function fetchCrisis(params?: { days?: number; from?: string; to?: string; brand?: string }): Promise<CrisisData> {
  const qs = new URLSearchParams();
  appendDateRange(qs, params);
  if (params?.brand) qs.set('brand', params.brand);
  return apiFetch(`/api/command-center/crisis?${qs}`);
}

export function fetchTopUgc(params?: { days?: number; from?: string; to?: string; brand?: string; limit?: number; sort?: string; search?: string; page?: number; spike?: boolean }): Promise<UgcResponse> {
  const qs = new URLSearchParams();
  appendDateRange(qs, params);
  if (params?.brand) qs.set('brand', params.brand);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.search) qs.set('search', params.search);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.spike) qs.set('spike', 'true');
  return apiFetch(`/api/command-center/top-ugc?${qs}`);
}

// ─── Instagram post detail ──────────────────────────────────────────────────

export interface InstagramPostDetail {
  post: InstagramPost & { mentions: string[] | null; media_type: string | null };
  sentiments: { sentiment: string; count: number }[];
  comments: { content: string; content_translated: string | null; sentiment: string | null; published_at: string | null; likes_count: number }[];
}

export function fetchInstagramPost(postId: string): Promise<InstagramPostDetail> {
  return apiFetch(`/api/instagram/posts/${postId}`);
}

export function triggerInstagramPostCommentScrape(postId: string): Promise<{ jobId: string }> {
  return apiFetch(`/api/instagram/posts/${postId}/scrape-comments`, { method: 'POST' });
}

// ── X Campaigns (docs/scope-x-campaigns.md, CONTEXT.md) ─────────────────────
// MizuMi-only campaign tracking: hashtag+ambassador membership, suggest-then-
// verify creation, frozen wrap-up report. See src/api/routes/campaigns.ts and
// src/analysis/campaign-report.ts for the exact backend shapes mirrored below.

export interface Campaign {
  id: number;
  brand_id: number;
  name: string;
  hashtags: string[];
  ambassador_handles: string[];
  starts_at: string | null;
  ends_at: string | null;
  status: 'draft' | 'active' | 'ended';
  created_at: string;
  post_count?: number;
}

export interface CampaignAssignedResult {
  anchor_posts?: number;
  [key: string]: unknown;
}

export async function fetchCampaigns(params?: { status?: string }): Promise<{ data: Campaign[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  return apiFetch(`/api/campaigns${qs.toString() ? '?' + qs : ''}`);
}

export async function fetchCampaign(id: number): Promise<{
  campaign: Campaign;
  counts: { anchor_posts: number; replies: number; quotes: number };
}> {
  return apiFetch(`/api/campaigns/${id}`);
}

export async function createCampaign(body: {
  name: string;
  hashtags: string[];
  ambassador_handles: string[];
  starts_at?: string | null;
  ends_at?: string | null;
}): Promise<{ campaign: Campaign; assigned: CampaignAssignedResult }> {
  return apiFetch('/api/campaigns', { method: 'POST', body: JSON.stringify(body) });
}

export async function deleteCampaign(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/api/campaigns/${id}`, { method: 'DELETE' });
}

export async function patchCampaign(id: number, body: Partial<{
  name: string;
  hashtags: string[];
  ambassador_handles: string[];
  starts_at: string | null;
  ends_at: string | null;
  status: 'draft' | 'active' | 'ended';
}>): Promise<{ campaign: Campaign; assigned: CampaignAssignedResult }> {
  return apiFetch(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export interface CampaignSuggestions {
  hashtags: { hashtag: string; count: number }[];
  ambassador_handles: { handle: string; count: number }[];
}

export async function fetchCampaignSuggestions(): Promise<CampaignSuggestions> {
  return apiFetch('/api/campaigns/suggestions');
}

export async function removePostFromCampaign(id: number, postId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/campaigns/${id}/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
}

export interface CampaignSentimentCounts {
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
    status: 'draft' | 'active' | 'ended';
    window_end: string | null;
  };
  reach: {
    owned: {
      anchor_posts: {
        count: number;
        views: number;
        likes: number;
        retweets: number;
        quotes_meta: number;
        replies_meta: number;
      };
      replies_count: number;
      quote_tweets_count: number;
    };
    earned: {
      ugc_count: number;
      views: number;
      likes: number;
      retweets: number;
    };
  };
  sentiment: {
    replies_and_quotes: CampaignSentimentCounts;
    hashtag_ugc: CampaignSentimentCounts;
    combined: CampaignSentimentCounts;
  };
  hashtag_volume_curve: Array<{ date: string; count: number }>;
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

export async function fetchCampaignReport(id: number): Promise<CampaignReport> {
  return apiFetch(`/api/campaigns/${id}/report`);
}

export async function triggerCampaignScrapeNow(id: number): Promise<{ jobId: string }> {
  return apiFetch(`/api/campaigns/${id}/scrape-now`, { method: 'POST' });
}

// The actual verify+lock+scrape work now runs async in the scraper-twitter
// queue worker (job_type 'track-link') — this just enqueues. Poll
// fetchScrapeJobStatus(jobId) and read `.result` as TrackLinkResult once
// status is 'done'.
export async function trackCampaignLink(id: number, url: string): Promise<{ jobId: string }> {
  return apiFetch(`/api/campaigns/${id}/track-link`, { method: 'POST', body: JSON.stringify({ url }) });
}

export interface TrackLinkResult {
  post_id: string;
  author_handle: string;
  caption: string;
}

export interface CampaignXSearchCandidate {
  id: string;
  url: string;
  author: string;
  authorName: string | null;
  content: string;
  likes: number;
  retweets: number;
  views: number | null;
  createdAt: string | null;
  /** Plain reshare, no added commentary — same content as the original tweet under its own post_id. */
  isRetweet: boolean;
}

export interface SearchXResult {
  candidates: CampaignXSearchCandidate[];
}

// Live X search now runs async in the scraper-twitter queue worker (job_type
// 'search-x') — this just enqueues. Poll fetchScrapeJobStatus(jobId) and read
// `.result` as SearchXResult once status is 'done'.
export async function searchCampaignX(id: number): Promise<{ jobId: string }> {
  return apiFetch(`/api/campaigns/${id}/search-x`, { method: 'POST' });
}
