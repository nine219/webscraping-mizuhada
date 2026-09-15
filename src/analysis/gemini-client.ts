import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

// Loads GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, ... from env
function loadKeys(): string[] {
  const keys: string[] = [];
  const primary = process.env.GEMINI_API_KEY;
  if (primary && primary !== 'your_gemini_api_key_here') keys.push(primary);
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  return keys;
}

const KEYS = loadKeys();
let currentIdx = 0;
// Timestamp after which the key is usable again (0 = available now)
const exhaustedUntil: number[] = new Array(Math.max(KEYS.length, 1)).fill(0);

export function hasGeminiKey(): boolean {
  return KEYS.length > 0;
}

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

export function getGeminiModel(modelName = DEFAULT_MODEL): GenerativeModel | null {
  if (KEYS.length === 0) return null;

  const now = Date.now();
  for (let i = 0; i < KEYS.length; i++) {
    const idx = (currentIdx + i) % KEYS.length;
    if (now >= exhaustedUntil[idx]) {
      if (process.env.TIKTOK_DEBUG === '1' && idx !== currentIdx) {
        console.log(`[Gemini] Switched to key ${idx + 1}/${KEYS.length}`);
      }
      currentIdx = idx;
      if (process.env.TIKTOK_DEBUG === '1') {
        console.log(`[Gemini] Using key ${idx + 1}/${KEYS.length} model=${modelName}`);
      }
      return new GoogleGenerativeAI(KEYS[idx]).getGenerativeModel({ model: modelName });
    }
  }

  const nextReset = Math.min(...exhaustedUntil.filter((t) => t > 0));
  const waitMin = Math.ceil((nextReset - now) / 60_000);
  console.warn(`[Gemini] All ${KEYS.length} key(s) exhausted. Next reset in ~${waitMin}min`);
  return null;
}

// Call when the current key returns 429 / quota exceeded.
// retryAfterMs: parse from API response if available, else default 24h.
export function markCurrentKeyExhausted(retryAfterMs?: number): void {
  if (KEYS.length === 0) return;
  const wait = retryAfterMs ?? 24 * 60 * 60 * 1000;
  exhaustedUntil[currentIdx] = Date.now() + wait;
  const next = (currentIdx + 1) % KEYS.length;
  console.log(`[Gemini] Key ${currentIdx + 1}/${KEYS.length} quota exhausted → rotating to key ${next + 1}`);
  currentIdx = next;
}

// Parse retryDelay from Gemini 429 error message ("Please retry in 40.0s")
export function parseRetryAfterMs(errMsg: string): number | undefined {
  const m = errMsg.match(/retry in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) + 2000 : undefined;
}
