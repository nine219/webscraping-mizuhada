/**
 * One-off diagnostic export: scrape RAW XHS search results for a keyword
 * (no brand-relevance filtering at all) and dump every note's caption +
 * English translation + note link to a CSV, so a human can eyeball which
 * ones are actually relevant and tell us what Chinese-language variants
 * (if any) to add to XHS_BRAND_KEYWORDS.
 *
 * Usage: XHS_SEARCH_KEYWORD=mizumi npm run tool:xhs-raw-export
 * Output: scratchpad-style CSV next to this file's cwd (see OUT_PATH below).
 */
import * as fs from 'fs';
import * as path from 'path';
import { launchPersistentContext, hasPersistentProfile, launchBrowser, newStealthContext, warmUp, PLATFORM_SLUG } from '../scrapers/xhs/xhs-browser';
import { collectNotesForKeyword } from '../scrapers/xhs/xhs-search';
import { XhsNote } from '../scrapers/xhs/xhs-browser';
import { getGeminiModel, DEFAULT_MODEL } from '../analysis/gemini-client';

const OUT_PATH = path.join(process.cwd(), `xhs-raw-export-${Date.now()}.csv`);
const BATCH_SIZE = 20;

function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function noteUrl(note: XhsNote): string {
  return note.xsecToken
    ? `https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${note.xsecToken}&xsec_source=pc_search`
    : `https://www.xiaohongshu.com/explore/${note.id}`;
}

async function translateBatchToEnglish(texts: string[]): Promise<string[]> {
  const model = getGeminiModel(DEFAULT_MODEL);
  if (!model) return texts.map(() => '');
  const prompt = `Translate each of these Xiaohongshu (Chinese social media) post captions into natural English.
Keep brand/product names as-is. Return ONLY a JSON array of strings, same order, same length as input — one English translation per caption, no commentary.

Captions:
${JSON.stringify(texts)}`;
  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return texts.map(() => '');
    const parsed = JSON.parse(match[0]) as string[];
    return texts.map((_, i) => parsed[i] ?? '');
  } catch (err) {
    console.warn('[xhs-raw-export] translate batch failed:', err instanceof Error ? err.message : err);
    return texts.map(() => '');
  }
}

async function main() {
  const keyword = process.env.XHS_SEARCH_KEYWORD;
  if (!keyword) {
    console.error('Set XHS_SEARCH_KEYWORD env var to the keyword to search.');
    process.exit(1);
  }

  const usePersistent = hasPersistentProfile();
  const ctx = usePersistent ? await launchPersistentContext() : await newStealthContext(await launchBrowser());
  console.log(`[xhs-raw-export] Using ${usePersistent ? 'persistent' : 'stealth'} context (platform=${PLATFORM_SLUG})`);

  try {
    const page = await ctx.newPage();
    await warmUp(page);

    console.log(`[xhs-raw-export] Searching "${keyword}" — no relevance filtering, capturing everything...`);
    const notes = await collectNotesForKeyword(page, keyword, 0);
    console.log(`[xhs-raw-export] Collected ${notes.length} raw notes.`);

    // Translate in batches
    const translations: string[] = [];
    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      const batch = notes.slice(i, i + BATCH_SIZE);
      const texts = batch.map((n) => `${n.title}\n${n.desc}`.trim());
      const translated = await translateBatchToEnglish(texts);
      translations.push(...translated);
      console.log(`[xhs-raw-export] Translated ${Math.min(i + BATCH_SIZE, notes.length)}/${notes.length}`);
    }

    const rows = notes.map((note, i) => [
      note.id,
      note.title,
      note.desc,
      translations[i] ?? '',
      note.author ?? '',
      noteUrl(note),
      note.likes ?? '',
      note.commentsCount ?? '',
      note.noteType ?? '',
    ]);

    const header = ['note_id', 'title', 'desc_raw', 'english_translation', 'author', 'note_url', 'likes', 'comments', 'note_type'];
    const csv = [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
    fs.writeFileSync(OUT_PATH, '﻿' + csv, 'utf8');
    console.log(`[xhs-raw-export] Wrote ${notes.length} rows to ${OUT_PATH}`);
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
