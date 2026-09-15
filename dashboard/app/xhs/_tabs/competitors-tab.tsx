'use client';

import { useEffect, useState } from 'react';
import { fetchXhsMentions, fetchBrands, XhsMention, DateRange } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';

const EXPORT_COLUMNS: CsvColumn<XhsMention>[] = [
  { header: 'author', value: (m) => m.author_name ?? '' },
  { header: 'content', value: (m) => m.content ?? '' },
  { header: 'likes', value: (m) => m.likes_count ?? 0 },
  { header: 'comments', value: (m) => m.comment_count ?? 0 },
  { header: 'published_at', value: (m) => m.published_at ?? '' },
  { header: 'note_url', value: (m) => m.note_url },
];

// Raw scraped data only, no sentiment analysis on top. Competitor brands are
// whatever's configured in Settings → Brands (type: 'competitor') — not
// hardcoded, so running the ad-hoc Feed Scrape card (Settings → Search) for a
// new XHS account surfaces it here automatically. Mirrors tiktok/_tabs/competitors-tab.tsx.
// Competitor accounts are often ad-hoc-scraped with "All time" lookback (Settings
// → Search Feed Scrape card), so history can span way past a 90-day window —
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

export default function XhsCompetitorsTab() {
  const [competitorBrands, setCompetitorBrands] = useState<{ slug: string; name: string }[]>([]);
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [brand, setBrand] = useState('');
  const [notes, setNotes] = useState<XhsMention[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
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
    if (!brand) { setNotes([]); setTotal(0); setLoading(false); return; }
    setLoading(true);
    // Fetches the FULL filtered set (no page param) so column-header sort
    // sorts every matching row — pagination is a client-side slice below.
    fetchXhsMentions({
      brand,
      ...range,
      limit: 100_000,
      sort: 'date',
    })
      .then((res) => {
        setNotes(res.data);
        setTotal(res.total);
      })
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  }, [brand, range]);

  const { sorted: sortedNotes, sortKey, sortDir, requestSort } = useClientSort<XhsMention>(notes, {
    author: (m) => m.author_name ?? '',
    content: (m) => m.content ?? '',
    likes: (m) => m.likes_count ?? 0,
    comments: (m) => m.comment_count ?? 0,
    posted: (m) => m.published_at ?? '',
  });

  const totalPages = Math.max(1, Math.ceil(sortedNotes.length / PAGE_LIMIT));
  const pageNotes = sortedNotes.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  if (brandsLoaded && competitorBrands.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="font-medium mb-1 text-primary">No competitor brands configured</p>
        <p className="text-sm text-muted">Add one under Settings → Brands (type: competitor), or run the ad-hoc Feed Scrape card (Settings → Search) to see its Xiaohongshu data here.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(sortedNotes)}
          columns={EXPORT_COLUMNS}
          filename={() => `xhs-competitor-${brand || 'all'}.csv`}
          disabled={!brand}
        />
      </div>

      <div className="card p-4 mb-5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-light)' }}>
        <p className="text-sm text-secondary">
          Raw scraped fields, no sentiment analysis applied. Comments not scraped by default — use the ad-hoc Feed Scrape card&apos;s &quot;Scrape comments&quot; toggle.
        </p>
      </div>

      {/* Competitor brand filter */}
      <FilterPills
        className="flex items-center gap-1 mb-3"
        options={competitorBrands.map((b) => ({ value: b.slug, label: b.name }))}
        value={brand}
        onChange={(v) => { setBrand(v); setPage(1); }}
      />

      {/* Date range filter */}
      <div className="mb-5">
        <DateRangePicker
          value={range}
          onChange={(v) => { setRange(v); setPage(1); }}
          presets={RANGE_PRESETS}
        />
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {[
          { label: 'Total Notes',   value: total.toLocaleString(), color: 'var(--accent-primary)' },
          { label: 'Comments Kept', value: notes.reduce((s, n) => s + (n.comment_count ?? 0), 0).toLocaleString(), color: 'var(--text-primary)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : notes.length === 0 ? (
          <div className="text-center py-16">
            <p className="font-medium text-primary">No data yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Content" sortKey="content" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pageNotes.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        {m.cover_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.cover_url} alt="" referrerPolicy="no-referrer"
                            className="w-8 h-10 rounded object-cover flex-shrink-0" style={{ background: 'var(--bg-elevated)' }} />
                        ) : (
                          <div className="w-8 h-10 rounded flex-shrink-0 bg-base" />
                        )}
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {m.author_name ? `@${m.author_name}` : '—'}
                        </span>
                      </div>
                    </td>
                    <td style={{ maxWidth: 340 }}>
                      <span title={m.content ?? ''} className="text-secondary">
                        {(m.content ?? '').length > 60 ? m.content!.slice(0, 60) + '…' : (m.content || '—')}
                      </span>
                    </td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(m.likes_count)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(m.comment_count)}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {m.published_at ? new Date(m.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td>
                      <a href={m.note_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                        View ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && notes.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t-light">
            <span className="text-sm text-muted">{total.toLocaleString()} notes · Page {page} of {totalPages}</span>
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
