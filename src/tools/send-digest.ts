import { sendMorningDigest } from '../analysis/morning-digest';

sendMorningDigest()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
