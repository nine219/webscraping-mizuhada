'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchTikTokPosts, fetchBrands, TikTokPost, DateRange } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { ShopBadge } from '@/components/shop-badge';
import { SourceBadge } from '@/components/badges';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';

const EXPORT_COLUMNS: CsvColumn<TikTokPost>[] = [
  { header: 'source_type', value: (p) => p.source_type ?? '' },
  { header: 'author_handle', value: (p) => p.author_handle ?? '' },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views ?? 0 },
  { header: 'likes', value: (p) => p.likes ?? 0 },
  { header: 'shares', value: (p) => p.shares ?? 0 },
  { header: 'comments', value: (p) => p.comments_count ?? 0 },
  { header: 'shop_content', value: (p) => (p.is_shop_content ? 'yes' : 'no') },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'post_url', value: (p) => p.post_url ?? '' },
];

// Raw scraped data only, no sentiment/theme/spike analysis on top (spike
// detection is gated to brands.type = 'own' in spike-detection.ts, so it
// structurally never fires here). The one exception is the Shop badge below
// — shop-detection.ts runs unconditionally on every scraped post regardless
// of brand type, so it's real, already-captured data, not new analysis.
// Competitor brands are whatever's configured in Settings → Brands (type:
// 'competitor') — not hardcoded, so adding a new competitor there surfaces
// it here automatically. Competitor accounts are often ad-hoc-scraped with
// "All time" lookback (Settings → Search Feed Scrape card), so history can
// span way past a 90-day window — default to All time here (unlike
// own-brand tabs, which default to 7d) so a freshly-scraped competitor
// isn't silently empty-looking.
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

export default function TikTokCompetitorsTab() {
  const router = useRouter();
  const [competitorBrands, setCompetitorBrands] = useState<{ slug: string; name: string }[]>([]);
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [brand, setBrand] = useState('');
  const [posts, setPosts] = useState<TikTokPost[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [lastScrapedAt, setLastScrapedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState('');
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
    fetchTikTokPosts({
      brand,
      source_type: sourceFilter || undefined,
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
  }, [brand, sourceFilter, range]);

  const { sorted: sortedPosts, sortKey, sortDir, requestSort } = useClientSort<TikTokPost>(posts, {
    author: (p) => p.author_handle ?? '',
    caption: (p) => p.caption ?? '',
    views: (p) => p.views,
    likes: (p) => p.likes,
    shares: (p) => p.shares,
    comments: (p) => p.comments_count,
    posted: (p) => p.posted_at ?? '',
    source: (p) => p.source_type ?? '',
  });

  const totalPages = Math.max(1, Math.ceil(sortedPosts.length / PAGE_LIMIT));
  const pagePosts = sortedPosts.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  if (brandsLoaded && competitorBrands.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="font-medium mb-1 text-primary">No competitor brands configured</p>
        <p className="text-sm text-muted">Add one under Settings → Brands (type: competitor) to see its TikTok data here.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(sortedPosts)}
          columns={EXPORT_COLUMNS}
          filename={() => `tiktok-competitor-${brand || 'all'}.csv`}
          disabled={!brand}
        />
      </div>

      <div className="card p-4 mb-5 flex items-start gap-2.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-light)' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: '20px' }}>ⓘ</span>
        <p className="text-sm text-secondary">
          Raw scraped fields only — no sentiment, theme, or spike analysis applied, and comments
          aren&apos;t scraped for competitor accounts. Shop badges are the one exception: that
          heuristic runs on every scraped post regardless of brand, so it&apos;s shown here too.
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
          { label: 'Feed Posts',  value: posts.filter((p) => p.source_type === 'feed' || p.source_type === 'profile').length.toLocaleString(), color: 'var(--text-primary)' },
          { label: 'Keyword-Search Posts', value: posts.filter((p) => p.source_type === 'search').length.toLocaleString(), color: 'var(--text-primary)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            {s.sub && <div className="text-xs mt-1 text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Source + date range filters */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <FilterPills
          options={[
            { value: '',       label: 'All Sources' },
            { value: 'feed',   label: 'Own Account (Feed)' },
            { value: 'search', label: 'Keyword Search' },
          ]}
          value={sourceFilter}
          onChange={(v) => { setSourceFilter(v); setPage(1); }}
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
                  <SortableTh label="Source" sortKey="source" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Caption" sortKey="caption" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Shares" sortKey="shares" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Signals</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pagePosts.map((p) => (
                  <tr
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/tiktok/${p.post_id}`)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td><SourceBadge sourceType={p.source_type} /></td>
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
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.shares)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.comments_count)}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td>
                      <div className="badge-row">
                        <ShopBadge isShopContent={p.is_shop_content} shopSignal={p.shop_signal} />
                        {!p.is_shop_content && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </div>
                    </td>
                    <td>
                      {p.post_url && (
                        <a href={p.post_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
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
