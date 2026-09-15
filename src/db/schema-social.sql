-- Mizuhada Social Listening Database — social data only
-- PostgreSQL 15 + TimescaleDB + pgvector
-- Retention: 6 months. cleanup_social_old_data() runs daily via Node cron.

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ── Brands (reference — no retention) ────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(100) NOT NULL,
  slug           VARCHAR(100) UNIQUE NOT NULL,
  type           VARCHAR(20)  NOT NULL CHECK (type IN ('own', 'competitor')),
  threat_level   DECIMAL(3,1),
  shopee_url     TEXT,
  lazada_url     TEXT,
  watsons_th_id  INTEGER,
  website_url    TEXT,
  notes            TEXT,
  tiktok_handle    VARCHAR(100),
  instagram_handle VARCHAR(100),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Social comments + sentiment + RAG embeddings ──────────────────────
-- Retention: rows with scraped_at < NOW() - 6 months are deleted daily.
CREATE TABLE IF NOT EXISTS social_comments (
  id                  SERIAL PRIMARY KEY,
  brand_id            INT REFERENCES brands(id) ON DELETE SET NULL,
  platform            VARCHAR(50)  NOT NULL,
  external_id         TEXT,
  content             TEXT         NOT NULL,
  sentiment           VARCHAR(20)  CHECK (sentiment IN ('positive', 'negative', 'neutral', 'question', 'resale')),
  sentiment_score     DECIMAL(4,3),
  topic               VARCHAR(100),
  published_at        TIMESTAMPTZ,
  scraped_at          TIMESTAMPTZ  DEFAULT NOW(),
  post_id             TEXT,
  likes_count         BIGINT,
  reply_count         BIGINT,
  is_reply            BOOLEAN      DEFAULT false,
  parent_comment_id   TEXT,
  -- X only (twitter-search.ts): link to whatever this tweet is about — the
  -- parent of a reply, the quoted tweet, or the retweeted-of original.
  original_post_url   TEXT,
  tweet_type          VARCHAR(20),
  UNIQUE (platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_comments_brand       ON social_comments(brand_id);
CREATE INDEX IF NOT EXISTS idx_comments_sentiment   ON social_comments(sentiment);
CREATE INDEX IF NOT EXISTS idx_comments_platform    ON social_comments(platform);
CREATE INDEX IF NOT EXISTS idx_comments_scraped     ON social_comments(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post        ON social_comments(post_id) WHERE post_id IS NOT NULL;
-- Backs the correlated-subquery comment-count sort on /api/tiktok/posts and
-- /api/tiktok/search (SORT_MAP.comments) — deliberately counts real rows
-- instead of trusting tp.comments_count (unreliable API metadata, see
-- CLAUDE.md), so the query itself isn't going away; this composite index is
-- what makes that correctness choice cheap instead of a per-row scan.
CREATE INDEX IF NOT EXISTS idx_comments_post_platform ON social_comments(post_id, platform) WHERE post_id IS NOT NULL;
-- Hot-path for /social feed + brandSentiment in marketing routes
CREATE INDEX IF NOT EXISTS idx_comments_platform_brand_published ON social_comments(platform, brand_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_platform_sentiment_pub   ON social_comments(platform, sentiment, published_at DESC);
-- Partial index for sentiment worker — only scans unclassified rows
CREATE INDEX IF NOT EXISTS idx_comments_unanalyzed  ON social_comments(scraped_at DESC) WHERE sentiment IS NULL;


-- ── TikTok Posts ──────────────────────────────────────────────────────
-- Retention: rows with scraped_at < NOW() - 6 months are deleted daily.
CREATE TABLE IF NOT EXISTS tiktok_posts (
  id                SERIAL PRIMARY KEY,
  brand_id          INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL,
  video_url         TEXT,
  post_url          TEXT,
  caption           TEXT,
  hashtags          TEXT[],
  product_links     TEXT[],
  views             BIGINT  DEFAULT 0,
  likes             BIGINT  DEFAULT 0,
  shares            BIGINT  DEFAULT 0,
  comments_count    BIGINT  DEFAULT 0,
  posted_at         TIMESTAMPTZ,
  engagement_rate   DECIMAL(8,4),
  spike_flag        BOOLEAN DEFAULT false,
  spike_detected_at TIMESTAMPTZ,
  theme             VARCHAR(50),
  raw_data          JSONB,
  scraped_at        TIMESTAMPTZ DEFAULT NOW(),
  -- First time this post was inserted into the DB. Never bumped on conflict
  -- (unlike scraped_at) so the 3h digest can count only genuinely-new mentions.
  first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
  source_type       TEXT        DEFAULT 'profile',
  author_handle     TEXT,
  search_keywords   TEXT[] NOT NULL DEFAULT '{}',
  -- Comment-scrape gating. comments_scraped_at = NULL means comments never scraped.
  -- comments_count is kept = API comment-count metadata (true total incl replies),
  -- refreshed by the feed/search upsert and NEVER overwritten by the comment scraper.
  -- comments_meta_at_scrape = comments_count snapshotted at the last comment scrape, so
  -- re-scrape fires only when current metadata grew >= 5 vs the previous metadata
  -- (metadata-to-metadata). Scraped rows undercount metadata, so they're not the baseline;
  -- actual scraped count is derived via COUNT(social_comments) on demand.
  comments_scraped_at     TIMESTAMPTZ,
  comments_meta_at_scrape BIGINT DEFAULT 0,
  UNIQUE (brand_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_posts_brand        ON tiktok_posts(brand_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_spike        ON tiktok_posts(spike_flag) WHERE spike_flag = true;
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_posted       ON tiktok_posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_scraped      ON tiktok_posts(scraped_at DESC);
-- Composite for brand dashboard queries (brand filter + time sort in one scan)
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_brand_posted ON tiktok_posts(brand_id, posted_at DESC);
-- GIN for array containment queries on keywords/hashtags
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_keywords     ON tiktok_posts USING GIN(search_keywords);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_hashtags     ON tiktok_posts USING GIN(hashtags);
-- Hot-path indexes for tabbed /tiktok page (Feed / Search / Hashtags / Influencers)
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_source_posted        ON tiktok_posts(source_type, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_source_brand_posted  ON tiktok_posts(source_type, brand_id, posted_at DESC);
-- Influencer aggregate: case-insensitive handle lookup (UGC search posts)
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_handle_lower         ON tiktok_posts(LOWER(author_handle)) WHERE author_handle IS NOT NULL AND source_type = 'search';
-- Spike feed: sort by detection time, only spike rows (partial index keeps it tiny)
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_spike_detected       ON tiktok_posts(spike_detected_at DESC) WHERE spike_flag = true;

-- ── Instagram Posts ───────────────────────────────────────────────────
-- Retention: rows with scraped_at < NOW() - 6 months are deleted daily.
-- post_id = IG shortcode (URL: instagram.com/p/<post_id>), external_id = numeric media pk.
CREATE TABLE IF NOT EXISTS instagram_posts (
  id                SERIAL PRIMARY KEY,
  brand_id          INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL,            -- IG shortcode (used for URL + uniqueness)
  external_id       TEXT,                     -- IG numeric media pk
  media_url         TEXT,                     -- display/thumbnail image
  post_url          TEXT,
  caption           TEXT,
  hashtags          TEXT[] DEFAULT '{}',
  mentions          TEXT[] DEFAULT '{}',
  media_type        VARCHAR(20),              -- image | video | carousel | reel
  views             BIGINT,                   -- video/reel play count (null for images)
  likes             BIGINT  DEFAULT 0,
  shares            BIGINT,                   -- IG exposes no public share count
  comments_count    BIGINT  DEFAULT 0,
  posted_at         TIMESTAMPTZ,
  engagement_rate   DECIMAL(8,4),
  raw_data          JSONB,
  scraped_at        TIMESTAMPTZ DEFAULT NOW(),
  source_type       TEXT        DEFAULT 'feed',  -- 'feed' (own profile) | 'search' (UGC)
  author_handle     TEXT,
  search_hashtags   TEXT[] DEFAULT '{}',
  -- Comment-scrape gating (same rule as tiktok_posts). comments_count holds API metadata
  -- (never overwritten by the IG comment scraper). comments_scraped_at = NULL → never
  -- scraped. comments_meta_at_scrape = comments_count snapshot at last scrape, so re-scrape
  -- fires only when metadata grew >= 5 (metadata-to-metadata).
  comments_scraped_at     TIMESTAMPTZ,
  comments_meta_at_scrape BIGINT DEFAULT 0,
  UNIQUE (brand_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_ig_posts_brand        ON instagram_posts(brand_id);
CREATE INDEX IF NOT EXISTS idx_ig_posts_posted       ON instagram_posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_posts_brand_posted ON instagram_posts(brand_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_posts_hashtags     ON instagram_posts USING GIN(hashtags);

-- Existing DBs: add first_seen_at without recreating the table. Backfill from
-- scraped_at so pre-existing rows aren't all treated as brand-new.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
UPDATE tiktok_posts SET first_seen_at = scraped_at WHERE first_seen_at IS NULL;
ALTER TABLE tiktok_posts ALTER COLUMN first_seen_at SET DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_first_seen   ON tiktok_posts(first_seen_at DESC);

-- Existing DBs: add comment-scrape gating columns without recreating the table.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS comments_scraped_at     TIMESTAMPTZ;
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS comments_meta_at_scrape BIGINT DEFAULT 0;
ALTER TABLE instagram_posts ADD COLUMN IF NOT EXISTS comments_scraped_at     TIMESTAMPTZ;
ALTER TABLE instagram_posts ADD COLUMN IF NOT EXISTS comments_meta_at_scrape BIGINT DEFAULT 0;

-- Creator-level reach stats (from search API authorStats) — drive influencer
-- reach-vs-engagement tiers. Backfilled from raw_data for existing rows.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS author_followers   INTEGER;
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS author_hearts      BIGINT;
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS author_video_count INTEGER;
UPDATE tiktok_posts SET
    author_followers   = COALESCE(author_followers,   (raw_data->'authorStats'->>'followerCount')::int),
    author_hearts      = COALESCE(author_hearts,      (raw_data->'authorStats'->>'heartCount')::bigint),
    author_video_count = COALESCE(author_video_count, (raw_data->'authorStats'->>'videoCount')::int)
WHERE source_type='search' AND author_followers IS NULL AND raw_data ? 'authorStats';

-- Chinese-platform comments are translated to Thai (DeepSeek) before sentiment.
-- NULL = not yet translated; the translate worker fills this for CN platforms only.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS content_translated TEXT;
CREATE INDEX IF NOT EXISTS idx_comments_untranslated ON social_comments(scraped_at DESC)
  WHERE content_translated IS NULL;

-- Scrapers now mark content_translated = '' at insert time for already-Thai/English
-- content (see analysis/lang-detect.ts), so the translate worker never re-checks it.
-- Backfill that mark onto pre-existing rows inserted before this existed (idempotent —
-- only touches rows still NULL).
UPDATE social_comments SET content_translated = ''
WHERE content_translated IS NULL AND content <> ''
  AND content !~ '[぀-ヿ㐀-鿿가-힯Ā-ɏḀ-ỿ]';

-- Distinguish own-profile rows from keyword-search (UGC) rows. Mirrors tiktok_posts.source_type.
-- 'profile' = scraped from a brand's own account/feed; 'search' = found via keyword search.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'profile';
UPDATE social_comments SET source_type = 'profile' WHERE source_type IS NULL;
CREATE INDEX IF NOT EXISTS idx_comments_source ON social_comments(platform, source_type);

-- Richer post metadata captured from the XHS list API (likes_count already exists above).
-- xsec_token = per-note access token; without it the explore/<id> URL 404s when opened.
-- cover_url = thumbnail; note_type = video|normal; author_name/avatar = creator info.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS xsec_token   TEXT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS cover_url    TEXT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS note_type    VARCHAR(20);
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS author_name  TEXT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS author_avatar TEXT;

-- Urgency 1-5 for negative comments only (Gemini-assigned alongside sentiment).
-- 1=trivial gripe, 5=urgent/critical (health/safety, viral risk) — needs fast response.
-- NULL for non-negative comments and for negative comments not yet (re)classified.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS urgency SMALLINT;
CREATE INDEX IF NOT EXISTS idx_comments_negative_urgency ON social_comments(urgency DESC NULLS LAST)
  WHERE sentiment = 'negative';

-- View count — currently only populated for Twitter (X's SearchTimeline GraphQL
-- response already carries views.count per tweet in the same call that builds
-- the results list; was being extracted then discarded before this column existed).
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS views_count BIGINT;

-- Retweet count (Twitter only) and author follower count (Twitter only) —
-- both already parsed out of the same SearchTimeline response as views_count
-- above, were being extracted then discarded before these columns existed.
-- reply_count already exists (shared with TikTok) and gets wired up alongside these.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS retweets_count BIGINT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS author_followers INTEGER;

-- Link to whatever a tweet is "about" (Twitter only) — the reply-parent, the
-- quoted tweet, or the retweeted-of original — so the Mentions table can
-- link straight to it instead of just the reply/quote/RT itself.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS original_post_url TEXT;

-- 'original' | 'reply' | 'quote' | 'retweet' (Twitter only) — powers the
-- Mentions-tab tweet-type filter.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS tweet_type VARCHAR(20);

-- 'resale' sentiment (Twitter only) — resale/marketplace posts ("WTS", used-bottle
-- reselling) were being lumped under 'neutral', which drowned out genuinely
-- no-opinion comments (91% of 'neutral' rows on Twitter turned out to be resale).
-- Split out as its own value, same tier as 'question' — a comment-type tag, not
-- an emotional stance.
ALTER TABLE social_comments DROP CONSTRAINT IF EXISTS social_comments_sentiment_check;
ALTER TABLE social_comments ADD CONSTRAINT social_comments_sentiment_check
  CHECK (sentiment IN ('positive', 'negative', 'neutral', 'question', 'resale'));

-- ── Xiaohongshu (RED) Notes ───────────────────────────────────────────
-- Retention: rows with scraped_at < NOW() - 6 months are deleted daily.
-- A "note" is an XHS post (the analogue of tiktok_posts / instagram_posts).
-- XHS comments live in social_comments (platform='xiaohongshu', post_id = note_id).
CREATE TABLE IF NOT EXISTS xhs_posts (
  id                 SERIAL PRIMARY KEY,
  brand_id           INT REFERENCES brands(id) ON DELETE SET NULL,
  note_id            TEXT NOT NULL UNIQUE,        -- XHS note id (ObjectID-style)
  post_url           TEXT,
  title              TEXT,
  caption            TEXT,                        -- title + desc
  caption_translated TEXT,                        -- Thai translation (CN notes)
  cover_url          TEXT,
  note_type          VARCHAR(20),                 -- video | normal
  author_handle      TEXT,
  author_name        TEXT,
  author_avatar      TEXT,
  xsec_token         TEXT,                         -- per-note access token (TTL-bound)
  likes_count        BIGINT,
  collects_count     BIGINT,
  comments_count     BIGINT,
  shares_count       BIGINT,
  sentiment          VARCHAR(20) CHECK (sentiment IN ('positive','negative','neutral','question')),
  sentiment_score    DECIMAL(4,3),
  topic              VARCHAR(100),
  source_type        VARCHAR(20) DEFAULT 'profile',  -- profile (own feed) | search (UGC)
  search_keyword     TEXT,
  published_at       TIMESTAMPTZ,
  raw_data           JSONB,
  scraped_at         TIMESTAMPTZ DEFAULT NOW(),
  first_seen_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_xhs_posts_brand     ON xhs_posts(brand_id);
CREATE INDEX IF NOT EXISTS idx_xhs_posts_published ON xhs_posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_xhs_posts_scraped   ON xhs_posts(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_xhs_posts_source    ON xhs_posts(source_type);

-- Scrapers mark caption_translated = '' at insert time for already-Thai/English
-- captions (see analysis/lang-detect.ts). Backfill onto pre-existing rows (idempotent).
UPDATE xhs_posts SET caption_translated = ''
WHERE caption_translated IS NULL AND caption <> ''
  AND caption !~ '[぀-ヿ㐀-鿿가-힯Ā-ɏḀ-ỿ]';

-- One-time migration (idempotent): move legacy XHS note rows out of social_comments
-- into xhs_posts, link the note's comments via post_id, then drop the note rows.
-- After the first run there are no 'xhs_note_%' rows left, so each step is a no-op.
INSERT INTO xhs_posts
  (brand_id, note_id, post_url, caption, caption_translated, cover_url, note_type,
   author_name, author_avatar, xsec_token, likes_count, sentiment, sentiment_score,
   topic, source_type, published_at, scraped_at, first_seen_at)
SELECT brand_id,
       substring(external_id from 10) AS note_id,           -- strip 'xhs_note_'
       'https://www.xiaohongshu.com/explore/' || substring(external_id from 10),
       content, content_translated, cover_url, note_type,
       author_name, author_avatar, xsec_token, likes_count, sentiment, sentiment_score,
       topic, COALESCE(source_type, 'profile'), published_at, scraped_at, scraped_at
FROM social_comments
WHERE platform = 'xiaohongshu' AND external_id LIKE 'xhs\_note\_%'
ON CONFLICT (note_id) DO NOTHING;

-- Link each XHS comment to its note (post_id = the note id embedded in external_id).
UPDATE social_comments
SET post_id = split_part(substring(external_id from 5), '_', 1)   -- strip 'xhs_', take id before next '_'
WHERE platform = 'xiaohongshu'
  AND external_id LIKE 'xhs\_%' AND external_id NOT LIKE 'xhs\_note\_%'
  AND (post_id IS NULL OR post_id = '');

-- Remove the note rows now living in xhs_posts.
DELETE FROM social_comments
WHERE platform = 'xiaohongshu' AND external_id LIKE 'xhs\_note\_%';

-- ── X (Twitter) Campaign Tracking ────────────────────────────────────
-- See docs/scope-x-campaigns.md (agreed scope, decisions 1-10) and
-- docs/adr/0001-twitter-posts-table-split.md (why X gets its own posts
-- table instead of joining tiktok_posts/instagram_posts/xhs_posts).
-- MizuMi-only for now (scope decision 10) — Gentle Colors and Bomi are not
-- modeled here; brand_id is left general (not constrained to one brand) so
-- the schema doesn't hardcode that business rule.

-- brands: X/Twitter handle, used by the new feed scraper (MizuMi only).
ALTER TABLE brands ADD COLUMN IF NOT EXISTS twitter_handle VARCHAR(100);
UPDATE brands SET twitter_handle = 'MizuMi__' WHERE slug = 'mizumi' AND twitter_handle IS NULL;

-- Campaigns: manual creation + suggest-helper (app layer). Membership join key
-- is hashtags[] (primary) + ambassador_handles[] + manual add/remove of posts
-- via twitter_posts.campaign_id — membership itself isn't modeled as a table.
CREATE TABLE IF NOT EXISTS campaigns (
  id                  SERIAL PRIMARY KEY,
  brand_id            INT REFERENCES brands(id),
  name                TEXT NOT NULL,
  hashtags            TEXT[] DEFAULT '{}',
  ambassador_handles  TEXT[] DEFAULT '{}',
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,
  status              VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended')),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_brand  ON campaigns(brand_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- Twitter/X feed + campaign-anchor posts (own brand + ambassador handles).
-- Mirrors tiktok_posts. Brand-image UGC mentions (keyword search) stay in
-- social_comments (platform='twitter') — deliberately NOT migrated here
-- (ADR-0001: split-home compromise, zero migration risk).
-- Retention: rows with scraped_at < NOW() - 6 months are deleted daily.
CREATE TABLE IF NOT EXISTS twitter_posts (
  id                      SERIAL PRIMARY KEY,
  brand_id                INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  post_id                 TEXT NOT NULL,
  post_url                TEXT,
  caption                 TEXT,
  hashtags                TEXT[] DEFAULT '{}',
  views                   BIGINT DEFAULT 0,
  likes                   BIGINT DEFAULT 0,
  retweets_count          BIGINT DEFAULT 0,
  replies                 BIGINT DEFAULT 0,
  quotes_count            BIGINT DEFAULT 0,
  posted_at               TIMESTAMPTZ,
  engagement_rate         DECIMAL(8,4),
  -- 'feed' = own-brand/ambassador post; 'search' reserved for future UGC-anchor
  -- use (not populated in Phase 1 — brand-image UGC stays in social_comments).
  source_type             TEXT DEFAULT 'feed',
  author_handle           TEXT,
  raw_data                JSONB,
  scraped_at              TIMESTAMPTZ DEFAULT NOW(),
  -- First time this post was inserted. Never bumped on conflict (mirrors tiktok_posts).
  first_seen_at           TIMESTAMPTZ DEFAULT NOW(),
  -- Comment-scrape gating (same rule as tiktok_posts/instagram_posts).
  comments_scraped_at     TIMESTAMPTZ,
  comments_meta_at_scrape BIGINT DEFAULT 0,
  -- Campaign tracking (X-specific — other platforms have no campaign concept yet).
  campaign_id             INT REFERENCES campaigns(id) ON DELETE SET NULL,
  is_ambassador           BOOLEAN DEFAULT false,
  -- true when campaign_id was set/cleared by a human (manual add/remove via
  -- POST|DELETE /api/campaigns/:id/posts). Auto-assignment (campaign-membership.ts)
  -- never touches a locked row, in either direction.
  campaign_locked         BOOLEAN DEFAULT false,
  UNIQUE (brand_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_twitter_posts_brand         ON twitter_posts(brand_id);
CREATE INDEX IF NOT EXISTS idx_twitter_posts_posted        ON twitter_posts(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_twitter_posts_scraped       ON twitter_posts(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_twitter_posts_source_posted ON twitter_posts(source_type, posted_at DESC);
-- GIN for hashtag containment queries (campaign hashtag matching).
CREATE INDEX IF NOT EXISTS idx_twitter_posts_hashtags      ON twitter_posts USING GIN(hashtags);
CREATE INDEX IF NOT EXISTS idx_twitter_posts_campaign      ON twitter_posts(campaign_id) WHERE campaign_id IS NOT NULL;

-- Column add for tables created before campaign_locked existed (CREATE TABLE
-- IF NOT EXISTS above is a no-op against an already-existing twitter_posts).
ALTER TABLE twitter_posts ADD COLUMN IF NOT EXISTS campaign_locked BOOLEAN DEFAULT false;

-- ── Trending Hashtags (TimescaleDB hypertable — retention via policy) ──
CREATE TABLE IF NOT EXISTS trending_hashtags (
  scraped_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  hashtag     VARCHAR(200) NOT NULL,
  category    VARCHAR(50)  NOT NULL DEFAULT 'trending',
  brand_slug  VARCHAR(100) REFERENCES brands(slug),
  view_count  BIGINT,
  post_count  INT
);

SELECT create_hypertable('trending_hashtags', 'scraped_at', if_not_exists => TRUE);
-- Drop any existing policy first — add_retention_policy(if_not_exists) is a no-op
-- when a policy already exists, so it would NOT pick up an interval change.
-- (remove_retention_policy here has no if_not_exists arg; guard in a DO block.)
DO $$
BEGIN
  PERFORM remove_retention_policy('trending_hashtags');
EXCEPTION WHEN OTHERS THEN NULL;  -- no policy yet → ignore
END $$;
SELECT add_retention_policy('trending_hashtags', INTERVAL '6 months', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_trending_hashtags_scraped  ON trending_hashtags(scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_trending_hashtags_hashtag  ON trending_hashtags(hashtag, scraped_at DESC);

-- ── User notifications ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_notifications (
  id                SERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL DEFAULT 'default',
  type              VARCHAR(50) NOT NULL,
  title             VARCHAR(255) NOT NULL,
  body              TEXT,
  payload           JSONB DEFAULT '{}',
  is_read           BOOLEAN DEFAULT false,
  read_at           TIMESTAMPTZ,
  related_post_id   TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user    ON user_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_read    ON user_notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_user_notifications_created ON user_notifications(created_at DESC);

-- ── Runtime app settings (single-row JSONB blob) ──────────────────────
-- Settings page writes here; scrapers/cron read via settings-loader.ts.
-- Missing keys fall back to defaults baked in the loader, so an empty row
-- behaves identically to the pre-settings hardcoded config.
CREATE TABLE IF NOT EXISTS app_settings (
  id         INT PRIMARY KEY DEFAULT 1,
  settings   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO app_settings (id, settings) VALUES (1, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- ── AI usage log — one row per LLM call (sentiment/translate/theme/relevance/captcha) ──
-- Written by src/analysis/ai-usage.ts. Powers the Admin > AI usage card.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id            SERIAL PRIMARY KEY,
  provider      VARCHAR(20)  NOT NULL,   -- 'gemini' | 'deepseek' | 'openrouter'
  model         VARCHAR(100) NOT NULL,
  purpose       VARCHAR(50)  NOT NULL,   -- 'sentiment' | 'translate' | 'post-theme' | 'brand-relevance' | 'captcha-vision'
  tokens_in     INT,
  tokens_out    INT,
  cost_usd      NUMERIC(10, 6),
  success       BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created  ON ai_usage_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_provider  ON ai_usage_log(provider, created_at DESC);

-- ── Data retention cleanup function ──────────────────────────────────
-- Called daily by Node.js cron. Returns total rows deleted.
CREATE OR REPLACE FUNCTION cleanup_social_old_data() RETURNS INTEGER AS $$
DECLARE
  total INTEGER := 0;
  n     INTEGER;
BEGIN
  DELETE FROM social_comments  WHERE scraped_at    < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  DELETE FROM tiktok_posts     WHERE scraped_at    < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  DELETE FROM twitter_posts    WHERE scraped_at    < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  DELETE FROM user_notifications WHERE created_at < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  DELETE FROM ai_usage_log     WHERE created_at    < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  -- Finished scrape jobs are ephemeral status records, not data — a 7-day tail
  -- is plenty for the dashboard's recent-jobs list. Never touch unfinished
  -- ('pending'/'running') rows.
  DELETE FROM scrape_jobs WHERE finished_at IS NOT NULL AND finished_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS n = ROW_COUNT; total := total + n;

  RETURN total;
END;
$$ LANGUAGE plpgsql;

-- TikTok Shop / commerce content marking. is_shop_content is derived (not
-- scraped) by a heuristic run against each post's raw_data/caption;
-- shop_signal records which heuristic matched (e.g. 'textExtra_isCommerce',
-- 'caption_regex') so detection accuracy can be tuned later without
-- re-deriving from raw_data every time. Both stay at their defaults until a
-- future detector pass actually populates them.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS is_shop_content BOOLEAN DEFAULT false;
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS shop_signal TEXT;

-- Marks whether a comment is actually about the post's own nominal brand or
-- a different brand mentioned in the same post/thread (e.g. a comparison
-- comment), so brand-level sentiment tallies can exclude off-topic comments.
-- NULL = not yet (re)classified — same convention as `urgency` above.
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS brand_relevance VARCHAR(20)
  CHECK (brand_relevance IN ('on_topic', 'other_brand'));

-- Mirrors tiktok_posts' spike_flag / spike_detected_at / author_followers
-- (same types, same defaults) so X spike-detection can share the same
-- column shape as TikTok's existing spike-detection logic instead of a
-- one-off design.
ALTER TABLE twitter_posts ADD COLUMN IF NOT EXISTS spike_flag BOOLEAN DEFAULT false;
ALTER TABLE twitter_posts ADD COLUMN IF NOT EXISTS spike_detected_at TIMESTAMPTZ;
ALTER TABLE twitter_posts ADD COLUMN IF NOT EXISTS author_followers INTEGER;

-- Dedicated signal for "this row's own views/likes/retweets/replies/quotes
-- are current", set ONLY when updateTweetStats() actually writes them
-- (twitter-feed.ts). Deliberately separate from comments_scraped_at, which
-- means "we last scraped replies/quotes for this post" — a real but
-- different question. twitter-stats-refresh.ts's backstop reads this column
-- (not comments_scraped_at) to decide whether a post still needs a refresh.
ALTER TABLE twitter_posts ADD COLUMN IF NOT EXISTS stats_refreshed_at TIMESTAMPTZ;

-- Resurgence detection (TikTok only for now): snapshot of views at the moment
-- of the most recent spike LINE alert (initial flag or a prior resurgence).
-- Lets detectSpikes() tell "still above threshold, nothing new" apart from
-- "already-flagged post just grew another 50%+ — genuinely new event, alert
-- again" without an absolute-threshold re-check re-firing every scrape.
-- Cleared back to NULL when a post is unflagged, so a later re-flag starts
-- fresh instead of comparing against a stale baseline.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS last_alert_views BIGINT;
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ;

-- Thumbnail for the Viral tab post cards. Signed TikTok CDN URL (item.video.cover
-- in the scraped API response) — expires a few weeks after scrape, not a
-- permanent host. Refreshed on every re-scrape (feed/search upserts SET this
-- on conflict); the dashboard falls back to a placeholder once a URL 404s
-- rather than proxying/caching images server-side.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS cover_url TEXT;

-- ── Search keywords (normalized) ──────────────────────────────────────
-- Replaces app_settings.settings.keywords.{tiktok,tiktokCategory,xhs,twitter}
-- (a whole-array-overwrite jsonb blob) with per-row CRUD. brand_id NULL =
-- platform-wide term (category/xhs seed keywords have no single owning brand).
-- Own AND competitor brands share this table — competitors previously had no
-- editable keyword list at all (matchBrandSlug() fell back to a bare
-- brand-name match, which false-positived generic terms like "วิตซี"/"VC"
-- meaning "vitamin C" against every vitamin-C skincare post).
CREATE TABLE IF NOT EXISTS keyword_terms (
  id          SERIAL PRIMARY KEY,
  platform    VARCHAR(20) NOT NULL CHECK (platform IN ('tiktok', 'tiktok_category', 'twitter', 'xhs')),
  brand_id    INT REFERENCES brands(id) ON DELETE CASCADE,
  keyword     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- COALESCE sentinel so NULL-brand_id rows (category/xhs) still dedupe —
-- plain UNIQUE(platform, brand_id, keyword) wouldn't catch those (NULL <> NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_terms_unique
  ON keyword_terms(platform, COALESCE(brand_id, 0), keyword);

-- ── Scrape job queue (Docker per-platform split) ──────────────────────
-- Durable replacement for the old in-process Map in api/routes/scrape.ts.
-- The `api` container INSERTs a 'pending' row; the matching scraper container
-- (SCRAPER_PLATFORM=<platform>) claims it via SELECT ... FOR UPDATE SKIP
-- LOCKED, runs the scrape, and writes status/count/message back. Making job
-- state a shared table (not per-process memory) is what lets the dashboard
-- poll status while the work runs in a different container — and also fixes
-- the pre-existing bug where a status poll hitting a different process saw no
-- job. Cooperative cancel: api flips cancel_requested; the scraper loop polls
-- it between steps (same semantics as the old in-memory job.cancelRequested).
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         VARCHAR(20)  NOT NULL,   -- 'tiktok'|'instagram'|'twitter'|'xhs'
  job_type         VARCHAR(30)  NOT NULL DEFAULT 'scrape',  -- 'scrape'|'search'|'comments'|'session-check'
  brand            TEXT         NOT NULL DEFAULT '',
  status           VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- 'pending'|'running'|'done'|'error'|'cancelled'
  message          TEXT         NOT NULL DEFAULT '',
  count            INTEGER      NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN      NOT NULL DEFAULT false,
  params           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
-- Claim query hits (platform, status) constantly — index it. Partial on the
-- hot 'pending' rows keeps the index tiny regardless of finished-job backlog.
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_claim
  ON scrape_jobs(platform, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_created
  ON scrape_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_keyword_terms_platform_brand ON keyword_terms(platform, brand_id);

-- Generic result payload for job_types whose caller needs data back, not just
-- a count (e.g. 'track-link' returns the verified post, 'search-x' returns
-- unsaved candidate tweets) — written by the queue worker right before the
-- terminal status flip; read via GET /api/scrape/status/:jobId.
ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS result JSONB;

-- Per-platform session status, self-reported by whichever process actually
-- holds that platform's browser profile (a scraper-<platform> container, or
-- the host for XHS) — written on boot, after every claimed job, and after a
-- 'login' job settles. GET /api/<platform>/session in `api` just SELECTs
-- this row: `api` has no browser after the Docker split, so it can no longer
-- stat the Cookies sqlite file itself (that file lives in the owning
-- container's/host's filesystem, not api's).
CREATE TABLE IF NOT EXISTS platform_sessions (
  platform    VARCHAR(20)  PRIMARY KEY,   -- 'tiktok'|'instagram'|'twitter'|'xhs'
  valid       BOOLEAN      NOT NULL DEFAULT false,
  profile_dir TEXT         NOT NULL DEFAULT '',
  hint        TEXT         NOT NULL DEFAULT '',
  checked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Instagram spike_flag/spike_detected_at/watchlist were dead columns — no
-- spike-detection process ever wrote spike_flag=true for Instagram (own
-- process only runs for TikTok/X), and there was no toggle endpoint for
-- watchlist. Verified 0 rows had either set before dropping (1100 rows total).
-- Existing DBs: drop them + the now-obsolete partial index.
DROP INDEX IF EXISTS idx_ig_posts_spike;
ALTER TABLE instagram_posts DROP COLUMN IF EXISTS spike_flag;
ALTER TABLE instagram_posts DROP COLUMN IF EXISTS spike_detected_at;
ALTER TABLE instagram_posts DROP COLUMN IF EXISTS watchlist;
