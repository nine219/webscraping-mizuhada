'use client';

import { useEffect, useState } from 'react';
import { fetchSocial, SocialComment } from '@/lib/api';

// Slide-in panel opened by clicking a point/bar on the Command Center charts
// (sentiment trend, negative-comment volume, topic matrix) — shows the actual
// comments behind that data point instead of leaving the user stuck looking
// at a chart with no way to see what's underneath a spike/drop.
export interface DrilldownFilter {
  /** Exact day (YYYY-MM-DD) — set when drilling in from a chart date/bar. */
  date?: string;
  sentiment?: string;
  topic?: string;
  /** Human label for the drawer header, e.g. "Jul 9, 2026" or "Topic: คุณภาพ". */
  title: string;
}

const PLATFORM_COLORS: Record<string, string> = {
  tiktok: '#000000',
  instagram: '#E1306C',
  xiaohongshu: '#FF2442',
  twitter: '#000000',
};

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  xiaohongshu: 'Xiaohongshu',
  twitter: 'X (Twitter)',
};

const SENTIMENT_TAG: Record<string, string> = {
  positive: 'tag-green',
  negative: 'tag-red',
  neutral: 'tag-blue',
  question: 'tag-amber',
};

function displayContent(c: SocialComment) {
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

export default function DrilldownDrawer({ filter, onClose }: { filter: DrilldownFilter | null; onClose: () => void }) {
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filter) return;
    setLoading(true);
    fetchSocial({ date: filter.date, sentiment: filter.sentiment, topic: filter.topic, sort: 'urgency', limit: 50 })
      .then((r) => { setComments(r.data); setTotal(r.total); })
      .catch(() => { setComments([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    if (!filter) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filter, onClose]);

  if (!filter) return null;

  return (
    <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-xs text-muted mb-0.5">{loading ? 'Loading…' : `${total.toLocaleString()} comment${total === 1 ? '' : 's'}`}</div>
            <h3 className="text-lg font-bold text-primary">{filter.title}</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded-full cursor-pointer text-sm flex-shrink-0"
            style={{ background: 'var(--bg-base)', border: 'none', color: 'var(--text-secondary)' }}
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : comments.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-3xl mb-2">💬</div>
            <p className="text-sm text-muted">No comments found for this filter.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {comments.map((c) => (
              <div key={c.id} className="p-3 rounded-lg" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span
                    className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                    style={{ background: PLATFORM_COLORS[c.platform] ?? '#64748b' }}
                  >
                    {c.platform.charAt(0).toUpperCase()}
                  </span>
                  <span className="text-xs font-semibold text-primary">{PLATFORM_LABELS[c.platform] ?? c.platform}</span>
                  <span className="text-xs text-muted">•</span>
                  <span className="text-xs text-muted">{c.brand_name}</span>
                  {c.sentiment && (
                    <span className={`tag text-[10px] ${SENTIMENT_TAG[c.sentiment] ?? 'tag-gray'}`}>{c.sentiment}</span>
                  )}
                  {c.sentiment === 'negative' && c.urgency != null && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                      style={{
                        background: c.urgency >= 4 ? 'var(--sentiment-negative-bg)' : 'var(--accent-warning-subtle)',
                        color: c.urgency >= 4 ? 'var(--sentiment-negative)' : 'var(--accent-warning)',
                      }}
                      title={`Urgency ${c.urgency}/5`}
                    >
                      U{c.urgency}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-secondary">{displayContent(c)}</p>
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  {c.topic && <span className="tag tag-purple text-[10px]">{c.topic}</span>}
                  <span className="text-[11px] text-muted">
                    {c.published_at ? new Date(c.published_at).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recently'}
                  </span>
                  {c.post_url && (
                    <a href={c.post_url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium hover:underline" style={{ color: 'var(--accent-primary)' }}>
                      View ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
