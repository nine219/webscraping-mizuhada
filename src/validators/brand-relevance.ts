import { hasSkincareContext } from '../analysis/post-verifier';
import { getGeminiModel, markCurrentKeyExhausted, parseRetryAfterMs, DEFAULT_MODEL } from '../analysis/gemini-client';
import { chatCompleteDeepSeek, hasDeepSeekKey } from '../analysis/llm-client';
import { getAiSettings } from '../config/settings-loader';
import { logAiUsage } from '../analysis/ai-usage';

const BATCH_SIZE = 20;
const MODEL = process.env.GEMINI_RELEVANCE_MODEL ?? DEFAULT_MODEL;

export interface RelevanceInput {
  id: string;
  text: string;
}

// Conservative fallback when Gemini is unavailable or quota-exhausted.
// Requires at least one skincare keyword — rejects posts with no product context.
function contextFallback(posts: RelevanceInput[]): Set<string> {
  const relevant = new Set<string>();
  let rejected = 0;
  for (const p of posts) {
    if (hasSkincareContext(p.text)) {
      relevant.add(p.id);
    } else {
      rejected++;
      if (process.env.TIKTOK_DEBUG === '1') {
        console.log(`  [relevance:fallback] REJECTED "${p.text.slice(0, 60)}"`);
      }
    }
  }
  if (rejected > 0) {
    console.log(`  [relevance] Context fallback: rejected ${rejected}/${posts.length} posts (no skincare terms)`);
  }
  return relevant;
}

// Returns null when the response has no parseable JSON array — caller falls back.
function parseRelevanceResponse(text: string, posts: RelevanceInput[], brandName: string): Set<string> | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]) as Array<{ i: number; relevant: boolean; reason?: string }>;
  const relevant = new Set<string>();
  let filtered = 0;
  for (const { i, relevant: rel, reason } of parsed) {
    if (!posts[i]) continue;
    if (rel) {
      relevant.add(posts[i].id);
    } else {
      filtered++;
      if (process.env.TIKTOK_DEBUG === '1') {
        console.log(`  [relevance] FILTERED "${posts[i].text.slice(0, 60)}" — ${reason ?? ''}`);
      }
    }
  }
  if (filtered > 0) console.log(`  [relevance] Filtered ${filtered}/${posts.length} irrelevant posts for "${brandName}"`);
  return relevant;
}

// Brand-specific disambiguation, learned from manually reviewing raw XHS search
// results (2026-07-10). Injected into the prompt below when relevant — applies
// on any platform, not just XHS, since these facts (ambassadors, name collisions)
// aren't platform-specific.
const BRAND_CONTEXT: Record<string, string> = {
  mizumi: `
Extra context for MizuMi specifically:
- MizuMi's brand ambassadors are 陈哲远 (Chen Zheyuan), PP Krit, and Pond Phuwin. A post about one of them USING, WEARING, or PROMOTING a sunscreen/skincare product IS relevant even if it never says "MizuMi" by name — assume it refers to MizuMi's product unless the post clearly names a different brand. Pure fan content about these people (event photos, "he's so handsome", concert coverage) with NO product/skincare mention is NOT relevant.
- "满水美" is MizuMi's own account name/Chinese branding — treat it the same as "MizuMi".
- "Mizumi" is also the name of an unrelated hotel/restaurant — travel/dining/hospitality posts using that name are NOT this brand.
- Competitor Thai/regional sunscreen brands seen mixed into the same search results — a post that is clearly about one of THESE and doesn't separately mention MizuMi is NOT relevant, even though it's the same "Thai sunscreen" category: Mistine (蜜丝婷), Pala. Also watch for OUIMIS (微米丝) and Merci — likely competitor product lines, treat the same way if the post is only about them.
`,
};

