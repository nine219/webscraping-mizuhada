/**
 * Twitter/X keyword search scraper (Playwright).
 *
 * Loads the persistent scraper profile (see twitter-browser.ts) and hits X's
 * search page. We do NOT parse the DOM — instead we intercept the
 * `/i/api/graphql/.../SearchTimeline` XHR response and read its raw JSON,
 * which matches how the web app renders results and survives markup changes.
 *
 * Same pipeline as tiktok-search / xhs-search: keyword → matchBrandSlug →
 * group by brand → Gemini filterIrrelevantPosts → drop irrelevant → upsert
 * into social_comments (platform='twitter').
 */
import type { BrowserContext, Page } from 'playwright';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { matchBrandSlug, BrandMatchCandidate } from '../keywords';
import { getTwitterSearchTargets, getTwitterOwnHandles, getThresholds } from '../../config/settings-loader';
import { filterIrrelevantPosts } from '../../validators/brand-relevance';
import { shouldKeepComment } from '../../analysis/comments';
import { needsTranslation } from '../../analysis/lang-detect';
import { launchAndVerify, LABEL } from './twitter-browser';

// Fallbacks for direct-CLI invocation before settings.thresholds.scrapeLimits.twitterSearch
// loads — the live run path (runTwitterSearchAllBrands) always passes the settings values.
const DEFAULT_MAX_TWEETS_PER_KEYWORD = parseInt(process.env.TWITTER_MAX_PER_KEYWORD ?? '40', 10);
const DEFAULT_SCROLL_ROUNDS = parseInt(process.env.TWITTER_SCROLL_ROUNDS ?? '15', 10);
const SCROLL_WAIT_MS = 2_500;
// X rate-limits/soft-blocks search much faster than TikTok does. TikTok's
// scraper already waits 60s between brands (tiktok-search.ts) — we had NO
// pause at all between keywords or brands here, which is the most likely
// cause of "0 results" runs (X silently starts serving empty/stale timelines
// once it decides the session is scraping too fast). Mirror TikTok's cooldown.
export const KEYWORD_DELAY_MS = parseInt(process.env.TWITTER_KEYWORD_DELAY_MS ?? '8000', 10);
// Bumped 45s -> 10min (2026-07-21): re-opening X search to Gentle Colors
// (docs/scope-x-campaigns.md decision 10 was MizuMi-only after 429s/an abort)
// hit one 429 near the end of Gentle Colors' keyword list on the very first
// run back. A real cooldown between brands — not just between keywords —
// gives X's per-session throttle more room to reset before the next brand's
// batch starts hammering it.
const BRAND_DELAY_MS = parseInt(process.env.TWITTER_BRAND_DELAY_MS ?? '600000', 10);
// Extra cooldown tacked on top of KEYWORD_DELAY_MS after a 429 — the normal
// gap clearly wasn't enough, so wait longer before hitting X again.
const RATE_LIMIT_BACKOFF_MS = parseInt(process.env.TWITTER_RATE_LIMIT_BACKOFF_MS ?? '90000', 10);
// Abort the whole run after this many 429s in a row — keeps retrying into an
// active block only risks a longer/harder ban on the session.
const RATE_LIMIT_ABORT_THRESHOLD = parseInt(process.env.TWITTER_RATE_LIMIT_ABORT_THRESHOLD ?? '3', 10);

/** Thrown to unwind out of a run once the user requests a stop. */
export class ScrapeCancelledError extends Error {
  constructor() {
    super('Scrape cancelled by user');
    this.name = 'ScrapeCancelledError';
  }
}

/** Thrown when X 429s us too many times in a row — run aborts rather than digging the session into a deeper block. */
export class RateLimitedError extends Error {
  constructor(consecutiveHits: number) {
    super(`X rate-limited (429) ${consecutiveHits}x in a row — aborting run`);
    this.name = 'RateLimitedError';
  }
}

type ShouldCancel = () => boolean;

/** Cancellable sleep — checks `shouldCancel` every second instead of blocking the full duration. */
async function cancellableSleep(ms: number, shouldCancel?: ShouldCancel): Promise<void> {
  const step = 1_000;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldCancel?.()) throw new ScrapeCancelledError();
    const chunk = Math.min(step, ms - elapsed);
    await new Promise((r) => setTimeout(r, chunk));
    elapsed += chunk;
  }
}

