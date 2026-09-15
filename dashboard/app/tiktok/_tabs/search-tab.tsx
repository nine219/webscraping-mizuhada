'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  fetchTikTokSearchMentions, fetchTikTokSearchStats, fetchBrands,
  TikTokSearchPost, TikTokSearchStats, DateRange,
} from '@/lib/api';
import DailyMentionsViewsChart from '@/components/charts/daily-mentions-views-chart';
import { ShopBadge } from '@/components/shop-badge';
import { SpikeBadge } from '@/components/badges';
import { WatchlistIcon } from '@/components/watchlist-icon';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { SearchInput } from '@/components/search-input';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo, formatEngagement } from '@/lib/format';

const PAGE_LIMIT = 25;

const EXPORT_COLUMNS: CsvColumn<TikTokSearchPost>[] = [
  { header: 'author_handle', value: (p) => p.author_handle ?? '' },
  { header: 'brand', value: (p) => p.brand_name },
  { header: 'keywords', value: (p) => (p.search_keywords ?? []).join('; ') },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views ?? 0 },
  { header: 'likes', value: (p) => p.likes ?? 0 },
  { header: 'shares', value: (p) => p.shares ?? 0 },
  { header: 'comments', value: (p) => p.comments_count ?? 0 },
  { header: 'engagement_pct', value: (p) => p.engagement_rate ?? '' },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'spike', value: (p) => (p.spike_flag ? 'yes' : 'no') },
  { header: 'watchlist', value: (p) => (p.watchlist ? 'yes' : 'no') },
  { header: 'post_url', value: (p) => p.post_url ?? '' },
];

const SORT_OPTIONS = [
  { value: 'date',     label: 'Newest' },
  { value: 'views',    label: 'Most Viewed' },
  { value: 'likes',    label: 'Most Liked' },
  { value: 'shares',   label: 'Most Shared' },
  { value: 'comments', label: 'Most Comments' },
];

