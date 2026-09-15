import { socialQuery as query, socialPool as pool } from '../db/social-client';
import { getGeminiModel, markCurrentKeyExhausted, parseRetryAfterMs, DEFAULT_MODEL } from './gemini-client';
import { chatCompleteWithUsage, chatCompleteDeepSeek, hasLlmKey, hasDeepSeekKey, activeProviderName } from './llm-client';
import { noiseExcludeSql } from './comments';
import { getAiSettings } from '../config/settings-loader';
import { logAiUsage } from './ai-usage';
import { alertUrgentNegativeComments, UrgentNegativeRow } from './spike-detection';

const BATCH_SIZE = 50;

type Sentiment = 'positive' | 'negative' | 'neutral' | 'question' | 'resale';
type BrandRelevance = 'on_topic' | 'other_brand';

interface SentimentResult {
  sentiment: Sentiment;
  score: number;
  topic: string;
  urgency: number | null;
  translated: string | null;
  brandRelevance: BrandRelevance;
}

const VALID: Sentiment[] = ['positive', 'negative', 'neutral', 'question', 'resale'];
const VALID_BRAND_RELEVANCE: BrandRelevance[] = ['on_topic', 'other_brand'];

// Parse a model's JSON-array response into the results map. Throws if no array.
function parseInto(results: Map<number, SentimentResult>, text: string): void {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in response');
  const parsed = JSON.parse(jsonMatch[0]) as Array<{
    id: number; sentiment: string; topic: string; score: number; urgency?: number | null; th?: string | null; brand_relevance?: string;
  }>;
  for (const item of parsed) {
    const sentiment = VALID.includes(item.sentiment as Sentiment)
      ? (item.sentiment as Sentiment)
      : 'neutral';
    // Urgency only applies to negative comments — model is told to omit/null it
    // otherwise. Clamp + round defensively in case it still sends a stray value.
    const rawUrgency = typeof item.urgency === 'number' ? item.urgency : null;
    const urgency = sentiment === 'negative' && rawUrgency != null
      ? Math.min(5, Math.max(1, Math.round(rawUrgency)))
      : null;
    // Translation only meaningful when the model actually returned Thai text
    // that differs from a "not needed" signal — empty string / same-as-input
    // means the comment was already Thai or English.
    const translated = typeof item.th === 'string' && item.th.trim() ? item.th.trim() : null;
    // Defaults to 'on_topic' — mirrors the sentiment fallback above. Most posts
    // only ever mention one brand, so "on_topic" is the right default whenever
    // the model omits the field or returns something unrecognized.
    const brandRelevance = VALID_BRAND_RELEVANCE.includes(item.brand_relevance as BrandRelevance)
      ? (item.brand_relevance as BrandRelevance)
      : 'on_topic';
    results.set(item.id, {
      sentiment,
      score: Math.min(1, Math.max(0, item.score ?? 0.5)),
      topic: item.topic ?? 'อื่นๆ',
      urgency,
      translated,
      brandRelevance,
    });
  }
}

interface CommentRow {
  id: number;
  content: string;
  brand_name: string;
  brand_slug: string;
  brand_type: string;
  platform: string;
  post_id: string | null;
  post_url: string | null;
  author_handle: string | null;
}

function resolveCommentUrl(r: CommentRow): string | null {
  if (r.post_url) return r.post_url;
  if (!r.post_id || !r.author_handle) return null;
  if (r.platform === 'tiktok') return `https://www.tiktok.com/@${r.author_handle}/video/${r.post_id}`;
  if (r.platform === 'twitter') return `https://x.com/${r.author_handle}/status/${r.post_id}`;
  return null;
}

