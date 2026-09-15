'use client';

// Shared badge/chip vocabulary for social-listening surfaces. Each of these
// started as ad-hoc inline JSX duplicated across feed-tab/search-tab/
// influencers-tab/post-detail/creator-detail (M2-M4 built them independently
// under time pressure) — pulled out here so every surface renders the same
// signal identically instead of five slightly-different `<span>` treatments.
//
// Platform-neutral by design: no TikTok-specific copy or data shape baked
// in, so the X/Twitter surfaces (mentions-tab, campaigns-tab, creators-tab)
// can import these as-is once they wire in the equivalent fields — see
// docs plan Milestone 7, which explicitly reuses whatever's built here.
// Sibling to shop-badge.tsx (kept as its own file/export since it already
// has call sites depending on that exact import path).

/** Engagement/view spike detected on this post. Same meaning everywhere it appears. */
export function SpikeBadge({ active }: { active: boolean | null | undefined }) {
  if (!active) return null;
  return (
    <span className="tag tag-red" title="Views/engagement spiked above baseline">
      Spike
    </span>
  );
}

/** Creator is on the ambassador allowlist — shown, not excluded, per product decision. */
export function AmbassadorBadge({ active }: { active: boolean | null | undefined }) {
  if (!active) return null;
  return (
    <span className="tag tag-amber" title="Already an ambassador/creator we work with">
      ★ Ambassador
    </span>
  );
}

/** Soft authenticity flag — engagement is a large multiple of the group median. Never a filter. */
export function OutlierFlag({ active }: { active: boolean | null | undefined }) {
  if (!active) return null;
  return (
    <span
      title="Engagement % is a large multiple of the group median — a possible sign of bought/bot engagement. Worth a manual check before reaching out."
      style={{ color: 'var(--accent-warning)', fontSize: 12, cursor: 'help', lineHeight: 1 }}
    >
      ⚠
    </span>
  );
}

/** Comment classified as being about a different brand mentioned in the same post/thread. */
export function OtherBrandChip({ active }: { active: boolean | null | undefined }) {
  if (!active) return null;
  return (
    <span
      className="tag tag-gray"
      title="Classifier flagged this comment as being about a different brand mentioned in the same post"
    >
      Other brand
    </span>
  );
}

/** Own-account feed post vs. keyword/UGC search hit — same distinction on every platform. */
export function SourceBadge({ sourceType }: { sourceType: string | null | undefined }) {
  const isSearch = sourceType === 'search';
  return (
    <span className={`tag ${isSearch ? 'tag-purple' : 'tag-green'}`}>
      {isSearch ? 'UGC Search' : 'Feed'}
    </span>
  );
}

/**
 * X mention cleared the "high reach" absolute views/retweets bar — read-time
 * derived by GET /api/twitter/mentions/stats, not a stored column (see
 * src/api/routes/twitter.ts). Deliberately NOT SpikeBadge reused verbatim:
 * Spike is baseline-relative and post-level (tiktok_posts.spike_flag /
 * twitter_posts.spike_flag, computed by spike-detection.ts); High Reach is an
 * absolute-threshold, mention-level flag with no baseline/trend concept.
 * Uses indigo instead of Spike's reserved danger-red (globals.css: "Spike
 * stays --accent-danger red everywhere") so the two signals read as related
 * but distinct, inside the same .tag pill vocabulary.
 */
export function HighReachBadge({ active }: { active: boolean | null | undefined }) {
  if (!active) return null;
  return (
    <span className="tag tag-purple" title="Views or retweets cleared the high-reach bar for X mentions">
      High Reach
    </span>
  );
}
