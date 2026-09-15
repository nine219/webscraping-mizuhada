'use client';

import { useEffect, useState } from 'react';
import {
  fetchSocial, fetchSocialStats, fetchBrands, SocialComment, Brand,
  fetchTwitterSession, fetchTwitterMentionsStats, TwitterMentionsStats, DateRange,
} from '@/lib/api';
import { OtherBrandChip, HighReachBadge } from '@/components/badges';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { SearchInput } from '@/components/search-input';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';
import { timeAgo } from '@/lib/format';

// Matches PAGE_LIMIT on every other list page — was 30 here, no stated reason.
const PAGE_LIMIT = 25;

const EXPORT_COLUMNS: CsvColumn<SocialComment>[] = [
  { header: 'brand', value: (t) => t.brand_name ?? '' },
  { header: 'author', value: (t) => t.author_name ?? '' },
  { header: 'content', value: (t) => t.content },
  { header: 'sentiment', value: (t) => t.sentiment ?? '' },
  { header: 'topic', value: (t) => t.topic ?? '' },
  { header: 'views', value: (t) => t.views_count ?? '' },
  { header: 'likes', value: (t) => t.likes_count ?? '' },
  { header: 'retweets', value: (t) => t.retweets_count ?? '' },
  { header: 'replies', value: (t) => t.reply_count ?? '' },
  { header: 'published_at', value: (t) => t.published_at ?? '' },
  { header: 'post_url', value: (t) => t.post_url ?? '' },
];

const SENTIMENT_META: Record<string, { label: string; color: string }> = {
  positive: { label: 'Positive', color: '#10b981' },
  neutral:  { label: 'Neutral',  color: '#94a3b8' },
  negative: { label: 'Negative', color: '#ef4444' },
  question: { label: 'Question', color: '#8b5cf6' },
  resale:   { label: 'Resale',   color: '#6366f1' },
};

