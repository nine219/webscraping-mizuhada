'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchInfluencers, fetchBrands, Influencer, DateRange } from '@/lib/api';
import { AmbassadorBadge, OutlierFlag } from '@/components/badges';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';

const EXPORT_COLUMNS: CsvColumn<Influencer>[] = [
  { header: 'handle', value: (r) => r.handle },
  { header: 'is_ambassador', value: (r) => r.is_ambassador ? 'yes' : 'no' },
  { header: 'tier', value: (r) => r.tier },
  { header: 'followers', value: (r) => r.followers ?? '' },
  { header: 'engagement_pct', value: (r) => r.avg_engagement_pct },
  { header: 'engagement_outlier', value: (r) => r.engagement_outlier ? 'yes' : 'no' },
  { header: 'mentions', value: (r) => r.posts },
  { header: 'posts_last_30d', value: (r) => r.posts_last_30d },
  { header: 'total_views', value: (r) => r.total_views },
  { header: 'brands', value: (r) => r.brands.join('; ') },
  { header: 'sentiment_label', value: (r) => r.sentiment?.label ?? '' },
  { header: 'sentiment_positive_pct', value: (r) => r.sentiment?.positivePct ?? '' },
  { header: 'url', value: (r) => r.url },
];

// Influencer reach is a long-horizon signal — wider presets than the other
// tabs' 1/7/14/30d default.
const RANGE_PRESETS = [
  { key: 'd7',   label: '7D',   days: 7 },
  { key: 'd30',  label: '30D',  days: 30 },
  { key: 'd90',  label: '90D',  days: 90 },
  { key: 'd180', label: '180D', days: 180 },
  { key: 'd365', label: '1Y',   days: 365 },
];
// Raw sort options only — no composite "Sponsor Score" per SCOPE v3.
const SORT_OPTIONS = [
  { value: 'posts',      label: 'Mentions' },
  { value: 'engagement', label: 'Engagement %' },
  { value: 'followers',  label: 'Followers' },
  { value: 'views',      label: 'Total Views' },
];

