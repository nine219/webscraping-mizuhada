'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { fetchInstagramPosts, fetchBrands, InstagramPost, DateRange } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { SearchInput } from '@/components/search-input';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo, formatEngagement } from '@/lib/format';

const PAGE_LIMIT = 25;

const EXPORT_COLUMNS: CsvColumn<InstagramPost>[] = [
  { header: 'brand', value: (p) => p.brand_name },
  { header: 'author_handle', value: (p) => p.author_handle ?? '' },
  { header: 'media_type', value: (p) => p.media_type ?? '' },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views ?? '' },
  { header: 'likes', value: (p) => p.likes ?? 0 },
  { header: 'comments', value: (p) => p.comments_count ?? 0 },
  { header: 'engagement_pct', value: (p) => p.engagement_rate ?? '' },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'post_url', value: (p) => p.post_url ?? '' },
];

const SORT_OPTIONS = [
  { value: 'date',     label: 'Newest' },
  { value: 'likes',    label: 'Most Liked' },
  { value: 'views',    label: 'Most Viewed' },
  { value: 'comments', label: 'Most Comments' },
];

const BRAND_COLORS: Record<string, string> = {
  mizumi: '#6366f1', 'gentle-colors': '#22d3ee', bomi: '#fb923c',
};
function getBrandColor(slug: string) { return BRAND_COLORS[slug] ?? '#94a3b8'; }

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

