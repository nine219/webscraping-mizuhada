-- Mizuhada Competitor Intelligence Platform — Database Schema
-- PostgreSQL 15 + TimescaleDB + pgvector

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Brands (own + competitor) ─────────────────────────────────────────
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
  notes          TEXT,
  tiktok_handle  VARCHAR(100),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Platforms ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platforms (
  id       SERIAL PRIMARY KEY,
  slug     VARCHAR(50) UNIQUE NOT NULL,
  name     VARCHAR(100) NOT NULL,
  country  CHAR(2) NOT NULL DEFAULT 'TH',
  base_url TEXT NOT NULL
);

-- ── Products / SKUs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  brand_id      INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform_id   INT NOT NULL REFERENCES platforms(id),
  external_id   TEXT,
  name          TEXT NOT NULL,
  url           TEXT,
  image_url     TEXT,
  category      VARCHAR(100),
  current_price DECIMAL(10,2),
  currency      CHAR(5) DEFAULT 'THB',
  is_active     BOOLEAN DEFAULT true,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (brand_id, platform_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_platform ON products(platform_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

-- ── Price snapshots (TimescaleDB hypertable) ──────────────────────────
CREATE TABLE IF NOT EXISTS price_snapshots (
  time           TIMESTAMPTZ NOT NULL,
  product_id     INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price          DECIMAL(10,2) NOT NULL,
  original_price DECIMAL(10,2),
  discount_pct   DECIMAL(5,2),
  stock_status   VARCHAR(50),
  sold_count     BIGINT,
  source_url     TEXT,
  raw_data       JSONB
);

SELECT create_hypertable('price_snapshots', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_snapshots_product_time ON price_snapshots (product_id, time DESC);

-- ── Social comments + sentiment + RAG embeddings ──────────────────────
CREATE TABLE IF NOT EXISTS social_comments (
  id              SERIAL PRIMARY KEY,
  brand_id        INT REFERENCES brands(id) ON DELETE SET NULL,
  platform        VARCHAR(50) NOT NULL,
  external_id     TEXT,
  content         TEXT NOT NULL,
  sentiment       VARCHAR(20) CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  sentiment_score DECIMAL(4,3),
  topic           VARCHAR(100),
  published_at    TIMESTAMPTZ,
  scraped_at      TIMESTAMPTZ DEFAULT NOW(),
  embedding       vector(768),
  UNIQUE (platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_comments_brand ON social_comments(brand_id);
CREATE INDEX IF NOT EXISTS idx_comments_sentiment ON social_comments(sentiment);
CREATE INDEX IF NOT EXISTS idx_comments_platform ON social_comments(platform);
CREATE INDEX IF NOT EXISTS idx_comments_embedding ON social_comments
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ── Alert rules ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(200) NOT NULL,
  condition_type   VARCHAR(50) NOT NULL,
  condition_params JSONB NOT NULL DEFAULT '{}',
  channel          VARCHAR(50) NOT NULL DEFAULT 'teams',
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Alert history ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_history (
  id           SERIAL PRIMARY KEY,
  rule_id      INT REFERENCES alert_rules(id) ON DELETE SET NULL,
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  details      JSONB,
  delivered    BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at DESC);

-- ── Competitor ads ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_ads (
  id            SERIAL PRIMARY KEY,
  brand_id      INT REFERENCES brands(id) ON DELETE CASCADE,
  platform      VARCHAR(50) NOT NULL,
  external_id   TEXT,
  headline      TEXT,
  format        VARCHAR(50),
  is_active     BOOLEAN DEFAULT true,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  run_days      INT DEFAULT 0,
  raw_data      JSONB,
  UNIQUE (platform, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_brand ON competitor_ads(brand_id);
CREATE INDEX IF NOT EXISTS idx_ads_active ON competitor_ads(is_active);

-- ── Search ranking snapshots ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_rankings (
  id              SERIAL PRIMARY KEY,
  keyword         VARCHAR(200) NOT NULL,
  platform        VARCHAR(50)  NOT NULL DEFAULT 'shopee_th',
  scraped_at      TIMESTAMPTZ  DEFAULT NOW(),
  position        SMALLINT     NOT NULL,
  external_id     TEXT,
  product_name    TEXT         NOT NULL,
  brand_id        INT REFERENCES brands(id) ON DELETE SET NULL,
  brand_name_raw  TEXT,
  shop_id         BIGINT,
  price           DECIMAL(10,2),
  sold_count      INT,
  rating          DECIMAL(3,2),
  review_count    INT,
  is_ad           BOOLEAN      DEFAULT false,
  badge           VARCHAR(50),
  image_url       TEXT,
  product_url     TEXT,
  gemini_category VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_rankings_keyword_time
  ON search_rankings(keyword, platform, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_rankings_brand
  ON search_rankings(brand_id);
CREATE INDEX IF NOT EXISTS idx_rankings_scraped
  ON search_rankings(scraped_at DESC);

-- ── Default alert rules ───────────────────────────────────────────────
INSERT INTO alert_rules (name, condition_type, condition_params, channel) VALUES
  ('Price drop ≥10%', 'price_drop', '{"threshold_pct": 10}', 'teams'),
  ('Negative sentiment spike', 'sentiment_spike', '{"threshold_pct": 35}', 'teams'),
  ('New competitor SKU detected', 'new_product', '{}', 'teams'),
  ('Competitor undercuts MizuMi', 'price_crossover', '{"own_brand_slug": "mizumi"}', 'teams')
ON CONFLICT DO NOTHING;

-- ── TikTok Posts ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tiktok_posts (
  id                SERIAL PRIMARY KEY,
  brand_id          INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL,
  video_url         TEXT,
  caption           TEXT,
  hashtags          TEXT[],
  product_links     TEXT[],
  views             BIGINT DEFAULT 0,
  likes             BIGINT DEFAULT 0,
  shares            BIGINT DEFAULT 0,
  comments_count    BIGINT DEFAULT 0,
  posted_at         TIMESTAMPTZ,
  engagement_rate   DECIMAL(8,4),
  spike_flag        BOOLEAN DEFAULT false,
  spike_detected_at TIMESTAMPTZ,
  raw_data          JSONB,
  scraped_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (brand_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_posts_brand  ON tiktok_posts(brand_id);
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_spike  ON tiktok_posts(spike_flag) WHERE spike_flag = true;
CREATE INDEX IF NOT EXISTS idx_tiktok_posts_posted ON tiktok_posts(posted_at DESC);

-- ── TikTok Engagement Baselines ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tiktok_baselines (
  brand_id           INT PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  rolling_avg        DECIMAL(12,2),
  post_count         INT DEFAULT 0,
  last_calculated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── TikTok Products (Shop) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tiktok_products (
  id              SERIAL PRIMARY KEY,
  brand_id        INT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  price           DECIMAL(10,2),
  original_price  DECIMAL(10,2),
  sold_count      BIGINT,
  rating          DECIMAL(3,1),
  review_count    BIGINT,
  badges          TEXT[],
  image_url       TEXT,
  product_url     TEXT,
  is_active       BOOLEAN DEFAULT true,
  first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (brand_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_tiktok_products_brand ON tiktok_products(brand_id);

-- Extend tiktok_posts for search/UGC tracking
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS source_type    TEXT DEFAULT 'profile';
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS author_handle  TEXT;
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS search_keyword TEXT;

-- A post can be found via more than one search keyword — track all of them.
ALTER TABLE tiktok_posts ADD COLUMN IF NOT EXISTS search_keywords TEXT[] NOT NULL DEFAULT '{}';
UPDATE tiktok_posts SET search_keywords = ARRAY[search_keyword]
  WHERE search_keyword IS NOT NULL AND search_keywords = '{}';
ALTER TABLE tiktok_posts DROP COLUMN IF EXISTS search_keyword;

-- Extend social_comments for TikTok
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS post_id TEXT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS likes_count BIGINT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS reply_count BIGINT;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS is_reply BOOLEAN DEFAULT false;
ALTER TABLE social_comments ADD COLUMN IF NOT EXISTS parent_comment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_social_comments_post
  ON social_comments(post_id) WHERE post_id IS NOT NULL;

-- ── Trending Hashtags ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trending_hashtags (
  id          SERIAL PRIMARY KEY,
  hashtag     VARCHAR(200) NOT NULL,
  category    VARCHAR(50)  NOT NULL DEFAULT 'trending', -- 'trending' or 'brand'
  brand_slug  VARCHAR(100) REFERENCES brands(slug),
  view_count  BIGINT,
  post_count  INT,
  scraped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trending_hashtags_scraped ON trending_hashtags(scraped_at DESC);
