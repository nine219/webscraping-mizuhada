'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TikTokPost } from '@/lib/api';
import { ShopBadge } from './shop-badge';
import { SpikeBadge, SourceBadge } from './badges';

// Per-brand tint for the media placeholder/fallback — gives each brand's
// viral hits a subtly distinct identity even before (or instead of) a video
// preview loads. Falls back to the app's existing dark-neutral gradient
// (same pair ugc-card.tsx already uses) for anything not in this map, e.g.
// Her Hyness never reaches this card at all (spike detection is own-brand
// only — see spike-detection.ts) but the fallback keeps this safe regardless.
const BRAND_GRADIENT: Record<string, string> = {
  mizumi: 'linear-gradient(135deg, #0b1220 0%, #1d4ed8 100%)',
  'gentle-colors': 'linear-gradient(135deg, #1e1b4b 0%, #7c3aed 100%)',
  bomi: 'linear-gradient(135deg, #0c2733 0%, #0891b2 100%)',
};
const FALLBACK_GRADIENT = 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)';

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n ?? 0);
}

function engagementColor(rate: string | null): string {
  if (!rate) return 'var(--text-muted)';
  const v = parseFloat(rate);
  if (v > 3) return 'var(--accent-success)';
  if (v >= 1) return 'var(--accent-warning)';
  return 'var(--text-muted)';
}

// Card for the Viral view's grid. video_url is a raw TikTok CDN file URL
// (playAddr/downloadAddr — see tiktok-feed.ts) that isn't guaranteed to load
// when hotlinked outside TikTok's own session (signed/expiring, sometimes
// referrer-gated), so playback is opportunistic: only attempted on hover,
// and the branded placeholder never gets torn down underneath it — if the
// video fails or never fires `onPlaying`, the placeholder just stays put
// with no broken-media flash.
//
// cover_url (thumbnail) is the same kind of signed, expiring CDN URL — it's
// captured fresh on every scrape but goes stale a few weeks after that (see
// schema-social.sql's cover_url comment). No server-side proxy/cache, so a
// stale thumbnail just 404s — onError below swaps back to the branded
// gradient+initial placeholder instead of showing a broken image icon.
export default function ViralPostCard({ post }: { post: TikTokPost }) {
  const router = useRouter();
  const [hovering, setHovering] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);

  const gradient = BRAND_GRADIENT[post.brand_slug] ?? FALLBACK_GRADIENT;
  const sentimentTotal = post.sentiment_positive + post.sentiment_negative + post.sentiment_neutral + post.sentiment_question;
  const engColor = engagementColor(post.engagement_rate);
  const showCover = !!post.cover_url && !coverFailed;

  return (
    <div
      className="viral-card"
      onClick={() => router.push(`/tiktok/${post.post_id}`)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => { setHovering(false); setVideoPlaying(false); }}
    >
      <div className="viral-media" style={{ background: gradient }}>
        {showCover && (
          // eslint-disable-next-line @next/next/no-img-element -- external hotlinked CDN URL, not a local/optimizable asset
          <img
            src={post.cover_url!}
            alt=""
            onError={() => setCoverFailed(true)}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'cover', opacity: hovering && videoPlaying ? 0 : 1, transition: 'opacity 0.15s',
            }}
          />
        )}

        {hovering && post.video_url && (
          <video
            src={post.video_url}
            muted
            loop
            playsInline
            autoPlay
            className={videoPlaying ? 'is-playing' : ''}
            onPlaying={() => setVideoPlaying(true)}
            onError={() => setVideoPlaying(false)}
          />
        )}

        {/* Decorative ghost initial — only shown when there's no real
           thumbnail to display (cover_url missing or expired/404'd). The
           caption already gets its own full line-clamped block in the card
           body below, so this stays a low-opacity brand mark, not a text
           duplicate. */}
        {!showCover && (
          <div className="viral-media-placeholder">
            <span className="viral-media-initial">{(post.brand_name || '?').charAt(0)}</span>
          </div>
        )}

        <div className="viral-play-hint">
          <svg width="38" height="38" viewBox="0 0 24 24" fill="rgba(255,255,255,0.92)"><path d="M8 5v14l11-7z" /></svg>
        </div>

        <div className="viral-view-count">
          {fmtCompact(post.views ?? 0)}
          <span className="unit">views</span>
        </div>

        <div style={{ position: 'absolute', top: 10, left: 10 }}>
          <SourceBadge sourceType={post.source_type} />
        </div>
        <div style={{ position: 'absolute', top: 10, right: 10 }}>
          <SpikeBadge active={post.spike_flag} />
        </div>
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="tag tag-blue text-[10px]">{post.brand_name}</span>
          {post.author_handle && (
            <span className="text-[11px] font-mono text-muted">@{post.author_handle}</span>
          )}
        </div>

        <p
          className="text-sm mb-3"
          style={{
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
            minHeight: '2.6em',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {post.caption || '—'}
        </p>

        <div className="flex items-center gap-4 mb-3">
          <div>
            <div className="text-sm font-semibold text-primary">{fmtCompact(post.likes ?? 0)}</div>
            <div className="text-[10px] text-muted">Likes</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-primary">{fmtCompact(post.shares ?? 0)}</div>
            <div className="text-[10px] text-muted">Shares</div>
          </div>
          <div>
            <div className="text-sm font-semibold text-primary">{fmtCompact(post.comments_count ?? 0)}</div>
            <div className="text-[10px] text-muted">Comments</div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-sm font-semibold" style={{ color: engColor }}>
              {post.engagement_rate ? `${parseFloat(post.engagement_rate).toFixed(2)}%` : '—'}
            </div>
            <div className="text-[10px] text-muted">Engagement</div>
          </div>
        </div>

        <div className="badge-row mb-3">
          <ShopBadge isShopContent={post.is_shop_content} shopSignal={post.shop_signal} />
        </div>

        {/* Sentiment mini-bar — same fields feed-tab's table cell uses, same
           "n/a when nothing classified yet" convention. */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] flex-shrink-0 text-muted">Sentiment</span>
          <div className="flex-1 h-1.5 rounded-full overflow-hidden flex bg-base">
            {sentimentTotal > 0 && (
              <>
                <div style={{ width: `${(post.sentiment_positive / sentimentTotal) * 100}%`, background: 'var(--sentiment-positive)' }} />
                <div style={{ width: `${(post.sentiment_neutral / sentimentTotal) * 100}%`, background: 'var(--sentiment-neutral)' }} />
                <div style={{ width: `${(post.sentiment_question / sentimentTotal) * 100}%`, background: '#8b5cf6' }} />
                <div style={{ width: `${(post.sentiment_negative / sentimentTotal) * 100}%`, background: 'var(--sentiment-negative)' }} />
              </>
            )}
          </div>
          <span className="text-[10px] font-medium flex-shrink-0" style={{ color: sentimentTotal > 0 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
            {sentimentTotal > 0 ? `${sentimentTotal} classified` : 'n/a'}
          </span>
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t-light">
          <span className="text-[11px] text-muted">
            {post.posted_at ? new Date(post.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
          </span>
          {post.post_url && (
            <a
              href={post.post_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs font-medium"
              style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}
            >
              View on TikTok ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
