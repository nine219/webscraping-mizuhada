import axios from 'axios';

// Provider-agnostic chat client for translation/utility LLM calls (OpenAI-compatible
// JSON shape). Used to translate CN-platform comments to Thai before sentiment.
//
// Provider auto-select (first with a key wins):
//   1. OpenRouter — OPENROUTER_API_KEY
//        primary model:  OPENROUTER_MODEL          (default qwen/qwen-plus)
//        fallback model: OPENROUTER_FALLBACK_MODEL (default deepseek/deepseek-chat)
//      On 402/429/auth/5xx across all keys on primary, retries fallback model on
//      the same keys before giving up.
//   2. DeepSeek  — DEEPSEEK_API_KEY (legacy native path; only used when no
//                  OPENROUTER_API_KEY is set).

interface Provider {
  name: string;
  baseUrl: string;
  model: string;
  fallbackModel?: string;
  keys: string[];
  headers?: Record<string, string>;
}

function envKeys(primaryName: string): string[] {
  const keys: string[] = [];
  const primary = process.env[primaryName];
  if (primary && primary.trim() && !primary.startsWith('your_')) keys.push(primary.trim());
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`${primaryName}_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  return keys;
}

function selectProvider(): Provider | null {
  const orKeys = envKeys('OPENROUTER_API_KEY');
  if (orKeys.length > 0) {
    return {
      name: 'OpenRouter',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_MODEL || 'qwen/qwen-plus',
      fallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'deepseek/deepseek-chat',
      keys: orKeys,
      headers: {
        'HTTP-Referer': 'https://mizuhada.local',
        'X-Title': 'Mizuhada Social Intelligence',
      },
    };
  }

  const dsKeys = envKeys('DEEPSEEK_API_KEY');
  if (dsKeys.length > 0) {
    return {
      name: 'DeepSeek',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      keys: dsKeys,
    };
  }

  return null;
}

const PROVIDER = selectProvider();
let currentIdx = 0;

// Native DeepSeek path, built regardless of which provider selectProvider() picked
// above — used when Admin > AI usage's provider toggle is explicitly set to
// "deepseek" (bypasses the OpenRouter-first auto-select).
function buildDeepSeekProvider(): Provider | null {
  const dsKeys = envKeys('DEEPSEEK_API_KEY');
  if (dsKeys.length === 0) return null;
  return {
    name: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    keys: dsKeys,
  };
}
const DEEPSEEK_PROVIDER = buildDeepSeekProvider();
let deepseekIdx = 0;

export function hasLlmKey(): boolean {
  return PROVIDER !== null;
}

export function hasDeepSeekKey(): boolean {
  return DEEPSEEK_PROVIDER !== null;
}

export function activeProviderName(): string {
  if (!PROVIDER) return 'none';
  const fb = PROVIDER.fallbackModel ? ` → ${PROVIDER.fallbackModel}` : '';
  return `${PROVIDER.name} (${PROVIDER.model}${fb})`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatChoice { message?: { content?: string } }
interface UsageField { prompt_tokens?: number; completion_tokens?: number }
interface ChatResponse { choices?: ChatChoice[]; usage?: UsageField }

export interface TokenUsage { promptTokens: number; completionTokens: number }

// OpenAI-compatible message content can be a plain string or multimodal parts.
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
type RawMessage = { role: string; content: string | ContentPart[] };

// One pass across all keys for a single model. Returns text on success,
// or { failed: true, exhausted: boolean } so caller can decide whether to
// try the fallback model. `exhausted` = at least one 402/429 seen (suggests
// credit/rate cap), worth trying a different model.
async function postChatOnce(
  provider: Provider,
  getIdx: () => number,
  setIdx: (n: number) => void,
  messages: RawMessage[],
  model: string,
  opts: { temperature?: number; maxTokens?: number },
): Promise<{ text: string | null; sawCapHit: boolean; usage: TokenUsage | null }> {
  let sawCapHit = false;
  for (let attempt = 0; attempt < provider.keys.length; attempt++) {
    const idx = (getIdx() + attempt) % provider.keys.length;
    try {
      const resp = await axios.post<ChatResponse>(
        `${provider.baseUrl}/chat/completions`,
        {
          model,
          messages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 2000,
          stream: false,
        },
        {
          headers: {
            Authorization: `Bearer ${provider.keys[idx]}`,
            'Content-Type': 'application/json',
            ...(provider.headers ?? {}),
          },
          timeout: 60_000,
        }
      );
      setIdx(idx);
      const usage = resp.data?.usage
        ? { promptTokens: resp.data.usage.prompt_tokens ?? 0, completionTokens: resp.data.usage.completion_tokens ?? 0 }
        : null;
      return { text: resp.data?.choices?.[0]?.message?.content ?? null, sawCapHit, usage };
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const retryable = status === 402 || status === 429 || status === 401 || status === 503 || status === 500;
      if (status === 402 || status === 429) sawCapHit = true;
      const msg = axios.isAxiosError(err)
        ? (err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message)
        : String(err);
      if (retryable && attempt < provider.keys.length - 1) {
        console.warn(`[LLM/${provider.name}/${model}] key ${idx + 1}/${provider.keys.length} failed (${status}) — rotating`);
        continue;
      }
      console.error(`[LLM/${provider.name}/${model}] request failed (${status}):`, msg);
      return { text: null, sawCapHit, usage: null };
    }
  }
  return { text: null, sawCapHit, usage: null };
}

interface PostChatResult { text: string | null; usage: TokenUsage | null; provider: string; model: string }

// Shared POST against the auto-selected provider (OpenRouter-first, DeepSeek
// fallback). Tries primary model across all keys; on credit/rate-cap exhaustion
// retries the fallback model (same keys) once.
async function postChat(
  messages: RawMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number },
): Promise<PostChatResult> {
  if (!PROVIDER) return { text: null, usage: null, provider: 'none', model: '' };
  const primary = opts.model ?? PROVIDER.model;
  const first = await postChatOnce(PROVIDER, () => currentIdx, (n) => { currentIdx = n; }, messages, primary, opts);
  if (first.text !== null) return { text: first.text, usage: first.usage, provider: PROVIDER.name, model: primary };

  const fb = PROVIDER.fallbackModel;
  // Only auto-fallback if caller didn't pin a specific model, and we actually saw
  // a cap-hit on primary (not a malformed-request 400 etc.).
  if (fb && fb !== primary && !opts.model && first.sawCapHit) {
    console.warn(`[LLM/${PROVIDER.name}] primary ${primary} exhausted — falling back to ${fb}`);
    const second = await postChatOnce(PROVIDER, () => currentIdx, (n) => { currentIdx = n; }, messages, fb, opts);
    if (second.text !== null) return { text: second.text, usage: second.usage, provider: PROVIDER.name, model: fb };
  }
  return { text: null, usage: null, provider: PROVIDER.name, model: primary };
}

// Forces the native DeepSeek path — used when Admin > AI usage's provider
// toggle is explicitly "deepseek", ignoring whatever selectProvider() auto-picked.
async function postChatDeepSeek(
  messages: RawMessage[],
  opts: { temperature?: number; maxTokens?: number },
): Promise<PostChatResult> {
  if (!DEEPSEEK_PROVIDER) return { text: null, usage: null, provider: 'DeepSeek', model: '' };
  const result = await postChatOnce(
    DEEPSEEK_PROVIDER, () => deepseekIdx, (n) => { deepseekIdx = n; },
    messages, DEEPSEEK_PROVIDER.model, opts,
  );
  return { text: result.text, usage: result.usage, provider: 'DeepSeek', model: DEEPSEEK_PROVIDER.model };
}

/**
 * Single chat completion. Rotates keys on 402/429/auth/5xx errors, falls back
 * to OPENROUTER_FALLBACK_MODEL when primary model is credit/rate capped.
 * Returns assistant text, or null when unconfigured / all attempts fail.
 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number } = {}
): Promise<string | null> {
  const r = await postChat(messages, opts);
  return r.text;
}

export interface UsageResult { text: string | null; usage: TokenUsage | null; provider: string; model: string }

// Same as chatComplete but also returns token usage + which provider/model actually
// answered — used by callers that log to ai_usage_log (Admin > AI usage).
export async function chatCompleteWithUsage(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number } = {}
): Promise<UsageResult> {
  return postChat(messages, opts);
}

// Forces DeepSeek regardless of what selectProvider() auto-picked (OpenRouter
// wins there if OPENROUTER_API_KEY is set). Used when the Admin provider toggle
// is explicitly "deepseek". Returns null text if no DEEPSEEK_API_KEY configured.
export async function chatCompleteDeepSeek(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<UsageResult> {
  return postChatDeepSeek(messages, opts);
}

/**
 * Vision chat completion — sends a text prompt plus one or more base64 images to a
 * vision-language model (default Qwen2.5-VL on OpenRouter). Used by the XHS captcha
 * solver. Returns assistant text or null.
 */
export async function chatCompleteVision(
  prompt: string,
  images: Array<{ base64: string; mime?: string }>,
  opts: { model?: string; temperature?: number; maxTokens?: number } = {}
): Promise<string | null> {
  const r = await chatCompleteVisionWithUsage(prompt, images, opts);
  return r.text;
}

// Same as chatCompleteVision but also returns token usage — used by the XHS
// captcha solver to log to ai_usage_log.
export async function chatCompleteVisionWithUsage(
  prompt: string,
  images: Array<{ base64: string; mime?: string }>,
  opts: { model?: string; temperature?: number; maxTokens?: number } = {}
): Promise<UsageResult> {
  if (!PROVIDER) return { text: null, usage: null, provider: 'none', model: '' };
  const parts: ContentPart[] = [{ type: 'text', text: prompt }];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mime ?? 'image/png'};base64,${img.base64}` } });
  }
  const model = opts.model
    ?? process.env.OPENROUTER_VISION_MODEL
    ?? (PROVIDER.name === 'OpenRouter' ? 'qwen/qwen-2.5-vl-72b-instruct' : PROVIDER.model);
  return postChat([{ role: 'user', content: parts }], { ...opts, model });
}
