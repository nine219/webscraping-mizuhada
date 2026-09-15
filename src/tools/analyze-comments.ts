/**
 * Batch sentiment analysis for social_comments rows where sentiment IS NULL.
 * Sends 30 comments per Gemini call to stay within 20 RPD free-tier quota.
 *
 * Usage:
 *   npm run analyze:sentiment
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { socialQuery as query, socialPool as pool } from '../db/social-client';

const GEMINI_BATCH_SIZE = 30; // comments per API call — 190 rows ≈ 7 calls
const INTER_BATCH_DELAY_MS = 3_000;

interface CommentRow {
  id: number;
  content: string;
}

type Sentiment = 'positive' | 'negative' | 'neutral';

function getGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  return new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
}

async function classifyBatch(rows: CommentRow[]): Promise<Map<number, Sentiment>> {
  const results = new Map<number, Sentiment>();
  if (rows.length === 0) return results;

  const numbered = rows.map((r, i) => `${i + 1}. "${r.content.replace(/"/g, "'").slice(0, 200)}"`).join('\n');
  const prompt =
    `Classify each comment sentiment as positive, negative, or neutral.\n` +
    `Reply ONLY in this exact format, one per line: <number>:<sentiment>\n` +
    `Comments:\n${numbered}`;

  let raw: string;
  try {
    const model = getGemini();
    const result = await model.generateContent(prompt);
    raw = result.response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 150) : String(err);
    console.error(`[AnalyzeComments] Gemini batch error: ${msg}`);
    return results;
  }

  // Parse "1:positive\n2:negative\n..."
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+)\s*:\s*(positive|negative|neutral)/i);
    if (!m) continue;
    const idx = parseInt(m[1]) - 1;
    const sentiment = m[2].toLowerCase() as Sentiment;
    if (idx >= 0 && idx < rows.length) {
      results.set(rows[idx].id, sentiment);
    }
  }

  return results;
}

async function main(): Promise<void> {
  console.log('[AnalyzeComments] Fetching comments with NULL sentiment...');

  const rows = await query<CommentRow>(
    `SELECT id, content FROM social_comments WHERE sentiment IS NULL ORDER BY id`
  );

  if (rows.length === 0) {
    console.log('[AnalyzeComments] Nothing to process.');
    await pool.end();
    return;
  }

  console.log(`[AnalyzeComments] Found ${rows.length} comments. Sending in batches of ${GEMINI_BATCH_SIZE}...`);

  let classified = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += GEMINI_BATCH_SIZE) {
    const batch = rows.slice(i, i + GEMINI_BATCH_SIZE);
    const batchNum = Math.floor(i / GEMINI_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rows.length / GEMINI_BATCH_SIZE);

    console.log(`[AnalyzeComments] Batch ${batchNum}/${totalBatches} (${batch.length} comments)...`);

    const sentiments = await classifyBatch(batch);

    for (const row of batch) {
      const sentiment = sentiments.get(row.id);
      if (!sentiment) { failed++; continue; }

      const score = sentiment === 'positive' ? 0.7 : sentiment === 'negative' ? -0.7 : 0;
      await query(
        `UPDATE social_comments SET sentiment = $1, sentiment_score = $2 WHERE id = $3`,
        [sentiment, score, row.id]
      );
      classified++;
    }

    console.log(`[AnalyzeComments] Batch ${batchNum} done — ${sentiments.size}/${batch.length} classified`);

    if (i + GEMINI_BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
    }
  }

  console.log(`[AnalyzeComments] Done. Classified: ${classified} | Failed/skipped: ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[AnalyzeComments] Fatal error:', err);
  process.exit(1);
});
