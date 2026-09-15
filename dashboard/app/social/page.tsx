'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  fetchSocial, fetchSocialStats, fetchBrands, fetchSocialTopics,
  updateCommentSentiment,
  SocialComment, SocialStats, Brand, DateRange,
} from '@/lib/api';
import SentimentDonut from '@/components/charts/sentiment-donut';
import { FilterPills } from '@/components/filter-pills';
import { SearchInput } from '@/components/search-input';
import { DateRangePicker } from '@/components/date-range-picker';
import { ExportCsvButton } from '@/components/export-csv-button';
import { CsvColumn } from '@/lib/csv-export';

// Same conceptual action ("view the post this came from") previously behaved
// differently depending on where you started: Command Center/UGC Performance
// open the internal detail page (full comment/sentiment context in-app),
// while Social Listening always jumped straight to the external platform,
// losing all in-app context. TikTok/XHS/Instagram have internal detail
// pages; X/Twitter doesn't, so that one still goes external.
function internalPostHref(c: SocialComment): string | null {
  if (!c.post_id) return null;
  if (c.platform === 'tiktok') return `/tiktok/${c.post_id}`;
  if (c.platform === 'xiaohongshu') return `/xhs/${c.post_id}`;
  if (c.platform === 'instagram') return `/ig-post/${c.post_id}`;
  return null;
}

const EXPORT_COLUMNS: CsvColumn<SocialComment>[] = [
  { header: 'platform', value: (c) => c.platform },
  { header: 'brand', value: (c) => c.brand_name },
  { header: 'author', value: (c) => c.author_name ?? '' },
  { header: 'content', value: (c) => c.content },
  { header: 'sentiment', value: (c) => c.sentiment ?? '' },
  { header: 'urgency', value: (c) => c.urgency ?? '' },
  { header: 'topic', value: (c) => c.topic ?? '' },
  { header: 'likes', value: (c) => c.likes_count ?? '' },
  { header: 'published_at', value: (c) => c.published_at ?? '' },
  { header: 'post_url', value: (c) => c.post_url ?? '' },
];

const PLATFORM_COLORS: Record<string, string> = {
  tiktok: '#000000',
  instagram: '#E1306C',
  xiaohongshu: '#FF2442',
  twitter: '#000000',
};

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  xiaohongshu: 'Xiaohongshu',
  twitter: 'X (Twitter)',
};

const PLATFORMS = ['tiktok', 'instagram', 'xiaohongshu', 'twitter'];
const SENTIMENTS = ['positive', 'negative', 'neutral', 'question', 'resale'];

// content_translated is only ever populated when the sentiment classifier
// (src/analysis/sentiment.ts) decided the comment wasn't Thai/English and
// translated it — so its mere presence means "show it", regardless of which
// script/language the original was in (Chinese, Vietnamese, Malay, etc).
function displayContent(c: SocialComment) {
  const th = c.content_translated?.trim();
  if (th && th !== c.content.trim()) {
    return (
      <>
        {c.content}{' '}
        <span style={{ color: 'var(--accent-info)' }}>({th})</span>
      </>
    );
  }
  return c.content;
}

