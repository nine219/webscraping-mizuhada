'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AiCostDailyChart, { DailyCostPoint } from '@/components/charts/ai-cost-daily-chart';
import { DateRangePicker } from '@/components/date-range-picker';
import type { DateRange } from '@/lib/api';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
// Matches src/api/require-api-key.ts — only enforced server-side when
// API_KEY is actually set, so leaving this unset locally still works.
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

// Thin wrapper over fetch — this page hand-rolls every request rather than
// going through dashboard/lib/api.ts's apiFetch, so it needs its own copy of
// both the ngrok-skip-browser-warning header (see apiFetch's comment for why:
// every request here re-hits the ngrok tunnel, not just the initial page
// load, and free-tier ngrok shows an HTML interstitial instead of proxying
// unless this header is present — harmless no-op against any real backend)
// and the X-API-Key header (this file went a whole round missing it entirely).
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: {
      'ngrok-skip-browser-warning': 'true',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

interface AiProviderStatus {
  provider: 'gemini' | 'deepseek';
  hasGeminiKey: boolean;
  hasDeepSeekKey: boolean;
  activeFallback: string;
}
interface AdminStatus {
  ai_provider: AiProviderStatus;
}

interface EnvVarRow {
  key: string;
  label: string;
  desc: string;
  present: boolean;
}
interface EnvStatus {
  vars: EnvVarRow[];
  envFilePath: string;
}

interface AiUsageSummaryRow {
  provider: string;
  calls: number;
  failures: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}
interface AiUsageRecentRow {
  id: number;
  provider: string;
  model: string;
  purpose: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  success: boolean;
  error_message: string | null;
  created_at: string;
}
interface AiUsageGroupRow {
  key: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}
interface AiUsageTotals {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}
interface AiUsageResponse {
  tracked: boolean;
  summary: AiUsageSummaryRow[];
  recent: AiUsageRecentRow[];
  totals: AiUsageTotals;
  by_purpose: AiUsageGroupRow[];
  by_model: AiUsageGroupRow[];
  daily: DailyCostPoint[];
  recent_page: number;
  recent_limit: number;
  recent_total: number;
  applied_filter: { days: number | null; from: string | null; to: string | null; date: string | null };
}

// Fixed categorical order — validated (CVD-safe on white surface, non-overlapping
// with the app's status colors). Assigned by position, never by a hash of the name.
const CATEGORY_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#e87ba4', '#eb6834'];
const PURPOSE_COLOR: Record<string, string> = {
  sentiment: CATEGORY_COLORS[0],
  translate: CATEGORY_COLORS[1],
  'post-theme': CATEGORY_COLORS[2],
  'brand-relevance': CATEGORY_COLORS[3],
  'captcha-vision': CATEGORY_COLORS[4],
};
const PURPOSE_LABEL: Record<string, string> = {
  sentiment: 'Sentiment classification',
  translate: 'Translation',
  'post-theme': 'Post theme',
  'brand-relevance': 'Brand relevance',
  'captcha-vision': 'Captcha vision',
};

function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  return n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`;
}

function fmtCompactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// Only the slice we touch — everything else in the settings blob is passed
// through untouched so a save here never clobbers Settings-page config.
interface AiSettingsSlice {
  provider: 'gemini' | 'deepseek';
}
interface FullSettings {
  ai: AiSettingsSlice;
  alerts: { lineToken: string; lineGroupId: string };
  [key: string]: unknown;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}


export default function AdminPage() {
  const [data, setData] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiUsage, setAiUsage] = useState<AiUsageResponse | null>(null);
  const [fullSettings, setFullSettings] = useState<FullSettings | null>(null);
  const [providerDraft, setProviderDraft] = useState<'gemini' | 'deepseek'>('gemini');
  const [savingAi, setSavingAi] = useState(false);
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [savingEnv, setSavingEnv] = useState(false);
  const [envMsg, setEnvMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [aiRange, setAiRange] = useState<DateRange>({ days: 30 });
  const [drillDate, setDrillDate] = useState<string | null>(null);

  // Moved from Settings → Alerts (removed — this is the only field that tab
  // had besides the CSV export below, and both are ops tools, not something
  // a marketer tunes). DB-backed (app_settings.alerts.lineGroupId) — this is
  // what src/alerts/line.ts actually reads at runtime, distinct from the
  // LINE_GROUP_ID env var above (env var is only ever a fallback until this
  // is saved — see line.ts's resolveLineConfig()).
  const [lineGroupIdDraft, setLineGroupIdDraft] = useState('');
  const [savingLineGroupId, setSavingLineGroupId] = useState(false);
  const [lineGroupIdMsg, setLineGroupIdMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Moved from Settings → Alerts alongside the LINE group ID field above.
  const today = new Date().toISOString().slice(0, 10);
  const [exportStart, setExportStart] = useState(today);
  const [exportEnd, setExportEnd] = useState(today);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');

  function load() {
    setLoading(true);
    apiFetch(`${API}/api/admin/status`).then((r) => r.json()).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }

  function loadEnvStatus() {
    apiFetch(`${API}/api/admin/env`).then((r) => r.json()).then(setEnvStatus).catch(() => setEnvStatus(null));
  }

  async function saveEnvVar(key: string) {
    if (!draftValue.trim()) { setEnvMsg({ kind: 'err', text: 'Enter a value first.' }); return; }
    setSavingEnv(true);
    setEnvMsg(null);
    try {
      const r = await apiFetch(`${API}/api/admin/env`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: draftValue }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || String(r.status));
      setEditingKey(null);
      setDraftValue('');
      loadEnvStatus();
      setEnvMsg({ kind: 'ok', text: `${key} saved — restart services to apply.` });
    } catch (err) {
      setEnvMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSavingEnv(false);
    }
  }

  async function restartServices() {
    if (!confirm('Restart api, scheduler, and dashboard now? Scrapes/alerts mid-run will be interrupted.')) return;
    setRestarting(true);
    try {
      await apiFetch(`${API}/api/admin/restart-services`, { method: 'POST' });
      setEnvMsg({ kind: 'ok', text: 'Restarting… give it ~10s, then reload this page.' });
    } catch {
      setEnvMsg({ kind: 'err', text: 'Restart trigger failed.' });
    } finally {
      setRestarting(false);
    }
  }

  const recentPageRef = useRef(1);
  const aiRangeRef = useRef(aiRange);
  const drillDateRef = useRef(drillDate);
  aiRangeRef.current = aiRange;
  drillDateRef.current = drillDate;
  // Request log had no way to filter by action type or failed-only despite
  // the table having both as columns, across 50 pages of history.
  const [purposeFilter, setPurposeFilter] = useState('');
  const [failedOnlyFilter, setFailedOnlyFilter] = useState(false);
  const purposeFilterRef = useRef(purposeFilter);
  const failedOnlyFilterRef = useRef(failedOnlyFilter);
  purposeFilterRef.current = purposeFilter;
  failedOnlyFilterRef.current = failedOnlyFilter;

  function loadAiUsage(recentPage = recentPageRef.current) {
    const range = aiRangeRef.current;
    const qs = new URLSearchParams({ recentPage: String(recentPage) });
    if (range.from && range.to) { qs.set('from', range.from); qs.set('to', range.to); }
    else if (range.days != null) qs.set('days', String(range.days));
    if (drillDateRef.current) qs.set('date', drillDateRef.current);
    if (purposeFilterRef.current) qs.set('purpose', purposeFilterRef.current);
    if (failedOnlyFilterRef.current) qs.set('failedOnly', 'true');
    apiFetch(`${API}/api/admin/ai-usage?${qs}`).then((r) => r.json()).then(setAiUsage).catch(() => setAiUsage(null));
  }

  function goToRecentPage(page: number) {
    recentPageRef.current = page;
    loadAiUsage(page);
  }

  function changeAiRange(next: DateRange) {
    setAiRange(next);
    setDrillDate(null);
    recentPageRef.current = 1;
    aiRangeRef.current = next;
    drillDateRef.current = null;
    loadAiUsage(1);
  }

  function toggleDrillDate(date: string) {
    const next = drillDate === date ? null : date;
    setDrillDate(next);
    recentPageRef.current = 1;
    drillDateRef.current = next;
    loadAiUsage(1);
  }

  function changePurposeFilter(next: string) {
    setPurposeFilter(next);
    purposeFilterRef.current = next;
    recentPageRef.current = 1;
    loadAiUsage(1);
  }

  function toggleFailedOnlyFilter() {
    const next = !failedOnlyFilter;
    setFailedOnlyFilter(next);
    failedOnlyFilterRef.current = next;
    recentPageRef.current = 1;
    loadAiUsage(1);
  }

  function loadAiSettings() {
    apiFetch(`${API}/api/settings`).then((r) => r.json()).then((d: { settings: FullSettings }) => {
      setFullSettings(d.settings);
      setProviderDraft(d.settings.ai.provider);
      setLineGroupIdDraft(d.settings.alerts?.lineGroupId ?? '');
    }).catch(() => {});
  }

  // Same PUT-the-whole-blob pattern as setAiProvider below.
  async function saveLineGroupId() {
    if (!fullSettings) return;
    setSavingLineGroupId(true);
    setLineGroupIdMsg(null);
    try {
      const next: FullSettings = { ...fullSettings, alerts: { ...fullSettings.alerts, lineGroupId: lineGroupIdDraft } };
      const r = await apiFetch(`${API}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      setFullSettings(body.settings);
      setLineGroupIdMsg({ kind: 'ok', text: 'Saved.' });
    } catch {
      setLineGroupIdMsg({ kind: 'err', text: 'Save failed — check API logs.' });
    } finally {
      setSavingLineGroupId(false);
    }
  }

  async function downloadMentionsCsv() {
    if (exportStart > exportEnd) { setExportErr('Start date must be before end date.'); return; }
    setExporting(true);
    setExportErr('');
    try {
      const res = await apiFetch(`${API}/api/settings/export-csv?start=${exportStart}&end=${exportEnd}`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const range = exportStart === exportEnd ? exportStart : `${exportStart}_to_${exportEnd}`;
      a.download = `mentions-${range}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportErr('Export failed — check API logs.');
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    load(); loadEnvStatus(); loadAiUsage(); loadAiSettings();
    // Real-time-ish: usage rows land seconds after a cron/trigger fires, so poll
    // instead of requiring a manual refresh click. Refs above keep the poll on
    // whatever range/drill-down/page is currently selected.
    const id = setInterval(() => loadAiUsage(), 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // DeepSeek temporarily hidden from this page's UI (provider toggle + cost
  // tracking) on request. Backend/data untouched — restore the pill buttons
  // (setAiProvider is still wired up below) and remove the .filter() calls
  // further down to bring it back.

  // Applies instantly on click — no separate save step. Takes the new value
  // directly rather than reading providerDraft (state update hasn't landed yet).
  async function setAiProvider(provider: 'gemini' | 'deepseek') {
    if (!fullSettings) return;
    setProviderDraft(provider);
    setSavingAi(true);
    try {
      const next: FullSettings = { ...fullSettings, ai: { provider } };
      const r = await apiFetch(`${API}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      setFullSettings(body.settings);
      load();
    } catch {
      setProviderDraft(fullSettings.ai.provider); // revert on failure
    } finally {
      setSavingAi(false);
    }
  }

  // Recomputed totals excluding DeepSeek — uses the backend's real per-provider
  // summary rows so the stat tiles/token split stay accurate while DeepSeek is
  // hidden, instead of just leaving the blended (Gemini+DeepSeek) totals shown
  // next to a table that's had its DeepSeek rows filtered out.
  const visibleTotals = aiUsage
    ? aiUsage.summary
        .filter((s) => s.provider !== 'deepseek')
        .reduce(
          (acc, s) => ({
            calls: acc.calls + s.calls,
            tokens_in: acc.tokens_in + s.tokens_in,
            tokens_out: acc.tokens_out + s.tokens_out,
            cost_usd: acc.cost_usd + s.cost_usd,
          }),
          { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 },
        )
    : null;
  const visibleByModel = aiUsage?.by_model.filter((m) => !m.key.toLowerCase().includes('deepseek')) ?? [];
  const visibleRecent = aiUsage?.recent.filter((r) => r.provider !== 'deepseek') ?? [];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">Admin / Operations</h1>
          <p className="page-header-subtitle">Runtime env · AI usage · manual triggers</p>
        </div>
        <button className="btn" onClick={() => { load(); loadEnvStatus(); loadAiUsage(); }} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {/* Manual scrape/search triggers actually live in Settings → Search
          (Multi-Platform Search + Feed Scrape), not on this page — a user
          checking Admin/Ops first for "search for a competitor" (the
          intuitive place, per this page's own "manual triggers" subtitle)
          wouldn't find it without this pointer. */}
      <Link
        href="/settings?tab=search"
        className="card p-4 mb-5 flex items-center justify-between card-hover"
        style={{ textDecoration: 'none' }}
      >
        <div>
          <div className="text-sm font-semibold text-primary">Looking to search a competitor or run a one-off scrape?</div>
          <div className="text-xs text-muted mt-0.5">Multi-Platform Search and Feed Scrape live in Settings → Search, not here.</div>
        </div>
        <span className="text-sm font-medium" style={{ color: 'var(--accent-primary)' }}>Go to Settings → Search →</span>
      </Link>

      {/* Moved from Settings → Alerts (that tab was removed — LINE group ID
          + CSV export were its only two things, and both are ops tools). */}
      <div className="card p-6 mb-5">
        <div className="section-title mb-1">Alert channel (LINE)</div>
        <div className="text-xs text-muted mb-4">
          DB-backed target group for spike/digest pushes (src/alerts/line.ts) — takes priority over the
          LINE_GROUP_ID env var below, which is only a fallback until this is saved.
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={lineGroupIdDraft}
            onChange={(e) => { setLineGroupIdDraft(e.target.value); setLineGroupIdMsg(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') saveLineGroupId(); }}
            placeholder="C1234abcd..."
            disabled={savingLineGroupId}
            className="text-xs px-2 py-1.5 rounded-lg outline-none font-mono"
            style={{ border: '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)', width: 320 }}
          />
          <button className="btn btn-sm" onClick={saveLineGroupId} disabled={savingLineGroupId}>
            {savingLineGroupId ? 'Saving…' : 'Save'}
          </button>
        </div>
        {lineGroupIdMsg && (
          <div className="text-xs mt-2" style={{ color: lineGroupIdMsg.kind === 'ok' ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
            {lineGroupIdMsg.text}
          </div>
        )}
      </div>

      <div className="card p-6 mb-5">
        <div className="section-title mb-1">Export mentions (CSV)</div>
        <div className="text-xs text-muted mb-4">
          One row per already-analyzed comment (sentiment classified), with its post&apos;s caption/views/likes
          repeated on each row — posts with zero comments still get one row.
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">From</span>
            <input type="date" value={exportStart} onChange={(e) => setExportStart(e.target.value)}
              max={today}
              className="px-3 py-1.5 text-sm rounded-lg outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--bg-base)' }} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">To</span>
            <input type="date" value={exportEnd} onChange={(e) => setExportEnd(e.target.value)}
              min={exportStart} max={today}
              className="px-3 py-1.5 text-sm rounded-lg outline-none"
              style={{ border: '1px solid var(--border)', background: 'var(--bg-base)' }} />
          </div>
          <button onClick={downloadMentionsCsv} disabled={exporting} className="btn btn-primary btn-sm">
            {exporting ? 'Exporting…' : 'Download CSV'}
          </button>
          {exportErr && <span className="text-xs" style={{ color: 'var(--accent-danger)' }}>{exportErr}</span>}
        </div>
      </div>

      {/* Env config — cron schedule editing lives in Settings → Schedules; this
          is process-level config (DB URLs, API keys, webhooks) that's only
          ever set before PM2/node starts, so it's presence-only + a link to
          the file, not an editable form. */}
      <div className="card p-6 mb-5">
        <div className="section-title mb-1">Environment config</div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Purpose</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(envStatus?.vars ?? []).map((v) => (
                <tr key={v.key}>
                  <td className="font-mono text-xs text-primary">{v.key}</td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                    <div className="font-medium">{v.label}</div>
                    <div className="text-muted">{v.desc}</div>
                  </td>
                  <td>
                    <span className="tag" style={{ background: v.present ? 'var(--accent-success)' : 'var(--accent-danger)', color: '#fff', fontSize: 10 }}>
                      {v.present ? 'set' : 'missing'}
                    </span>
                  </td>
                  <td>
                    {editingKey === v.key ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="password"
                          autoFocus
                          value={draftValue}
                          onChange={(e) => setDraftValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveEnvVar(v.key); if (e.key === 'Escape') { setEditingKey(null); setDraftValue(''); } }}
                          placeholder="New value…"
                          disabled={savingEnv}
                          className="text-xs px-2 py-1 rounded-lg outline-none font-mono"
                          style={{ border: '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)', width: 200 }}
                        />
                        <button className="btn btn-sm" onClick={() => saveEnvVar(v.key)} disabled={savingEnv}>
                          {savingEnv ? '…' : 'Save'}
                        </button>
                        <button className="btn btn-sm" onClick={() => { setEditingKey(null); setDraftValue(''); }} disabled={savingEnv}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="btn btn-sm" onClick={() => { setEditingKey(v.key); setDraftValue(''); setEnvMsg(null); }}>
                        {v.present ? 'Replace' : 'Set'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {envMsg && (
          <div className="text-xs mt-3" style={{ color: envMsg.kind === 'ok' ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
            {envMsg.text}
          </div>
        )}

        <div className="flex items-center gap-3 mt-4">
          <button className="btn" onClick={restartServices} disabled={restarting}>
            {restarting ? 'Restarting…' : 'Restart services to apply changes'}
          </button>
          <span className="text-xs text-muted">Restarts api, scheduler, dashboard — required for edits above to take effect.</span>
        </div>
      </div>

      {/* AI Usage */}
      <div className="card p-6 mb-5">
        <div className="section-title mb-1">AI usage</div>
        <div className="section-subtitle mb-4">Provider selection + token/cost tracking across sentiment, translation, theme, relevance, and captcha-vision calls</div>

        {/* Provider — plain text while DeepSeek is hidden (toggle would be
            pointless with only one real option). Un-comment PROVIDER_OPTIONS
            above + restore the pill buttons here to bring the switch back. */}
        <div className="rounded-lg p-4 mb-5" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-primary">Gemini</span>
          </div>

          {providerDraft === 'gemini' && !data?.ai_provider.hasGeminiKey && (
            <div className="text-xs mb-3" style={{ color: 'var(--accent-warning)' }}>
              No GEMINI_API_KEY set in env — Gemini calls will fail until one is added.
            </div>
          )}
          {/* DeepSeek key warning — hidden alongside the provider option above.
          {providerDraft === 'deepseek' && !data?.ai_provider.hasDeepSeekKey && (
            <div className="text-xs mb-3" style={{ color: 'var(--accent-warning)' }}>
              No DEEPSEEK_API_KEY set in env — DeepSeek calls will fail until one is added.
            </div>
          )} */}

          {data?.ai_provider && (
            <div className="text-xs text-muted">
              Text-completion fallback (when Gemini is quota-exhausted): {data.ai_provider.activeFallback}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <DateRangePicker value={aiRange} onChange={changeAiRange} />
          {drillDate && (
            <button className="filter-pill active" onClick={() => toggleDrillDate(drillDate)}>
              {drillDate} ✕
            </button>
          )}
        </div>

        {/* Cost analysis */}
        {aiUsage && visibleTotals && visibleTotals.calls > 0 ? (
          <>
            <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
              {drillDate ? `Showing ${drillDate} only` : 'Selected range'} · live
            </div>

            {/* Stat tiles */}
            <div className="grid grid-cols-4 gap-3 mb-3">
              {[
                { label: 'Total spend', value: fmtUsd(visibleTotals.cost_usd) },
                { label: 'Total tokens', value: fmtCompactNum(visibleTotals.tokens_in + visibleTotals.tokens_out) },
                { label: 'Avg cost / request', value: visibleTotals.calls > 0 ? fmtUsd(visibleTotals.cost_usd / visibleTotals.calls) : '—' },
                { label: 'Total requests', value: visibleTotals.calls.toLocaleString() },
              ].map((t) => (
                <div key={t.label} className="rounded-lg p-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                  <div className="text-lg font-bold text-primary">{t.value}</div>
                  <div className="text-xs mt-0.5 text-muted">{t.label}</div>
                </div>
              ))}
            </div>

            {/* Input/output token split */}
            <div className="rounded-lg p-3 mb-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
              <div className="flex justify-between text-xs mb-1">
                <span style={{ color: '#2a78d6' }}>Input tokens: {fmtCompactNum(visibleTotals.tokens_in)}</span>
                <span style={{ color: '#e87ba4' }}>Output tokens: {fmtCompactNum(visibleTotals.tokens_out)}</span>
              </div>
              {(() => {
                const total = visibleTotals.tokens_in + visibleTotals.tokens_out;
                const inPct = total > 0 ? (visibleTotals.tokens_in / total) * 100 : 50;
                return (
                  <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex', background: 'var(--border-light)' }}>
                    <div style={{ width: `${inPct}%`, background: '#2a78d6' }} />
                    <div style={{ width: `${100 - inPct}%`, background: '#e87ba4' }} />
                  </div>
                );
              })()}
            </div>

            {/* Cost by action / model */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">Cost by action</div>
                {aiUsage.by_purpose.map((p) => (
                  <div key={p.key} className="flex items-center justify-between py-1.5 border-b-light">
                    <div className="flex items-center gap-2">
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: PURPOSE_COLOR[p.key] ?? 'var(--text-muted)', display: 'inline-block' }} />
                      <div>
                        <div className="text-sm text-primary">{PURPOSE_LABEL[p.key] ?? p.key} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({p.calls})</span></div>
                        <div className="text-xs text-muted">{fmtCompactNum(p.tokens_in)} in · {fmtCompactNum(p.tokens_out)} out</div>
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-primary">{fmtUsd(p.cost_usd)}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg p-3" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">Cost by model</div>
                {visibleByModel.map((m, i) => (
                  <div key={m.key} className="flex items-center justify-between py-1.5 border-b-light">
                    <div className="flex items-center gap-2">
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: CATEGORY_COLORS[i % CATEGORY_COLORS.length], display: 'inline-block' }} />
                      <div>
                        <div className="text-sm font-mono text-primary">{m.key} <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'inherit' }}>({m.calls})</span></div>
                        <div className="text-xs text-muted">{fmtCompactNum(m.tokens_in)} in · {fmtCompactNum(m.tokens_out)} out</div>
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-primary">{fmtUsd(m.cost_usd)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Daily cost */}
            <div className="rounded-lg p-3 mb-4" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
              <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">Daily cost — click a bar to filter everything below to that day</div>
              <div style={{ height: 220 }}>
                <AiCostDailyChart data={aiUsage.daily} onBarClick={toggleDrillDate} selectedDate={drillDate} />
              </div>
            </div>

            {/* Request log */}
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Request log</div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  className="select"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  value={purposeFilter}
                  onChange={(e) => changePurposeFilter(e.target.value)}
                >
                  <option value="">All actions</option>
                  {Object.keys(PURPOSE_LABEL).map((p) => (
                    <option key={p} value={p}>{PURPOSE_LABEL[p]}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-secondary">
                  <input type="checkbox" checked={failedOnlyFilter} onChange={toggleFailedOnlyFilter} />
                  Failed only
                </label>
              </div>
            </div>
            <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Action</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cost</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {visibleRecent.map((r) => (
                  <tr key={r.id}>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{fmtTime(r.created_at)}</td>
                    <td>{r.provider}</td>
                    <td style={{ fontSize: 12, fontFamily: 'monospace' }}>{r.model}</td>
                    <td>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: PURPOSE_COLOR[r.purpose] ?? 'var(--text-muted)', display: 'inline-block', marginRight: 6 }} />
                      {PURPOSE_LABEL[r.purpose] ?? r.purpose}
                    </td>
                    <td style={{ fontSize: 12 }}>{r.tokens_in?.toLocaleString() ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{r.tokens_out?.toLocaleString() ?? '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--accent-success)' }}>{r.cost_usd ? fmtUsd(r.cost_usd) : '—'}</td>
                    <td>
                      <span className="tag" style={{ background: r.success ? 'var(--accent-success)' : 'var(--accent-danger)', color: '#fff', fontSize: 10 }}>
                        {r.success ? 'ok' : 'error'}
                      </span>
                      {!r.success && r.error_message && (
                        <span className="text-xs ml-2 text-muted">{r.error_message.slice(0, 60)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {aiUsage.recent_total > aiUsage.recent_limit && (
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-muted">
                  Page {aiUsage.recent_page} of {Math.max(1, Math.ceil(aiUsage.recent_total / aiUsage.recent_limit))} · {aiUsage.recent_total.toLocaleString()} total calls
                </span>
                <div className="flex gap-2">
                  <button className="btn btn-sm" disabled={aiUsage.recent_page <= 1} onClick={() => goToRecentPage(aiUsage.recent_page - 1)}>Prev</button>
                  <button className="btn btn-sm" disabled={aiUsage.recent_page >= Math.ceil(aiUsage.recent_total / aiUsage.recent_limit)} onClick={() => goToRecentPage(aiUsage.recent_page + 1)}>Next</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-muted">
            No AI calls logged yet — runs once sentiment/translation/theme jobs fire.
          </div>
        )}
      </div>
    </div>
  );
}
