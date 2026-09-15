// TikTok Shop content detection.
//
// Marks posts that carry a TikTok Shop product anchor (affiliate/shop-tagged
// content) so the dashboard can badge it — never excludes or re-ranks it,
// this module only decides `is_shop_content` / `shop_signal`.
//
// Detection order (cheapest/most reliable first — verified against 30 live
// sample rows plus a handful of direct live-DB spot checks):
//   1. `raw_data.AnchorTypes` array containing 33 — a perfect 1:1 predictor
//      of real TikTok Shop presence in the sample (18/18 positive matches,
//      0 mismatches, 12/12 true negatives).
//   2. Confirm + extract detail: `raw_data.anchors` is an array; each
//      anchor's `.extra` field is a JSON-ENCODED STRING (not an object) —
//      `JSON.parse(anchor.extra)` yields an array of items. Find the item
//      where `item.component_key === 'anchor_shop'`. That item's OWN
//      `.extra` is ALSO a JSON-encoded string; `JSON.parse(item.extra)`
//      yields `{ product_id, seller_id, source: "TikTok Shop", seo_url,
//      title, market_price, currency, categories, skus }`. Used only to
//      enrich `shop_signal` with a product id/title — if this step fails
//      (malformed data), step 1's pre-filter result still stands.
//   3. Caption/hashtag regex — last resort only, used when step 1 finds
//      nothing. Caught 0/18 real shop posts in the sample; kept as a cheap
//      fallback, not a real detector.
//
// NOTE: `isAd`/`adAuthorization` are TikTok's separate paid-ad disclosure
// toggle — correlated with shop presence but NOT identical (3 sampled
// isAd:true rows had no shop item; 1 shop row had isAd:false). Never gate
// `isShop` on `isAd`.

const SHOP_ANCHOR_TYPE = 33;
const SHOP_COMPONENT_KEY = 'anchor_shop';
const SHOP_CAPTION_REGEX = /TikTokShop|TikTokMadeMeBuyIt|เลือกซื้อ|ช้อปเลย/i;

interface ShopAnchorExtra {
  product_id?: string | number;
  seller_id?: string | number;
  source?: string;
  seo_url?: string;
  title?: string;
  market_price?: number;
  currency?: string;
  categories?: unknown;
  skus?: unknown;
}

export interface ShopDetectionResult {
  isShop: boolean;
  signal: string | null;
}

/**
 * Detect whether a scraped TikTok post carries a TikTok Shop product anchor.
 * Defensive by design: `rawItem`'s shape varies across API versions and can
 * be malformed, so every parse is try/caught — this function must NEVER
 * throw. Any unexpected shape falls back to `{ isShop: false, signal: null }`
 * (or to the caption regex fallback, if that fires).
 */
export function detectShopContent(rawItem: unknown, caption: string | null): ShopDetectionResult {
  try {
    const structural = detectFromAnchors(rawItem);
    if (structural) return structural;
  } catch {
    // Malformed raw_data shape — fall through to the caption fallback below.
  }

  return detectFromCaption(caption);
}

function detectFromAnchors(rawItem: unknown): ShopDetectionResult | null {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const item = rawItem as Record<string, unknown>;

  const anchorTypes = item.AnchorTypes;
  if (!Array.isArray(anchorTypes) || !anchorTypes.includes(SHOP_ANCHOR_TYPE)) return null;

  // Pre-filter fired — this alone was a 0-mismatch predictor in the sample.
  // Try to enrich shop_signal with product detail; if extraction fails,
  // still report the pre-filter as a positive rather than downgrading it.
  const detail = extractShopDetail(item);
  if (detail && detail.product_id != null) {
    const label = detail.title ? `${detail.product_id}:${detail.title}` : String(detail.product_id);
    return { isShop: true, signal: `anchor_shop:${label}` };
  }

  return { isShop: true, signal: 'anchor_types:33' };
}

function extractShopDetail(item: Record<string, unknown>): ShopAnchorExtra | null {
  const anchors = item.anchors;
  if (!Array.isArray(anchors)) return null;

  for (const anchor of anchors) {
    if (!anchor || typeof anchor !== 'object') continue;
    const rawExtra = (anchor as Record<string, unknown>).extra;
    if (typeof rawExtra !== 'string') continue;

    let items: unknown;
    try {
      items = JSON.parse(rawExtra);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;

    const shopItem = items.find(
      (it) => it && typeof it === 'object' && (it as Record<string, unknown>).component_key === SHOP_COMPONENT_KEY
    ) as Record<string, unknown> | undefined;
    if (!shopItem) continue;

    const innerExtra = shopItem.extra;
    if (typeof innerExtra !== 'string') continue;

    try {
      const parsed = JSON.parse(innerExtra) as ShopAnchorExtra;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

function detectFromCaption(caption: string | null): ShopDetectionResult {
  if (caption && SHOP_CAPTION_REGEX.test(caption)) {
    return { isShop: true, signal: 'caption_regex' };
  }
  return { isShop: false, signal: null };
}
