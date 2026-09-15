/**
 * Manually fire the LINE weekly digest (normally Monday 08:00 Bangkok via cron).
 * Usage: npx ts-node -r dotenv/config src/tools/send-weekly-digest.ts dotenv_config_path=.env.local
 */
import { sendWeeklyDigest } from '../analysis/weekly-digest';

sendWeeklyDigest()
  .then(() => { console.log('Done: weekly digest sent'); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });
