/**
 * Re-classify ALL comments under the current (enhanced) sentiment prompt.
 * Run after a prompt-quality change to correct existing labels in place.
 * Usage: npx ts-node -r dotenv/config src/tools/reclassify-comments.ts dotenv_config_path=.env.local
 */
import { reclassifyAllComments } from '../analysis/sentiment';

reclassifyAllComments()
  .then((n) => { console.log(`Done: ${n} comments re-classified`); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });
