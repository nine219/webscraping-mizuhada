'use client';

import { useRouter } from 'next/navigation';
import { UgcPost } from '@/lib/api';

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const THEME_COLORS: Record<string, string> = {
  'Product Review': '#f59e0b',
  'Tutorial / How-to': '#3b82f6',
  'Unboxing': '#8b5cf6',
  'Comparison': '#10b981',
  'Routine / GRWM': '#ec4899',
  'Before / After': '#ef4444',
  'Challenge / Trend': '#06b6d4',
  'Educational': '#6366f1',
  'Lifestyle / Vlog': '#84cc16',
  'Promotion / Sale': '#f97316',
  'Podcast': '#14b8a6',
  'Other': '#94a3b8',
};

export function getThemeColor(theme: string): string {
  return THEME_COLORS[theme] ?? '#94a3b8';
}

export function UgcCardStats({ post, compact = false }: { post: UgcPost; compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? 'gap-3' : 'gap-4'}`}>
      {[
        { v: fmtCompact(post.views), l: 'Views' },
        { v: fmtCompact(post.likes), l: 'Likes' },
        { v: fmtCompact(post.shares), l: 'Shares' },
      ].map((m) => (
        <div key={m.l} className={compact ? 'text-left' : 'text-center'}>
          <div className={`font-semibold ${compact ? 'text-xs' : 'text-sm'}`}>{m.v}</div>
          {!compact && <div className="text-[10px] text-muted">{m.l}</div>}
        </div>
      ))}
      <div className={`ml-auto ${compact ? 'text-left' : 'text-center'}`}>
        <div className={`font-semibold ${compact ? 'text-xs' : 'text-sm'}`} style={{ color: 'var(--sentiment-positive)' }}>{post.engagement_rate.toFixed(1)}%</div>
        {!compact && <div className="text-[10px] text-muted">Engagement</div>}
      </div>
    </div>
  );
}

export default function UgcCard({ post }: { post: UgcPost }) {
  const router = useRouter();
  const s = post.sentiment;
  const classified = s.positive + s.negative + s.neutral;
  const themeColor = getThemeColor(post.theme);

  return (
    <div
      className="card overflow-hidden card-hover cursor-pointer"
      onClick={() => router.push(`/tiktok/${post.post_id}`)}
    >
      {/* Header band */}
      <div className="relative p-4" style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-white bg-black/30 px-2 py-0.5 rounded">TikTok</span>
            <span
              className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded uppercase"
              style={{ background: themeColor }}
            >
              {post.theme}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {post.spike_flag && (
              <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded uppercase" style={{ background: 'var(--accent-danger)' }}>Spike</span>
            )}
            <span className="text-[11px] text-white/70">
              {post.posted_at ? new Date(post.posted_at).toLocaleDateString('en-CA') : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="tag tag-blue text-[10px]">{post.brand_name}</span>
          <span className="text-[11px] text-muted">
            {post.author_handle ? `@${post.author_handle}` : 'unknown'}
          </span>
        </div>

        <p
          className="text-sm mb-3"
          style={{
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {post.caption ?? '—'}
        </p>

        <UgcCardStats post={post} />

        {/* Sentiment bar */}
        <div className="flex items-center gap-2 mt-3">
          <span className="text-[10px] text-muted">Sentiment</span>
          <div className="flex-1 h-1.5 rounded-full overflow-hidden flex bg-base">
            {classified > 0 ? (
              <>
                <div style={{ width: `${s.positive_pct}%`, background: 'var(--sentiment-positive)' }} />
                <div style={{ width: `${s.neutral_pct}%`, background: 'var(--sentiment-neutral)' }} />
                <div style={{ width: `${s.negative_pct}%`, background: 'var(--sentiment-negative)' }} />
              </>
            ) : null}
          </div>
          <span className="text-[10px] font-medium" style={{ color: classified > 0 ? 'var(--sentiment-positive)' : 'var(--text-muted)' }}>
            {classified > 0 ? `${s.positive_pct}%` : 'n/a'}
          </span>
        </div>
      </div>
    </div>
  );
}
