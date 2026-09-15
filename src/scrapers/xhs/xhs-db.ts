import { socialPool as pool } from '../../db/social-client';
import { PLATFORM_SLUG, XhsNote } from './xhs-browser';
import { publishedAtFromNoteId } from './xhs-comments';
import { needsTranslation } from '../../analysis/lang-detect';

// Persistence for XHS notes (posts). Notes are the XHS analogue of tiktok_posts —
// they live in xhs_posts, NOT social_comments. XHS comments still go to
// social_comments (platform='xiaohongshu', post_id = note_id) via base-social.

export { PLATFORM_SLUG };

let brandCache: Map<string, number> | null = null;

/** slug → brand_id, cached for the process. */
export async function loadXhsBrandIds(): Promise<Map<string, number>> {
  if (brandCache) return brandCache;
  const { rows } = await pool.query<{ id: number; slug: string }>('SELECT id, slug FROM brands');
  brandCache = new Map(rows.map((r) => [r.slug, r.id]));
  return brandCache;
}

/**
 * Upsert one note into xhs_posts. brandId attributes the note (feed knows it from
 * the profile; search resolves it from the matched keyword's brand). Refreshes
 * volatile fields (likes, token, cover) on conflict so re-scrapes keep tokens fresh.
 */
export async function upsertXhsPost(
  brandId: number | null,
  note: XhsNote,
  sourceType: 'profile' | 'search',
  searchKeyword?: string,
): Promise<void> {
  const caption = `${note.title ?? ''}\n${note.desc ?? ''}`.trim();
  const publishedAt = note.publishedAt ?? publishedAtFromNoteId(note.id) ?? null;

  await pool.query(
    `INSERT INTO xhs_posts
       (brand_id, note_id, post_url, title, caption, caption_translated, cover_url, note_type,
        author_handle, author_name, author_avatar, xsec_token, likes_count,
        comments_count, collects_count, shares_count,
        source_type, search_keyword, published_at, scraped_at, first_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())
     ON CONFLICT (note_id) DO UPDATE SET
       post_url      = COALESCE(EXCLUDED.post_url,      xhs_posts.post_url),
       title         = COALESCE(EXCLUDED.title,         xhs_posts.title),
       caption       = COALESCE(NULLIF(EXCLUDED.caption,''), xhs_posts.caption),
       -- A detail-fetch enrichment can replace a short title-only caption with the
       -- real one later — without this, caption_translated stays stuck on whatever
       -- (or nothing) was computed off the short version. Reset on real change so
       -- the existing translateUntranslatedNotes cron (every 2h) redoes it.
       caption_translated = CASE
         WHEN NULLIF(EXCLUDED.caption,'') IS NOT NULL
          AND NULLIF(EXCLUDED.caption,'') IS DISTINCT FROM xhs_posts.caption
         THEN NULL
         ELSE xhs_posts.caption_translated
       END,
       cover_url     = COALESCE(EXCLUDED.cover_url,     xhs_posts.cover_url),
       note_type     = COALESCE(EXCLUDED.note_type,     xhs_posts.note_type),
       author_handle = COALESCE(EXCLUDED.author_handle, xhs_posts.author_handle),
       author_name   = COALESCE(EXCLUDED.author_name,   xhs_posts.author_name),
       author_avatar = COALESCE(EXCLUDED.author_avatar, xhs_posts.author_avatar),
       xsec_token    = COALESCE(EXCLUDED.xsec_token,    xhs_posts.xsec_token),
       likes_count   = COALESCE(EXCLUDED.likes_count,   xhs_posts.likes_count),
       comments_count = COALESCE(EXCLUDED.comments_count, xhs_posts.comments_count),
       collects_count = COALESCE(EXCLUDED.collects_count, xhs_posts.collects_count),
       shares_count   = COALESCE(EXCLUDED.shares_count,   xhs_posts.shares_count),
       search_keyword = COALESCE(xhs_posts.search_keyword, EXCLUDED.search_keyword),
       published_at  = COALESCE(xhs_posts.published_at, EXCLUDED.published_at),
       scraped_at    = NOW()`,
    [
      brandId,
      note.id,
      note.url ?? `https://www.xiaohongshu.com/explore/${note.id}`,
      note.title ?? null,
      caption,
      caption ? (needsTranslation(caption) ? null : '') : null,
      note.coverUrl ?? null,
      note.noteType ?? null,
      note.author ?? null,
      note.authorName ?? null,
      note.authorAvatar ?? null,
      note.xsecToken ?? null,
      note.likes ?? null,
      note.commentsCount ?? null,
      note.collectsCount ?? null,
      note.sharesCount ?? null,
      sourceType,
      searchKeyword ?? null,
      publishedAt,
    ],
  );
}
