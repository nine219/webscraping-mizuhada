import { socialQuery as query, socialPool as pool } from '../db/social-client';
import { chatCompleteWithUsage, chatCompleteDeepSeek, hasLlmKey, hasDeepSeekKey, activeProviderName } from './llm-client';
import { getGeminiModel, hasGeminiKey, markCurrentKeyExhausted, parseRetryAfterMs, DEFAULT_MODEL } from './gemini-client';
import { getAiSettings } from '../config/settings-loader';
import { logAiUsage } from './ai-usage';
import { needsTranslation } from './lang-detect';

// translateUntranslatedComments (any non-TH/EN language → Thai, any platform)
// is NOT part of the live cron pipeline — src/analysis/sentiment.ts's
// classifyBatch() already does this inline, in the same Gemini call as
// sentiment classification, for every NEW comment. This function is the
// backfill path: comments classified before that inline translation existed
// (or where the model skipped it) sit with content_translated = NULL forever
// otherwise. Also used by the standalone Qwen-vs-DeepSeek comparison tool
// (src/tools/sentiment-xhs.ts).
//
// translateUntranslatedNotes (XHS caption → Thai) is still live — captions
// live in xhs_posts, not social_comments, so they never pass through the
// sentiment classifier and need their own translation pass.

const BATCH_SIZE = 25;
const KEYS_RETRIES = 10;

interface CommentRow {
  id: number;
  content: string;
}

// Fallback for rows scraped before insert-time language marking existed —
// scrapers now set content_translated = '' upfront for already-TH/EN content
// (see lang-detect.ts), so in steady state this partition finds nothing to skip.
function partitionByScript<T extends CommentRow>(rows: T[]): [T[], T[]] {
  const toTranslate: T[] = [];
  const alreadyThEn: T[] = [];
  for (const r of rows) {
    (needsTranslation(r.content) ? toTranslate : alreadyThEn).push(r);
  }
  return [toTranslate, alreadyThEn];
}

// Provider-toggle-aware completion: Admin > AI usage's gemini/deepseek switch
// decides the path. "gemini" tries native Gemini first, falling back to
// llm-client's auto-select (OpenRouter/DeepSeek) on quota exhaustion; "deepseek"
// skips Gemini entirely. Logs every attempt to ai_usage_log.
async function getTranslatedText(prompt: string): Promise<string | null> {
  const ai = await getAiSettings();

  if (ai.provider === 'deepseek') {
    if (!hasDeepSeekKey()) {
      console.warn('[Translate] Provider=deepseek but no DEEPSEEK_API_KEY set');
      return null;
    }
    const r = await chatCompleteDeepSeek([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 2000 });
    logAiUsage({
      provider: 'deepseek', model: r.model, purpose: 'translate',
      tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null,
      success: !!r.text, errorMessage: r.text ? null : 'empty response',
    }).catch(() => {});
    return r.text;
  }

  for (let attempt = 0; attempt < KEYS_RETRIES; attempt++) {
    const model = getGeminiModel(DEFAULT_MODEL);
    if (!model) break; // all Gemini keys exhausted → fall through to LLM fallback

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      logAiUsage({
        provider: 'gemini', model: DEFAULT_MODEL, purpose: 'translate',
        tokensIn: result.response.usageMetadata?.promptTokenCount ?? null,
        tokensOut: result.response.usageMetadata?.candidatesTokenCount ?? null,
        success: true,
      }).catch(() => {});
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      if (isQuota) {
        markCurrentKeyExhausted(parseRetryAfterMs(msg));
      } else {
        console.error('[Translate] Gemini failed — trying fallback:', msg.slice(0, 120));
        logAiUsage({ provider: 'gemini', model: DEFAULT_MODEL, purpose: 'translate', tokensIn: null, tokensOut: null, success: false, errorMessage: msg.slice(0, 200) }).catch(() => {});
        break;
      }
    }
  }

  if (hasLlmKey()) {
    const r = await chatCompleteWithUsage([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 2000 });
    if (r.text) {
      logAiUsage({ provider: r.provider.toLowerCase(), model: r.model, purpose: 'translate', tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null, success: true }).catch(() => {});
      console.log(`[Translate] via fallback ${activeProviderName()}`);
      return r.text;
    }
  }
  return null;
}

// Whether *any* configured path (per the Admin provider toggle) can translate.
async function hasUsableProvider(): Promise<boolean> {
  const ai = await getAiSettings();
  return ai.provider === 'deepseek' ? hasDeepSeekKey() : (hasGeminiKey() || hasLlmKey());
}

