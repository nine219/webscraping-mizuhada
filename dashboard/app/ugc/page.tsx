'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchTopUgc, fetchBrands, UgcPost, Brand, UgcThemeStat, UgcResponse, DateRange } from '@/lib/api';
import UgcCard, { getThemeColor } from '@/components/ugc-card';
import UgcListItem from '@/components/ugc-list-item';
import { DateRangePicker } from '@/components/date-range-picker';
import { FilterPills } from '@/components/filter-pills';
import { SearchInput } from '@/components/search-input';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';

// 24, not the 25 every other list page uses — this page renders a 4-column
// grid (see grid-cols-4 below), and 24 is a multiple of 4 so the last page
// doesn't end mid-row. Kept intentionally different; documenting why so it
// doesn't get "fixed" into inconsistency with itself later.
const PAGE_LIMIT = 24;

const EXPORT_COLUMNS: CsvColumn<UgcPost>[] = [
  { header: 'brand', value: (p) => p.brand_name },
  { header: 'author_handle', value: (p) => p.author_handle ?? '' },
  { header: 'theme', value: (p) => p.theme },
  { header: 'caption', value: (p) => p.caption ?? '' },
  { header: 'views', value: (p) => p.views },
  { header: 'likes', value: (p) => p.likes },
  { header: 'shares', value: (p) => p.shares },
  { header: 'comments', value: (p) => p.comments_count },
  { header: 'engagement_pct', value: (p) => p.engagement_rate },
  { header: 'positive_pct', value: (p) => p.sentiment.positive_pct },
  { header: 'negative_pct', value: (p) => p.sentiment.negative_pct },
  { header: 'posted_at', value: (p) => p.posted_at ?? '' },
  { header: 'post_url', value: (p) => p.post_url ?? '' },
];

function rangeLabel(r: DateRange): string {
  return r.from && r.to ? `${r.from}–${r.to}` : `${r.days ?? 7}d`;
}

const SORTS = [
  { key: 'engagement', label: 'Engagement' },
  { key: 'views', label: 'Views' },
  { key: 'likes', label: 'Likes' },
  { key: 'recent', label: 'Most Recent' },
];

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function SentimentBar({ post }: { post: UgcPost }) {
  const s = post.sentiment;
  const classified = s.positive + s.negative + s.neutral;
  if (classified === 0) return <span className="text-[10px] text-muted">n/a</span>;
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 rounded-full overflow-hidden flex bg-base">
        <div style={{ width: `${s.positive_pct}%`, background: 'var(--sentiment-positive)' }} />
        <div style={{ width: `${s.neutral_pct}%`, background: 'var(--sentiment-neutral)' }} />
        <div style={{ width: `${s.negative_pct}%`, background: 'var(--sentiment-negative)' }} />
      </div>
      <span className="text-[10px] font-medium" style={{ color: 'var(--sentiment-positive)' }}>{s.positive_pct}%</span>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
  color = 'var(--accent-primary)',
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color?: string;
  /** When set, the sub-label becomes a link to the source post/profile for verification. */
  href?: string | null;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="stat-value" style={{ color }}>{value}</div>
      {sub && (
        href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs mt-1 block hover:underline" style={{ color: 'var(--accent-primary)' }}>
            {sub} ↗
          </a>
        ) : (
          <div className="text-xs mt-1 text-muted">{sub}</div>
        )
      )}
    </div>
  );
}

