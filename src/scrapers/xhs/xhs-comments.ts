import { Browser, BrowserContext, Page } from 'playwright';
import { BaseSocialScraper, RawSocialPost } from './base-social';
import { socialQuery } from '../../db/social-client';
import {
  PLATFORM_SLUG, LABEL, XhsNote, XhsComment,
  launchBrowser, newStealthContext, hasXhsCookies, warmUp, handleCaptcha,
  launchPersistentContext, hasPersistentProfile,
} from './xhs-browser';

interface XhsCommentsResponse {
  data?: {
    comments?: XhsComment[];
    target_comment?: XhsComment;
  };
}

// XHS web app-gates individual note pages (explore/<id> → 404 "open App to view").
// So by default we store note metadata straight from the list API and DON'T open
// each note. Set XHS_SCRAPE_COMMENTS=1 to attempt comment scraping anyway.
export function commentsEnabled(): boolean {
  return process.env.XHS_SCRAPE_COMMENTS === '1';
}

// XHS note IDs are MongoDB-style ObjectIDs: first 8 hex chars = unix seconds.
// The web list API omits publish time, so derive it from the ID instead.
export function publishedAtFromNoteId(id: string): string | undefined {
  const hex = id.slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(hex)) return undefined;
  const ts = parseInt(hex, 16);
  if (ts < 1_500_000_000 || ts > 4_000_000_000) return undefined; // sanity: ~2017–2096
  return new Date(ts * 1000).toISOString();
}

export interface XhsNoteDetail {
  desc: string;
  tagList: Array<{ id: string; name: string; type: string }>;
}

/**
 * Read the note's full content (desc + hashtag tagList) from the SSR
 * __INITIAL_STATE__ Vue state — XHS never sends this over an XHR, it's
 * server-rendered directly into the page on load. Same _rawValue/_value
 * unwrap as mergeStateNotes() in xhs-feed.ts, different map
 * (note.noteDetailMap vs user.notes).
 */
async function readNoteDetailState(page: Page, noteId: string): Promise<XhsNoteDetail | null> {
  return page.evaluate((id: string) => {
    const s = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__;
    const noteState = s?.note as Record<string, unknown> | undefined;
    const mapRef = noteState?.noteDetailMap as { _rawValue?: unknown; _value?: unknown } | undefined;
    const map = (mapRef?._rawValue ?? mapRef?._value ?? mapRef) as
      Record<string, { note?: Record<string, unknown> }> | undefined;
    const n = map?.[id]?.note;
    if (!n) return null;
    return {
      desc: (n.desc as string) ?? '',
      tagList: (n.tagList as Array<{ id: string; name: string; type: string }>) ?? [],
    };
  }, noteId).catch(() => null);
}

/**
 * Visit a note page to get its real caption — the search/feed list APIs only
 * ever send `display_title` (confirmed empirically: XHS's search-notes response
 * carries no `desc` field at all, on any note). No comment scroll — separate
 * from scrapeNoteComments, callable on its own when only the caption is needed.
 * Best-effort: null on app-wall/missing state, caller keeps the short title.
 */
