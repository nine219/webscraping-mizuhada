/**
 * Deletes emoji-only / no-text XHS comment rows from social_comments.
 * Usage: npx ts-node -r dotenv/config src/tools/xhs-clean-comments.ts dotenv_config_path=.env.local
 */
import { socialQuery, socialPool } from '../db/social-client';
import { isMeaningfulComment } from '../scrapers/xhs/xhs-comments';

async function main(): Promise<void> {
  const rows = await socialQuery<{ id: number; content: string }>(
    `SELECT id, content FROM social_comments
     WHERE platform = 'xiaohongshu'
       AND external_id LIKE 'xhs\\_%' AND external_id NOT LIKE 'xhs\\_note\\_%'`,
  );

  // Comment content may be "noteCtx\n---\ncomment"; check the comment part only.
  const noise = rows.filter((r) => {
    const comment = r.content.includes('---') ? r.content.split('---').pop()!.trim() : r.content;
    return !isMeaningfulComment(comment);
  });

  if (noise.length === 0) {
    console.log('[XhsClean] No emoji-only comments to remove.');
    await socialPool.end();
    return;
  }

  const ids = noise.map((r) => r.id);
  await socialQuery(`DELETE FROM social_comments WHERE id = ANY($1::int[])`, [ids]);
  console.log(`[XhsClean] Deleted ${ids.length} emoji-only comment(s).`);
  await socialPool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