function ContentThemes({ themes, total }: { themes: UgcThemeStat[]; total: number }) {
  return (
    <div className="card p-6">
      <div className="section-title mb-1">Content Themes</div>
      <div className="section-subtitle mb-4">What type of content performs best</div>
      <div className="space-y-3">
        {themes.length === 0 && (
          <div className="text-sm text-muted">No themes classified yet.</div>
        )}
        {themes.map((t) => {
          const pct = total > 0 ? (t.post_count / total) * 100 : 0;
          // Bar width matches the displayed percentage (share of total) — it
          // must NOT be relative to the top theme's count, or a theme at say
          // 67% of total renders as a near-full bar just because it's close
          // to whichever theme happens to be the max.
          const barWidth = pct;
          return (
            <div key={t.theme} className="flex items-center gap-3">
              <div className="w-32 text-sm truncate text-secondary">{t.theme}</div>
              <div className="flex-1 h-2 rounded-full overflow-hidden bg-base">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(barWidth, 4)}%`, background: getThemeColor(t.theme) }}
                />
              </div>
              <div className="w-20 text-right">
                <div className="text-xs font-semibold text-primary">{pct.toFixed(1)}%</div>
                <div className="text-[10px] text-muted">{t.post_count} posts</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopHashtags({ posts }: { posts: UgcPost[] }) {
  const hashtags = useMemo(() => {
    const map = new Map<string, { count: number; views: number; engagement: number }>();
    for (const p of posts) {
      for (const h of p.hashtags ?? []) {
        const tag = h.startsWith('#') ? h : `#${h}`;
        const cur = map.get(tag) ?? { count: 0, views: 0, engagement: 0 };
        cur.count += 1;
        cur.views += p.views;
        cur.engagement += p.engagement_rate;
        map.set(tag, cur);
      }
    }
    return Array.from(map.entries())
      .map(([hashtag, { count, views, engagement }]) => ({
        hashtag,
        count,
        views,
        avgEngagement: count > 0 ? engagement / count : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [posts]);

  return (
    <div className="card p-6">
      <div className="section-title mb-1">Top Hashtags</div>
      <div className="section-subtitle mb-4">Hashtag performance by engagement</div>
      <div className="space-y-3">
        {hashtags.length === 0 && (
          <div className="text-sm text-muted">No hashtags found.</div>
        )}
        {hashtags.map((h) => (
          <div key={h.hashtag} className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm font-medium truncate" style={{ color: 'var(--accent-info)' }}>{h.hashtag}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                {h.count} posts
              </span>
            </div>
            <div className="text-xs font-mono text-secondary">
              {h.avgEngagement.toFixed(1)}% eng
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UgcPerformancePage() {
  const router = useRouter();
  const [posts, setPosts] = useState<UgcPost[]>([]);
  const [themes, setThemes] = useState<UgcThemeStat[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [brands, setBrands] = useState<Brand[]>([]);
  const [brand, setBrand] = useState('');
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [sort, setSort] = useState('engagement');
  const [search, setSearch] = useState('');
  const [spikeOnly, setSpikeOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [stats, setStats] = useState<UgcResponse['stats'] | null>(null);
  const [topPost, setTopPost] = useState<UgcPost | null>(null);

  useEffect(() => { fetchBrands().then((b) => setBrands(b.filter((x) => x.type === 'own'))).catch(() => {}); }, []);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    fetchTopUgc({ ...range, brand: brand || undefined, sort, search: debouncedSearch || undefined, page, limit: PAGE_LIMIT, spike: spikeOnly || undefined })
      .then((r) => {
        setPosts(r.data);
        setTotal(r.total);
        setThemes(r.themes);
        setStats(r.stats);
        setTopPost(r.top_post);
      })
      .catch(() => {
        setPosts([]);
        setTotal(0);
        setThemes([]);
        setStats(null);
        setTopPost(null);
      })
      .finally(() => setLoading(false));
  }, [range, brand, sort, debouncedSearch, page, spikeOnly]);

  const ownBrands = brands.filter((b) => b.type === 'own');

  const totalPosts = total;
  const avgEng = stats?.avg_engagement ?? 0;
  const positivePct = stats?.sentiment.positive_pct ?? 0;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">UGC Performance</h1>
          <p className="page-header-subtitle">Track user-generated content and engagement across platforms</p>
        </div>
        <div className="flex items-center gap-3">
          <ExportCsvButton
            fetchAll={() => fetchTopUgc({ ...range, brand: brand || undefined, sort, search: debouncedSearch || undefined, limit: 100_000, spike: spikeOnly || undefined }).then((r) => r.data)}
            columns={EXPORT_COLUMNS}
            filename={() => `ugc-${brand || 'all'}.csv`}
          />
          <DateRangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} />
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Total UGC Posts"
          value={totalPosts.toLocaleString()}
          sub={`${rangeLabel(range)} period`}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="8" y1="12" x2="16" y2="12" />
              <line x1="12" y1="8" x2="12" y2="16" />
            </svg>
          }
          color="var(--accent-primary)"
        />
        <StatCard
          label="Avg Engagement"
          value={`${avgEng.toFixed(1)}%`}
          sub={`across ${totalPosts.toLocaleString()} posts, ${rangeLabel(range)}`}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22,7 13.5,15.5 8.5,10.5 2,17" />
              <polyline points="16,7 22,7 22,13" />
            </svg>
          }
          color="var(--text-primary)"
        />
        <StatCard
          label="Top Performing Post"
          value={topPost ? `${topPost.engagement_rate.toFixed(0)}%` : '—'}
          sub={topPost ? `${topPost.spike_flag ? '⚡ Spiking · ' : ''}@${topPost.author_handle ?? 'unknown'}` : 'No posts'}
          href={topPost?.post_url}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
            </svg>
          }
          color="var(--accent-warning)"
        />
        <StatCard
          label="UGC Sentiment"
          value={`${positivePct}%`}
          sub="Positive"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          }
          color="var(--sentiment-positive)"
        />
      </div>

      {/* Themes + Hashtags */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <ContentThemes themes={themes} total={totalPosts} />
        <TopHashtags posts={posts} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search themes, captions, comments, creator, or TikTok link..."
          minWidth={240}
          maxWidth={480}
        />

        <button
          onClick={() => { setSpikeOnly((v) => !v); setPage(1); }}
          className="btn btn-sm"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: spikeOnly ? 'var(--accent-warning)' : undefined,
            borderColor: spikeOnly ? 'var(--accent-warning)' : undefined,
          }}
          title="Show only posts that are currently spiking"
        >
          ⚡ Spikes only
        </button>

        {/* Pills — matching the brand/sort filter widget used on every other
            list page (TikTok/XHS/Instagram/X); this and Social Listening
            were the only two still using a <select>. */}
        <FilterPills
          options={[
            { value: '', label: 'All Brands' },
            ...ownBrands.slice().sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ value: b.slug, label: b.name })),
          ]}
          value={brand}
          onChange={(v) => { setBrand(v); setPage(1); }}
        />

        <FilterPills
          options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
          value={sort}
          onChange={(v) => { setSort(v); setPage(1); }}
        />

        <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}>
          <button
            onClick={() => setViewMode('grid')}
            className="p-1.5 rounded-md transition-colors"
            style={{
              color: viewMode === 'grid' ? 'var(--accent-primary)' : 'var(--text-muted)',
              background: viewMode === 'grid' ? 'var(--bg-surface)' : 'transparent',
              boxShadow: viewMode === 'grid' ? 'var(--shadow-sm)' : 'none',
            }}
            title="Grid view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
          <button
            onClick={() => setViewMode('list')}
            className="p-1.5 rounded-md transition-colors"
            style={{
              color: viewMode === 'list' ? 'var(--accent-primary)' : 'var(--text-muted)',
              background: viewMode === 'list' ? 'var(--bg-surface)' : 'transparent',
              boxShadow: viewMode === 'list' ? 'var(--shadow-sm)' : 'none',
            }}
            title="List view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
        </div>
      ) : posts.length > 0 ? (
        <>
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-4 gap-4">
              {posts.map((p) => <UgcCard key={p.post_id} post={p} />)}
            </div>
          ) : (
            <div className="space-y-3">
              {posts.map((p) => <UgcListItem key={p.post_id} post={p} />)}
            </div>
          )}

          <div className="flex items-center justify-between mt-5">
            <span className="text-sm text-muted">Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </>
      ) : (
        <div className="card p-10 text-center">
          <div className="text-3xl mb-2">📭</div>
          <p className="text-sm text-muted">No UGC posts found for this range.</p>
        </div>
      )}
    </div>
  );
}
