'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchXhsMentions, fetchXhsStats, fetchBrands, XhsMention, XhsStats, DateRange } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { SearchInput } from '@/components/search-input';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';
import DailyCountChart from '@/components/charts/daily-count-chart';

const PAGE_LIMIT = 25;

const EXPORT_COLUMNS: CsvColumn<XhsMention>[] = [
  { header: 'author', value: (m) => m.author_name ?? '' },
  { header: 'brand', value: (m) => m.brand_name ?? '' },
  { header: 'keyword', value: (m) => m.search_keyword ?? '' },
  { header: 'content', value: (m) => m.content ?? '' },
  { header: 'likes', value: (m) => m.likes_count ?? 0 },
  { header: 'comments', value: (m) => m.comment_count ?? 0 },
  { header: 'published_at', value: (m) => m.published_at ?? '' },
  { header: 'note_url', value: (m) => m.note_url },
];

const SORT_OPTIONS = [
  { value: 'date',   label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'likes',  label: 'Most Liked' },
];

export default function XhsSearchTab() {
  const router = useRouter();
  const [mentions, setMentions] = useState<XhsMention[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Distinguishes "no data" from "the fetch failed" in the empty state below.
  const [fetchFailed, setFetchFailed] = useState(false);

  const [brandFilter, setBrandFilter] = useState('');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState(searchQ);
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [sort, setSort] = useState('date');
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);
  const [stats, setStats] = useState<XhsStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    fetchBrands()
      // XHS has no Bomi data — don't offer the filter.
      .then((brands) => setBrandOptions(brands.filter((b) => b.type === 'own' && b.slug !== 'bomi').map((b) => ({ slug: b.slug, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(searchQ); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchQ]);

  const authorFilter  = debouncedQ.startsWith('@') ? debouncedQ.slice(1) : undefined;
  const captionFilter = debouncedQ && !debouncedQ.startsWith('@') ? debouncedQ : undefined;

  useEffect(() => {
    setLoading(true);
    setFetchFailed(false);
    // Fetches the FULL filtered set (no page param) so column-header sort
    // sorts every matching row — pagination is a client-side slice below.
    fetchXhsMentions({
      brand: brandFilter || undefined, ...range, limit: 100_000, source: 'search', sort,
      searchKeyword: keywordFilter || undefined,
      author: authorFilter,
      keyword: captionFilter,
    })
      .then((res) => { setMentions(res.data); setTotal(res.total); })
      .catch(() => { setMentions([]); setFetchFailed(true); })
      .finally(() => setLoading(false));
  }, [brandFilter, range, sort, keywordFilter, debouncedQ]);

  useEffect(() => {
    setStatsLoading(true);
    fetchXhsStats({ brand: brandFilter || undefined, ...range, source: 'search' })
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false));
  }, [brandFilter, range]);

  function handleKeywordClick(kw: string) { setKeywordFilter((prev) => (prev === kw ? '' : kw)); setPage(1); }

  // Client-side sort of the FULL filtered set — independent of the server-side
  // "Sort:" pills above, which only control initial order before any column
  // header is clicked.
  const { sorted: sortedMentions, sortKey, sortDir, requestSort } = useClientSort<XhsMention>(mentions, {
    author: (m) => m.author_name ?? '',
    brand: (m) => m.brand_name ?? '',
    keyword: (m) => m.search_keyword ?? '',
    content: (m) => m.content ?? '',
    likes: (m) => m.likes_count ?? 0,
    comments: (m) => m.comment_count ?? 0,
    posted: (m) => m.published_at ?? '',
  });

  const totalPages = Math.max(1, Math.ceil(sortedMentions.length / PAGE_LIMIT));
  const pageMentions = sortedMentions.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  return (
    <div>
      {/* Summary stats — no views/engagement% on XHS (scraper doesn't capture views) */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Mentions Found', value: total.toLocaleString(), color: 'var(--accent-primary)', sub: `updated ${timeAgo(stats?.last_scraped_at)}` },
          { label: 'Notes Covered',  value: (stats?.total_notes ?? 0).toLocaleString(), color: 'var(--text-primary)' },
          { label: 'Positive Comments', value: stats ? `${stats.sentiment.positive} / ${stats.sentiment.total}` : '—', color: 'var(--sentiment-positive)' },
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
              const { positive, negative, neutral, question, total: st } = stats.sentiment;
              const pct = (n: number) => Math.round((n / st) * 100);
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

          {/* Keyword breakdown — click a keyword to filter the note list below */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="stat-label">Notes by Keyword</div>
              {keywordFilter && (
                <button className="text-xs font-medium" style={{ color: 'var(--accent-primary)' }}
                  onClick={() => { setKeywordFilter(''); setPage(1); }}>Clear ✕</button>
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
                        <span className="text-muted">{k.post_count} notes · {k.total_likes.toLocaleString()} likes</span>
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

          {/* Top authors — real server-side aggregate over the full filtered set */}
          <div className="card p-5">
            <div className="stat-label mb-3">Top Creators Mentioning Brand</div>
            {stats.top_authors.length === 0 ? (
              <p className="text-xs text-muted">No data</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {stats.top_authors.map((a, i) => (
                  <div key={a.handle} className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-mono" style={{ color: 'var(--text-muted)', width: 14 }}>{i + 1}</span>
                      <span className="text-xs font-mono font-medium truncate" style={{ color: 'var(--accent-primary)' }}>@{a.handle}</span>
                    </div>
                    <div className="text-xs whitespace-nowrap text-muted">
                      {a.mention_count}× · {a.total_likes.toLocaleString()} likes
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Daily mentions chart */}
          {stats.daily_trend.length > 1 && (
            <div className="card p-5" style={{ gridColumn: 'span 3' }}>
              <div className="stat-label mb-3">Daily Mentions</div>
              <div style={{ height: 220 }}>
                <DailyCountChart data={stats.daily_trend} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Search + brand pills + export — search always leads, export pushed right. */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <SearchInput value={searchQ} onChange={setSearchQ} placeholder="Search caption or @author…" />
        <FilterPills
          className="flex items-center gap-1.5 flex-wrap"
          options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
          value={brandFilter}
          onChange={(v) => { setBrandFilter(v); setPage(1); }}
        />
        <div className="ml-auto">
          <ExportCsvButton
            fetchAll={() => Promise.resolve(sortedMentions)}
            columns={EXPORT_COLUMNS}
            filename={() => `xhs-search-${brandFilter || 'all'}.csv`}
          />
        </div>
      </div>

      {/* Days + sort */}
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <DateRangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={(v) => { setSort(v); setPage(1); }} />
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
        ) : mentions.length === 0 ? (
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
                  <SortableTh label="Keyword" sortKey="keyword" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Content" sortKey="content" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pageMentions.map((m) => (
                  <tr
                    key={m.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/xhs/${m.note_id}`)}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td>
                      <div className="flex items-center gap-2">
                        {m.cover_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.cover_url} alt="" referrerPolicy="no-referrer"
                            className="w-8 h-10 rounded object-cover flex-shrink-0" style={{ background: 'var(--bg-elevated)' }} />
                        ) : (
                          <div className="w-8 h-10 rounded flex-shrink-0 bg-base" />
                        )}
                        {m.author_name ? (
                          <span className="font-mono text-xs text-secondary">@{m.author_name}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Unknown</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                        {m.brand_name ?? '—'}
                      </span>
                    </td>
                    <td>
                      {m.search_keyword ? (
                        <button
                          className="font-mono text-xs"
                          style={{ color: 'var(--accent-primary)' }}
                          onClick={(e) => { e.stopPropagation(); handleKeywordClick(m.search_keyword!); }}
                        >
                          {m.search_keyword}
                        </button>
                      ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ maxWidth: 260 }}>
                      <span title={m.content ?? ''} style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                        {m.content ? m.content.slice(0, 50) + (m.content.length > 50 ? '…' : '') : '—'}
                      </span>
                    </td>
                    <td className="price" style={{ textAlign: 'right' }}>{(m.likes_count ?? 0).toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="font-mono text-xs font-semibold" style={{ color: m.comment_count > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                        {(m.comment_count ?? 0).toLocaleString()}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {m.published_at ? new Date(m.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td>
                      <a href={m.note_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs font-medium" style={{ color: 'var(--accent-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                        onClick={(e) => e.stopPropagation()}>
                        View ↗
                      </a>
                    </td>
                  </tr>
                ))}
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
