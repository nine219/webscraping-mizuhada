/**
 * Translate + sentiment-classify Xiaohongshu comments only.
 * XHS comments are Chinese, so we translate them to Thai first, then the Thai
 * classifier scores them. Drains the full XHS backlog in one run.
 *
 * Usage: npx ts-node -r dotenv/config src/tools/sentiment-xhs.ts dotenv_config_path=.env.local
 */
import { translateUntranslatedComments } from '../analysis/translate';
import { classifyUnanalyzedComments } from '../analysis/sentiment';

const PLATFORM = 'xiaohongshu';

(async () => {
  // 1) Translate untranslated CN comments (XHS is the CN platform with data).
  let translated = 0, t = 0;
  do { t = await translateUntranslatedComments(500); translated += t; } while (t > 0);
  console.log(`[XHS-Sentiment] translated ${translated} comments`);

  // 2) Classify unanalyzed XHS comments (reads the Thai translation).
  let classified = 0, c = 0;
  do { c = await classifyUnanalyzedComments(500, PLATFORM); classified += c; } while (c > 0);
  console.log(`[XHS-Sentiment] ✓ classified ${classified} XHS comments`);

  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
