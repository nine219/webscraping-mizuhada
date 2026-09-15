/**
 * Quick single-comment sentiment test against Qwen + DeepSeek via OpenRouter.
 * Usage: TEXT='your comment' npx ts-node -r dotenv/config src/tools/test-one-comment.ts dotenv_config_path=.env.local
 */
import axios from 'axios';

const KEY = process.env.OPENROUTER_API_KEY;
const BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const TEXT = process.env.TEXT || '虾🦐皮有吗';

if (!KEY) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }

const PROMPT = `You are a Thai beauty/skincare social-comment classifier. Comments are mostly Thai (some English/Chinese), often slang and emoji-heavy.

For each comment, classify:
- sentiment: one of "positive", "negative", "neutral", "question"
  - "question": ANY inquiry — price, where to buy, suitability, "...มั้ย/ไหม/หรอ/คะ?", "ขายที่ไหน", "กี่บาท"
  - "positive": praise, satisfaction, anticipation, want-to-try, following, affection, efficacy testimonial
  - "negative": complaint, disappointment, warning
  - "neutral": ONLY genuinely no-sentiment content
- topic: one of "ราคา","คุณภาพ","บรรจุภัณฑ์","ประสิทธิภาพ","กลิ่น","สี","บริการ","อื่นๆ"
- score: 0.0–1.0

Return ONLY a JSON array, one object per comment: {id, sentiment, topic, score}.

Comments:
${JSON.stringify([{ id: 1, text: TEXT }])}`;

async function call(model: string) {
  const t = Date.now();
  const r = await axios.post(
    `${BASE}/chat/completions`,
    { model, messages: [{ role: 'user', content: PROMPT }], temperature: 0.1, max_tokens: 500, stream: false },
    {
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mizuhada.local',
        'X-Title': 'test-one',
      },
      timeout: 60000,
    },
  );
  return { model, ms: Date.now() - t, text: r.data?.choices?.[0]?.message?.content ?? '' };
}

(async () => {
  console.log(`Comment: ${TEXT}\n`);
  for (const m of ['qwen/qwen-plus', 'deepseek/deepseek-chat']) {
    try {
      const r = await call(m);
      console.log(`=== ${r.model} (${r.ms}ms) ===\n${r.text}\n`);
    } catch (e) {
      console.error(`!! ${m} failed:`, e instanceof Error ? e.message : e);
    }
  }
})();
