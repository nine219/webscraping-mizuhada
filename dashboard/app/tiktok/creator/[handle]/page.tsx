'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchTikTokCreator, TikTokCreatorDetail } from '@/lib/api';
import { useClientSort } from '@/lib/use-client-sort';
import { SortableTh } from '@/components/sortable-th';
import DailyCountChart from '@/components/charts/daily-count-chart';
import SentimentDonut from '@/components/charts/sentiment-donut';
import { AmbassadorBadge, SpikeBadge } from '@/components/badges';
import { formatEngagement } from '@/lib/format';

const PAGE_SIZE = 20;

const TIER_META: Record<string, { label: string; color: string; bg: string }> = {
  nano:    { label: 'Nano',    color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
  micro:   { label: 'Micro',   color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  mid:     { label: 'Mid',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  macro:   { label: 'Macro',   color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  mega:    { label: 'Mega',    color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  unknown: { label: 'Unknown', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function CreatorDetailPage() {
  const params = useParams<{ handle: string }>();
  const router = useRouter();
  // Strip @ so we can accept /creator/@foo or /creator/foo interchangeably.
  const handle = decodeURIComponent(params.handle ?? '').replace(/^@+/, '');
  const [data, setData] = useState<TikTokCreatorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  // Which sentiment slice of the donut is drilled into, showing its topic
  // breakdown below. Only positive/negative have topic data computed server-side.
  const [topicSentiment, setTopicSentiment] = useState<'positive' | 'negative' | null>(null);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setTopicSentiment(null);
    fetchTikTokCreator(handle)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [handle]);

  // Client-side re-sort of the posts table. Called unconditionally (before
  // any early return) per Rules of Hooks — falls back to [] until data
  // loads. Initial order stays "newest first" (matches the "Sorted newest
  // first" subtitle below) until the user clicks a different column header.
  type CreatorPost = TikTokCreatorDetail['posts'][number];
  const { sorted: sortedPosts, sortKey, sortDir, requestSort } = useClientSort<CreatorPost>(
    data?.posts ?? [],
    {
      brand: (p) => p.brand_name,
      caption: (p) => p.caption ?? '',
      theme: (p) => p.theme ?? '',
      views: (p) => p.views ?? 0,
      likes: (p) => p.likes ?? 0,
      shares: (p) => p.shares ?? 0,
      comments: (p) => p.comments_count ?? 0,
      engagement: (p) => p.engagement_rate ?? 0,
      posted: (p) => p.posted_at ?? '',
      spike: (p) => (p.spike_flag ? 1 : 0),
    },
    'posted',
    'desc',
  );

  // Reset to page 1 whenever the sort changes — stale page numbers into a
  // freshly re-ordered list would show the wrong slice.
  useEffect(() => { setPage(1); }, [sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedPosts.length / PAGE_SIZE));
  const pagedPosts = sortedPosts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Chronological (oldest→newest) regardless of the table's current sort —
  // a trend chart only reads correctly in date order.
  const chronologicalPosts = (data?.posts ?? [])
    .filter((p) => p.posted_at)
    .slice()
    .sort((a, b) => new Date(a.posted_at as string).getTime() - new Date(b.posted_at as string).getTime());
  const viewsOverTime = chronologicalPosts.map((p) => ({ date: p.posted_at as string, count: p.views }));
  // Whether engagement is steady across posts or propped up by one viral
  // outlier — a real signal for sponsorship risk, not a synthesized score.
  const engagementOverTime = chronologicalPosts.map((p) => ({ date: p.posted_at as string, count: Math.round(p.engagement_rate * 100) / 100 }));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center py-20">
        <div className="text-4xl mb-3">🕵️</div>
        <p className="font-medium mb-1 text-primary">Creator not found</p>
        <p className="text-sm mb-4 text-muted">
          @{handle} has no scraped posts mentioning any own brand.
        </p>
        <button className="btn" onClick={() => router.back()}>← Back</button>
      </div>
    );
  }

  const { creator, posts } = data;
  const tier = TIER_META[creator.tier] ?? TIER_META.unknown;

  return (
    <div>
      {/* Header */}
      <div className="page-header">
        <div>
          <button onClick={() => router.back()} className="text-xs mb-1 hover:underline text-muted">
            ← Back
          </button>
          <div className="flex items-center gap-3">
            <h1 className="page-header-title">@{creator.handle}</h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ color: tier.color, background: tier.bg }}>
              {tier.label}
            </span>
            <AmbassadorBadge active={creator.is_ambassador} />
          </div>
          <p className="page-header-subtitle">
            Creator mentioning {creator.brands.length} own brand{creator.brands.length === 1 ? '' : 's'} — {creator.posts} post{creator.posts === 1 ? '' : 's'} tracked
          </p>
        </div>
        <a href={creator.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
          Open on TikTok ↗
        </a>
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-6 gap-4 mb-6">
        {[
          { label: 'Followers',      value: fmt(creator.followers),            sub: tier.label + ' tier',                             color: 'var(--accent-primary)' },
          { label: 'Mentions',       value: creator.posts.toLocaleString(),    sub: 'posts about own brands',                         color: 'var(--text-primary)'   },
          { label: 'Total Views',    value: fmt(creator.total_views),          sub: `avg ${fmt(Math.round(creator.total_views / Math.max(1, creator.posts)))} / post`, color: 'var(--text-primary)' },
          { label: 'Total Likes',    value: fmt(creator.total_likes),          sub: `${fmt(creator.total_comments)} comments`,        color: 'var(--sentiment-positive)' },
          { label: 'Avg Engagement', value: `${creator.avg_engagement_pct}%`,  sub: '(likes+shares+comments)/views',                  color: creator.avg_engagement_pct > 3 ? 'var(--accent-success)' : creator.avg_engagement_pct >= 1 ? 'var(--accent-warning)' : 'var(--text-muted)' },
          {
            label: 'Views / Follower',
            value: creator.followers && creator.followers > 0 ? `${(creator.total_views / creator.followers).toFixed(1)}×` : '—',
            sub: 'reach beyond their own follower base',
            color: 'var(--text-primary)',
          },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
            <div className="text-xs mt-1 text-muted">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Meta row */}
      <div className="card p-4 mb-6 flex flex-wrap items-center gap-6">
        <div>
          <div className="stat-label mb-1">Brands mentioned</div>
          <div className="flex gap-1 flex-wrap">
            {creator.brands.map((b) => (
              <span key={b} className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{ background: 'var(--accent-primary-subtle)', color: 'var(--accent-primary)' }}>
                {b}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="stat-label mb-1">First seen</div>
          <div className="text-sm text-primary">
            {creator.first_seen ? new Date(creator.first_seen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
          </div>
        </div>
        <div>
          <div className="stat-label mb-1">Last seen</div>
          <div className="text-sm text-primary">
            {creator.last_seen ? new Date(creator.last_seen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
          </div>
        </div>
        <div>
          <div className="stat-label mb-1">Posts (last 30d)</div>
          <div className="text-sm text-primary">
            {creator.posts_last_30d} — {creator.posts_last_30d > 0 ? 'posting recently' : 'no recent activity'}
          </div>
        </div>
      </div>

      {/* Sponsorship-decision data: performance trend, consistency, and how people react */}
      <div className="grid gap-5 mb-6 grid-2col" style={{ gridTemplateColumns: '1.2fr 1.2fr 1fr' }}>
        {viewsOverTime.length > 1 && (
          <div className="card p-5">
            <div className="section-title mb-1">Views by Post</div>
            <div className="section-subtitle mb-3">Peaks are this creator's most effective posts</div>
            <div style={{ height: 200 }}>
              <DailyCountChart data={viewsOverTime} label="Views" />
            </div>
          </div>
        )}
        {engagementOverTime.length > 1 && (
          <div className="card p-5">
            <div className="section-title mb-1">Engagement % by Post</div>
            <div className="section-subtitle mb-3">Steady vs. propped up by one viral post</div>
            <div style={{ height: 200 }}>
              <DailyCountChart data={engagementOverTime} label="Engagement %" />
            </div>
          </div>
        )}
        <div className="card p-5">
          <div className="section-title mb-1">Sentiment on Their Posts</div>
          <div className="section-subtitle mb-3">
            Comments under posts mentioning us{creator.sentiment.positive + creator.sentiment.negative > 0 ? ' — click positive/negative to see topics' : ''}
          </div>
          {creator.sentiment.positive + creator.sentiment.negative + creator.sentiment.neutral + creator.sentiment.question > 0 ? (
            <>
              <SentimentDonut
                positive={creator.sentiment.positive} negative={creator.sentiment.negative} neutral={creator.sentiment.neutral}
                onSliceClick={(s) => {
                  if (s === 'neutral') return; // no topic breakdown computed for neutral
                  setTopicSentiment((prev) => (prev === s ? null : s));
                }}
              />
              <div className="flex justify-center gap-3 mt-2 text-xs flex-wrap">
                {([
                  { key: 'positive', label: 'Positive', color: '#10b981', n: creator.sentiment.positive, clickable: true },
                  { key: 'negative', label: 'Negative', color: '#ef4444', n: creator.sentiment.negative, clickable: true },
                  { key: 'neutral', label: 'Neutral', color: '#94a3b8', n: creator.sentiment.neutral, clickable: false },
                  { key: 'question', label: 'Question', color: '#8b5cf6', n: creator.sentiment.question, clickable: false },
                ] as const).map((s) => (
                  <button
                    key={s.label}
                    onClick={() => s.clickable && setTopicSentiment((prev) => (prev === s.key ? null : s.key as 'positive' | 'negative'))}
                    disabled={!s.clickable}
                    className="flex items-center gap-1"
                    style={{
                      color: topicSentiment === s.key ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: topicSentiment === s.key ? 600 : 400,
                      background: 'none', border: 'none', padding: 0,
                      cursor: s.clickable ? 'pointer' : 'default',
                    }}
                  >
                    <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                    {s.label} ({s.n})
                  </button>
                ))}
              </div>
              {topicSentiment && (() => {
                const topics = topicSentiment === 'positive' ? creator.sentiment.positiveTopics : creator.sentiment.negativeTopics;
                const barColor = topicSentiment === 'positive' ? '#10b981' : '#ef4444';
                const max = Math.max(...topics.map((t) => t.count), 1);
                return (
                  <div className="mt-4 pt-4 border-t-light">
                    <div className="text-xs font-semibold mb-2 text-primary">
                      Topics — {topicSentiment === 'positive' ? 'Positive' : 'Negative'} comments
                    </div>
                    {topics.length === 0 ? (
                      <div className="text-xs text-muted">No topic-classified {topicSentiment} comments.</div>
                    ) : (
                      <div className="space-y-2">
                        {topics.slice(0, 8).map((t) => (
                          <div key={t.topic}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs text-secondary">{t.topic}</span>
                              <span className="font-mono text-xs text-muted">{t.count}</span>
                            </div>
                            <div className="h-1.5 rounded-full overflow-hidden bg-base">
                              <div className="h-full" style={{ width: `${(t.count / max) * 100}%`, background: barColor }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </>
          ) : (
            <div className="text-center py-10 text-sm text-muted">No classified comments yet.</div>
          )}
        </div>
      </div>

      {/* Posts table */}
      <div className="card overflow-hidden">
        <div className="p-5 border-b-light">
          <div className="section-title">Posts mentioning our brands ({posts.length})</div>
          <div className="section-subtitle">Sorted newest first</div>
        </div>
        {posts.length === 0 ? (
          <div className="text-center py-16 text-sm text-muted">No posts.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh label="Brand" sortKey="brand" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Caption" sortKey="caption" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Theme" sortKey="theme" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Views" sortKey="views" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Shares" sortKey="shares" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Comments" sortKey="comments" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Engagement %" sortKey="engagement" activeKey={sortKey} dir={sortDir} onSort={requestSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <SortableTh label="Spike" sortKey="spike" activeKey={sortKey} dir={sortDir} onSort={requestSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pagedPosts.map((p) => {
                  const eng = formatEngagement(p.engagement_rate);
                  return (
                    <tr
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/tiktok/${p.post_id}`)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td className="brand-cell">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ background: 'var(--accent-primary-subtle)', color: 'var(--accent-primary)' }}>
                          {p.brand_name}
                        </span>
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        <span title={p.caption ?? ''} className="text-secondary">
                          {p.caption ? p.caption.slice(0, 55) + (p.caption.length > 55 ? '…' : '') : '—'}
                        </span>
                      </td>
                      <td style={{ fontSize: 11 }}>
                        {p.theme ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                            {p.theme}
                          </span>
                        ) : <span className="text-muted">—</span>}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>{p.views.toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{p.likes.toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{p.shares.toLocaleString()}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{p.comments_count.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="font-mono text-xs font-semibold" style={{ color: eng.color }}>{eng.text}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        {p.spike_flag ? <SpikeBadge active={p.spike_flag} /> : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td>
                        <a href={p.post_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
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
        {posts.length > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t-light">
            <span className="text-sm text-muted">
              {sortedPosts.length.toLocaleString()} posts · Page {page} of {totalPages}
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
