/**
 * Just opens a real, logged-in XHS browser window (persistent profile) and
 * leaves it open for manual browsing/searching. Exits once you close the
 * browser window yourself.
 *
 * Usage: npx ts-node -r dotenv/config src/tools/xhs-open-browser.ts dotenv_config_path=.env.local
 */
import { launchPersistentContext, hasPersistentProfile, warmUp } from '../scrapers/xhs/xhs-browser';

async function main() {
  if (!hasPersistentProfile()) {
    console.warn('[xhs-open-browser] No persistent profile found yet — this will open a fresh (logged-out) session. Log in via the Settings UI first for a logged-in session.');
  }
  const ctx = await launchPersistentContext();
  const page = await ctx.newPage();
  await warmUp(page);
  console.log('[xhs-open-browser] Browser open — close the window when done.');

  // Keep the process alive until the browser itself is closed.
  await new Promise<void>((resolve) => {
    ctx.on('close', () => resolve());
  });
  console.log('[xhs-open-browser] Browser closed — exiting.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
