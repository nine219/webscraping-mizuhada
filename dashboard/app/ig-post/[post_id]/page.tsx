'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchInstagramPost, triggerInstagramPostCommentScrape, InstagramPostDetail } from '@/lib/api';

const SENTIMENT_CONFIG = {
  positive:   { color: '#10b981', bg: 'rgba(16,185,129,0.12)', label: 'Positive' },
  negative:   { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  label: 'Negative' },
  neutral:    { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', label: 'Neutral' },
  question:   { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', label: 'Question' },
  unanalyzed: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  label: 'Unanalyzed' },
};

const MEDIA_BADGE: Record<string, { label: string; color: string }> = {
  reel:     { label: 'Reel',     color: '#8b5cf6' },
  video:    { label: 'Video',    color: '#6366f1' },
  carousel: { label: 'Carousel', color: '#0ea5e9' },
  image:    { label: 'Image',    color: '#64748b' },
};

// Same format as /social's displayContent() — content_translated is only
// ever populated when the sentiment classifier decided the comment wasn't
// Thai/English, so its mere presence means "show it".
function displayContent(c: { content: string; content_translated: string | null }) {
  const th = c.content_translated?.trim();
  if (th && th !== c.content.trim()) {
    return (
      <>
        {c.content}{' '}
        <span style={{ color: 'var(--accent-info)' }}>({th})</span>
      </>
    );
  }
  return c.content;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="stat-label mb-2">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="text-xs mt-1 text-muted">{sub}</div>}
    </div>
  );
}

