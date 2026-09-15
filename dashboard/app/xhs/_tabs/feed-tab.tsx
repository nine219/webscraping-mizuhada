'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchXhsMentions, fetchXhsStats, fetchBrands, XhsMention, XhsStats, DateRange } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';

const PAGE_LIMIT = 25;

const EXPORT_COLUMNS: CsvColumn<XhsMention>[] = [
  { header: 'brand', value: (m) => m.brand_name ?? '' },
  { header: 'author', value: (m) => m.author_name ?? '' },
  { header: 'content', value: (m) => m.content ?? '' },
  { header: 'sentiment', value: (m) => m.sentiment ?? '' },
  { header: 'likes', value: (m) => m.likes_count ?? 0 },
  { header: 'comments', value: (m) => m.comment_count ?? 0 },
  { header: 'published_at', value: (m) => m.published_at ?? '' },
  { header: 'note_url', value: (m) => m.note_url },
];

const SORT_OPTIONS = [
  { value: 'date',   label: 'Newest' },
  { value: 'likes',  label: 'Most Liked' },
];

const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

function displayContent(m: XhsMention): { raw: string; th: string | null } {
  const raw = m.content ? m.content.replace(/\s*---\s*/g, ' — ') : '';
  const th = m.content_translated?.trim();
  const showTh = th && th !== m.content.trim() && CJK_RE.test(raw);
  return { raw: raw || '—', th: showTh ? th : null };
}

const SENTIMENT_CONFIG: Record<string, { label: string; color: string }> = {
  positive: { label: 'Positive', color: '#10b981' },
  neutral:  { label: 'Neutral',  color: '#94a3b8' },
  negative: { label: 'Negative', color: '#ef4444' },
  question: { label: 'Question', color: '#8b5cf6' },
};

