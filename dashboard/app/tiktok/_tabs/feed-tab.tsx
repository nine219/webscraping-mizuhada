'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchTikTokPosts, fetchBrands, TikTokPost, DateRange } from '@/lib/api';
import { ShopBadge } from '@/components/shop-badge';
import { SpikeBadge } from '@/components/badges';
import { WatchlistIcon } from '@/components/watchlist-icon';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { SearchInput } from '@/components/search-input';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo, formatEngagement } from '@/lib/format';

const PAGE_LIMIT = 25;

const EXPORT_COLUMNS: CsvColumn<TikTokPost>[] = [
  { header: 'brand', value: (p) => p.brand_name },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views ?? 0 },
  { header: 'likes', value: (p) => p.likes ?? 0 },
  { header: 'shares', value: (p) => p.shares ?? 0 },
  { header: 'comments', value: (p) => p.comments_count ?? 0 },
  { header: 'engagement_pct', value: (p) => p.engagement_rate ?? '' },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'sentiment_positive', value: (p) => p.sentiment_positive },
  { header: 'sentiment_negative', value: (p) => p.sentiment_negative },
  { header: 'sentiment_neutral', value: (p) => p.sentiment_neutral },
  { header: 'sentiment_question', value: (p) => p.sentiment_question },
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

const SENTIMENT_CONFIG: Record<string, { label: string; color: string }> = {
  positive: { label: 'Positive', color: '#10b981' },
  negative: { label: 'Negative', color: '#ef4444' },
  neutral:  { label: 'Neutral',  color: '#94a3b8' },
  question: { label: 'Question', color: '#8b5cf6' },
};