export default function IgPostDetailPage() {
  const { post_id } = useParams<{ post_id: string }>();
  const router = useRouter();
  const [data, setData] = useState<InstagramPostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scrapeStatus, setScrapeStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');

  function load() {
    fetchInstagramPost(post_id)
      .then(setData)
      .catch(() => setError('Post not found'))
      .finally(() => setLoading(false));
  }
  useEffect(load, [post_id]);

  const handleScrapeComments = async () => {
    setScrapeStatus('running');
    try {
      const { jobId } = await triggerInstagramPostCommentScrape(post_id);
      const poll = setInterval(async () => {
        try {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/scrape/status/${jobId}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
          const job = await res.json() as { status: string };
          if (job.status === 'done') { setScrapeStatus('done'); clearInterval(poll); load(); }
          if (job.status === 'error') { setScrapeStatus('error'); clearInterval(poll); }
        } catch { clearInterval(poll); setScrapeStatus('error'); }
      }, 3_000);
    } catch { setScrapeStatus('error'); }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <div className="w-8 h-8 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
    </div>
  );

  if (error || !data) return (
    <div className="text-center py-32">
      <div className="text-4xl mb-3">📸</div>
      <p className="font-medium text-primary">{error || 'Post not found'}</p>
      <button className="btn btn-secondary mt-4" onClick={() => router.push('/instagram')}>Back to Feed</button>
    </div>
  );

  const { post, sentiments, comments } = data;
  const totalComments = sentiments.reduce((s, r) => s + r.count, 0);
  const get = (k: string) => sentiments.find((s) => s.sentiment === k)?.count ?? 0;
  const counts = { positive: get('positive'), negative: get('negative'), neutral: get('neutral'), question: get('question'), unanalyzed: get('unanalyzed') };
  const analyzed = counts.positive + counts.negative + counts.neutral + counts.question;
  const pct = (n: number) => totalComments > 0 ? ((n / totalComments) * 100).toFixed(1) : '0.0';
  const mt = MEDIA_BADGE[post.media_type ?? 'image'] ?? MEDIA_BADGE.image;
  const engVal = post.engagement_rate ? parseFloat(post.engagement_rate) : 0;
  const ORDER = ['positive', 'negative', 'neutral', 'question', 'unanalyzed'] as const;

  return (
    <div>
      {/* Real browser back — see tiktok/[post_id]/page.tsx for why. */}
      <button onClick={() => (window.history.length > 1 ? router.back() : router.push('/instagram'))} className="flex items-center gap-2 text-sm mb-6 hover:opacity-80 text-muted">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>

      <div className="page-header mb-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <span className="font-semibold text-sm px-2.5 py-1 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>{post.brand_name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: `${mt.color}1f`, color: mt.color }}>{mt.label}</span>
            {post.author_handle && <span className="text-xs text-muted">@{post.author_handle}</span>}
            {post.posted_at && <span className="text-xs text-muted">{new Date(post.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
          </div>
          <p className="text-base leading-relaxed" style={{ color: 'var(--text-secondary)', maxWidth: 680 }}>{post.caption ?? 'No caption'}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="btn btn-secondary" disabled={scrapeStatus === 'running'} onClick={handleScrapeComments}>
            {scrapeStatus === 'running' ? (
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />Scraping...</span>
            ) : scrapeStatus === 'done' ? 'Done' : scrapeStatus === 'error' ? 'Error' : 'Scrape Comments'}
          </button>
          {post.post_url && (
            <a href={post.post_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              View on Instagram
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Views" value={post.views != null ? fmt(post.views) : '—'} sub={post.views == null ? 'image (no views)' : undefined} />
        <StatCard label="Likes" value={fmt(post.likes)} />
        <StatCard label="Comments" value={fmt(post.comments_count)} sub={totalComments > 0 ? `${totalComments} scraped` : undefined} />
        <div className="card p-5">
          <div className="stat-label mb-2">Engagement</div>
          <div className="stat-value" style={{ color: engVal > 3 ? 'var(--accent-success)' : engVal >= 1 ? 'var(--accent-warning)' : 'var(--text-muted)' }}>
            {post.engagement_rate ? `${engVal.toFixed(2)}%` : `${fmt(post.likes + post.comments_count)}`}
          </div>
          <div className="text-xs mt-1 text-muted">{post.engagement_rate ? 'of views' : 'interactions'}</div>
        </div>
      </div>

      <div className="grid gap-5 mb-5 grid-2col" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        <div className="card p-6">
          <div className="section-title mb-1">Comment Sentiment</div>
          <div className="text-xs mb-5 text-muted">
            {totalComments > 0 ? `${totalComments} comments scraped · ${analyzed} analyzed` : 'No comments scraped yet'}
          </div>
          {totalComments === 0 ? (
            <div className="text-center py-6 text-muted">
              <div className="text-2xl mb-2">💬</div>
              <p className="text-sm">Run the comment scraper to see sentiment data</p>
            </div>
          ) : (
            <div className="space-y-4">
              {ORDER.map((key) => {
                const count = counts[key];
                if (count === 0) return null;
                const cfg = SENTIMENT_CONFIG[key];
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: cfg.color }} />
                        <span className="text-sm font-medium text-primary">{cfg.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm font-bold" style={{ color: cfg.color }}>{count.toLocaleString()}</span>
                        <span className="text-xs w-12 text-right font-mono text-muted">{pct(count)}%</span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden bg-base">
                      <div className="h-full rounded-full transition-all" style={{ width: `${parseFloat(pct(count))}%`, background: cfg.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-6" id="comments">
          <div className="section-title mb-4">Top Comments</div>
          {comments.length === 0 ? (
            <div className="text-center py-6 text-muted">
              <div className="text-2xl mb-2">💬</div>
              <p className="text-sm">No comments scraped yet</p>
            </div>
          ) : (
            <div className="space-y-3 overflow-y-auto" style={{ maxHeight: 460 }}>
              {comments.map((c, i) => {
                const cfg = c.sentiment ? SENTIMENT_CONFIG[c.sentiment as keyof typeof SENTIMENT_CONFIG] : null;
                return (
                  <div key={i} className="p-3 rounded-lg" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      {cfg && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>}
                      <div className="flex items-center gap-1 ml-auto flex-shrink-0 text-muted">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        <span className="text-[11px] font-mono">{c.likes_count ?? 0}</span>
                      </div>
                    </div>
                    <p className="text-sm leading-relaxed text-secondary">{displayContent(c)}</p>
                    {c.published_at && <p className="text-[11px] mt-1.5 text-muted">{new Date(c.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