export default function TikTokSearchTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [posts, setPosts] = useState<TikTokSearchPost[]>([]);
  const [total, setTotal] = useState(0);
  const [totalViews, setTotalViews] = useState(0);
  const [avgEngagement, setAvgEngagement] = useState(0);
  const [lastScrapedAt, setLastScrapedAt] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Distinguishes "no data" from "the fetch failed" in the empty state below.
  const [fetchFailed, setFetchFailed] = useState(false);

  const [brandFilter, setBrandFilter] = useState('');
  const [spikesOnly, setSpikesOnly] = useState(false);
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [keywordFilter, setKeywordFilter] = useState('');
  // TikTok Hashtags tab links here (?tab=search&q=X) to drill into the actual
  // posts behind a hashtag count, in-app instead of an external
  // tiktok.com/tag/ link with no brand scoping. hashtags-tab's data comes
  // from tp.hashtags (parsed from captions), not search_keyword, so this
  // feeds the free-text caption search (ILIKE substring), not keywordFilter
  // (exact search_keyword match) — the latter would silently return nothing
  // for most hashtags. Read once on mount as the initial value...
  const [searchQ, setSearchQ] = useState(() => searchParams.get('q') ?? '');
  const [debouncedQ, setDebouncedQ] = useState(searchQ);
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [sort, setSort] = useState('date');
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);
  const [stats, setStats] = useState<TikTokSearchStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    fetchBrands()
      .then((brands) => setBrandOptions(brands.filter((b) => b.type === 'own').map((b) => ({ slug: b.slug, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(searchQ); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchQ]);

  // ...but this tab stays mounted (display:none) once opened once — the tab
  // host never remounts it — so the mount-time initializer above alone
  // wouldn't catch a SECOND hashtag click after the tab's already open.
  // This keeps searchQ in sync with the URL on every navigation.
  useEffect(() => {
    const q = searchParams.get('q');
    if (q && q !== searchQ) { setSearchQ(q); setPage(1); }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const authorFilter  = debouncedQ.startsWith('@') ? debouncedQ.slice(1) : undefined;
  const captionFilter = debouncedQ && !debouncedQ.startsWith('@') ? debouncedQ : undefined;
  const isSearching = !!(debouncedQ || keywordFilter);

  useEffect(() => {
    setLoading(true);
    setFetchFailed(false);
    // Always fetch the FULL filtered set (no page param) and paginate
    // client-side from sortedPosts, same fetch-all/client-sort convention as
    // every sibling list tab (feed-tab.tsx etc, commit 986bb61). Previously
    // this forked into server-side pagination when not actively searching,
    // which rendered the raw unsorted `posts` for that state — column-header
    // sort silently did nothing outside of an active search.
    const params: Record<string, unknown> = {
      brand: brandFilter || undefined,
      spike: spikesOnly || undefined,
      watchlist: watchlistOnly || undefined,
      ...range,
      sort,
      limit: 100_000,
      keyword: keywordFilter || undefined,
      author: authorFilter,
      caption: captionFilter,
    };
    fetchTikTokSearchMentions(params as any)
      .then((res) => {
        setPosts(res.data);
        setTotal(res.total);
        setTotalViews(res.stats?.total_views ?? 0);
        setAvgEngagement(res.stats?.avg_engagement ?? 0);
        setLastScrapedAt(res.stats?.last_scraped_at ?? null);
      })
      .catch(() => { setPosts([]); setFetchFailed(true); })
      .finally(() => setLoading(false));
  }, [brandFilter, spikesOnly, watchlistOnly, range, sort, keywordFilter, debouncedQ]);

  useEffect(() => {
    setStatsLoading(true);
    fetchTikTokSearchStats({ brand: brandFilter || undefined, ...range })
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false));
  }, [brandFilter, range]);

  function handleBrandChange(v: string) { setBrandFilter(v); setPage(1); }
  function handleSpikesToggle() { setSpikesOnly((prev) => !prev); setPage(1); }
  function handleWatchlistToggle() { setWatchlistOnly((prev) => !prev); setPage(1); }
  function handleRangeChange(v: DateRange) { setRange(v); setPage(1); }
  function handleSortChange(v: string)  { setSort(v); setPage(1); }
  function handleKeywordClick(kw: string) { setKeywordFilter((prev) => (prev === kw ? '' : kw)); setPage(1); }

  // Client-side sort of the FULL filtered set — independent of the server-side
  // "Sort:" pills above, which only control initial order before any column
  // header is clicked.
  const { sorted: sortedPosts, sortKey, sortDir, requestSort } = useClientSort<TikTokSearchPost>(posts, {
    author: (p) => p.author_handle ?? '',
    brand: (p) => p.brand_name,
    caption: (p) => p.caption ?? '',
    views: (p) => p.views ?? 0,
    likes: (p) => p.likes ?? 0,
    shares: (p) => p.shares ?? 0,
    comments: (p) => p.comments_count ?? 0,
    engagement: (p) => (p.engagement_rate ? parseFloat(p.engagement_rate) : 0),
    posted: (p) => p.posted_at ?? '',
    spike: (p) => (p.spike_flag ? 1 : 0),
  });

  const totalPages = Math.max(1, Math.ceil(sortedPosts.length / PAGE_LIMIT));
  const pagePosts = sortedPosts.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  return (
    <div>
      {/* Tab-local toolbar (page-header moved to host) */}
      <div className="flex items-center justify-end gap-3 mb-4">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(sortedPosts)}
          columns={EXPORT_COLUMNS}
          filename={() => `tiktok-search-${brandFilter || 'all'}.csv`}
        />
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Mentions Found', value: total.toLocaleString(), color: 'var(--accent-primary)', sub: `updated ${timeAgo(lastScrapedAt)}` },
          { label: 'Total Views', value: totalViews.toLocaleString(), color: 'var(--text-primary)' },
          { label: 'Avg Engagement', value: `${avgEngagement.toFixed(2)}%`, color: avgEngagement > 3 ? 'var(--accent-success)' : avgEngagement >= 1 ? 'var(--accent-warning)' : 'var(--text-muted)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            {s.sub && <div className="text-xs mt-1 text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Analytics: sentiment + keyword breakdown + top authors + trend */}
      {stats && !statsLoading && (
        <div className="grid grid-cols-3 gap-4 mb-6">

          {/* Sentiment */}
          <div className="card p-5">
            <div className="stat-label mb-3">Comment Sentiment</div>
            {stats.sentiment.total === 0 ? (
              <p className="text-xs text-muted">No comments with sentiment yet — run sentiment analysis</p>
            ) : (() => {
              const { positive, negative, neutral, question, total } = stats.sentiment;
              const pct = (n: number) => Math.round((n / total) * 100);
              return (
                <div>
                  <div className="flex rounded overflow-hidden mb-2" style={{ height: 10 }}>
                    <div style={{ width: `${pct(positive)}%`, background: 'var(--accent-success)' }} />
                    <div style={{ width: `${pct(neutral)}%`,  background: 'var(--border-light)' }} />
                    <div style={{ width: `${pct(negative)}%`, background: 'var(--accent-danger, #e53e3e)' }} />
                    <div style={{ width: `${pct(question)}%`, background: '#8b5cf6' }} />
                  </div>
                  <div className="flex gap-3 text-xs flex-wrap">
                    {[
                      { label: 'Positive', n: positive, color: 'var(--accent-success)' },
                      { label: 'Neutral',  n: neutral,  color: 'var(--text-muted)' },
                      { label: 'Negative', n: negative, color: 'var(--accent-danger, #e53e3e)' },
                      { label: 'Question', n: question, color: '#8b5cf6' },
                    ].filter((s) => s.n > 0).map((s) => (
                      <span key={s.label} className="flex items-center gap-1">
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: s.color }} />
                        <span className="text-muted">{s.label}</span>
                        <span className="font-semibold text-primary">{pct(s.n)}%</span>
                        <span className="text-muted">({s.n})</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Keyword breakdown — click a keyword to filter the post list below */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="stat-label">Posts by Keyword</div>
              {keywordFilter && (
                <button
                  className="text-xs font-medium"
                  style={{ color: 'var(--accent-primary)' }}
                  onClick={() => { setKeywordFilter(''); setPage(1); }}
                >
                  Clear ✕
                </button>
              )}
            </div>
            {stats.keyword_breakdown.length === 0 ? (
              <p className="text-xs text-muted">No data</p>
            ) : (
              <div className="flex flex-col gap-1.5" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {stats.keyword_breakdown.map((k) => {
                  const maxCount = stats.keyword_breakdown[0].post_count;
                  const pct = Math.round((k.post_count / maxCount) * 100);
                  const active = keywordFilter === k.keyword;
                  return (
                    <button
                      key={k.keyword}
                      onClick={() => handleKeywordClick(k.keyword)}
                      className="text-left"
                      style={{
                        background: active ? 'var(--bg-base)' : 'transparent',
                        border: active ? '1px solid var(--accent-primary)' : '1px solid transparent',
                        borderRadius: 6,
                        padding: '3px 6px',
                        cursor: 'pointer',
                      }}
                    >
                      <div className="flex justify-between text-xs mb-0.5">
                        <span className="font-mono" style={{ color: active ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>{k.keyword}</span>
                        <span className="text-muted">{k.post_count} posts · {k.total_views.toLocaleString()} views</span>
                      </div>
                      <div className="rounded overflow-hidden" style={{ height: 4, background: 'var(--bg-base)' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent-primary)', borderRadius: 2 }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top authors */}
          <div className="card p-5">
            <div className="stat-label mb-3">Top Creators Mentioning Brand</div>
            {stats.top_authors.length === 0 ? (
              <p className="text-xs text-muted">No data</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {stats.top_authors.slice(0, 6).map((a, i) => (
                  <div key={a.handle} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono" style={{ color: 'var(--text-muted)', width: 14 }}>{i + 1}</span>
                      <a
                        href={`https://www.tiktok.com/@${a.handle}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-xs font-mono font-medium"
                        style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        @{a.handle}
                      </a>
                    </div>
                    <div className="text-xs text-muted">
                      {a.mention_count}× · {(a.total_views / 1000).toFixed(0)}K views
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Engagement trend */}
          {stats && stats.daily_trend.length > 1 && (
            <div className="card p-5" style={{ gridColumn: 'span 3' }}>
              <div className="stat-label mb-3">Daily Mentions &amp; Views</div>
              <div style={{ height: 220 }}>
                <DailyMentionsViewsChart data={stats.daily_trend} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Brand pills */}
      <FilterPills
        className="flex items-center gap-1.5 flex-wrap mb-3"
        options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
        value={brandFilter}
        onChange={handleBrandChange}
      />

      {/* Spike Detection filter */}
      <div
        className="card p-4 mb-4"
        style={{
          border: spikesOnly ? '1px solid var(--accent-warning)' : '1px solid var(--border-light)',
          transition: 'border-color 0.15s',
        }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ lineHeight: 1 }}>⚡</span>
            <div>
              <span className="font-semibold text-sm text-primary">Spike Detection</span>
              {!loading && isSearching && (
                <span className="ml-2 text-xs text-muted">
                  {posts.filter(p => p.spike_flag).length} of {posts.length} posts spiking
                </span>
              )}
              {!loading && !isSearching && total > 0 && (
                <span className="ml-2 text-xs text-muted">{total.toLocaleString()} total mentions</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <DateRangePicker value={range} onChange={handleRangeChange} />
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
              <span className="toggle">
                <input type="checkbox" checked={spikesOnly} onChange={handleSpikesToggle} />
                <span className="toggle-track"></span>
                <span className="toggle-thumb"></span>
              </span>
              <span
                className="font-medium"
                style={{ color: spikesOnly ? 'var(--accent-warning)' : 'var(--text-muted)' }}
              >
                {spikesOnly ? 'Showing spikes only' : 'Filter spikes'}
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
              <span className="toggle">
                <input type="checkbox" checked={watchlistOnly} onChange={handleWatchlistToggle} />
                <span className="toggle-track"></span>
                <span className="toggle-thumb"></span>
              </span>
              <WatchlistIcon active={watchlistOnly} />
              <span
                className="font-medium"
                style={{ color: watchlistOnly ? '#f59e0b' : 'var(--text-muted)' }}
              >
                Watchlist
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Search + Sort on same row */}
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <SearchInput value={searchQ} onChange={setSearchQ} placeholder="Search caption or @username…" />
        <div className="flex items-center gap-1">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={handleSortChange} />
        </div>
      </div>

      {/* Active filter banners */}
      {(keywordFilter || debouncedQ) && (
        <div className="flex items-center gap-3 mb-3 text-xs flex-wrap text-secondary">
          {keywordFilter && (
            <span className="flex items-center gap-1.5">
              <span>Keyword:</span>
              <span className="font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-base)', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)' }}>
                {keywordFilter}
              </span>
              <button className="font-medium" style={{ color: 'var(--accent-primary)' }} onClick={() => { setKeywordFilter(''); setPage(1); }}>✕</button>
            </span>
          )}
          {authorFilter && (
            <span className="flex items-center gap-1.5">
              <span>Author:</span>
              <span className="font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-base)', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)' }}>
                @{authorFilter}
              </span>
              <button className="font-medium" style={{ color: 'var(--accent-primary)' }} onClick={() => { setSearchQ(''); setDebouncedQ(''); setPage(1); }}>✕</button>
            </span>
          )}
          {captionFilter && (
            <span className="flex items-center gap-1.5">
              <span>Caption:</span>
              <span className="font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-base)', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)' }}>
                &ldquo;{captionFilter}&rdquo;
              </span>
              <button className="font-medium" style={{ color: 'var(--accent-primary)' }} onClick={() => { setSearchQ(''); setDebouncedQ(''); setPage(1); }}>✕</button>
            </span>
          )}
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">{fetchFailed ? '⚠️' : '🔍'}</div>
            <p className="font-medium mb-1 text-primary">{fetchFailed ? 'Could not load mentions — the API may be unreachable' : 'No mentions found'}</p>
            {!fetchFailed && <p className="text-sm font-mono text-muted">Run a search from Settings → Account Management</p>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Brand Searched</th>
                  <th>Keyword</th>
                  <SortableTh label="Caption" sortKey="caption" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Shares" sortKey="shares" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Eng %" sortKey="engagement" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Spike" sortKey="spike" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.map((p) => {
                  const eng = formatEngagement(p.engagement_rate);
                  return (
                    <tr
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/tiktok/${p.post_id}`)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td>
                        {p.author_handle ? (
                          <span className="font-mono text-xs text-secondary">
                            @{p.author_handle}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Unknown</span>
                        )}
                      </td>
                      <td>
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                          {p.brand_name}
                        </span>
                      </td>
                      <td>
                        {p.search_keywords && p.search_keywords.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {p.search_keywords.map((kw) => (
                              <button
                                key={kw}
                                className="font-mono text-xs"
                                style={{ color: 'var(--accent-primary)' }}
                                onClick={(e) => { e.stopPropagation(); handleKeywordClick(kw); }}
                              >
                                {kw}
                              </button>
                            ))}
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        <span title={p.caption ?? ''} style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                          {p.caption ? p.caption.slice(0, 50) + (p.caption.length > 50 ? '…' : '') : '—'}
                        </span>
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.views ?? 0).toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.likes ?? 0).toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.shares ?? 0).toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.comments_count ?? 0).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="font-mono text-xs font-semibold" style={{ color: eng.color }}>{eng.text}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        <div className="badge-row">
                          <SpikeBadge active={p.spike_flag} />
                          <ShopBadge isShopContent={p.is_shop_content} shopSignal={p.shop_signal} />
                          {p.watchlist && (
                            <span title="Watchlist">
                              <WatchlistIcon active strokeWidth={1.5} />
                            </span>
                          )}
                          {!p.spike_flag && !p.watchlist && !p.is_shop_content && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                        </div>
                      </td>
                      <td>
                        {p.post_url ? (
                          <a href={p.post_url} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                            onClick={(e) => e.stopPropagation()}>
                            View ↗
                          </a>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && posts.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t-light">
            <span className="text-sm text-muted">
              {total.toLocaleString()} mentions · Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
