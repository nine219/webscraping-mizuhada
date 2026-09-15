/**
 * src/analysis/comments.ts
 *
 * Single home for comment-content normalisation and filtering logic that does
 * NOT need a LLM. Keeps sentiment.ts free of regex grime and lets scrapers,
 * /social queries, and one-off scripts share the same definition of "junk
 * comment we should not classify or surface."
 *
 * ── Adding a new filter ──
 * To exclude a new class of junk (sticker, emoji, spam phrase, profanity-only,
 * etc.), add the predicate inside this file and OR it into shouldKeepComment().
 * Every scraper calls shouldKeepComment() — they don't import individual
 * predicates — so one change here propagates to TikTok, Instagram, XHS, and
 * any future platform without touching their files.
 *
 * For SQL-side filters (mention stream, sentiment classifier) extend
 * noiseExcludeSql() with the same pattern list. Read-side and write-side
 * stay in sync because both walk the same NOISE_PATTERNS array.
 */

// ── Noise patterns ────────────────────────────────────────────────────────────
// Sticker placeholders (TikTok renders sticker-only comments as the literal
// text "[สติกเกอร์]" / "[Sticker]"). They have no sentiment signal and they
// inflate the per-brand comment counts on /social.
//
// Each pattern is a literal substring that must appear in the comment body
// for it to be considered noise. Keep them anchored to TikTok/IG conventions —
// do not match anything that could appear inside a real user reply.
export const NOISE_PATTERNS: readonly string[] = [
  '[สติกเกอร์]', // TikTok Thai sticker placeholder
  '[Sticker]',   // TikTok English sticker placeholder
  '[贴纸]',       // XHS / Douyin sticker placeholder (Simplified Chinese)
];

/**
 * Return true when a comment body is just a sticker / placeholder and carries
 * no sentiment-bearing text. Whitespace is trimmed first so "[สติกเกอร์]   "
 * still counts as noise.
 *
 * A comment counts as noise if, after stripping every NOISE_PATTERNS token,
 * nothing meaningful remains (length <= 1 char, common emojis aside).
 */
export function isNoiseComment(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  let stripped = trimmed;
  for (const pat of NOISE_PATTERNS) {
    // Use split/join to remove ALL occurrences without escaping regex meta-chars.
    stripped = stripped.split(pat).join('');
  }
  // Strip whitespace only — keep emojis intact so we don't drop genuine emoji
  // replies (those still carry sentiment via Gemini).
  stripped = stripped.replace(/\s+/g, '');
  return stripped.length === 0;
}

// ── Emoji / symbol-only comments ──────────────────────────────────────────────
// Strip emoji (pictographs, skin tones, flags, ZWJ, variation/keycap selectors),
// then punctuation/symbols/whitespace. Digits and letters survive (e.g. Thai "555").
// If nothing meaningful remains, the comment is emoji/symbol-only — no sentiment
// signal to extract.
const EMOJI_STRIP = /[\p{Extended_Pictographic}‍️︎⃣\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

// Shared by isEmojiOnly and isMentionOnly so the definition of "nothing
// meaningful remains" can't silently drift between the two checks.
function stripEmojiAndPunctuation(s: string): string {
  return s.replace(EMOJI_STRIP, '').replace(/[\p{P}\p{S}\s]/gu, '').trim();
}

export function isEmojiOnly(text: string | null | undefined): boolean {
  if (!text) return true;
  return stripEmojiAndPunctuation(text).length === 0;
}

// ── Mention-only comments ─────────────────────────────────────────────────────
// A comment that's just one or more @handles ("@friend", "@user1 @user2 😂")
// is a tag/notification ping, not a reaction to the brand — no sentiment to
// extract. Strip @mentions, then the same emoji/punctuation/whitespace as
// isEmojiOnly; if nothing meaningful remains AND there was actually a mention
// to strip (so plain text with no @ at all doesn't hit this by accident),
// it's mention-only noise.
//
// This does NOT apply when the mention itself IS the point — a top-level UGC
// post/tweet discovered by keyword search whose entire content is "@ourbrand
// 😍" is a genuine, valuable brand tag, not a notification ping to a friend.
// Callers on that path pass allowMentionOnly:true via shouldKeepComment to
// skip this check entirely; it only makes sense for actual replies/comments.
const MENTION_PATTERN = /@[a-zA-Z0-9._-]+/g;
export function isMentionOnly(text: string | null | undefined): boolean {
  if (!text) return false;
  const withoutMentions = text.replace(MENTION_PATTERN, '');
  if (withoutMentions.length === text.length) return false; // no @mention present
  return stripEmojiAndPunctuation(withoutMentions).length === 0;
}

// ── Public scrape-time gate ───────────────────────────────────────────────────
/**
 * The ONE check every comment scraper should call before INSERT.
 *
 * Returns false → drop the comment silently. Returns true → keep it.
 *
 * Adding a new filter? Add a predicate above and OR it into this function. The
 * three scrapers (TikTok / Instagram / XHS) call this function — they do not
 * call individual predicates — so the propagation cost of a new junk pattern
 * is one line, in this file.
 *
 * `opts.allowMentionOnly` — pass true from call sites saving a top-level
 * UGC post/tweet discovered via keyword search (not a reply/comment), where
 * a bare brand @mention IS the content signal, not notification-ping noise.
 */
export function shouldKeepComment(
  text: string | null | undefined,
  opts?: { allowMentionOnly?: boolean },
): boolean {
  if (isEmojiOnly(text))    return false;
  if (isNoiseComment(text)) return false;
  if (!opts?.allowMentionOnly && isMentionOnly(text)) return false;
  return true;
}

/**
 * Build a Postgres `WHERE` fragment that excludes noise comments from a
 * social_comments query. Pass the column alias (e.g. `sc.content`) — returns
 * a parameter-less fragment safe to inline (NOISE_PATTERNS is a hardcoded
 * compile-time list, not user input).
 *
 * Example:
 *   `... WHERE ${noiseExcludeSql('sc.content')} AND sc.platform = $1`
 */
export function noiseExcludeSql(column: string): string {
  // ILIKE matches case-insensitively. TRIM removes outer whitespace so
  // "   [สติกเกอร์]" still hits the equality check.
  const literals = NOISE_PATTERNS.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  return `(TRIM(${column}) NOT IN (${literals}))`;
}

// ── Counting / inspection ─────────────────────────────────────────────────────
/**
 * Count rows currently caught by NOISE_PATTERNS. Useful for a one-shot health
 * check (`ts-node src/analysis/comments.ts count`) when adding a new pattern.
 *
 * We do NOT mutate noise rows. The CHECK constraint on social_comments.sentiment
 * forbids a sentinel value, and we don't need one: noiseExcludeSql() filters
 * them out at every read site (sentiment classifier and /api/social), so the
 * rows stay in the DB for audit + future re-scrape detection but disappear
 * from every user-visible surface.
 */
export async function countNoiseComments(): Promise<number> {
  const { socialQueryOne } = await import('../db/social-client');
  const row = await socialQueryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM social_comments
     WHERE TRIM(content) = ANY($1::text[])`,
    [NOISE_PATTERNS as unknown as string[]],
  );
  return parseInt(row?.n ?? '0', 10);
}

if (require.main === module) {
  countNoiseComments()
    .then((n) => {
      console.log(`[comments] Patterns: ${NOISE_PATTERNS.join(' · ')}`);
      console.log(`[comments] Noise rows currently in social_comments: ${n}`);
      console.log(`[comments] Rows stay in DB; noiseExcludeSql() filters them out of every read.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[comments] count failed:', err);
      process.exit(1);
    });
}
