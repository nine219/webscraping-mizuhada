'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  fetchCampaigns, createCampaign, patchCampaign, deleteCampaign, fetchCampaignSuggestions, fetchCampaignReport,
  removePostFromCampaign, triggerCampaignScrapeNow, trackCampaignLink,
  searchCampaignX, fetchTwitterPosts, fetchScrapeJobStatus,
  Campaign, CampaignSuggestions, CampaignReport, CampaignXSearchCandidate,
  ScrapeJobStatus, SearchXResult,
} from '@/lib/api';
import { useRunningPlatformFamilies } from '@/lib/use-running-platforms';
import { SpikeBadge } from '@/components/badges';
import DailyMentionsViewsChart from '@/components/charts/daily-mentions-views-chart';
import { SortableTh } from '@/components/sortable-th';
import type { SortDir } from '@/lib/use-client-sort';

const STATUS_META: Record<Campaign['status'], { label: string; color: string }> = {
  draft:  { label: 'Draft',  color: 'var(--text-muted)' },
  active: { label: 'Active', color: 'var(--accent-success)' },
  ended:  { label: 'Ended',  color: 'var(--accent-primary)' },
};

const SENTIMENT_META: Record<string, { label: string; color: string }> = {
  positive: { label: 'Positive', color: 'var(--sentiment-positive)' },
  neutral:  { label: 'Neutral',  color: '#94a3b8' },
  negative: { label: 'Negative', color: 'var(--sentiment-negative)' },
  question: { label: 'Question', color: '#8b5cf6' },
  resale:   { label: 'Resale',   color: '#6366f1' },
};

// Shared poll for the async job types below (track-link, search-x) — 1s
// interval matches the scraper container's own claim-poll cadence
// (queue-worker.ts POLL_MS), so this stays close to the old synchronous-
// request feel rather than adding a second, unrelated lag on top.
function pollScrapeJob(
  jobId: string,
  onDone: (job: ScrapeJobStatus) => void,
  onError: (job: ScrapeJobStatus | null) => void,
): void {
  const poll = setInterval(async () => {
    try {
      const job = await fetchScrapeJobStatus(jobId);
      if (job.status === 'done') { clearInterval(poll); onDone(job); }
      else if (job.status === 'error' || job.status === 'cancelled') { clearInterval(poll); onError(job); }
    } catch {
      clearInterval(poll); onError(null);
    }
  }, 1_000);
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ends_at IS NULL with a starts_at set means "ongoing" (no defined end date),
// distinct from a campaign that has no dates configured at all.
function fmtEnd(startsAt: string | null, endsAt: string | null): string {
  if (!endsAt && startsAt) return 'ongoing';
  return fmtDate(endsAt);
}

// Splits on commas, whitespace, or newlines; strips a leading # or @ so the
// same input box works whether the user pastes "#mizumixphuwin" or types
// "mizumixphuwin, mizumipromo".
function splitTokens(input: string, stripChar: '#' | '@'): string[] {
  return input
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(new RegExp(`^\\${stripChar}`), ''))
    .filter((t) => t.length > 0);
}

