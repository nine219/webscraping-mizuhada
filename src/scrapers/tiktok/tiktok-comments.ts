import { BrowserContext } from 'playwright';
import { socialPool as pool, socialQuery as query } from '../../db/social-client';
import { TIKTOK_ACCOUNTS } from './tiktok-feed';
import { solveTikTokCaptcha } from './tiktok-captcha';
import { launchContext, warmUp } from './tiktok-browser';
import { shouldKeepComment, isEmojiOnly as isEmojiOnlyImpl } from '../../analysis/comments';
import { needsTranslation } from '../../analysis/lang-detect';


// ── TikTok comment API shapes ─────────────────────────────────────────────────
interface TikTokCommentItem {
  cid: string;
  text: string;
  author?: { unique_id?: string; nickname?: string };
  digg_count: number;
  reply_comment_total?: number;
  create_time: number;
  reply_id?: string;
}


// ── Fetch comments via direct API call from page context ─────────────────────
// Runs inside the browser page so cookies are automatically included.
// TikTok paginates with cursor; we collect up to MAX_PAGES pages.
async function fetchCommentsViaApi(
  page: import('playwright').Page,
  postId: string,
  maxPages = 30,
  startCursor = 0,
): Promise<TikTokCommentItem[]> {
  const all: TikTokCommentItem[] = [];
  let cursor = startCursor;

  for (let i = 0; i < maxPages; i++) {
    const result = await page.evaluate(
      async ({ awemeId, cur }: { awemeId: string; cur: number }) => {
        // Extract msToken from cookies — required in query params by TikTok API
        const msToken = document.cookie.split(';')
          .find((c) => c.trim().startsWith('msToken='))
          ?.split('=').slice(1).join('=').trim() ?? '';

        // webid persists in localStorage or can be extracted from TikTok's app context
        const webId = (window as unknown as Record<string, unknown>).__tea_app_webid as string | undefined
          ?? '';

        const params = new URLSearchParams({
          aweme_id:         awemeId,
          cursor:           String(cur),
          count:            '20',
          digged_cid:       '',
          insert_ids:       '',
          white_list_type:  '0',
          support_h265:     '0',
          is_preloading:    '0',
          current_region:   'TH',
          msToken,
          ...(webId ? { webid: webId } : {}),
        });
        try {
          // Use relative URL so Referer = current page URL (required by TikTok CSRF)
          const resp = await fetch(`/api/comment/list/?${params}`, {
            credentials: 'include',
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              Accept: 'application/json, text/plain, */*',
            },
          });
          if (!resp.ok) return { error: resp.status, comments: [], has_more: 0, cursor: 0, status_code: resp.status };
          return await resp.json();
        } catch (e) {
          return { error: String(e), comments: [], has_more: 0, cursor: 0, status_code: -1 };
        }
      },
      { awemeId: postId, cur: cursor },
    ) as { comments?: TikTokCommentItem[]; has_more?: number; cursor?: number; status_code?: number; error?: unknown };

    const comments  = result.comments ?? [];
    const hasMore   = result.has_more ?? 0;
    const nextCursor = result.cursor ?? 0;
    const status    = result.status_code ?? 0;

    if (i === 0) {
      console.log(`    [api] status=${status} count=${comments.length} has_more=${hasMore}`);
    }

    for (const c of comments) {
      if (c?.cid) all.push(c);
    }

    if (!hasMore || comments.length === 0) break;
    cursor = nextCursor;
    await new Promise((r) => setTimeout(r, 800));
  }

  return all;
}

