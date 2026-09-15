import { socialPool, withSocialTransaction } from './social-client';
import { PoolClient } from 'pg';

const brands = [
  { name: 'MizuMi',        slug: 'mizumi',        type: 'own', threat_level: null, shopee_url: 'https://shopee.co.th/mizumi_officialshop', lazada_url: null, watsons_th_id: 164254, website_url: 'https://www.mizumi.com',       tiktok_handle: 'mizumi_official',      notes: 'Flagship sensitive skin brand · 873K TikTok' },
  { name: 'Gentle Colors', slug: 'gentle-colors', type: 'own', threat_level: null, shopee_url: 'https://shopee.co.th/gentlecolors',        lazada_url: null, watsons_th_id: 158211, website_url: null,                         tiktok_handle: 'gentlecolorsofficial', notes: 'Gender-neutral color cosmetics · Gen Z' },
  { name: 'Bomi',          slug: 'bomi',          type: 'own', threat_level: null, shopee_url: 'https://shopee.co.th/mizumi_officialshop', lazada_url: null, watsons_th_id: 153335, website_url: 'https://bomithailand.com',    tiktok_handle: 'bomiofficial_th',      notes: 'Beauty supplements · shared store with MizuMi' },
  { name: 'Her Hyness',    slug: 'her-hyness',    type: 'competitor', threat_level: null, shopee_url: null, lazada_url: null, watsons_th_id: null, website_url: null, tiktok_handle: 'herhynessbeauty', notes: 'Benchmark competitor · TikTok-only tracking' },
];

async function seedBrands(client: PoolClient) {
  console.log('Seeding brands into social DB...');
  for (const b of brands) {
    await client.query(
      `INSERT INTO brands (name, slug, type, threat_level, shopee_url, lazada_url, watsons_th_id, website_url, notes, tiktok_handle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (slug) DO UPDATE SET
         name          = EXCLUDED.name,
         threat_level  = EXCLUDED.threat_level,
         shopee_url    = EXCLUDED.shopee_url,
         lazada_url    = EXCLUDED.lazada_url,
         watsons_th_id = EXCLUDED.watsons_th_id,
         website_url   = EXCLUDED.website_url,
         notes         = EXCLUDED.notes,
         tiktok_handle = EXCLUDED.tiktok_handle`,
      [b.name, b.slug, b.type, b.threat_level ?? null, b.shopee_url ?? null, b.lazada_url ?? null, b.watsons_th_id ?? null, b.website_url ?? null, b.notes ?? null, b.tiktok_handle ?? null]
    );
  }
  console.log(`  ✓ ${brands.length} brands`);
}

async function main() {
  console.log('Running social DB seed...');
  try {
    await withSocialTransaction(async (client) => {
      await seedBrands(client);
    });
    console.log('\n✅ Social DB seed complete.');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await socialPool.end();
  }
}

main();
