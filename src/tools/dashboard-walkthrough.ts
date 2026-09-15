/**
 * Automated dashboard walkthrough recorder.
 *
 * Launches Chromium, navigates every relevant page in order, pauses at
 * highlights, and drops a .webm video into `walkthrough/`. Slide-deck ready.
 *
 * Usage:
 *   npm run dashboard:walkthrough
 *   (or: node -r ts-node/register -r dotenv/config src/tools/dashboard-walkthrough.ts)
 *
 * Env:
 *   DASHBOARD_URL   base URL (default http://localhost:3000)
 *   WALKTHROUGH_DIR output dir      (default ./walkthrough)
 *   WALKTHROUGH_SLOW  pause multiplier (default 1.0 — bump to 1.5 for slower)
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const BASE = process.env.DASHBOARD_URL || 'http://localhost:3000';
const OUT_DIR = process.env.WALKTHROUGH_DIR || path.join(process.cwd(), 'walkthrough');
const SLOW = parseFloat(process.env.WALKTHROUGH_SLOW || '1');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * SLOW));

interface Stop {
  path: string;
  title: string;
  linger: number;                  // seconds to stay on the page
  actions?: (page: import('playwright').Page) => Promise<void>;
}

// Ordered tour. Add / reorder as needed. `actions` runs after the initial nav
// so we can click through tabs, scroll, etc. before moving on.
const TOUR: Stop[] = [
  {
    path: '/overview',
    title: 'Command Center',
    linger: 6,
    actions: async (page) => {
      await wait(2_000);
      await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
      await wait(2_500);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    },
  },
  {
    path: '/social',
    title: 'Social Listening',
    linger: 8,
    actions: async (page) => {
      // Click through the tab strip (Mentions → Negative Queue → Hashtags)
      for (const tabLabel of ['Negative Queue', 'Hashtags', 'Mentions']) {
        await page.getByRole('button', { name: tabLabel, exact: true }).click().catch(() => {});
        await wait(2_500);
      }
    },
  },
  {
    path: '/tiktok?tab=feed',
    title: 'TikTok — Feed Monitor',
    linger: 5,
    actions: async (page) => {
      await wait(1_500);
      await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
      await wait(2_500);
    },
  },
  {
    path: '/tiktok?tab=search',
    title: 'TikTok — UGC Search',
    linger: 5,
  },
  {
    path: '/tiktok?tab=influencers',
    title: 'TikTok — Influencers',
    linger: 5,
  },
  {
    path: '/xhs?tab=feed',
    title: 'Xiaohongshu — Brand Monitor',
    linger: 5,
  },
  {
    path: '/xhs?tab=search',
    title: 'Xiaohongshu — UGC Search',
    linger: 5,
  },
  {
    path: '/x',
    title: 'X (Twitter)',
    linger: 5,
  },
  {
    path: '/instagram',
    title: 'Instagram',
    linger: 4,
  },
  {
    path: '/ugc',
    title: 'UGC Performance',
    linger: 5,
  },
  {
    path: '/admin',
    title: 'Admin / Ops',
    linger: 5,
    actions: async (page) => {
      await wait(1_500);
      await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
      await wait(2_500);
    },
  },
  {
    path: '/settings',
    title: 'Settings',
    linger: 6,
    actions: async (page) => {
      // Cycle through the settings tabs so viewers see every panel.
      for (const t of ['Brands', 'Keywords', 'Twitter/X', 'Schedules']) {
        await page.getByRole('button', { name: t, exact: true }).click().catch(() => {});
        await wait(2_500);
      }
    },
  },
];

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[walkthrough] recording ${TOUR.length} stops → ${OUT_DIR}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1200 } },
  });
  const page = await context.newPage();

  try {
    for (const stop of TOUR) {
      const url = `${BASE}${stop.path}`;
      console.log(`  → ${stop.title.padEnd(30)} ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
      // Give React a chance to hydrate + data to arrive.
      await wait(1_500);
      if (stop.actions) await stop.actions(page).catch((e) => console.warn(`      actions error: ${e}`));
      await wait(stop.linger * 1_000);
    }
  } finally {
    await page.close();
    await context.close(); // flushes video
    await browser.close();
  }

  // Rename the auto-generated video file so it's easy to find.
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm')).sort();
  const latest = files.at(-1);
  if (latest) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(OUT_DIR, `mizuhada-walkthrough-${stamp}.webm`);
    fs.renameSync(path.join(OUT_DIR, latest), target);
    console.log(`\n[walkthrough] ✓ saved: ${target}`);
    console.log(`[walkthrough] to convert to mp4: ffmpeg -i "${target}" -c:v libx264 -crf 23 out.mp4`);
  } else {
    console.warn('[walkthrough] no .webm file produced');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