// Mentions-tab filter: which of these four this tweet is. Priority mirrors
// originalPostUrl below — a tweet can only be one of reply/quote/retweet at
// once (X doesn't allow combining them), 'original' otherwise.
export type TweetType = 'original' | 'reply' | 'quote' | 'retweet';

export interface Tweet {
  id: string;
  content: string;
  author: string;
  authorName: string | null;
  authorFollowers: number | null;
  likes: number;
  retweets: number;
  replies: number;
  views: number | null;
  lang: string | null;
  createdAt: string | null;
  url: string;
  /** Reply target > quoted tweet > retweeted-of, whichever this tweet has. Null for a plain original tweet. */
  originalPostUrl: string | null;
  /** True for a plain retweet (no added commentary) — same content as the original, just reshared. */
  isRetweet: boolean;
  tweetType: TweetType;
}

// ── Response parser ──────────────────────────────────────────────────────────
// X's SearchTimeline GraphQL returns a deeply-nested envelope. Walk it looking
// for entries of type "TimelineTimelineItem" whose item content wraps a tweet.
// Extract only fields we store; ignore ads / who-to-follow / other module rows.
function parseSearchTimeline(body: unknown, out: Map<string, Tweet>): void {
  const stack: unknown[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;

    // A tweet result node has itemContent.tweet_results.result.legacy — read it.
    const inner = ((o.itemContent as Record<string, unknown> | undefined)?.tweet_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
    if (inner) {
      const legacy = inner.legacy as Record<string, unknown> | undefined;
      const core   = inner.core   as Record<string, unknown> | undefined;
      const userResult = ((core?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined);
      const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;
      // X moved name/screen_name out of `legacy` into a `core` sub-object on the
      // user result (followers_count etc. are still under legacy) — prefer the
      // new path, fall back to legacy in case X reverts or serves both.
      const userCore = userResult?.core as Record<string, unknown> | undefined;
      const id = String((inner.rest_id ?? legacy?.id_str ?? '') as string | number);
      if (id && legacy) {
        const author = String(((userCore?.screen_name ?? userLegacy?.screen_name) ?? '') as string);
        // Retweets truncate the RT'd text with "RT @user: <cut>". Pull the
        // original tweet's full_text instead so matchBrandSlug can see the
        // brand mention that lived in the source body.
        const rtStatus = (legacy.retweeted_status_result as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
        const rtLegacy = rtStatus?.legacy as Record<string, unknown> | undefined;
        const rtText = rtLegacy?.full_text as string | undefined;
        // Quote-tweet: the quoted tweet's text lives under quoted_status_result.
        const qStatus = (inner.quoted_status_result as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
        const qLegacy = qStatus?.legacy as Record<string, unknown> | undefined;
        const qText = qLegacy?.full_text as string | undefined;

        const primary = String(legacy.full_text ?? '');
        // Concatenate — matchBrandSlug scans the whole blob, sentiment classifier
        // only needs 500 chars anyway.
        const content = [primary, rtText, qText].filter(Boolean).join(' \n ');

        // Link to whatever this tweet is "about": a reply's parent, else the
        // quoted tweet, else the retweeted-of original. Only one can apply
        // per tweet (X doesn't let you quote AND reply in the same tweet).
        // tweetType mirrors the same priority, for the Mentions-tab filter.
        let originalPostUrl: string | null = null;
        let tweetType: TweetType = 'original';
        const replyToId = legacy.in_reply_to_status_id_str as string | undefined;
        const replyToUser = legacy.in_reply_to_screen_name as string | undefined;
        if (replyToId && replyToUser) {
          originalPostUrl = `https://x.com/${replyToUser}/status/${replyToId}`;
          tweetType = 'reply';
        } else if (qStatus) {
          const qId = String((qStatus.rest_id ?? qLegacy?.id_str ?? '') as string | number);
          const qUserResult = ((qStatus.core as Record<string, unknown> | undefined)?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
          const qAuthor = (qUserResult?.core as Record<string, unknown> | undefined)?.screen_name
            ?? (qUserResult?.legacy as Record<string, unknown> | undefined)?.screen_name;
          if (qId && qAuthor) { originalPostUrl = `https://x.com/${qAuthor}/status/${qId}`; tweetType = 'quote'; }
        } else if (rtStatus) {
          const rtId = String((rtStatus.rest_id ?? rtLegacy?.id_str ?? '') as string | number);
          const rtUserResult = ((rtStatus.core as Record<string, unknown> | undefined)?.user_results as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
          const rtAuthor = (rtUserResult?.core as Record<string, unknown> | undefined)?.screen_name
            ?? (rtUserResult?.legacy as Record<string, unknown> | undefined)?.screen_name;
          if (rtId && rtAuthor) { originalPostUrl = `https://x.com/${rtAuthor}/status/${rtId}`; tweetType = 'retweet'; }
        }

        out.set(id, {
          id,
          content,
          author,
          authorName: ((userCore?.name ?? userLegacy?.name) as string | undefined) ?? null,
          authorFollowers: (userLegacy?.followers_count as number | undefined) ?? null,
          likes: Number(legacy.favorite_count ?? 0),
          retweets: Number(legacy.retweet_count ?? 0),
          replies: Number(legacy.reply_count ?? 0),
          views: Number((inner.views as Record<string, unknown> | undefined)?.count ?? 0) || null,
          lang: (legacy.lang as string | undefined) ?? null,
          createdAt: (legacy.created_at as string | undefined) ?? null,
          url: `https://x.com/${author}/status/${id}`,
          originalPostUrl,
          isRetweet: !!rtStatus,
          tweetType,
        });
      }
    }

    // Recurse into array/object children so we find every entry regardless of
    // whether X wraps the timeline in "instructions" / "entries" / "moduleItems".
    for (const key of Object.keys(o)) stack.push(o[key]);
  }
}

// ── Search one keyword ───────────────────────────────────────────────────────
export async function searchKeyword(ctx: BrowserContext, keyword: string, sinceDays: number, lang: string | null, shouldCancel?: ShouldCancel, maxTweets = DEFAULT_MAX_TWEETS_PER_KEYWORD, scrollRounds = DEFAULT_SCROLL_ROUNDS): Promise<{ tweets: Tweet[]; rateLimited: boolean }> {
  const page: Page = await ctx.newPage();
  const collected = new Map<string, Tweet>();
  // X returns 429 on ANY /i/api/ call once it decides the session is over
  // the limit (we saw it on the unrelated `fleetline` background XHR too —
  // this is a session-wide throttle, not a per-endpoint one). A silently
  // empty SearchTimeline response looks identical to "no matches" unless we
  // watch for the 429 explicitly.
  let rateLimited = false;

  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!url.includes('/i/api/')) return;
    if (resp.status() === 429) {
      rateLimited = true;
      return;
    }
    if (!url.includes('/i/api/graphql/') || !url.includes('SearchTimeline')) return;
    if (!resp.ok()) return;
    try {
      const json = await resp.json() as unknown;
      const before = collected.size;
      parseSearchTimeline(json, collected);
      const gained = collected.size - before;
      if (gained > 0 && process.env.TWITTER_DEBUG === '1') {
        console.log(`${LABEL}   [xhr] +${gained} tweets from ${url.split('?')[0]}`);
      }
    } catch { /* ignore non-json */ }
  };
  page.on('response', onResponse);

  try {
    let q = keyword;
    if (lang) q += ` lang:${lang}`;
    if (sinceDays > 0) {
      const since = new Date(Date.now() - sinceDays * 86_400_000);
      q += ` since:${since.toISOString().slice(0, 10)}`;
    }
    // f=live sorts by recency (Latest tab). Top tab is Ads + engagement-weighted.
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
    console.log(`${LABEL} Searching: ${q}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(3_000);

    // Scroll until stale, rate-limited, or we hit the per-keyword cap.
    let stale = 0;
    for (let i = 0; i < scrollRounds && collected.size < maxTweets; i++) {
      if (shouldCancel?.()) throw new ScrapeCancelledError();
      if (rateLimited) break; // no point scrolling further — X won't serve more
      const before = collected.size;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(SCROLL_WAIT_MS);
      if (collected.size === before) {
        if (++stale >= 3) break;
      } else {
        stale = 0;
      }
    }
    if (rateLimited) {
      console.warn(`${LABEL}   "${keyword}": 429 rate-limited by X — ${collected.size} tweets kept before throttle hit`);
    } else {
      console.log(`${LABEL}   "${keyword}": ${collected.size} tweets scraped`);
    }
  } finally {
    page.off('response', onResponse);
    await page.close();
  }

  return { tweets: Array.from(collected.values()).slice(0, maxTweets), rateLimited };
}

// ── Brand-id cache ───────────────────────────────────────────────────────────
async function loadBrandIds(): Promise<Map<string, number>> {
  const rows = await query<{ id: number; slug: string }>(
    `SELECT id, slug FROM brands WHERE type = 'own'`,
  );
  return new Map(rows.map((r) => [r.slug, r.id]));
}

// Own-brand-only, matching loadBrandIds()'s scope (X search is intentionally
// MizuMi/Gentle Colors/Bomi-only per docs/scope-x-campaigns.md decision 10 —
// competitor coverage on X isn't part of this). Uses live Settings keywords
// (getTwitterSearchTargets()) rather than the static keywords.ts dict, same
// fix as tiktok-search.ts's category branch.
async function loadOwnBrandCandidates(): Promise<BrandMatchCandidate[]> {
  const [rows, targets] = await Promise.all([
    query<{ id: number; slug: string; name: string }>(`SELECT id, slug, name FROM brands WHERE type = 'own'`),
    getTwitterSearchTargets(),
  ]);
  const keywordsBySlug = new Map(targets.map((t) => [t.brandSlug, t.keywords]));
  return rows.map((r) => ({ slug: r.slug, type: 'own' as const, name: r.name, keywords: keywordsBySlug.get(r.slug) }));
}

// ── Upsert ───────────────────────────────────────────────────────────────────
async function upsertTweet(tweet: Tweet, brandId: number): Promise<'inserted' | 'updated' | 'skipped'> {
  // allowMentionOnly: true — this is a top-level UGC tweet discovered by brand
  // keyword search, not a reply. Content that's just "@ourbrand 😍" is exactly
  // the direct brand-tag engagement this scraper exists to catch, not a
  // notification ping to a friend (see isMentionOnly's doc comment).
  if (!shouldKeepComment(tweet.content, { allowMentionOnly: true })) return 'skipped';
  const res = await pool.query<{ inserted: boolean }>(
    `INSERT INTO social_comments
       (brand_id, platform, external_id, content, published_at, post_id, likes_count, author_name, views_count, retweets_count, reply_count, author_followers, content_translated, source_type, original_post_url, tweet_type)
     VALUES ($1, 'twitter', $2, $3, $4, $2, $5, $6, $7, $8, $9, $10, $11, 'search', $12, $13)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       likes_count        = EXCLUDED.likes_count,
       views_count        = EXCLUDED.views_count,
       retweets_count     = EXCLUDED.retweets_count,
       reply_count        = EXCLUDED.reply_count,
       author_followers   = EXCLUDED.author_followers,
       author_name        = EXCLUDED.author_name,
       original_post_url  = EXCLUDED.original_post_url,
       tweet_type         = EXCLUDED.tweet_type
     RETURNING (xmax = 0) AS inserted`,
    [
      brandId,
      tweet.id,
      tweet.content,
      tweet.createdAt ? new Date(tweet.createdAt) : null,
      tweet.likes ?? 0,
      // author_name renders as "@{value}" in the UI — store the handle
      // (screen_name), not the display name. Display name (tweet.authorName)
      // isn't persisted separately today.
      tweet.author || tweet.authorName,
      tweet.views,
      tweet.retweets,
      tweet.replies,
      tweet.authorFollowers,
      needsTranslation(tweet.content) ? null : '',
      tweet.originalPostUrl,
      tweet.tweetType,
    ],
  );
  return res.rows[0]?.inserted ? 'inserted' : 'updated';
}

// ── Verifier ─────────────────────────────────────────────────────────────────
async function verifyRelevant(tweets: Tweet[], brandSlug: string, brandName: string): Promise<Set<string>> {
  if (tweets.length === 0) return new Set();
  return filterIrrelevantPosts(
    tweets.map((t) => ({ id: t.id, text: t.content })),
    brandName, brandSlug,
  );
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function searchTwitterKeyword(
  keyword: string,
  opts: { sinceDays?: number; lang?: string; ctx?: BrowserContext; shouldCancel?: ShouldCancel; maxTweets?: number; scrollRounds?: number } = {},
): Promise<{ totalHits: number; kept: number; dropped: number; rateLimited: boolean }> {
  const sinceDays = opts.sinceDays ?? parseInt(process.env.TWITTER_SINCE_DAYS ?? '7', 10);
  const lang = opts.lang ?? ((process.env.TWITTER_LANG || 'th') || null);

  const ownCtx = opts.ctx ?? await launchAndVerify();
  try {
    const { tweets, rateLimited } = await searchKeyword(ownCtx, keyword, sinceDays, lang, opts.shouldCancel, opts.maxTweets, opts.scrollRounds);
    if (tweets.length === 0) return { totalHits: 0, kept: 0, dropped: 0, rateLimited };

    const brandIds = await loadBrandIds();
    const brandCandidates = await loadOwnBrandCandidates();
    const ownHandles = await getTwitterOwnHandles();
    const byBrand = new Map<string, Tweet[]>();
    let unmatched = 0;
    let ownAuthor = 0;
    for (const t of tweets) {
      // Skip tweets authored by our own brand accounts — feed scraper would
      // otherwise double-count them, and Marketing wants only UGC from third
      // parties on this platform (X has no separate "feed" scraper yet).
      if (ownHandles.has(t.author.toLowerCase())) {
        ownAuthor++;
        continue;
      }
      const slug = matchBrandSlug(t.content, brandCandidates);
      if (!slug || !brandIds.has(slug)) {
        unmatched++;
        if (process.env.TWITTER_DEBUG === '1') {
          console.log(`${LABEL}   [drop:no-brand] ${t.url} — ${t.content.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
        continue;
      }
      let bucket = byBrand.get(slug);
      if (!bucket) { bucket = []; byBrand.set(slug, bucket); }
      bucket.push(t);
    }
    if (ownAuthor > 0) {
      console.log(`${LABEL}   pre-verify: ${ownAuthor} dropped (own brand handle)`);
    }
    if (unmatched > 0 && process.env.TWITTER_DEBUG !== '1') {
      console.log(`${LABEL}   pre-verify: ${unmatched}/${tweets.length} dropped (no brand match — set TWITTER_DEBUG=1 to see content)`);
    }

    let kept = 0;
    for (const [slug, bucket] of byBrand) {
      const brandName = slug; // slug doubles as display name for the verifier prompt
      const okIds = await verifyRelevant(bucket, slug, brandName);
      console.log(`${LABEL} [verify] "${brandName}": ${okIds.size}/${bucket.length} kept`);
      for (const t of bucket) {
        if (!okIds.has(t.id)) continue;
        const r = await upsertTweet(t, brandIds.get(slug)!);
        if (r === 'inserted' || r === 'updated') kept++;
      }
    }
    const dropped = tweets.length - kept;
    console.log(`${LABEL} "${keyword}": kept=${kept} dropped=${dropped}`);
    return { totalHits: tweets.length, kept, dropped, rateLimited };
  } finally {
    if (!opts.ctx) await ownCtx.close(); // only close if we owned the context
  }
}

/** Full cron run: iterate every brand × keyword from live Settings under one browser context. */
export async function runTwitterSearchAllBrands(shouldCancel?: ShouldCancel): Promise<{ total: number; rateLimitedKeywords: string[] }> {
  const targets = await getTwitterSearchTargets();
  const limits = (await getThresholds().catch(() => null))?.scrapeLimits.twitterSearch;
  const ctx = await launchAndVerify();
  let total = 0;
  const rateLimitedKeywords: string[] = [];
  let consecutiveRateLimits = 0;
  try {
    for (const [brandIdx, { brandSlug, keywords }] of targets.entries()) {
      for (const [kwIdx, kw] of keywords.entries()) {
        if (shouldCancel?.()) throw new ScrapeCancelledError();
        let hitRateLimit = false;
        try {
          const r = await searchTwitterKeyword(kw, { ctx, shouldCancel, maxTweets: limits?.maxPosts, scrollRounds: limits?.maxScrolls });
          total += r.kept;
          hitRateLimit = r.rateLimited;
        } catch (err) {
          if (err instanceof ScrapeCancelledError) throw err;
          console.error(`${LABEL} "${kw}" failed:`, err instanceof Error ? err.message : err);
        }

        if (hitRateLimit) {
          rateLimitedKeywords.push(kw);
          consecutiveRateLimits++;
          if (consecutiveRateLimits >= RATE_LIMIT_ABORT_THRESHOLD) {
            throw new RateLimitedError(consecutiveRateLimits);
          }
          console.warn(`${LABEL} rate-limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s before next keyword`);
          await cancellableSleep(RATE_LIMIT_BACKOFF_MS, shouldCancel);
        } else {
          consecutiveRateLimits = 0;
        }

        // Cooldown between keywords — hitting search back-to-back is the
        // likeliest reason X starts returning empty timelines mid-run.
        if (kwIdx < keywords.length - 1) await cancellableSleep(KEYWORD_DELAY_MS, shouldCancel);
      }
      if (brandIdx < targets.length - 1) {
        console.log(`${LABEL} [${brandSlug}] done — waiting ${BRAND_DELAY_MS / 1000}s before next brand...`);
        await cancellableSleep(BRAND_DELAY_MS, shouldCancel);
      }
    }
  } finally {
    await ctx.close();
  }
  if (rateLimitedKeywords.length > 0) {
    console.warn(`${LABEL} done — total upserted: ${total} — rate-limited on ${rateLimitedKeywords.length} keyword(s): ${rateLimitedKeywords.join(', ')}`);
  } else {
    console.log(`${LABEL} done — total upserted: ${total}`);
  }
  return { total, rateLimitedKeywords };
}

/**
 * Cheap session-status helper for /admin + /settings UI.
 *
 * We CANNOT launch Chrome here — the login flow holds an exclusive lock on
 * the profile dir, so racing another launchPersistentContext() would abort the
 * login window. Instead we probe the on-disk Cookies sqlite (Chrome 122+
 * stores it at `<profile>/Default/Network/Cookies`; older Chrome used
 * `<profile>/Default/Cookies`). Fresh mtime = user is likely still logged in.
 * If the caller sees `valid=false` but the file exists, run a scrape — the
 * scraper's launchAndVerify catches an actual bad session at run time.
 */
export async function getTwitterSessionStatus(): Promise<{ valid: boolean; profileDir: string; checkedAt: string; hint?: string }> {
  const fs = await import('fs');
  const path = await import('path');
  const { TWITTER_PROFILE_DIR } = await import('./twitter-browser');
  const now = new Date().toISOString();

  const candidates = [
    path.join(TWITTER_PROFILE_DIR, 'Default', 'Network', 'Cookies'),
    path.join(TWITTER_PROFILE_DIR, 'Default', 'Cookies'),
  ];

  try {
    if (!fs.existsSync(TWITTER_PROFILE_DIR)) {
      return { valid: false, profileDir: TWITTER_PROFILE_DIR, checkedAt: now, hint: 'Profile not initialised — click Log in to X.' };
    }
    const cookieFile = candidates.find((p) => fs.existsSync(p));
    if (!cookieFile) {
      return { valid: false, profileDir: TWITTER_PROFILE_DIR, checkedAt: now, hint: 'No Cookies sqlite yet — click Log in to X.' };
    }
    const stat = fs.statSync(cookieFile);
    const ageDays = (Date.now() - stat.mtimeMs) / (24 * 3_600_000);
    if (ageDays > 30) {
      return { valid: false, profileDir: TWITTER_PROFILE_DIR, checkedAt: now, hint: `Cookies last touched ${Math.round(ageDays)}d ago — re-login likely required.` };
    }
    return { valid: true, profileDir: TWITTER_PROFILE_DIR, checkedAt: now, hint: `Cookies file last written ${Math.round(ageDays * 24 * 60) / 60}h ago.` };
  } catch (err) {
    return { valid: false, profileDir: TWITTER_PROFILE_DIR, checkedAt: now, hint: err instanceof Error ? err.message : String(err) };
  }
}

if (require.main === module) {
  runTwitterSearchAllBrands()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
