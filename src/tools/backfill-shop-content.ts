// One-off backfill: run TikTok Shop detection (see scrapers/tiktok/shop-detection.ts)
// against every existing tiktok_posts row's already-captured raw_data, so
// historical posts get is_shop_content/shop_signal marked too — not just new
// scrapes going forward (tiktok-feed.ts / tiktok-search.ts handle those live).
//
// Paginates by id in batches so it never holds the whole table in memory.
// Run: npx ts-node -r dotenv/config src/tools/backfill-shop-content.ts dotenv_config_path=.env.local
import { socialPool as pool } from '../db/social-client';
import { detectShopContent } from '../scrapers/tiktok/shop-detection';

const BATCH_SIZE = 500;

interface Row {
  id: number;
  raw_data: unknown;
  caption: string | null;
}

async function main() {
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM tiktok_posts WHERE raw_data IS NOT NULL`
  );
  const total = Number(countResult.rows[0]?.count ?? 0);
  console.log(`Backfilling shop detection for ${total} posts with raw_data (batch size ${BATCH_SIZE})...`);

  let lastId = 0;
  let processed = 0;
  let flagged = 0;

  for (;;) {
    const { rows } = await pool.query<Row>(
      `SELECT id, raw_data, caption FROM tiktok_posts
       WHERE raw_data IS NOT NULL AND id > $1
       ORDER BY id ASC
       LIMIT $2`,
      [lastId, BATCH_SIZE]
    );
    if (rows.length === 0) break;

    await Promise.all(rows.map(async (row) => {
      const { isShop, signal } = detectShopContent(row.raw_data, row.caption ?? null);
      if (isShop) flagged++;
      await pool.query(
        `UPDATE tiktok_posts SET is_shop_content = $1, shop_signal = $2 WHERE id = $3`,
        [isShop, signal, row.id]
      );
    }));

    processed += rows.length;
    lastId = rows[rows.length - 1].id;
    console.log(`  ...${processed}/${total} processed (${flagged} flagged so far)`);
  }

  const pct = processed > 0 ? ((flagged / processed) * 100).toFixed(1) : '0.0';
  console.log(`\nDone. Processed ${processed} posts, flagged ${flagged} as shop content (${pct}%).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
