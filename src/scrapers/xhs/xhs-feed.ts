import { Browser, BrowserContext, Page } from 'playwright';
import { BaseSocialScraper, RawSocialPost, upsertSocialComment } from './base-social';
import { scrapeNoteComments, commentsEnabled } from './xhs-comments';
import { upsertXhsPost, loadXhsBrandIds } from './xhs-db';
import {
  PLATFORM_SLUG, LABEL, XhsNote, XHS_ACCOUNTS,
  launchBrowser, newStealthContext, detectWall, hasXhsCookies, warmUp, handleCaptcha,
  launchPersistentContext, hasPersistentProfile,
} from './xhs-browser';

// Note-only mode stores list-API metadata (no per-note page visit), so keeping all
// collected notes is just cheap DB upserts. Cap high; the scroll loop / redirect wall
// limits how many actually load anyway.
const MAX_NOTES_PER_BRAND = 300;

// Profile "user_posted" API — shape varies, so normalize defensively.
interface UserPostedResponse {
  data?: {
    notes?: Array<{
      note_id?: string;
      id?: string;
      xsec_token?: string;
      type?: string;
      display_title?: string;
      desc?: string;
      note_card?: { display_title?: string; desc?: string };
      time?: string;
      interact_info?: { liked_count?: string; comment_count?: string; collected_count?: string; shared_count?: string };
      cover?: { url_default?: string; url_pre?: string };
      user?: { nickname?: string; nick_name?: string; avatar?: string };
    }>;
  };
}

function toInt(v?: string): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Extract notes from the SSR'd Vue state (__INITIAL_STATE__.user.notes) and merge into
// `collected`. State uses camelCase (interactInfo.likedCount, displayTitle, urlDefault),
// unlike the snake_case user_posted XHR. Captures the SSR first page (newest notes) that
// never triggers an XHR. Best-effort — silently no-ops on a 404/redirect state.
async function mergeStateNotes(page: Page, collected: Map<string, XhsNote>, brandSlug: string): Promise<void> {
  try {
    const notes = await page.evaluate(() => {
      const s = (window as unknown as { __INITIAL_STATE__?: { user?: { notes?: { _rawValue?: unknown; _value?: unknown } } } }).__INITIAL_STATE__;
      const ref = s?.user?.notes;
      const pages = (ref?._rawValue ?? ref?._value ?? []) as Array<Array<Record<string, unknown>>>;
      const out: Array<Record<string, string | undefined>> = [];
      for (const pg of pages) {
        for (const item of pg ?? []) {
          const nc = (item?.noteCard ?? {}) as Record<string, unknown>;
          const id = (item?.id as string) ?? (nc.noteId as string);
          if (!id) continue;
          const interact = (nc.interactInfo ?? {}) as Record<string, string>;
          const user = (nc.user ?? {}) as Record<string, string>;
          const cover = (nc.cover ?? {}) as Record<string, string>;
          out.push({
            id,
            xsecToken: (item?.xsecToken as string) ?? (nc.xsecToken as string),
            title: (nc.displayTitle as string) ?? '',
            type: nc.type as string,
            likes: interact.likedCount,
            comments: interact.commentCount,
            collects: interact.collectedCount,
            shares: interact.shareCount,
            cover: cover.urlDefault ?? cover.urlPre ?? cover.url,
            nickname: user.nickname ?? user.nickName,
            avatar: user.avatar,
          });
        }
      }
      return out;
    });

    for (const n of notes) {
      if (!n.id || collected.has(n.id)) continue;
      collected.set(n.id, {
        id: n.id,
        title: n.title ?? '',
        desc: '',
        author: brandSlug,
        url: `https://www.xiaohongshu.com/explore/${n.id}`,
        xsecToken: n.xsecToken,
        likes: n.likes ? parseInt(n.likes, 10) : undefined,
        commentsCount: n.comments ? parseInt(n.comments, 10) : undefined,
        collectsCount: n.collects ? parseInt(n.collects, 10) : undefined,
        sharesCount: n.shares ? parseInt(n.shares, 10) : undefined,
        noteType: n.type,
        coverUrl: n.cover,
        authorName: n.nickname,
        authorAvatar: n.avatar,
      });
    }
  } catch { /* best-effort: state missing or page redirected */ }
}

