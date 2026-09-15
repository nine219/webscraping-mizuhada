'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  fetchCommandCenterOverview, fetchSentimentTrend, fetchTopicMatrix, fetchCrisis, fetchTopUgc, fetchBrands,
  CommandCenterOverview, SentimentTrendPoint, TopicMatrixRow, CrisisBrand, UgcPost, DateRange,
} from '@/lib/api';
import SentimentTrendChart from '@/components/charts/sentiment-trend-chart';
import TopicSentimentMatrix from '@/components/charts/topic-sentiment-matrix';
import CrisisRiskChart from '@/components/charts/crisis-risk-chart';
import UgcCard from '@/components/ugc-card';
import { DateRangePicker } from '@/components/date-range-picker';
import { FilterPills } from '@/components/filter-pills';
import DrilldownDrawer, { DrilldownFilter } from '@/components/drilldown-drawer';

function rangeLabel(r: DateRange): string {
  return r.from && r.to ? `${r.from}–${r.to}` : `${r.days ?? 7}d`;
}

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  xiaohongshu: 'Xiaohongshu',
  twitter: 'X (Twitter)',
};

const SEV_BORDER: Record<string, string> = {
  negative: 'var(--sentiment-negative)',
  warning: 'var(--accent-warning)',
  info: 'var(--accent-primary)',
};
const SEV_BG: Record<string, string> = {
  negative: 'var(--sentiment-negative-bg)',
  warning: 'var(--accent-warning-subtle)',
  info: 'var(--accent-primary-subtle)',
};

function timeAgo(iso: string | null) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3.6e6);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function CommandCenterPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<CommandCenterOverview | null>(null);
  const [trend, setTrend] = useState<SentimentTrendPoint[]>([]);
  const [topics, setTopics] = useState<TopicMatrixRow[]>([]);
  const [crisisBrands, setCrisisBrands] = useState<CrisisBrand[]>([]);
  const [crisisTimeline, setCrisisTimeline] = useState<{ date: string; negative: number; total: number }[]>([]);
  const [ugc, setUgc] = useState<UgcPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<DateRange>({ days: 7 });
  const [drilldown, setDrilldown] = useState<DrilldownFilter | null>(null);
  // Command Center had no brand filter at all — every other main page does.
  const [brandFilter, setBrandFilter] = useState('');
  const [brandOptions, setBrandOptions] = useState<{ slug: string; name: string }[]>([]);

  function fmtDateLabel(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  // Command Center had no CSV export at all — every other main page has one.
  // Hits the raw comment-export endpoint directly (self-serve CSV pull for a
  // date range) rather than the client-side ExportCsvButton pattern used on
  // list pages, since this page has no single already-fetched row array to
  // export — it's a dashboard of aggregates, not a table.
  async function downloadOverviewCsv() {
    setExporting(true);
    setExportFailed(false);
    try {
      const today = new Date().toISOString().slice(0, 10);
      let start: string;
      let end: string;
      if (range.from && range.to) {
        start = range.from;
        end = range.to;
      } else {
        // Backend caps spans at 366 days — matches that cap here instead of
        // sending "All time"'s 2000-01-01 sentinel (used elsewhere) and
        // getting rejected.
        const days = Math.min(range.days || 366, 366);
        start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
        end = today;
      }
      const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
      const qs = new URLSearchParams({ start, end });
      if (brandFilter) qs.set('brand', brandFilter);
      const res = await fetch(`${base}/api/settings/export-csv?${qs}`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `command-center-${start === end ? start : `${start}_to_${end}`}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportFailed(true);
      setTimeout(() => setExportFailed(false), 3000);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    fetchBrands()
      .then((b) => setBrandOptions(b.filter((x) => x.type === 'own').map((x) => ({ slug: x.slug, name: x.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const brand = brandFilter || undefined;
    Promise.all([
      fetchCommandCenterOverview(range, brand),
      fetchSentimentTrend({ ...range, brand }),
      fetchTopicMatrix({ ...range, brand }),
      fetchCrisis({ ...range, brand }),
      fetchTopUgc({ ...range, brand, limit: 4 }),
    ])
      .then(([o, t, tm, c, u]) => {
        setOverview(o);
        setTrend(t.data);
        setTopics(tm.data);
        setCrisisBrands(c.brands);
        setCrisisTimeline(c.timeline);
        setUgc(u.data);
      })
      .catch(() => setOverview(null))
      .finally(() => setLoading(false));
  }, [range, brandFilter]);

  const k = overview?.kpis;
  const flaggedBrands = (overview?.brand_summary ?? []).filter((b) => b.negative > 0);
  const totalPlatformMentions = (overview?.platform_mix ?? []).reduce((s, p) => s + p.count, 0);
  const hasFire = !!k && (k.brands_with_negatives_recent > 0 || k.active_spikes_recent > 0);

  // Raw counts only — no invented composite scores (per SCOPE v3).
  // UGC Mentions combines TikTok + X search volume into one tile (with a
  // per-platform sub-line, since "UGC mentions" doesn't mean the same
  // pipeline on both — TikTok keyword search vs MizuMi-only X search) rather
  // than two separate cards for what's conceptually one metric. Avg
  // Engagement Rate is TikTok-only (no cross-platform concept yet); the rest
  // aggregate comments from all 4 platforms (TikTok/Instagram/Xiaohongshu/X).
  // Labeled explicitly so the scope of each number is never ambiguous.
  const KPIS = [
    {
      label: `UGC Mentions (${rangeLabel(range)}, TikTok + X)`, value: k ? k.ugc_mentions_recent.toLocaleString() : '—',
      meta: k ? `TikTok: ${k.social_mentions_recent.toLocaleString()} · X: ${k.x_mentions_recent.toLocaleString()}` : '',
      delta: k?.ugc_mentions_delta, color: 'var(--accent-success)',
    },
    {
      label: `Negative Comments (${rangeLabel(range)}, all platforms)`, value: k ? k.negative_mentions_recent.toLocaleString() : '—',
      meta: k ? `${k.brands_with_negatives_recent} brand${k.brands_with_negatives_recent === 1 ? '' : 's'} affected` : '',
      color: 'var(--sentiment-negative)',
    },
    {
      label: `Sentiment Split (${rangeLabel(range)}, all platforms)`, value: k ? `${k.sentiment_split.positive}%` : '—',
      meta: k ? `pos · ${k.sentiment_split.neutral}% neu · ${k.sentiment_split.negative}% neg` : '',
      color: 'var(--accent-primary)',
    },
    {
      label: `Avg Engagement Rate (${rangeLabel(range)}, TikTok only)`, value: k ? `${k.avg_engagement}%` : '—',
      meta: '(likes+shares+comments) / views',
      color: 'var(--accent-info)',
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">Command Center</h1>
          <p className="page-header-subtitle">Per-brand mention volume, sentiment split, engagement spikes</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn btn-sm" onClick={downloadOverviewCsv} disabled={exporting}>
            {exporting ? 'Exporting…' : exportFailed ? 'Export failed' : '⭳ Export CSV'}
          </button>
          <DateRangePicker value={range} onChange={setRange} />
          <span className="live-indicator"><span className="live-dot" /> Live</span>
        </div>
      </div>

      <FilterPills
        className="flex items-center gap-1.5 flex-wrap mb-5"
        options={[{ value: '', label: 'All Brands' }, ...brandOptions.map((b) => ({ value: b.slug, label: b.name }))]}
        value={brandFilter}
        onChange={setBrandFilter}
      />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
        </div>
      ) : (
        <>
          {/* Fire ribbon — the one thing an executive needs to know before anything else */}
          {overview && (hasFire ? (
            <div className="card p-4 mb-5 flex items-center gap-3"
              style={{ borderLeft: '3px solid var(--sentiment-negative)', background: 'var(--sentiment-negative-bg)' }}>
              <span style={{ fontSize: 20 }}>🔥</span>
              <span className="text-sm font-medium text-primary">
                {k!.brands_with_negatives_recent > 0 &&
                  `${k!.brands_with_negatives_recent} brand${k!.brands_with_negatives_recent === 1 ? '' : 's'} flagged`}
                {k!.brands_with_negatives_recent > 0 && k!.active_spikes_recent > 0 && ' · '}
                {k!.active_spikes_recent > 0 &&
                  `${k!.active_spikes_recent} engagement spike${k!.active_spikes_recent === 1 ? '' : 's'}`}
                {' — see Insight Feed below.'}
              </span>
            </div>
          ) : (
            <div className="card p-4 mb-5 flex items-center gap-3"
              style={{ borderLeft: '3px solid var(--accent-success)', background: 'var(--accent-success-subtle)' }}>
              <span style={{ fontSize: 20 }}>✓</span>
              <span className="text-sm font-medium text-primary">
                All brands stable — nothing flagged in the last {rangeLabel(range)}.
              </span>
            </div>
          ))}

          {/* KPI row */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            {KPIS.map((s) => (
              <div key={s.label} className="card p-5 card-hover">
                <div className="stat-label mb-3">{s.label}</div>
                <div className="flex items-baseline gap-2">
                  <div className="stat-value" style={{ color: 'var(--text-primary)', fontSize: 26 }}>{s.value}</div>
                  {typeof s.delta === 'number' && s.delta !== 0 && (
                    <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{
                      color: s.delta > 0 ? 'var(--sentiment-positive)' : 'var(--sentiment-negative)',
                      background: s.delta > 0 ? 'var(--sentiment-positive-bg)' : 'var(--sentiment-negative-bg)',
                    }}>
                      {s.delta > 0 ? '↑' : '↓'} {Math.abs(s.delta)}%
                    </span>
                  )}
                </div>
                {s.meta && <div className="stat-meta">{s.meta}</div>}
              </div>
            ))}
          </div>

          {/* Insight feed + quick actions / brand health */}
          <div className="grid gap-5 mb-6 grid-2col" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="section-title">Insight Feed</div>
                <span className="text-xs text-muted">{overview?.insights.length ?? 0} alerts</span>
              </div>
              {overview && overview.insights.length > 0 ? (
                <div className="space-y-3 max-h-[460px] overflow-y-auto pr-1">
                  {overview.insights.map((ins, i) => (
                    <div key={i} className="card p-4" style={{ borderLeft: `3px solid ${SEV_BORDER[ins.severity]}` }}>
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
                          style={{ background: SEV_BG[ins.severity], color: SEV_BORDER[ins.severity] }}>!</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold mb-1 text-primary">{ins.title}</div>
                          <div className="text-xs mb-2" style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>{ins.detail}</div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="tag tag-blue text-[10px]">{ins.brand}</span>
                            <span className="tag tag-gray text-[10px]">{ins.platform}</span>
                            {ins.when && <span className="text-[11px] ml-auto text-muted">{timeAgo(ins.when)}</span>}
                          </div>
                          <button onClick={() => router.push(ins.href)} className="text-xs font-medium mt-2 inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--accent-primary)' }}>
                            {ins.cta} →
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-10">
                  <div className="text-3xl mb-2">✓</div>
                  <p className="text-sm text-muted">No active alerts — all brands stable.</p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <div className="card p-6">
                <div className="section-title mb-4">Executive Digest</div>
                <div className="space-y-2.5 text-sm text-secondary">
                  <p>
                    <strong className="text-primary">{totalPlatformMentions.toLocaleString()}</strong> comments across{' '}
                    <strong className="text-primary">{overview?.platform_mix.length ?? 0}</strong> platform{(overview?.platform_mix.length ?? 0) === 1 ? '' : 's'} in the last {rangeLabel(range)}.
                  </p>
                  <p>
                    Sentiment:{' '}
                    <strong style={{ color: 'var(--sentiment-positive)' }}>{k?.sentiment_split.positive ?? 0}% positive</strong>
                    {' · '}
                    <strong style={{ color: 'var(--sentiment-negative)' }}>{k?.sentiment_split.negative ?? 0}% negative</strong>
                  </p>
                  {flaggedBrands.length > 0 ? (
                    <p>⚠ <strong className="text-primary">{flaggedBrands.length}</strong> brand{flaggedBrands.length === 1 ? '' : 's'} flagged: {flaggedBrands.map((b) => b.name).join(', ')}</p>
                  ) : (
                    <p>✓ No brands flagged this period.</p>
                  )}
                  {(k?.active_spikes_recent ?? 0) > 0 && (
                    <p>📈 {k!.active_spikes_recent} engagement spike{k!.active_spikes_recent === 1 ? '' : 's'} detected (TikTok).</p>
                  )}
                </div>

                {(overview?.platform_mix.length ?? 0) > 0 && (
                  <div className="mt-4 pt-4 border-t-light">
                    <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
                      By Platform — breaks out the cross-platform totals above
                    </div>
                    <div className="space-y-3">
                      {overview!.platform_mix.map((p) => {
                        const total = p.count || 1;
                        const posPct = (p.positive / total) * 100;
                        const neuPct = (p.neutral / total) * 100;
                        const negPct = (p.negative / total) * 100;
                        return (
                          <div key={p.platform} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-secondary">{PLATFORM_LABELS[p.platform] ?? p.platform}</span>
                              <span className="text-[11px] text-muted">
                                {p.count.toLocaleString()} comments ({p.pct}% of total)
                              </span>
                            </div>
                            <div
                              className="flex h-2 rounded-full overflow-hidden bg-base"
                              title={`${PLATFORM_LABELS[p.platform] ?? p.platform} — positive ${p.positive} · neutral ${p.neutral} · negative ${p.negative}`}
                            >
                              <div style={{ width: `${posPct}%`, background: 'var(--sentiment-positive)' }} title={`Positive: ${p.positive}`} />
                              <div style={{ width: `${neuPct}%`, background: 'var(--text-muted)' }} title={`Neutral: ${p.neutral}`} />
                              <div style={{ width: `${negPct}%`, background: 'var(--sentiment-negative)' }} title={`Negative: ${p.negative}`} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="card p-5">
                <div className="section-title mb-3" style={{ fontSize: 16 }}>Per-Brand Comments ({rangeLabel(range)}, all platforms)</div>
                <div className="space-y-3">
                  {(overview?.brand_summary ?? []).map((b) => {
                    const total = b.classified || 1;
                    const posPct = (b.positive / total) * 100;
                    const neuPct = (b.neutral / total) * 100;
                    const negPct = (b.negative / total) * 100;
                    return (
                      <div key={b.slug} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-primary">{b.name}</span>
                          <span className="text-xs text-muted">{b.classified.toLocaleString()}</span>
                        </div>
                        <div
                          className="flex h-2 rounded-full overflow-hidden bg-base"
                          title={`${b.name} — ${b.classified} classified · positive ${b.positive} · neutral ${b.neutral} · negative ${b.negative} · ${b.avg_engagement}% eng`}
                        >
                          <div
                            style={{ width: `${posPct}%`, background: 'var(--sentiment-positive)' }}
                            title={`Positive: ${b.positive} (${Math.round(posPct)}%)`}
                          />
                          <div
                            style={{ width: `${neuPct}%`, background: 'var(--text-muted)' }}
                            title={`Neutral: ${b.neutral} (${Math.round(neuPct)}%)`}
                          />
                          <div
                            style={{ width: `${negPct}%`, background: 'var(--sentiment-negative)' }}
                            title={`Negative: ${b.negative} (${Math.round(negPct)}%)`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Sentiment trend + Top UGC */}
          <div className="grid gap-5 mb-6 grid-2col" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="card p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <div className="section-title">Sentiment Trend</div>
                  <div className="section-subtitle">{rangeLabel(range)} positive · neutral · negative comment volume (all platforms)</div>
                </div>
              </div>
              <div style={{ height: 280 }}>
                <SentimentTrendChart
                  data={trend}
                  onDateClick={(date) => setDrilldown({ date, title: fmtDateLabel(date) })}
                />
              </div>
            </div>

            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="section-title">Top UGC Performance (TikTok)</div>
                <button onClick={() => router.push('/ugc')} className="text-xs font-medium hover:underline" style={{ color: 'var(--accent-primary)' }}>View All →</button>
              </div>
              {ugc.length > 0 ? (
                <div className="grid grid-cols-2 gap-3">
                  {ugc.map((p) => <UgcCard key={p.post_id} post={p} />)}
                </div>
              ) : (
                <div className="text-center py-10 text-sm text-muted">No UGC posts in range.</div>
              )}
            </div>
          </div>

          {/* Topic matrix + Crisis monitor */}
          <div className="grid gap-5 mb-6 grid-2col" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <div className="card p-6">
              <div className="section-title mb-1">Topic Sentiment Matrix</div>
              <div className="section-subtitle mb-4">Comment mentions by topic and sentiment (all platforms)</div>
              <div style={{ height: 300 }}>
                <TopicSentimentMatrix
                  data={topics}
                  onTopicClick={(topic) => setDrilldown({ topic, title: `Topic: ${topic}` })}
                />
              </div>
            </div>

            <div className="card p-6">
              <div className="section-title mb-1">Negative Comment Volume</div>
              <div className="section-subtitle mb-4">{rangeLabel(range)} raw counts per brand (all platforms)</div>
              <div style={{ height: 180 }}>
                <CrisisRiskChart
                  data={crisisTimeline}
                  onDateClick={(date) => setDrilldown({ date, sentiment: 'negative', title: `${fmtDateLabel(date)} — Negative comments` })}
                />
              </div>
              <div className="mt-4 space-y-3">
                {crisisBrands.map((b) => (
                  <div key={b.slug} className="flex items-center justify-between">
                    <span className="text-sm font-medium text-primary">{b.name}</span>
                    <span className="text-xs text-secondary">
                      <span style={{ color: 'var(--sentiment-negative)' }}>{b.negative}</span>
                      <span className="text-muted"> / {b.classified} comments</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <DrilldownDrawer filter={drilldown} onClose={() => setDrilldown(null)} />
    </div>
  );
}