export default function SocialPage() {
  const router = useRouter();
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [stats, setStats] = useState<SocialStats | null>(null);
  const [scopedStats, setScopedStats] = useState<SocialStats | null>(null);
  // Empty array = no filter (equivalent to "all selected") — matches every
  // pill (including "All") showing active at once, not just a separate "All"
  // pill standing in for the rest.
  const [sentiment, setSentiment] = useState<string[]>([]);
  const [platform, setPlatform] = useState<string[]>([]);
  const [brandFilter, setBrandFilter] = useState('');
  // Free-text search — this page previously had zero text search (pill/date
  // filters only), unlike UGC Performance and TikTok UGC Search.
  const [searchQ, setSearchQ] = useState('');
  const [debouncedSearchQ, setDebouncedSearchQ] = useState('');
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [topicFilter, setTopicFilter] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState<number>(0);
  // Negative queue mode used to force urgency-first sort silently, with no
  // visible control — a comment from an earlier date could outrank a more
  // recent one with no explanation on screen. Date-first is now the default;
  // urgency is an explicit opt-in via the pill below.
  const [negativeSortMode, setNegativeSortMode] = useState<'date' | 'urgency'>('date');
  const [page, setPage] = useState(1);
  const [totalCommentRows, setTotalCommentRows] = useState(0);
  const [loading, setLoading] = useState(true);
  const [brandOptions, setBrandOptions] = useState<Brand[]>([]);
  const [editingSentimentId, setEditingSentimentId] = useState<number | null>(null);
  const [topicOptions, setTopicOptions] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const editorPopoverRef = useRef<HTMLDivElement | null>(null);

  // Filtering the sentiment pills down to exactly one sentiment unlocks a topic
  // filter scoped to that sentiment (fetched separately below). "Negative" additionally
  // switches the page into full queue mode: urgency sort, urgency filter chip, and the
  // right panel swaps to urgency distribution + negative-by-topic + negative-by-brand.
  // No separate tab — filtering to negative IS the queue.
  const activeSentiment = sentiment.length === 1 ? sentiment[0] : null;
  const negativeOnlyMode = activeSentiment === 'negative';

  useEffect(() => {
    fetchBrands().then((b) => setBrandOptions(b.filter((x) => x.type === 'own'))).catch(() => {});
    // Populates the manual-edit topic dropdown — real distinct values already
    // in use, not a hardcoded list, since the classifier assigns free-text topics.
    fetchSocialTopics().then(setTopicOptions).catch(() => setTopicOptions([]));
  }, []);

  // Click-outside / Escape closes the manual sentiment+topic editor popover.
  useEffect(() => {
    if (editingSentimentId == null) return;
    function onClick(e: MouseEvent) {
      if (editorPopoverRef.current && !editorPopoverRef.current.contains(e.target as Node)) {
        setEditingSentimentId(null);
      }
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setEditingSentimentId(null); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [editingSentimentId]);

  // Focus trap for the popover — without this, Tab past the last field (the
  // "Done" button) moved focus into the NEXT comment card's sentiment
  // button while this popover was still open and visually anchored to the
  // first comment, which is disorienting for keyboard users. Wraps Tab/
  // Shift+Tab between the popover's own focusable children instead.
  function trapPopoverTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const container = editorPopoverRef.current;
    if (!container) return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>('select, button'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Matches PAGE_LIMIT on every other list page (TikTok/XHS/Instagram feed
  // and search tabs) — was 30 here and on X Mentions, 24 on UGC Performance,
  // with no stated reason for the drift.
  const PAGE_LIMIT = 25;

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearchQ(searchQ); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchQ]);

  // Shared with handleCommentEdit's rollback-refetch below, so a failed
  // manual edit re-fetches under the exact same filters currently on screen
  // (sort/topic/urgency included) instead of a stale, differently-scoped
  // subset that silently drops the active queue/sort context.
  function currentFetchParams() {
    return {
      sentiment,
      platform,
      brand: brandFilter || undefined,
      ...range,
      page,
      sort: negativeOnlyMode && negativeSortMode === 'urgency' ? 'urgency' : undefined,
      topic: activeSentiment ? (topicFilter || undefined) : undefined,
      urgency: negativeOnlyMode ? (urgencyFilter || undefined) : undefined,
      search: debouncedSearchQ || undefined,
    };
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchSocial(currentFetchParams()),
      fetchSocialStats({ ...range, platform, brand: brandFilter || undefined }),
    ])
      .then(([c, s]) => { setComments(c.data); setTotalCommentRows(c.total); setStats(s); })
      .catch(() => { setComments([]); setStats(null); })
      .finally(() => setLoading(false));
  }, [negativeOnlyMode, activeSentiment, sentiment, platform, brandFilter, range, page, topicFilter, urgencyFilter, negativeSortMode, debouncedSearchQ]);

  // Topic filter pills (and, in negative's case, the full urgency/topic/brand queue
  // panel) are scoped to whichever single sentiment is active — matches what the
  // list actually shows, instead of the whole-page pos/neu/neg mix.
  useEffect(() => {
    if (!activeSentiment) { setScopedStats(null); return; }
    fetchSocialStats({ ...range, platform, brand: brandFilter || undefined, sentiment: activeSentiment })
      .then(setScopedStats)
      .catch(() => setScopedStats(null));
  }, [activeSentiment, platform, brandFilter, range]);

  // A topic (or urgency) picked while scoped to one sentiment doesn't
  // necessarily exist under a different one — drop both whenever the active
  // single-sentiment scope changes so a stale filter can't silently apply.
  useEffect(() => {
    setTopicFilter('');
    setUrgencyFilter(0);
    setNegativeSortMode('date');
  }, [activeSentiment]);

  // Multi-select toggle: click adds/removes from the selection. Empty
  // selection = "All" = no filter (shows everything), and once every option
  // is individually selected that's treated the same as "All" too.
  function toggleInArray(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }
  function handleSentimentToggle(v: string) { setSentiment((prev) => toggleInArray(prev, v)); setPage(1); }
  function handlePlatformToggle(v: string) { setPlatform((prev) => toggleInArray(prev, v)); setPage(1); }
  function handleSentimentClear() { setSentiment([]); setPage(1); }
  function handlePlatformClear() { setPlatform([]); setPage(1); }

  const handleCommentEdit = async (commentId: number, patch: { sentiment?: string | null; topic?: string | null }) => {
    setEditError(null);
    setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, ...patch } : c)));
    try {
      await updateCommentSentiment(commentId, patch);
    } catch {
      // Rollback: refetch under the exact filters currently on screen (not a
      // narrower ad-hoc subset) so a failed edit doesn't silently swap the
      // visible list out from under an active sort/topic/urgency queue.
      fetchSocial(currentFetchParams())
        .then((c) => setComments(c.data))
        .catch(() => {
          // Refetch also failed — the optimistic edit above is now showing a
          // value that was never actually saved, with nothing else on
          // screen indicating that. Surface it instead of failing silently.
          setEditError('Could not save your change — please retry.');
        });
    }
  };
  function handleBrandFilterChange(v: string) { setBrandFilter(v); setPage(1); }
  function handleRangeChange(v: DateRange) { setRange(v); setPage(1); }

  const totalPages = Math.max(1, Math.ceil(totalCommentRows / PAGE_LIMIT));

  const dist = stats?.sentimentDistribution ?? [];
  const positive = parseInt(dist.find((d) => d.sentiment === 'positive')?.count ?? '0');
  const negative = parseInt(dist.find((d) => d.sentiment === 'negative')?.count ?? '0');
  const neutral  = parseInt(dist.find((d) => d.sentiment === 'neutral')?.count ?? '0');
  const question = parseInt(dist.find((d) => d.sentiment === 'question')?.count ?? '0');
  const resale   = parseInt(dist.find((d) => d.sentiment === 'resale')?.count ?? '0');
  // Use totalComments from API — counts ALL comments regardless of sentiment analysis status
  const total = stats?.totalComments ?? (positive + negative + neutral + question + resale);

  const brandSentiment = stats?.brandSentiment ?? [];

  // scopedStats holds stats for whichever single sentiment is active (any of
  // positive/negative/neutral/question/resale) — feeds the topic filter pills
  // for all of them, plus the negative-only urgency/by-brand queue panels.
  const urgencyBuckets = [1, 2, 3, 4, 5].map((u) => ({
    urgency: u,
    count: parseInt(scopedStats?.urgencyDistribution.find((d) => Number(d.urgency) === u)?.count ?? '0', 10),
  }));
  const scopedTopics = (scopedStats?.topicDistribution ?? [])
    .map((t) => ({ topic: t.topic, count: parseInt(t.count, 10) }))
    .sort((a, b) => b.count - a.count);
  const negByBrand = (scopedStats?.brandSentiment ?? [])
    .map((b) => ({ brand_name: b.brand_name, count: parseInt(b.count, 10) }))
    .sort((a, b) => b.count - a.count);

  // Topic × sentiment: raw counts only. No invented "net" composite (SCOPE v3).
  const topicSent = (stats?.topicSentiment ?? [])
    .map((t) => {
      const p = parseInt(t.positive), n = parseInt(t.negative), nu = parseInt(t.neutral), tot = parseInt(t.total) || 1;
      return { topic: t.topic, p, n, nu, tot };
    })
    .sort((a, b) => b.tot - a.tot);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">Social Listening</h1>
          <p className="page-header-subtitle">
            {negativeOnlyMode
              ? (negativeSortMode === 'urgency' ? 'Negative-only view · sorted by urgency, most urgent first' : 'Negative-only view · sorted by date, most recent first')
              : 'Cross-platform mention stream — filter to Negative for the urgency-queue option'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ExportCsvButton
            fetchAll={() => fetchSocial({
              sentiment, platform, brand: brandFilter || undefined, ...range, limit: 100_000,
              sort: negativeOnlyMode && negativeSortMode === 'urgency' ? 'urgency' : undefined,
              topic: activeSentiment ? (topicFilter || undefined) : undefined,
              urgency: negativeOnlyMode ? (urgencyFilter || undefined) : undefined,
              search: debouncedSearchQ || undefined,
            }).then((r) => r.data)}
            columns={EXPORT_COLUMNS}
            filename={() => `social-comments-${brandFilter || 'all'}.csv`}
          />
          <span className="live-indicator"><span className="live-dot"></span> Live monitoring</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Total Comments', value: total.toLocaleString(), color: 'var(--accent-primary)' },
          { label: 'Positive', value: positive.toLocaleString(), color: 'var(--accent-success)' },
          { label: 'Negative', value: negative.toLocaleString(), color: 'var(--accent-danger)' },
          { label: 'Neutral', value: neutral.toLocaleString(), color: 'var(--text-muted)' },
          { label: 'Questions', value: question.toLocaleString(), color: 'var(--accent-warning)' },
        ].map((s) => (
          <div key={s.label} className="card p-5">
            <div className="stat-label mb-2">{s.label}</div>
            <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Sentiment filter pills — multi-select. Empty selection (or every
          option individually selected) both mean "All" and light up together.
          Filtering down to exactly "Negative" switches the page into queue mode
          (urgency sort + the topic/urgency chips and right panel below). */}
      {(() => {
        const allActive = sentiment.length === 0 || sentiment.length === SENTIMENTS.length;
        return (
        <div className="flex gap-2 flex-wrap mb-3">
          <button
            onClick={handleSentimentClear}
            className={`filter-pill ${allActive ? 'active' : ''}`}
          >
            All Sentiments ({total})
          </button>
          {SENTIMENTS.map((v) => {
            const active = allActive || sentiment.includes(v);
            const count = v === 'positive' ? positive : v === 'negative' ? negative : v === 'neutral' ? neutral : v === 'question' ? question : resale;
            return (
              <button
                key={v}
                onClick={() => handleSentimentToggle(v)}
                className={`filter-pill ${active ? 'active' : ''}`}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)} ({count})
              </button>
            );
          })}
        </div>
        );
      })()}

      {/* Sort toggle — negative queue defaults to date order; urgency-first is
          an explicit opt-in, not silent, so the order on screen always has a
          visible reason. */}
      {negativeOnlyMode && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-muted">Sort:</span>
          <FilterPills
            options={[
              { value: 'date', label: 'Date (most recent)' },
              { value: 'urgency', label: 'Urgency (most urgent)' },
            ]}
            value={negativeSortMode}
            onChange={(v) => { setNegativeSortMode(v as 'date' | 'urgency'); setPage(1); }}
          />
        </div>
      )}

      {/* Topic filter pills, scoped to whichever single sentiment is active. Negative
          additionally gets an urgency filter chip (urgency is only scored for negatives). */}
      {activeSentiment && (scopedTopics.length > 0 || urgencyFilter > 0) && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="text-xs text-muted">Topic:</span>
          <FilterPills
            options={[
              { value: '', label: 'All' },
              ...scopedTopics.map((t) => ({ value: t.topic, label: `${t.topic} (${t.count})` })),
            ]}
            value={topicFilter}
            onChange={(v) => { setTopicFilter(v === topicFilter ? '' : v); setPage(1); }}
          />
          {urgencyFilter > 0 && (
            <span className="flex items-center gap-1.5 ml-2 text-xs text-muted">
              Urgency: <strong className="text-primary">{urgencyFilter}</strong>
              <button style={{ color: 'var(--accent-primary)' }} onClick={() => { setUrgencyFilter(0); setPage(1); }}>✕</button>
            </span>
          )}
        </div>
      )}

      {/* Platform filter pills — multi-select, same "all active together" rule as sentiment */}
      {(() => {
        const allActive = platform.length === 0 || platform.length === PLATFORMS.length;
        return (
        <div className="flex gap-2 flex-wrap mb-3">
          <button
            onClick={handlePlatformClear}
            className={`filter-pill ${allActive ? 'active' : ''}`}
          >
            All Platforms
          </button>
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => handlePlatformToggle(p)}
              className={`filter-pill ${allActive || platform.includes(p) ? 'active' : ''}`}
            >
              {PLATFORM_LABELS[p] ?? p}
            </button>
          ))}
        </div>
        );
      })()}

      {/* Search + days + brand pills — search always leads (consistent with
          every other list page); pills matching the brand-filter widget used
          everywhere else. */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <SearchInput value={searchQ} onChange={setSearchQ} placeholder="Search comment text or author…" />
        <DateRangePicker value={range} onChange={handleRangeChange} />
        <FilterPills
          options={[
            { value: '', label: 'All Brands' },
            ...brandOptions
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((b) => ({ value: b.slug, label: b.name })),
          ]}
          value={brandFilter}
          onChange={handleBrandFilterChange}
        />
      </div>

      <div className="grid gap-5 mb-5 grid-2col" style={{ gridTemplateColumns: '2fr 1fr' }}>
        {/* Comments list */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="section-title">Comments Feed</div>
            <div className="text-xs text-muted">
              {totalCommentRows} comments
            </div>
          </div>

          {editError && (
            <div
              className="text-xs font-medium mb-3 px-3 py-2 rounded"
              style={{ background: 'var(--accent-danger-subtle, #fef2f2)', color: 'var(--accent-danger, #e53e3e)' }}
            >
              {editError}
              <button
                className="ml-2 font-semibold"
                style={{ color: 'inherit' }}
                onClick={() => setEditError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
            </div>
          ) : comments.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">💬</div>
              <p className="text-sm text-muted">No comments found.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {comments.map((c) => (
                <div
                  key={c.id}
                  className="p-4 rounded-lg animate-slide-up"
                  style={{ background: 'var(--bg-base)', border: '1px solid var(--border-light)' }}
                >
                  <div className="flex items-start gap-3">
                    {c.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.cover_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-10 h-12 rounded-lg object-cover flex-shrink-0"
                        style={{ background: 'var(--bg-elevated)' }}
                      />
                    ) : (
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                        style={{ background: PLATFORM_COLORS[c.platform] ?? '#64748b' }}
                      >
                        {c.platform.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs font-semibold text-primary">
                          {PLATFORM_LABELS[c.platform] ?? c.platform}
                        </span>
                        <span className="text-xs text-muted">•</span>
                        <span className="text-xs text-muted">
                          {c.author_name || c.brand_name}
                        </span>
                        {c.note_type === 'video' && (
                          <span className="tag tag-blue text-[10px]">video</span>
                        )}
                        <span style={{ position: 'relative', display: 'inline-block' }}>
                          <button
                            onClick={() => setEditingSentimentId(editingSentimentId === c.id ? null : c.id)}
                            className={`tag text-[10px] ${c.sentiment === 'positive' ? 'tag-green' : c.sentiment === 'negative' ? 'tag-red' : c.sentiment === 'question' ? 'tag-amber' : c.sentiment === 'resale' ? 'tag-purple' : c.sentiment === 'neutral' ? 'tag-blue' : 'tag-gray'} hover:opacity-80 transition-opacity`}
                            title="Click to change sentiment/topic"
                          >
                            {c.sentiment ?? 'Set sentiment'}
                          </button>
                          {editingSentimentId === c.id && (
                            <div
                              ref={editorPopoverRef}
                              className="glass-popover"
                              style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 160 }}
                              onKeyDown={trapPopoverTab}
                            >
                              <label className="block text-[10px] font-semibold mb-1 text-muted">Sentiment</label>
                              <select
                                autoFocus
                                value={c.sentiment ?? ''}
                                onChange={(e) => handleCommentEdit(c.id, { sentiment: e.target.value || null })}
                              >
                                <option value="">None</option>
                                {SENTIMENTS.map((s) => (
                                  <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
                                ))}
                              </select>
                              <label className="block text-[10px] font-semibold mt-2 mb-1 text-muted">Topic</label>
                              <select
                                value={c.topic ?? ''}
                                onChange={(e) => handleCommentEdit(c.id, { topic: e.target.value || null })}
                              >
                                <option value="">None</option>
                                {topicOptions.map((t) => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                              <button
                                className="text-[10px] mt-2 w-full text-center"
                                style={{ color: 'var(--accent-primary)' }}
                                onClick={() => setEditingSentimentId(null)}
                              >
                                Done
                              </button>
                            </div>
                          )}
                        </span>
                        {c.sentiment === 'negative' && c.urgency != null && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                            style={{
                              background: c.urgency >= 4 ? 'var(--sentiment-negative-bg)' : 'var(--accent-warning-subtle)',
                              color: c.urgency >= 4 ? 'var(--sentiment-negative)' : 'var(--accent-warning)',
                            }}
                            title={`Urgency ${c.urgency}/5 — how fast this negative comment needs a response`}
                          >
                            U{c.urgency}
                          </span>
                        )}
                      </div>
                      <p className="text-sm leading-relaxed text-secondary">
                        {displayContent(c)}
                      </p>
                      <div className="flex items-center gap-3 mt-2">
                        {c.post_theme && (
                          <span className="tag tag-blue text-[10px]" title="Post theme (post-theme.ts)">{c.post_theme}</span>
                        )}
                        {c.topic && (
                          <span className="tag tag-purple text-[10px]" title="Comment topic">{c.topic}</span>
                        )}
                        {c.likes_count != null && parseInt(c.likes_count) > 0 && (
                          <span className="text-[11px] flex items-center gap-0.5 text-muted">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                            </svg>
                            {parseInt(c.likes_count).toLocaleString()}
                          </span>
                        )}
                        <span className="text-[11px] text-muted">
                          {c.published_at
                            ? new Date(c.published_at).toLocaleDateString('th-TH', { month: 'short', day: 'numeric', year: 'numeric' })
                            : 'Recently'
                          }
                        </span>
                        {(() => {
                          const internalHref = internalPostHref(c);
                          if (internalHref) {
                            return (
                              <button
                                onClick={() => router.push(internalHref)}
                                className="text-[11px] flex items-center gap-0.5 hover:underline"
                                style={{ color: 'var(--accent-primary)' }}
                              >
                                {c.platform === 'tiktok' ? 'View video' : 'View post'} →
                              </button>
                            );
                          }
                          if (c.post_url) {
                            return (
                              <a
                                href={c.post_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] flex items-center gap-0.5 hover:underline"
                                style={{ color: 'var(--accent-primary)' }}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                  <polyline points="15 3 21 3 21 9"/>
                                  <line x1="10" y1="14" x2="21" y2="3"/>
                                </svg>
                                View post
                              </a>
                            );
                          }
                          return null;
                        })()}
                        {/* {c.sentiment_score && (
                          <span 
                            className="text-[11px] font-medium"
                            style={{ 
                              color: parseFloat(c.sentiment_score) > 0.3 ? 'var(--accent-success)' : 
                                    parseFloat(c.sentiment_score) < -0.3 ? 'var(--accent-danger)' : 'var(--text-muted)'
                            }}
                          >
                            Score: {parseFloat(c.sentiment_score).toFixed(2)}
                          </span>
                        )} */}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && totalPages > 1 && (
            <div
              className="flex items-center justify-between px-0 pt-4 border-t-light"
            >
              <span className="text-sm text-muted">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  className="btn btn-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  className="btn btn-sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: sentiment + topics + brand sentiment — scoped to negative-only when on Negative Queue */}
        <div className="flex flex-col gap-4">
          {negativeOnlyMode ? (
            <div className="card p-6">
              <div className="section-title mb-1">Urgency Distribution</div>
              <div className="text-xs mb-4 text-muted">
                1 = trivial · 5 = urgent/critical, needs a fast response — click a bar to filter
              </div>
              <div className="space-y-2">
                {urgencyBuckets.map((u) => {
                  const max = Math.max(...urgencyBuckets.map((b) => b.count), 1);
                  const color = u.urgency >= 4 ? 'var(--sentiment-negative)' : u.urgency === 3 ? 'var(--accent-warning)' : 'var(--text-muted)';
                  const active = urgencyFilter === u.urgency;
                  return (
                    <button
                      key={u.urgency}
                      onClick={() => { setUrgencyFilter(active ? 0 : u.urgency); setPage(1); }}
                      className="flex items-center gap-2 w-full text-left"
                      style={{ background: active ? 'var(--bg-base)' : 'transparent', borderRadius: 6, padding: '2px 4px', border: active ? '1px solid var(--accent-primary)' : '1px solid transparent' }}
                    >
                      <span className="text-xs font-mono" style={{ width: 14, color: 'var(--text-secondary)' }}>{u.urgency}</span>
                      <div className="flex-1 h-2.5 rounded-full overflow-hidden bg-base">
                        <div style={{ width: `${(u.count / max) * 100}%`, height: '100%', background: color }} />
                      </div>
                      <span className="text-xs font-mono" style={{ width: 24, textAlign: 'right', color: 'var(--text-muted)' }}>{u.count}</span>
                    </button>
                  );
                })}
                {urgencyBuckets.every((u) => u.count === 0) && (
                  <div className="text-xs text-muted">No urgency-scored negative comments in range.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="card p-6">
              <div className="section-title mb-4">Sentiment Distribution</div>
              <div style={{ height: 200 }}>
                <SentimentDonut positive={positive} negative={negative} neutral={neutral} />
              </div>
              <div className="flex justify-center gap-4 mt-4 text-xs">
                {[
                  { label: 'Positive', color: '#10b981', n: positive },
                  { label: 'Negative', color: '#ef4444', n: negative },
                  { label: 'Neutral', color: '#94a3b8', n: neutral },
                ].map((l) => (
                  <span key={l.label} className="flex items-center gap-1.5 text-secondary">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: l.color }}></span>
                    {l.label} ({l.n})
                  </span>
                ))}
              </div>
            </div>
          )}

          {negativeOnlyMode ? (
            <div className="card p-6">
              <div className="section-title mb-1">Negative Comments by Topic</div>
              <div className="text-xs mb-4 text-muted">
                Raw counts — what's driving complaints, ranked
              </div>
              <div className="space-y-3">
                {scopedTopics.slice(0, 7).map((t) => {
                  const max = Math.max(...scopedTopics.map((x) => x.count), 1);
                  return (
                    <div key={t.topic}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-secondary">{t.topic}</span>
                        <span className="font-mono text-xs text-muted">{t.count}</span>
                      </div>
                      <div className="h-2 rounded-full overflow-hidden bg-base">
                        <div className="h-full" style={{ width: `${(t.count / max) * 100}%`, background: '#ef4444' }} />
                      </div>
                    </div>
                  );
                })}
                {scopedTopics.length === 0 && (
                  <div className="text-xs text-muted">No classified negative comments yet.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="card p-6">
              <div className="section-title mb-1">Topics — Loved vs Complained</div>
              <div className="text-xs mb-4 text-muted">
                Raw counts per topic — +positive · ·neutral · −negative · total
              </div>
              <div className="space-y-3">
                {topicSent.slice(0, 7).map((t) => (
                  <div key={t.topic}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-secondary">{t.topic}</span>
                      <span className="flex items-center gap-2 text-xs">
                        <span style={{ color: 'var(--sentiment-positive)' }}>+{t.p}</span>
                        <span className="text-muted">·{t.nu}</span>
                        <span style={{ color: 'var(--sentiment-negative)' }}>−{t.n}</span>
                        <span className="font-mono" style={{ color: 'var(--text-muted)', width: 36, textAlign: 'right' }}>{t.tot}</span>
                      </span>
                    </div>
                    <div className="flex h-2 rounded-full overflow-hidden bg-base">
                      <div className="h-full" style={{ width: `${(t.p / t.tot) * 100}%`, background: '#10b981' }} title={`${t.p} positive`} />
                      <div className="h-full" style={{ width: `${(t.nu / t.tot) * 100}%`, background: '#94a3b8' }} title={`${t.nu} neutral`} />
                      <div className="h-full" style={{ width: `${(t.n / t.tot) * 100}%`, background: '#ef4444' }} title={`${t.n} negative`} />
                    </div>
                  </div>
                ))}
                {topicSent.length === 0 && (
                  <div className="text-xs text-muted">No classified comments yet.</div>
                )}
              </div>
            </div>
          )}

          {negativeOnlyMode ? (
            negByBrand.length > 0 && (
              <div className="card p-6">
                <div className="section-title mb-4">Negative by Brand</div>
                <div className="space-y-3">
                  {negByBrand.slice(0, 5).map((b) => (
                    <div key={b.brand_name} className="flex items-center justify-between">
                      <span className="text-sm font-medium text-primary">{b.brand_name}</span>
                      <span className="font-mono text-xs font-semibold" style={{ color: 'var(--sentiment-negative)' }}>{b.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          ) : (
            brandSentiment.length > 0 && (
              <div className="card p-6">
                <div className="section-title mb-4">Brand Sentiment</div>
                <div className="space-y-3">
                  {brandSentiment.slice(0, 5).map((bs) => (
                    <div key={`${bs.brand_name}-${bs.sentiment}`} className="flex items-center justify-between">
                      <span className="text-sm font-medium text-primary">{bs.brand_name}</span>
                      <div className="flex items-center gap-2">
                        <span className={`tag text-[10px] ${bs.sentiment === 'positive' ? 'tag-green' : bs.sentiment === 'negative' ? 'tag-red' : 'tag-blue'}`}>
                          {bs.sentiment}
                        </span>
                        <span className="font-mono text-xs font-semibold text-secondary">{bs.count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
