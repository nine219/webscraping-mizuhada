import { socialQuery } from '../src/db/social-client';

async function main() {
  const rows = await socialQuery(`
    SELECT
      b.slug,
      COUNT(*) FILTER (WHERE ip.source_type = 'search') AS search_posts,
      COUNT(DISTINCT ip.author_handle) FILTER (WHERE ip.source_type = 'search') AS unique_authors,
      MIN(ip.posted_at) FILTER (WHERE ip.source_type = 'search') AS oldest,
      MAX(ip.posted_at) FILTER (WHERE ip.source_type = 'search') AS newest
    FROM instagram_posts ip
    JOIN brands b ON b.id = ip.brand_id
    GROUP BY b.slug
  `);
  console.table(rows);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
