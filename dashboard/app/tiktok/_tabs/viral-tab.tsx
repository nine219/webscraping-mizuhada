'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchTikTokPosts, fetchBrands, TikTokPost, DateRange } from '@/lib/api';
import ViralPostCard from '@/components/viral-post-card';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { SearchInput } from '@/components/search-input';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';

const PAGE_LIMIT = 12; // multiple of the 3-col grid

const EXPORT_COLUMNS: CsvColumn<TikTokPost>[] = [
  { header: 'source_type', value: (p) => p.source_type ?? '' },
  { header: 'brand', value: (p) => p.brand_name },
  { header: 'author_handle', value: (p) => p.author_handle ?? '' },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views ?? 0 },
  { header: 'likes', value: (p) => p.likes ?? 0 },
  { header: 'shares', value: (p) => p.shares ?? 0 },
  { header: 'comments', value: (p) => p.comments_count ?? 0 },
  { header: 'engagement_pct', value: (p) => p.engagement_rate ?? '' },
  { header: 'shop_content', value: (p) => (p.is_shop_content ? 'yes' : 'no') },
  { header: 'spike_detected_at', value: (p) => p.spike_detected_at ?? '' },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'post_url', value: (p) => p.post_url ?? '' },
];

const RANGE_PRESETS = [
  { key: 'd7',   label: '7D',   days: 7 },
  { key: 'd30',  label: '30D',  days: 30 },
  { key: 'all',  label: 'All time', days: 0 },
];

const SORT_OPTIONS = [
  { value: 'spike',      label: 'Recently Spiked' },
  { value: 'views',      label: 'Most Viewed' },
  { value: 'likes',      label: 'Most Liked' },
  { value: 'engagement', label: 'Highest Engagement' },
];

const SOURCE_OPTIONS = [
  { value: '',       label: 'All Sources' },
  { value: 'feed',   label: 'Feed' },
  { value: 'search', label: 'UGC Search' },
];

// Robust to whichever literal string the DB actually holds for own-account
// posts ('profile' per CLAUDE.md vs 'feed' per some call sites elsewhere in
// this app — see viral-tab investigation notes) by treating "search" as the
// only real UGC signal and everything else as feed-sourced.
function matchesSource(p: TikTokPost, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'search') return p.source_type === 'search';
  return p.source_type !== 'search';
}

// @handle prefix scopes the match to the author only (mirrors search-tab.tsx's
// convention); plain text matches the caption. Case-insensitive substring.
function matchesSearch(p: TikTokPost, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  if (query.startsWith('@')) return (p.author_handle ?? '').toLowerCase().includes(query.slice(1));
  return (p.caption ?? '').toLowerCase().includes(query);
}

function spikeTimestamp(p: TikTokPost): number {
  const t = p.spike_detected_at ?? p.posted_at;
  return t ? new Date(t).getTime() : 0;
}

