'use client';

import { useRouter } from 'next/navigation';
import { UgcPost } from '@/lib/api';
import { getThemeColor, UgcCardStats } from './ugc-card';

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export default function UgcListItem({ post }: { post: UgcPost }) {
  const router = useRouter();
  const s = post.sentiment;
  const classified = s.positive + s.negative + s.neutral;
  const themeColor = getThemeColor(post.theme);

  return (
    <div
      className="card p-4 card-hover cursor-pointer"
      onClick={() => router.push(`/tiktok/${post.post_id}`)}
    >
      <div className="flex items-start gap-4">
        {/* Theme indicator */}
        <div className="flex flex-col items-center gap-1 pt-1">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-[10px] font-bold text-center leading-tight" style={{ background: themeColor }}>
            {post.theme.split(' ')[0]}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="tag tag-blue text-[10px]">{post.brand_name}</span>
            <span className="text-[11px] text-muted">
              {post.author_handle ? `@${post.author_handle}` : 'unknown'}
            </span>
            {post.spike_flag && (
              <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded uppercase" style={{ background: 'var(--accent-danger)' }}>Spike</span>
            )}
            <span className="text-[11px] ml-auto text-muted">
              {post.posted_at ? new Date(post.posted_at).toLocaleDateString('en-CA') : ''}
            </span>
          </div>

          <p
            className="text-sm mb-2"
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

          <div className="flex items-center gap-4">
            <div className="flex-1 max-w-xs">
              <UgcCardStats post={post} compact />
            </div>

            <div className="flex items-center gap-2 w-32">
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
      </div>
    </div>
  );
}
