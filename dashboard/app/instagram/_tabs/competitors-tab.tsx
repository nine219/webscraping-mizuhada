'use client';

import { useEffect, useState } from 'react';
import { fetchInstagramPosts, fetchBrands, InstagramPost, DateRange } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';

const EXPORT_COLUMNS: CsvColumn<InstagramPost>[] = [
  { header: 'media_type', value: (p) => p.media_type ?? '' },
  { header: 'author_handle', value: (p) => p.author_handle ?? '' },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views ?? '' },
  { header: 'likes', value: (p) => p.likes ?? 0 },
  { header: 'comments', value: (p) => p.comments_count ?? 0 },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'post_url', value: (p) => p.post_url ?? '' },
];

// Raw scraped data only, no sentiment/theme/spike analysis on top. Competitor
// brands are whatever's configured in Settings → Brands (type: 'competitor') —
// not hardcoded, so adding one there (or running the ad-hoc Feed Scrape card,
// Settings → Search) surfaces it here automatically. Mirrors tiktok/_tabs/competitors-tab.tsx.
// Competitor accounts are often ad-hoc-scraped with "All time" lookback (Settings
// → Search Feed Scrape card), so history can span way past a 30/90-day window —
// default to All time here (unlike own-brand tabs, which default to 7d) so a
// freshly-scraped competitor isn't silently empty-looking.
const PAGE_LIMIT = 50;
const RANGE_PRESETS = [
  { key: 'd30',  label: '30D',  days: 30 },
  { key: 'd90',  label: '90D',  days: 90 },
  { key: 'd365', label: '1Y',   days: 365 },
  { key: 'all',  label: 'All time', days: 0 },
];

function fmt(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = typeof n === 'string' ? parseInt(n, 10) : n;
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export default function InstagramCompetitorsTab() {
  const [competitorBrands, setCompetitorBrands] = useState<{ slug: string; name: string }[]>([]);
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [brand, setBrand] = useState('');
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [lastScrapedAt, setLastScrapedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mediaFilter, setMediaFilter] = useState('');
  const [range, setRange] = useState<DateRange>({ days: 0 });

  useEffect(() => {
    fetchBrands()
      .then((b) => {
        const competitors = b.filter((x) => x.type === 'competitor')
          .map((x) => ({ slug: x.slug, name: x.name }))
          .sort((a, c) => a.name.localeCompare(c.name));
        setCompetitorBrands(competitors);
        setBrand((prev) => prev || competitors[0]?.slug || '');
      })
      .catch(() => {})
      .finally(() => setBrandsLoaded(true));
  }, []);

  useEffect(() => {
    if (!brand) { setPosts([]); setTotal(0); setLoading(false); return; }
    setLoading(true);
    // Fetches the FULL filtered set (no page param) so column-header sort
    // sorts every matching row — pagination is a client-side slice below.
    fetchInstagramPosts({
      brand,
      media: mediaFilter || undefined,
      ...range,
      limit: 100_000,
      sort: 'date',
    })
      .then((res) => {
        setPosts(res.data);
        setTotal(res.total);
        setLastScrapedAt(res.stats?.last_scraped_at ?? null);
      })
      .catch(() => setPosts([]))
      .finally(() => setLoading(false));
  }, [brand, mediaFilter, range]);

  // Client-side sort of the FULL filtered set — independent of the server-side
  // "Sort:" pills, which only control initial order before any column header is clicked.
  const { sorted: sortedPosts, sortKey, sortDir, requestSort } = useClientSort<InstagramPost>(posts, {
    author: (p) => p.author_handle ?? '',
    type: (p) => p.media_type ?? '',
    caption: (p) => p.caption ?? '',
    views: (p) => p.views ?? 0,
    likes: (p) => p.likes,
    comments: (p) => p.comments_count,
    posted: (p) => p.posted_at ?? '',
  });

  const totalPages = Math.max(1, Math.ceil(sortedPosts.length / PAGE_LIMIT));
  const pagePosts = sortedPosts.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  if (brandsLoaded && competitorBrands.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="font-medium mb-1 text-primary">No competitor brands configured</p>
        <p className="text-sm text-muted">Add one under Settings → Brands (type: competitor), or run the ad-hoc Feed Scrape card (Settings → Search) to see its Instagram data here.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(sortedPosts)}
          columns={EXPORT_COLUMNS}
          filename={() => `instagram-competitor-${brand || 'all'}.csv`}
          disabled={!brand}
        />
      </div>

      <div className="card p-4 mb-5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-light)' }}>
        <p className="text-sm text-secondary">
          Raw scraped fields, no sentiment/theme/spike analysis applied. Comments not scraped by default — use the ad-hoc Feed Scrape card&apos;s &quot;Scrape comments&quot; toggle.
        </p>
      </div>

      {/* Competitor brand filter */}
      <FilterPills
        className="flex items-center gap-1 mb-3"
        options={competitorBrands.map((b) => ({ value: b.slug, label: b.name }))}
        value={brand}
        onChange={(v) => { setBrand(v); setPage(1); }}
      />

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Posts', value: total.toLocaleString(), color: 'var(--accent-primary)', sub: `updated ${timeAgo(lastScrapedAt)}` },
          { label: 'Posts',       value: posts.filter((p) => p.media_type !== 'reel').length.toLocaleString(), color: 'var(--text-primary)' },
          { label: 'Reels',       value: posts.filter((p) => p.media_type === 'reel').length.toLocaleString(), color: 'var(--text-primary)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            {s.sub && <div className="text-xs mt-1 text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Media type + date range filters */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <FilterPills
          options={[
            { value: '',     label: 'All Types' },
            { value: 'post', label: 'Posts' },
            { value: 'reel', label: 'Reels' },
          ]}
          value={mediaFilter}
          onChange={(v) => { setMediaFilter(v); setPage(1); }}
        />
        <DateRangePicker
          value={range}
          onChange={(v) => { setRange(v); setPage(1); }}
          presets={RANGE_PRESETS}
        />
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : posts.length === 0 ? (
          <div className="text-center py-16">
            <p className="font-medium text-primary">No data yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Caption" sortKey="caption" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: p.media_type === 'reel' ? 'rgba(99,102,241,0.12)' : 'rgba(16,185,129,0.12)', color: p.media_type === 'reel' ? '#6366f1' : '#10b981' }}>
                        {p.media_type === 'reel' ? 'Reel' : 'Post'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {p.author_handle ? `@${p.author_handle}` : '—'}
                    </td>
                    <td style={{ maxWidth: 340 }}>
                      <span title={p.caption ?? ''} className="text-secondary">
                        {(p.caption ?? '').length > 60 ? p.caption!.slice(0, 60) + '…' : (p.caption || '—')}
                      </span>
                    </td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.views)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.likes)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.comments_count)}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td>
                      {p.post_url && (
                        <a href={p.post_url} target="_blank" rel="noopener noreferrer"
                          className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                          View ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && posts.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t-light">
            <span className="text-sm text-muted">{total.toLocaleString()} posts · Page {page} of {totalPages}</span>
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