function fmt(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = typeof n === 'string' ? parseInt(n, 10) : n;
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// Same threshold formula GET /api/twitter/mentions/stats applies server-side
// (views_count >= xViralViewsThreshold OR retweets_count >= 100). That
// endpoint scopes its own `high_reach.count` to source_type='search' UGC rows
// only (its docstring: mirrors tiktok/search/stats' UGC-only semantics), but
// this table shows every twitter social_comments row (replies/quotes too —
// no source_type filter on fetchSocial, pre-existing and unrelated to this
// change). Applying the same numeric bar to every row here is an honest
// superset read for a per-row marker: a reply that cleared the bar is still
// meaningfully high-reach to someone scanning the table, even outside that
// endpoint's narrower UGC-only tally.
function isHighReach(t: SocialComment, hr: TwitterMentionsStats['high_reach'] | null): boolean {
  if (!hr) return false;
  const views = t.views_count != null ? parseInt(String(t.views_count), 10) : 0;
  const retweets = t.retweets_count != null ? parseInt(String(t.retweets_count), 10) : 0;
  return views >= hr.threshold_views || retweets >= hr.threshold_retweets;
}

export default function MentionsTab() {
  const [items, setItems] = useState<SocialComment[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Distinguishes "no data" from "the fetch failed" in the empty state below.
  const [fetchFailed, setFetchFailed] = useState(false);
  const [session, setSession] = useState<{ valid: boolean } | null>(null);

  const [brandFilter, setBrandFilter] = useState('');
  const [sentimentFilter, setSentimentFilter] = useState('');
  const [highReachOnly, setHighReachOnly] = useState(false);
  // Off-topic replies (classifier-tagged brand_relevance='other_brand' — e.g.
  // a random reply under one of our own tweets that has nothing to do with
  // us, since twitter-comments.ts saves every reply on our own posts
  // unconditionally, not just on-topic ones) are noise in the default view.
  // Hidden by default; toggle to review them.
  const [hideOtherBrand, setHideOtherBrand] = useState(true);
  const [tweetTypeFilter, setTweetTypeFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [brandOptions, setBrandOptions] = useState<Brand[]>([]);
  const [lastScrapedAt, setLastScrapedAt] = useState<string | null>(null);
  const [highReach, setHighReach] = useState<TwitterMentionsStats['high_reach'] | null>(null);

  useEffect(() => {
    fetchBrands().then((b) => setBrandOptions(b.filter((x) => x.type === 'own'))).catch(() => {});
    fetchTwitterSession().then(setSession).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    setLoading(true);
    setFetchFailed(false);
    // Fetches the FULL filtered set (no page param) so column-header sort
    // sorts every matching row — pagination is a client-side slice below.
    fetchSocial({
      platform: 'twitter',
      sentiment: sentimentFilter || undefined,
      brand: brandFilter || undefined,
      ...range,
      limit: 100_000,
    })
      .then((r) => { setItems(r.data); })
      .catch(() => { setItems([]); setFetchFailed(true); console.warn('[MentionsTab] fetchSocial failed'); })
      .finally(() => setLoading(false));
  }, [brandFilter, sentimentFilter, range]);

  useEffect(() => {
    fetchSocialStats({ platform: 'twitter', sentiment: sentimentFilter || undefined, brand: brandFilter || undefined, ...range })
      .then((s) => setLastScrapedAt(s.lastScrapedAt))
      .catch(() => setLastScrapedAt(null));
  }, [brandFilter, sentimentFilter, range]);

  // /api/twitter/mentions/stats now takes ?brand= (no sentiment param — the
  // high-reach bar is a reach threshold, not sentiment-scoped), so this
  // tracks the same brand pill as the mentions list below it.
  useEffect(() => {
    fetchTwitterMentionsStats({ ...range, brand: brandFilter || undefined })
      .then((s) => setHighReach(s.high_reach))
      .catch(() => setHighReach(null));
  }, [range, brandFilter]);

  // Client-side sort of the FULL filtered set — this page has no server-side
  // sort param today (existing gap, left untouched), so initial order is just
  // fetch order until a column header is clicked.
  const { sorted: sortedItems, sortKey, sortDir, requestSort } = useClientSort<SocialComment>(items, {
    brand: (t) => t.brand_name ?? '',
    author: (t) => t.author_name ?? '',
    tweet: (t) => t.content ?? '',
    likes: (t) => (t.likes_count != null ? parseInt(String(t.likes_count), 10) : 0),
    views: (t) => (t.views_count != null ? parseInt(String(t.views_count), 10) : 0),
    retweets: (t) => (t.retweets_count != null ? parseInt(String(t.retweets_count), 10) : 0),
    replies: (t) => (t.reply_count != null ? parseInt(String(t.reply_count), 10) : 0),
    posted: (t) => t.published_at ?? '',
    sentiment: (t) => t.sentiment ?? '',
    topic: (t) => t.topic ?? '',
    highReach: (t) => (isHighReach(t, highReach) ? 1 : 0),
  });

  const otherBrandCount = items.filter((t) => t.brand_relevance === 'other_brand').length;
  const q = searchQuery.trim().toLowerCase();
  // Every filter except the high-reach toggle itself — the High-Reach tile
  // counts within this set (so it shows "how many WOULD show if I turn this
  // on", not a number that's already collapsed once the toggle is active).
  const itemsBeforeHighReachToggle = sortedItems
    .filter((t) => !hideOtherBrand || t.brand_relevance !== 'other_brand')
    .filter((t) => !tweetTypeFilter || (tweetTypeFilter === 'unclassified' ? t.tweet_type == null : t.tweet_type === tweetTypeFilter))
    .filter((t) => !q || (t.author_name ?? '').toLowerCase().includes(q) || t.content.toLowerCase().includes(q));
  const filteredItems = itemsBeforeHighReachToggle
    .filter((t) => !highReachOnly || isHighReach(t, highReach));
  const highReachCount = itemsBeforeHighReachToggle.filter((t) => isHighReach(t, highReach)).length;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_LIMIT));
  const pageItems = filteredItems.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT);

  // Sentiment stat tiles — over the same set the table actually shows (every
  // active filter: hide-off-topic, high-reach-only, tweet type, search), not
  // just the server-side brand/sentiment/date params. 'other_brand'-flagged
  // comments are excluded from the tally entirely (not even "none"/unanalyzed),
  // same convention as the brand_relevance SQL filters — but only when the
  // hide-off-topic toggle hasn't already dropped them via filteredItems.
  const bucket = { positive: 0, negative: 0, neutral: 0, question: 0, resale: 0, none: 0 };
  for (const c of filteredItems) {
    const s = c.sentiment as keyof typeof bucket | null;
    if (!s) { bucket.none++; continue; }
    if (c.brand_relevance === 'other_brand') continue;
    if (s in bucket) bucket[s]++; else bucket.none++;
  }

  return (
    <div>
      <div className="flex items-center justify-end gap-3 mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(filteredItems)}
          columns={EXPORT_COLUMNS}
          filename={() => `x-mentions-${brandFilter || 'all'}.csv`}
        />
        <span className="text-xs text-muted">
          Session:{' '}
          <strong style={{ color: session?.valid ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
            {session == null ? '—' : session.valid ? 'valid ✓' : 'invalid ✗'}
          </strong>
        </span>
      </div>

      {!session?.valid && (
        <div className="card p-4 mb-4" style={{ borderLeft: '3px solid var(--accent-warning)' }}>
          <div className="text-sm text-secondary">
            X session not logged in — go to <strong>Settings → Twitter/X</strong> and click <strong>Log in to X</strong> before running a scrape.
          </div>
        </div>
      )}

      {/* Summary stats — raw counts of what's on this page */}
      <div className="grid grid-cols-6 gap-4 mb-6">
        {[
          { label: 'Total Mentions',   value: filteredItems.length.toLocaleString(),               color: 'var(--accent-primary)', sub: `updated ${timeAgo(lastScrapedAt)}` },
          { label: 'High-Reach',       value: highReachCount.toLocaleString(), color: 'var(--accent-info)', sub: highReachOnly ? 'Showing high-reach only — click to clear' : 'Click to filter to high-reach only', clickable: true },
          { label: 'Positive (page)',  value: bucket.positive.toLocaleString(),     color: 'var(--sentiment-positive)' },
          { label: 'Negative (page)',  value: bucket.negative.toLocaleString(),     color: 'var(--sentiment-negative)' },
          { label: 'Resale (page)',    value: bucket.resale.toLocaleString(),       color: '#6366f1' },
          { label: 'Unanalyzed (page)',value: bucket.none.toLocaleString(),         color: 'var(--text-muted)'       },
        ].map((s) => (
          <div
            key={s.label}
            className="card p-5"
            style={s.clickable ? {
              cursor: 'pointer',
              border: highReachOnly ? '1px solid var(--accent-info)' : '1px solid var(--border-light)',
              background: highReachOnly ? 'var(--accent-primary-subtle)' : undefined,
            } : undefined}
            onClick={s.clickable ? () => { setHighReachOnly((v) => !v); setPage(1); } : undefined}
          >
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            {s.sub && <div className="text-xs mt-1 text-muted">{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Brand pills */}
      <FilterPills
        className="flex items-center gap-1.5 flex-wrap mb-3"
        options={[{ value: '', label: 'All Brands' }, ...brandOptions.filter((b) => b.type === 'own').map((b) => ({ value: b.slug, label: b.name }))]}
        value={brandFilter}
        onChange={(v) => { setBrandFilter(v); setPage(1); }}
      />

      {/* Sentiment pills */}
      <FilterPills
        className="flex items-center gap-1 mb-3 flex-wrap"
        options={['', 'positive', 'negative', 'neutral', 'question', 'resale'].map((v) => ({
          value: v, label: v === '' ? 'All Sentiments' : v[0].toUpperCase() + v.slice(1),
        }))}
        value={sentimentFilter}
        onChange={(v) => { setSentimentFilter(v); setPage(1); }}
      />

      {/* Tweet type pills — original vs reply/quote/retweet. "Unclassified" is
          its own bucket (not folded into "All") — rows scraped before
          tweet_type existed, so the four real types don't silently undercount
          against "All Types"'s total. */}
      <FilterPills
        className="flex items-center gap-1 mb-3 flex-wrap"
        options={['', 'original', 'quote', 'reply', 'retweet', 'unclassified'].map((v) => ({
          value: v, label: v === '' ? 'All Types' : v === 'unclassified' ? 'Unclassified' : v[0].toUpperCase() + v.slice(1),
        }))}
        value={tweetTypeFilter}
        onChange={(v) => { setTweetTypeFilter(v); setPage(1); }}
      />

      {/* Search + date range — search always leads. */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <SearchInput value={searchQuery} onChange={(v) => { setSearchQuery(v); setPage(1); }} placeholder="Search username or tweet text..." />
        <DateRangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
      </div>

      {/* Off-topic reply toggle */}
      {otherBrandCount > 0 && (
        <label className="flex items-center gap-2 mb-5 text-xs text-muted" style={{ cursor: 'pointer', width: 'fit-content' }}>
          <input type="checkbox" checked={hideOtherBrand} onChange={(e) => { setHideOtherBrand(e.target.checked); setPage(1); }} />
          Hide off-topic replies ({otherBrandCount} found)
        </label>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin"
              style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">{fetchFailed ? '⚠️' : '🐦'}</div>
            <p className="font-medium mb-1 text-primary">{fetchFailed ? 'Could not load tweets — the API may be unreachable' : 'No tweets yet'}</p>
            {!fetchFailed && (
              <p className="text-sm mb-4 text-muted">
                Run a search from Settings → Account Management, or wait for the 2h cron.
              </p>
            )}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📡</div>
            <p className="font-medium mb-1 text-primary">No high-reach mentions in this filter</p>
            <button className="btn btn-sm mt-2" onClick={() => setHighReachOnly(false)}>Clear filter</button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Brand" sortKey="brand" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Author" sortKey="author" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Tweet" sortKey="tweet" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="High Reach" sortKey="highReach" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Retweets" sortKey="retweets" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Replies" sortKey="replies" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Sentiment" sortKey="sentiment" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Topic" sortKey="topic" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((t) => {
                  const meta = t.sentiment ? SENTIMENT_META[t.sentiment] : null;
                  return (
                    <tr key={t.id}>
                      <td className="brand-cell">
                        {t.brand_name ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style={{ background: 'var(--accent-primary-subtle)', color: 'var(--accent-primary)' }}>
                            {t.brand_name}
                          </span>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {t.author_name ? `@${t.author_name}` : '—'}
                        {t.author_followers != null && (
                          <div style={{ fontSize: 10 }}>{fmt(t.author_followers)} followers</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 480 }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.4 }}>
                          {t.content.slice(0, 200)}{t.content.length > 200 ? '…' : ''}
                        </span>
                      </td>
                      <td>
                        {isHighReach(t, highReach) ? <HighReachBadge active /> : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>
                        {fmt(t.views_count)}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>
                        {fmt(t.likes_count)}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>
                        {fmt(t.retweets_count)}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>
                        {fmt(t.reply_count)}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {t.published_at
                          ? new Date(t.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                          : '—'}
                      </td>
                      <td>
                        {meta ? (
                          <div className="flex items-center gap-1.5" title={meta.label}>
                            <div className="rounded flex-shrink-0" style={{ width: 24, height: 8, background: meta.color, opacity: 0.85 }} />
                            <span className="text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                        {t.brand_relevance === 'other_brand' && (
                          <div className="mt-1">
                            <OtherBrandChip active />
                          </div>
                        )}
                      </td>
                      <td>
                        {t.topic ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                            style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                            {t.topic}
                          </span>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td>
                        {t.post_url ? (
                          <a href={t.post_url} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium" style={{ color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>
                            View ↗
                          </a>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                        {t.original_post_url && (
                          <div className="mt-1">
                            <a href={t.original_post_url} target="_blank" rel="noopener noreferrer"
                              className="text-xs" style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                              ↩ Original ↗
                            </a>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t-light">
            <span className="text-sm text-muted">
              {filteredItems.length.toLocaleString()} tweets{highReachOnly ? ' (high-reach only)' : ''} · Page {page} of {totalPages}
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
