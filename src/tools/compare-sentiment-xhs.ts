/**
 * Side-by-side sentiment comparison for XHS comments:
 *   Qwen (qwen/qwen-plus) vs DeepSeek (deepseek/deepseek-chat),
 *   both via OpenRouter using the same API key.
 *
 * Does NOT write to the DB. Prints a diff table to stdout and a summary.
 *
 * Usage:
 *   npx ts-node src/tools/compare-sentiment-xhs.ts          # 30 random XHS comments
 *   N=50 npx ts-node src/tools/compare-sentiment-xhs.ts     # custom count
 */
import axios from 'axios';
import { socialQuery } from '../db/social-client';

const OR_KEY = process.env.OPENROUTER_API_KEY;
const BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const QWEN  = process.env.OPENROUTER_MODEL          || 'qwen/qwen-plus';
const DEEP  = process.env.OPENROUTER_FALLBACK_MODEL || 'deepseek/deepseek-chat';
const N     = Number(process.env.N || 30);

if (!OR_KEY) { console.error('OPENROUTER_API_KEY missing'); process.exit(1); }

const PROMPT_HEAD = `You are a Thai beauty/skincare social-comment classifier. Comments are mostly Thai (some English/Chinese), often slang and emoji-heavy.

For each comment, classify:

- sentiment: one of "positive", "negative", "neutral", "question"
  - "positive": praise, satisfaction, recommendation — AND weak/implicit positive engagement signals (anticipation, saving, want-to-try, following, affection, efficacy testimonial).
  - "negative": complaint, disappointment, warning, "ของปลอม", "แพ้", "ไม่เห็นผล", "แตก/รั่ว", "แพง" (as complaint).
  - "question": ANY inquiry — price, where to buy, suitability, "...มั้ย/ไหม/หรอ/คะ?".
  - "neutral": ONLY genuinely no-sentiment content (on-topic factual, off-topic noise, stickers, gibberish).
- topic: one of "ราคา","คุณภาพ","บรรจุภัณฑ์","ประสิทธิภาพ","กลิ่น","สี","บริการ","อื่นๆ"
- score: 0.0–1.0

Return ONLY a JSON array, one object per comment: {id, sentiment, topic, score}.

Comments:
`;

interface Row { id: number; content: string }
interface Out { id: number; sentiment: string; topic: string; score: number }

const CHUNK = Number(process.env.CHUNK || 25);

async function callModelChunk(model: string, batch: Row[]): Promise<Map<number, Out>> {
  const prompt = PROMPT_HEAD + JSON.stringify(batch.map((c) => ({ id: c.id, text: c.content })));
  const resp = await axios.post(
    `${BASE}/chat/completions`,
    { model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: Number(process.env.MAX_TOK || 900), stream: false },
    {
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mizuhada.local',
        'X-Title': 'Mizuhada Sentiment Compare',
      },
      timeout: 90_000,
    },
  );
  const text: string = resp.data?.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`No JSON array from ${model}: ${text.slice(0, 200)}`);
  const arr = JSON.parse(m[0]) as Out[];
  const out = new Map<number, Out>();
  for (const r of arr) out.set(r.id, r);
  return out;
}

async function callModel(model: string, rows: Row[]): Promise<Map<number, Out>> {
  const out = new Map<number, Out>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    try {
      const got = await callModelChunk(model, slice);
      for (const [k, v] of got) out.set(k, v);
      process.stdout.write(`  chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(rows.length / CHUNK)} ok (${got.size})\n`);
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? `${e.response?.status ?? '?'} ${JSON.stringify(e.response?.data ?? {}).slice(0, 200)}`
        : (e instanceof Error ? e.message : String(e));
      console.error(`  chunk ${Math.floor(i / CHUNK) + 1} FAILED on ${model}: ${msg}`);
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  const v = (s ?? '').replace(/\s+/g, ' ');
  return v.length > n ? v.slice(0, n - 1) + '…' : v.padEnd(n);
}

(async () => {
  const rows = await socialQuery<Row>(
    `SELECT id, COALESCE(NULLIF(content_translated, ''), content) AS content
     FROM social_comments
     WHERE platform = 'xiaohongshu'
       AND COALESCE(NULLIF(content_translated, ''), content) <> ''
     ORDER BY RANDOM()
     LIMIT $1`,
    [N],
  );
  console.log(`Loaded ${rows.length} XHS comments.\n`);

  console.log(`→ Calling Qwen   (${QWEN})...`);
  const tQ0 = Date.now();
  const qwen = await callModel(QWEN, rows);
  console.log(`  done in ${Date.now() - tQ0}ms · returned ${qwen.size}\n`);

  console.log(`→ Calling DeepSeek (${DEEP})...`);
  const tD0 = Date.now();
  const deep = await callModel(DEEP, rows);
  console.log(`  done in ${Date.now() - tD0}ms · returned ${deep.size}\n`);

  // Print side-by-side
  console.log(
    pad('id', 7) + ' | ' +
    pad('qwen', 10) + ' | ' +
    pad('deep', 10) + ' | ' +
    pad('topic-Q', 14) + ' | ' +
    pad('topic-D', 14) + ' | ' +
    'text',
  );
  console.log('-'.repeat(120));

  let agreeSent = 0, agreeTopic = 0, both = 0;
  const diffs: Array<{ id: number; text: string; q: string; d: string }> = [];
  for (const r of rows) {
    const q = qwen.get(r.id);
    const d = deep.get(r.id);
    if (!q || !d) continue;
    both++;
    if (q.sentiment === d.sentiment) agreeSent++;
    else diffs.push({ id: r.id, text: r.content, q: q.sentiment, d: d.sentiment });
    if (q.topic === d.topic) agreeTopic++;

    const flag = q.sentiment === d.sentiment ? ' ' : '*';
    console.log(
      pad(String(r.id), 7) + ' | ' +
      pad(`${flag}${q.sentiment}`, 10) + ' | ' +
      pad(`${flag}${d.sentiment}`, 10) + ' | ' +
      pad(q.topic, 14) + ' | ' +
      pad(d.topic, 14) + ' | ' +
      r.content.replace(/\s+/g, ' ').slice(0, 80),
    );
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Agreement (sentiment): ${agreeSent}/${both} = ${((100 * agreeSent) / both).toFixed(1)}%`);
  console.log(`Agreement (topic):     ${agreeTopic}/${both} = ${((100 * agreeTopic) / both).toFixed(1)}%`);
  if (diffs.length) {
    console.log(`\nDisagreements (${diffs.length}):`);
    for (const x of diffs) {
      console.log(`  id=${x.id}  Q=${x.q}  D=${x.d}  | ${x.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