function SentimentBar({ counts }: { counts: CampaignReport['sentiment']['combined'] }) {
  const { positive, negative, neutral, question, resale, total } = counts;
  if (total === 0) return <p className="text-xs text-muted">No sentimented rows yet.</p>;
  const pct = (n: number) => Math.round((n / total) * 100);
  const rows = [
    { key: 'positive', n: positive },
    { key: 'neutral', n: neutral },
    { key: 'negative', n: negative },
    { key: 'question', n: question },
    { key: 'resale', n: resale },
  ].filter((r) => r.n > 0);
  return (
    <div>
      <div className="flex rounded overflow-hidden mb-2" style={{ height: 10 }}>
        {rows.map((r) => (
          <div key={r.key} style={{ width: `${pct(r.n)}%`, background: SENTIMENT_META[r.key].color }} />
        ))}
      </div>
      <div className="flex gap-3 text-xs flex-wrap">
        {rows.map((r) => (
          <span key={r.key} className="flex items-center gap-1">
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: SENTIMENT_META[r.key].color }} />
            <span className="text-muted">{SENTIMENT_META[r.key].label}</span>
            <span className="font-semibold text-primary">{pct(r.n)}%</span>
            <span className="text-muted">({r.n})</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── List view (campaigns table + create form + suggested-campaign clusters) ─

function CampaignsListView({ onOpen }: { onOpen: (id: number) => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState('');
  const [hashtagsInput, setHashtagsInput] = useState('');
  const [handlesInput, setHandlesInput] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [ongoing, setOngoing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Suggest-then-verify (scope decision 4): one pass over MizuMi's feed
  // suggests hashtags + @mention handles + volume clusters. Nothing is
  // auto-applied — clicking a chip/cluster just seeds the form for the user
  // to confirm/edit before submitting.
  const [suggestions, setSuggestions] = useState<CampaignSuggestions | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  function loadCampaigns() {
    setLoading(true);
    fetchCampaigns()
      .then((r) => setCampaigns(r.data))
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false));
  }

  async function handleDelete(c: Campaign) {
    setOpenMenuId(null);
    if (!confirm(`Delete campaign "${c.name}"? Anchor posts and their scraped replies/quotes stay in the database, just unassigned from this campaign. This cannot be undone.`)) return;
    setDeletingId(c.id);
    try {
      await deleteCampaign(c.id);
      loadCampaigns();
    } catch {
      alert('Failed to delete campaign — check the API is reachable.');
    } finally {
      setDeletingId(null);
    }
  }

  const loadSuggestions = useCallback(() => {
    setSuggestLoading(true);
    setSuggestError(null);
    fetchCampaignSuggestions()
      .then(setSuggestions)
      .catch(() => setSuggestError('Could not load suggestions — is the MizuMi feed scraper running?'))
      .finally(() => setSuggestLoading(false));
  }, []);

  useEffect(loadCampaigns, []);
  useEffect(loadSuggestions, [loadSuggestions]);

  function addHashtagChip(tag: string) {
    const current = splitTokens(hashtagsInput, '#');
    if (current.includes(tag)) return;
    setHashtagsInput([...current, tag].join(', '));
  }
  function addHandleChip(handle: string) {
    const current = splitTokens(handlesInput, '@');
    if (current.includes(handle)) return;
    setHandlesInput([...current, handle].join(', '));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setFormError('Name is required'); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await createCampaign({
        name: name.trim(),
        hashtags: splitTokens(hashtagsInput, '#'),
        ambassador_handles: splitTokens(handlesInput, '@'),
        starts_at: startsAt || null,
        ends_at: ongoing ? null : (endsAt || null),
      });
      setShowForm(false);
      setName(''); setHashtagsInput(''); setHandlesInput(''); setStartsAt(''); setEndsAt(''); setOngoing(false);
      loadCampaigns();
      loadSuggestions();
      // Confirmed campaign — immediately scrape replies/quotes for its
      // just-assigned posts instead of waiting for the next 6h cron tick.
      // Fire-and-forget: the detail view's own "Scrape Now" button covers
      // tracking progress if the user wants to watch it.
      triggerCampaignScrapeNow(res.campaign.id).catch(() => {});
      onOpen(res.campaign.id);
    } catch {
      setFormError('Failed to create campaign — check the API is reachable.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted">
          MizuMi ambassador &amp; hashtag campaigns on X (Twitter) — anchor posts, replies, quote tweets.
          Membership is manual: paste a post link in a campaign, or search X live for its hashtags.
        </p>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ New Campaign'}
        </button>
      </div>

      {showForm && (
        <div className="card p-6 mb-6">
          <div className="section-title mb-4">New Campaign</div>

          {suggestError && (
            <div className="text-xs mb-4" style={{ color: 'var(--accent-danger)' }}>{suggestError}</div>
          )}

          {suggestLoading ? (
            <p className="text-xs text-muted mb-4">Loading suggestions…</p>
          ) : suggestions && (
            <div className="grid grid-cols-2 gap-4 mb-5">
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                <div className="text-xs font-semibold mb-2 text-secondary">Suggested hashtags</div>
                {suggestions.hashtags.length === 0 ? (
                  <p className="text-xs text-muted">No unclaimed hashtags found on the MizuMi feed yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.hashtags.map((h) => (
                      <button
                        key={h.hashtag}
                        type="button"
                        onClick={() => addHashtagChip(h.hashtag)}
                        className="text-xs font-mono px-2 py-1 rounded-full"
                        style={{ background: 'var(--accent-primary-subtle)', color: 'var(--accent-primary)', border: '1px solid transparent' }}
                      >
                        #{h.hashtag} <span style={{ opacity: 0.65 }}>({h.count})</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                <div className="text-xs font-semibold mb-2 text-secondary">Suggested ambassador handles</div>
                {suggestions.ambassador_handles.length === 0 ? (
                  <p className="text-xs text-muted">No @mentions found on the MizuMi feed yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.ambassador_handles.map((a) => (
                      <button
                        key={a.handle}
                        type="button"
                        onClick={() => addHandleChip(a.handle)}
                        className="text-xs font-mono px-2 py-1 rounded-full"
                        style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}
                      >
                        @{a.handle} <span style={{ opacity: 0.65 }}>({a.count})</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="grid gap-4 mb-4 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label className="text-xs font-medium mb-1.5 block text-secondary">Campaign name</label>
                <input
                  className="select" style={{ width: '100%' }}
                  value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. MizuMi x Phuwin Summer Push"
                />
              </div>
              <div className="grid gap-4 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <label className="text-xs font-medium mb-1.5 block text-secondary">Starts</label>
                  <input type="date" className="select" style={{ width: '100%' }} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-secondary">Ends</label>
                    <label className="flex items-center gap-1 text-xs text-muted cursor-pointer">
                      <input type="checkbox" checked={ongoing} onChange={(e) => setOngoing(e.target.checked)} />
                      Ongoing
                    </label>
                  </div>
                  <input
                    type="date" className="select" style={{ width: '100%' }}
                    value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
                    disabled={ongoing}
                    placeholder={ongoing ? 'No end date' : undefined}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-4 mb-4 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label className="text-xs font-medium mb-1.5 block text-secondary">Hashtags (comma or space separated)</label>
                <input
                  className="select" style={{ width: '100%' }}
                  value={hashtagsInput} onChange={(e) => setHashtagsInput(e.target.value)}
                  placeholder="mizumixphuwin, mizumisummer"
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1.5 block text-secondary">Ambassador handles</label>
                <input
                  className="select" style={{ width: '100%' }}
                  value={handlesInput} onChange={(e) => setHandlesInput(e.target.value)}
                  placeholder="phuwin_p, pond_naravit"
                />
              </div>
            </div>

            {formError && <div className="text-xs mb-3" style={{ color: 'var(--accent-danger)' }}>{formError}</div>}

            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Campaign'}
            </button>
          </form>
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">🐦</div>
            <p className="font-medium mb-1 text-primary">No campaigns yet</p>
            <p className="text-sm text-muted">Create one above, optionally seeded from a suggestion.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Hashtags</th>
                  <th>Ambassadors</th>
                  <th>Window</th>
                  <th style={{ textAlign: 'right' }}>Anchor Posts</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const meta = STATUS_META[c.status];
                  return (
                    <tr
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => onOpen(c.id)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ fontWeight: 500 }}>{c.name}</td>
                      <td>
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                          style={{ background: `${meta.color}1a`, color: meta.color }}>
                          {meta.label}
                        </span>
                      </td>
                      <td>
                        {c.hashtags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {c.hashtags.slice(0, 3).map((h) => (
                              <span key={h} className="text-xs font-mono" style={{ color: 'var(--accent-primary)' }}>#{h}</span>
                            ))}
                            {c.hashtags.length > 3 && <span className="text-xs text-muted">+{c.hashtags.length - 3}</span>}
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td>
                        {c.ambassador_handles.length > 0 ? (
                          <span className="text-xs text-secondary">
                            {c.ambassador_handles.slice(0, 2).map((h) => `@${h}`).join(', ')}
                            {c.ambassador_handles.length > 2 ? ` +${c.ambassador_handles.length - 2}` : ''}
                          </span>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {fmtDate(c.starts_at)} – {fmtEnd(c.starts_at, c.ends_at)}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>{c.post_count ?? 0}</td>
                      <td style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn btn-sm"
                          style={{ padding: '2px 8px' }}
                          disabled={deletingId === c.id}
                          onClick={() => setOpenMenuId((v) => (v === c.id ? null : c.id))}
                        >
                          ⋯
                        </button>
                        {openMenuId === c.id && (
                          <>
                            <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setOpenMenuId(null)} />
                            <div
                              className="card"
                              style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, minWidth: 140, padding: 4 }}
                            >
                              {/* Opening the report previously required clicking the
                                  row body itself — nothing in the menu indicated the
                                  row was clickable, and the menu's only entry was
                                  Delete. Explicit entry here too. */}
                              <button
                                className="w-full text-left text-sm px-3 py-2 rounded"
                                style={{ color: 'var(--text-primary)' }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                                onClick={() => { setOpenMenuId(null); onOpen(c.id); }}
                              >
                                View report
                              </button>
                              <button
                                className="w-full text-left text-sm px-3 py-2 rounded"
                                style={{ color: 'var(--accent-danger)' }}
                                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-base)')}
                                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                                onClick={() => handleDelete(c)}
                              >
                                Delete campaign
                              </button>
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail view (single campaign report) ─────────────────────────────────

function CampaignDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // campaign-report.ts's top_anchor_posts doesn't carry spike_flag — GET
  // /api/twitter/posts (twitter.ts) does, and already supports ?campaign_id=,
  // so this is a second small fetch scoped to just this campaign's posts
  // rather than a backend change. Keyed by post_id to look up per anchor row.
  const [spikeMap, setSpikeMap] = useState<Map<string, boolean>>(new Map());
  const [busyPostId, setBusyPostId] = useState<string | null>(null);
  const [scrapeStatus, setScrapeStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  // Reply/quote scraping shares the same persistent Twitter/X Chrome profile
  // as the keyword search trigger (Account Management tab) and every other
  // campaign's scrape — a second launch just blocks silently on that lock.
  const runningFamilies = useRunningPlatformFamilies();
  const twitterBusy = runningFamilies.has('twitter');
  const [trackUrl, setTrackUrl] = useState('');
  const [tracking, setTracking] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editHashtagsInput, setEditHashtagsInput] = useState('');
  const [editHandlesInput, setEditHandlesInput] = useState('');
  const [editStartsAt, setEditStartsAt] = useState('');
  const [editEndsAt, setEditEndsAt] = useState('');
  const [editOngoing, setEditOngoing] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [searchingX, setSearchingX] = useState(false);
  const [searchXError, setSearchXError] = useState<string | null>(null);
  const [xCandidates, setXCandidates] = useState<CampaignXSearchCandidate[] | null>(null);
  const [trackingXCandidateId, setTrackingXCandidateId] = useState<string | null>(null);
  const [xCandidatesPage, setXCandidatesPage] = useState(1);
  const X_CANDIDATES_PAGE_SIZE = 10;
  const [quoteAnchorFilter, setQuoteAnchorFilter] = useState<string>('');
  const [quoteTweetsPage, setQuoteTweetsPage] = useState(1);
  const QUOTE_TWEETS_PAGE_SIZE = 20;
  // Plain state, not useClientSort — that hook can't be called below this
  // component's `if (loading) return …` / `if (error || !report) return …`
  // early exits (load() re-sets loading=true on refresh, so this component
  // really can re-render through those branches after mount, not just once —
  // a hook call reached only past them would violate the rules of hooks).
  const [quoteTweetsSortKey, setQuoteTweetsSortKey] = useState<string | null>(null);
  const [quoteTweetsSortDir, setQuoteTweetsSortDir] = useState<SortDir>('desc');
  function requestQuoteTweetsSort(key: string) {
    if (quoteTweetsSortKey === key) setQuoteTweetsSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setQuoteTweetsSortKey(key); setQuoteTweetsSortDir('desc'); }
    setQuoteTweetsPage(1);
  }

  const load = useCallback(() => {
    setLoading(true);
    fetchCampaignReport(id)
      .then(setReport)
      .catch(() => setError('Campaign not found or the API is unreachable.'))
      .finally(() => setLoading(false));
    fetchTwitterPosts({ campaign_id: id })
      .then((res) => setSpikeMap(new Map(res.data.map((p) => [p.post_id, p.spike_flag]))))
      .catch(() => setSpikeMap(new Map()));
  }, [id]);

  useEffect(load, [load]);


  async function handleRemovePost(postId: string) {
    setBusyPostId(postId);
    try {
      await removePostFromCampaign(id, postId);
      load();
    } catch {
      setError('Failed to remove post.');
    } finally {
      setBusyPostId(null);
    }
  }

  async function handleScrapeNow() {
    if (twitterBusy) return; // guarded by disabled state below too — belt and suspenders
    setScrapeStatus('running');
    try {
      const { jobId } = await triggerCampaignScrapeNow(id);
      const poll = setInterval(async () => {
        try {
          const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/scrape/status/${jobId}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
          const job = await res.json() as { status: string };
          if (job.status === 'done') { setScrapeStatus('done'); clearInterval(poll); load(); }
          if (job.status === 'error') { setScrapeStatus('error'); clearInterval(poll); }
        } catch { clearInterval(poll); setScrapeStatus('error'); }
      }, 3_000);
    } catch {
      setScrapeStatus('error');
    }
  }

  // Manual "paste an X link" flow — live-fetches the tweet to confirm it's
  // real before saving, then locks it to this campaign and kicks off its own
  // reply/quote scrape. More accurate than relying on hashtag auto-detection
  // when the user already knows exactly which post belongs to the campaign.
  async function handleTrackLink(e: React.FormEvent) {
    e.preventDefault();
    if (!trackUrl.trim()) return;
    setTracking(true);
    setTrackError(null);
    try {
      const { jobId } = await trackCampaignLink(id, trackUrl.trim());
      setTrackUrl('');
      setScrapeStatus('running');
      // Stays 'tracking' until the worker actually verifies+locks the tweet,
      // not just until the enqueue POST resolves (which is near-instant) —
      // otherwise the button would look done while nothing has happened yet.
      pollScrapeJob(
        jobId,
        () => { setScrapeStatus('done'); load(); setTracking(false); },
        (job) => {
          setScrapeStatus('error');
          setTrackError(job?.message || 'Could not verify that link — check the X session is valid and the URL looks like x.com/<handle>/status/<id>.');
          setTracking(false);
        },
      );
    } catch {
      setTrackError('Could not verify that link — check the X session is valid and the URL looks like x.com/<handle>/status/<id>.');
      setTracking(false);
    }
  }

  // Live X-wide search — ANY author, but each search requires BOTH #mizumi
  // AND the campaign hashtag together (X treats space-separated terms as
  // AND), so a post has to actually reference MizuMi, not just the generic
  // fan hashtag, to show up here. Candidates are live/unverified, so
  // tracking one goes through trackCampaignLink (live-verify+lock+scrape),
  // not the plain local lock used by the MizuMi-own-posts search above.
  async function handleSearchX() {
    setSearchingX(true);
    setSearchXError(null);
    try {
      const { jobId } = await searchCampaignX(id);
      pollScrapeJob(
        jobId,
        (job) => {
          const result = job.result as SearchXResult | undefined;
          setXCandidates(result?.candidates ?? []);
          setXCandidatesPage(1);
          setSearchingX(false);
        },
        (job) => {
          setSearchXError(job?.message || 'Could not search X — check the session is valid, or the campaign has hashtags set.');
          setSearchingX(false);
        },
      );
    } catch {
      setSearchXError('Could not search X — check the session is valid, or the campaign has hashtags set.');
      setSearchingX(false);
    }
  }

  async function handleTrackXCandidate(url: string, candidateId: string) {
    setTrackingXCandidateId(candidateId);
    try {
      const { jobId } = await trackCampaignLink(id, url);
      // Optimistic: drop the candidate from the list as soon as tracking
      // starts, same as before — the job itself still runs in the
      // background, poll below just settles scrapeStatus/refreshes the post
      // list once it's actually done.
      setXCandidates((prev) => {
        const next = prev?.filter((c) => c.id !== candidateId) ?? null;
        const maxPage = Math.max(1, Math.ceil((next?.length ?? 0) / X_CANDIDATES_PAGE_SIZE));
        setXCandidatesPage((p) => Math.min(p, maxPage));
        return next;
      });
      setScrapeStatus('running');
      setTrackingXCandidateId(null);
      pollScrapeJob(
        jobId,
        () => { setScrapeStatus('done'); load(); },
        (job) => {
          setScrapeStatus('error');
          setSearchXError(job?.message || 'Failed to track that post — check the X session is valid.');
        },
      );
    } catch {
      setSearchXError('Failed to track that post — check the X session is valid.');
      setTrackingXCandidateId(null);
    }
  }

  function openEdit() {
    if (!report) return;
    const c = report.campaign;
    setEditName(c.name);
    setEditHashtagsInput(c.hashtags.join(', '));
    setEditHandlesInput(''); // ambassador_handles not in the report shape — leave blank, PATCH omits unset fields
    setEditStartsAt(c.starts_at ? c.starts_at.slice(0, 10) : '');
    setEditEndsAt(c.ends_at ? c.ends_at.slice(0, 10) : '');
    setEditOngoing(!!c.starts_at && !c.ends_at);
    setEditError(null);
    setEditing(true);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editName.trim()) { setEditError('Name is required'); return; }
    setEditSubmitting(true);
    setEditError(null);
    try {
      await patchCampaign(id, {
        name: editName.trim(),
        hashtags: splitTokens(editHashtagsInput, '#'),
        ...(editHandlesInput.trim() ? { ambassador_handles: splitTokens(editHandlesInput, '@') } : {}),
        starts_at: editStartsAt || null,
        ends_at: editOngoing ? null : (editEndsAt || null),
      });
      setEditing(false);
      load();
    } catch {
      setEditError('Failed to save changes — check the API is reachable.');
    } finally {
      setEditSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="card p-6">
        <p className="text-sm" style={{ color: 'var(--accent-danger)' }}>{error ?? 'Campaign not found.'}</p>
        <button className="btn btn-sm mt-3" onClick={onBack}>← Back to Campaigns</button>
      </div>
    );
  }

  const { campaign, reach, sentiment, hashtag_volume_curve, top_anchor_posts, top_quote_tweets, top_amplifiers } = report;
  const meta = STATUS_META[campaign.status];
  const isEnded = campaign.status === 'ended';

  const dailyChartData = hashtag_volume_curve.map((d) => ({
    date: d.date, post_count: d.count, total_views: 0, total_engagement: 0,
  }));

  const filteredQuoteTweets = quoteAnchorFilter
    ? top_quote_tweets.filter((q) => q.anchor_post_id === quoteAnchorFilter)
    : top_quote_tweets;

  const QUOTE_TWEETS_ACCESSORS: Record<string, (q: (typeof top_quote_tweets)[number]) => string | number | null> = {
    author: (q) => q.author_name,
    views: (q) => q.views,
    likes: (q) => q.likes,
    retweets: (q) => q.retweets,
    posted: (q) => q.published_at,
  };
  const sortedQuoteTweets = quoteTweetsSortKey && QUOTE_TWEETS_ACCESSORS[quoteTweetsSortKey]
    ? [...filteredQuoteTweets].sort((a, b) => {
        const getter = QUOTE_TWEETS_ACCESSORS[quoteTweetsSortKey];
        const av = getter(a);
        const bv = getter(b);
        let cmp: number;
        if (av == null && bv == null) cmp = 0;
        else if (av == null) cmp = -1;
        else if (bv == null) cmp = 1;
        else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return quoteTweetsSortDir === 'asc' ? cmp : -cmp;
      })
    : filteredQuoteTweets;

  const quoteTweetsMaxPage = Math.max(1, Math.ceil(sortedQuoteTweets.length / QUOTE_TWEETS_PAGE_SIZE));
  const pagedQuoteTweets = sortedQuoteTweets.slice(
    (quoteTweetsPage - 1) * QUOTE_TWEETS_PAGE_SIZE,
    quoteTweetsPage * QUOTE_TWEETS_PAGE_SIZE,
  );

  return (
    <div>
      <button className="text-xs text-muted mb-3" onClick={onBack}>← All Campaigns</button>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold text-primary">{campaign.name}</h2>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: `${meta.color}1a`, color: meta.color }}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {scrapeStatus === 'done' && <span className="text-xs" style={{ color: 'var(--accent-success)' }}>Scrape done ✓</span>}
          {scrapeStatus === 'error' && <span className="text-xs" style={{ color: 'var(--accent-danger)' }}>Scrape failed</span>}
          <button className="btn btn-sm" onClick={() => (editing ? setEditing(false) : openEdit())}>
            {editing ? 'Cancel Edit' : 'Edit'}
          </button>
          <button
            className="btn btn-sm"
            disabled={scrapeStatus === 'running' || twitterBusy}
            title={twitterBusy ? 'X/Twitter is already running a job elsewhere — wait for it to finish.' : undefined}
            onClick={handleScrapeNow}
          >
            {scrapeStatus === 'running' ? 'Scraping replies/quotes…' : twitterBusy ? 'X busy elsewhere…' : 'Scrape Now'}
          </button>
        </div>
      </div>
      <p className="text-sm text-muted mb-5">
        {isEnded ? 'Final report' : 'Live report'} · {fmtDate(campaign.starts_at)} – {fmtEnd(campaign.starts_at, campaign.ends_at)}
        {campaign.hashtags.length > 0 && <> · {campaign.hashtags.map((h) => `#${h}`).join(' ')}</>}
      </p>

      {editing && (
        <div className="card p-6 mb-6">
          <div className="section-title mb-4">Edit Campaign</div>
          <form onSubmit={handleEditSubmit}>
            <div className="grid gap-4 mb-4 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label className="text-xs font-medium mb-1.5 block text-secondary">Campaign name</label>
                <input
                  className="select" style={{ width: '100%' }}
                  value={editName} onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="grid gap-4 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <label className="text-xs font-medium mb-1.5 block text-secondary">Starts</label>
                  <input type="date" className="select" style={{ width: '100%' }} value={editStartsAt} onChange={(e) => setEditStartsAt(e.target.value)} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-secondary">Ends</label>
                    <label className="flex items-center gap-1 text-xs text-muted cursor-pointer">
                      <input type="checkbox" checked={editOngoing} onChange={(e) => setEditOngoing(e.target.checked)} />
                      Ongoing
                    </label>
                  </div>
                  <input
                    type="date" className="select" style={{ width: '100%' }}
                    value={editEndsAt} onChange={(e) => setEditEndsAt(e.target.value)}
                    disabled={editOngoing}
                  />
                </div>
              </div>
            </div>

            <div className="grid gap-4 mb-4 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label className="text-xs font-medium mb-1.5 block text-secondary">Hashtags (comma or space separated)</label>
                <input
                  className="select" style={{ width: '100%' }}
                  value={editHashtagsInput} onChange={(e) => setEditHashtagsInput(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1.5 block text-secondary">
                  Ambassador handles <span className="text-muted">(leave blank to keep unchanged)</span>
                </label>
                <input
                  className="select" style={{ width: '100%' }}
                  value={editHandlesInput} onChange={(e) => setEditHandlesInput(e.target.value)}
                  placeholder="phuwin_p, pond_naravit"
                />
              </div>
            </div>

            {editError && <div className="text-xs mb-3" style={{ color: 'var(--accent-danger)' }}>{editError}</div>}

            <button type="submit" className="btn btn-primary" disabled={editSubmitting}>
              {editSubmitting ? 'Saving…' : 'Save Changes'}
            </button>
          </form>
        </div>
      )}

      {/* Reach — owned vs earned, kept visually separate per honest-provenance decision */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-5" style={{ borderLeft: '3px solid var(--accent-primary)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="stat-label">Owned Reach</div>
            <span className="text-[10px] text-muted" title="MizuMi + ambassador anchor posts, plus their replies and quote tweets">
              anchor posts + replies/quotes
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="stat-value" style={{ fontSize: 22, color: 'var(--accent-primary)' }}>{reach.owned.anchor_posts.count}</div>
              <div className="text-xs text-muted">Anchor posts</div>
            </div>
            <div>
              <div className="stat-value" style={{ fontSize: 22 }}>{reach.owned.replies_count}</div>
              <div className="text-xs text-muted">Replies</div>
            </div>
            <div>
              <div className="stat-value" style={{ fontSize: 22 }}>{reach.owned.quote_tweets_count}</div>
              <div className="text-xs text-muted">Quote tweets</div>
            </div>
          </div>
          <div className="flex gap-4 mt-3 text-xs text-muted">
            <span>{fmt(reach.owned.anchor_posts.views)} views</span>
            <span>{fmt(reach.owned.anchor_posts.likes)} likes</span>
            <span>{fmt(reach.owned.anchor_posts.retweets)} retweets</span>
          </div>
        </div>

        <div className="card p-5" style={{ borderLeft: '3px solid var(--accent-success)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="stat-label">Earned Reach</div>
            <span className="text-[10px] text-muted" title="Third-party hashtag-UGC — counted, not deep-scraped">
              hashtag-UGC (counts only)
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="stat-value" style={{ fontSize: 22, color: 'var(--accent-success)' }}>{reach.earned.ugc_count}</div>
              <div className="text-xs text-muted">UGC posts</div>
            </div>
            <div>
              <div className="stat-value" style={{ fontSize: 22 }}>{fmt(reach.earned.views)}</div>
              <div className="text-xs text-muted">Views</div>
            </div>
            <div>
              <div className="stat-value" style={{ fontSize: 22 }}>{fmt(reach.earned.likes)}</div>
              <div className="text-xs text-muted">Likes</div>
            </div>
          </div>
          <div className="flex gap-4 mt-3 text-xs text-muted">
            <span>{fmt(reach.earned.retweets)} retweets</span>
          </div>
        </div>
      </div>

      {/* Sentiment + volume curve */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-5">
          <div className="stat-label mb-3">Sentiment — replies + quotes + hashtag-UGC combined</div>
          <SentimentBar counts={sentiment.combined} />
        </div>
        <div className="card p-5">
          <div className="stat-label mb-3">Hashtag Volume Curve</div>
          <div style={{ height: 180 }}>
            {hashtag_volume_curve.length > 1 ? (
              <DailyMentionsViewsChart data={dailyChartData} />
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted">Not enough data yet</div>
            )}
          </div>
        </div>
      </div>

      {/* Search X (live) — any author, but requires #mizumi AND the campaign
          hashtag together to control noise. Unverified candidates, so
          Track goes through the live-verify path (trackCampaignLink). */}
      <div className="card p-5 mb-6">
        <div className="flex items-center justify-between mb-1">
          <div className="stat-label">Search X (live, any author)</div>
          <button className="btn btn-sm" disabled={searchingX || campaign.hashtags.length === 0} onClick={handleSearchX}>
            {searchingX ? 'Searching X…' : 'Search'}
          </button>
        </div>
        <div className="text-xs text-muted mb-3">
          Live-searches all of X for #mizumi + each campaign hashtag together (both required) — catches UGC from other accounts, not just MizuMi&apos;s own. Click Track to verify and save one.
        </div>
        {searchXError && <div className="text-xs mb-2" style={{ color: 'var(--accent-danger)' }}>{searchXError}</div>}
        {xCandidates && (
          xCandidates.length === 0 ? (
            <p className="text-xs text-muted">No new posts found for #mizumi + these hashtags.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {xCandidates.slice((xCandidatesPage - 1) * X_CANDIDATES_PAGE_SIZE, xCandidatesPage * X_CANDIDATES_PAGE_SIZE).map((c) => (
                <div key={c.id} className="p-3 rounded-lg flex items-center justify-between gap-3"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs text-secondary">@{c.author}</span>
                      {c.isRetweet && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                          style={{ background: 'var(--accent-warning-subtle, #fef3c7)', color: 'var(--accent-warning, #b45309)' }}
                          title="Reshare of another tweet — tracking it saves a separate anchor post under this retweet's own id."
                        >
                          ↺ Retweet
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted" style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480,
                    }}>
                      {c.content}
                    </div>
                    <div className="text-xs text-muted mt-0.5">
                      {fmt(c.likes)} likes · {fmt(c.retweets)} retweets{c.views != null ? ` · ${fmt(c.views)} views` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-xs" style={{ color: 'var(--accent-primary)' }}>View ↗</a>
                    <button
                      className="btn btn-sm"
                      disabled={trackingXCandidateId === c.id}
                      onClick={() => handleTrackXCandidate(c.url, c.id)}
                    >
                      {trackingXCandidateId === c.id ? 'Tracking…' : 'Track'}
                    </button>
                  </div>
                </div>
              ))}
              {xCandidates.length > X_CANDIDATES_PAGE_SIZE && (
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-muted">
                    Page {xCandidatesPage} of {Math.ceil(xCandidates.length / X_CANDIDATES_PAGE_SIZE)} · {xCandidates.length} results
                  </span>
                  <div className="flex gap-2">
                    <button className="btn btn-sm" disabled={xCandidatesPage <= 1} onClick={() => setXCandidatesPage((p) => p - 1)}>Prev</button>
                    <button className="btn btn-sm" disabled={xCandidatesPage >= Math.ceil(xCandidates.length / X_CANDIDATES_PAGE_SIZE)} onClick={() => setXCandidatesPage((p) => p + 1)}>Next</button>
                  </div>
                </div>
              )}
            </div>
          )
        )}
      </div>

      {/* Track by X link — live-verifies the tweet, then locks + scrapes it */}
      <div className="card p-5 mb-6">
        <div className="stat-label mb-1">Track by X link</div>
        <div className="text-xs text-muted mb-3">
          Paste a tweet URL — we&apos;ll fetch it live to confirm it&apos;s real, save it, and scrape its replies/quotes right away.
        </div>
        <form onSubmit={handleTrackLink} className="flex items-center gap-2">
          <input
            className="select" style={{ flex: 1, maxWidth: 420 }}
            value={trackUrl}
            onChange={(e) => setTrackUrl(e.target.value)}
            placeholder="https://x.com/handle/status/1234567890"
          />
          <button type="submit" className="btn btn-sm" disabled={tracking || !trackUrl.trim()}>
            {tracking ? 'Verifying…' : 'Track'}
          </button>
        </form>
        {trackError && <div className="text-xs mt-2" style={{ color: 'var(--accent-danger)' }}>{trackError}</div>}
      </div>

      {/* Top anchor posts */}
      <div className="card overflow-hidden mb-6">
        <div className="p-5 pb-0">
          <div className="section-title mb-1">Top Anchor Posts</div>
          <div className="text-xs text-muted mb-2">Ranked by likes + retweets + quotes + replies</div>
        </div>
        {top_anchor_posts.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted">No anchor posts assigned yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Author</th>
                  <th>Caption</th>
                  <th style={{ textAlign: 'right' }}>Views</th>
                  <th style={{ textAlign: 'right' }}>Likes</th>
                  <th style={{ textAlign: 'right' }}>Retweets</th>
                  <th style={{ textAlign: 'right' }} title="scraped / X-reported metadata">Quotes (scraped/meta)</th>
                  <th style={{ textAlign: 'right' }}>Replies</th>
                  <th>Posted</th>
                  <th>Spike</th>
                  <th>Link</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {top_anchor_posts.map((p) => (
                  <tr key={p.post_id}>
                    <td className="font-mono text-xs text-secondary">{p.author_handle ? `@${p.author_handle}` : '—'}</td>
                    <td style={{ maxWidth: 260 }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{p.caption_snippet ?? '—'}</span>
                    </td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.views)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.likes)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.retweets)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>
                      <span style={p.quotes_scraped < p.quotes ? { color: 'var(--accent-warning)' } : undefined}>
                        {fmt(p.quotes_scraped)}/{fmt(p.quotes)}
                      </span>
                    </td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(p.replies)}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(p.posted_at)}</td>
                    <td>
                      {spikeMap.get(p.post_id) ? <SpikeBadge active /> : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                    </td>
                    <td>
                      {p.post_url ? (
                        <a href={p.post_url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium" style={{ color: 'var(--accent-primary)' }}>View ↗</a>
                      ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                    </td>
                    <td>
                      <button
                        className="text-xs"
                        style={{ color: 'var(--accent-danger)' }}
                        disabled={busyPostId === p.post_id}
                        onClick={() => handleRemovePost(p.post_id)}
                      >
                        {busyPostId === p.post_id ? '…' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Top quote tweets */}
      <div className="card overflow-hidden mb-6">
        <div className="p-5 pb-0">
          <div className="flex items-center justify-between mb-1">
            <div className="section-title">Top Quote Tweets</div>
            {top_anchor_posts.length > 0 && (
              <select
                className="select" style={{ maxWidth: 280, fontSize: 12 }}
                value={quoteAnchorFilter}
                onChange={(e) => { setQuoteAnchorFilter(e.target.value); setQuoteTweetsPage(1); }}
              >
                <option value="">All anchor posts</option>
                {top_anchor_posts.map((p) => (
                  <option key={p.post_id} value={p.post_id}>
                    {(p.caption_snippet ?? p.post_id).slice(0, 50)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="text-xs text-muted mb-2">Ranked by likes + retweets + views</div>
        </div>
        {filteredQuoteTweets.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted">
            {quoteAnchorFilter ? 'No quote tweets captured for this anchor post.' : 'No quote tweets captured yet.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Quoting (anchor post)</th>
                  <SortableTh label="Author" sortKey="author" activeKey={quoteTweetsSortKey} dir={quoteTweetsSortDir} onSort={requestQuoteTweetsSort} />
                  <th>Content</th>
                  <th>Sentiment</th>
                  <SortableTh label="Views" sortKey="views" activeKey={quoteTweetsSortKey} dir={quoteTweetsSortDir} onSort={requestQuoteTweetsSort} align="right" />
                  <SortableTh label="Likes" sortKey="likes" activeKey={quoteTweetsSortKey} dir={quoteTweetsSortDir} onSort={requestQuoteTweetsSort} align="right" />
                  <SortableTh label="Retweets" sortKey="retweets" activeKey={quoteTweetsSortKey} dir={quoteTweetsSortDir} onSort={requestQuoteTweetsSort} align="right" />
                  <SortableTh label="Posted" sortKey="posted" activeKey={quoteTweetsSortKey} dir={quoteTweetsSortDir} onSort={requestQuoteTweetsSort} />
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {pagedQuoteTweets.map((q) => {
                  const sMeta = q.sentiment ? SENTIMENT_META[q.sentiment] : null;
                  return (
                    <tr key={q.external_id ?? Math.random()}>
                      <td style={{ maxWidth: 220, borderRight: '1px solid var(--border-light)' }}>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.4 }}>
                          {q.anchor_caption_snippet ?? '—'}
                        </span>
                        {q.anchor_post_url && (
                          <div>
                            <a href={q.anchor_post_url} target="_blank" rel="noopener noreferrer"
                              className="text-xs" style={{ color: 'var(--accent-primary)' }}>
                              View anchor ↗
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="font-mono text-xs text-secondary">{q.author_name ? `@${q.author_name}` : '—'}</td>
                      <td style={{ maxWidth: 300 }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{q.content_snippet ?? '—'}</span>
                      </td>
                      <td>
                        {sMeta ? (
                          <span className="text-[10px] font-medium" style={{ color: sMeta.color }}>{sMeta.label}</span>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                      <td className="price" style={{ textAlign: 'right' }}>{fmt(q.views)}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{fmt(q.likes)}</td>
                      <td className="price" style={{ textAlign: 'right' }}>{fmt(q.retweets)}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtDate(q.published_at)}</td>
                      <td>
                        {q.post_url ? (
                          <a href={q.post_url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium" style={{ color: 'var(--accent-primary)' }}>View ↗</a>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredQuoteTweets.length > QUOTE_TWEETS_PAGE_SIZE && (
              <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid var(--border-light)' }}>
                <span className="text-xs text-muted">
                  Page {quoteTweetsPage} of {quoteTweetsMaxPage} · {filteredQuoteTweets.length} results
                </span>
                <div className="flex gap-2">
                  <button className="btn btn-sm" disabled={quoteTweetsPage <= 1} onClick={() => setQuoteTweetsPage((p) => p - 1)}>Prev</button>
                  <button className="btn btn-sm" disabled={quoteTweetsPage >= quoteTweetsMaxPage} onClick={() => setQuoteTweetsPage((p) => p + 1)}>Next</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Top amplifiers */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-0">
          <div className="section-title mb-1">Top Amplifiers</div>
          <div className="text-xs text-muted mb-2">Quote-tweet + hashtag-UGC authors, ranked by combined reach</div>
        </div>
        {top_amplifiers.length === 0 ? (
          <div className="text-center py-10 text-sm text-muted">No amplifiers yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Author</th>
                  <th style={{ textAlign: 'right' }}>Posts</th>
                  <th style={{ textAlign: 'right' }}>Reach</th>
                  <th style={{ textAlign: 'right' }}>Followers</th>
                  <th>Top Post</th>
                </tr>
              </thead>
              <tbody>
                {top_amplifiers.map((a) => (
                  <tr key={a.author_name}>
                    <td>
                      <a href={`https://x.com/${a.author_name}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs font-medium" style={{ color: 'var(--accent-primary)' }}>
                        @{a.author_name}
                      </a>
                    </td>
                    <td className="price" style={{ textAlign: 'right' }}>{a.post_count}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(a.total_reach)}</td>
                    <td className="price" style={{ textAlign: 'right' }}>{fmt(a.followers)}</td>
                    <td>
                      {a.top_post_url ? (
                        <a href={a.top_post_url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium" style={{ color: 'var(--accent-primary)' }}>View ↗</a>
                      ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CampaignsTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // A campaign's report previously only existed as client-side state
  // (openId) — no unique URL, so it couldn't be bookmarked, deep-linked, or
  // shared with a colleague the way a post-detail page can. Mirrored into
  // ?campaign=<id> alongside the existing ?tab=campaigns.
  const [openId, setOpenId] = useState<number | null>(() => {
    const c = searchParams.get('campaign');
    const n = c ? parseInt(c, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  });

  function openCampaign(id: number) {
    setOpenId(id);
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    next.set('campaign', String(id));
    router.push(`/x?${next.toString()}`);
  }

  function closeCampaign() {
    setOpenId(null);
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    next.delete('campaign');
    router.push(`/x?${next.toString()}`);
  }

  return openId == null
    ? <CampaignsListView onOpen={openCampaign} />
    : <CampaignDetailView id={openId} onBack={closeCampaign} />;
}
