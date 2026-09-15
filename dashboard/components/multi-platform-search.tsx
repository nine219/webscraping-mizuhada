'use client';

import { useEffect, useRef, useState } from 'react';
import { triggerMultiSearch, fetchScrapeJobStatus, stopScrapeJob, triggerAdhocFeedScrape, MultiSearchPlatform, FeedScrapePlatform, ScrapeJobStatus } from '@/lib/api';
import { useRunningPlatformFamilies } from '@/lib/use-running-platforms';
import BrandPicker, { useSocialBrands } from './brand-picker';

// Settings > Search tab. Reuses each platform's existing ad-hoc-keyword search path as-is: results
// still only get saved if they mention one of the 3 own brands (MizuMi/
// Gentle Colors/Bomi) — same relevance filter + own-brand attribution the
// scheduled UGC search already applies. This is "run one keyword right now,"
// not a free/unfiltered search. Instagram is excluded — it has no ad-hoc
// keyword search, only a configured hashtag list.
const PLATFORMS: { value: MultiSearchPlatform; label: string }[] = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'xhs', label: 'Xiaohongshu' },
  { value: 'twitter', label: 'X (Twitter)' },
];

// Which platforms actually honor a stop request. XHS's scraper has no
// cancellation support yet — its job would just keep running underneath a
// button that claims to have stopped it, so the Stop button is hidden there
// instead of lying about what it does.
const CANCELLABLE_PLATFORMS = new Set<MultiSearchPlatform>(['tiktok', 'twitter']);

interface JobRow {
  platform: MultiSearchPlatform;
  jobId: string;
  status: ScrapeJobStatus | null;
}

