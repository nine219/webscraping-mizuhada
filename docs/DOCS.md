# Mizuhada Social Intelligence — Developer Docs

Monitors brand voice for Mizuhada's three own brands — **MizuMi**, **Gentle Colors**, **Bomi** — across **TikTok**, **Instagram**, **X (Twitter)**, **Xiaohongshu (XHS)**. Scrapes posts + UGC + comments, classifies with LLMs (sentiment, urgency, topic, theme, brand relevance), detects spikes, sends LINE alerts/digests, serves a Next.js dashboard.

Map for the next developer: every module, its techniques, its traps.

---

## Table of Contents

1. [Terminology](#terminology)
2. [Stack & Repository Layout](#stack--repository-layout)
3. [Setup](#setup)
4. [Environment Variables](#environment-variables)
5. [Process Architecture (PM2 + Docker)](#process-architecture-pm2--docker)
6. [Data Flow](#data-flow)
7. [Cron Schedule & Locking](#cron-schedule--locking)
8. [Database Schema](#database-schema)
9. [Runtime Settings System](#runtime-settings-system)
10. [Keyword Configuration](#keyword-configuration)
11. [Scrapers — TikTok](#scrapers--tiktok)
12. [Scrapers — Instagram](#scrapers--instagram)
13. [Scrapers — X (Twitter)](#scrapers--x-twitter)
14. [Scrapers — Xiaohongshu](#scrapers--xiaohongshu)
15. [Anti-Bot Techniques (read before touching any scraper)](#anti-bot-techniques)
16. [AI / LLM Layer](#ai--llm-layer)
17. [Analysis Pipeline](#analysis-pipeline)
18. [Spike Detection](#spike-detection)
19. [LINE Alerts & Digests](#line-alerts--digests)
20. [X Campaign Tracking](#x-campaign-tracking)
21. [API Reference](#api-reference)
22. [Job System](#job-system)
23. [Dashboard](#dashboard)
24. [Tools & Scripts](#tools--scripts)
25. [Adding a New Scraper](#adding-a-new-scraper)
26. [Debugging](#debugging)

---

## Terminology

Canonical vocabulary — use in code, PRs, discussion. `_Avoid_` synonyms cause real ambiguity (usually two similar things map to different DB rows).

**Feed post** — tweet from a tracked own-brand/ambassador account. Campaign anchor. _Avoid: own post, profile tweet._

**UGC mention** — tweet from any third party matching brand keywords. Always-on brand-image stream, count-only. _Avoid: search post, keyword hit._

**Brand-image stream** — the always-on UGC keyword search. Runs regardless of campaign state.

**Campaign stream** — capture anchored on a campaign's feed posts (replies, quotes, counts). Bounded to a post set + date window.

**Reply** — comment on a tweet, own sentiment row, campaign posts only. Gets negative-flagged/DM'd. _Avoid: comment (reserved for the cross-platform generic)._

**Quote tweet** — retweet + own text, sentimented, campaign posts only. _Avoid: quote RT, QT._

**Retweet** — plain repost, no text. Count only — retweeter list NOT enumerated (X truncates + rate-limits it). _Avoid: RT, share, repost._

**Campaign** — marketing initiative (e.g. Pond–Phuwin push), one unit over a date window. Join key: campaign hashtag (primary) + ambassador handles + manual add/remove. Has start/end dates. _Avoid: promotion, activation._

**Ambassador** — non-brand account (e.g. Pond, Phuwin) on a campaign. Posts = anchor posts; handle feeds the scraper while active. _Avoid: influencer, KOL, talent._

**Anchor post** — campaign feed post from brand/ambassador. Deep-scraped: replies + quotes as sentiment rows, plus counts. _Avoid: seed post, source post._

**Hashtag-UGC** — third-party tweet with a campaign hashtag. Counts toward reach/sentiment, NOT deep-scraped (cost bound). Distinct from **UGC mention** (not campaign-scoped).

**Campaign report** — frozen wrap-up at campaign end: reach, sentiment split, hashtag volume, top posts/amplifiers, computed on-demand. Trending-in-Thailand status NOT included. _Avoid: campaign summary, recap._

**Negative-attention queue** — surface-only view of negative X rows (campaign + UGC), sorted by urgency, handle + link for manual DM. No resolution state — handled items reappear. _Avoid: crisis queue, ticket, case._

---

## Stack & Repository Layout

| Layer | Technology |
|---|---|
| Backend | TypeScript + Node.js 20, Express 4, `ts-node` (no build step) |
| Scraping | Playwright 1.49, real `google-chrome-stable`, persistent profiles. 3 containerized platforms (TikTok/IG/X): Xvfb + noVNC (fixed port/platform) for login. XHS: host, real screen, no Xvfb/noVNC. |
| Frontend | Next.js 14 App Router (`dashboard/`), own `package.json` |
| Database | PostgreSQL 15 + TimescaleDB, 1 container (`social-db`). Legacy main DB dropped from Compose. |
| AI | Gemini (`@google/generative-ai`), OpenRouter/DeepSeek (axios) |
| Captcha | Flask + ddddocr (`captcha-solver/solver.py`, :5001) — TikTok only; XHS uses vision-LLM |
| Scheduling | `node-cron`, split by role: `scheduler-core` (Docker, non-browser) + one `scraper-<platform>` container/platform + one PM2 process (XHS host) |
| Alerts | LINE Messaging API (Flex) |
| Tests | vitest (`npm test`) |

**Test coverage is minimal** — 2 files (`scrape.test.ts`, `where-builder.test.ts`), job-queue + WHERE-clause only. None of the ~15 scraper/analysis modules are tested. No CI. Correctness comes from live-testing, not the suite.

```
src/
  alerts/          line.ts — LINE push + Flex style kit
  analysis/        sentiment, translate, post-theme, spike-detection, digests,
                   ai-usage ledger, llm-client, gemini-client, lang-detect,
                   comments (noise filter), campaign-membership, campaign-report
  api/             server.ts, require-api-key.ts, parse-date-range.ts, routes/*
  config/          settings-loader.ts — DB-backed runtime settings
  db/              social-client.ts, schema-social.sql, seed-social.ts, where-builder.ts
  notifications/   store.ts — dashboard bell notifications
  scheduler/       cron.ts — ALL recurring jobs
  scrapers/        keywords.ts + tiktok/ instagram/ twitter/ xhs/
  tools/           one-off CLI utilities (logins, backfills, reports)
  validators/      brand-relevance.ts, gemini.ts — LLM post filtering
dashboard/         Next.js app (own node_modules, own build)
captcha-solver/    Python ddddocr Flask service
scripts/           ad-hoc scrape/backfill scripts (ts-node)
docs/              this file only — everything else has been folded in below
```

### Own brands

| Slug | Display | TikTok | Instagram | X | XHS |
|---|---|---|---|---|---|
| `mizumi` | MizuMi | `mizumi_official` (+ `mizumi.mini`, `mizumiglobal`) | yes | `MizuMi__` | yes (满水美) |
| `gentle-colors` | Gentle Colors | `gentlecolorsofficial`, `gentlecolorsglobal` | yes | — | yes |
| `bomi` | Bomi | `bomiofficial_th` | yes | — | — |

`brands.slug` = stable ID everywhere. `brands.type`: `'own' | 'competitor'` — spikes + LINE alerts run for `own` only.

---

## Setup

### Prerequisites

- Node.js 20+ (`engines` enforces it)
- Docker Desktop (Postgres 15 + TimescaleDB images)
- Python 3.10+ (`captcha-solver/`: `flask`, `ddddocr`)
- Google Chrome at a standard path (`findChrome()`; override with `CHROME_PATH` — TikTok/Instagram only)

### First run

Since the 2026-07 Docker cutover, most of the platform runs as Compose services; only XHS runs on the host via PM2.

```bash
npm install
docker compose up -d              # social-db, api, dashboard, captcha-solver,
                                   # scheduler-core, scraper-tiktok/instagram/twitter
npm run db:migrate-social         # applies schema-social.sql — needs SOCIAL_DATABASE_URL at host port 5433
npm run db:seed-social            # inserts the 3 own brands
```

**Logins — TikTok/Instagram/X run in containers**, so login needs noVNC. Fixed port per platform (`platform-sessions.ts:NOVNC_PORTS`), also used by the dashboard's login tab:

| Platform | noVNC port |
|---|---|
| TikTok | 6080 |
| Instagram | 6081 |
| X/Twitter | 6082 |

```bash
docker compose run --rm -p 6080:6080 scraper-tiktok     /app/docker/scraper-login.sh   # http://localhost:6080/vnc.html
docker compose run --rm -p 6081:6081 scraper-instagram   /app/docker/scraper-login.sh   # http://localhost:6081/vnc.html
docker compose run --rm -p 6082:6082 scraper-twitter     /app/docker/scraper-login.sh   # http://localhost:6082/vnc.html
```
Log in, close when done. `platform_sessions` gets self-reported by whichever process holds the profile — `GET /api/<platform>/session` reads it without `api` touching the filesystem.

**XHS logs in on the host** (real Chrome, no VNC needed): `npm run xhs:login` (persistent profile — see [Tools & Scripts](#tools--scripts) for how this differs from `xhs:auth`).

```bash
pm2 start ecosystem.config.js     # host: XHS-only scraper (cron + queue worker)
pm2 save                          # persist across reboots
```

Sessions persist in per-platform Chrome profiles — no credentials in code. Host processes use home-dir profile dirs; containerized platforms use a named Docker volume so login survives container recreation:

| Platform | Profile dir (host) | Container volume |
|---|---|---|
| TikTok | `~/.tiktok-scraper-profile` | `tiktok-profile` |
| Twitter/X | `~/.twitter-scraper-profile` (override: `TWITTER_PROFILE`) | per-container volume |
| Instagram | `instagram-feed.ts:launchContext` | per-container volume |
| XHS | `~/.xhs-scraper-profile` (+ cookie export fallback) — host only | — |

### Manual dev (no PM2)

```bash
python captcha-solver/solver.py   # :5001 — REQUIRED before any TikTok scraper
npm run dev                       # API :3001 + dashboard dev :3000 (concurrently)
npm run scheduler                 # cron, separate terminal
```

### TypeScript check

```bash
npx tsc --noEmit    # checks src/ only; dashboard type-checked by `next build`
```

---

## Environment Variables

All in `.env.local` (gitignored), loaded via `ts-node -r dotenv/config ... dotenv_config_path=.env.local`.

### Core

| Variable | Purpose |
|---|---|
| `SOCIAL_DATABASE_URL` | Social DB, host port **5433**. `social-client.ts` **throws at import** if missing. Rewritten to `@social-db:5432` inside Compose. |
| `API_PORT` | Express port (default 3001) |
| `API_KEY` | Shared secret for **mutating** routes (`X-API-Key`). Unset ⇒ warn once, allow all. GET/HEAD/OPTIONS exempt. |
| `DASHBOARD_ORIGIN` | CORS allow-origin (default `http://localhost:3000`) |
| `NEXT_PUBLIC_API_URL` | Dashboard → API base URL |
| `NEXT_PUBLIC_API_KEY` | Baked into dashboard bundle **at build time** — export before `docker compose build dashboard`, see [Debugging](#debugging) |
| `CAPTCHA_SOLVER_URL` | Default `http://localhost:5001`; rewritten to `http://captcha-solver:5001` in Docker |
| `API_INTERNAL_URL` | Compose build arg for `dashboard` image (`http://api:3001`), SSR rewrites |
| `DASHBOARD_PUBLIC_URL` | Public dashboard URL used to build links inside LINE digest messages (default `http://localhost:3000` won't resolve for anyone off the host) |

### AI providers (multi-key rotation: `<NAME>`, `<NAME>_2` … `<NAME>_10`)

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` (+`_2`…`_10`) | Sentiment/theme/relevance. Rotates on 429. Default model `gemini-3.1-flash-lite`. |
| `OPENROUTER_API_KEY` (+…) | Primary for `llm-client.ts` (translation/utility). `OPENROUTER_MODEL` (default `qwen/qwen-plus`), `OPENROUTER_FALLBACK_MODEL` (default `deepseek/deepseek-chat`), `OPENROUTER_VISION_MODEL` (XHS captcha), `OPENROUTER_BASE_URL` override |
| `DEEPSEEK_API_KEY` (+…) | Native DeepSeek — used with no OpenRouter key, or Settings forces `deepseek`. `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` overrides. |
| `GEMINI_RELEVANCE_MODEL` | Override model for brand-relevance only |

### Alerts

| Variable | Purpose |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API push token. `LINE_NOTIFY_TOKEN` = legacy fallback. |
| `LINE_GROUP_ID` | Target group. Settings → Alerts overrides (DB wins). Unset/placeholder ⇒ stub mode, no crash. |
| `LINE_FLEX_DEBUG` | `1` ⇒ dump full Flex JSON on stub sends |

### Scraper tuning

| Variable | Purpose |
|---|---|
| `TIKTOK_SEARCH_BRAND` | Limit search run to one brand slug |
| `TIKTOK_TRENDING_SCRAPE` | `1` ⇒ live Playwright scrape of TikTok's explore page for trending hashtags. Default (`0`/unset) ⇒ falls back to DB aggregation instead of scraping. |
| `TIKTOK_DEBUG` / `COMMENT_DEBUG` | `1` ⇒ verbose logs (+ Gemini key-rotation logging) |
| `TIKTOK_COOKIE_HEADER` / `TIKTOK_COOKIES` (JSON) / `TIKTOK_MS_TOKEN` | Non-interactive auth (`tiktok-auth.ts:buildCookieHeader()`), priority order. Alternative to noVNC login. `MS_TOKEN` alone may not suffice for `item_list`. |
| `TIKTOK_PROXY` (+ `_USER`, `_PASS`) | Optional proxy (`tiktok-auth.ts:getProxyConfig()`) |
| `TWITTER_HEADLESS` | `1` ⇒ headless. **Keep unset** — X fingerprints it. |
| `TWITTER_PROFILE` | Override X profile dir |
| `TWITTER_MAX_PER_KEYWORD`, `TWITTER_SCROLL_ROUNDS`, `TWITTER_KEYWORD_DELAY_MS` (8s), `TWITTER_BRAND_DELAY_MS` (10min), `TWITTER_RATE_LIMIT_BACKOFF_MS` (90s), `TWITTER_RATE_LIMIT_ABORT_THRESHOLD` (3), `TWITTER_COMMENTS_POST_DELAY_MS` (20s), `TWITTER_STATS_REFRESH_DELAY_MS` (15s), `TWITTER_STATS_REFRESH_MAX_POSTS` (50), `TWITTER_DEBUG` | X pacing — CLI fallbacks; live reads Settings `thresholds.scrapeLimits` |
| `XHS_COOKIE_HEADER` / `XHS_COOKIES` (JSON) | Same cookie-based non-interactive auth pattern as TikTok's, for XHS |
| `XHS_CAPTCHA_SOLVER` | `0` ⇒ skip the VLM solve step, go straight to manual (default: try VLM first) |
| `XHS_CAPTCHA_MANUAL` | `0` ⇒ skip the manual-solve fallback window (default: on) |
| `XHS_CAPTCHA_MODEL` | Override vision model for captcha solving (default `google/gemini-3.1-flash-lite`) |
| `XHS_DEBUG` / `IG_DEBUG` / `IG_COMMENT_DAYS` | Verbose logs; IG comment-scrape lookback override |

---

## Process Architecture (PM2 + Docker)

**Post-2026-07 cutover: most runs as Docker Compose. Only XHS on host via PM2** — blocked by anti-bot in a container (SwiftShader software WebGL, no real GPU, triggers the wall even with real Chrome). Proven by elimination: healthy Xvfb, cleared lock, fresh noVNC, host's exact cookies, real `google-chrome-stable` → still 0 notes. Host on real hardware → 400+ notes/keyword, same cookies. GPU fingerprint, not network or cookies.

`docker-compose.yml` services:

| Service | Image | Role |
|---|---|---|
| `social-db` | `timescale/timescaledb-ha:pg15-latest` :5433 | mounts `schema-social.sql` |
| `api` | `Dockerfile.backend` | Express, **no browser** — enqueues to `scrape_jobs` instead of launching Chrome |
| `dashboard` | `dashboard/Dockerfile` | Next.js, built at image-build time (`API_INTERNAL_URL` build arg) |
| `captcha-solver` | `captcha-solver/Dockerfile` | ddddocr, used by `scraper-tiktok` |
| `scheduler-core` | `Dockerfile.backend`, `SCHEDULER_ROLE=core` | Non-browser only: sentiment, theme, translation, digests, cleanup, campaign sync |
| `scraper-tiktok` / `-instagram` / `-twitter` | `Dockerfile.scraper` (real Chrome + Xvfb + noVNC), `SCRAPER_PLATFORM=<p>` | Runs `scraper-entry.ts`: cron + queue worker (`queue-worker.ts`), one Chrome profile per platform (own Docker volume) |

Legacy `db` service (main DB) removed from Compose — nothing imports `db/client.ts`. Its volume was left on disk, undeclared.

`ecosystem.config.js` — host PM2, **1 app** now:

| Name | What | Notes |
|---|---|---|
| `scheduler` | `scraper-entry.ts`, `SCHEDULER_ROLE=scraper SCRAPER_PLATFORM=xhs` | XHS cron + queue worker, host's Chrome. Same PM2 slot as pre-cutover, program changed. |

`pm2-windows-startup` registered — survives reboots. `pm2 save` after process changes. Backend change: `docker compose build <service> && docker compose up -d <service>` (build-time snapshots, no hot reload); host: `pm2 restart scheduler`.

**Role gating** (`cron.ts`, boot-time): `SCHEDULER_ROLE` (`core`/`scraper`/unset) + `SCRAPER_PLATFORM` decide which jobs a process registers —
- unset (`legacyAllInOne`) → every platform + core — what `npm run dev`/`npm run scheduler` give locally
- `core` → core jobs only
- `scraper` + `SCRAPER_PLATFORM=<p>` → that platform's browser jobs only (XHS never ran under the legacy scheduler — `wantXhs` requires the explicit role)

---

## Data Flow

```
TikTok Feed (6h)      → tiktok_posts    source_type='profile'  → feed comments → social_comments
TikTok Search (4h)    → tiktok_posts    source_type='search'   → comments for new/recent posts
Instagram Feed (6h)   → instagram_posts source_type='feed'     → IG comments
X Search (2h)         → social_comments platform='twitter', source_type='search'  (UGC mentions)
X Track-by-link       → twitter_posts   source_type='feed'|'search' (campaign anchors)
X Replies/Quotes (6h) → social_comments platform='twitter', source_type='profile'
XHS Feed/Search (6h)  → xhs_posts (+ comments → social_comments platform='xiaohongshu')

           ↓ every 2h
classifyUnanalyzedComments()  — ONE Gemini call per batch does:
   sentiment + score + topic + urgency(neg only) + brand_relevance + Thai translation
           ↓
checkNegativeSentimentSpikes() — right after classification
detectSpikes()/detectTwitterSpikes() — after scrapes / stats refresh
           ↓
LINE: spike alerts, urgent-negative alerts, morning digest (07:00),
      weekly digest (Mon 08:00), TikTok top-5 spike digest (18:00)
```

Every post table keeps the full raw API response in `raw_data JSONB` for audit/replay/backfill (e.g. `author_followers` backfilled from `raw_data->'authorStats'` after the column was added).

---

## Cron Schedule & Locking

Source: `src/scheduler/cron.ts`. All times Asia/Bangkok. Cron expressions come from Settings (`app_settings.schedules.*.cron`), defaults:

| Runs | Cron | Job | Lock |
|---|---|---|---|
| Every 2h, on the hour | `0 */2 * * *` | Sentiment (XHS translate → classify 100 → negative-spike check) | `sentiment` |
| Daily 01:15/07:15/13:15/19:15 (~6h) | `15 1,7,13,19 * * *` | TikTok feed → feed comments | `tiktok` (+ `feed-comments`) |
| Every 4h, on the hour | `0 */4 * * *` | TikTok search → theme classification | `tiktok` |
| Mondays 05:40 | `40 5 * * 1` | TikTok watchlist/spike stats refresh | `tiktok` |
| Daily 03:30/09:30/15:30/21:30 (6h) | `30 3,9,15,21 * * *` | Instagram feed + comments | `instagram` |
| Daily 02:10/08:10/14:10/20:10 (6h) | `10 2,8,14,20 * * *` | XHS feed → search → comments (sequential, shared profile) | `xhs` |
| Every 2h, at :45 | `45 */2 * * *` | X keyword search | `twitter` |
| Every 6h, at :35 | `35 */6 * * *` | X replies + quote tweets | `twitter` |
| Every 3h, at :20 | `20 */3 * * *` | X stats refresh → spike detection | `twitter` |
| Every hour | `0 * * * *` | X campaign status sync (DB-only) | — |
| Daily 03:00 | `0 3 * * *` | `runSocialCleanup()` — purge > 6 months | — |
| Daily 07:00 | `0 7 * * *` | LINE morning digest | `morning-digest` |
| Mondays 08:00 | `0 8 * * 1` | LINE weekly digest | — |
| Daily 18:00 | `0 18 * * *` | LINE TikTok top-5 spike digest (DB-only; sends nothing if none spiked today) | `tiktok-spike-digest` |

**XHS is not manual-only** — real cron above, only in `scraper-xhs` host process (`wantXhs`, gated on role). Never ran under the legacy all-in-one scheduler. Still triggerable on demand via the job queue.

Three guard layers:

1. **`withLock(name, fn)`** — in-process mutex; overlapping ticks are *skipped*, not queued. TikTok feed/search/stats share `'tiktok'`; X search/comments/stats share `'twitter'` (one Chrome profile each).
2. **`ifEnabled(job, fn)`** — reads Settings enable flag every tick — toggling takes effect live. Cron-expression edits need `pm2 restart scheduler` (registered once at boot).
3. **Offset scheduling** — minute offsets deliberate so no two Chrome-heavy jobs co-start (racing launches caused real failures).

Boot runs sentiment + theme classification once, never the morning digest (would LINE-push on every restart).

---

## Database Schema

Source: `src/db/schema-social.sql` (idempotent). Retention: **6 months**, `cleanup_social_old_data()` (covers `social_comments`, `tiktok_posts`, `twitter_posts`, `alert_history`, `user_notifications`, `ai_usage_log`; `trending_hashtags` uses a Timescale retention policy).

### Tables

**`brands`** — reference, no retention. `slug`, `type ('own'|'competitor')`, per-platform handles.

**`tiktok_posts`** — unique `(brand_id, post_id)`.
- `source_type`: `'profile'` (feed) / `'search'` (UGC)
- `search_keywords TEXT[]` — GIN-indexed
- `author_handle`, `author_followers`, `author_hearts`, `author_video_count` — search posts only (`authorStats`)
- `spike_flag`, `spike_detected_at`, `last_alert_views`, `last_alert_at` — spike + resurgence state
- `theme` — Gemini label; `is_shop_content` + `shop_signal` — commerce heuristic
- `first_seen_at` — set once, never bumped (digests count new posts from it); `scraped_at` bumps every re-scrape
- `comments_scraped_at` + `comments_meta_at_scrape` — comment gating (below)
- `cover_url` — **signed CDN URL, expires in weeks**; refreshed per re-scrape; dashboard falls back to placeholder on 404

**`instagram_posts`** — mirrors `tiktok_posts`. `post_id` = IG shortcode, `external_id` = numeric media pk. `media_type`: image|video|carousel|reel. No public share count.

**`twitter_posts`** — X campaign anchors only (own + ambassadors + manually tracked). UGC stays in `social_comments`. Split rationale: anchors need campaign columns + different retention shape; avoids a nullable-heavy shared table. Extra: `retweets_count`, `quotes_count`, `campaign_id` (FK→campaigns, SET NULL), `is_ambassador`, `campaign_locked` (never automation-touched), `stats_refreshed_at` (set only when `updateTweetStats()` wrote real numbers, distinct from `comments_scraped_at`).

**`xhs_posts`** — XHS notes. `note_id` unique, `xsec_token` (TTL-bound access token), `caption_translated` (Thai), `collects_count`, sentiment fields on the note itself.

**`social_comments`** — every comment/reply/mention, all platforms. Unique `(platform, external_id)`.
- `platform`: tiktok/instagram/twitter/xiaohongshu/douyin/weibo
- `sentiment`: `positive|negative|neutral|question|resale` (NULL = unclassified). `resale` exists — 91% of X "neutral" was WTS/resale noise.
- `urgency` 1–5, negative only (5 = health/safety/viral risk)
- `brand_relevance`: `on_topic|other_brand` — excludes comparison threads from tallies
- `content_translated` — `''` = already Thai/EN, NULL = pending
- X-only: `views_count`, `retweets_count`, `author_followers`, `original_post_url`, `tweet_type`
- `source_type`: `'profile'` (own/campaign) vs `'search'` (UGC)

**`campaigns`** — X campaigns: `hashtags[]`, `ambassador_handles[]`, `starts_at/ends_at`, `status draft→active→ended` (hourly sync, +3-day tail).

**`scrape_jobs`** — Docker-split job queue ([Job System](#job-system)). `platform`, `job_type`, `brand`, `status` (`pending|running|done|error|cancelled`), `message`, `count`, `cancel_requested`, `params`/`result` (JSONB). Indexed `(platform, created_at) WHERE status='pending'`.

**`platform_sessions`** — one row/platform, self-reported by whichever process holds the browser profile: `valid`, `profile_dir`, `hint`, `checked_at`. `GET /<platform>/session` just SELECTs it (api has no browser). Written on boot, every 5min, and by the `login` job_type.

**Others** — `trending_hashtags` (INSERT-only hypertable), `user_notifications`, `app_settings` (single-row JSONB), `ai_usage_log` — all live.

**No `tiktok_products`/`competitor_ads`/`alert_rules`/`alert_history` here** — dropped 2026-07-24 (`b4db44f`) along with the empty Ads Library page. No reader/writer beyond seed rows + cleanup; LINE alerting is pushed directly from `spike-detection.ts`/`sentiment.ts`. Still defined in `src/db/schema.sql` — the **legacy main-DB schema**, itself vestigial (nothing imports `db/client.ts`, no Compose service runs `DATABASE_URL`). Don't confuse `schema.sql` with `schema-social.sql` — only the latter is live.

**Instagram's `spike_flag`/`spike_detected_at`/`watchlist` dropped from `instagram_posts`** (2026-07-30) — dead, 0 of 1100 rows had either set (no IG spike process; no watchlist toggle ever existed).

### Feature availability by platform (verified against code, not schema)

Some schema columns are filterable via API but never populated — schema alone will mislead. Verified 2026-07-08:

| Feature | TikTok | XHS | Instagram | X (Twitter) |
|---|:---:|:---:|:---:|:---:|
| Own-brand feed scrape | ✅ | ✅ | ✅ | ❌ (search-only) |
| UGC/keyword search | ✅ | ✅ | ❌ | ✅ |
| Dedicated post table | ✅ | ✅ | ✅ | ❌ (lives in `social_comments`) |
| Views/impressions | ✅ | ❌ | ⚠️ video/reel only | ✅ (from `SearchTimeline.views.count`, added 2026-07-08; older rows NULL) |
| Spike detection | ✅ live | ❌ | ❌ | ❌ |
| Watchlist | ✅ live, has toggle | ❌ | ❌ | ❌ |
| Post theme classification | ✅ | ❌ | ❌ | ❌ |
| Note/post-level sentiment | ❌ (comments only) | ✅ (unique) | ❌ (comments only) | ❌ (comments only) |
| Reply threading | ✅ | ❌ | ❌ | ❌ |
| Creator follower/tier data | ✅ (UGC posts, `authorStats`) | ❌ (not exposed) | ❌ (never mined) | ⚠️ extracted then discarded |
| Trending hashtags | ✅ (gated `TIKTOK_TRENDING_SCRAPE=1`) | ❌ | ❌ | ❌ |

Comment sentiment/topic/urgency + Thai translation apply uniformly across all 4 — see [AI / LLM Layer](#ai--llm-layer).

### Patterns to know

- **`xmax = 0` insert detection** — every upsert uses `RETURNING (xmax = 0) AS is_new`. True only on fresh insert.
- **Comment-scrape gating** (TikTok/IG/X): `comments_count` = API metadata (never overwritten, undercounts). Re-scrape fires only when metadata grew ≥ `commentGrowthDelta` (5) vs `comments_meta_at_scrape`. Real count via `COUNT(social_comments)` on demand.
- **Comment-count sorting** — `sort=comments` uses a correlated `COUNT(*)` subquery, NOT `tp.comments_count`. Cheap via partial index `idx_comments_post_platform`. Don't "optimize" back to the metadata column.
- **Migrations** — append `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + backfill at end of `schema-social.sql`, then `npm run db:migrate-social`. No framework.

### DB access layer

`src/db/social-client.ts` only: `socialPool` (max 10), `socialQuery`, `socialQueryOne`, `withSocialTransaction`, `runSocialCleanup()`. **Never import `db/client`** (legacy). `where-builder.ts` — parameterized WHERE clause helper.

---

## Runtime Settings System

`src/config/settings-loader.ts` — single-row `app_settings.settings` JSONB, deep-merged over `DEFAULT_SETTINGS`, cached 60s. All operational config editable in Settings without a deploy:

- `keywords` — **actual terms (TikTok per-brand, TikTok category, X per-brand, XHS) live in the `keyword_terms` table**, not this blob. `loadKeywordTerms()` overwrites those 4 fields on every load; `DEFAULT_SETTINGS` values are empty stubs (matter only if the DB query fails). Own AND competitor brands share `keyword_terms` (competitors previously had no editable list — false-positived "วิตซี"/"VC" against every vitamin-C post). Own-handle/influencer exclusions (`ownHandlesTiktok`, `ownHandlesTwitter`, `ownInfluencers`) stay settings-blob-backed.
- `thresholds` — spike thresholds (TikTok + smaller X set), `negativeSpikePct` (35), `feedMaxAgeDays` (30), `commentGrowthDelta` (5), `commentMinViews` (50k), per-platform `scrapeLimits`
- `alerts` — LINE token/group (env = fallback only)
- `schedules` — enable flag + cron per job (enable live; cron edit needs restart)
- `ai.provider` — `gemini | deepseek` switch

Typed getters: `getThresholds()`, `getKeywords()`, `getAlerts()`, `getAiSettings()`, `isJobEnabled()`, `getTikTokSearchTargets()`, `getTwitterSearchTargets()`, `getTwitterOwnHandles()`. `invalidateSettingsCache()` on settings PUT.

Circular-dependency note: `settings-loader` imports defaults FROM `keywords.ts`, so `keywords.ts` can't read settings — `matchBrandSlug()` takes candidates as a parameter instead.

---

## Keyword Configuration

**Live/editable source = `keyword_terms` table** (`platform` ∈ `tiktok|tiktok_category|twitter|xhs`, one row/keyword, own + competitor), read via `getKeywords()`/`getTikTokSearchTargets()`/`getTwitterSearchTargets()` — what the scrapers and Settings page actually use. `src/scrapers/keywords.ts` is now just: (a) original seed defaults, one-time migrated (`migrate-keywords-to-table.ts`, idempotent), and (b) matchers never migrated (`XHS_BRAND_KEYWORDS`, `AMBIGUOUS_KEYWORDS` — no `keyword_terms.platform` slot for either):

- `SEARCH_TARGETS` / `CATEGORY_KEYWORDS` / `CN_SEARCH_KEYWORDS` — seed values only. Latin + Thai + misspellings + hashtags; category terms save only if caption also mentions an own brand; XHS/Douyin/Weibo keep brand names Latin, categories Chinese, no Bomi (XHS-specific product decision).
- `XHS_BRAND_KEYWORDS` — compile-time only: excludes Bomi, adds `满水美` + ambassador names (genuine mentions often name the ambassador, not the brand). Use `matchBrandSlugXhs()`, never `matchBrandSlug`.
- `AMBIGUOUS_KEYWORDS` — compile-time only, terms colliding with non-skincare content (`bomi` = K-pop name). Must pass Gemini brand-relevance before saving.
- `OWN_BRAND_HANDLES` / `OWN_INFLUENCERS` — excluded from UGC / leaderboard. Settings-blob-backed, not `keyword_terms`.
- `containsKeyword(text, term)` — substring + Latin word-boundary guard (`bomi` ≠ inside `minibomi`). Thai has no delimiters — plain substring match.
- `matchBrandSlug(content, candidates)` — first match wins; competitors now have real curated rows (previously bare display-name match, same "วิตซี" false-positive).

**X brand scope: all 3 brands for UGC search** (Gentle Colors/Bomi re-enabled 2026-07-21 after clean rate-limit staging) — see [X Campaign Tracking](#x-campaign-tracking).

---

## Scrapers — TikTok

One persistent Chrome profile (`~/.tiktok-scraper-profile`) via `tiktok-browser.ts` — hence the shared `'tiktok'` lock.

**`tiktok-browser.ts`** — `TIKTOK_PROFILE_DIR`, `findChrome()`, `launchContext()` (`launchPersistentContext`, headful, desktop UA), `warmUp(ctx)` (primes session), `isSessionValid(page)`, `solveCaptcha(page)` (→ `tiktok-captcha.ts`).

**`tiktok-feed.ts`** — own-brand posts. `TIKTOK_ACCOUNTS` = 6 handles. Intercepts `api/post/item_list` XHR, never DOM. Up to 50 scrolls, stops past `feedMaxAgeDays` or 5 empty scrolls. Entry: `scrapeAllTikTok()`.

**`tiktok-search.ts`** — UGC search, two-phase:
- *Phase 1*: per keyword, intercept `/api/search/general/full/` + `/api/search/item/full/`, upsert (`source_type='search'`).
- *Phase 2*: comments via N parallel Chrome workers (default 2, own profile clone each) from a shared queue: new posts + <24h-old posts with metadata growth.
- Filter chain: skip own-brand handles → category posts need `matchBrandSlug()` → ambiguous posts need `filterIrrelevantPosts()` (Gemini) → `detectShopContent()` labels commerce → upsert → `detectSpikes()`.
- Cancellation: dashboard Stop sets `job.cancelRequested`; scraper polls between keywords/scrolls, unwinds via `ScrapeCancelledError`.
- No date sort — every 4h run re-scans all keywords (cheap dedupe via `ON CONFLICT`). 60s between brands.
- Entry: `searchAllBrands(shouldCancel?, skipComments?)`; single brand via `TIKTOK_SEARCH_BRAND`.

**`tiktok-comments.ts`** — paginated. Clicks comment icon; falls back to the "ความคิดเห็น" tab if the recommendation panel shows instead. Noise via `shouldKeepComment()`/`isEmojiOnly()`. Exports: `scrapePostComments`, `upsertComments`, `scrapeCommentsForBrand`, `scrapeCommentsForPost` (API trigger), `scrapeAllComments()` (6h cron).

**`tiktok-trending-hashtags.ts`** — Creative Center → `trending_hashtags` (`npm run scrape:hashtags`).

**`tiktok-stats-refresh.ts`** — weekly (Mon 05:40), re-fetches views/likes/shares/comments/`cover_url` for watchlisted/spike-flagged posts only.

**`shop-detection.ts`** — `detectShopContent(rawItem, caption)`: heuristics over `raw_data` + caption regex, returns matched signal (`shop_signal`).

**`tiktok-captcha.ts` + `captcha-solver/solver.py`** — slide/rotate captchas solved via ddddocr on `:5001`. Service down = scrapers hang at captcha.

---

## Scrapers — Instagram

Feed-only by design — UGC search removed (unreliable, too noisy).

**`instagram-feed.ts`** — `INSTAGRAM_ACCOUNTS` → intercept private JSON APIs while scrolling → `normalizeIg()` → `instagram_posts`. Entry: `scrapeAllInstagram()`.

**`instagram-comments.ts`** — `fetchComments(page, pk)`, up to 20 pages, same growth-delta gating as TikTok. Entries: `scrapeAllIgComments(days)`, `scrapeIgCommentsForBrand`, `scrapeIgCommentsForPost` (API trigger).

Login: `src/tools/instagram-login.ts`.

---

## Scrapers — X (Twitter)

History: a twscrape microservice was abandoned (Cloudflare blocked even clean IPs). Now: Playwright + persistent profile, XHR interception.

**`twitter-browser.ts`** — profile at `~/.twitter-scraper-profile`; `launchAndVerify()` probes `x.com/home` + `auth_token`, throws if invalid. Two locks: in-process mutex + **Postgres advisory lock** (`pg_advisory_lock(918273645)`, needed since api and scheduler are separate processes). `ctx.close()` monkey-patched to release both — a leaked context wedges every later launch, so any new browser-opening code MUST close its context.

**`twitter-search.ts`** — UGC search via `SearchTimeline` GraphQL. Pipeline: keyword → collect tweets → `matchBrandSlug` → Gemini `filterIrrelevantPosts` → `shouldKeepComment` → upsert (`social_comments`, `source_type='search'`), `content_translated=''` stamp for TH/EN.
Pacing: 8s/keyword, **10min/brand**, +90s post-429, abort after 3 consecutive 429s (`RateLimitedError`). Entry: `runTwitterSearchAllBrands()`; `getTwitterSessionStatus()` for the dashboard.

**`twitter-feed.ts`** — misleading name, timeline crawling removed. Single-tweet fetch: `parseTweetUrl`, `fetchSingleTweet(handle, id)`, `parseTweetById`, `upsertFeedTweet(tweet, brandId, isAmbassador, sourceType)` (`'feed'`=own/ambassador, `'search'`=tracked third party — conflating these once broke hashtag search), `updateTweetStats` (stamps `stats_refreshed_at`). `computeEngagementRate` shared so both write paths agree.

**`twitter-comments.ts`** — replies + quotes for recent anchors (`twitter_posts source_type='feed'`). Replies from `TweetDetail`, quotes from `/quotes` timeline. Distinguished only by `is_reply`. Effective stop: `STALE_SCROLL_LIMIT` (6 empty scrolls), not the 500-scroll cap. Known ceiling: X's quotes timeline serves well below reported `quotes_count` (~33/71 seen) — not our bug. 35-day window, growth delta 5, 20s/post. Entry: `runTwitterCommentsScrape()`.

**`twitter-stats-refresh.ts`** — every 3h, re-fetches stats not refreshed in 3h (max 50/run, 15s apart), then `detectTwitterSpikes()`.

---

## Scrapers — Xiaohongshu

**`xhs-browser.ts`** — persistent profile OR exported-cookie context; `detectWall()` → `login|captcha|ok`; captcha ladder: `detectCaptcha` → `solveCaptchaWithVlm` (`xhs-captcha-solver.ts`, vision LLM) → `waitForManualCaptcha` (3min window). `XHS_ACCOUNTS` = own-brand profiles.

**`xhs-feed.ts` / `xhs-search.ts` / `xhs-comments.ts`** — notes → `xhs_posts`, comments → `social_comments`. Search mirrors TikTok: keyword → `matchBrandSlugXhs` → **Gemini verification of every candidate** (mandatory, ambassador keywords are ambiguous) → upsert. `xsec_token` required per note or detail URL 404s.

**`xhs-db.ts`** — note persistence: `loadXhsBrandIds()` (cached), `upsertXhsPost(brandId, note, sourceType, searchKeyword?)`. Volatile fields refresh on conflict; `caption_translated` resets to NULL when a detail-fetch replaces a short caption, so the translate cron redoes it.

**`base-social.ts`** — legacy shared base (`BaseSocialScraper`, `RawSocialPost`, `upsertSocialComment`), XHS only — TikTok/IG/X are standalone.

CN content translates to Thai before sentiment: captions via `translateUntranslatedNotes()`, comments inline in the sentiment call.

---

## Anti-Bot Techniques


1. **Persistent profiles, manual login, headful.** Real logged-in profile, no credentials in code, no automated login. `headless: false` everywhere.
   **Use a throwaway/alt account, never the brand's official or your own personal one.** risk of getting ban.
2. **Intercept XHR/GraphQL, never DOM.** Feed=`item_list`; search=`/full/`; X=`SearchTimeline`/`TweetDetail`; IG=private JSON. Survives markup changes.
3. **One Chrome per profile, ever.** `withLock` only serializes within one process. All four platforms wrap `launchContext()` in a **Postgres advisory lock** (one key/platform) — protects against a container's own cron colliding with its queue worker. IG missing this until 2026-07-27 (added after a stress test: one job blocked 518s clean, then launched the instant the lock freed). New browser-opening code MUST use the same lock.
4. **Native UA per OS, never spoofed.** `desktop-ua.ts:DESKTOP_UA` — Linux returns `undefined` (Chromium's own consistent UA); Windows/macOS hard-codes a Windows UA. Previously hard-coded Windows UA everywhere, which mismatched `navigator.platform` inside Linux containers — itself a bot signal.
5. **Pace like a human, back off on 429, abort on repeat.** TikTok: 60s/brand. X: 8s/keyword, 10min/brand, 90s post-429, abort after 3 — X rate-limits silently via empty timelines, so "0 results" usually means too fast.
6. **Stagger cron minutes** so heavy jobs never co-start.
7. **Captchas**: TikTok → ddddocr; XHS → VLM then manual window.
8. **All raw responses into `raw_data`** — re-parse later, don't re-scrape.

---

## AI / LLM Layer

Two client stacks, one usage ledger:

**`gemini-client.ts`** — Google SDK, multi-key rotation: on 429, sidelines the key until reset, rotates. `DEFAULT_MODEL = 'gemini-3.1-flash-lite'`.

**`llm-client.ts`** — OpenAI-compatible via axios. Auto-select: OpenRouter (`qwen/qwen-plus` → `deepseek/deepseek-chat`, retried across keys) → native DeepSeek. `chatComplete`, `chatCompleteWithUsage`, `chatCompleteDeepSeek` (forced path), `chatCompleteVision[WithUsage]` (XHS captcha).

**`ai-usage.ts`** — `logAiUsage()` writes one row/call (provider, model, purpose, tokens, cost). Purposes: `sentiment|translate|post-theme|brand-relevance|captcha-vision`. Powers Admin → AI usage. **New LLM call sites must log here** or cost tracking misses them.

**Validators:**
- `brand-relevance.ts` — `filterIrrelevantPosts()`: batches of 20 → Gemini/DeepSeek, brand-specific disambiguation prompt (ambassadors, `bomi` collision). No-LLM fallback: `contextFallback()` requires ≥1 skincare keyword (`post-verifier.ts:hasSkincareContext`) — rejects rather than accepts.
- `gemini.ts` — `validateComments()` for XHS.

---

## Analysis Pipeline

**`sentiment.ts` — `classifyUnanalyzedComments(n)`** — the workhorse. `n` rows `WHERE sentiment IS NULL`, batches of 50, one prompt returns everything: sentiment (5-way + `resale`), score, Thai topic, urgency (negative only), Thai translation, `brand_relevance`. Defensive parsing: bad sentiment → `neutral`, missing relevance → `on_topic`. Urgent negatives feed `alertUrgentNegativeComments()` → LINE.

**`translate.ts`** — `translateUntranslatedNotes(n)`: XHS note captions only. Comment translation is inline in sentiment.

**`lang-detect.ts`** — `needsTranslation(content)`: CJK/Hangul/extended-Latin regex. Stamps `content_translated=''` at insert for TH/EN.

**`post-theme.ts`** — `classifyMissingPostThemes(n)`: labels `tiktok_posts.theme`. Runs after each search + on boot.

**`comments.ts`** — noise filters: `NOISE_PATTERNS`, `isNoiseComment`, `isEmojiOnly`, `isMentionOnly`, `shouldKeepComment` (scrape-time), `noiseExcludeSql(column)` (query-time).

**`tiktok-spike-digest.ts`** — `sendTikTokDailySpikeDigest()`: daily 18:00 LINE roundup of the day's top 5 spiked TikTok posts (own brands), any post age, gated on `spike_detected_at` falling today. Sends nothing on a quiet day.

**`campaign-report.ts`** — `getCampaignReport(id)`: engagement, sentiment split, reply/quote counts (`npm run report:campaign`).

---

## Spike Detection

`spike-detection.ts` — thresholds Settings-driven.

**TikTok** — `detectSpikes(brandId, slug)` / `reEvaluateAllSpikesQuiet()`:
- Two flat OR conditions: A) views ≥100k AND eng ≥3%. B) views ≥500k AND eng ≥2%.
- **Symmetric un-flagging** — tightening a threshold removes stale spikes.
- **Resurgence** — re-alerts at +50%/+50k views over `last_alert_views`, 6h cooldown, baseline advances same UPDATE (no double-fire).
- No `posted_at` cutoff for flagging; alert-window check prevents paging on ancient spikes.
- Own brands only.

**X** — `detectTwitterSpikes()` (after 3h stats refresh): same shape, `x*` thresholds (10k/50k views — unmeasured guesses, ~1/10 TikTok scale).

**Negative sentiment** — `checkNegativeSentimentSpikes()` after each sentiment run: alerts when negative % > 35. Plus `alertUrgentNegativeComments()` per high-urgency comment.

---

## LINE Alerts & Digests

**Currently a test group, few people, not a live channel** — swap `LINE_GROUP_ID` when this goes beyond internal testing.

### Getting LINE credentials (Messaging API, one-time)

No LINE account exists in this repo — has to be created externally:

1. **developers.line.biz** → log in with a LINE account → create a **Provider** → inside it create a **Messaging API channel** (this is the "LINE Business" side, separate from a personal LINE account).
2. Channel's **Messaging API** tab → **Issue** a long-lived **Channel access token** → this is `LINE_CHANNEL_ACCESS_TOKEN`.
3. In **LINE Official Account Manager** (the linked OA dashboard) turn off auto-reply/greeting messages — otherwise the bot spams the group with default replies on top of our pushes.
4. Add the channel's OA as a friend, then invite it into the target LINE group.
5. **Getting `LINE_GROUP_ID`** — this app only pushes (no inbound webhook route exists here), so there's nothing in-repo to read it from. Get it externally: in the channel's Messaging API settings, temporarily point **Webhook URL** at a public catcher (ngrok tunnel to a local listener, or a site like webhook.site), enable webhooks, then send any message in the group with the bot present. The received payload's `events[].source.groupId` is the value. Turn the webhook back off/blank afterward — this app never consumes it, leaving it pointed at a dead URL is harmless but pointless.
6. Put both values in `.env.local` (`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_GROUP_ID`) or Settings → Alerts in the dashboard (DB wins over env).
7. Verify before relying on it: unset/placeholder values silently fall to stub mode (console log, no crash) — check logs for an actual push attempt, not just absence of errors. `LINE_FLEX_DEBUG=1` dumps the full Flex payload on stub sends if a message looks wrong.

**`alerts/line.ts`** — LINE Messaging API push. Config from Settings, env fallback; missing ⇒ stub mode. `sendLineMessage`, `sendLineFlex`, `sendLineTextThenFlex` (one push, no interleave). Shared Flex kit: `FLEX_COLORS`, `PLATFORM_COLORS`, `kpiTile`, `deltaBadge`, `sentimentBar`, `fmtCompact`, `truncateText`, `sanitizeCarousel`/`isValidFlexContent` (drop malformed bubbles, don't fail the push).

**`digest-common.ts`** — shared digest data + bubbles: `fetchBrandDigest`, `fetchTwitterStats`, `fetchTopPosts/Hashtags/Topics`, `fetchUrgentComments`, `fetchRecentSpikePosts`, `brandBubble`, `needsAttentionBubble`, `rideTheWaveBubble`, `performanceBubble`, `takeaway()`.

**`morning-digest.ts`** (07:00) — yesterday's posts/UGC/engagement, urgent comments, spikes. **`weekly-digest.ts`** (Mon 08:00) — weekly recap. Manual: `npm run digest:morning`, `send-weekly-digest.ts`.

---

## X Campaign Tracking

**Campaign stream is MizuMi only** (scope decision, 2026-07-13) — not schema-hardcoded, but Gentle Colors/Bomi are out of scope for anchors/ambassadors/campaign creation. Two streams: (1) **campaign stream** — MizuMi's + ambassadors' feed posts, deep-scraped replies/quotes, grouped by hashtag; (2) always-on **brand-image UGC stream**.

**UGC stream is NOT MizuMi-only anymore** — narrowed 2026-07-13 after Gentle Colors/Bomi keywords caused 429s + a run-abort. Reopened from 2026-07-21: staged rollout, then full 3-brand dry-run hit zero rate-limits, verifier checked clean — all 3 back on (`getTwitterSearchTargets()`). Allowlist stays an explicit `Set`, not "all configured brands," so it's the enforcement point if rate-limits return — watch `logs/scheduler-err.log`.

Negative comments surface in a queue for manual DM. Campaign end → frozen wrap-up report.

Cadence: 6h deep-scrape while Active; lifecycle Draft → Active → Ended, +3-day tail, then freeze.

**Out of scope / deferred:**
- X Trending-in-Thailand detection
- Retweeter-list enumeration (X truncates + rate-limits)
- DM-state tracking, templates, automated DMs
- Auto-clustering/auto-draft campaigns
- Per-post verification (verification is per-campaign)
- Gentle Colors & Bomi on campaign tracking (UGC search is open to all 3)
- Own-brand X feed for anyone but MizuMi

**Key risk:** shared X session already 429s under UGC load. Campaign scraping multiplies requests on it. Mitigation: 6h cadence + Active-only + MizuMi-narrow anchors + existing backoff.

Design decisions:
- **Membership manual-only.** Join via track-link (`POST /api/campaigns/:id/track-link`, live-verifies) or add-by-id. Hashtag auto-assignment exists (`campaign-membership.ts`) but is **deliberately not called** — misattributes unrelated posts. Human-set membership → `campaign_locked=true`, automation never touches locked rows.
- Timeline feed-scraping removed — anchors come only from tracking actions.
- `syncCampaignStatuses()` (hourly, DB-only) moves status by dates, +3-day tail.
- Ongoing: replies/quotes every 6h, anchor stats every 3h, spike check after refresh.
- Reporting: `GET /api/campaigns/:id/report`; `/suggestions` (hashtag candidates for human confirm); `POST /:id/search-x` (scoped live search); `POST /:id/scrape-now` (force refresh).

---

## API Reference

Base `http://localhost:3001`. `GET /health` unauthenticated. Mutating requests need `X-API-Key: $API_KEY` when set. List endpoints share `parse-date-range.ts` (`days` or `from`/`to`; `resolveWindowWithPrior` for deltas).

### TikTok (`routes/tiktok.ts`, `tiktok-jobs.ts`, `tiktok-influencers.ts`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tiktok/session` · POST `/login` | Session probe / open login |
| GET | `/api/tiktok/posts` | Filters: `brand, days/from/to, sort, spike, source_type, watchlist, page, limit` |
| GET | `/api/tiktok/posts/:postId` | Post + comments + sentiment breakdown |
| DELETE | `/api/tiktok/posts/:postId` | Deletes post + comments |
| PATCH | `/api/tiktok/posts/:postId/watchlist` · `/theme` | Toggle watchlist / set theme |
| GET | `/api/tiktok/spikes` | Spiked posts |
| GET | `/api/tiktok/hashtags` · `/trending-hashtags` | Hashtag frequency / Creative Center trends |
| GET | `/api/tiktok/search` · `/search/stats` | UGC posts; stats = keyword breakdown, authors, sentiment, trend |
| POST | `/api/tiktok/search/run` · `/scrape` · `/scrape/adhoc` · `/posts/:postId/scrape-comments` | Job triggers → `{ jobId }` |
| GET | `/api/tiktok/influencers` | Leaderboard: `sponsor_score` = advocacy 40% + resonance 35% (capped) + reach 25% (log10 followers), normalized to result set max |
| GET | `/api/tiktok/creators/:handle` | Creator drill-down |

`post_url` for search posts: `COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle)` — links the actual creator.

### Twitter/X (`routes/twitter.ts`, `routes/campaigns.ts`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/twitter/session` · POST `/login` | |
| POST | `/api/twitter/search/run` | Manual UGC job (advisory-locked vs scheduler) |
| GET | `/api/twitter/posts` · `/posts/:postId` | Anchors + replies/quotes |
| GET | `/api/twitter/mentions/stats` | UGC stats incl. `tweet_type` filter |
| POST/GET | `/api/campaigns` | Create / list |
| GET | `/api/campaigns/suggestions` · `/:id` · `/:id/report` | |
| POST | `/api/campaigns/:id/track-link` · `/:id/posts` · `/:id/search-x` · `/:id/scrape-now` | |
| PATCH/DELETE | `/api/campaigns/:id` · DELETE `/:id/posts/:postId` | Manual remove sets `campaign_locked` |

### Instagram / XHS

`/api/instagram/*` mirrors TikTok (session, login, posts, posts/:id, scrape, scrape/adhoc, posts/:id/scrape-comments). `/api/xhs/*`: session, login, mentions, note/:noteId, stats, run, search/run, scrape/adhoc.

### Cross-platform & infra

| Route | Purpose |
|---|---|
| `/api/social` (+`/stats`, `/topics`, POST `/analyze`, PATCH `/comments/:id/sentiment`) | Cross-platform feed; sentiment override; trigger classification |
| `/api/command-center/*` | Home-dashboard aggregates |
| `/api/brands` (+`/:slug`) | Brand list |
| `/api/notifications` | Dashboard bell |
| `/api/scrape/status/:jobId` · `/stop/:jobId` · `/jobs` | Job polling (3s), cancel, recent-30 list |
| `/api/settings` | Runtime settings + brand CRUD + CSV export |
| `/api/admin` | Env editor, pm2 restart, multi-search, status, AI cost |

---

## Job System

Since the Docker split, `api` has no browser — every trigger is a DB-queued job, claimed by the matching `scraper-<platform>` container (host for XHS).

**`routes/scrape.ts`:**
- `enqueueScrapeJob(...)` — the only way routes trigger a scrape. INSERTs `pending`, returns `{ id }`. Validates synchronously first (bad request 400s instantly, no queue round-trip).
- `startScrapeJob(opts, fn)` — pre-cutover in-memory pattern. **No route uses it anymore** (2026-07). Left in place, safe to remove once the queue path is fully trusted.
- Status/stop/list routes read/write the DB row (fall back to in-memory Map for tests without `SOCIAL_DATABASE_URL`). `result` carries type-specific payloads for job types that need data back.
- Cancellation: `POST /stop/:jobId` sets `cancel_requested`; worker polls it and unwinds cooperatively.

**`queue-worker.ts`** — runs in every `scraper-<platform>` container + XHS host, alongside that process's cron:
- `startQueueWorker(platform)` — polls every 1000ms for the oldest `pending` row, claims via `FOR UPDATE SKIP LOCKED`, executes, writes back.
- `dispatch(row, handle)` — routes by platform + `job_type`. Types: TikTok `search|comments|feed|adhoc-feed|login`; IG `comments|feed|adhoc-feed|login`; X `search|campaign-comments|track-link|search-x|login`; XHS `feed|adhoc-feed|search|login`. `login` launches Chrome, polls for the session cookie (up to 15min, 5 for X), writes `platform_sessions`.
- One worker per container, **strictly sequential** — a slow sweep (20-30+ min) blocks everything queued behind it. No per-job timeout or priority.
- `scraper-entry.ts` — entrypoint: registers cron then starts the queue worker, same process, shared cross-process lock (prevents cron + worker double-launching Chrome).
- **Jobs are lost only if the claiming container dies mid-job** — row stuck at `running` forever, nothing re-claims it. No reaper; clean up manually (`UPDATE scrape_jobs SET status='error' ...`).

---

## Dashboard

`dashboard/` — Next.js 14 App Router. All API calls via `dashboard/lib/api.ts` — never fetch inline. Colors from CSS vars in `globals.css`, never hardcoded.

| Route | Page |
|---|---|
| `/` | Command center |
| `/tiktok` | Tabbed hub: Feed / Search / Hashtags / Influencers / Spikes / Viral |
| `/tiktok/[post_id]` | Post detail + comments |
| `/tiktok/creator/[handle]` | Creator drill-down |
| `/instagram`, `/ig-post/[post_id]` | IG feed + post detail |
| `/x` | Campaigns, tracked posts, mentions, session |
| `/xhs`, `/xhs/[note_id]` | XHS notes + note detail |
| `/social` | Cross-platform feed |
| `/ugc`, `/overview`, `/reports` | Aggregate views |
| `/settings` | Account Management (session status + login for every platform), Brands, Keywords, Thresholds, Schedules, Multi-Platform Search |
| `/admin` | Env editor, restarts, LINE group ID + AI provider config, AI usage/cost, status, link to Multi-Platform Search |

Production runs the **built** app via `dashboard/start.js` under PM2 — rebuild after changes.

---

## Tools & Scripts

`src/tools/` (`ts-node -r dotenv/config src/tools/<file>.ts dotenv_config_path=.env.local`, some have npm aliases):

| Tool | Purpose |
|---|---|
| `tiktok-login` / `twitter-login` / `instagram-login` / `export-xhs-cookies` / `export-tiktok-cookies` | Interactive session setup |
| `xhs-login` (`npm run xhs:login`) | Logs into the **persistent profile** — right one for container/volume login. **Different from `xhs:auth`** (`export-xhs-cookies.ts`), which writes `XHS_COOKIES` to `.env.local` instead. Use `xhs:login` unless you need the env-var export. |
| `migrate-keywords-to-table` | One-time backfill into `keyword_terms` (see [Keyword Configuration](#keyword-configuration)). Already run — don't re-run. |
| `analyze-comments` (`npm run analyze:sentiment`) | Run classifier once |
| `classify-backlog` | Drain the sentiment backlog |
| `reclassify-comments` | Re-grade all (after prompt changes) |
| `backfill-urgency` / `backfill-shop-content` | Backfills for later columns |
| `send-digest` / `send-weekly-digest` | Manual digest push |
| `big-scrape` | Deep one-off scrape |
| `sentiment-xhs`, `compare-sentiment-xhs`, `xhs-clean-comments`, `xhs-raw-export`, `xhs-open-browser`, `bench-xhs-captcha` | XHS utilities |
| `june-stats-report`, `dashboard-walkthrough`, `test-one-comment`, `mock-her-hyness` | Reporting / testing aids |

`scripts/` (repo root): `twitter-feed-backfill.ts`, `twitter-search-backfill.ts`, `run-tiktok-search-cron.ts`, `tiktok-keyword-search.ts`, `tiktok-keyword-csv-scrape.ts`, `inspect-insta-search.ts`, `aggregate-insta-search.ts`, `export-report-pdf.js`, `rebuild-dashboard.bat`.

---

## Adding a New Scraper

1. **Keywords** — add to `keywords.ts` (+ `settings-loader.ts` defaults if Settings-editable).
2. **Browser layer** — copy `twitter-browser.ts`'s pattern: profile dir, `findChrome()`, `launchAndVerify()`. Add a pg advisory lock if both API and scheduler drive it.
3. **XHR interception**, not DOM. Full response into `raw_data`.
4. **DB** — idempotent DDL in `schema-social.sql`; shared columns (`source_type`, `first_seen_at`, `comments_scraped_at`/`comments_meta_at_scrape`, `raw_data`, `xmax=0`). DELETE in `cleanup_social_old_data()`.
5. **Insert-time hygiene** — `shouldKeepComment()`, `needsTranslation()` stamp, `filterIrrelevantPosts()` for ambiguous hits.
6. **API route** — new file in `api/routes/`, register in `server.ts`; `startScrapeJob` for triggers, `WhereBuilder`/`parseDateRange` for lists.
7. **Cron** — `withLock` + `ifEnabled`, `ScheduleSettings` entry, non-colliding minute offset.
8. **LLM calls** — through `gemini-client`/`llm-client`, log via `logAiUsage`.
9. **Dashboard** — typed wrapper, page, CSS vars only.

---

## Debugging

**Verbose logs** — `TIKTOK_DEBUG=1`, `COMMENT_DEBUG=1`, `LINE_FLEX_DEBUG=1`.

**Captcha solver down** → TikTok hangs at captcha. Docker: `docker compose up -d captcha-solver`. Host: `python captcha-solver/solver.py`.

**Session expired** — TikTok: `npm run tiktok:login`. X: `npm run twitter:login`, probe `GET /api/twitter/session`. XHS: `npm run xhs:login`.

**X returns 0 results** — usually a silent soft-block, not missing data. Check for 429s/`RateLimitedError`; wait, don't lower delays.

**X Chrome window flapping** — two processes fighting over the profile. Advisory lock should prevent it; if not, find the path missing `launchAndVerify()` or a leaked `ctx.close()`.

**Sentiment stuck NULL** — check `GEMINI_API_KEY`; look for "All keys exhausted"; check `ai_usage_log`; drain via `classify-backlog.ts`.

**DB connection refused** — social DB is **5433**, not 5432.

**Route change not taking effect** — rebuild: `docker compose build <service> && docker compose up -d <service>`, not just `src/` edits.

**Every dashboard button 401s** — `NEXT_PUBLIC_API_KEY` wasn't set at build time (inlined at build, not runtime). Compose doesn't auto-load `.env.local` for build-arg interpolation. Rebuild with it exported: `NEXT_PUBLIC_API_KEY=$(grep -oP '^API_KEY=\K.*' .env.local) docker compose build dashboard`.

**`scrape_jobs` row stuck `running`** — owning container died mid-job. Confirm nothing's still working it, then `UPDATE scrape_jobs SET status='error', ... WHERE id=...`.

**Killed background script still running** — on Windows, killing a wrapper process doesn't reliably kill its child `node`/`ts-node`. Verify with `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`.

**Schedule edits not applying** — enable/disable is live; cron-expression changes need `pm2 restart scheduler`.

**Job status stale after API restart** — job store is in-memory; expected, re-trigger.

**Thumbnails 404** — `cover_url` is a signed CDN URL that expires; refreshes on next re-scrape.

**Scheduler restarted and LINE-pushed?** — shouldn't: morning digest only runs from its cron entry, never on boot.

**TypeScript** — `npx tsc --noEmit` (src only); dashboard via `next build`. Tests: `npm test`.

**Container won't launch Chrome / "SingletonLock"** — stale lock from a killed container. `docker/scraper-run.sh` clears it on start; otherwise delete manually from the profile volume.

**Shell script fails in container** — check line endings. `.gitattributes` forces LF on `*.sh`/Dockerfiles (CRLF breaks shebangs).

**Deployment / hosting** — still local/dev-machine only. Intended for a private server eventually; target not chosen yet. Document here once decided.
