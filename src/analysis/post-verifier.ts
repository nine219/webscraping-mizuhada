/**
 * Post relevance verifier — guards against false-positive UGC matches.
 *
 * Tier 1: skincare context keyword check (instant, no API)
 * Tier 2: Gemini batch classification (handles ambiguous brand names like "bomi")
 *
 * Used by tiktok-search.ts before upsert for posts matching ambiguous keywords.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

// Thai + English skincare/beauty terms that confirm a post is product-related
const SKINCARE_CONTEXT_WORDS = [
  // Thai
  'ครีม', 'สกินแคร์', 'กันแดด', 'ผิว', 'สิว', 'เซรั่ม',
  'มาส์ก', 'มาสก์', 'มาก', 'คอนซีลเลอร์', 'บิวตี้', 'บำรุง',
  'ทำความสะอาด', 'มอยเจอร์', 'รีวิว', 'โทนเนอร์', 'ฟาวเดชั่น',
  'ลิปสติก', 'บลัชออน', 'แป้ง', 'เมคอัพ', 'ผลิตภัณฑ์',
  // English
  'skincare', 'skin care', 'beauty', 'cream', 'serum', 'sunscreen',
  'review', 'makeup', 'make up', 'moisturizer', 'toner', 'concealer',
  'lotion', 'essence', 'mask', 'foundation', 'spf', 'uv',
];

export function hasSkincareContext(text: string): boolean {
  const lower = text.toLowerCase();
  return SKINCARE_CONTEXT_WORDS.some((w) => lower.includes(w));
}

const BRAND_DESCRIPTIONS: Record<string, string> = {
  'mizumi':        'MizuMi — Thai skincare brand (sunscreen, serum, moisturizer for sensitive skin)',
  'bomi':          'Bomi Beauty — Thai cosmetics/beauty brand (NOT Apink member Bomi, NOT any K-pop idol)',
  'gentle-colors': 'Gentle Colors — Thai makeup brand (concealer, corrector)',
};

function getModel() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') return null;
  const client = new GoogleGenerativeAI(key);
  return client.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function verifyBatch(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  posts: Array<{ id: string; caption: string }>,
  brandSlug: string,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const brandDesc = BRAND_DESCRIPTIONS[brandSlug] ?? brandSlug;

  const items = posts.map((p, i) => ({
    i,
    text: (p.caption ?? '').slice(0, 400),
  }));

  const prompt = `You are a content filter for ${brandDesc}.

Each entry is a TikTok caption. Decide if it's about the BRAND's actual product (cosmetics/skincare).
- YES: reviews, unboxings, hauls, usage, recommendations of the brand's product
- NO: content about K-pop idols, sports figures, people named bomi/mizumi, unrelated products

Reply ONLY as a JSON array with no other text: [{"i": 0, "ok": true}, {"i": 1, "ok": false}, ...]

Captions:
${JSON.stringify(items)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const match = text.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error('No JSON array in Gemini response');

      const parsed = JSON.parse(match[0]) as Array<{ i: number; ok: boolean }>;
      for (const entry of parsed) {
        const post = posts[entry.i];
        if (post) results.set(post.id, entry.ok === true);
      }
      // Fill any missing entries as false (conservative)
      for (const post of posts) {
        if (!results.has(post.id)) results.set(post.id, false);
      }
      return results;
    } catch (err: unknown) {
      const msg = String(err);
      const isRateLimit = msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
      if (isRateLimit && attempt < 3) {
        const wait = Math.pow(2, attempt + 1) * 4000; // 8s, 16s, 32s
        console.log(`[PostVerifier] Rate limited — retry ${attempt + 1}/3 in ${wait / 1000}s`);
        await sleep(wait);
      } else {
        console.error('[PostVerifier] Gemini error:', msg.slice(0, 200));
        break;
      }
    }
  }

  // Gemini failed — fall back to skincare context check
  console.log('[PostVerifier] Gemini unavailable — using skincare context fallback');
  for (const post of posts) {
    results.set(post.id, hasSkincareContext(post.caption));
  }
  return results;
}

/**
 * Verify that posts are actually about the brand's product.
 *
 * Tier 1: posts with skincare context words are approved immediately (no API call).
 * Tier 2: remaining posts go to Gemini in batches of 10, with retry on rate limits.
 *         If Gemini is unavailable, falls back to Tier 1 (context check only).
 *
 * Returns Set of approved post IDs.
 */
export async function verifyPostsRelevance(
  posts: Array<{ id: string; caption: string }>,
  brandSlug: string,
): Promise<Set<string>> {
  if (posts.length === 0) return new Set();

  // Tier 1: instant context check
  const approved = new Set<string>();
  const needsGemini: Array<{ id: string; caption: string }> = [];

  for (const post of posts) {
    if (hasSkincareContext(post.caption)) {
      approved.add(post.id);
    } else {
      needsGemini.push(post);
    }
  }

  if (needsGemini.length === 0) return approved;

  const model = getModel();
  if (!model) {
    console.log(`[PostVerifier] Gemini not configured — ${needsGemini.length} borderline posts rejected`);
    // Conservative: reject borderline posts without Gemini
    return approved;
  }

  console.log(`[PostVerifier] Verifying ${needsGemini.length} borderline posts via Gemini...`);
  const BATCH_SIZE = 10;

  for (let i = 0; i < needsGemini.length; i += BATCH_SIZE) {
    const batch = needsGemini.slice(i, i + BATCH_SIZE);
    const batchResults = await verifyBatch(model, batch, brandSlug);

    for (const [id, ok] of batchResults) {
      if (ok) approved.add(id);
    }

    // Pause between batches to avoid rate limiting (Gemini free: 15 RPM)
    if (i + BATCH_SIZE < needsGemini.length) {
      await sleep(4500);
    }
  }

  return approved;
}
