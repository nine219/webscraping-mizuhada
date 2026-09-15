/**
 * Benchmark different vision-LLMs on the collected XHS captcha screenshots.
 *
 * Feeds every PNG in src/scrapers/xhs/captcha/ to a list of candidate
 * models via OpenRouter's OpenAI-compatible /chat/completions endpoint, prints
 * each model's picks per captcha, and scores against a small ground-truth
 * table below.
 *
 * Ground truth is inferred from the images (see comments in `EXPECTED`) and is
 * best-effort — some captchas are ambiguous. The point is relative comparison.
 *
 * Run: node -r dotenv/config -r ts-node/register src/tools/bench-xhs-captcha.ts \
 *      dotenv_config_path=.env.local
 */

import * as fs from 'fs';
import * as path from 'path';

const CAPTCHA_DIR = path.join(__dirname, '..', 'scrapers', 'xhs', 'captcha');

// Reference answers per screenshot filename. Sets are used so order doesn't
// matter. Best-effort — some prompts are semantically ambiguous.
const EXPECTED: Record<string, { instruction: string; picks: Set<number> }> = {
  'Screenshot 2026-07-01 104332.png': { instruction: '金属做的东西 (metal things)',              picks: new Set([2, 6]) },
  'Screenshot 2026-07-01 092857.png': { instruction: '色彩鲜艳的动物 (colorful animals)',        picks: new Set([2, 4]) },
  'Screenshot 2026-07-01 104348.png': { instruction: 'Spicy vegetables',                         picks: new Set([4, 6]) },
  'Screenshot 2026-07-01 104403.png': { instruction: 'Animals living in the wild forest',        picks: new Set([2, 3]) },
  'Screenshot 2026-06-29 161458.png': { instruction: '可以直接生吃的水果 (fruits eatable raw)',  picks: new Set([3, 6]) },
};

// OpenRouter IDs verified live (2026-07). Models rotate — refresh via
// `curl https://openrouter.ai/api/v1/models -H "Authorization: Bearer $KEY"`
// if 404s reappear.
const MODELS = [
  'qwen/qwen3.7-plus',               // user's baseline — mentioned it "kinda works"
  'qwen/qwen3-vl-32b-instruct',      // smaller vision-specific
  'qwen/qwen3.6-plus',                // one gen back
  'anthropic/claude-sonnet-5',        // strongest sonnet
  'anthropic/claude-opus-4.8-fast',   // top tier
  'google/gemini-3.5-flash',          // fast + cheap
  'google/gemini-3.1-flash-lite',     // even cheaper
];

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function ask(model: string, prompt: string, imageB64: string): Promise<{ raw: string | null; picks: number[]; error?: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { raw: null, picks: [], error: 'OPENROUTER_API_KEY not set' };

  const body = {
    model,
    temperature: 0,
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
      ],
    }],
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e) } }) } as any)); // eslint-disable-line @typescript-eslint/no-explicit-any

  if (!res.ok) {
    let text = '';
    try { text = await (res as unknown as Response).text(); } catch { /* ignore */ }
    return { raw: null, picks: [], error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
  }
  const json = await (res as unknown as Response).json() as ChatResponse;
  if (json.error) return { raw: null, picks: [], error: json.error.message };
  const raw = json.choices?.[0]?.message?.content ?? null;
  if (!raw) return { raw: null, picks: [], error: 'empty response' };
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return { raw, picks: [] };
  try {
    const parsed = JSON.parse(m[0]) as { pick?: number[] };
    return { raw, picks: Array.isArray(parsed.pick) ? parsed.pick.filter((n) => Number.isInteger(n) && n >= 1 && n <= 6) : [] };
  } catch {
    return { raw, picks: [] };
  }
}

function score(picks: number[], expected: Set<number>): { correct: number; extra: number; missed: number; verdict: 'PASS' | 'PARTIAL' | 'FAIL' } {
  const got = new Set(picks);
  let correct = 0;
  for (const p of got) if (expected.has(p)) correct++;
  const extra = picks.length - correct;
  const missed = expected.size - correct;
  const verdict = correct === expected.size && extra === 0 ? 'PASS'
    : correct > 0 ? 'PARTIAL'
    : 'FAIL';
  return { correct, extra, missed, verdict };
}

const PROMPT = (instruction: string) => `You are solving a Chinese/English image-selection CAPTCHA panel.

The panel shows the instruction shown ON THE IMAGE (do NOT trust my paraphrase — read the panel yourself). Below the instruction is a grid of 6 numbered tiles, numbered 1..6 in reading order (top-left = 1, top-right = 3, bottom-left = 4, bottom-right = 6).

The panel prompt you should solve is roughly: "${instruction}".

Pick EXACTLY the images that satisfy the panel's instruction (usually 2). Return ONLY JSON: {"pick":[i,j]} where i,j are the 1-based tile numbers. No prose, no markdown.`;

async function main(): Promise<void> {
  if (!fs.existsSync(CAPTCHA_DIR)) {
    console.error(`Captcha dir not found: ${CAPTCHA_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(CAPTCHA_DIR).filter((f) => f.endsWith('.png') && EXPECTED[f]);
  if (files.length === 0) { console.error('No PNGs mapped to EXPECTED — nothing to bench.'); return; }

  console.log(`Benching ${MODELS.length} models × ${files.length} captchas via OpenRouter\n`);

  const summary: Record<string, { pass: number; partial: number; fail: number }> = {};
  for (const model of MODELS) summary[model] = { pass: 0, partial: 0, fail: 0 };

  for (const file of files) {
    const spec = EXPECTED[file];
    const filePath = path.join(CAPTCHA_DIR, file);
    const b64 = fs.readFileSync(filePath).toString('base64');
    console.log(`── ${file}`);
    console.log(`   instruction: ${spec.instruction}`);
    console.log(`   expected:    [${Array.from(spec.picks).sort().join(',')}]`);

    for (const model of MODELS) {
      const t0 = Date.now();
      const { raw, picks, error } = await ask(model, PROMPT(spec.instruction), b64);
      const ms = Date.now() - t0;
      if (error) {
        console.log(`   ${model.padEnd(42)} ERROR (${ms}ms): ${error.slice(0, 80)}`);
        summary[model].fail++;
        continue;
      }
      const s = score(picks, spec.picks);
      summary[model][s.verdict === 'PASS' ? 'pass' : s.verdict === 'PARTIAL' ? 'partial' : 'fail']++;
      const rawShort = (raw ?? '').replace(/\s+/g, ' ').slice(0, 60);
      console.log(`   ${model.padEnd(42)} ${s.verdict.padEnd(7)} picks=[${picks.join(',')}] ${ms}ms  "${rawShort}"`);
    }
    console.log('');
  }

  console.log('── Summary ──');
  console.log('model'.padEnd(42) + '  pass  partial  fail');
  for (const [m, s] of Object.entries(summary)) {
    console.log(m.padEnd(42) + `   ${s.pass}      ${s.partial}       ${s.fail}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