// ── Extract fresh post stats from an OPEN page ────────────────────────────────
// Reuses the already-navigated comment-scrape page so we don't reopen the URL
// (which retriggers CAPTCHA). Pulls from __UNIVERSAL_DATA_FOR_REHYDRATION__ first
// (no signing needed), then falls back to /api/item/detail/.
// item_list (feed) commentCount is often stale; item/detail is authoritative.
async function extractStatsFromPage(
  page: import('playwright').Page,
  postId: string,
): Promise<{ views: number; likes: number; shares: number; comments: number } | null> {
  try {
    // Strategy 1: extract from SIGI_STATE / UNIVERSAL_DATA in initial HTML (no signing needed)
    const fromHtml = await page.evaluate((id: string) => {
      // Walk JSON tree looking for a node that pairs `id === postId` with a `stats` object.
      // Fall back to ANY stats object with playCount+commentCount keys if id-match fails
      // (TikTok sometimes splits id and stats across siblings).
      let idMatched: Record<string, number> | null = null;
      let anyStats: Record<string, number> | null = null;
      const walk = (obj: unknown, depth: number): void => {
        if (depth > 30 || !obj || typeof obj !== 'object') return;
        const o = obj as Record<string, unknown>;
        const s = o.stats;
        if (s && typeof s === 'object') {
          const sObj = s as Record<string, number>;
          if (typeof sObj.playCount === 'number' && typeof sObj.commentCount === 'number') {
            if (o.id === id || o.aweme_id === id) {
              idMatched = sObj;
            } else if (!anyStats) {
              anyStats = sObj;
            }
          }
        }
        if (idMatched) return;
        for (const k of Object.keys(o)) walk(o[k], depth + 1);
      };
      const scripts = [
        document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__'),
        document.getElementById('SIGI_STATE'),
        document.getElementById('__NEXT_DATA__'),
      ].filter(Boolean) as HTMLElement[];
      let usedSource = '';
      for (const sc of scripts) {
        try {
          const data = JSON.parse(sc.textContent ?? '{}');
          walk(data, 0);
          if (idMatched || anyStats) { usedSource = sc.id; break; }
        } catch { /* ignore */ }
      }
      const picked: Record<string, number> | null = idMatched ?? anyStats;
      return picked ? { source: usedSource, stats: picked, matched: !!idMatched } : null;
    }, postId);

    if (fromHtml) {
      const s = fromHtml.stats as Record<string, number>;
      console.log(`    [stats:html] from=${fromHtml.source} matched=${fromHtml.matched} play=${s.playCount} digg=${s.diggCount} share=${s.shareCount} comment=${s.commentCount}`);
      return {
        views:    s.playCount    ?? 0,
        likes:    s.diggCount    ?? 0,
        shares:   s.shareCount   ?? 0,
        comments: s.commentCount ?? 0,
      };
    }
    console.log(`    [stats:html] no stats found in HTML scripts`);

    // Strategy 2: fall back to direct /api/item/detail/ fetch
    const stats = await page.evaluate(async (id: string) => {
      const params = new URLSearchParams({ itemId: id, aweme_id: id });
      try {
        const resp = await fetch(`/api/item/detail/?${params}`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
        });
        const text = await resp.text();
        if (!resp.ok) return { error: `status=${resp.status}`, text: text.slice(0, 200) };
        const body = JSON.parse(text) as Record<string, unknown>;
        const itemStruct = (body?.itemInfo as Record<string, unknown>)?.itemStruct as Record<string, unknown> | undefined;
        const s = itemStruct?.stats as Record<string, number> | undefined;
        if (!s) return { error: 'no-stats', keys: Object.keys(body).slice(0, 10) };
        return {
          ok: true as const,
          views:    s.playCount    ?? 0,
          likes:    s.diggCount    ?? 0,
          shares:   s.shareCount   ?? 0,
          comments: s.commentCount ?? 0,
        };
      } catch (e) { return { error: String(e) }; }
    }, postId);

    if (stats && 'ok' in stats) {
      const s = stats as { views: number; likes: number; shares: number; comments: number };
      console.log(`    [stats:api] play=${s.views} digg=${s.likes} share=${s.shares} comment=${s.comments}`);
      return { views: s.views, likes: s.likes, shares: s.shares, comments: s.comments };
    }
    console.log(`    [stats:api] failed: ${JSON.stringify(stats)}`);
    return null;
  } catch (err) {
    console.log(`    [stats] extraction error: ${err}`);
    return null;
  }
}

