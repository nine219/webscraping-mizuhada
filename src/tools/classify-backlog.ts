/**
 * Drain the full sentiment backlog in one run (cron does only 100/2h).
 * Usage: npx ts-node -r dotenv/config src/tools/classify-backlog.ts dotenv_config_path=.env.local
 */
import { classifyUnanalyzedComments } from '../analysis/sentiment';

(async () => {
  let total = 0, n = 0;
  do {
    n = await classifyUnanalyzedComments(500);
    total += n;
    console.log(`[Backlog] cumulative=${total}`);
  } while (n > 0);
  console.log(`[Backlog] ALL DONE total=${total}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
