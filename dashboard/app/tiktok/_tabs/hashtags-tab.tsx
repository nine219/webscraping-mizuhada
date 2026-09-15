'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  fetchTikTokHashtags,
  fetchTikTokTrendingHashtags,
  TikTokHashtag,
  TikTokTrendingHashtag,
  TikTokBrandHashtag,
  DateRange,
} from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import { FilterPills } from '@/components/filter-pills';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';

const EXPORT_COLUMNS: CsvColumn<TikTokHashtag>[] = [
  { header: 'hashtag', value: (h) => h.hashtag },
  { header: 'count', value: (h) => h.count },
  { header: 'brand_slug', value: (h) => h.brand_slug ?? '' },
];

function rangeLabel(r: DateRange): string {
  return r.from && r.to ? `${r.from} to ${r.to}` : `last ${r.days ?? 7}d`;
}

function fmtViews(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export default function TikTokHashtagsTab() {
  const router = useRouter();
  const [hashtags, setHashtags] = useState<TikTokHashtag[]>([]);
  const [trending, setTrending] = useState<TikTokTrendingHashtag[]>([]);
  const [brandHashtags, setBrandHashtags] = useState<TikTokBrandHashtag[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [brandFilter, setBrandFilter] = useState('');
  // Backend filters by slug (b.slug = $1) — option value must be the slug,
  // not the display name, or the filter silently matches nothing.
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);

  useEffect(() => {
    fetchTikTokTrendingHashtags()
      .then((res) => {
        setTrending(res.trending);
        setBrandHashtags(res.brand_hashtags);
        const bySlug = new Map(res.brand_hashtags.map((b) => [b.brand_slug, b.brand_name]));
        const unique = Array.from(bySlug, ([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name));
        if (unique.length > 0) setBrandOptions(unique);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchTikTokHashtags({ ...range, brand: brandFilter || undefined })
      .then((hashtagsRes) => {
        setHashtags(hashtagsRes.data);
      })
      .catch(() => {
        setHashtags([]);
      })
      .finally(() => setLoading(false));
  }, [range, brandFilter]);

  function handleRangeChange(v: DateRange) { setRange(v); }
  function handleBrandChange(v: string) { setBrandFilter(v); }

  const top20 = hashtags.slice(0, 20);
  const maxCount = Math.max(...top20.map((h) => h.count), 1);

  // Client-side re-sort of the full hashtags table.
  const { sorted: sortedHashtags, sortKey, sortDir, requestSort } = useClientSort<TikTokHashtag>(hashtags, {
    hashtag: (h) => h.hashtag,
    count: (h) => h.count,
    brand: (h) => h.brand_slug ?? '',
  });

  // Top brand hashtags grouped by brand for Trending Now section
  const topBrandTags = brandHashtags.slice(0, 20);
  const maxBrandCount = Math.max(...topBrandTags.map((h) => h.count), 1);

  const totalMentions = hashtags.reduce((s, h) => s + h.count, 0);
  const topHashtag = hashtags[0] ?? null;

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ExportCsvButton
          fetchAll={() => Promise.resolve(hashtags)}
          columns={EXPORT_COLUMNS}
          filename={() => `tiktok-hashtags-${brandFilter || 'all'}.csv`}
          disabled={hashtags.length === 0}
        />
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Unique Hashtags', value: hashtags.length.toLocaleString(), sub: rangeLabel(range), color: 'var(--accent-primary)' },
          { label: 'Total Mentions',  value: totalMentions.toLocaleString(),   sub: 'across all hashtags', color: 'var(--text-primary)' },
          { label: 'Top Hashtag',     value: topHashtag ? `#${topHashtag.hashtag}` : '—', sub: topHashtag ? `${topHashtag.count.toLocaleString()} mentions` : 'no data', color: 'var(--accent-success)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color, fontSize: s.label === 'Top Hashtag' ? 20 : undefined }}>{s.value}</div>
            <div className="text-xs mt-1 text-muted">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Trending Now section */}
      {(trending.length > 0 || brandHashtags.length > 0) && (
        <div className="grid grid-cols-2 gap-5 mb-6">
          {/* TikTok trending (from explore scrape) */}
          {trending.length > 0 && (
            <div className="card p-6">
              <div className="section-title mb-1">Trending Now on TikTok</div>
              <div className="section-subtitle mb-4">From TikTok Explore — last scraped run</div>
              <div className="space-y-2">
                {trending.slice(0, 15).map((h, i) => (
                  <div key={h.hashtag} className="flex items-center gap-3">
                    <span
                      className="font-mono text-xs w-5 text-right flex-shrink-0 text-muted"
                    >
                      {i + 1}
                    </span>
                    <a
                      href={`https://www.tiktok.com/tag/${h.hashtag}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 text-sm font-medium truncate"
                      style={{ color: 'var(--accent-info)', textDecoration: 'none' }}
                    >
                      #{h.hashtag}
                    </a>
                    <span className="text-xs font-mono flex-shrink-0 text-muted">
                      {h.view_count !== null ? fmtViews(h.view_count) + ' views' : h.post_count !== null ? h.post_count + ' posts' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Brand hashtags (from DB aggregation) — commented out, kept for reference */}
          {/* {topBrandTags.length > 0 && (
            <div className="card p-6">
              <div className="section-title mb-1">Brand Hashtag Activity</div>
              <div className="section-subtitle mb-4">Aggregated from posts (last 30 days)</div>
              <div className="space-y-2.5">
                {topBrandTags.map((h) => (
                  <div key={`${h.brand_slug}-${h.hashtag}`} className="flex items-center gap-3">
                    <span className="text-sm flex-1 truncate font-medium" style={{ color: 'var(--accent-info)' }}>
                      #{h.hashtag}
                    </span>
                    <div className="flex-shrink-0" style={{ width: 100 }}>
                      <div className="h-1.5 rounded-full overflow-hidden bg-base">
                        <div className="h-full rounded-full" style={{ width: `${(h.count / maxBrandCount) * 100}%`, background: 'var(--accent-primary)' }} />
                      </div>
                    </div>
                    <span className="text-xs font-mono font-semibold flex-shrink-0" style={{ color: 'var(--text-secondary)', width: 32, textAlign: 'right' }}>
                      {h.count}
                    </span>
                    <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)', width: 80, textAlign: 'right' }}>
                      {h.brand_name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )} */}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap mb-6">
        <DateRangePicker value={range} onChange={handleRangeChange} />
        <FilterPills
          className="flex items-center gap-1.5 flex-wrap"
          options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
          value={brandFilter}
          onChange={handleBrandChange}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div
            className="w-6 h-6 border-2 rounded-full animate-spin"
            style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }}
          />
        </div>
      ) : hashtags.length === 0 ? (
        <div className="card text-center py-16">
          <div className="text-4xl mb-3">#️⃣</div>
          <p className="font-medium mb-1 text-primary">
            No hashtag data yet
          </p>
          <p className="text-sm text-muted">
            Run: npm run scrape:tiktok
          </p>
        </div>
      ) : (
        <>
          {/* Inline CSS horizontal bar chart — no Chart.js */}
          <div className="card p-6 mb-6">
            <div className="section-title mb-4">Top 20 Hashtags ({rangeLabel(range)})</div>
            <div className="space-y-2">
              {top20.map((h) => (
                <div key={h.hashtag} className="flex items-center gap-3">
                  <span
                    className="text-sm font-medium flex-shrink-0"
                    style={{ color: 'var(--accent-info)', width: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={`#${h.hashtag}`}
                  >
                    #{h.hashtag}
                  </span>
                  <div className="flex-1 h-4 rounded overflow-hidden bg-base">
                    <div
                      className="h-full rounded transition-all"
                      style={{
                        width: `${(h.count / maxCount) * 100}%`,
                        background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-primary-light, #818cf8))',
                      }}
                    />
                  </div>
                  <span
                    className="font-mono text-xs font-semibold flex-shrink-0"
                    style={{ color: 'var(--text-secondary)', width: 40, textAlign: 'right' }}
                  >
                    {h.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Full table */}
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b-light">
              <div className="section-title" style={{ fontSize: 16 }}>
                All Hashtags
                <span
                  className="ml-2 text-sm font-normal text-muted"
                >
                  ({hashtags.length} total)
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <SortableTh label="Hashtag" sortKey="hashtag" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                    <SortableTh label="Count" sortKey="count" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                    {!brandFilter && <SortableTh label="Brand" sortKey="brand" activeKey={sortKey} dir={sortDir} onSort={requestSort} />}
                  </tr>
                </thead>
                <tbody>
                  {sortedHashtags.map((h, i) => (
                    <tr key={h.hashtag}>
                      <td style={{ color: 'var(--text-muted)', width: 48 }}>{i + 1}</td>
                      <td>
                        {/* This table is our own scraped/brand-scoped counts —
                            drill into the actual posts behind it in-app
                            instead of TikTok's public, unfiltered hashtag
                            page (which also isn't brand-scoped at all). */}
                        <button
                          onClick={() => router.push(`/tiktok?tab=search&q=${encodeURIComponent(h.hashtag)}`)}
                          className="font-medium"
                          style={{ color: 'var(--accent-info)' }}
                          title="View posts using this hashtag"
                        >
                          #{h.hashtag}
                        </button>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="font-mono font-semibold text-primary">
                          {h.count.toLocaleString()}
                        </span>
                      </td>
                      {!brandFilter && (
                        <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {h.brand_slug ?? '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