export default function XhsFeedTab() {
  const router = useRouter();
  const [mentions, setMentions] = useState<XhsMention[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [brandFilter, setBrandFilter] = useState('');
  const [sentimentFilter, setSentimentFilter] = useState('');
  const [sort, setSort] = useState('date');
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);
  const [stats, setStats] = useState<XhsStats | null>(null);
  // Distinguishes "no data" from "the fetch failed" in the empty state below.
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    fetchBrands()
      // Feed = own-brand accounts only. XHS also has no Bomi data — don't offer that filter either.
      .then((b) => setBrandOptions(b.filter((x) => x.type === 'own' && x.slug !== 'bomi').map((x) => ({ slug: x.slug, name: x.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setFetchFailed(false);
    // Brand Monitor shows official (own-brand) posts only — UGC mentions live
    // on the separate UGC Search tab, so no source toggle here.
    // Fetches the FULL filtered set (no page param) so column-header sort
    // sorts every matching row — pagination is a client-side slice below.
    fetchXhsMentions({
      brand: brandFilter || undefined, ...range, limit: 100_000,
      source: 'profile', sentiment: sentimentFilter || undefined, sort,
    })
      .then((res) => { setMentions(res.data); setTotal(res.total); })
      .catch(() => { setMentions([]); setFetchFailed(true); })
      .finally(() => setLoading(false));
  }, [brandFilter, sentimentFilter, sort, range]);

  useEffect(() => {
    fetchXhsStats({ brand: brandFilter || undefined, ...range, source: 'profile' })
      .then(setStats)
      .catch(() => setStats(null));
  }, [brandFilter, range]);

  const s = stats?.sentiment;

  // Client-side sort of the FULL filtered set — independent of the server-side
  // "Sort:" pills above, which only control initial order before any column
  // header is clicked.
  const { sorted: sortedMentions, sortKey, sortDir, requestSort } = useClientSort<XhsMention>(mentions, {
    brand: (m) => m.brand_name ?? '',
    author: (m) => m.author_name ?? '',
    content: (m) => m.content ?? '',
    likes: (m) => m.likes_count ?? 0,
    comments: (m) => m.comment_count ?? 0,
    posted: (m) => m.published_at ?? '',
    sentiment: (m) => m.sentiment ?? '',
  });

  const totalPages = Math.max(1, Math.ceil(sortedMentions.length / PAGE_LIMIT));
  const pageMentions = sortedMentions.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(sortedMentions)}
          columns={EXPORT_COLUMNS}
          filename={() => `xhs-feed-${brandFilter || 'all'}.csv`}
        />
      </div>

      {/* Summary stats — 4 raw counts, no composites */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Mentions', value: total.toLocaleString(),                           color: 'var(--accent-primary)', sub: `updated ${timeAgo(stats?.last_scraped_at)}` },
          { label: 'Notes Covered',  value: (stats?.total_notes ?? 0).toLocaleString(),       color: 'var(--text-primary)'   },
          { label: 'Positive',       value: (s?.positive ?? 0).toLocaleString(),              color: 'var(--sentiment-positive)' },
          { label: 'Negative',       value: (s?.negative ?? 0).toLocaleString(),              color: 'var(--sentiment-negative)' },
        ].map((c) => (
          <div key={c.label} className="card p-5">
            <div className="stat-label mb-2">{c.label}</div>
            <div className="stat-value" style={{ color: c.color }}>{c.value}</div>
            {c.sub && <div className="text-xs mt-1 text-muted">{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* Brand pills */}
      <FilterPills
        className="flex items-center gap-1.5 flex-wrap mb-3"
        options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
        value={brandFilter}
        onChange={(v) => { setBrandFilter(v); setPage(1); }}
      />

      {/* Sentiment filter pills */}
      <FilterPills
        className="flex items-center gap-1 flex-wrap mb-3"
        options={[
          { value: '',         label: 'All Sentiments' },
          { value: 'positive', label: 'Positive' },
          { value: 'neutral',  label: 'Neutral' },
          { value: 'negative', label: 'Negative' },
          { value: 'question', label: 'Question' },
        ]}
        value={sentimentFilter}
        onChange={(v) => { setSentimentFilter(v); setPage(1); }}
      />

      {/* Controls row: days + sort */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <DateRangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={(v) => { setSort(v); setPage(1); }} />
        </div>
      </div>

      {/* Table — XHS-only columns (no Views/Shares/Eng — XHS doesn't expose them) */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : mentions.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">{fetchFailed ? '⚠️' : '📕'}</div>
            <p className="font-medium mb-1 text-primary">{fetchFailed ? 'Could not load mentions — the API may be unreachable' : 'No mentions yet'}</p>
            {!fetchFailed && <p className="text-sm text-muted">Run a scrape from the UGC Search tab.</p>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Brand" sortKey="brand" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Content" sortKey="content" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Sentiment" sortKey="sentiment" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pageMentions.map((m) => {
                  const { raw, th } = displayContent(m);
                  const title = th ? `${raw} (${th})` : raw;
                  const truncatedRaw = raw.length > 55 ? raw.slice(0, 55) + '…' : raw;
                  const truncatedTh = th && th.length > 55 ? th.slice(0, 55) + '…' : th;
                  const meta = m.sentiment ? SENTIMENT_CONFIG[m.sentiment] : null;
                  return (
                    <tr
                      key={m.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/xhs/${m.note_id}`)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td className="brand-cell">
                        <div className="flex items-center gap-1.5">
                          {m.brand_name ?? '—'}
                          {!m.is_note && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(99,102,241,0.12)', color: '#6366f1' }}>Comment</span>
                          )}
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {m.author_name ? `@${m.author_name}` : '—'}
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <div className="flex items-center gap-2">
                          {m.cover_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={m.cover_url} alt="" referrerPolicy="no-referrer"
                              className="w-8 h-10 rounded object-cover flex-shrink-0" style={{ background: 'var(--bg-elevated)' }} />
                          )}
                          <span title={title} className="text-secondary">
                            {truncatedRaw}
                            {truncatedTh && (
                              <span style={{ color: 'var(--accent-info)' }}> ({truncatedTh})</span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>
                        {(m.likes_count ?? 0).toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="font-mono text-xs font-semibold" style={{ color: m.comment_count > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                          {(m.comment_count ?? 0).toLocaleString()}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {m.published_at ? new Date(m.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        {meta ? (
                          <div className="flex items-center gap-1.5" title={meta.label}>
                            <div className="rounded flex-shrink-0" style={{ width: 24, height: 8, background: meta.color, opacity: 0.85 }} />
                            <span className="text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td>
                        <a href={m.note_url} target="_blank" rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                          View ↗
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && mentions.length > 0 && (
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
