# Mizuhada Social Intelligence Platform

Social listening platform for Mizuhada's own brands — **MizuMi**, **Gentle Colors**, **Bomi**. Monitors brand voice across TikTok, Instagram, Xiaohongshu, and X (Twitter); classifies sentiment; detects engagement/negative-sentiment spikes; surfaces everything in an in-house dashboard with LINE alerting. X also gets dedicated campaign tracking (MizuMi only — see `docs/DOCS.md#x-campaign-tracking`).

**Stack:** TypeScript Node.js (Express + Playwright scrapers + cron) · Next.js 14 (App Router) · PostgreSQL 15 + TimescaleDB · Docker · PM2 (XHS only)

For architecture, every scraper's internals, DB schema, cron schedule, anti-bot techniques, and the API reference, see **[docs/DOCS.md](./docs/DOCS.md)** — the developer deep-dive. This file is just the map + quick start.

---

## Platform coverage

| Platform | Feed (own brands) | UGC/keyword search | Comments | Notes |
|---|---|---|---|---|
| **TikTok** | ✅ ~every 6h | ✅ every 4h | ✅ | Most mature — also has trending-hashtags + influencer leaderboard |
| **Instagram** | ✅ every 6h | ❌ | ✅ | UGC search was removed — tagged-feed scraping proved unreliable, hashtag search too noisy for real UGC |
| **Xiaohongshu (XHS)** | ✅ every 6h (host-only cron) | ✅ every 6h | ✅ | Chinese-market coverage. Runs on the host, not in Docker — blocked by anti-bot in a container |
| **X (Twitter)** | ✅ MizuMi + ambassadors, campaign-only | ✅ every 2h | inline with search + campaign replies/quotes | Playwright + persistent Chrome profile |

Own-brand vs. competitor distinction is driven by the `brands` table (`type: 'own' | 'competitor'`), editable in Settings → Brands — not hardcoded per platform.

---

## Quick start

```bash
npm install
docker compose up -d              # social-db, api, dashboard, captcha-solver,
                                   # scheduler-core, scraper-tiktok/instagram/twitter
pm2 start ecosystem.config.js     # host: XHS-only (cron + queue worker)
pm2 save                          # persist across reboots
```

Full setup (DB migration/seed, one-time platform logins via noVNC, manual dev without Docker) is in **[docs/DOCS.md#setup](./docs/DOCS.md#setup)**.

---

## Dashboard pages

| Route | What it shows |
|---|---|
| `/` | Command center — KPIs, per-brand sentiment/health, topic matrix, crisis view |
| `/tiktok` | Tabbed hub: Feed / UGC Search / Hashtags / Influencers / Spikes / Viral |
| `/instagram`, `/x`, `/xhs` | Per-platform feed/UGC/campaign views |
| `/social` | Cross-platform comment feed |
| `/ugc`, `/overview`, `/reports` | Aggregate views |
| `/settings` | Account Management (session status + login for every platform), Brands, Keywords, Thresholds, Schedules, Multi-Platform Search |
| `/admin` | Env editor, service restarts, LINE group ID + AI provider config, AI usage/cost, link to Multi-Platform Search |

Full route list with per-page detail: **[docs/DOCS.md#dashboard](./docs/DOCS.md#dashboard)**.

---