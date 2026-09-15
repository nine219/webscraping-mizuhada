'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchTikTokPost, triggerPostCommentScrape, deletePost, toggleWatchlist, updatePostTheme, updateCommentSentiment, CONTENT_THEMES, TikTokPostDetail } from '@/lib/api';
import { getThemeColor } from '@/components/ugc-card';
import { ShopBadge } from '@/components/shop-badge';
import { SpikeBadge, OtherBrandChip } from '@/components/badges';
import { WatchlistIcon } from '@/components/watchlist-icon';

const SENTIMENT_CONFIG = {
  positive:   { color: '#10b981', bg: 'rgba(16,185,129,0.12)', label: 'Positive' },
  negative:   { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  label: 'Negative' },
  neutral:    { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', label: 'Neutral' },
  question:   { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', label: 'Question' },
  unanalyzed: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  label: 'Unanalyzed' },
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

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="stat-label mb-2">{label}</div>
      <div className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub && <div className="text-xs mt-1 text-muted">{sub}</div>}
    </div>
  );
}

function ThemeEditor({ postId, initial }: { postId: string; initial: string | null }) {
  const [theme, setTheme] = useState<string | null>(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const color = getThemeColor(theme ?? 'Other');

  const handleChange = async (next: string) => {
    setEditing(false);
    if (next === theme) return;
    const prev = theme;
    setTheme(next);          // optimistic
    setSaving(true);
    try {
      await updatePostTheme(postId, next);
    } catch {
      setTheme(prev);        // revert on failure
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <select
        autoFocus
        className="select text-xs py-0.5 px-2"
        value={theme ?? 'Other'}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => setEditing(false)}
      >
        {CONTENT_THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to change tag"
      className="text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1 hover:opacity-80 transition-opacity"
      style={{ background: `${color}1f`, color }}
    >
      {saving ? 'Saving…' : (theme ?? 'Set tag')}
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
      </svg>
    </button>
  );
}

export default function PostDetailPage() {
  const { post_id } = useParams<{ post_id: string }>();
  const router = useRouter();
  const [data, setData] = useState<TikTokPostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scrapeStatus, setScrapeStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [watchlisted, setWatchlisted] = useState<boolean | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [commentSentiment, setCommentSentiment] = useState('');
  const [editingSentimentId, setEditingSentimentId] = useState<number | null>(null);

  const handleSentimentChange = async (commentId: number, sentiment: string | null) => {
    setEditingSentimentId(null);
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        comments: prev.comments.map((c) =>
          c.id === commentId ? { ...c, sentiment } : c
        ),
      };
    });
    try {
      await updateCommentSentiment(commentId, { sentiment });
    } catch {
      // refetch on failure
      fetchTikTokPost(post_id, commentSentiment || undefined)
        .then((d) => setData(d))
        .catch(() => {});
    }
  };

  const handleScrapeComments = async () => {
    setScrapeStatus('running');
    try {
      const { jobId } = await triggerPostCommentScrape(post_id);
      const poll = setInterval(async () => {
        try {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/scrape/status/${jobId}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
          const job = await res.json() as { status: string };
          if (job.status === 'done') { setScrapeStatus('done'); clearInterval(poll); }
          if (job.status === 'error') { setScrapeStatus('error'); clearInterval(poll); }
        } catch { clearInterval(poll); setScrapeStatus('error'); }
      }, 3_000);
    } catch { setScrapeStatus('error'); }
  };

  useEffect(() => {
    fetchTikTokPost(post_id, commentSentiment || undefined)
      .then((d) => { setData(d); setWatchlisted(d.post.watchlist); })
      .catch(() => setError('Post not found'))
      .finally(() => setLoading(false));
  }, [post_id, commentSentiment]);

  const handleToggleWatchlist = async () => {
    const { watchlist } = await toggleWatchlist(post_id);
    setWatchlisted(watchlist);
  };

  const handleDelete = async () => {
    if (deleteStatus === 'idle') { setDeleteStatus('confirm'); return; }
    setDeleteStatus('deleting');
    try {
      await deletePost(post_id);
      router.back();
    } catch { setDeleteStatus('idle'); }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <div className="w-8 h-8 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
    </div>
  );

  if (error || !data) return (
    <div className="text-center py-32">
      <div className="text-4xl mb-3">🎵</div>
      <p className="font-medium text-primary">{error || 'Post not found'}</p>
      <button className="btn btn-secondary mt-4" onClick={() => router.push('/tiktok')}>Back to Feed</button>
    </div>
  );

  const { post, sentiments, comments } = data;

  // Sentiment totals
  const totalComments = sentiments.reduce((s, r) => s + r.count, 0);
  const getSentiment = (key: string) => sentiments.find((s) => s.sentiment === key)?.count ?? 0;
  const positive   = getSentiment('positive');
  const negative   = getSentiment('negative');
  const neutral    = getSentiment('neutral');
  const question   = getSentiment('question');
  const unanalyzed = getSentiment('unanalyzed');
  const analyzed   = positive + negative + neutral + question;
  const pct = (n: number) => totalComments > 0 ? ((n / totalComments) * 100).toFixed(1) : '0.0';

  const engVal = post.engagement_rate ? parseFloat(post.engagement_rate) : 0;
  const engColor = engVal > 3 ? 'var(--accent-success)' : engVal >= 1 ? 'var(--accent-warning)' : 'var(--text-muted)';

  const SENTIMENT_ORDER = ['positive', 'negative', 'neutral', 'question', 'unanalyzed'] as const;

  return (
    <div>
      {/* Back nav — real browser back, not a hardcoded destination. This page
          is reachable from Command Center spike alerts, UGC Performance
          cards, Social Listening, and TikTok Feed/Search — hardcoding
          "Back to Feed Monitor" sent a user drilling in from anywhere else
          to an unrelated page instead of back to where they actually were.
          Falls back to Feed Monitor only if there's no in-app history to
          go back to (e.g. this page was opened directly/in a new tab). */}
      <button
        onClick={() => (window.history.length > 1 ? router.back() : router.push('/tiktok'))}
        className="flex items-center gap-2 text-sm mb-6 hover:opacity-80 transition-opacity text-muted"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Back
      </button>

      {/* Header */}
      <div className="page-header mb-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <span className="font-semibold text-sm px-2.5 py-1 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>
              {post.brand_name}
            </span>
            {post.source_type === 'search'
              ? <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(99,102,241,0.12)', color: '#6366f1' }}>UGC</span>
              : <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}>Official</span>
            }
            <SpikeBadge active={post.spike_flag} />
            <ShopBadge isShopContent={post.is_shop_content} shopSignal={post.shop_signal} />
            <ThemeEditor postId={post.post_id} initial={post.theme ?? null} />
            {post.posted_at && (
              <span className="text-xs text-muted">
                {new Date(post.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </span>
            )}
          </div>
          <p className="text-base leading-relaxed" style={{ color: 'var(--text-secondary)', maxWidth: 680 }}>
            {post.caption ?? 'No caption'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Watchlist toggle */}
          <button
            className="btn btn-secondary flex items-center gap-1.5"
            onClick={handleToggleWatchlist}
            title={watchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
            style={watchlisted ? { color: '#f59e0b', borderColor: 'rgba(245,158,11,0.4)' } : {}}
          >
            <WatchlistIcon active={!!watchlisted} size={14} color="currentColor" />
            {watchlisted ? 'Watching' : 'Watch'}
          </button>
          <button
            className="btn btn-secondary"
            disabled={scrapeStatus === 'running'}
            onClick={handleScrapeComments}
          >
            {scrapeStatus === 'running' ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                Scraping...
              </span>
            ) : scrapeStatus === 'done' ? 'Done' : scrapeStatus === 'error' ? 'Error' : 'Scrape Comments'}
          </button>
          {post.post_url && (
            <a
              href={post.post_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              View on TikTok
            </a>
          )}
          {/* Delete */}
          <button
            className="btn btn-secondary"
            disabled={deleteStatus === 'deleting'}
            onClick={handleDelete}
            style={deleteStatus === 'confirm' ? { color: '#ef4444', borderColor: 'rgba(239,68,68,0.4)' } : {}}
          >
            {deleteStatus === 'confirm' ? 'Confirm delete?' : deleteStatus === 'deleting' ? 'Deleting...' : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Engagement stats */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <StatCard label="Views"      value={post.views ?? 0} />
        <StatCard label="Likes"      value={post.likes ?? 0} />
        <StatCard label="Shares"     value={post.shares ?? 0} />
        <StatCard label="Comments"   value={post.comments_count ?? 0} sub={totalComments > 0 ? `${totalComments} scraped` : undefined} />
        <div className="card p-5">
          <div className="stat-label mb-2">Engagement</div>
          <div className="stat-value" style={{ color: engColor }}>
            {post.engagement_rate ? `${engVal.toFixed(2)}%` : '—'}
          </div>
        </div>
      </div>

      <div className="grid gap-5 mb-5 grid-2col" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        {/* Sentiment breakdown */}
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
              {SENTIMENT_ORDER.map((key) => {
                const count = key === 'positive' ? positive : key === 'negative' ? negative : key === 'neutral' ? neutral : key === 'question' ? question : unanalyzed;
                if (count === 0) return null;
                const cfg = SENTIMENT_CONFIG[key];
                const pctVal = parseFloat(pct(count));
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
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pctVal}%`, background: cfg.color }}
                      />
                    </div>
                  </div>
                );
              })}

              {/* Summary pills */}
              <div className="flex gap-2 flex-wrap pt-2 border-t-light">
                {SENTIMENT_ORDER.map((key) => {
                  const count = key === 'positive' ? positive : key === 'negative' ? negative : key === 'neutral' ? neutral : key === 'question' ? question : unanalyzed;
                  if (count === 0) return null;
                  const cfg = SENTIMENT_CONFIG[key];
                  return (
                    <span key={key} className="text-[11px] px-2 py-1 rounded-full font-medium" style={{ background: cfg.bg, color: cfg.color }}>
                      {cfg.label}: {count} ({pct(count)}%)
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Top comments */}
        <div className="card p-6" id="comments">
          <div className="section-title mb-4">Top Comments</div>

          {/* Sentiment filter pills */}
          {totalComments > 0 && (
            <div className="flex gap-2 flex-wrap mb-4">
              {SENTIMENT_ORDER.map((key) => {
                const count = key === 'positive' ? positive : key === 'negative' ? negative : key === 'neutral' ? neutral : key === 'question' ? question : unanalyzed;
                if (count === 0 && commentSentiment !== key) return null;
                const cfg = SENTIMENT_CONFIG[key];
                return (
                  <button
                    key={key}
                    onClick={() => setCommentSentiment(commentSentiment === key ? '' : key)}
                    className={`filter-pill ${commentSentiment === key ? 'active' : ''}`}
                  >
                    {cfg.label} ({count})
                  </button>
                );
              })}
              {commentSentiment && (
                <button
                  onClick={() => setCommentSentiment('')}
                  className="text-xs text-muted"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          {comments.length === 0 ? (
            <div className="text-center py-6 text-muted">
              <div className="text-2xl mb-2">💬</div>
              <p className="text-sm">{commentSentiment ? `No ${commentSentiment} comments` : 'No comments scraped yet'}</p>
            </div>
          ) : (
            <div className="space-y-3 overflow-y-auto" style={{ maxHeight: 420 }}>
              {comments.map((c, i) => {
                const cfg = c.sentiment ? SENTIMENT_CONFIG[c.sentiment as keyof typeof SENTIMENT_CONFIG] : null;
                const isEditing = editingSentimentId === c.id;
                return (
                  <div key={c.id} className="p-3 rounded-lg" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      {isEditing ? (
                        <select
                          autoFocus
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                          value={c.sentiment ?? ''}
                          onChange={(e) => handleSentimentChange(c.id, e.target.value || null)}
                          onBlur={() => setEditingSentimentId(null)}
                        >
                          <option value="">None</option>
                          {(['positive', 'negative', 'neutral', 'question'] as const).map((key) => (
                            <option key={key} value={key}>{SENTIMENT_CONFIG[key].label}</option>
                          ))}
                        </select>
                      ) : (
                        <button
                          onClick={() => setEditingSentimentId(c.id)}
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 hover:opacity-80 transition-opacity"
                          style={cfg ? { background: cfg.bg, color: cfg.color } : { background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                          title="Click to change sentiment"
                        >
                          {cfg?.label ?? 'Set sentiment'}
                        </button>
                      )}
                      <OtherBrandChip active={c.brand_relevance === 'other_brand'} />
                      <div className="flex items-center gap-1 ml-auto flex-shrink-0 text-muted">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        <span className="text-[11px] font-mono">{c.likes_count ?? 0}</span>
                      </div>
                    </div>
                    <p className="text-sm leading-relaxed text-secondary">{displayContent(c)}</p>
                    {c.published_at && (
                      <p className="text-[11px] mt-1.5 text-muted">
                        {new Date(c.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    )}
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