export default function MultiPlatformSearch() {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Set<MultiSearchPlatform>>(new Set<MultiSearchPlatform>(['tiktok', 'xhs', 'twitter']));
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<JobRow[]>([]);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { brands, setBrands } = useSocialBrands();
  const [brandSlug, setBrandSlug] = useState('');
  // XHS/X still only auto-detect the 3 own brands regardless of what's
  // picked here — previously only disclosed in the paragraph above the
  // pills, easy to miss. Surfaced directly on the pills themselves when it's
  // actually relevant (a competitor is picked), not as a blanket disclaimer.
  const selectedIsCompetitor = brands.find((b) => b.slug === brandSlug)?.type === 'competitor';
  // Each platform's manual triggers share one persistent-Chrome-profile lock
  // (see Account Management tab) — a second launch while one's already
  // running just blocks silently on that lock, no crash but no feedback
  // either. Block it here instead of leaving the user staring at "Starting…".
  const runningFamilies = useRunningPlatformFamilies();
  const selectedBusy = Array.from(selected).filter((p) => runningFamilies.has(p));

  function togglePlatform(p: MultiSearchPlatform) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  async function handleRun() {
    setError('');
    if (!brandSlug) { setError('Select a brand first.'); return; }
    if (!keyword.trim()) { setError('Enter a keyword first.'); return; }
    if (selected.size === 0) { setError('Pick at least one platform.'); return; }
    if (selectedBusy.length > 0) { setError(`${selectedBusy.join(', ')} already running elsewhere — wait for it to finish or deselect it.`); return; }
    setRunning(true);
    try {
      const res = await triggerMultiSearch(keyword.trim(), Array.from(selected), brandSlug);
      setRows(res.jobs.map((j) => ({ ...j, status: null })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start search');
      setRunning(false);
    }
  }

  // Cooperative — the scraper notices between steps (keyword/scroll), not
  // instantly, so the row's status may still say "running" for a moment
  // after this resolves. The next status poll (below) picks up 'cancelled'.
  async function handleStop(jobId: string) {
    setStoppingIds((prev) => new Set(prev).add(jobId));
    try {
      await stopScrapeJob(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop job');
    } finally {
      setStoppingIds((prev) => { const next = new Set(prev); next.delete(jobId); return next; });
    }
  }

  // Poll every 3s while any job is still running.
  useEffect(() => {
    if (rows.length === 0) return;
    const hasRunning = rows.some((r) => !r.status || r.status.status === 'running');
    if (!hasRunning) { setRunning(false); return; }

    pollRef.current = setInterval(async () => {
      const updated = await Promise.all(
        rows.map(async (r) => {
          if (r.status && r.status.status !== 'running') return r;
          try {
            const status = await fetchScrapeJobStatus(r.jobId);
            return { ...r, status };
          } catch {
            return r;
          }
        }),
      );
      setRows(updated);
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return (
    <div className="card p-6">
      <div className="section-title mb-1">Multi-Platform Search</div>
      <div className="text-xs mb-4 text-muted">
        Run one keyword now across platforms — results save if they mention the brand you pick below.
        TikTok force-attributes every result to that brand (own or competitor). Xiaohongshu/X can&apos;t be scoped yet — they still auto-detect only MizuMi/Gentle Colors/Bomi from content regardless of this selection, so picking a competitor won&apos;t pull anything from those two.
      </div>

      <div className="mb-3">
        <BrandPicker
          brands={brands}
          value={brandSlug}
          onChange={setBrandSlug}
          onCreated={(b) => setBrands((prev) => [...prev, b])}
          newBrandDefaultType="competitor"
          disabled={running}
        />
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Keyword (e.g. ครีมกันแดดผิวแพ้ง่าย)"
          disabled={running}
          className="text-sm px-3 py-2 rounded-lg outline-none"
          style={{ border: '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)', minWidth: 260 }}
        />
        <button className="btn btn-primary" onClick={handleRun} disabled={running || !brandSlug || selectedBusy.length > 0}>
          {running ? 'Running…' : selectedBusy.length > 0 ? 'Platform busy…' : 'Run Search'}
        </button>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {PLATFORMS.map((p) => {
          const wontWork = selectedIsCompetitor && (p.value === 'xhs' || p.value === 'twitter');
          const familyBusy = runningFamilies.has(p.value);
          return (
            <button
              key={p.value}
              onClick={() => togglePlatform(p.value)}
              disabled={running}
              title={
                familyBusy ? `${p.label} is already running a job elsewhere — wait for it to finish.`
                : wontWork ? `${p.label} can't be scoped to a competitor yet — still only auto-detects MizuMi/Gentle Colors/Bomi from content, so this will find nothing for the competitor you picked.`
                : undefined
              }
              className={`filter-pill${selected.has(p.value) ? ' active' : ''}`}
              style={familyBusy ? { borderColor: 'var(--accent-danger)' } : wontWork ? { borderColor: 'var(--accent-warning)' } : undefined}
            >
              {p.label}{familyBusy ? ' ⏳' : wontWork ? ' ⚠' : ''}
            </button>
          );
        })}
        <span className="text-xs text-muted">Instagram not supported (no ad-hoc keyword search)</span>
      </div>

      {error && <div className="text-xs mb-3" style={{ color: 'var(--accent-danger)' }}>{error}</div>}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => {
            const s = r.status;
            const color = !s || s.status === 'running' ? 'var(--accent-warning)'
              : s.status === 'done' ? 'var(--accent-success)'
              : s.status === 'cancelled' ? 'var(--text-muted)'
              : 'var(--accent-danger)';
            const canStop = CANCELLABLE_PLATFORMS.has(r.platform) && (!s || s.status === 'running');
            const stopping = stoppingIds.has(r.jobId);
            return (
              <div key={r.jobId} className="flex items-center gap-2 text-xs rounded-lg px-3 py-2 bg-base">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="font-medium" style={{ color: 'var(--text-primary)', width: 80 }}>
                  {PLATFORMS.find((p) => p.value === r.platform)?.label ?? r.platform}
                </span>
                <span className="text-secondary flex-1">{s?.message ?? 'Starting…'}</span>
                {canStop && (
                  <button
                    className="text-xs font-medium px-2 py-0.5 rounded flex-shrink-0"
                    style={{ color: 'var(--accent-danger)', border: '1px solid var(--accent-danger)', opacity: stopping ? 0.5 : 1 }}
                    disabled={stopping}
                    onClick={() => handleStop(r.jobId)}
                  >
                    {stopping ? 'Stopping…' : 'Stop'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Ad-hoc feed scrape card ──────────────────────────────────────────────────
// Pull ALL recent posts from one specific account (own brand, competitor, or
// any other creator) by pasting a profile link or handle — not a keyword
// match. Posts attach to a competitor brand row (auto-created by slug if it
// doesn't exist yet). Platform picker mirrors Multi-Platform Search above;
// X/Twitter is excluded — it has no feed-scrape concept (no own-account post
// puller), only keyword search and campaign reply/quote scraping.
const FEED_SCRAPE_PLATFORMS: { value: FeedScrapePlatform; label: string; placeholder: string }[] = [
  { value: 'tiktok', label: 'TikTok', placeholder: 'tiktok.com/@handle or @handle' },
  { value: 'instagram', label: 'Instagram', placeholder: 'instagram.com/handle or @handle' },
  { value: 'xhs', label: 'Xiaohongshu', placeholder: 'Full xiaohongshu.com/user/profile/<id> URL' },
];

// Mirrors Settings → Thresholds "Feed max post age" presets — per-run override,
// doesn't touch the global default. XHS has no age-based cutoff (note/scroll
// caps only), so this row is hidden when XHS is selected.
const LOOKBACK_PRESETS = [30, 60, 90, 0] as const;

export function FeedScrapeCard() {
  const [platform, setPlatform] = useState<FeedScrapePlatform>('tiktok');
  const [input, setInput] = useState('');
  const { brands, setBrands } = useSocialBrands();
  const [brandSlug, setBrandSlug] = useState('');
  const [lookbackDays, setLookbackDays] = useState<number>(30);
  const [scrapeComments, setScrapeComments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const active = FEED_SCRAPE_PLATFORMS.find((p) => p.value === platform)!;
  const selectedBrand = brands.find((b) => b.slug === brandSlug);
  const runningFamilies = useRunningPlatformFamilies();
  const platformBusy = runningFamilies.has(platform);

  async function run() {
    if (!brandSlug) { setMsg({ kind: 'err', text: 'Select a brand first.' }); return; }
    if (!input.trim()) { setMsg({ kind: 'err', text: 'Enter a profile link or handle first.' }); return; }
    if (platformBusy) { setMsg({ kind: 'err', text: `${active.label} already running elsewhere — wait for it to finish.` }); return; }
    setBusy(true);
    setMsg(null);
    try {
      // Passing the selected brand's own (existing) name/slug means the
      // adhoc route's find-or-create-by-slug upsert always resolves to the
      // SAME row the picker already validated — it just refreshes that
      // brand's handle field, never creates a duplicate.
      const r = await triggerAdhocFeedScrape(platform, input.trim(), selectedBrand?.name, {
        lookbackDays: platform === 'xhs' ? undefined : lookbackDays,
        scrapeComments,
      });
      setMsg({ kind: 'ok', text: `Feed scrape started for ${r.handle ? `@${r.handle}` : r.brandSlug} (job ${r.jobId.slice(0, 8)}…)` });
      setInput('');
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to start feed scrape' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-6 mt-4">
      <div className="section-title mb-1">Feed Scrape</div>
      <div className="text-xs mb-4 text-muted">
        Pull all recent posts from one account by profile link or handle — not a keyword search. Select the brand these posts belong to, or create one inline if it isn&apos;t tracked yet.
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {FEED_SCRAPE_PLATFORMS.map((p) => {
          const familyBusy = runningFamilies.has(p.value);
          return (
            <button
              key={p.value}
              onClick={() => setPlatform(p.value)}
              disabled={busy}
              title={familyBusy ? `${p.label} is already running a job elsewhere — wait for it to finish.` : undefined}
              className={`filter-pill${platform === p.value ? ' active' : ''}`}
              style={familyBusy ? { borderColor: 'var(--accent-danger)' } : undefined}
            >
              {p.label}{familyBusy ? ' ⏳' : ''}
            </button>
          );
        })}
      </div>

      <div className="mb-3">
        <BrandPicker
          brands={brands}
          value={brandSlug}
          onChange={setBrandSlug}
          onCreated={(b) => setBrands((prev) => [...prev, b])}
          newBrandDefaultType="competitor"
          disabled={busy}
        />
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={active.placeholder}
          disabled={busy}
          className="text-sm px-3 py-2 rounded-lg outline-none"
          style={{ border: '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)', minWidth: 260 }}
        />
        <button className="btn btn-primary" onClick={run} disabled={busy || !brandSlug || platformBusy}>
          {busy ? 'Scraping…' : platformBusy ? 'Platform busy…' : 'Scrape Feed'}
        </button>
      </div>

      <div className="flex items-center gap-3 mb-3 flex-wrap">
        {platform !== 'xhs' && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted">Lookback:</span>
            {LOOKBACK_PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => setLookbackDays(d)}
                disabled={busy}
                className={`filter-pill${lookbackDays === d ? ' active' : ''}`}
              >
                {d === 0 ? 'All time' : `${d}d`}
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-secondary">
          <span className="toggle">
            <input type="checkbox" checked={scrapeComments} onChange={() => setScrapeComments((v) => !v)} disabled={busy} />
            <span className="toggle-track"></span>
            <span className="toggle-thumb"></span>
          </span>
          Scrape comments
        </label>
      </div>

      {msg && (
        <div className="text-xs" style={{ color: msg.kind === 'ok' ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
