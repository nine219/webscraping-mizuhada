// One-time backfill: app_settings.settings.keywords.{tiktok,tiktokCategory,xhs,twitter}
// -> keyword_terms table. Idempotent (ON CONFLICT DO NOTHING) — safe to re-run.
// Run: npx ts-node -r dotenv/config src/tools/migrate-keywords-to-table.ts dotenv_config_path=.env.local
//
// NOTE: reads keywords.ts hardcoded arrays + the raw stored jsonb override
// directly (NOT settings-loader.ts's loadSettings()/getKeywords()) — those
// now source tiktok/tiktokCategory/xhs/twitter FROM keyword_terms itself, so
// calling them here would read back whatever this script already inserted
// (empty on a first run) instead of the pre-migration source data.

import { socialQuery as query, socialPool } from '../db/social-client';
import { getStoredOverride, deepMerge, DeepPartial } from '../config/settings-loader';
import {
  SEARCH_TARGETS,
  CATEGORY_KEYWORDS,
  CN_SEARCH_KEYWORDS,
} from '../scrapers/keywords';

interface LegacyKeywords {
  tiktok: Record<string, string[]>;
  tiktokCategory: string[];
  xhs: string[];
  twitter: Record<string, string[]>;
}

function targetsToMap(targets: typeof SEARCH_TARGETS): Record<string, string[]> {
  return Object.fromEntries(targets.map((t) => [t.brandSlug, [...t.keywords]]));
}

async function loadLegacyKeywords(): Promise<LegacyKeywords> {
  const defaults: LegacyKeywords = {
    tiktok: targetsToMap(SEARCH_TARGETS),
    tiktokCategory: [...CATEGORY_KEYWORDS],
    xhs: [...CN_SEARCH_KEYWORDS],
    twitter: targetsToMap(SEARCH_TARGETS),
  };
  const stored = await getStoredOverride();
  const storedKeywords = (stored as { keywords?: DeepPartial<LegacyKeywords> }).keywords;
  return deepMerge(defaults, storedKeywords);
}

async function main() {
  const settings = await loadLegacyKeywords();
  const brandRows = await query<{ id: number; slug: string; name: string; type: 'own' | 'competitor' }>(
    `SELECT id, slug, name, type FROM brands`
  );
  const idBySlug = new Map(brandRows.map((b) => [b.slug, b.id]));

  let inserted = 0;

  async function insertRow(platform: string, brandId: number | null, keyword: string) {
    const kw = keyword.trim();
    if (!kw) return;
    const res = await query(
      `INSERT INTO keyword_terms (platform, brand_id, keyword)
       VALUES ($1, $2, $3)
       ON CONFLICT (platform, COALESCE(brand_id, 0), keyword) DO NOTHING
       RETURNING id`,
      [platform, brandId, kw]
    );
    if (res.length > 0) inserted++;
  }

  for (const [slug, keywords] of Object.entries(settings.tiktok)) {
    const brandId = idBySlug.get(slug);
    if (!brandId) continue;
    for (const kw of keywords) await insertRow('tiktok', brandId, kw);
  }

  for (const kw of settings.tiktokCategory) await insertRow('tiktok_category', null, kw);
  for (const kw of settings.xhs) await insertRow('xhs', null, kw);

  for (const [slug, keywords] of Object.entries(settings.twitter)) {
    const brandId = idBySlug.get(slug);
    if (!brandId) continue;
    for (const kw of keywords) await insertRow('twitter', brandId, kw);
  }

  // Competitors had no editable keyword list before this migration — seed
  // one bare-name row each so matchBrandSlug()'s existing behavior (bare
  // name match) is preserved until an operator adds real keywords.
  for (const b of brandRows) {
    if (b.type !== 'competitor') continue;
    await insertRow('tiktok', b.id, b.name);
  }

  console.log(`[migrate-keywords] inserted ${inserted} keyword_terms rows`);
  const counts = await query<{ platform: string; n: string }>(
    `SELECT platform, COUNT(*)::text AS n FROM keyword_terms GROUP BY platform ORDER BY platform`
  );
  console.table(counts);
  await socialPool.end();
}

main().catch((err) => {
  console.error('[migrate-keywords] failed:', err);
  process.exit(1);
});
