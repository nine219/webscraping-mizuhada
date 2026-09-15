/**
 * One-time backfill: assign urgency (1-5) to existing negative comments that
 * predate the urgency field. Cheaper than reclassify-comments.ts — only
 * touches sentiment='negative' AND urgency IS NULL rows.
 * Usage: npx ts-node -r dotenv/config src/tools/backfill-urgency.ts dotenv_config_path=.env.local
 */
import { backfillNegativeUrgency } from '../analysis/sentiment';

backfillNegativeUrgency()
  .then((n) => { console.log(`Done: ${n} negative comments backfilled with urgency`); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });
