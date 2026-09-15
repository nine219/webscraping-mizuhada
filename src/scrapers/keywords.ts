/**
 * Keyword definitions for TikTok search and social content matching.
 *
 * SEARCH_TARGETS   — own-brand searches: each post is attributed to that brand
 * CATEGORY_KEYWORDS — generic skincare/beauty terms: posts attributed via matchBrandSlug()
 *                     (skipped if no own brand is mentioned in the content)
 */

// ── Own-brand search targets ───────────────────────────────────────────────────
export const SEARCH_TARGETS: Array<{ brandSlug: string; keywords: string[] }> = [
  {
    brandSlug: 'mizumi',
    keywords: [
      'mizumi',
      'มิซึมิ',
      'มิซูมิ',
      'มิสูมิ',
      'มิซึมี่',
      'mizumi thailand',
      'mizumi skincare',
      'mizumi review',
      'mizumi mini',
      'mizumi global',
      'mizumiglobal',
      'mizumi.mini',
      'รีวิว mizumi',
      'ครีม mizumi',
      '#mizumi',
      '#มิซึมิ',
      '#mizumithailand',
      '#mizumiglobal',
      'มิซึมิ สกินแคร์',
      'มิซึมิ รีวิว',
    ],
  },
  {
    brandSlug: 'bomi',
    keywords: [
      'bomi',
      'โบมิ',
      'bomi beauty',
      'bomi thailand',
      'bomi review',
      'รีวิว bomi',
      '#bomi',
      '#โบมิ',
      '#bomibeauty',
      'โบมิ บิวตี้',
      'โบมี้',
      'โบมิ รีวิว',
    ],
  },
  {
    brandSlug: 'gentle-colors',
    keywords: [
      'gentlecolors',
      'gentle colors',
      'gentle colors global',
      'gentlecolorsglobal',
      'เจนเทิลคัลเลอร์ส',
      'เจ็นเทิลคัลเลอร์ส',
      'เจนเทิลคัลเลอ',
      'gentle colors thailand',
      'gentle colors review',
      'รีวิว gentle colors',
      '#gentlecolors',
      '#gentlecolorsthailand',
      '#gentlecolorsglobal',
      'เจนเทิลคัลเลอร์ส คอนซีลเลอร์',
    ],
  },
];

// ── Category / trend keywords ─────────────────────────────────────────────────
// Broader skincare terms — used to catch UGC in our brands' product categories.
// Posts from these searches are only saved when an own-brand mention is found.
export const CATEGORY_KEYWORDS: string[] = [
  // Company name (parent of all 3 brands) — not brand-specific on its own,
  // still requires matchBrandSlug() to hit an own-brand keyword before saving.
  'mizuhada',
  'มิซูฮาดะ',
  '#mizuhada',

  // Sunscreen / sensitive skin
  'กันแดดผิวแพ้ง่าย',
  'ครีมกันแดดผิวแพ้',
  'กันแดด sensitive skin',
  'sunscreen sensitive skin thai',
  'กันแดด',
  'ครีมกันแดด',
  'สิว',
  'ผิวแพ้ง่าย',
  'มาร์ก',
  'มาส์ก',
  'มาสก์',

  // Toning / brightening
  'โทนเนอร์ผิวแพ้',
  'เซรั่มผิวหน้า',
  'วิตซี ผิว',
  'ผิวกระจ่างใส',
  'ลดรอยสิว',

  // Korean skincare
  'สกินแคร์เกาหลี',
  'kbeauty thailand',

  // General beauty / skincare
  'สกินแคร์ผิวแพ้',
  'รีวิวสกินแคร์',
  'ผิวแพ้ง่าย',
  'รีวิวบิวตี้',
  'skincare thailand',

  // Makeup — concealer / corrector (Gentle Colors category)
  'คอนซีลเลอร์',
  'คอนซีลเลอร์จบทุกรอย',
  'concealer',
  'corrector',
  'คอนซีลเลอร์ผิวแพ้',
  'คอนซีลเลอร์ปกปิดรอยดำ',
  'รีวิวคอนซีลเลอร์',
  'แต่งหน้าปกปิดรอยสิว',
  'เครื่องสำอางผิวแพ้',
  'makeup sensitive skin thai',
];

// ── Chinese-platform search keywords ──────────────────────────────────────────
// Xiaohongshu / Douyin / Weibo. Brand names stay Latin (Chinese users write them
// in English); category terms are in Chinese. Comment in () = English meaning.
export const CN_SEARCH_KEYWORDS: string[] = [
  // Own brands (Latin — as written on CN platforms). Bomi excluded — not
  // searched on XHS per product decision.
  'mizumi',
  'gentle colors',
  // Category — Chinese
  '泰国防晒霜',        // thai sunscreen
  '泰国护肤',          // thai skincare
  '泰国美妆',          // thai cosmetics / makeup
  '敏感肌防晒',        // sensitive-skin sunscreen
  '敏感肌护肤',        // sensitive-skin skincare
  '泰国小众护肤',      // niche thai skincare
  '遮瑕',              // concealer
  '泰国遮瑕',          // thai concealer
];

// ── Own brand TikTok handles ──────────────────────────────────────────────────
// Posts from these accounts are already captured by the feed scraper.
// Search scraper skips them so UGC results stay clean.
export const OWN_BRAND_HANDLES = new Set([
  'mizumi_official',
  'gentlecolorsofficial',
  'bomiofficial_th',
  'gentlecolorsglobal',
  'mizumi.mini',
  'mizumiglobal',
]);

// Creators we already work with / own staff accounts — excluded from the
// influencer leaderboard so it only surfaces NEW sponsorship prospects.
// Add TikTok handles here (no '@'), e.g. 'nuimizumi'. Matched case-insensitively.
export const OWN_INFLUENCERS: string[] = [
  'nuimizumi',
];

// ── Brand matching ─────────────────────────────────────────────────────────────
// Maps brand slug → keyword variants for detecting own-brand mentions in content
export const BRAND_KEYWORDS: Record<string, string[]> = Object.fromEntries(
  SEARCH_TARGETS.map(({ brandSlug, keywords }) => [brandSlug, keywords]),
);

// Backwards-compat alias used by douyin/weibo/xiaohongshu scrapers
export const SOCIAL_KEYWORDS = BRAND_KEYWORDS;

// MizuMi's Chinese-market brand ambassadors — a huge share of genuine XHS
// mentions reference them by name instead of saying "mizumi" (confirmed via
// manual review of raw search results, 2026-07-10: "陈哲远同款防晒" etc. never
// says the brand name at all). Ambiguous on their own (pure fan content with no
// product tie-in also matches) — safe to list here anyway since every match
// still goes through Gemini verification before being kept, same as any other
// candidate (see verifyNotesAreRelevant in xhs-search.ts).
const MIZUMI_AMBASSADOR_KEYWORDS = [
  '陈哲远',       // Chen Zheyuan — primary ambassador
  'Chen Zheyuan', // English romanization — titles skew Latin-script on MY/TH-facing posts
  'ChenZheyuan',
  'เฉินเจ๋อหย่วน', // Thai transliteration — seen in TH-market hashtags
  'PP Krit',      // secondary ambassador (bare "PP" too short/generic to match safely)
  'Pond Phuwin',
  'PondPhuwin',
];

// XHS-only brand matcher — deliberately separate from BRAND_KEYWORDS (which still
// includes Bomi for TikTok/IG) so a note mentioning "bomi" via some OTHER search
// keyword can never get attributed to Bomi on XHS, matching the "no Bomi on XHS"
// product decision (see CN_SEARCH_KEYWORDS above).
export const XHS_BRAND_KEYWORDS: Record<string, string[]> = Object.fromEntries(
  SEARCH_TARGETS.filter(({ brandSlug }) => brandSlug !== 'bomi').map(({ brandSlug, keywords }) => [
    brandSlug,
    brandSlug === 'mizumi'
      ? [...keywords, '满水美', ...MIZUMI_AMBASSADOR_KEYWORDS] // 满水美 = brand's own XHS account display name
      : keywords,
  ]),
);

// Keywords that can match non-skincare content (K-pop names, people, etc.)
// Posts matching ONLY one of these need Gemini / context verification before saving.
// Map: brandSlug → Set of ambiguous keyword strings (lowercase)
export const AMBIGUOUS_KEYWORDS: Record<string, Set<string>> = {
  'bomi': new Set(['bomi', 'bomi review']),
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Substring match, but rejects hits glued to other Latin word chars —
// "bomi" must NOT match inside "bomi_conejita" or "minibomi". Thai script has
// no delimiter convention, so Thai terms still match like a plain substring
// (Thai chars are outside [A-Za-z0-9_], so the boundary check is a no-op for them).
export function containsKeyword(text: string, term: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(term)}(?![A-Za-z0-9_])`, 'i');
  return re.test(text);
}

export interface BrandMatchCandidate {
  slug: string;
  type: 'own' | 'competitor';
  /** Brand display name — the only signal used for a competitor (see below). */
  name: string;
  /** Keyword variants to check against. Own brands only — ignored for competitors. Falls back to the static BRAND_KEYWORDS entry if omitted (old behavior). */
  keywords?: string[];
}

/**
 * Resolves which brand (if any) a piece of content is about, from an explicit
 * candidate list passed by the caller — NOT a fixed global dict. Callers
 * should pass live Settings-edited keywords (settings.keywords.tiktok/twitter)
 * here instead of whatever was hardcoded in SEARCH_TARGETS at deploy time;
 * this file can't read Settings itself (settings-loader.ts imports FROM here,
 * so the reverse would be circular) — that's why the live data has to come
 * in as a parameter instead of being fetched inside this function.
 *
 * Own brands are checked against their `keywords` list (or the static
 * BRAND_KEYWORDS fallback if none given). Competitor brands have no
 * maintained keyword list — matchBrandSlug's job never covered them at all
 * until now — so they're matched against just their bare `name` instead: a
 * coarser signal, but the only one available for a brand nobody's curated
 * search terms for.
 */
export function matchBrandSlug(content: string, candidates: BrandMatchCandidate[]): string | null {
  for (const c of candidates) {
    if (c.type === 'competitor') {
      // Curated keyword_terms rows exist (settings-loader.ts's
      // getCompetitorTikTokKeywords()) — use those instead of the bare name.
      // A generic competitor name like "วิตซี"/"VC" (both just mean "vitamin
      // C") false-positives against nearly all vitamin-C skincare content if
      // matched bare, which is exactly the bug curated keywords fix.
      if (c.keywords && c.keywords.length > 0) {
        if (c.keywords.some((kw) => containsKeyword(content, kw))) return c.slug;
        continue;
      }
      if (containsKeyword(content, c.name)) return c.slug;
      continue;
    }
    const keywords = c.keywords ?? BRAND_KEYWORDS[c.slug] ?? [];
    if (keywords.some((kw) => containsKeyword(content, kw))) return c.slug;
  }
  return null;
}

// Same as matchBrandSlug but against XHS_BRAND_KEYWORDS (no Bomi) — use this,
// not matchBrandSlug, anywhere that infers a brand from XHS note content.
export function matchBrandSlugXhs(content: string): string | null {
  for (const [slug, keywords] of Object.entries(XHS_BRAND_KEYWORDS)) {
    for (const kw of keywords) {
      if (containsKeyword(content, kw)) return slug;
    }
  }
  return null;
}
