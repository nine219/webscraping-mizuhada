'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  fetchTikTokSession, triggerTikTokLogin,
  fetchInstagramSession, triggerInstagramLogin,
  fetchXhsSession, triggerXhsLogin,
  fetchTwitterSession, triggerTwitterLogin,
  fetchScrapeJobStatus,
  type PlatformSession,
} from '../../../lib/api';
import { API_BASE, API_KEY, Section } from './shared';
import { useRunningPlatformFamilies } from '../../../lib/use-running-platforms';

// ── Account Management tab ────────────────────────────────────────────────────
// Session status + real interactive login flow for all 4 scraped platforms.
// Each platform's /session probes the on-disk Cookies sqlite mtime (no Chrome
// launch — would fight an in-progress login window); /login launches a real
// Chrome window server-side and polls for the platform's session cookie.
// Supersedes the "Scraper sessions" card that used to live on /admin.
interface AccountPlatform {
  key: string;
  label: string;
  fetchSession: () => Promise<PlatformSession>;
  triggerLogin: (opts?: { force?: boolean }) => Promise<{ started: boolean; jobId?: string; message: string; novncUrl?: string }>;
  desc: string;
}

const ACCOUNT_PLATFORMS: AccountPlatform[] = [
  {
    key: 'tiktok',
    label: 'TikTok',
    fetchSession: fetchTikTokSession,
    triggerLogin: triggerTikTokLogin,
    desc: 'Persistent Chrome profile used by the feed/search/comment scrapers.',
  },
  {
    key: 'instagram',
    label: 'Instagram',
    fetchSession: fetchInstagramSession,
    triggerLogin: triggerInstagramLogin,
    desc: 'Persistent Chrome profile used by the feed/comment scrapers.',
  },
  {
    key: 'xhs',
    label: 'Xiaohongshu',
    fetchSession: fetchXhsSession,
    triggerLogin: triggerXhsLogin,
    desc: 'Persistent Chrome profile (new) — falls back to XHS_COOKIES/XHS_COOKIE_HEADER env vars if no profile exists yet.',
  },
  {
    key: 'twitter',
    label: 'Twitter / X',
    fetchSession: fetchTwitterSession,
    triggerLogin: triggerTwitterLogin,
    desc: 'Persistent Chrome profile used by the keyword search scraper.',
  },
];
const TRIGGERS: { label: string; endpoint: string; method: 'POST'; platform: string | null }[] = [
  { label: 'TikTok feed scrape',     endpoint: '/api/tiktok/scrape',            method: 'POST', platform: 'tiktok' },
  { label: 'TikTok search scrape',   endpoint: '/api/tiktok/search/run',        method: 'POST', platform: 'tiktok' },
  { label: 'Instagram feed scrape',  endpoint: '/api/instagram/scrape',         method: 'POST', platform: 'instagram' },
  { label: 'Xiaohongshu feed scrape',endpoint: '/api/xhs/run',                  method: 'POST', platform: 'xhs' },
  { label: 'Xiaohongshu UGC search', endpoint: '/api/xhs/search/run',           method: 'POST', platform: 'xhs' },
  { label: 'Twitter/X search',       endpoint: '/api/twitter/search/run',       method: 'POST', platform: 'twitter' },
  { label: 'Sentiment classify',     endpoint: '/api/social/analyze',           method: 'POST', platform: null },
];