export async function fetchNoteDetail(page: Page, note: XhsNote): Promise<XhsNoteDetail | null> {
  const noteUrl = note.xsecToken
    ? `https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${note.xsecToken}&xsec_source=pc_search`
    : `https://www.xiaohongshu.com/explore/${note.id}`;
  try {
    await page.goto(noteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_500);
    await handleCaptcha(page);
    const detail = await readNoteDetailState(page, note.id);
    return detail && detail.desc ? detail : null;
  } catch (err) {
    console.warn(`${LABEL} fetchNoteDetail failed for ${note.id}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Open a note page and capture its comments by intercepting the comments API.
 * Returns one RawSocialPost per real comment (linked to its note via postId),
 * or an empty array when no comments are captured. Notes themselves are stored
 * separately in xhs_posts (see upsertXhsPost).
 *
 * Shared by xhs-feed and xhs-search — the XHS analogue of tiktok-comments'
 * scrapePostComments.
 */
export async function scrapeNoteComments(page: Page, note: XhsNote): Promise<RawSocialPost[]> {
  const out: RawSocialPost[] = [];
  const collected = new Map<string, XhsComment>();

  const onResponse = async (resp: import('playwright').Response) => {
    if (!resp.ok()) return;
    const url = resp.url();
    // XHS comment endpoints vary by version: v1 note/<id>/comments, v2 comment/page, etc.
    const isComments = url.includes('/comment/page')
      || url.includes(`/note/${note.id}/comments`)
      || url.includes('/note/comments')
      || (url.includes('/comment') && url.includes('note_id'));
    if (!isComments) return;
    try {
      const body = await resp.json() as XhsCommentsResponse;
      const comments = body?.data?.comments ?? [];
      if (body?.data?.target_comment) comments.push(body.data.target_comment);
      for (const c of comments) {
        if (!c?.id) continue;
        collected.set(c.id, c);
        for (const sc of c.sub_comments ?? []) {     // nested replies
          if (sc?.id) collected.set(sc.id, sc);
        }
      }
    } catch { /* ignore non-JSON */ }
  };
  page.on('response', onResponse);

  // The xsec_token is what lets the note page load on web (without it → 404 app-wall).
  const noteUrl = note.xsecToken
    ? `https://www.xiaohongshu.com/explore/${note.id}?xsec_token=${note.xsecToken}&xsec_source=pc_user`
    : `https://www.xiaohongshu.com/explore/${note.id}`;
  try {
    await page.goto(noteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);
    await handleCaptcha(page); // pause for manual solve (headful) if the security panel appears

    // XHS note pages are two-pane: media on the LEFT, a scrollable comments column
    // on the RIGHT (~the right 75–80% of the viewport). Scrolling the window does
    // nothing to that column, so comment pagination never fires. Instead, park the
    // mouse over the comments column and wheel-scroll it (same approach as TikTok).
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const cx = Math.floor(vp.width * 0.78);   // right comments column
    const cy = Math.floor(vp.height * 0.5);
    await page.mouse.move(cx, cy);

    let prevSize = -1, stale = 0;
    for (let s = 0; s < 20; s++) {
      if (!page.url().includes(note.id) && !page.url().includes('/explore/')) {
        console.warn(`${LABEL} redirected off note ${note.id} — stopping (kept ${collected.size})`);
        break;
      }
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(1500);

      // XHS appends an end-of-list marker ("- THE END -" / "到底了" / "没有更多了")
      // once every comment is loaded — the authoritative stop signal.
      const atEnd = await page.evaluate(() => {
        const t = document.body.innerText;
        return t.includes('到底了') || t.includes('没有更多') || t.includes('已经到底') || /THE END/i.test(t);
      }).catch(() => false);
      if (atEnd) break;

      // Fallback stop: no new comments after several wheels (marker not found / hidden).
      if (collected.size === prevSize) { if (++stale >= 4) break; } else stale = 0;
      prevSize = collected.size;
    }
  } catch (err) {
    console.warn(`${LABEL} Note page failed for ${note.id}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    page.off('response', onResponse);
  }

  // Notes themselves live in xhs_posts now — here we emit only real comments,
  // linked to their note via postId (= note.id). No note-only fallback row.
  for (const c of collected.values()) {
    if (!isMeaningfulComment(c.content)) continue; // drop emoji-only / no-text noise
    out.push({
      externalId: `xhs_${note.id}_${c.id}`,
      content: c.content.trim(),
      platformPostUrl: noteUrl,
      authorHandle: c.user_info?.nickname ?? note.author,
      publishedAt: commentTime(c.create_time) ?? note.publishedAt,
      likesCount: c.like_count != null ? Number(c.like_count) : undefined,
      postId: note.id,             // link comment → xhs_posts.note_id
    });
  }

  return out;
}

// True if a comment has real text after stripping XHS emoji tags ([哭惹R], [doge]),
// unicode emoji, symbols, punctuation and whitespace. Filters out emoji-only noise.
export function isMeaningfulComment(text: string): boolean {
  if (!text) return false;
  const stripped = text
    .replace(/\[[^\]]{0,20}\]/g, '')                                   // XHS emoji tags
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{S}\p{P}\s]/gu, ''); // emoji/symbols/punct/ws
  const cjk = stripped.match(/[㐀-鿿぀-ヿ가-힯]/g)?.length ?? 0;
  const alnum = stripped.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return cjk >= 1 || alnum >= 2; // ≥1 CJK char OR ≥2 letters/digits
}

// XHS comment create_time is epoch ms (number) or an ISO string. Normalize to ISO.
function commentTime(t?: number | string): string | undefined {
  if (t == null) return undefined;
  if (typeof t === 'number') return new Date(t).toISOString();
  const n = Number(t);
  return Number.isFinite(n) && n > 1e12 ? new Date(n).toISOString() : t;
}

const RECENT_HOURS = 24;
const MAX_NOTES = 40;

// Pull recently-scraped notes (id + xsec_token + brand) from xhs_posts. The token
// is required to open the note page (else 404 app-wall). Newest tokens first.
async function recentNotes(): Promise<Array<{ id: string; token: string | null; brandSlug: string | null }>> {
  const rows = await socialQuery<{ note_id: string; xsec_token: string | null; brand_slug: string | null }>(
    `SELECT xp.note_id, xp.xsec_token, b.slug AS brand_slug
     FROM xhs_posts xp
     LEFT JOIN brands b ON b.id = xp.brand_id
     WHERE xp.scraped_at > NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY (xp.xsec_token IS NOT NULL) DESC, xp.scraped_at DESC
     LIMIT $2`,
    [RECENT_HOURS, MAX_NOTES],
  );
  return rows.map((r) => ({ id: r.note_id, token: r.xsec_token, brandSlug: r.brand_slug }));
}

// Standalone comments refresh — re-scrapes comments for notes seen in the last
// RECENT_HOURS. The XHS analogue of tiktok-comments' scrapeAllComments.
export class XhsCommentsScraper extends BaseSocialScraper {
  constructor() {
    super({ platformSlug: PLATFORM_SLUG });
  }

  async fetchPosts(): Promise<RawSocialPost[]> {
    if (!hasXhsCookies()) {
      console.warn(`${LABEL} No XHS_COOKIES set. XHS requires auth — see CN_SOCIAL_SETUP.md`);
      return [];
    }

    const notes = await recentNotes();
    if (notes.length === 0) {
      console.log(`${LABEL} No recent notes to refresh comments for.`);
      return [];
    }

    const usePersistent = hasPersistentProfile();
    let browser: Browser | undefined;
    let ctx: BrowserContext;
    if (usePersistent) {
      ctx = await launchPersistentContext();
    } else {
      browser = await launchBrowser();
      ctx = await newStealthContext(browser);
    }
    const out: RawSocialPost[] = [];
    try {
      const page = await ctx.newPage();
      await warmUp(page);
      console.log(`${LABEL} Refreshing comments for ${notes.length} notes`);
      for (const { id, token, brandSlug } of notes) {
        const note: XhsNote = { id, title: '', desc: '', author: '', url: `https://www.xiaohongshu.com/explore/${id}`, xsecToken: token ?? undefined };
        const rows = await scrapeNoteComments(page, note);
        if (brandSlug) for (const r of rows) r.brandSlug = brandSlug; // inherit note's brand
        out.push(...rows);
        await this.delay(2000 + Math.floor(Math.random() * 2000));
      }
      return out;
    } finally {
      if (browser) await browser.close();
      else await ctx.close();
    }
  }
}

export async function runXhsComments(): Promise<void> {
  await new XhsCommentsScraper().run();
}

if (require.main === module) {
  runXhsComments()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
