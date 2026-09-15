import { socialQuery } from '../src/db/social-client';

async function main() {
  const rows = await socialQuery(`
    SELECT b.slug, ip.search_hashtags, ip.author_handle, ip.caption, ip.likes, ip.comments_count, ip.posted_at
    FROM instagram_posts ip
    JOIN brands b ON b.id = ip.brand_id
    WHERE ip.source_type = 'search'
    ORDER BY ip.posted_at DESC
    LIMIT 20
  `);
  console.table(rows);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
