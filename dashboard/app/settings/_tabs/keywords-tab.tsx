'use client';

import { Section, KeywordChips } from './shared';
import type { KeywordsSettings, Brand, KeywordPlatform } from './types';

// ── Keywords tab ──────────────────────────────────────────────────────────────
// tiktok/tiktokCategory/xhs/twitter/competitorTiktok are keyword_terms-table-backed
// (immediate per-keyword CRUD via onAddKeyword/onRemoveKeyword — no debounce, no
// whole-array overwrite). ownHandles*/ownInfluencers stay in the jsonb settings
// blob (small, stable lists) and still go through the debounced `update` save.

export default function KeywordsTab({ settings, brands, update, onAddKeyword, onRemoveKeyword }: {
  settings: KeywordsSettings;
  brands: Brand[];
  update: (patch: Partial<KeywordsSettings>) => void;
  onAddKeyword: (platform: KeywordPlatform, brandSlug: string | null, kw: string) => void;
  onRemoveKeyword: (platform: KeywordPlatform, brandSlug: string | null, kw: string) => void;
}) {
  const ownBrands = brands.filter((b) => b.type === 'own');
  const competitorBrands = brands.filter((b) => b.type === 'competitor');

  return (
    <>
      <Section title="TikTok — keywords per brand" desc="Each post matched by these keywords is attributed to the brand. Hourly UGC search uses this list.">
        {ownBrands.map((b) => {
          const kws = settings.tiktok[b.slug] ?? [];
          return (
            <div key={b.slug} className="py-3 border-b-light">
              <div className="text-sm font-medium mb-2 text-primary">{b.name} <span className="text-xs font-mono text-muted">({b.slug})</span></div>
              <KeywordChips
                keywords={kws}
                placeholder={`Add TikTok keyword for ${b.name}...`}
                onAdd={(kw) => onAddKeyword('tiktok', b.slug, kw)}
                onRemove={(kw) => onRemoveKeyword('tiktok', b.slug, kw)}
              />
            </div>
          );
        })}
      </Section>

      <Section title="TikTok — category keywords" desc="Generic terms (skincare, sunscreen, concealer). Posts saved only if caption also mentions an own brand.">
        <KeywordChips
          keywords={settings.tiktokCategory}
          placeholder="Add category keyword..."
          onAdd={(kw) => onAddKeyword('tiktok_category', null, kw)}
          onRemove={(kw) => onRemoveKeyword('tiktok_category', null, kw)}
        />
      </Section>

      <Section title="TikTok — competitor keywords (optional)" desc="A competitor with no keywords here falls back to matching its bare brand name — that can false-positive on generic terms (e.g. a competitor named for an ingredient). Add real keywords to narrow the match.">
        {competitorBrands.length === 0 && (
          <div className="text-xs text-muted">No competitor brands yet — add one on the Brands tab.</div>
        )}
        {competitorBrands.map((b) => {
          const kws = settings.competitorTiktok[b.slug] ?? [];
          return (
            <div key={b.slug} className="py-3 border-b-light">
              <div className="text-sm font-medium mb-2 text-primary">{b.name} <span className="text-xs font-mono text-muted">({b.slug})</span></div>
              {kws.length === 0 && (
                <div className="text-xs mb-2" style={{ color: 'var(--accent-warning, #b45309)' }}>
                  No curated keywords — currently matching bare name &quot;{b.name}&quot;.
                </div>
              )}
              <KeywordChips
                keywords={kws}
                placeholder={`Add TikTok keyword for ${b.name}...`}
                onAdd={(kw) => onAddKeyword('tiktok', b.slug, kw)}
                onRemove={(kw) => onRemoveKeyword('tiktok', b.slug, kw)}
              />
            </div>
          );
        })}
      </Section>

      <Section title="Xiaohongshu — search keywords" desc="Notes + UGC. Brand names in Latin, category terms in Chinese.">
        <KeywordChips
          keywords={settings.xhs}
          placeholder="Add XHS keyword..."
          onAdd={(kw) => onAddKeyword('xhs', null, kw)}
          onRemove={(kw) => onRemoveKeyword('xhs', null, kw)}
        />
      </Section>

      <Section title="X (Twitter) — keywords per brand" desc="Hourly UGC search hits X for each keyword. Same Thai/Latin variants as TikTok work here.">
        {ownBrands.map((b) => {
          const kws = settings.twitter?.[b.slug] ?? [];
          return (
            <div key={b.slug} className="py-3 border-b-light">
              <div className="text-sm font-medium mb-2 text-primary">
                {b.name} <span className="text-xs font-mono text-muted">({b.slug})</span>
              </div>
              <KeywordChips
                keywords={kws}
                placeholder={`Add X keyword for ${b.name}...`}
                onAdd={(kw) => onAddKeyword('twitter', b.slug, kw)}
                onRemove={(kw) => onRemoveKeyword('twitter', b.slug, kw)}
              />
            </div>
          );
        })}
      </Section>

      <Section title="Own brand handles" desc="Skipped from UGC search so the feed scraper covers them exclusively.">
        <div className="py-3 border-b-light">
          <div className="text-sm font-medium mb-2 text-primary">TikTok handles</div>
          <KeywordChips
            keywords={settings.ownHandlesTiktok}
            placeholder="Add TikTok handle (no @)"
            onAdd={(kw) => update({ ownHandlesTiktok: Array.from(new Set([...settings.ownHandlesTiktok, kw.replace(/^@/, '')])) })}
            onRemove={(kw) => update({ ownHandlesTiktok: settings.ownHandlesTiktok.filter((k) => k !== kw) })}
          />
        </div>
        <div className="py-3 border-b-light">
          <div className="text-sm font-medium mb-2 text-primary">X (Twitter) handles</div>
          <KeywordChips
            keywords={settings.ownHandlesTwitter ?? []}
            placeholder="Add X screen_name (no @)"
            onAdd={(kw) => update({ ownHandlesTwitter: Array.from(new Set([...(settings.ownHandlesTwitter ?? []), kw.replace(/^@/, '')])) })}
            onRemove={(kw) => update({ ownHandlesTwitter: (settings.ownHandlesTwitter ?? []).filter((k) => k !== kw) })}
          />
        </div>
        <div className="py-3">
          <div className="text-sm font-medium mb-2 text-primary">Ambassador handles</div>
          <div className="text-xs text-muted mb-2">
            Tagged with an ★ Ambassador badge on the Influencers leaderboard — they stay visible (real creators worth tracking), not excluded.
          </div>
          <KeywordChips
            keywords={settings.ownInfluencers}
            placeholder="Add influencer handle (no @)"
            onAdd={(kw) => update({ ownInfluencers: Array.from(new Set([...settings.ownInfluencers, kw.replace(/^@/, '')])) })}
            onRemove={(kw) => update({ ownInfluencers: settings.ownInfluencers.filter((k) => k !== kw) })}
          />
        </div>
      </Section>
    </>
  );
}
