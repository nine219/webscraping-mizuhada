import { Router, Request, Response } from 'express';
import { socialQuery as query } from '../../db/social-client';

const router = Router();

// products/price_snapshots are legacy tables that don't exist on every
// deployment — only Postgres error 42P01 (undefined_table) should degrade to
// empty silently. Anything else (bad join, permissions) is a real bug and
// should show up in logs instead of vanishing into an empty array.
function swallowUndefinedTable(err: unknown, tableLabel: string): never[] {
  const code = (err as { code?: string } | null)?.code;
  if (code === '42P01') return [];
  console.error(`[brands/:slug] ${tableLabel} query failed (not a missing-table error):`, err);
  return [];
}

// GET /api/brands — list all brands
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{
      id: number;
      name: string;
      slug: string;
      type: string;
      threat_level: string | null;
      website_url: string | null;
      shopee_url: string | null;
      notes: string | null;
    }>(`
      SELECT id, name, slug, type, threat_level, website_url, shopee_url, notes
      FROM brands
      ORDER BY type DESC, threat_level DESC NULLS LAST, name
    `);

    res.json(rows);
  } catch (err) {
    console.error('/api/brands error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/brands/:slug — single brand detail with all products
router.get('/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    const [brandRows, productRows, priceHistoryRows] = await Promise.all([
      query<{
        id: number; name: string; slug: string; type: string;
        threat_level: string | null; website_url: string | null;
        shopee_url: string | null; notes: string | null;
      }>(`
        SELECT id, name, slug, type, threat_level, website_url, shopee_url, notes
        FROM brands WHERE slug = $1 LIMIT 1
      `, [slug]),

      // products + priceHistory queries run only if the table exists — swallow
      // ONLY that specific case (Postgres 42P01 undefined_table) so a real bug
      // (bad join, permissions) doesn't silently degrade to empty data with no
      // signal anywhere in the logs.
      query<{
        product_id: number; product_name: string; platform_slug: string;
        category: string; current_price: string; currency: string;
        url: string | null; image_url: string | null; last_seen_at: Date;
      }>(`
        SELECT p.id AS product_id, p.name AS product_name, pl.slug AS platform_slug,
               p.category, p.current_price, p.currency, p.url, p.image_url, p.last_seen_at
        FROM products p
        JOIN platforms pl ON pl.id = p.platform_id
        WHERE p.brand_id = (SELECT id FROM brands WHERE slug = $1) AND p.is_active = true
        ORDER BY p.current_price DESC
      `, [slug]).catch((err) => swallowUndefinedTable(err, 'products')),

      query<{ time: Date; avg_price: string; product_count: string }>(`
        SELECT time_bucket('1 day', ps.time) AS time,
               ROUND(AVG(ps.price)::numeric, 2) AS avg_price,
               COUNT(DISTINCT ps.product_id)::text AS product_count
        FROM price_snapshots ps
        JOIN products p ON p.id = ps.product_id
        JOIN brands b ON b.id = p.brand_id
        WHERE b.slug = $1 AND ps.time >= NOW() - INTERVAL '30 days'
        GROUP BY time_bucket('1 day', ps.time) ORDER BY time ASC
      `, [slug]).catch((err) => swallowUndefinedTable(err, 'price_snapshots')),
    ]);

    if (brandRows.length === 0) {
      res.status(404).json({ error: 'Brand not found' });
      return;
    }

    res.json({
      brand: brandRows[0],
      products: productRows,
      priceHistory: priceHistoryRows,
    });
  } catch (err) {
    console.error('/api/brands/:slug error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