export async function collectBrandNotes(page: Page, profileUrl: string, brandSlug: string, maxScrolls?: number): Promise<XhsNote[]> {
  const collected = new Map<string, XhsNote>();

  const onResponse = async (resp: import('playwright').Response) => {
    if (!resp.ok()) return;
    if (!resp.url().includes('/api/sns/web/v1/user_posted')) return;
    try {
      const body = await resp.json() as UserPostedResponse;
      for (const n of body?.data?.notes ?? []) {
        const id = n.note_id || n.id;
        if (!id || collected.has(id)) continue;
        collected.set(id, {
          id,
          title: n.display_title ?? n.note_card?.display_title ?? '',
          desc: n.desc ?? n.note_card?.desc ?? '',
          author: brandSlug,
          url: `https://www.xiaohongshu.com/explore/${id}`,
          publishedAt: n.time,
          xsecToken: n.xsec_token,
          likes: toInt(n.interact_info?.liked_count),
          commentsCount: toInt(n.interact_info?.comment_count),
          collectsCount: toInt(n.interact_info?.collected_count),
          sharesCount: toInt(n.interact_info?.shared_count),
          noteType: n.type,
          coverUrl: n.cover?.url_default ?? n.cover?.url_pre,
          authorName: n.user?.nickname ?? n.user?.nick_name,
          authorAvatar: n.user?.avatar,
        });
      }
    } catch { /* ignore non-JSON */ }
  };
  page.on('response', onResponse);

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(5000);
    await handleCaptcha(page); // pause for manual solve (headful) if the security panel appears

    // The newest notes are server-rendered into __INITIAL_STATE__ (the first page is
    // NOT fetched via the user_posted XHR), so grab them from state BEFORE scrolling —
    // a scroll-triggered redirect to /404 would replace __INITIAL_STATE__.
    await mergeStateNotes(page, collected, brandSlug);

    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    const wall = detectWall(bodyText);
    if (wall === 'login') {
      console.warn(`${LABEL} Login wall on ${brandSlug} profile — XHS_COOKIES may be expired`);
      return [];
    }
    if (wall === 'captcha') {
      console.warn(`${LABEL} Captcha/anti-bot on ${brandSlug} profile — partial data`);
    }

    // Scroll pacing — XHS lazy-loads the next batch on scroll; if we check for new
    // notes before that load finishes it looks "stale" and we'd bail early while
    // more notes exist below. So wait generously and give extra patience before
    // giving up. Tune via env without code changes.
    const SCROLL_MS    = parseInt(process.env.XHS_SCROLL_MS ?? '3500', 10);   // wait after each scroll
    // maxScrolls comes from settings.thresholds.scrapeLimits.xhsFeed (Settings UI) —
    // env var / 30 is only the fallback for direct-CLI invocation before settings load.
    const MAX_SCROLLS  = maxScrolls ?? parseInt(process.env.XHS_MAX_SCROLLS ?? '30', 10);   // hard cap
    const STALE_LIMIT  = parseInt(process.env.XHS_STALE_LIMIT ?? '5', 10);    // stop after N no-growth rounds
    const debug = process.env.XHS_DEBUG === '1';

    let prevSize = 0;
    let staleRounds = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      // XHS redirects off the profile to an app/verify wall after a few scrolls.
      // Notes are already captured via API by then — stop and keep what we have.
      if (!page.url().includes('/user/profile/')) {
        console.warn(`${LABEL} ${brandSlug}: redirected off profile — stopping scroll (kept ${collected.size})`);
        break;
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(SCROLL_MS);
      await mergeStateNotes(page, collected, brandSlug); // state ref also accumulates scroll pages

      if (collected.size === prevSize) {
        staleRounds++;
        // Before counting a stale round as terminal, give the lazy-load one more
        // longer beat — a slow network batch can arrive just after the wait.
        if (staleRounds < STALE_LIMIT) {
          await page.waitForTimeout(SCROLL_MS);
          await mergeStateNotes(page, collected, brandSlug);
        }
        if (collected.size === prevSize && staleRounds >= STALE_LIMIT) {
          if (debug) console.log(`${LABEL} ${brandSlug}: [scroll ${i + 1}] plateaued at ${collected.size} (${staleRounds} stale)`);
          break;
        }
        if (collected.size > prevSize) staleRounds = 0;
      } else {
        staleRounds = 0;
      }
      if (debug) console.log(`${LABEL} ${brandSlug}: [scroll ${i + 1}] size=${collected.size} (+${collected.size - prevSize})`);
      prevSize = collected.size;
    }
  } finally {
    page.off('response', onResponse);
  }

  console.log(`${LABEL} ${brandSlug}: ${collected.size} notes`);
  return Array.from(collected.values());
}

export class XhsFeedScraper extends BaseSocialScraper {
  constructor() {
    super({ platformSlug: PLATFORM_SLUG, defaultSourceType: 'profile' });
  }

  async fetchPosts(): Promise<RawSocialPost[]> {
    if (!hasXhsCookies()) {
      console.warn(`${LABEL} No XHS_COOKIES set. XHS requires auth — see CN_SOCIAL_SETUP.md`);
      return [];
    }

    const targets = XHS_ACCOUNTS.filter((a) => a.handle.trim());
    if (targets.length === 0) {
      console.warn(`${LABEL} No XHS_ACCOUNTS with a profile URL — nothing to scrape`);
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

      const withComments = commentsEnabled();
      const brandIds = await loadXhsBrandIds();
      const { getThresholds } = await import('../../config/settings-loader');
      const limits = (await getThresholds().catch(() => null))?.scrapeLimits.xhsFeed;
      for (const { brandSlug, handle } of targets) {
        const brandId = brandIds.get(brandSlug) ?? null;
        const notes = (await collectBrandNotes(page, handle, brandSlug, limits?.maxScrolls)).slice(0, limits?.maxPosts ?? MAX_NOTES_PER_BRAND);
        for (const note of notes) {
          try {
            await upsertXhsPost(brandId, note, 'profile'); // note → xhs_posts
          } catch (err) {
            // One malformed note (e.g. bad published_at) used to throw and abort
            // the entire remaining keyword/brand loop instead of degrading
            // gracefully — mirrors the per-row catch already used for comments
            // (base-social.ts's upsertComment loop).
            console.error(`${LABEL} Failed to save note ${note.id}: ${err}`);
            continue;
          }
          if (withComments) {
            const rows = await scrapeNoteComments(page, note);
            for (const r of rows) r.brandSlug = brandSlug; // comments → social_comments (base path)
            out.push(...rows);
            await this.delay(2000 + Math.floor(Math.random() * 2000));
          }
        }
        console.log(`${LABEL} ${brandSlug}: ${notes.length} notes upserted, ${out.length} comment rows so far`);
        await this.delay(3000);
      }

      return out;
    } finally {
      if (browser) await browser.close();
      else await ctx.close();
    }
  }
}

export async function runXhsFeed(): Promise<void> {
  await new XhsFeedScraper().run();
}

// ── Ad-hoc single-account feed scrape ─────────────────────────────────────────
// XHS analogue of TikTokFeedScraper/InstagramFeedScraper's single-account
// constructor — XHS has no reusable scraper class shaped that way (XhsFeedScraper
// always loops the full XHS_ACCOUNTS list), so this reimplements just the
// per-account body of fetchPosts() above for one arbitrary profile URL. XHS has
// no @handle — profileUrl is the full xiaohongshu.com/user/profile/<id> link.
export async function runXhsAdhocFeed(
  brandId: number,
  brandSlug: string,
  profileUrl: string,
  maxNotes = MAX_NOTES_PER_BRAND,
  // Explicit override from the ad-hoc UI's "Scrape comments" toggle — when set,
  // wins over the XHS_SCRAPE_COMMENTS env var (which still governs the
  // scheduled own-brand feed). Undefined = fall back to the env var.
  scrapeCommentsOverride?: boolean,
): Promise<number> {
  if (!hasXhsCookies()) {
    console.warn(`${LABEL} No XHS_COOKIES set. XHS requires auth — see CN_SOCIAL_SETUP.md`);
    return 0;
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

  try {
    const page = await ctx.newPage();
    await warmUp(page);

    const withComments = scrapeCommentsOverride ?? commentsEnabled();
    const notes = (await collectBrandNotes(page, profileUrl, brandSlug)).slice(0, maxNotes);

    let commentCount = 0;
    for (const note of notes) {
      try {
        await upsertXhsPost(brandId, note, 'profile');
      } catch (err) {
        console.error(`${LABEL} Failed to save note ${note.id}: ${err}`);
        continue;
      }
      if (withComments) {
        const rows = await scrapeNoteComments(page, note);
        for (const r of rows) {
          r.brandSlug = brandSlug;
          if (await upsertSocialComment(r, brandId, PLATFORM_SLUG, 'profile')) commentCount++;
        }
        await new Promise((res) => setTimeout(res, 2000 + Math.floor(Math.random() * 2000)));
      }
    }

    console.log(`${LABEL} ad-hoc ${brandSlug}: ${notes.length} notes, ${commentCount} comments`);
    return notes.length;
  } finally {
    if (browser) await browser.close();
    else await ctx.close();
  }
}

if (require.main === module) {
  runXhsFeed()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