// ── Scrape comments for one post ──────────────────────────────────────────────
export async function scrapePostComments(
  ctx: BrowserContext,
  handle: string,
  postId: string,
): Promise<{
  comments: TikTokCommentItem[];
  stats: { views: number; likes: number; shares: number; comments: number } | null;
  // True unless at least one /api/comment/list/ response came back with status_code=0
  // (a genuine, unblocked answer — even an empty one). stats is populated straight from
  // page HTML (UNIVERSAL_DATA) and loads fine even when the comment API itself is
  // CAPTCHA-blocked (status_code=5), so it CANNOT be used as the "did we actually get
  // comments" signal — this flag is the real one. See findTargetPosts gate.
  blocked: boolean;
}> {
  const page = await ctx.newPage();
  const debug = process.env.COMMENT_DEBUG === '1';
  const collected = new Map<string, TikTokCommentItem>();

  // Network-based CAPTCHA signal — re-armable flag (captcha can appear mid-pagination)
  let captchaNetworkFlag = false;
  let captchaNetworkTrigger: (() => void) | null = null;
  const captchaNetworkPromise = new Promise<void>((res) => { captchaNetworkTrigger = res; });

  // Cursor tracking for API-based pagination after first page
  let latestCursor = 0;
  let latestHasMore = false;

  // Set true the moment any /api/comment/list/ response (UI-triggered or the direct-fetch
  // fallback — both flow through this listener since it's a real browser fetch) comes back
  // with status_code=0. That's TikTok actually answering, as opposed to status_code=5
  // (CAPTCHA-blocked) which never flips this — a post can genuinely have 0 comments and
  // still get a valid status_code=0 response.
  let gotValidResponse = false;

  // Intercept all responses — comment/list + CAPTCHA network detection
  page.on('response', async (resp) => {
    const url = resp.url();

    // CAPTCHA network detection: TikTok fetches captcha config/images from these paths
    if (
      url.includes('/captcha/') ||
      url.includes('secsdk-captcha') ||
      url.includes('verify.snssdk.com') ||
      (url.includes('tiktok.com') && url.includes('/verify/'))
    ) {
      console.log(`    [captcha:net] ${url.slice(0, 120)}`);
      captchaNetworkFlag = true;
      captchaNetworkTrigger?.();
      return;
    }

    if (!url.includes('/api/comment/list/')) return;
    try {
      const body = await resp.json() as Record<string, unknown>;
      const comments = (body.comments as TikTokCommentItem[] | undefined) ?? [];
      const status   = (body.status_code as number) ?? 0;
      latestCursor  = (body.cursor as number) ?? 0;
      latestHasMore = (body.has_more as number) === 1;
      if (status === 0) gotValidResponse = true;
      console.log(`    [comment/list] status=${status} count=${comments.length} has_more=${latestHasMore} cursor=${latestCursor}`);
      for (const c of comments) {
        if (c?.cid) collected.set(c.cid, c);
      }
    } catch { /* ignore */ }
  });

  try {
    await page.goto(`https://www.tiktok.com/@${handle}/video/${postId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const currentUrl = page.url();
    if (
      currentUrl.includes('/login') ||
      currentUrl.includes('loginType') ||
      currentUrl.includes('/verify/captcha') ||
      currentUrl.includes('scene=crawler')
    ) {
      console.warn(`  [BLOCKED] ${currentUrl}`);
      if (debug) await page.screenshot({ path: `debug-blocked-${postId}.png` });
      return { comments: [], stats: null, blocked: true };
    }

    // Shared CAPTCHA selector (same as tiktok-captcha.ts SEL.container)
    const CAPTCHA_SEL = '#captcha_container, [class*="captcha-verify-container"], [id*="captcha-verify"], [class*="secsdk-captcha"]';

    // Helper: dump DOM captcha elements + solve if any are visible
    const trySolveCaptcha = async (label: string) => {
      // Log every element matching captcha patterns so we can diagnose selector misses
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[id*="captcha"],[class*="captcha"],[id*="verify"],[class*="verify"]'))
          .map((el) => `${el.tagName}#${el.id}.${[...el.classList].join('.')}`)
          .filter((s) => s.length > 5)
          .slice(0, 10)
      ).catch(() => [] as string[]);
      console.log(`    [captcha:${label}] DOM matches (${found.length}): ${found.join(' | ') || 'none'}`);

      const visible = await page.locator(CAPTCHA_SEL).first().isVisible({ timeout: 1500 }).catch(() => false);
      console.log(`    [captcha:${label}] CAPTCHA_SEL visible=${visible}`);
      if (!visible) return;

      const solved = await solveTikTokCaptcha(page);
      console.log(`    [captcha:${label}] solved=${solved}`);
      if (solved) {
        await page.waitForResponse(
          (r) => r.url().includes('/api/comment/list/'),
          { timeout: 12000 },
        ).catch(() => {});
      }
    };

    // Solve CAPTCHA if it appeared on page load (before comment icon exists)
    await trySolveCaptcha('page-load');

    // Helper: click the "ความคิดเห็น" (comments) tab using multiple strategies.
    // TikTok's right panel now defaults to "คุณอาจจะชอบ" (recommendations) tab.
    const switchToCommentsTab = async (label: string): Promise<void> => {
      // Strategy 1: Playwright selectors
      for (const sel of [
        '[data-e2e="comment-tab"]',
        ':text-is("ความคิดเห็น")',
        ':text("ความคิดเห็น")',
        'button:has-text("ความคิดเห็น")',
        '[class*="CommentTab"]',
        'span:has-text("ความคิดเห็น")',
        'div:has-text("ความคิดเห็น"):not(:has(div))',
      ]) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 600 })) {
            await el.click({ timeout: 1500 });
            console.log(`    [tab:${label}] clicked via "${sel}"`);
            await page.waitForTimeout(700);
            return;
          }
        } catch { /* try next */ }
      }
      // Strategy 2: JS evaluate — walks DOM for leaf element whose text starts with "ความคิดเห็น"
      const clicked = await page.evaluate(() => {
        const walk = (el: Element): boolean => {
          if (!(el as HTMLElement).offsetParent) return false;
          const text = el.childNodes.length <= 2
            ? (el as HTMLElement).textContent?.trim() ?? '' : '';
          if (text.startsWith('ความคิดเห็น')) {
            (el as HTMLElement).click(); return true;
          }
          for (const child of el.children) if (walk(child)) return true;
          return false;
        };
        return walk(document.body);
      }).catch(() => false);
      if (clicked) {
        console.log(`    [tab:${label}] clicked via JS evaluate`);
        await page.waitForTimeout(700);
      } else {
        console.log(`    [tab:${label}] no clickable element found`);
      }
    };

    // Step 1: click the comment icon to trigger panel open + API load
    await page.waitForSelector('[data-e2e="comment-icon"]', { timeout: 10000 }).catch(() => {});
    if (debug) await page.screenshot({ path: `debug-${postId}-pre.png` });
    try {
      const commentIcon = page.locator('[data-e2e="comment-icon"]').first();
      await commentIcon.scrollIntoViewIfNeeded({ timeout: 3000 });
      await commentIcon.click({ timeout: 3000 });
      console.log('    [click] comment-icon');
      await page.waitForTimeout(1200);
    } catch { /* icon not found — fall through */ }

    // Step 2: TikTok resets the right panel to "คุณอาจจะชอบ" (recommendations) after icon click.
    // ALWAYS navigate to the "ความคิดเห็น" (comments) tab unconditionally.
    await switchToCommentsTab('post-icon');
    await page.waitForTimeout(800);

    // Step 3: verify comments loaded; retry tab switch up to 2 more times if not
    for (let attempt = 0; attempt < 2; attempt++) {
      const hasComments = await page.locator('[data-e2e="comment-item"], [class*="DivCommentItem"]').first().isVisible({ timeout: 1200 }).catch(() => false);
      if (hasComments) break;
      console.log(`    [tab:retry-${attempt + 1}] comments not visible yet — retrying tab switch`);
      await page.waitForTimeout(1500);
      await switchToCommentsTab(`retry-${attempt + 1}`);
      await page.waitForTimeout(800);
    }

    if (debug) await page.screenshot({ path: `debug-${postId}-post.png` });

    // Race: VALID comment API response (status=0, count>0) vs CAPTCHA — first wins.
    // Ignoring status=5 blocked responses so CAPTCHA can still be detected in the same race.
    type RaceResult = 'comments' | 'captcha';
    const raceResult = await Promise.race<RaceResult>([
      page.waitForResponse(
        async (r) => {
          if (!r.url().includes('/api/comment/list/')) return false;
          try {
            const body = await r.json() as Record<string, unknown>;
            return (body.status_code as number) === 0 && Array.isArray(body.comments) && (body.comments as unknown[]).length > 0;
          } catch { return false; }
        },
        { timeout: 15000 },
      ).then((): RaceResult => 'comments'),
      page.waitForSelector(CAPTCHA_SEL, { state: 'visible', timeout: 15000 })
        .then((): RaceResult => 'captcha'),
      captchaNetworkPromise.then(async (): Promise<RaceResult> => {
        await page.waitForTimeout(800);
        return 'captcha';
      }),
    ]).catch((): RaceResult => 'captcha');

    console.log(`    [race] result=${raceResult}`);
    if (raceResult === 'captcha') {
      await trySolveCaptcha('post-click');
    }

    // Wait for response listener to finish processing first page
    await page.waitForTimeout(800);

    // Race may have resolved 'comments' on a CAPTCHA-blocked response (status=5 slipped through).
    // If so, CAPTCHA fires right after — handle it now before pagination.
    if (collected.size === 0 && captchaNetworkFlag) {
      captchaNetworkFlag = false;
      console.log(`    [captcha] post-race: got blocked response, CAPTCHA detected — solving`);
      await trySolveCaptcha('post-race');
      captchaNetworkFlag = false;
      await page.waitForTimeout(500);
    }

    if (collected.size === 0) {
      // First page never loaded (blocked/captcha) — try direct API from cursor 0
      console.log('    [pagination] first page empty — trying direct fetch from cursor 0');
      const fallback = await fetchCommentsViaApi(page, postId);
      const stats = await extractStatsFromPage(page, postId);
      return { comments: fallback, stats, blocked: !gotValidResponse };
    }

    console.log(`    [pagination] first page: ${collected.size} comments, has_more=${latestHasMore}, cursor=${latestCursor}`);

    if (latestHasMore) {
      // Pagination: programmatically scroll the comment list's actual scrollable ancestor.
      // Walking up from a comment item finds the real overflow-y:auto container even when
      // it sits below the viewport (mouse-wheel can't reach offscreen positions). scrollBy
      // fires native scroll events, which trigger TikTok's IntersectionObserver sentinel
      // and the in-page JS that signs /api/comment/list/ requests with X-Bogus.
      const MAX_SCROLL_ROUNDS = 40;
      let emptyRounds = 0;

      for (let round = 0; round < MAX_SCROLL_ROUNDS && latestHasMore; round++) {
        const prevSize = collected.size;

        const scrolled = await page.evaluate(() => {
          const item = document.querySelector(
            '[data-e2e="comment-item"], [data-e2e="comment-level-1"], [class*="DivCommentItem"], [class*="CommentItemContainer"]',
          );
          if (!item) return { ok: false, reason: 'no-item' as const };

          let el: HTMLElement | null = item as HTMLElement;
          while (el && el !== document.body) {
            const style = getComputedStyle(el);
            const oy = style.overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
              const before = el.scrollTop;
              el.scrollBy({ top: 1500, behavior: 'instant' as ScrollBehavior });
              el.dispatchEvent(new Event('scroll', { bubbles: true }));
              return { ok: true as const, before, after: el.scrollTop, max: el.scrollHeight - el.clientHeight };
            }
            el = el.parentElement;
          }
          return { ok: false, reason: 'no-scrollable' as const };
        });

        if (!scrolled.ok) {
          console.log(`    [scroll] round ${round + 1}: ${scrolled.reason} — stopping`);
          break;
        }

        await page.waitForTimeout(1600);

        if (collected.size === prevSize) {
          emptyRounds++;
          if (emptyRounds >= 3) {
            console.log(`    [scroll] no new after 3 empty rounds — stopping at ${collected.size}`);
            break;
          }
        } else {
          emptyRounds = 0;
          console.log(`    [scroll] round ${round + 1}: ${collected.size} (scrollTop ${scrolled.before}→${scrolled.after}/${scrolled.max})`);
        }
      }

      console.log(`    [pagination] total after scroll pagination: ${collected.size}`);
    }

    // Extract fresh stats from the SAME page before close (no extra navigation,
    // no extra CAPTCHA risk). UNIVERSAL_DATA was loaded with the page.
    const stats = await extractStatsFromPage(page, postId);

    return { comments: Array.from(collected.values()), stats, blocked: !gotValidResponse };
  } finally {
    await page.close();
  }
}

// ── Find posts needing comment scraping ───────────────────────────────────────
// Only feed posts (own-brand). Search/UGC posts get comments scraped inline by
// tiktok-search.ts immediately after upsert, using the correct UGC author handle.
interface PostRow { post_id: string; author_handle: string | null }

async function findTargetPosts(brandId: number, days: number, growthDelta: number): Promise<PostRow[]> {
  return query<PostRow>(
    `SELECT post_id, author_handle FROM tiktok_posts
     WHERE brand_id = $1
       AND source_type IN ('feed', 'profile')
       AND author_handle IS NOT NULL
       AND posted_at >= NOW() - INTERVAL '1 month'   -- hard cap: never scrape posts older than 1 month
       AND (
         -- INITIAL (never scraped): scrape EVERY own-brand post, full stop — no comment_count
         -- gate. comments_count is API metadata and known unreliable (can under-report as 0
         -- on a post that genuinely has comments), so gating the first attempt on it silently
         -- skipped real comments forever. Feed is only ~6 accounts so the load is small, and
         -- this backfills newly-discovered older posts too.
         comments_scraped_at IS NULL
         -- UPDATE (already scraped): re-scrape only when the comment metadata grew >= growthDelta
         -- vs the snapshot (metadata-to-metadata — comments_count always holds API metadata).
         -- growthDelta is Settings → Thresholds "Comment re-scrape delta" (commentGrowthDelta) —
         -- separate knob from commentMinViews/commentMinCount, which gate UGC search
         -- comment-scraping only (tiktok-search.ts); feed always scrapes every post's comments
         -- regardless of those, so it must not share that knob.
         OR (
           comments_scraped_at IS NOT NULL
           AND comments_count - comments_meta_at_scrape >= $3
           AND (posted_at >= NOW() - ($2 || ' days')::INTERVAL OR spike_flag = true)
         )
       )
     ORDER BY views DESC`,
    [brandId, days, growthDelta],
  );
}

// ── Upsert comments ───────────────────────────────────────────────────────────
// Drop-decision lives in analysis/comments.ts → shouldKeepComment().
// Re-exported isEmojiOnly is for legacy import sites only; new code should not
// use it directly.
export const isEmojiOnly = isEmojiOnlyImpl;

export async function upsertComments(
  brandId: number,
  postId: string,
  comments: TikTokCommentItem[],
): Promise<number> {
  let count = 0;
  for (const c of comments) {
    if (!shouldKeepComment(c.text)) continue; // see analysis/comments.ts
    try {
      await pool.query(
        `INSERT INTO social_comments
           (brand_id, platform, external_id, content, published_at,
            post_id, likes_count, reply_count, is_reply, parent_comment_id, content_translated)
         VALUES ($1,'tiktok',$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (platform, external_id) DO UPDATE SET
           likes_count  = EXCLUDED.likes_count,
           reply_count  = EXCLUDED.reply_count`,
        [
          brandId,
          c.cid,
          c.text ?? '',
          new Date(c.create_time * 1000),
          postId,
          c.digg_count ?? 0,
          c.reply_comment_total ?? 0,
          !!c.reply_id,
          c.reply_id ?? null,
          needsTranslation(c.text ?? '') ? null : '',
        ],
      );
      count++;
    } catch (err) {
      console.error(`  Comment upsert failed for ${c.cid}: ${err}`);
    }
  }
  return count;
}

// ── Per-brand scraper ─────────────────────────────────────────────────────────
export async function scrapeCommentsForBrand(
  brandSlug: string,
  days: number,
): Promise<void> {
  const rows = await query<{ id: number }>('SELECT id FROM brands WHERE slug = $1 LIMIT 1', [brandSlug]);
  if (rows.length === 0) { console.warn(`[Comments/${brandSlug}] Not in DB`); return; }
  const brandId = rows[0].id;

  const { getThresholds } = await import('../../config/settings-loader');
  const growthDelta = (await getThresholds().catch(() => null))?.commentGrowthDelta ?? 5;
  const posts = await findTargetPosts(brandId, days, growthDelta);
  if (posts.length === 0) { console.log(`[Comments/${brandSlug}] No posts in window`); return; }

  console.log(`[Comments/${brandSlug}] ${posts.length} posts → scraping comments...`);
  let { ctx, cleanup } = await launchContext();
  await warmUp(ctx);
  try {
    for (const post of posts) {
      const postHandle = post.author_handle;
      if (!postHandle) {
        console.log(`  ${post.post_id} — skipped (no author_handle)`);
        continue;
      }
      process.stdout.write(`  ${post.post_id} (@${postHandle})...`);
      try {
        const { comments, blocked } = await scrapePostComments(ctx, postHandle, post.post_id);
        const saved = await upsertComments(brandId, post.post_id, comments);
        // Mark as scraped whenever we got a real (non-CAPTCHA-blocked) answer — a post can
        // genuinely have 0 comments, and that's a valid result, not a failure. blocked=true
        // (hard redirect, or every /api/comment/list/ response was CAPTCHA-blocked) leaves
        // comments_scraped_at NULL so the next run retries it. NOTE: stats alone can't be used
        // for this — it's read from page HTML and loads fine even when the comment API itself
        // is CAPTCHA-blocked. comments_count is left = API metadata (true total incl replies,
        // refreshed by the feed/search upsert); we only snapshot it into comments_meta_at_scrape
        // so the re-scrape gate compares metadata-to-metadata. Scraped rows always undercount
        // metadata (no replies, emoji-only dropped), so they must NOT be the baseline. Actual
        // scraped count is derived via COUNT(social_comments).
        if (!blocked) {
          await pool.query(
            `UPDATE tiktok_posts SET
               comments_meta_at_scrape = comments_count,
               comments_scraped_at     = NOW()
             WHERE post_id = $1`,
            [post.post_id],
          );
        }
        console.log(` ${saved} comments`);
      } catch (err) {
        const msg = String(err);
        // Reconnect if Chrome crashed or context was closed externally
        if (msg.includes('Target page') || msg.includes('has been closed') || msg.includes('browserContext')) {
          console.log(` [reconnect] Chrome context lost — relaunching`);
          try { await cleanup(); } catch { /* ignore */ }
          ({ ctx, cleanup } = await launchContext());
        } else {
          console.log(` failed: ${err}`);
        }
      }
      // Randomised delay prevents comment API rate-limiting (TikTok throttles ~2-3 reqs/session)
      const delay = 8_000 + Math.random() * 4_000;
      await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    await cleanup();
  }
}

// ── Single-post scraper (for API-triggered re-scrape) ────────────────────────
// Uses the persistent profile (TikTokBrowser) so the logged-in session is guaranteed valid.
export async function scrapeCommentsForPost(postId: string): Promise<void> {
  const rows = await query<{ brand_id: number; author_handle: string | null; source_type: string; tiktok_handle: string | null }>(
    `SELECT tp.brand_id, tp.author_handle, tp.source_type, b.tiktok_handle
     FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
     WHERE tp.post_id = $1 LIMIT 1`,
    [postId],
  );
  if (rows.length === 0) throw new Error(`Post ${postId} not found`);
  const { brand_id, author_handle, source_type, tiktok_handle } = rows[0];
  const handle = source_type === 'search'
    ? (author_handle ?? tiktok_handle ?? '')
    : (tiktok_handle ?? author_handle ?? '');
  if (!handle) throw new Error(`No handle resolved for post ${postId}`);

  console.log(`[Comments/single] ${postId} via @${handle}`);
  const { ctx, cleanup } = await launchContext();
  await warmUp(ctx);

  try {
    // Stats are extracted from the same page that scrapes comments — no
    // second navigation, no extra CAPTCHA risk.
    const { comments, stats } = await scrapePostComments(ctx, handle, postId);
    await upsertComments(brand_id, postId, comments);

    if (stats) {
      const { views, likes, shares, comments: commsMeta } = stats;
      const eng = views > 0 ? (((likes + shares + commsMeta) / views) * 100).toFixed(4) : '0';
      await pool.query(
        `UPDATE tiktok_posts SET
           views = $2, likes = $3, shares = $4, comments_count = $5, engagement_rate = $6,
           comments_meta_at_scrape = $5, comments_scraped_at = NOW(), scraped_at = NOW()
         WHERE post_id = $1`,
        [postId, views, likes, shares, commsMeta, eng],
      );
      console.log(`[Comments/single] stats updated: views=${views} likes=${likes} shares=${shares} comments=${commsMeta}`);
    } else {
      // Stats unavailable — still stamp scrape timestamp and snapshot existing metadata.
      await pool.query(
        `UPDATE tiktok_posts SET
           comments_meta_at_scrape = comments_count,
           comments_scraped_at = NOW(),
           scraped_at = NOW()
         WHERE post_id = $1`,
        [postId],
      );
    }

    console.log(`[Comments/single] ${postId} → ${comments.length} comments saved`);
  } finally {
    await cleanup();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
export async function scrapeAllComments(): Promise<void> {
  const days = parseInt(process.env.COMMENT_DAYS ?? '7', 10);
  const target = process.env.TIKTOK_HANDLE;
  const accounts = target
    ? TIKTOK_ACCOUNTS.filter((a) => a.handle === target || a.brandSlug === target)
    : TIKTOK_ACCOUNTS;

  console.log(`[Comments] ${accounts.length} account(s) · last ${days} days`);
  for (const acc of accounts) {
    await scrapeCommentsForBrand(acc.brandSlug, days);
    if (acc !== accounts[accounts.length - 1]) await new Promise((r) => setTimeout(r, 20_000));
  }
  console.log('[Comments] Done');
}

if (require.main === module) {
  scrapeAllComments()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
