import { Page, Frame, ElementHandle } from 'playwright';
import { chatCompleteVisionWithUsage, hasLlmKey } from '../../analysis/llm-client';
import { getGeminiModel } from '../../analysis/gemini-client';
import { getAiSettings } from '../../config/settings-loader';
import { logAiUsage } from '../../analysis/ai-usage';

// Auto-solve the XHS "安全验证" image-selection captcha with a vision-LLM.
// Strategy: read the Chinese instruction, screenshot each tile, ask the VLM
// which tiles match, click them, submit; on failure click 换一换 (refresh) and
// retry. Best-effort — XHS markup shifts, so it logs verbosely and falls back
// to manual/abort (handled by the caller) when it can't solve.
//
// Provider preference:
//   1. Native Gemini API (via @google/generative-ai SDK, GEMINI_API_KEY)
//   2. OpenRouter VLM fallback (via OPENROUTER_API_KEY)
// Model: XHS_CAPTCHA_MODEL env (default gemini-3.1-flash-lite via either path)

const LABEL = '[XHS-Captcha]';
const MAX_ATTEMPTS = 4;

type Root = Page | Frame;

// The captcha may render in an iframe; find the frame holding the panel text.
async function captchaRoot(page: Page): Promise<Root> {
  for (const f of page.frames()) {
    try {
      const t = await f.evaluate(() => document.body?.innerText ?? '');
      if (/安全验证|换一换|请选择/.test(t)) return f;
    } catch { /* cross-origin frame — skip */ }
  }
  return page;
}

// Pull the visible panel text (instruction + description) to feed the VLM.
async function panelText(root: Root): Promise<string> {
  try {
    return (await root.evaluate(() => document.body?.innerText ?? '')).slice(0, 500);
  } catch {
    return '';
  }
}

// Candidate tile images: <img> elements roughly square and tile-sized. XHS lays
// out 6 in a 3×2 grid. Returns them in DOM order (= reading order, top-left first).
async function findTiles(root: Root): Promise<ElementHandle<SVGElement | HTMLElement>[]> {
  const imgs = await root.$$('img');
  const tiles: ElementHandle<SVGElement | HTMLElement>[] = [];
  for (const img of imgs) {
    const box = await img.boundingBox().catch(() => null);
    if (!box) continue;
    const squareish = Math.abs(box.width - box.height) < box.width * 0.5;
    if (box.width >= 60 && box.width <= 240 && squareish) tiles.push(img);
  }
  return tiles;
}

