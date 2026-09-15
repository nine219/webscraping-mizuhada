// Reads/writes the `platform_sessions` table — see schema-social.sql for why
// this exists: `api` has no browser after the Docker split, so it can't stat
// a platform's Cookies sqlite file itself anymore. Whichever process DOES
// hold that platform's profile (a scraper-<platform> container, or the host
// for XHS) self-reports its status here; `api`'s GET /session routes just
// read the row.
import { socialQuery, socialQueryOne } from '../db/social-client';

export type SessionPlatform = 'tiktok' | 'instagram' | 'twitter' | 'xhs';

// Host-side noVNC port per containerized platform (docker-compose.yml,
// localhost-only) — lets the dashboard open a tab onto the actual Chrome
// window a 'login' job launches. XHS is deliberately absent: it runs on the
// host, not in a container, so its login Chrome already opens directly on
// the user's own screen — no VNC needed or available for it.
export const NOVNC_PORTS: Partial<Record<SessionPlatform, number>> = {
  tiktok: 6080,
  instagram: 6081,
  twitter: 6082,
};

export function getNovncUrl(platform: SessionPlatform): string | undefined {
  const port = NOVNC_PORTS[platform];
  return port ? `http://localhost:${port}/vnc.html` : undefined;
}

export interface SessionStatus {
  valid: boolean;
  profileDir: string;
  checkedAt: string;
  hint?: string;
}

interface SessionRow {
  platform: string;
  valid: boolean;
  profile_dir: string;
  hint: string;
  checked_at: Date | string;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Called by `api` — fast DB read, no filesystem access, matches the old synchronous route shape. */
export async function readSessionStatus(platform: SessionPlatform): Promise<SessionStatus> {
  const row = await socialQueryOne<SessionRow>(
    `SELECT * FROM platform_sessions WHERE platform = $1`,
    [platform],
  );
  if (!row) {
    return { valid: false, profileDir: '', checkedAt: new Date().toISOString(), hint: 'No status reported yet — the scraper for this platform may not have started.' };
  }
  return { valid: row.valid, profileDir: row.profile_dir, checkedAt: toIso(row.checked_at), hint: row.hint || undefined };
}

/** Called by whichever process actually owns the platform's browser profile. */
export async function writeSessionStatus(platform: SessionPlatform, status: SessionStatus): Promise<void> {
  await socialQuery(
    `INSERT INTO platform_sessions (platform, valid, profile_dir, hint, checked_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (platform) DO UPDATE SET
       valid       = EXCLUDED.valid,
       profile_dir = EXCLUDED.profile_dir,
       hint        = EXCLUDED.hint,
       checked_at  = NOW()`,
    [platform, status.valid, status.profileDir, status.hint ?? ''],
  );
}
