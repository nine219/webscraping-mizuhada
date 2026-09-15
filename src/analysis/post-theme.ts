import { socialPool as pool, socialQuery as query } from '../db/social-client';
import { getGeminiModel, markCurrentKeyExhausted, parseRetryAfterMs, DEFAULT_MODEL } from './gemini-client';
import { chatCompleteDeepSeek, hasDeepSeekKey } from './llm-client';
import { getAiSettings } from '../config/settings-loader';
import { logAiUsage } from './ai-usage';

export const CONTENT_THEMES = [
  'Product Review',
  'Tutorial / How-to',
  'Unboxing',
  'Comparison',
  'Routine / GRWM',
  'Before / After',
  'Challenge / Trend',
  'Educational',
  'Lifestyle / Vlog',
  'Promotion / Sale',
  'Podcast',
  'Other',
] as const;

export type ContentTheme = (typeof CONTENT_THEMES)[number];

interface PostToClassify {
  post_id: string;
  caption: string | null;
  hashtags: string[] | null;
}

const BATCH_SIZE = 20;
const KEYS_RETRIES = 10;

function buildPrompt(posts: PostToClassify[]): string {
  return `You are a content classifier for Thai beauty/skincare TikTok posts.

Classify each post into exactly one theme from this list. Each theme has a definition — use it to disambiguate, don't guess from keywords alone:

- Product Review: centers on ONE specific product (named or shown), gives opinion/rating/experience ("ใช้แล้วเป็นไง", "รีวิว", pros/cons). Still Product Review even if it explains ingredients, how it works, or gives tips — as long as it's tied to that specific product.
- Tutorial / How-to: step-by-step instructions for HOW to do something (apply makeup, mix skincare steps). Not primarily an opinion on one product.
- Unboxing: opening/first look at a package or haul, minimal usage opinion yet.
- Comparison: explicitly compares 2+ products/brands side by side.
- Routine / GRWM: sequence of multiple products used in a routine (morning/night/get-ready-with-me), no single product is the focus.
- Before / After: visual or described transformation over time, result-focused.
- Challenge / Trend: participating in a TikTok trend/challenge/sound, not primarily about a product.
- Educational: general knowledge NOT tied to a specific product — skin science, ingredient explainers in the abstract, myth-busting, skin type advice. If a specific product is named with opinion/experience, prefer Product Review instead.
- Lifestyle / Vlog: daily life content where beauty is incidental, not the focus.
- Promotion / Sale: discount codes, sale announcements, affiliate/ad calls-to-action as the main point.
- Podcast: talk-show / long-form conversation format.
- Other: none of the above fit.

Disambiguation priority: if a post names/shows a specific product AND gives opinion or experience about it, always choose Product Review over Educational or Tutorial / How-to, even if it also explains ingredients or how-to-use steps.

Examples:
1. Caption "รีวิวเซรั่มตัวนี้ใช้ 2 อาทิตย์ หน้าใสขึ้นจริง ส่วนผสมมี niacinamide ช่วยลดจุดด่างดำ" → Product Review (named product + personal result, the ingredient mention doesn't make it Educational).
2. Caption "Niacinamide คืออะไร ทำไมถึงช่วยผิวกระจ่างใส ใช้ยังไงให้ได้ผล" (no specific product named) → Educational.
3. Caption "How to layer skincare: cleanser → toner → serum → moisturizer, step by step" (no single product opinion) → Tutorial / How-to.

Return ONLY a JSON array, one object per post, with keys: post_id, theme.
The theme value must be exactly one of the strings above.

Posts:
${JSON.stringify(posts.map((p) => ({
    post_id: p.post_id,
    caption: (p.caption ?? '').slice(0, 300),
    hashtags: p.hashtags ?? [],
  })))}`;
}

function parseThemeResponse(text: string, results: Map<string, ContentTheme>): void {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in response');
  const parsed = JSON.parse(jsonMatch[0]) as Array<{ post_id: string; theme: string }>;
  for (const item of parsed) {
    const theme = CONTENT_THEMES.includes(item.theme as ContentTheme)
      ? (item.theme as ContentTheme)
      : 'Other';
    results.set(item.post_id, theme);
  }
}

