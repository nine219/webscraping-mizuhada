'use client';

// Small badge marking TikTok Shop / affiliate-tagged content (see
// src/scrapers/tiktok/shop-detection.ts for how is_shop_content is derived).
// Purely presentational — shop content is never excluded or re-ranked
// anywhere, this just marks it. Shared across feed/search/post-detail (and
// the future Viral view) so all surfaces render it identically.
interface ShopBadgeProps {
  isShopContent: boolean | null | undefined;
  shopSignal?: string | null;
}

export function ShopBadge({ isShopContent, shopSignal }: ShopBadgeProps) {
  if (!isShopContent) return null;
  return (
    <span className="tag tag-amber" title={shopSignal ? `Signal: ${shopSignal}` : 'TikTok Shop content'}>
      🛍 Shop
    </span>
  );
}