async function checkBatch(
  posts: RelevanceInput[],
  brandName: string,
  brandSlug: string,
): Promise<Set<string>> {

  const prompt = `You are filtering social media posts for a Thai beauty brand intelligence platform.

Brand: "${brandName}" (${brandSlug}) — a Thai beauty/skincare brand under the Mizuhada Group (parent company; also owns sibling brands MizuMi, Bomi, Gentle Colors).
${BRAND_CONTEXT[brandSlug] ?? ''}
For each post, decide if it GENUINELY mentions this brand as a product, company, brand image, or beauty item.

Return relevant=false if the brand name appears only as:
- A K-pop/celebrity/idol name (e.g. "Bomi" from APINK, not the skincare brand)
- An unrelated username or handle
- A song, video, or audio title
- An unrelated foreign word that coincidentally matches

Return relevant=true if the post:
- Reviews, recommends, or criticises the brand's products
- Compares this brand to other skincare brands
- Discusses price, packaging, texture, efficacy, or scent of the brand
- Uses the brand hashtag in a clear product/beauty context
- Is clearly about the brand's products even if just briefly mentioned
- Is a vlog, day-in-life, workplace, event, or behind-the-scenes clip tagged with BOTH "Mizuhada"/"มิซูฮาดะ" (the parent company) AND the brand name/hashtag — this is brand-image content (e.g. staff/creator content tied to the brand), not just an unrelated tag list, even without explicit product talk

Posts (indexed):
${JSON.stringify(posts.map((p, i) => ({ i, text: p.text.slice(0, 500) })), null, 2)}

Return a JSON array with one object per post:
[{"i": 0, "relevant": true, "reason": "brief reason"}, ...]`;

  const ai = await getAiSettings();

  if (ai.provider === 'deepseek') {
    if (!hasDeepSeekKey()) {
      console.warn('[BrandRelevance] Provider=deepseek but no DEEPSEEK_API_KEY set — using context fallback');
      return contextFallback(posts);
    }
    try {
      const r = await chatCompleteDeepSeek([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 2000 });
      const parsed = r.text ? parseRelevanceResponse(r.text, posts, brandName) : null;
      logAiUsage({
        provider: 'deepseek', model: r.model, purpose: 'brand-relevance',
        tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null,
        success: parsed !== null, errorMessage: parsed !== null ? null : 'unparseable/empty response',
      }).catch(() => {});
      if (parsed !== null) return parsed;
      console.warn(`[BrandRelevance] DeepSeek response unusable for "${brandName}" — using context fallback`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[BrandRelevance] DeepSeek error — using context fallback: ${msg.slice(0, 80)}`);
      logAiUsage({ provider: 'deepseek', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', purpose: 'brand-relevance', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
    }
    return contextFallback(posts);
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const model = getGeminiModel(MODEL);
    if (!model) return contextFallback(posts);

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = parseRelevanceResponse(text, posts, brandName);
      if (parsed === null) {
        console.warn(`[BrandRelevance] Could not parse response for "${brandName}" — using context fallback`);
        logAiUsage({ provider: 'gemini', model: MODEL, purpose: 'brand-relevance', tokensIn: null, tokensOut: null, success: false, errorMessage: 'unparseable response' }).catch(() => {});
        return contextFallback(posts);
      }
      logAiUsage({
        provider: 'gemini', model: MODEL, purpose: 'brand-relevance',
        tokensIn: result.response.usageMetadata?.promptTokenCount ?? null,
        tokensOut: result.response.usageMetadata?.candidatesTokenCount ?? null,
        success: true,
      }).catch(() => {});
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      if (isQuota) {
        markCurrentKeyExhausted(parseRetryAfterMs(msg));
      } else {
        console.warn(`[BrandRelevance] Gemini error — using context fallback: ${msg.slice(0, 80)}`);
        logAiUsage({ provider: 'gemini', model: MODEL, purpose: 'brand-relevance', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
        return contextFallback(posts);
      }
    }
  }
  return contextFallback(posts);
}

/**
 * Filters posts to those genuinely relevant to the brand.
 * Primary: Gemini. Fallback: skincare context keyword check (conservative).
 */
export async function filterIrrelevantPosts(
  posts: RelevanceInput[],
  brandName: string,
  brandSlug: string,
): Promise<Set<string>> {
  if (posts.length === 0) return new Set();

  const relevant = new Set<string>();
  for (let i = 0; i < posts.length; i += BATCH_SIZE) {
    const batch = posts.slice(i, i + BATCH_SIZE);
    const batchRelevant = await checkBatch(batch, brandName, brandSlug);
    for (const id of batchRelevant) relevant.add(id);
    if (i + BATCH_SIZE < posts.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return relevant;
}