async function classifyThemeBatch(
  posts: PostToClassify[],
): Promise<Map<string, ContentTheme>> {
  const results = new Map<string, ContentTheme>();
  if (posts.length === 0) return results;

  const ai = await getAiSettings();
  const prompt = buildPrompt(posts);

  if (ai.provider === 'deepseek') {
    if (!hasDeepSeekKey()) {
      console.warn('[PostTheme] Provider=deepseek but no DEEPSEEK_API_KEY set');
      return results;
    }
    try {
      const r = await chatCompleteDeepSeek([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 2000 });
      if (r.text) {
        parseThemeResponse(r.text, results);
        logAiUsage({ provider: 'deepseek', model: r.model, purpose: 'post-theme', tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null, success: true }).catch(() => {});
      } else {
        logAiUsage({ provider: 'deepseek', model: r.model, purpose: 'post-theme', tokensIn: null, tokensOut: null, success: false, errorMessage: 'empty response' }).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PostTheme] DeepSeek batch failed:', msg.slice(0, 120));
      logAiUsage({ provider: 'deepseek', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', purpose: 'post-theme', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
    }
    return results;
  }

  for (let attempt = 0; attempt < KEYS_RETRIES; attempt++) {
    const model = getGeminiModel(DEFAULT_MODEL);
    if (!model) {
      console.warn('[PostTheme] No Gemini keys available — skipping batch');
      return results;
    }

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      });
      parseThemeResponse(result.response.text(), results);
      logAiUsage({
        provider: 'gemini', model: DEFAULT_MODEL, purpose: 'post-theme',
        tokensIn: result.response.usageMetadata?.promptTokenCount ?? null,
        tokensOut: result.response.usageMetadata?.candidatesTokenCount ?? null,
        success: true,
      }).catch(() => {});
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      if (isQuota) {
        markCurrentKeyExhausted(parseRetryAfterMs(msg));
      } else {
        console.error('[PostTheme] Batch classification failed:', msg.slice(0, 120));
        logAiUsage({ provider: 'gemini', model: DEFAULT_MODEL, purpose: 'post-theme', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
        return results;
      }
    }
  }

  console.warn('[PostTheme] All key rotation attempts exhausted for this batch');
  return results;
}

// Posts currently being classified — /api/command-center/top-ugc calls this
// synchronously in the request path with no dedup, so two dashboard tabs (or
// any two concurrent requests) hitting the same page before the first
// classification's write-back lands would each independently re-issue the
// same Gemini calls for the same posts. Skip anything already in flight.
const inFlight = new Set<string>();

export async function classifyPostThemes(postIds: string[]): Promise<Map<string, ContentTheme>> {
  const toClassify = postIds.filter((id) => !inFlight.has(id));
  if (toClassify.length === 0) return new Map();
  toClassify.forEach((id) => inFlight.add(id));

  try {
    return await classifyPostThemesInner(toClassify);
  } finally {
    toClassify.forEach((id) => inFlight.delete(id));
  }
}

async function classifyPostThemesInner(postIds: string[]): Promise<Map<string, ContentTheme>> {
  const rows = await query<PostToClassify>(
    `SELECT post_id, caption, hashtags
     FROM tiktok_posts
     WHERE post_id = ANY($1::text[])`,
    [postIds],
  );

  const results = new Map<string, ContentTheme>();
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchResults = await classifyThemeBatch(batch);
    for (const [postId, theme] of batchResults) {
      results.set(postId, theme);
    }
    if (i + BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (results.size > 0) {
    const entries = [...results.entries()];
    const values: unknown[] = [];
    const placeholders = entries.map(([_, __], i) => {
      values.push(entries[i][0], entries[i][1]);
      return `($${i * 2 + 1}, $${i * 2 + 2})`;
    });
    await pool.query(
      `UPDATE tiktok_posts AS tp
       SET theme = v.theme
       FROM (VALUES ${placeholders.join(', ')}) AS v(post_id, theme)
       WHERE tp.post_id = v.post_id`,
      values,
    );
  }

  return results;
}

export async function classifyMissingPostThemes(limit = 100): Promise<number> {
  const rows = await query<{ post_id: string }>(
    `SELECT post_id
     FROM tiktok_posts
     WHERE source_type = 'search'
       AND theme IS NULL
       AND caption IS NOT NULL
       AND LENGTH(TRIM(caption)) > 0
     ORDER BY posted_at DESC
     LIMIT $1`,
    [limit],
  );

  if (rows.length === 0) return 0;

  const results = await classifyPostThemes(rows.map((r) => r.post_id));
  return results.size;
}