async function clickByText(root: Root, text: string): Promise<boolean> {
  try {
    const el = root.locator(`text="${text}"`).last();
    if (await el.count() === 0) return false;
    await el.click({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function parsePickJson(text: string | null): number[] {
  if (!text) return [];
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]) as { pick?: number[] };
    return Array.isArray(parsed.pick) ? parsed.pick.filter((n) => Number.isInteger(n) && n >= 1) : [];
  } catch {
    return [];
  }
}

const CAPTCHA_PROMPT =
  `You are solving a Chinese/English image-selection CAPTCHA.\n` +
  `Instruction shown on the page: """%s"""\n` +
  `You are given %d images, numbered 1 to %d in the order provided.\n` +
  `Decide which images satisfy the instruction. Think about the meaning carefully ` +
  `(e.g. "可以直接生吃的水果" = fruit that can be eaten raw without cooking).\n` +
  `Return ONLY JSON: {"pick":[indices]} — the 1-based numbers of the matching images. No prose.`;

function buildPrompt(instruction: string, count: number): string {
  return CAPTCHA_PROMPT.replace('%s', instruction).replace(/%d/g, String(count));
}

// Ask the VLM which tiles satisfy the instruction. Returns 1-based indices.
// Preference: native Gemini API (cheaper, no proxy), then OpenRouter VLM fallback.
// Default model: gemini-3.1-flash-lite (5/5 in benchmark — cheap and accurate).
// Override via XHS_CAPTCHA_MODEL env var (e.g. "google/gemini-3.1-flash-lite"
// for OpenRouter, or "gemini-3.1-flash-lite" for native Gemini).
async function pickTiles(instruction: string, tilePngs: string[]): Promise<number[]> {
  const prompt = buildPrompt(instruction, tilePngs.length);
  const modelCfg = process.env.XHS_CAPTCHA_MODEL || 'google/gemini-3.1-flash-lite';
  const ai = await getAiSettings();

  // DeepSeek has no vision model — when the Admin toggle is set to "deepseek"
  // skip the native Gemini attempt entirely and go straight to the OpenRouter
  // VLM fallback (Qwen2.5-VL), same as when Gemini is quota-exhausted.
  if (ai.provider === 'gemini') {
    const geminiModel = getGeminiModel(modelCfg.replace(/^google\//, ''));
    if (geminiModel) {
      try {
        const result = await geminiModel.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              ...tilePngs.map((b64) => ({ inlineData: { mimeType: 'image/png' as const, data: b64 } })),
            ],
          }],
        });
        const text = result.response.text();
        const picks = parsePickJson(text);
        logAiUsage({
          provider: 'gemini', model: modelCfg.replace(/^google\//, ''), purpose: 'captcha-vision',
          tokensIn: result.response.usageMetadata?.promptTokenCount ?? null,
          tokensOut: result.response.usageMetadata?.candidatesTokenCount ?? null,
          success: picks.length > 0, errorMessage: picks.length > 0 ? null : 'no picks returned',
        }).catch(() => {});
        if (picks.length > 0) return picks;
        console.warn(`${LABEL} Gemini returned no picks — falling back to OpenRouter`);
      } catch (err) {
        const msg = String(err).slice(0, 200);
        const is429 = msg.includes('429') || msg.includes('quota') || msg.includes('rate');
        if (is429) console.warn(`${LABEL} Gemini quota hit — falling back to OpenRouter`);
        else console.warn(`${LABEL} Gemini error — falling back to OpenRouter: ${msg}`);
        logAiUsage({ provider: 'gemini', model: modelCfg.replace(/^google\//, ''), purpose: 'captcha-vision', tokensIn: null, tokensOut: null, success: false, errorMessage: msg }).catch(() => {});
      }
    }
  }

  // Fallback / deepseek-toggle path: OpenRouter VLM (model name with google/ prefix if using Gemini via OpenRouter)
  const r = await chatCompleteVisionWithUsage(prompt, tilePngs.map((b) => ({ base64: b })), {
    model: modelCfg,
    temperature: 0,
    maxTokens: 60,
  });
  const picks = parsePickJson(r.text);
  logAiUsage({
    provider: r.provider.toLowerCase(), model: r.model || modelCfg, purpose: 'captcha-vision',
    tokensIn: r.usage?.promptTokens ?? null, tokensOut: r.usage?.completionTokens ?? null,
    success: picks.length > 0, errorMessage: picks.length > 0 ? null : 'no picks returned',
  }).catch(() => {});
  return picks;
}

/**
 * Attempt to auto-solve the captcha. Returns true if the panel is gone afterwards.
 * `detectStillPresent` lets the caller re-use its own detector to confirm.
 */
export async function solveXhsCaptcha(
  page: Page,
  detectStillPresent: (p: Page) => Promise<boolean>,
): Promise<boolean> {
  if (!hasLlmKey() && !getGeminiModel('gemini-3.1-flash-lite')) {
    console.warn(`${LABEL} No Gemini/LLM key — cannot auto-solve.`);
    return false;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const root = await captchaRoot(page);
    const instruction = await panelText(root);
    const tiles = await findTiles(root);
    console.log(`${LABEL} attempt ${attempt}/${MAX_ATTEMPTS}: found ${tiles.length} tiles · instruction="${instruction.replace(/\s+/g, ' ').slice(0, 80)}"`);

    if (tiles.length < 4 || tiles.length > 9) {
      console.warn(`${LABEL} unexpected tile count (${tiles.length}) — markup may have changed.`);
      return false;
    }

    const pngs: string[] = [];
    for (const t of tiles) {
      const buf = await t.screenshot().catch(() => null);
      if (buf) pngs.push(buf.toString('base64'));
    }
    if (pngs.length !== tiles.length) {
      console.warn(`${LABEL} could not screenshot all tiles.`);
      return false;
    }

    const pick = await pickTiles(instruction, pngs);
    console.log(`${LABEL} VLM picked tiles: [${pick.join(', ')}]`);
    if (pick.length === 0) {
      await clickByText(root, '换一换'); // refresh for a new (maybe easier) set
      await page.waitForTimeout(1500);
      continue;
    }

    for (const idx of pick) {
      const tile = tiles[idx - 1];
      if (tile) await tile.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // Submit (button labelled 验证 — NOT the 安全验证 title).
    if (!(await clickByText(root, '验证'))) {
      await clickByText(root, '确定'); // fallback label
    }
    await page.waitForTimeout(2500);

    if (!(await detectStillPresent(page))) {
      console.log(`${LABEL} ✓ solved on attempt ${attempt}.`);
      return true;
    }
    console.warn(`${LABEL} still present after attempt ${attempt} — refreshing.`);
    await clickByText(root, '换一换');
    await page.waitForTimeout(1500);
  }

  console.warn(`${LABEL} gave up after ${MAX_ATTEMPTS} attempts.`);
  return false;
}