// Reach tiers from follower count — colour-coded so "mega but low engagement" reads at a glance.
const TIER_META: Record<string, { label: string; color: string; bg: string }> = {
  nano:    { label: 'Nano',    color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
  micro:   { label: 'Micro',   color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  mid:     { label: 'Mid',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  macro:   { label: 'Macro',   color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  mega:    { label: 'Mega',    color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  unknown: { label: 'Unknown', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

function fmt(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function engColor(v: number): string {
  if (v > 6) return 'var(--accent-success)';
  if (v >= 2) return 'var(--accent-warning)';
  return 'var(--text-muted)';
}

const SENTIMENT_META: Record<string, { label: string; color: string; bg: string }> = {
  positive: { label: 'Positive', color: 'var(--accent-success)', bg: 'var(--accent-success-subtle)' },
  negative: { label: 'Negative', color: 'var(--accent-danger)',  bg: 'var(--accent-danger-subtle)' },
  mixed:    { label: 'Mixed',    color: 'var(--accent-warning)', bg: 'var(--accent-warning-subtle)' },
  unknown:  { label: '—',        color: 'var(--text-muted)',     bg: 'transparent' },
};

const PER_PAGE = 50;

export default function TikTokInfluencersTab() {
  const router = useRouter();
  const [rows, setRows] = useState<Influencer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [brandFilter, setBrandFilter] = useState('');
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [sort, setSort] = useState('posts');
  const [tier, setTier] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);

  useEffect(() => {
    fetchBrands()
      .then((b) => setBrandOptions(b.filter((x) => x.type === 'own').map((x) => ({ slug: x.slug, name: x.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setPage(1);
  }, [brandFilter, range, sort, tier, search]);

  const [tierCounts, setTierCounts] = useState<Record<string, number>>({});
  const [headline, setHeadline] = useState<{ mostMentions: any; mostViews: any; multiBrandCount: number }>({ mostMentions: null, mostViews: null, multiBrandCount: 0 });

  // Fetches the FULL filtered set (backend caps perPage at 200, so loop pages)
  // so column-header sort sorts every matching creator — pagination below is
  // a client-side slice. tierCounts/headline are computed backend-side over
  // the full pre-pagination set regardless of which page we ask for, so the
  // first page's response already carries the right values.
  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const first = await fetchInfluencers({ brand: brandFilter || undefined, ...range, sort, search: search || undefined, tier: tier || undefined, page: 1, perPage: 200 });
        const all = [...first.influencers];
        const pages = Math.ceil(first.total / 200);
        for (let p = 2; p <= pages; p++) {
          const next = await fetchInfluencers({ brand: brandFilter || undefined, ...range, sort, search: search || undefined, tier: tier || undefined, page: p, perPage: 200 });
          all.push(...next.influencers);
        }
        setRows(all);
        setTotal(first.total);
        setTierCounts(first.tierCounts);
        setHeadline(first.headline);
      } catch {
        setRows([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [brandFilter, range, sort, tier, search]);

  // Client-side sort of the FULL filtered set — independent of the server-side
  // "Sort:" dropdown above, which only controls initial order before any
  // column header is clicked.
  const { sorted: sortedRows, sortKey, sortDir, requestSort } = useClientSort<Influencer>(rows, {
    creator: (r) => r.handle,
    tier: (r) => r.tier,
    followers: (r) => r.followers ?? 0,
    engagement: (r) => r.avg_engagement_pct ?? 0,
    mentions: (r) => r.posts ?? 0,
    last30d: (r) => r.posts_last_30d ?? 0,
    views: (r) => r.total_views ?? 0,
    brands: (r) => r.brands.join(', '),
    // % positive of (positive+negative) comments — unscored creators sort last.
    sentiment: (r) => r.sentiment?.positivePct ?? -1,
  });

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PER_PAGE));
  const pageRows = sortedRows.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton fetchAll={() => Promise.resolve(sortedRows)} columns={EXPORT_COLUMNS} filename={() => `tiktok-influencers-${brandFilter || 'all'}.csv`} />
      </div>

      {/* Headline cards — overall stats from filtered dataset (ignores tier + page) */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="card p-5">
          <div className="stat-label mb-2">Most Mentions</div>
          {headline.mostMentions ? (
            <>
              <button
                onClick={() => router.push(`/tiktok/creator/${encodeURIComponent(headline.mostMentions!.handle)}`)}
                className="stat-value hover:underline"
                style={{ color: 'var(--accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
              >
                @{headline.mostMentions.handle}
              </button>
              <div className="text-xs mt-1 text-muted">
                {headline.mostMentions.posts} mentions · {fmt(headline.mostMentions.followers)} followers · {headline.mostMentions.avg_engagement_pct}% eng
              </div>
            </>
          ) : <div className="stat-value">—</div>}
        </div>
        <div className="card p-5">
          <div className="stat-label mb-2">Most Views</div>
          {headline.mostViews ? (
            <>
              <button
                onClick={() => router.push(`/tiktok/creator/${encodeURIComponent(headline.mostViews!.handle)}`)}
                className="stat-value hover:underline"
                style={{ color: 'var(--accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
              >
                @{headline.mostViews.handle}
              </button>
              <div className="text-xs mt-1 text-muted">
                {fmt(headline.mostViews.total_views)} views · {headline.mostViews.posts} mentions · {fmt(headline.mostViews.followers)} followers
              </div>
            </>
          ) : <div className="stat-value">—</div>}
        </div>
        <div className="card p-5">
          <div className="stat-label mb-2">Multi-Brand Mentioners</div>
          <div className="stat-value" style={{ color: 'var(--accent-success)' }}>
            {headline.multiBrandCount}
          </div>
          <div className="text-xs mt-1 text-muted">
            creators who mention 2+ own brands
          </div>
        </div>
        <div className="card p-5">
          <div className="stat-label mb-2">Total Creators</div>
          <div className="stat-value" style={{ color: 'var(--accent-primary)' }}>{total}</div>
          <div className="text-xs mt-1 text-muted">
            page {page} of {totalPages}
          </div>
        </div>
      </div>

      {/* Search bar + Filters */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        {/* min/max-width inline, not min-w-[..]/max-w-sm — globals.css's
            .flex > * { min-width: 0 } outranks those utility classes at
            equal specificity (later in the stylesheet), which silently let
            this shrink to a sliver on narrow viewports. */}
        <div className="relative flex-1" style={{ minWidth: 200, maxWidth: 384 }}>
          <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text" placeholder="Search by creator name..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchInput); }}
            className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)', color: 'var(--text-primary)' }}
          />
        </div>
        <DateRangePicker value={range} onChange={setRange} presets={RANGE_PRESETS} />
        <div className="flex items-center gap-1">
          <span className="text-xs mr-1 text-muted">Sort:</span>
          <FilterPills options={SORT_OPTIONS} value={sort} onChange={setSort} />
        </div>
        <FilterPills
          className="flex items-center gap-1.5 flex-wrap"
          options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
          value={brandFilter}
          onChange={setBrandFilter}
        />
      </div>

      {/* Tier filter pills */}
      <FilterPills
        className="flex gap-2 flex-wrap mb-5"
        options={[
          { value: '', label: 'All Tiers' },
          ...Object.entries(TIER_META).map(([k, m]) => ({ value: k, label: `${m.label} (${tierCounts[k] ?? 0})` })),
        ]}
        value={tier}
        onChange={setTier}
      />

      <div className="card p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-3xl mb-2">🧑‍🎤</div>
            <p className="text-sm text-muted">No creators found for this filter.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)' }} className="text-xs text-left">
                <th className="px-4 py-3 font-medium">#</th>
                <SortableTh label="Creator" sortKey="creator" activeKey={sortKey} dir={sortDir} onSort={requestSort} style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Tier" sortKey="tier" activeKey={sortKey} dir={sortDir} onSort={requestSort} style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Followers" sortKey="followers" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Eng %" sortKey="engagement" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Sentiment" sortKey="sentiment" activeKey={sortKey} dir={sortDir} onSort={requestSort} style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Mentions" sortKey="mentions" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Posts (30d)" sortKey="last30d" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Total Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" style={{ padding: '12px 16px', fontWeight: 500 }} />
                <SortableTh label="Brands" sortKey="brands" activeKey={sortKey} dir={sortDir} onSort={requestSort} style={{ padding: '12px 16px', fontWeight: 500 }} />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => {
                const t = TIER_META[r.tier] ?? TIER_META.unknown;
                return (
                  <tr key={r.handle} style={{ borderBottom: '1px solid var(--border-light)', cursor: 'pointer' }}
                    className="hover:bg-[var(--bg-base)]"
                    onClick={() => router.push(`/tiktok/creator/${encodeURIComponent(r.handle)}`)}>
                    <td className="px-4 py-3 text-muted">{(page - 1) * PER_PAGE + i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); router.push(`/tiktok/creator/${encodeURIComponent(r.handle)}`); }}
                          className="font-semibold hover:underline"
                          style={{ color: 'var(--accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >
                          @{r.handle}
                        </button>
                        <AmbassadorBadge active={r.is_ambassador} />
                        <OutlierFlag active={r.engagement_outlier} />
                        {r.url && (
                          <a
                            href={r.url} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs" style={{ color: 'var(--text-muted)' }}
                            title="Open TikTok profile"
                          >
                            ↗
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ color: t.color, background: t.bg }}>
                        {t.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-secondary">{fmt(r.followers)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold" style={{ color: engColor(r.avg_engagement_pct) }}>{r.avg_engagement_pct}%</td>
                    <td className="px-4 py-3">
                      {(() => {
                        const sm = SENTIMENT_META[r.sentiment?.label ?? 'unknown'];
                        const n = r.sentiment ? r.sentiment.positive + r.sentiment.negative + r.sentiment.neutral : 0;
                        const pct = r.sentiment?.positivePct;
                        const label = pct != null && (r.sentiment.label === 'positive' || r.sentiment.label === 'negative')
                          ? `${pct}% ${sm.label}`
                          : sm.label;
                        return (
                          <span
                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                            style={{ color: sm.color, background: sm.bg }}
                            title={n > 0 ? `${r.sentiment.positive} positive · ${r.sentiment.negative} negative · ${r.sentiment.neutral} neutral` : 'No classified comments yet'}
                          >
                            {label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-secondary">{r.posts}</td>
                    <td className="px-4 py-3 text-right font-mono text-secondary">{r.posts_last_30d}</td>
                    <td className="px-4 py-3 text-right font-mono text-secondary">{fmt(r.total_views)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 flex-wrap">
                        {r.brands.map((b) => <span key={b} className="tag tag-purple text-[10px]">{b}</span>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 px-1">
          <span className="text-xs text-muted">{total} creators total</span>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-30 hover:opacity-80 transition-opacity"
              style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}
            >
              ← Prev
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let p: number;
              if (totalPages <= 7) {
                p = i + 1;
              } else if (page <= 4) {
                p = i + 1;
              } else if (page >= totalPages - 3) {
                p = totalPages - 6 + i;
              } else {
                p = page - 3 + i;
              }
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium transition-opacity"
                  style={{
                    background: p === page ? 'var(--accent-primary)' : 'var(--bg-base)',
                    color: p === page ? '#fff' : 'var(--text-secondary)',
                    border: '1px solid var(--border-light)',
                  }}
                >
                  {p}
                </button>
              );
            })}
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-30 hover:opacity-80 transition-opacity"
              style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      <p className="text-xs mt-3 text-muted">
        Raw data only — no composite ranking. Engagement % is view-based.
        Reach tiers (by follower count): Nano &lt;10K · Micro &lt;100K · Mid &lt;500K · Macro &lt;1M · Mega ≥1M.
        ★ Ambassador = already an ambassador/creator we work with (shown, not excluded).
        ⚠ = engagement over 5× the group median — a soft flag to verify manually, not a filter.
      </p>
    </div>
  );
}