export default function TikTokFeedTab() {
  const router = useRouter();
  const [posts, setPosts] = useState<TikTokPost[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [brandFilter, setBrandFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [spikesOnly, setSpikesOnly] = useState(false);
  const [watchlistOnly, setWatchlistOnly] = useState(false);
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [sort, setSort] = useState('date');
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);
  const [stats, setStats] = useState<{ total_views: number; avg_engagement: number; spike_count: number; last_scraped_at: string | null }>({ total_views: 0, avg_engagement: 0, spike_count: 0, last_scraped_at: null });
  // Distinguishes "no data in range" from "the fetch failed" — previously
  // both rendered the identical empty-state text, so an API outage looked
  // indistinguishable from a genuinely quiet brand/date range.
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    fetchBrands()
      // Feed Monitor is own-brand posts only — competitor mockups (Her Hyness)
      // only ever surface on the separate Competitors tab.
      .then((brands) => setBrandOptions(brands.filter((b) => b.type === 'own').map((b) => ({ slug: b.slug, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setFetchFailed(false);
    // Feed Monitor shows official (own-brand) posts only — UGC mentions live
    // on the separate UGC Search tab, so no source_type toggle here.
    // Fetches the FULL filtered set (no page param) so column-header sort
    // (useClientSort below) sorts every matching row, not just one page's
    // worth — pagination is a client-side slice of the sorted array.
    fetchTikTokPosts({ brand: brandFilter || undefined, spike: spikesOnly || undefined, watchlist: watchlistOnly || undefined, ...range, limit: 100_000, sort, source_type: 'feed' })
      .then((res) => {
        setPosts(res.data);
        setTotal(res.total);
        setStats(res.stats ?? { total_views: 0, avg_engagement: 0, spike_count: 0, last_scraped_at: null });
      })
      .catch(() => { setPosts([]); setFetchFailed(true); })
      .finally(() => setLoading(false));
  }, [brandFilter, spikesOnly, watchlistOnly, range, sort]);

  function handleBrandChange(v: string) { setBrandFilter(v); setPage(1); }
  function handleSpikesToggle() { setSpikesOnly((prev) => !prev); setPage(1); }
  function handleWatchlistToggle() { setWatchlistOnly((prev) => !prev); setPage(1); }
  function handleRangeChange(v: DateRange) { setRange(v); setPage(1); }
  function handleSortChange(v: string) { setSort(v); setPage(1); }

  // Client-side substring filter over the already-fetched full set — search
  // is client-side here, not a new backend param, per the established
  // fetch-all/client-sort convention (commit 986bb61). Caption is the only
  // meaningful free-text field: every row is this brand's own account, so
  // there's no distinct per-row author worth searching (brand pills already
  // cover that axis).
  const filteredPosts = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => (p.caption ?? '').toLowerCase().includes(q));
  }, [posts, searchQ]);

  // Client-side sort of the FULL filtered set (posts holds every matching row,
  // not just one page) — independent of the server-side "Sort:" pills above,
  // which only control initial order before any column header is clicked.
  const { sorted: sortedPosts, sortKey, sortDir, requestSort } = useClientSort<TikTokPost>(filteredPosts, {
    brand: (p) => p.brand_name,
    caption: (p) => p.caption ?? '',
    views: (p) => p.views ?? 0,
    likes: (p) => p.likes ?? 0,
    shares: (p) => p.shares ?? 0,
    comments: (p) => p.comments_count ?? 0,
    engagement: (p) => (p.engagement_rate ? parseFloat(p.engagement_rate) : 0),
    posted: (p) => p.posted_at ?? '',
    sentiment: (p) => p.sentiment_positive - p.sentiment_negative,
    spike: (p) => (p.spike_flag ? 1 : 0),
  });

  const totalPages = Math.max(1, Math.ceil(sortedPosts.length / PAGE_LIMIT));
  const pagePosts = sortedPosts.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  return (
    <div>
      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Posts', value: total.toLocaleString(), color: 'var(--accent-primary)', sub: `updated ${timeAgo(stats.last_scraped_at)}` },
          { label: 'Total Views', value: stats.total_views.toLocaleString(), color: 'var(--text-primary)' },
          { label: 'Avg Engagement', value: `${stats.avg_engagement.toFixed(2)}%`, color: stats.avg_engagement > 3 ? 'var(--accent-success)' : stats.avg_engagement >= 1 ? 'var(--accent-warning)' : 'var(--text-muted)' },
          { label: 'Spikes', value: stats.spike_count.toLocaleString(), color: 'var(--accent-danger)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            {s.sub && <div className="text-xs mt-1 text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Search + brand pills + export — search always leads (consistent
          with every other list page), export pushed right regardless of
          how much/little else is in the row. */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <SearchInput value={searchQ} onChange={(v) => { setSearchQ(v); setPage(1); }} placeholder="Search caption…" />
        <FilterPills
          className="flex items-center gap-1.5 flex-wrap"
          options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
          value={brandFilter}
          onChange={handleBrandChange}
        />
        <div className="ml-auto">
          <ExportCsvButton
            fetchAll={() => Promise.resolve(sortedPosts)}
            columns={EXPORT_COLUMNS}
            filename={() => `tiktok-feed-${brandFilter || 'all'}.csv`}
          />
        </div>
      </div>

      {/* Controls row: spikes toggle + days + sort */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-secondary">
          <span className="toggle">
            <input type="checkbox" checked={spikesOnly} onChange={handleSpikesToggle} />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </span>
          Spikes only
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-secondary">
          <span className="toggle">
            <input type="checkbox" checked={watchlistOnly} onChange={handleWatchlistToggle} />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </span>
          <WatchlistIcon active={watchlistOnly} />
          Watchlist
        </label>

        <DateRangePicker value={range} onChange={handleRangeChange} />

        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={handleSortChange} />
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : sortedPosts.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">{fetchFailed ? '⚠️' : '🎵'}</div>
            <p className="font-medium mb-1 text-primary">
              {fetchFailed ? 'Could not load posts — the API may be unreachable' : searchQ.trim() ? 'No posts match your search' : 'No posts yet'}
            </p>
            {/* <p className="text-sm font-mono text-muted">Run: npm run scrape:tiktok</p> */}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Brand" sortKey="brand" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Caption" sortKey="caption" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Shares" sortKey="shares" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Engagement %" sortKey="engagement" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Sentiment" sortKey="sentiment" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Spike" sortKey="spike" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.map((p) => {
                  const eng = formatEngagement(p.engagement_rate);
                  return (
                    <tr
                      key={p.id}
                      className="cursor-pointer"
                      style={{ transition: 'background 0.15s' }}
                      onClick={() => router.push(`/tiktok/${p.post_id}`)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td className="brand-cell">{p.brand_name}</td>
                      <td style={{ maxWidth: 280 }}>
                        <span title={p.caption ?? ''} className="text-secondary">
                          {p.caption ? p.caption.slice(0, 55) + (p.caption.length > 55 ? '…' : '') : '—'}
                        </span>
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.views ?? 0).toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.likes ?? 0).toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{(p.shares ?? 0).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="font-mono text-xs font-semibold hover:underline"
                          style={{ color: p.comments_count > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                          onClick={(e) => { e.stopPropagation(); router.push(`/tiktok/${p.post_id}#comments`); }}
                        >
                          {(p.comments_count ?? 0).toLocaleString()}
                        </button>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="font-mono text-xs font-semibold" style={{ color: eng.color }}>{eng.text}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        {(() => {
                          const total = p.sentiment_positive + p.sentiment_negative + p.sentiment_neutral + p.sentiment_question;
                          if (total === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>;
                          const dominant = p.sentiment_positive >= p.sentiment_negative && p.sentiment_positive >= p.sentiment_neutral && p.sentiment_positive >= p.sentiment_question ? 'positive'
                            : p.sentiment_negative >= p.sentiment_neutral && p.sentiment_negative >= p.sentiment_question ? 'negative'
                            : p.sentiment_neutral >= p.sentiment_question ? 'neutral'
                            : 'question';
                          const cfg = SENTIMENT_CONFIG[dominant];
                          return (
                            <div className="flex items-center gap-1.5" title={`${p.sentiment_positive} positive · ${p.sentiment_neutral} neutral · ${p.sentiment_negative} negative · ${p.sentiment_question} question`}>
                              <div className="rounded flex-shrink-0" style={{ width: 24, height: 8, background: cfg.color, opacity: 0.85 }} />
                              <span className="text-[10px] font-medium" style={{ color: cfg.color }}>{cfg.label}</span>
                            </div>
                          );
                        })()}
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

        {!loading && sortedPosts.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t-light">
            <span className="text-sm text-muted">Page {page} of {totalPages}</span>
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
