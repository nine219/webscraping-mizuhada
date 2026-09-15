'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchXhsNote, updateCommentSentiment, XhsNoteDetail } from '@/lib/api';

const SENTIMENT_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  positive:   { color: '#10b981', bg: 'rgba(16,185,129,0.12)', label: 'Positive' },
  negative:   { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  label: 'Negative' },
  neutral:    { color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', label: 'Neutral' },
  question:   { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', label: 'Question' },
  unanalyzed: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  label: 'Unanalyzed' },
};

const SENTIMENT_ORDER = ['positive', 'negative', 'neutral', 'question', 'unanalyzed'] as const;

const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

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

export default function XhsNoteDetailPage() {
  const { note_id } = useParams<{ note_id: string }>();
  const router = useRouter();
  const [data, setData] = useState<XhsNoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [commentSentiment, setCommentSentiment] = useState('');
  const [editingSentimentId, setEditingSentimentId] = useState<number | null>(null);

  useEffect(() => {
    fetchXhsNote(note_id, commentSentiment || undefined)
      .then(setData)
      .catch(() => setError('Note not found'))
      .finally(() => setLoading(false));
  }, [note_id, commentSentiment]);

  const handleSentimentChange = async (commentId: number, sentiment: string | null) => {
    setEditingSentimentId(null);
    setData((prev) => {
      if (!prev) return prev;
      return { ...prev, comments: prev.comments.map((c) => (c.id === commentId ? { ...c, sentiment } : c)) };
    });
    try {
      await updateCommentSentiment(commentId, { sentiment });
    } catch {
      fetchXhsNote(note_id, commentSentiment || undefined).then(setData).catch(() => {});
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <div className="w-8 h-8 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
    </div>
  );

  if (error || !data) return (
    <div className="text-center py-32">
      <div className="text-4xl mb-3">📕</div>
      <p className="font-medium text-primary">{error || 'Note not found'}</p>
      <button className="btn btn-secondary mt-4" onClick={() => router.push('/xhs')}>Back to Monitor</button>
    </div>
  );

  const { post, sentiments, comments } = data;
  const cfg = post.sentiment ? SENTIMENT_CONFIG[post.sentiment] : null;
  const caption = post.content?.replace(/\s*---\s*/g, ' — ') ?? '';
  const th = post.content_translated?.trim();
  const showTh = th && th !== caption.trim() && CJK_RE.test(caption);

  const totalComments = sentiments.reduce((s, r) => s + r.count, 0);
  const getSentiment = (key: string) => sentiments.find((s) => s.sentiment === key)?.count ?? 0;
  const positive   = getSentiment('positive');
  const negative   = getSentiment('negative');
  const neutral    = getSentiment('neutral');
  const question   = getSentiment('question');
  const unanalyzed = getSentiment('unanalyzed');
  const pct = (n: number) => totalComments > 0 ? ((n / totalComments) * 100).toFixed(1) : '0.0';

  return (
    <div>
      {/* Back nav — real browser back (see tiktok/[post_id]/page.tsx for why:
          this page is reachable from more than one place). */}
      <button
        onClick={() => (window.history.length > 1 ? router.back() : router.push('/xhs'))}
        className="flex items-center gap-2 text-sm mb-6 hover:opacity-80 transition-opacity text-muted"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Back
      </button>

      <div className="grid gap-5 mb-6 grid-2col" style={{ gridTemplateColumns: '320px 1fr' }}>
        {/* Cover */}
        <div className="card p-0 overflow-hidden" style={{ alignSelf: 'start' }}>
          {post.cover_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.cover_url} alt="" referrerPolicy="no-referrer" className="w-full object-cover" style={{ maxHeight: 420, background: 'var(--bg-elevated)' }} />
          ) : (
            <div className="flex items-center justify-center" style={{ height: 320, background: 'var(--bg-base)', color: 'var(--text-muted)' }}>No cover</div>
          )}
        </div>

        {/* Details */}
        <div>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <span className="font-semibold text-sm px-2.5 py-1 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>
              {post.brand_name ?? '—'}
            </span>
            {post.source_type === 'search'
              ? <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(99,102,241,0.12)', color: '#6366f1' }}>UGC</span>
              : <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}>Official</span>
            }
            {post.note_type === 'video' && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>video</span>
            )}
            {cfg && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
            )}
            {post.published_at && (
              <span className="text-xs text-muted">
                {new Date(post.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </span>
            )}
          </div>

          {post.author_name && (
            <div className="flex items-center gap-2 mb-3">
              {post.author_avatar && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={post.author_avatar} alt="" referrerPolicy="no-referrer" className="w-6 h-6 rounded-full" />
              )}
              <span className="text-sm text-secondary">@{post.author_name}</span>
            </div>
          )}

          <p className="text-base leading-relaxed mb-2 text-primary">
            {caption || 'No caption'}
          </p>
          {showTh && (
            <p className="text-sm leading-relaxed mb-4 pl-3" style={{ color: 'var(--accent-info)', borderLeft: '2px solid var(--accent-info)' }}>
              ({th})
            </p>
          )}

          <div className="grid grid-cols-3 gap-4 mt-5 mb-5">
            <StatCard label="Likes" value={post.likes_count ?? 0} />
            <StatCard label="Topic" value={post.topic ?? '—'} />
            <StatCard label="Type" value={post.note_type ?? '—'} />
          </div>

          <a href={post.note_url} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            View on Xiaohongshu
          </a>
        </div>
      </div>

      {/* Sentiment breakdown + comments */}
      <div className="grid gap-5 mb-5 grid-2col" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
        <div className="card p-6">
          <div className="section-title mb-1">Comment Sentiment</div>
          <div className="text-xs mb-5 text-muted">
            {totalComments > 0 ? `${totalComments} replies` : 'No replies yet'}
          </div>
          {totalComments === 0 ? (
            <div className="text-center py-6 text-muted">
              <p className="text-sm">No replies on this note</p>
            </div>
          ) : (
            <div className="space-y-4">
              {SENTIMENT_ORDER.map((key) => {
                const count = key === 'positive' ? positive : key === 'negative' ? negative : key === 'neutral' ? neutral : key === 'question' ? question : unanalyzed;
                if (count === 0) return null;
                const ccfg = SENTIMENT_CONFIG[key];
                const pctVal = parseFloat(pct(count));
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: ccfg.color }} />
                        <span className="text-sm font-medium text-primary">{ccfg.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm font-bold" style={{ color: ccfg.color }}>{count.toLocaleString()}</span>
                        <span className="text-xs w-12 text-right font-mono text-muted">{pct(count)}%</span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden bg-base">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pctVal}%`, background: ccfg.color }} />
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-2 flex-wrap pt-2 border-t-light">
                {SENTIMENT_ORDER.map((key) => {
                  const count = key === 'positive' ? positive : key === 'negative' ? negative : key === 'neutral' ? neutral : key === 'question' ? question : unanalyzed;
                  if (count === 0) return null;
                  const ccfg = SENTIMENT_CONFIG[key];
                  return (
                    <span key={key} className="text-[11px] px-2 py-1 rounded-full font-medium" style={{ background: ccfg.bg, color: ccfg.color }}>
                      {ccfg.label}: {count} ({pct(count)}%)
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Replies */}
        <div className="card p-6">
          <div className="section-title mb-4">Replies</div>

          {totalComments > 0 && (
            <div className="flex gap-2 flex-wrap mb-4">
              {SENTIMENT_ORDER.map((key) => {
                const count = key === 'positive' ? positive : key === 'negative' ? negative : key === 'neutral' ? neutral : key === 'question' ? question : unanalyzed;
                if (count === 0 && commentSentiment !== key) return null;
                const ccfg = SENTIMENT_CONFIG[key];
                return (
                  <button
                    key={key}
                    onClick={() => setCommentSentiment(commentSentiment === key ? '' : key)}
                    className={`filter-pill ${commentSentiment === key ? 'active' : ''}`}
                  >
                    {ccfg.label} ({count})
                  </button>
                );
              })}
              {commentSentiment && (
                <button onClick={() => setCommentSentiment('')} className="text-xs text-muted">Clear</button>
              )}
            </div>
          )}

          {comments.length === 0 ? (
            <div className="text-center py-6 text-muted">
              <p className="text-sm">{commentSentiment ? `No ${commentSentiment} replies` : 'No replies on this note'}</p>
            </div>
          ) : (
            <div className="space-y-3 overflow-y-auto" style={{ maxHeight: 420 }}>
              {comments.map((c) => {
                const ccfg = c.sentiment ? SENTIMENT_CONFIG[c.sentiment] : null;
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
                          style={ccfg ? { background: ccfg.bg, color: ccfg.color } : { background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}
                          title="Click to change sentiment"
                        >
                          {ccfg?.label ?? 'Set sentiment'}
                        </button>
                      )}
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

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-5">
      <div className="stat-label mb-2">{label}</div>
      <div className="stat-value">{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}