export default function TikTokViralTab() {
  const [posts, setPosts] = useState<TikTokPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const [brandFilter, setBrandFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [hideShop, setHideShop] = useState(false);
  const [range, setRange] = useState<DateRange>({ days: 30 });
  const [sort, setSort] = useState('spike');
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);

  useEffect(() => {
    fetchBrands()
      .then((brands) => setBrandOptions(brands.filter((b) => b.type === 'own').map((b) => ({ slug: b.slug, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    // spike=true on /api/tiktok/posts already covers BOTH own-account feed
    // posts and UGC search hits — they live in the same tiktok_posts table
    // and spike-detection.ts runs on both source_types (own-brand only, see
    // its `type !== 'own'` early-return). Omitting source_type here is
    // deliberate: it's what unifies feed + UGC search into one dataset
    // without a second fetch/merge, and each row still carries its own
    // source_type for the per-card Feed/UGC Search label + the pill filter
    // below.
    fetchTikTokPosts({ brand: brandFilter || undefined, spike: true, ...range, limit: 100_000, sort: 'date' })
      .then((res) => setPosts(res.data))
      .catch(() => setPosts([]))
      .finally(() => setLoading(false));
  }, [brandFilter, range]);

  function handleBrandChange(v: string) { setBrandFilter(v); setPage(1); }
  function handleSourceChange(v: string) { setSourceFilter(v); setPage(1); }
  function handleRangeChange(v: DateRange) { setRange(v); setPage(1); }
  function handleSortChange(v: string) { setSort(v); setPage(1); }
  function handleShopToggle() { setHideShop((prev) => !prev); setPage(1); }
  function handleSearchChange(v: string) { setSearchQ(v); setPage(1); }

  const filtered = useMemo(
    () => posts.filter((p) => matchesSource(p, sourceFilter) && (!hideShop || !p.is_shop_content) && matchesSearch(p, searchQ)),
    [posts, sourceFilter, hideShop, searchQ],
  );

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sort === 'views') return (b.views ?? 0) - (a.views ?? 0);
      if (sort === 'likes') return (b.likes ?? 0) - (a.likes ?? 0);
      if (sort === 'engagement') return (parseFloat(b.engagement_rate ?? '0') || 0) - (parseFloat(a.engagement_rate ?? '0') || 0);
      return spikeTimestamp(b) - spikeTimestamp(a);
    });
    return arr;
  }, [filtered, sort]);

  // Hero stats reflect the currently-filtered set (source/shop/brand/range),
  // same convention as every other tab's stat row.
  const totalViews = sorted.reduce((s, p) => s + (p.views ?? 0), 0);
  const feedCount = sorted.filter((p) => matchesSource(p, 'feed')).length;
  const searchCount = sorted.filter((p) => matchesSource(p, 'search')).length;
  const latestSpikeAt = sorted.length
    ? sorted.reduce((max, p) => Math.max(max, spikeTimestamp(p)), 0)
    : 0;

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_LIMIT));
  const pagePosts = sorted.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  return (
    <div>
      {/* Hero — leads with the one fact marketing actually wants: how much
         is spiking right now, and where it's coming from. The headline
         count is the page's one deliberate use of the cyan/magenta duotone
         (see .viral-count-gradient) — everything else stays in the app's
         normal stat-tile vocabulary. */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="card p-5">
          <div className="stat-label mb-2">Viral Posts</div>
          <div className="stat-value viral-count-gradient">{sorted.length.toLocaleString()}</div>
          <div className="text-xs mt-1 text-muted">spike_flag = true, current filters</div>
        </div>
        <div className="card p-5">
          <div className="stat-label mb-2">Total Views</div>
          <div className="stat-value">{totalViews.toLocaleString()}</div>
          <div className="text-xs mt-1 text-muted">across viral posts shown</div>
        </div>
        <div className="card p-5">
          <div className="stat-label mb-2">Feed vs UGC Search</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{feedCount} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>·</span> {searchCount}</div>
          <div className="flex rounded-full overflow-hidden mt-2" style={{ height: 5 }}>
            <div style={{ width: `${feedCount + searchCount > 0 ? (feedCount / (feedCount + searchCount)) * 100 : 50}%`, background: 'var(--accent-success)' }} />
            <div style={{ width: `${feedCount + searchCount > 0 ? (searchCount / (feedCount + searchCount)) * 100 : 50}%`, background: 'var(--accent-info)' }} />
          </div>
        </div>
        <div className="card p-5">
          <div className="stat-label mb-2">Most Recent Spike</div>
          <div className="stat-value" style={{ fontSize: 20, color: 'var(--accent-danger)' }}>
            {latestSpikeAt > 0 ? timeAgo(new Date(latestSpikeAt).toISOString()) : '—'}
          </div>
          <div className="text-xs mt-1 text-muted">newest flagged post</div>
        </div>
      </div>

      {/* Search + brand pills + export — search always leads, export pushed right. */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <SearchInput value={searchQ} onChange={handleSearchChange} placeholder="Search caption or @username…" />
        <FilterPills
          className="flex items-center gap-1.5 flex-wrap"
          options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
          value={brandFilter}
          onChange={handleBrandChange}
        />
        <div className="ml-auto">
          <ExportCsvButton
            fetchAll={() => Promise.resolve(sorted)}
            columns={EXPORT_COLUMNS}
            filename={() => `tiktok-viral-${brandFilter || 'all'}.csv`}
          />
        </div>
      </div>

      {/* Controls: source + shop toggle + date range + sort */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <FilterPills options={SOURCE_OPTIONS} value={sourceFilter} onChange={handleSourceChange} />
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-secondary">
          <span className="toggle">
            <input type="checkbox" checked={hideShop} onChange={handleShopToggle} />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </span>
          Hide Shop content
        </label>
        <DateRangePicker value={range} onChange={handleRangeChange} presets={RANGE_PRESETS} />
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={handleSortChange} />
        </div>
      </div>

      {/* Card grid */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
        </div>
      ) : sorted.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">🔥</div>
          <p className="font-medium mb-1 text-primary">{searchQ.trim() ? 'No posts match your search' : 'Nothing spiking right now'}</p>
          <p className="text-sm text-muted">{searchQ.trim() ? 'Try a different caption or @username.' : 'Try widening the date range, or check back after the next scrape.'}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-5">
            {pagePosts.map((p) => <ViralPostCard key={p.id} post={p} />)}
          </div>

          <div className="flex items-center justify-between mt-5">
            <span className="text-sm text-muted">{sorted.length.toLocaleString()} viral posts · Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
