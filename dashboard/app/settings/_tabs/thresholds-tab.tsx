'use client';

import { Section, Field, NumInput } from './shared';
import type { ThresholdSettings, ScrapeLimits } from './types';

// ── Thresholds tab ────────────────────────────────────────────────────────────

const FEED_AGE_PRESETS = [30, 60, 90, 0] as const;

export default function ThresholdsTab({ settings, defaults, update }: { settings: ThresholdSettings; defaults: ThresholdSettings; update: (patch: Partial<ThresholdSettings>) => void }) {
  return (
    <>
      <Section title="Feed scrape range" desc="How far back own-brand feed scrapers (TikTok/Instagram/X) look before stopping — a competitor account that posts rarely may need a wider window to pull more than a handful of posts. XHS has no age cutoff (note/scroll caps only), so this doesn't affect it. This is the global default; the ad-hoc Feed Scrape card (Settings → Search) can override it per run.">
        <Field label="Feed max post age" desc={`Default: ${defaults.feedMaxAgeDays === 0 ? 'All time' : `${defaults.feedMaxAgeDays} days`}`}>
          <div className="flex items-center gap-1.5">
            {FEED_AGE_PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => update({ feedMaxAgeDays: d })}
                className={`filter-pill${settings.feedMaxAgeDays === d ? ' active' : ''}`}
              >
                {d === 0 ? 'All time' : `${d}d`}
              </button>
            ))}
          </div>
        </Field>
      </Section>

      <Section title="Comment scrape gating (UGC search only)" desc="Decides which UGC/search posts get their comment thread scraped (TikTok search — Instagram/XHS search were removed). Feed posts (own-brand accounts) always scrape all comments regardless of these — not affected by this section. Tighter = fewer Chrome runs, lower bot-detection risk.">
        <Field label="Minimum views" desc={`Skip comment scrape unless post views ≥ this. Default: ${defaults.commentMinViews.toLocaleString()}`}>
          <NumInput value={settings.commentMinViews} onChange={(n) => update({ commentMinViews: n })} step={1000} />
        </Field>
        <Field label="Minimum comments" desc={`Require this many comments on the post. Default: ${defaults.commentMinCount}`}>
          <NumInput value={settings.commentMinCount} onChange={(n) => update({ commentMinCount: n })} />
        </Field>
        <Field label="Comment re-scrape delta" desc={`Re-scrape a post once its comment-count metadata grows by at least this many since the last scrape — applies to TikTok/Instagram/X feed AND TikTok UGC search. Default: ${defaults.commentGrowthDelta}`}>
          <NumInput value={settings.commentGrowthDelta} onChange={(n) => update({ commentGrowthDelta: n })} />
        </Field>
      </Section>

      <Section title="Spike detection" desc="Two-condition OR, both flat thresholds (no per-brand baseline): (views ≥ min views AND engagement ≥ min engagement %) OR (views ≥ viral views AND engagement ≥ viral engagement %).">
        <Field label="Min views for spike" desc={`View floor for the standard spike rule. Default: ${defaults.minViewsForSpike.toLocaleString()}`}>
          <NumInput value={settings.minViewsForSpike} onChange={(n) => update({ minViewsForSpike: n })} step={10000} />
        </Field>
        <Field label="Min engagement %" desc={`Engagement floor for the standard spike rule. Default: ${defaults.minEngagementPct}%`}>
          <NumInput value={settings.minEngagementPct} onChange={(n) => update({ minEngagementPct: n })} step={0.5} />
        </Field>
        <Field label="Viral views threshold" desc={`Absolute-viral rule: views above this + engagement ≥ viral pct. Default: ${defaults.viralViewsThreshold.toLocaleString()}`}>
          <NumInput value={settings.viralViewsThreshold} onChange={(n) => update({ viralViewsThreshold: n })} step={50000} />
        </Field>
        <Field label="Viral engagement %" desc={`Engagement floor for absolute-viral rule. Default: ${defaults.viralEngagementPct}%`}>
          <NumInput value={settings.viralEngagementPct} onChange={(n) => update({ viralEngagementPct: n })} step={0.5} />
        </Field>
      </Section>

      <Section title="X (Twitter) spike detection" desc="Same two-condition OR shape as TikTok's spike rule above, but with its own thresholds — X's much lower view/engagement volume (MizuMi-only scope) means TikTok's numbers would never fire here. Applies to detectTwitterSpikes(), run on the twitterStatsRefresh cron below.">
        <Field label="Min views for spike" desc={`View floor for the standard X spike rule. Default: ${defaults.xMinViewsForSpike.toLocaleString()}`}>
          <NumInput value={settings.xMinViewsForSpike} onChange={(n) => update({ xMinViewsForSpike: n })} step={1000} />
        </Field>
        <Field label="Min engagement %" desc={`Engagement floor for the standard X spike rule. Default: ${defaults.xMinEngagementPct}%`}>
          <NumInput value={settings.xMinEngagementPct} onChange={(n) => update({ xMinEngagementPct: n })} step={0.1} />
        </Field>
        <Field label="Viral views threshold" desc={`Absolute-viral rule for X. Default: ${defaults.xViralViewsThreshold.toLocaleString()}`}>
          <NumInput value={settings.xViralViewsThreshold} onChange={(n) => update({ xViralViewsThreshold: n })} step={5000} />
        </Field>
        <Field label="Viral engagement %" desc={`Engagement floor for X's absolute-viral rule. Default: ${defaults.xViralEngagementPct}%`}>
          <NumInput value={settings.xViralEngagementPct} onChange={(n) => update({ xViralEngagementPct: n })} step={0.1} />
        </Field>
      </Section>

      <Section title="Sentiment alert" desc="Fires when negative comment share crosses this percentage for a brand inside the alert window.">
        <Field label="Negative comment %" desc={`Default: ${defaults.negativeSpikePct}%`}>
          <NumInput value={settings.negativeSpikePct} onChange={(n) => update({ negativeSpikePct: n })} />
        </Field>
      </Section>

      <Section title="Per-platform scrape limits" desc="Hard caps on browser scrolls + posts collected per scraper run. Lower = faster + safer; higher = deeper coverage at higher bot-detection risk.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th className="text-left py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Scraper</th>
                <th className="text-right py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Max scrolls</th>
                <th className="text-right py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Max posts</th>
                <th className="text-right py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Default</th>
              </tr>
            </thead>
            <tbody>
              {(['tiktokFeed','tiktokSearch','instagramFeed','twitterSearch','twitterComments','xhsFeed','xhsSearch'] as Array<keyof ScrapeLimits>).map((k) => {
                const cur = settings.scrapeLimits[k];
                const def = defaults.scrapeLimits[k];
                const label = ({ tiktokFeed: 'TikTok feed', tiktokSearch: 'TikTok UGC search', instagramFeed: 'Instagram feed', twitterSearch: 'X (Twitter) search', twitterComments: 'X (Twitter) replies/quotes', xhsFeed: 'Xiaohongshu feed', xhsSearch: 'Xiaohongshu UGC search' } as Record<keyof ScrapeLimits, string>)[k];
                return (
                  <tr key={k}>
                    <td className="py-2 px-2 text-sm" style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-primary)' }}>{label}</td>
                    <td className="py-2 px-2 text-right border-b-light">
                      <NumInput value={cur.maxScrolls} onChange={(n) => update({ scrapeLimits: { ...settings.scrapeLimits, [k]: { ...cur, maxScrolls: n } } })} />
                    </td>
                    <td className="py-2 px-2 text-right border-b-light">
                      <NumInput value={cur.maxPosts} onChange={(n) => update({ scrapeLimits: { ...settings.scrapeLimits, [k]: { ...cur, maxPosts: n } } })} step={10} />
                    </td>
                    <td className="py-2 px-2 text-right text-xs font-mono" style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-muted)' }}>{def.maxScrolls} / {def.maxPosts}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