async function classifyBatch(
  comments: Array<{ id: number; content: string; brand_name: string; platform?: string }>
): Promise<Map<number, SentimentResult>> {
  const results = new Map<number, SentimentResult>();

  const prompt = `You are a Thai beauty/skincare social-comment classifier. Comments are mostly Thai (some English/Chinese), often slang and emoji-heavy.

For each comment, classify:

- sentiment: one of "positive", "negative", "neutral", "question", "resale"
  - "positive": praise, satisfaction, recommendation — AND weak/implicit positive engagement signals, which are VERY common and must NOT be called neutral:
    • anticipation / excitement: "รอเลย", "รออยู่", "มาแล้ว", "ว้าว", "ตำเลย", "ต้องตำ", "ปังมาก"
    • saving / noting for later: "ปัก", "ปักหมุด", "จด", "จดไว้", "เซฟไว้", "บุ๊กมาร์ก"
    • want to try / buy (desire, not a question): "น่าลอง", "อยากลอง", "อยากได้", "อยากกินบ้าง"
    • following the creator: "กดตาม", "กดติดตามแล้ว", "ตามมาจาก", "มาจาก..."
    • affection / compliment: "น่ารัก", "สวย", "คุณพรี๊", "ชอบ", "เลิฟ", "🥰❤️"
    • efficacy testimonial = positive (topic=efficacy): "ทานสัปดาห์แรกผิวลื่นขึ้น", "ใช้แล้วดีขึ้น", "หน้าใส"
  - "negative": complaint, disappointment, warning, "ของปลอม", "แพ้", "ไม่เห็นผล", "แตก/รั่ว/ไหล", "แพง" (as a complaint)
  - "question": ANY inquiry — price, where to buy, how to use, suitability, "...มั้ย/ไหม/หรอ/คะ?", "ขายที่ไหน", "ทานพร้อม...ได้ไหม", "กี่บาท". Watch out: resale posts often borrow question-particle phrasing as a sales hook ("มีใครสนใจมั้ยคะ" = "anyone interested?") — if it's actually selling something (price + shipping/meetup terms), that's "resale" below, not "question", even though it ends in "มั้ยคะ".
  - "resale": Twitter-only (platform="twitter") — resale/marketplace listings, pairs with topic="ขายต่อ/มือสอง" below. ALWAYS "resale" regardless of wording/emoji or question-particle phrasing, even if it reads enthusiastic ("สภาพดีมาก", "ราคาดีสุดๆ") or is phrased as a question ("มีใครสนใจมั้ยคะ") — it's a sales post, not a brand opinion or a genuine question. Never use "resale" for TikTok/XHS/Instagram.
  - "neutral": ONLY genuinely no-sentiment content. This includes:
    • on-topic but opinion-less factual statements ("มี SPF50", "ออกปีที่แล้ว", "7/11")
    • OFF-TOPIC / NOISE that isn't about the product: bare friend tags ("@someone"), celebrity/fan chatter ("my gege", "มังกร🐲", k-pop names), stickers, keyboard mash / gibberish (".บ.บฝบ", "ขข")
    Do NOT use neutral as a dumping ground — if a comment shows ANY of the positive engagement signals above, label it positive.

- topic: one of "ราคา" (price), "คุณภาพ" (quality), "บรรจุภัณฑ์" (packaging), "ประสิทธิภาพ" (efficacy), "กลิ่น" (scent), "สี" (color), "บริการ" (service), "ขายต่อ/มือสอง" (resale/secondhand — Twitter only), "อื่นๆ" (other)
  - "ขายต่อ/มือสอง": pairs with sentiment="resale" above — ONLY when platform="twitter" AND the comment is someone reselling/trading a used or opened bottle — "WTS", "ขายต่อ", "มือสอง", "เหลือใช้", posting remaining ml + price + meetup/shipping terms. Never use this topic for TikTok/XHS/Instagram comments — treat similar content there under its normal topic instead.
- score: confidence 0.0–1.0
- urgency: ONLY when sentiment is "negative", rate how urgently this needs a human response, on a 1-5 scale:
  1 = trivial gripe (price complaint, mild preference dislike, no real problem)
  2 = mild dissatisfaction (didn't meet expectations, no safety/health concern)
  3 = clear complaint (product defect, quality issue) but isolated, not urgent
  4 = serious complaint (damaged/counterfeit product, refund or legal threat, complaint visible publicly) — should be answered soon
  5 = urgent/critical (health/safety harm — allergic reaction, injury, illness — or viral backlash risk) — needs a response fast
  If sentiment is NOT "negative", set urgency to null. Do not invent urgency for positive/neutral/question comments.
- th: Thai translation of the comment — ONLY if the comment's language is NOT Thai and NOT English (e.g. Chinese, Vietnamese, Japanese, Korean, Malay, etc). Translate the MEANING into natural Thai (ภาษาไทย), keeping product names, brand names, and emoji as-is. Do not add commentary.
  If the comment is already Thai or English, set th to null — do not translate or echo it back.
- brand_relevance: one of "on_topic", "other_brand" — each comment below carries a "brand" field naming the brand its post is actually tagged under. Is the comment actually about THAT brand?
  - "other_brand": ONLY when the comment is clearly about a different brand/product that's also mentioned in the same post/thread — e.g. a direct comparison ("X ดีกว่า Y"), or praise/complaint aimed at a competitor product mentioned alongside the tagged brand.
  - Default to "on_topic" whenever there's no other brand in play, or it's ambiguous which brand the comment means — don't over-flag.

Return ONLY a JSON array, one object per comment, with keys: id, sentiment, topic, score, urgency, th, brand_relevance.

Comments:
${JSON.stringify(comments.map((c) => ({ id: c.id, brand: c.brand_name, platform: c.platform ?? 'unknown', text: c.content })))}`;

  const ai = await getAiSettings();

  if (ai.provider === 'deepseek') {
    // Admin toggle set to DeepSeek — skip Gemini entirely, no OpenRouter fallback.
    if (!hasDeepSeekKey()) {
      console.warn('[Sentiment] Provider=deepseek but no DEEPSEEK_API_KEY set');
      return results;
    }
    try {
      const r = await chatCompleteDeepSeek([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 2000 });
      if (r.text) {
        parseInto(results, r.text);
        logAiUsage({ provider: 'deepseek', model: r.model, purpose: 'sentiment', tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null, success: true }).catch(() => {});
        return results;
      }
      logAiUsage({ provider: 'deepseek', model: r.model, purpose: 'sentiment', tokensIn: null, tokensOut: null, success: false, errorMessage: 'empty response' }).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Sentiment] DeepSeek batch failed:', msg.slice(0, 120));
      logAiUsage({ provider: 'deepseek', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', purpose: 'sentiment', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
    }
    console.warn('[Sentiment] DeepSeek call failed for this batch');
    return results;
  }

  // Primary: Gemini with key rotation.
  for (let attempt = 0; attempt < KEYS_RETRIES; attempt++) {
    const model = getGeminiModel(DEFAULT_MODEL);
    if (!model) break; // all Gemini keys exhausted → fall through to LLM fallback

    try {
      const result = await model.generateContent(prompt);
      parseInto(results, result.response.text());
      logAiUsage({
        provider: 'gemini', model: DEFAULT_MODEL, purpose: 'sentiment',
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
        // retry loop picks up the next key
      } else {
        console.error('[Sentiment] Gemini batch failed — trying fallback:', msg.slice(0, 120));
        logAiUsage({ provider: 'gemini', model: DEFAULT_MODEL, purpose: 'sentiment', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
        break;
      }
    }
  }

  // Fallback: OpenRouter/Qwen (or DeepSeek) — keeps classification alive when Gemini is quota-blocked.
  if (hasLlmKey()) {
    try {
      const r = await chatCompleteWithUsage([{ role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 2000 });
      if (r.text) {
        parseInto(results, r.text);
        logAiUsage({ provider: r.provider.toLowerCase(), model: r.model, purpose: 'sentiment', tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null, success: true }).catch(() => {});
        console.log(`[Sentiment] Classified batch via fallback ${activeProviderName()} (${results.size})`);
        return results;
      }
    } catch (err) {
      console.error('[Sentiment] Fallback classification failed:', err instanceof Error ? err.message.slice(0, 120) : err);
    }
  }

  console.warn('[Sentiment] Gemini exhausted and no working fallback for this batch');
  return results;
}

// Max attempts = number of available keys (each attempt may rotate to a different key)
const KEYS_RETRIES = 10;

async function updateSentimentBatch(results: Map<number, SentimentResult>): Promise<void> {
  if (results.size === 0) return;
  const entries = [...results.entries()];
  const values: unknown[] = [];
  const placeholders = entries.map(([id, r], i) => {
    const base = i * 7;
    values.push(id, r.sentiment, r.score, r.topic, r.urgency, r.translated, r.brandRelevance);
    return `($${base + 1}::int, $${base + 2}, $${base + 3}::decimal, $${base + 4}, $${base + 5}::smallint, $${base + 6}::text, $${base + 7}::varchar(20))`;
  });
  await pool.query(
    `UPDATE social_comments AS sc
     SET sentiment          = v.sentiment,
         sentiment_score    = v.score,
         topic              = v.topic,
         urgency            = v.urgency,
         content_translated = COALESCE(v.translated, sc.content_translated),
         brand_relevance    = v.brand_relevance
     FROM (VALUES ${placeholders.join(', ')}) AS v(id, sentiment, score, topic, urgency, translated, brand_relevance)
     WHERE sc.id = v.id`,
    values,
  );
}

export async function classifyUnanalyzedComments(limit = 200, platform?: string): Promise<number> {
  const rows = await query<CommentRow>(
    `SELECT sc.id, sc.content, sc.platform, sc.post_id, b.name AS brand_name, b.slug AS brand_slug, b.type AS brand_type,
            COALESCE(tp.post_url, twp.post_url) AS post_url,
            COALESCE(tp.author_handle, twp.author_handle) AS author_handle
     FROM social_comments sc
     JOIN brands b ON b.id = sc.brand_id
     LEFT JOIN tiktok_posts tp ON sc.platform = 'tiktok' AND tp.brand_id = sc.brand_id AND tp.post_id = sc.post_id
     LEFT JOIN twitter_posts twp ON sc.platform = 'twitter' AND twp.brand_id = sc.brand_id AND twp.post_id = sc.post_id
     WHERE sc.sentiment IS NULL
       AND ($2::text IS NULL OR sc.platform = $2)
       AND ${noiseExcludeSql('sc.content')}
     ORDER BY sc.scraped_at DESC
     LIMIT $1
     FOR UPDATE OF sc SKIP LOCKED`,
    [limit, platform ?? null]
  );

  if (rows.length === 0) {
    console.log('[Sentiment] No unclassified comments.');
    return 0;
  }

  console.log(`[Sentiment] Classifying ${rows.length} comments...`);
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const results = await classifyBatch(batch.map((r) => ({ id: r.id, content: r.content, brand_name: r.brand_name, platform: r.platform })));
    await updateSentimentBatch(results);
    done += results.size;

    const urgentRows: UrgentNegativeRow[] = [];
    for (const r of batch) {
      const res = results.get(r.id);
      if (res?.sentiment === 'negative' && res.urgency != null && res.urgency >= 4 && r.brand_type === 'own') {
        urgentRows.push({
          id: r.id, content: r.content, topic: res.topic, urgency: res.urgency,
          brand_name: r.brand_name, brand_slug: r.brand_slug, platform: r.platform,
          postUrl: resolveCommentUrl(r),
        });
      }
    }
    if (urgentRows.length > 0) {
      await alertUrgentNegativeComments(urgentRows).catch((e) =>
        console.error('[Sentiment] Urgent negative alert failed:', e instanceof Error ? e.message : e));
    }

    if (i + BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`[Sentiment] ✓ Classified ${done} comments.`);
  return done;
}

/**
 * Re-classify EVERY comment (not just NULL) under the current prompt rules.
 * Used after a prompt-quality change to correct existing labels. Paginates by id
 * so it's restart-safe and never holds a giant result set.
 */
export async function reclassifyAllComments(batchSize = BATCH_SIZE, platform?: string): Promise<number> {
  let lastId = 0;
  let done = 0;
  for (;;) {
    const rows = await query<{ id: number; content: string; platform: string; brand_name: string }>(
      `SELECT sc.id, sc.content, sc.platform, b.name AS brand_name
       FROM social_comments sc
       JOIN brands b ON b.id = sc.brand_id
       WHERE sc.id > $1
         AND sc.external_id NOT LIKE 'xhs\\_note\\_%'
         AND ($3::text IS NULL OR sc.platform = $3)
       ORDER BY sc.id
       LIMIT $2`,
      [lastId, batchSize, platform ?? null],
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const results = await classifyBatch(rows.map((r) => ({ id: r.id, content: r.content, brand_name: r.brand_name, platform: r.platform })));
    await updateSentimentBatch(results);
    done += results.size;
    console.log(`[Reclassify] up to id=${lastId} · ${done} done`);
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`[Reclassify] ✓ Re-classified ${done} comments.`);
  return done;
}

/**
 * One-time backfill: existing comments already labeled sentiment='negative'
 * from before the urgency field existed have urgency=NULL. Re-run just those
 * through the classifier (cheaper than reclassifyAllComments, which touches
 * every comment regardless of sentiment). Paginates by id, restart-safe.
 */
export async function backfillNegativeUrgency(batchSize = BATCH_SIZE): Promise<number> {
  let lastId = 0;
  let done = 0;
  for (;;) {
    const rows = await query<{ id: number; content: string; brand_name: string }>(
      `SELECT sc.id, sc.content, b.name AS brand_name
       FROM social_comments sc
       JOIN brands b ON b.id = sc.brand_id
       WHERE sc.id > $1
         AND sc.sentiment = 'negative'
         AND sc.urgency IS NULL
       ORDER BY sc.id
       LIMIT $2`,
      [lastId, batchSize],
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const results = await classifyBatch(rows.map((r) => ({ id: r.id, content: r.content, brand_name: r.brand_name })));
    await updateSentimentBatch(results);
    done += results.size;
    console.log(`[BackfillUrgency] up to id=${lastId} · ${done} done`);
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`[BackfillUrgency] ✓ Backfilled urgency for ${done} negative comments.`);
  return done;
}

if (require.main === module) {
  classifyUnanalyzedComments()
    .then((n) => { console.log(`Done: ${n} comments classified`); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
