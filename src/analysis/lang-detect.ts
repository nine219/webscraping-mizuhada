// Matches any script that isn't Thai/English/common punctuation/digits/emoji —
// Chinese, Vietnamese diacritics, Japanese, Korean, etc. Used to mark scraped
// content as "already Thai/English, no translation needed" at insert time,
// so the translate.ts backfill never has to re-check or re-send it to an LLM.
const NON_TH_EN_RE = /[぀-ヿ㐀-鿿가-힯Ā-ɏḀ-ỿ]/;

export function needsTranslation(content: string): boolean {
  return NON_TH_EN_RE.test(content);
}