function AccountCard({ platform, runningFamilies }: { platform: AccountPlatform; runningFamilies: Set<string> }) {
  const [session, setSession] = useState<PlatformSession | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Same protection as the Manual Triggers buttons below — a login job shares
  // this platform's browser-profile lock with any other job already running,
  // so it wouldn't crash, it'd just sit blocked with no explanation.
  const loginFamilyBusy = runningFamilies.has(platform.key);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 5000);
  };

  const refresh = useCallback(async () => {
    try {
      const s = await platform.fetchSession();
      setSession(s);
    } catch (e) {
      flash('err', `${platform.label} session check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  useEffect(() => { refresh(); }, [refresh]);

  // Login runs server-side for up to 15 min (5 for X) — poll the job itself
  // instead of guessing a single delay, so the ✓/✗ badge updates the moment
  // the login actually finishes (or fails) instead of only once at 15s.
  const pollLoginJob = useCallback(async (jobId: string) => {
    const deadline = Date.now() + 16 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const job = await fetchScrapeJobStatus(jobId);
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
          await refresh();
          if (job.status !== 'done') flash('err', job.message || `Login ${job.status}.`);
          return;
        }
      } catch {
        // Job row not queryable yet (race with the INSERT) or a transient
        // fetch blip — keep polling rather than giving up on one miss.
      }
    }
    refresh(); // client-side timeout — one last check in case it finished right at the edge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLogin = async () => {
    setBusy(true);
    try {
      // A "Re-login" click (session already valid) forces a fresh login —
      // currently only TikTok's backend acts on this flag; other platforms
      // ignore the extra field.
      const body = await platform.triggerLogin({ force: !!session?.valid });
      // TikTok/Instagram/Twitter run in a Docker container now — their login
      // Chrome window renders into that container's own virtual display, not
      // this machine's screen, so there's nothing to see without opening its
      // noVNC session. XHS runs on the host and has no novncUrl (its Chrome
      // already opens directly on this screen), so this is a no-op there.
      if (body.novncUrl) {
        const w = window.open(body.novncUrl, '_blank', 'noopener,noreferrer');
        if (!w) flash('err', `Popup blocked — open ${body.novncUrl} manually to log in.`);
        else flash('ok', 'Chrome window opening — log in in the new tab.');
      } else {
        flash('ok', body.message ?? 'Login flow started on the server.');
      }
      if (body.jobId) pollLoginJob(body.jobId);
      else setTimeout(refresh, 15000); // fallback if an older API build doesn't return jobId yet
    } catch (e) {
      flash('err', String(e));
    } finally {
      setBusy(false);
    }
  };

  async function trigger(t: typeof TRIGGERS[number]) {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}${t.endpoint}`, { method: t.method, headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true', ...(API_KEY ? { 'X-API-Key': API_KEY } : {}) }, body: '{}' });
      const body = await r.json().catch(() => ({}));
      flash('ok', `${t.label}: ${r.ok ? (body.jobId ? `started (job ${body.jobId.slice(0, 8)}…)` : 'started') : `failed (${r.status})`}`);
    } catch {
      flash('err', `${t.label}: request failed`);
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
      {msg && (
        <div className="px-3 py-2 mb-3 rounded-lg text-sm"
          style={{
            background: msg.kind === 'ok' ? 'var(--accent-success-subtle, rgba(16,185,129,0.12))' : 'var(--accent-danger-subtle, rgba(239,68,68,0.12))',
            color: msg.kind === 'ok' ? 'var(--accent-success)' : 'var(--accent-danger)',
          }}>
          {msg.text}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-primary">{platform.label}</span>
        <strong style={{ fontSize: 12, color: session?.valid ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
          {session == null ? '—' : session.valid ? 'valid ✓' : 'not logged in ✗'}
        </strong>
      </div>

      <p className="text-xs mb-3 text-muted">{platform.desc}</p>

      <div className="flex items-center gap-3 mb-3 text-xs">
        {session?.checkedAt && (
          <span className="text-muted">
            checked {new Date(session.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button onClick={refresh} disabled={busy}
          className="px-3 py-1.5 text-xs rounded-lg cursor-pointer"
          style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
          Refresh
        </button>
        <button onClick={startLogin} disabled={busy || loginFamilyBusy}
          title={loginFamilyBusy ? `${platform.label} is already running a job — logging in now would just wait behind it.` : undefined}
          className="px-3 py-1.5 text-xs rounded-lg cursor-pointer"
          style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }}>
          {busy ? 'Working…' : loginFamilyBusy ? 'Already running…' : session?.valid ? 'Re-login' : 'Log in'}
        </button>
      </div>

      {session?.profileDir && (
        <div className="text-xs font-mono break-all mb-1 text-secondary">
          {session.profileDir}
        </div>
      )}
      {session?.hint && (
        <div className="text-xs text-muted">{session.hint}</div>
      )}

      {/* Triggers — inline row, not a nested card, so it reads as part of this platform's tile */}
      {(() => {
        const platformTriggers = TRIGGERS.filter((t) => t.platform === platform.key);
        if (platformTriggers.length === 0) return null;
        return (
          <div className="mt-3 pt-3 border-t-light">
            <div className="text-xs mb-2 text-muted">Manual triggers</div>
            <div className="flex gap-2 flex-wrap">
              {platformTriggers.map((t) => {
                // This platform's browser profile is already in use by a job
                // started elsewhere (another trigger, the scheduler, another
                // tab) — a second launch wouldn't crash (the advisory lock
                // just makes it wait) but it'd sit silently blocked with no
                // explanation, so block the click here instead.
                const familyBusy = !!t.platform && runningFamilies.has(t.platform);
                return (
                  <button
                    key={t.endpoint}
                    onClick={() => trigger(t)}
                    disabled={busy || familyBusy}
                    title={familyBusy ? `${platform.label} is already running a job — wait for it to finish.` : undefined}
                    className="btn btn-primary btn-sm"
                  >
                    {busy ? 'Triggering…' : familyBusy ? 'Already running…' : t.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default function AccountsTab() {
  const [sentimentBusy, setSentimentBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const runningFamilies = useRunningPlatformFamilies();

  async function triggerSentiment() {
    setSentimentBusy(true);
    try {
      const t = TRIGGERS.find((x) => x.endpoint === '/api/social/analyze')!;
      const r = await fetch(`${API_BASE}${t.endpoint}`, { method: t.method, headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true', ...(API_KEY ? { 'X-API-Key': API_KEY } : {}) }, body: '{}' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setToast({ kind: 'err', text: `Sentiment classify failed (${r.status})` });
      } else if (body.started === false) {
        setToast({ kind: 'ok', text: body.message ?? (body.pending === 0 ? 'No comments to analyze right now.' : 'Already running.') });
      } else {
        setToast({ kind: 'ok', text: `Sentiment classify started — ${body.pending} comment(s) queued.` });
      }
    } catch {
      setToast({ kind: 'err', text: 'Sentiment classify: request failed' });
    } finally {
      setSentimentBusy(false);
      setTimeout(() => setToast(null), 5000);
    }
  }

  return (
    <Section title="Account Management" desc="Session status + login for every scraped platform. Each Log in click launches a real Chrome window server-side — finish the flow there, then Refresh (or wait ~15s) to see the status update.">
      <div className="grid grid-cols-2 gap-4">
        {ACCOUNT_PLATFORMS.map((p) => <AccountCard key={p.key} platform={p} runningFamilies={runningFamilies} />)}
      </div>

      <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="text-sm font-semibold mb-1 text-primary">Global triggers</div>
        <p className="text-xs mb-3 text-muted">Not tied to one platform — runs across every comment awaiting classification.</p>
        {toast && (
          <div className="px-3 py-2 mb-3 rounded-lg text-sm" style={{
            background: toast.kind === 'ok' ? 'var(--accent-success-subtle, rgba(16,185,129,0.12))' : 'var(--accent-danger-subtle, rgba(239,68,68,0.12))',
            color: toast.kind === 'ok' ? 'var(--accent-success)' : 'var(--accent-danger)',
          }}>
            {toast.text}
          </div>
        )}
        <button onClick={triggerSentiment} disabled={sentimentBusy} className="btn btn-primary">
          {sentimentBusy ? 'Classifying…' : 'Sentiment classify'}
        </button>
        <p className="text-xs mt-3 text-muted">
          Logs live in PM2 — run <code style={{ background: 'var(--bg-base)', padding: '1px 4px', borderRadius: 3 }}>pm2 logs api</code>. AI provider + cost tracking: Admin page.
        </p>
      </div>
    </Section>
  );
}
