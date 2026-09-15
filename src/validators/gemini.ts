import { GoogleGenerativeAI } from '@google/generative-ai';
import { RawSocialPost } from '../scrapers/xhs/base-social';

const BATCH_SIZE = 20;

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') {
    throw new Error('GEMINI_API_KEY not configured — set it in .env.local');
  }
  return new GoogleGenerativeAI(key);
}

interface CommentEnrichmentResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  sentiment_score: number;
  topic: string;
}

async function validateCommentsBatch(comments: RawSocialPost[]): Promise<CommentEnrichmentResult[]> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

  const prompt = `You are a social-media sentiment analyst for a beauty brand intelligence platform.

For each post/comment below, return:
- sentiment: "positive", "negative", or "neutral"
- sentiment_score: a number between -1.0 (very negative) and 1.0 (very positive)
- topic: a short topical label in English (e.g. "price", "quality", "packaging", "efficacy", "scent", "color", "service", "influencer", "other")

Return a JSON array with one object per input comment: {"sentiment": "...", "sentiment_score": number, "topic": "..."}

Comments:
${JSON.stringify(comments.map((c, i) => ({ i, text: c.content.slice(0, 400) })), null, 2)}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[Gemini] Could not parse comment enrichment response, using neutral defaults');
    return comments.map(() => ({ sentiment: 'neutral', sentiment_score: 0, topic: 'other' }));
  }

  try {
    return JSON.parse(jsonMatch[0]) as CommentEnrichmentResult[];
  } catch {
    console.warn('[Gemini] JSON parse error in comment enrichment response, using neutral defaults');
    return comments.map(() => ({ sentiment: 'neutral', sentiment_score: 0, topic: 'other' }));
  }
}

export async function validateComments(comments: RawSocialPost[]): Promise<RawSocialPost[]> {
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
    console.warn('[Gemini] API key not set — skipping comment enrichment, passing all through');
    return comments;
  }

  const enriched: RawSocialPost[] = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);

    if (consecutiveFailures >= 2) {
      enriched.push(...comments.slice(i));
      console.warn(`[Gemini] Skipping remaining comment enrichment after ${consecutiveFailures} consecutive failures — passing all through`);
      break;
    }

    try {
      const results = await validateCommentsBatch(batch);
      consecutiveFailures = 0;
      batch.forEach((c, idx) => {
        const r = results[idx];
        if (!r) {
          enriched.push(c);
          return;
        }
        const sentiment = ['positive', 'negative', 'neutral'].includes(r.sentiment)
          ? (r.sentiment as RawSocialPost['sentiment'])
          : 'neutral';
        const sentimentScore = Math.min(1, Math.max(-1, typeof r.sentiment_score === 'number' ? r.sentiment_score : 0));
        enriched.push({
          ...c,
          sentiment,
          sentimentScore,
          topic: r.topic || 'other',
        });
      });
    } catch (err) {
      consecutiveFailures++;
      const errMsg = err instanceof Error ? err.message.slice(0, 80) : String(err);
      console.warn(`[Gemini] Comment batch ${Math.floor(i / BATCH_SIZE) + 1} failed (${consecutiveFailures} in a row): ${errMsg} — passing through`);
      enriched.push(...batch);
    }

    if (i + BATCH_SIZE < comments.length && consecutiveFailures === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`[Gemini] Enriched ${enriched.length} comments`);
  return enriched;
}