async function translateBatch(
  comments: CommentRow[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();

  const prompt = `You are a translator for Thai beauty/skincare social media comments.
Comments may be in any language (Chinese, Vietnamese, Japanese, Korean, Malay, etc).
For each comment, translate its MEANING into natural Thai (ภาษาไทย), keeping product
names, brand names and emoji as-is. Do not add commentary. If a comment is already
Thai or English, return th as an empty string — do not echo it back.

Return ONLY a JSON array, one object per comment, with keys: id, th.

Comments:
${JSON.stringify(comments.map((c) => ({ id: c.id, text: c.content })))}`;

  const text = await getTranslatedText(prompt);
  if (!text) return out;

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[Translate] No JSON array in LLM response — skipping batch');
    return out;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ id: number; th: string }>;
    const byId = new Map(comments.map((c) => [c.id, c.content.trim()]));
    for (const item of parsed) {
      const th = typeof item?.th === 'string' ? item.th.trim() : '';
      // Skip empty/echoed-back translations — the comment was already Thai/English.
      if (typeof item?.id === 'number' && th && th !== byId.get(item.id)) {
        out.set(item.id, th);
      }
    }
  } catch (err) {
    console.error('[Translate] Failed to parse LLM JSON:', err instanceof Error ? err.message : err);
  }
  return out;
}

async function updateBatch(results: Map<number, string>): Promise<void> {
  if (results.size === 0) return;
  const entries = [...results.entries()];
  const values: unknown[] = [];
  const placeholders = entries.map(([id, th], i) => {
    const base = i * 2;
    values.push(id, th);
    return `($${base + 1}::int, $${base + 2})`;
  });
  await pool.query(
    `UPDATE social_comments AS sc
     SET content_translated = v.th
     FROM (VALUES ${placeholders.join(', ')}) AS v(id, th)
     WHERE sc.id = v.id`,
    values,
  );
}

export async function translateUntranslatedComments(limit = 200): Promise<number> {
  if (!(await hasUsableProvider())) {
    console.warn('[Translate] No usable AI provider configured — skipping translation backfill.');
    return 0;
  }
  console.log(`[Translate] Provider: ${activeProviderName()}`);

  const rows = await query<CommentRow>(
    `SELECT id, content
     FROM social_comments
     WHERE content_translated IS NULL
       AND content <> ''
     ORDER BY scraped_at DESC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  if (rows.length === 0) {
    console.log('[Translate] No untranslated comments.');
    return 0;
  }

  const [toTranslate, alreadyThEn] = partitionByScript(rows);
  if (alreadyThEn.length > 0) {
    await updateBatch(new Map(alreadyThEn.map((r) => [r.id, ''])));
    console.log(`[Translate] Skipped ${alreadyThEn.length} comments already in Thai/English.`);
  }
  if (toTranslate.length === 0) return 0;

  console.log(`[Translate] Translating ${toTranslate.length} comments (non-TH/EN language)...`);
  let done = 0;

  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    const batch = toTranslate.slice(i, i + BATCH_SIZE);
    const results = await translateBatch(batch);
    await updateBatch(results);
    done += results.size;

    if (i + BATCH_SIZE < toTranslate.length) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  console.log(`[Translate] ✓ Translated ${done} comments.`);
  return done;
}

// XHS note captions live in xhs_posts (not social_comments). Translate them the
// same way so the /xhs feed shows Thai alongside the Chinese caption.
async function updateNotesBatch(results: Map<number, string>): Promise<void> {
  if (results.size === 0) return;
  const entries = [...results.entries()];
  const values: unknown[] = [];
  const placeholders = entries.map(([id, th], i) => {
    const base = i * 2;
    values.push(id, th);
    return `($${base + 1}::int, $${base + 2})`;
  });
  await pool.query(
    `UPDATE xhs_posts AS xp
     SET caption_translated = v.th
     FROM (VALUES ${placeholders.join(', ')}) AS v(id, th)
     WHERE xp.id = v.id`,
    values,
  );
}

export async function translateUntranslatedNotes(limit = 200): Promise<number> {
  if (!(await hasUsableProvider())) return 0;

  const rows = await query<CommentRow>(
    `SELECT id, caption AS content
     FROM xhs_posts
     WHERE caption_translated IS NULL AND caption <> ''
     ORDER BY scraped_at DESC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  if (rows.length === 0) return 0;

  const [toTranslate, alreadyThEn] = partitionByScript(rows);
  if (alreadyThEn.length > 0) {
    await updateNotesBatch(new Map(alreadyThEn.map((r) => [r.id, ''])));
    console.log(`[Translate] Skipped ${alreadyThEn.length} note captions already in Thai/English.`);
  }
  if (toTranslate.length === 0) return 0;

  console.log(`[Translate] Translating ${toTranslate.length} XHS note captions...`);
  let done = 0;
  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    const batch = toTranslate.slice(i, i + BATCH_SIZE);
    const results = await translateBatch(batch);
    await updateNotesBatch(results);
    done += results.size;
    if (i + BATCH_SIZE < toTranslate.length) await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`[Translate] ✓ Translated ${done} note captions.`);
  return done;
}

if (require.main === module) {
  Promise.all([translateUntranslatedComments(), translateUntranslatedNotes()])
    .then(([c, n]) => { console.log(`Done: ${c} comments, ${n} note captions translated`); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
