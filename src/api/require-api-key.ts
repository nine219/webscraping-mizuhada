import { Request, Response, NextFunction } from 'express';

// Every mutating route (settings writes, comment/brand deletes, sentiment
// overrides, scrape/login triggers) had no auth at all — anyone reachable to
// the Express API could wipe settings, delete data, or kick off browser
// logins. This is a single-operator internal tool with no existing
// user/session system, so a shared API key (one secret, checked on every
// non-GET request) is the right-sized fix rather than building real login.
//
// If API_KEY isn't set, log a warning once and allow requests through —
// matches this codebase's existing pattern for optional secrets (LINE/Teams
// webhooks are log-only when unset, per CLAUDE.md) so local/dev setups don't
// break without an extra required env var.
const API_KEY = process.env.API_KEY;
let warnedUnset = false;

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  if (!API_KEY) {
    if (!warnedUnset) {
      console.warn('[api] API_KEY not set — mutating routes are UNAUTHENTICATED. Set API_KEY in .env.local to protect them.');
      warnedUnset = true;
    }
    next();
    return;
  }
  const provided = req.header('x-api-key');
  if (provided !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized — missing or invalid X-API-Key header' });
    return;
  }
  next();
}
