/**
 * One-time interactive login for the Twitter/X scraper.
 *
 * Opens Chrome with the persistent scraper profile, navigates to x.com login.
 * You solve any SMS/2FA/captcha yourself. Cookies persist in the profile dir
 * for every subsequent scraper run.
 *
 * Usage: `npm run twitter:login`
 *   or:  `node -r ts-node/register -r dotenv/config src/tools/twitter-login.ts`
 */
import { launchContext, isSessionValid, LABEL, TWITTER_PROFILE_DIR } from '../scrapers/twitter/twitter-browser';

async function main(): Promise<void> {
  console.log(`${LABEL} launching Chrome (profile: ${TWITTER_PROFILE_DIR})...`);
  const ctx = await launchContext();
  const page = await ctx.newPage();

  // Fast path: already logged in — say so and exit.
  if (await isSessionValid(page)) {
    console.log(`${LABEL} ✓ Already logged in. No action needed.`);
    await ctx.close();
    return;
  }

  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });
  console.log(`${LABEL} → Please log in manually in the opened Chrome window.`);
  console.log(`${LABEL}   Waiting up to 5 minutes for auth_token cookie...`);

  // Poll every 3s for the auth_token cookie — set on successful login.
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    const cookies = await ctx.cookies(['https://x.com', 'https://twitter.com']);
    if (cookies.some((c) => c.name === 'auth_token' && !!c.value)) {
      console.log(`${LABEL} ✓ Login detected — cookies saved. Closing.`);
      await ctx.close();
      return;
    }
    if (page.isClosed()) break;
  }

  console.warn(`${LABEL} Timed out waiting for login. Cookies not saved.`);
  await ctx.close();
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
