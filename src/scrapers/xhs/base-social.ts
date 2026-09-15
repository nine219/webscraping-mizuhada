import { socialPool as pool } from '../../db/social-client';
import { validateComments } from '../../validators/gemini';
import { matchBrandSlugXhs } from '../keywords';
import { shouldKeepComment } from '../../analysis/comments';
import { needsTranslation } from '../../analysis/lang-detect';

export interface RawSocialPost {
  externalId: string;
  content: string;
  publishedAt?: Date | string | null;
  platformPostUrl?: string;
  authorHandle?: string;
  rawData?: Record<string, unknown>;
  sentiment?: 'positive' | 'negative' | 'neutral';
  sentimentScore?: number;
  topic?: string;
  // Explicit brand attribution (feed scraper knows the brand from the profile).
  // When set, used directly; otherwise brand is inferred from content via matchBrandSlugXhs.
  brandSlug?: string;
  // 'profile' = own-feed row, 'search' = keyword/UGC row. Falls back to config default.
  sourceType?: 'profile' | 'search';
  // Optional post metadata (e.g. XHS list API).
  likesCount?: number;
  xsecToken?: string;
  coverUrl?: string;
  noteType?: string;
  authorName?: string;
  authorAvatar?: string;
  // Links a comment to its parent post (e.g. XHS comment → note_id in xhs_posts).
  postId?: string;
}

export interface SocialScraperConfig {
  platformSlug: string;
  // Default source_type for rows this scraper produces when a post doesn't set its own.
  defaultSourceType?: 'profile' | 'search';
}

interface BrandRef {
  id: number;
  slug: string;
}

export abstract class BaseSocialScraper {
  protected brands: BrandRef[] = [];

  constructor(protected config: SocialScraperConfig) {}

  abstract fetchPosts(): Promise<RawSocialPost[]>;

  async run(): Promise<void> {
    const label = `[social/${this.config.platformSlug}]`;
    console.log(`${label} Starting social scrape...`);

    await this.loadIds();

    const posts = await this.fetchPosts();
    console.log(`${label} Fetched ${posts.length} posts/comments`);

    if (posts.length === 0) {
      console.log(`${label} No data to save`);
      return;
    }

    const enriched = await validateComments(posts);

    let saved = 0;
    for (let i = 0; i < enriched.length; i++) {
      try {
        await this.upsertComment(enriched[i]);
        saved++;
      } catch (err) {
        console.error(`${label} Failed to save comment ${enriched[i].externalId}: ${err}`);
      }
    }
    console.log(`${label} ✓ Saved ${saved}/${enriched.length} comments`);
  }

  private async loadIds(): Promise<void> {
    // social_comments.platform is a plain slug (no platforms table / FK).
    // Load all brands so matchBrandSlugXhs can attribute to own brands (type='own').
    const brands = await pool.query<BrandRef>('SELECT id, slug FROM brands');
    this.brands = brands.rows;
  }

  protected resolveBrandId(p: RawSocialPost): number | null {
    const slug = p.brandSlug ?? matchBrandSlugXhs(p.content);
    if (!slug) return null;
    return this.brands.find((b) => b.slug === slug)?.id ?? null;
  }

  protected async upsertComment(p: RawSocialPost): Promise<void> {
    const brandId = this.resolveBrandId(p);
    await upsertSocialComment(p, brandId, this.config.platformSlug, this.config.defaultSourceType ?? 'profile');
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Standalone (not tied to a BaseSocialScraper instance) so ad-hoc single-account
// scrapers (e.g. XHS's runXhsAdhocFeed) can reuse the exact same upsert — brand
// attribution already known (the account's own competitor/own brand row), no
// need for resolveBrandId's content-based matchBrandSlugXhs fallback.
export async function upsertSocialComment(
  p: RawSocialPost,
  brandId: number | null,
  platformSlug: string,
  defaultSourceType: 'profile' | 'search' = 'profile',
): Promise<boolean> {
  const sourceType = p.sourceType ?? defaultSourceType;
  // allowMentionOnly for 'search' rows — those are top-level UGC notes
  // discovered by brand keyword search, not replies, so a bare "@ourbrand"
  // mention is the direct-tag content itself, not notification-ping noise.
  if (!shouldKeepComment(p.content, { allowMentionOnly: sourceType === 'search' })) return false; // see analysis/comments.ts
  const publishedAt = p.publishedAt
    ? typeof p.publishedAt === 'string'
      ? p.publishedAt
      : p.publishedAt.toISOString()
    : null;

  await pool.query(
    `INSERT INTO social_comments
       (brand_id, platform, external_id, content, sentiment, sentiment_score, topic, published_at, source_type,
        likes_count, xsec_token, cover_url, note_type, author_name, author_avatar, post_id, content_translated, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (platform, external_id)
     DO UPDATE SET
       likes_count   = COALESCE(EXCLUDED.likes_count,   social_comments.likes_count),
       xsec_token    = COALESCE(EXCLUDED.xsec_token,    social_comments.xsec_token),
       cover_url     = COALESCE(EXCLUDED.cover_url,     social_comments.cover_url),
       note_type     = COALESCE(EXCLUDED.note_type,     social_comments.note_type),
       author_name   = COALESCE(EXCLUDED.author_name,   social_comments.author_name),
       author_avatar = COALESCE(EXCLUDED.author_avatar, social_comments.author_avatar),
       post_id       = COALESCE(EXCLUDED.post_id,       social_comments.post_id),
       published_at  = COALESCE(social_comments.published_at, EXCLUDED.published_at)`,
    [
      brandId,
      platformSlug,
      p.externalId,
      p.content,
      p.sentiment ?? null,
      p.sentimentScore ?? null,
      p.topic ?? null,
      publishedAt,
      sourceType,
      p.likesCount ?? null,
      p.xsecToken ?? null,
      p.coverUrl ?? null,
      p.noteType ?? null,
      p.authorName ?? p.authorHandle ?? null,
      p.authorAvatar ?? null,
      p.postId ?? null,
      needsTranslation(p.content) ? null : '',
    ]
  );
  return true;
}