export default function InstagramFeedTab() {
  const router = useRouter();
  const [posts, setPosts]         = useState<InstagramPost[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(true);
  // Distinguishes "no data" from "the fetch failed" in the empty state below.
  const [fetchFailed, setFetchFailed] = useState(false);
  const [brandFilter, setBrand]   = useState('');
  const [range, setRange]         = useState<DateRange>({ days: 7 });
  const [sort, setSort]           = useState('date');
  const [media, setMedia]         = useState('');
  // This tab had no text search at all, unlike TikTok's Feed Monitor which
  // has a caption search box — client-side over the already-fetched full
  // set, same fetch-all/client-sort convention as that tab.
  const [searchQ, setSearchQ]     = useState('');
  const [brandOptions, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [stats, setStats]         = useState<{ total_views: number; avg_engagement: number; last_scraped_at: string | null }>({ total_views: 0, avg_engagement: 0, last_scraped_at: null });

  useEffect(() => {
    fetchBrands()
      // Feed Monitor is own-brand posts only — competitors surface on the separate Competitors tab.
      .then((b) => setBrands(
        b.filter((x) => x.type === 'own')
          .map((x) => ({ slug: x.slug, name: x.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      ))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setFetchFailed(false);
    // Fetches the FULL filtered set (no page param) so column-header sort
    // sorts every matching row — pagination is a client-side slice below.
    fetchInstagramPosts({
      brand: brandFilter || undefined,
      ...range, limit: 100_000, sort,
      source_type: 'feed',
      media: media || undefined,
    })
      .then((r) => { setPosts(r.data); setTotal(r.total); setStats(r.stats ?? { total_views: 0, avg_engagement: 0, last_scraped_at: null }); })
      .catch(() => { setPosts([]); setFetchFailed(true); })
      .finally(() => setLoading(false));
  }, [brandFilter, range, sort, media]);

  const filteredPosts = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => (p.caption ?? '').toLowerCase().includes(q));
  }, [posts, searchQ]);

  // Client-side sort of the FULL filtered set — independent of the server-side
  // "Sort:" pills above, which only control initial order before any column
  // header is clicked.
  const { sorted: sortedPosts, sortKey, sortDir, requestSort } = useClientSort<InstagramPost>(filteredPosts, {
    brand: (p) => p.brand_name,
    author: (p) => p.author_handle ?? '',
    type: (p) => p.media_type ?? '',
    caption: (p) => p.caption ?? '',
    views: (p) => p.views ?? 0,
    likes: (p) => p.likes ?? 0,
    comments: (p) => p.comments_count ?? 0,
    engagement: (p) => (p.engagement_rate ? parseFloat(p.engagement_rate) : 0),
    posted: (p) => p.posted_at ?? '',
  });

  const totalPages = Math.max(1, Math.ceil(sortedPosts.length / PAGE_LIMIT));
  const pagePosts = sortedPosts.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(sortedPosts)}
          columns={EXPORT_COLUMNS}
          filename={() => `instagram-feed-${brandFilter || 'all'}.csv`}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Posts',    value: total.toLocaleString(),                color: 'var(--accent-primary)', sub: `updated ${timeAgo(stats.last_scraped_at)}` },
          { label: 'Total Views',    value: fmt(stats.total_views),                color: 'var(--text-primary)' },
          { label: 'Avg Engagement', value: `${stats.avg_engagement.toFixed(2)}%`, color: stats.avg_engagement > 3 ? 'var(--accent-success)' : stats.avg_engagement >= 1 ? 'var(--accent-warning)' : 'var(--text-muted)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            {s.sub && <div className="text-xs mt-1 text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Brand pills */}
      <FilterPills
        className="flex items-center gap-1.5 flex-wrap mb-3"
        options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
        value={brandFilter}
        onChange={(v) => { setBrand(v); setPage(1); }}
        styleFor={(slug) => (slug ? { background: getBrandColor(slug), color: '#fff', borderColor: getBrandColor(slug) } : {})}
      />

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <SearchInput value={searchQ} onChange={(v) => { setSearchQ(v); setPage(1); }} placeholder="Search caption…" />
        {/* Media type: distinguish posts (image/carousel) from reels */}
        <div className="flex items-center gap-1">
          <span className="text-xs mr-1 text-muted">Type:</span>
          <FilterPills
            options={[{ value: '', label: 'All' }, { value: 'post', label: 'Posts' }, { value: 'reel', label: 'Reels' }]}
            value={media}
            onChange={(v) => { setMedia(v); setPage(1); }}
          />
        </div>

        <DateRangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />

        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={(v) => { setSort(v); setPage(1); }} />
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
            <div className="text-4xl mb-3">{fetchFailed ? '⚠️' : '📸'}</div>
            <p className="font-medium mb-1 text-primary">
              {fetchFailed ? 'Could not load posts — the API may be unreachable' : searchQ.trim() ? 'No posts match your search' : 'No posts yet'}
            </p>
            {!fetchFailed && !searchQ.trim() && <p className="text-sm font-mono text-muted">Run a scrape from Settings → Account Management</p>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Brand" sortKey="brand" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Caption" sortKey="caption" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Eng %" sortKey="engagement" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.map((p) => {
                  const eng = formatEngagement(p.engagement_rate);
                  return (
                    <tr key={p.id} className="cursor-pointer" onClick={() => router.push(`/ig-post/${p.post_id}`)}>
                      <td className="brand-cell">
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: `${getBrandColor(p.brand_slug)}18`, color: getBrandColor(p.brand_slug) }}>
                          {p.brand_name}
                        </span>
                      </td>
                      <td>
                        {p.author_handle ? (
                          <a href={`https://www.instagram.com/${p.author_handle}/`} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}>
                            @{p.author_handle}
                          </a>
                        ) : <span className="text-muted">—</span>}
                      </td>
                      <td>
                        <span className={`tag ${p.media_type === 'reel' ? 'tag-purple' : 'tag-gray'}`}>
                          {p.media_type ?? 'post'}
                        </span>
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        <span title={p.caption ?? ''} className="text-secondary">
                          {p.caption ? p.caption.slice(0, 60) + (p.caption.length > 60 ? '…' : '') : '—'}
                        </span>
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>{p.views != null ? fmt(p.views) : '—'}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{fmt(p.likes)}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{fmt(p.comments_count)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="font-mono text-xs font-semibold" style={{ color: eng.color }}>{eng.text}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        {p.post_url ? (
                          <a href={p.post_url} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
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
