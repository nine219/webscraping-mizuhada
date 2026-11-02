import { socialQuery } from '../db/social-client';
import { getOfficialTiktokHandles, nonOfficialTiktokSql } from './spike-detection';
import { sendLineFlex, Flex, FLEX_COLORS as C, platformStripe, truncateText as truncate, sanitizeCarousel } from '../alerts/line';

const TOP_N = 5;

interface PerformanceRow {
  brand_name: string;
  caption: string | null;
  views: string;
  likes: string;
  engagement_rate: string | null;
  post_url: string | null;
  gained: string;
  is_new: boolean;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const RANK_MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

/**
 * Daily 18:00 LINE "TikTok Top 5 Performance" — the 5 UGC posts (own brands,
 * official accounts excluded) that gained the most views in the last 24h,
 * old and new posts alike:
 *   - ใหม่ (posted <24h ago): every view counts as gained (baseline 0)
 *   - เก่า (posted ≥24h ago): views now − the latest tiktok_view_snapshots
 *     row at or before 24h ago; if the post has no snapshot that old (first
 *     seen within the window, or right after the snapshot table shipped),
 *     falls back to its earliest snapshot — growth since we first saw it.
 * Only posts re-scraped in the last 24h can have moved, so that bounds the
 * scan. Separate from the real-time spike alert (spike-detection.ts). Sends
 * nothing if no post gained views — a quiet day shouldn't page anyone.
 */
export async function sendTikTokDailySpikeDigest(): Promise<void> {
  const officialHandles = await getOfficialTiktokHandles();
  const rows = await socialQuery<PerformanceRow>(
    `SELECT * FROM (
       SELECT b.name AS brand_name, tp.caption, tp.views::text, tp.likes::text,
              tp.engagement_rate::text,
              COALESCE(
                NULLIF(tp.post_url, ''),
                CASE WHEN tp.author_handle IS NOT NULL OR b.tiktok_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                  ELSE NULL END
              ) AS post_url,
              (tp.posted_at >= NOW() - interval '24 hours') AS is_new,
              tp.views - COALESCE(
                CASE WHEN tp.posted_at >= NOW() - interval '24 hours' THEN 0 END,
                (SELECT s.views FROM tiktok_view_snapshots s
                  WHERE s.tiktok_post_id = tp.id AND s.captured_at <= NOW() - interval '24 hours'
                  ORDER BY s.captured_at DESC LIMIT 1),
                (SELECT s.views FROM tiktok_view_snapshots s
                  WHERE s.tiktok_post_id = tp.id
                  ORDER BY s.captured_at ASC LIMIT 1),
                tp.views
              ) AS gained
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE b.type = 'own'
         AND tp.scraped_at >= NOW() - interval '24 hours'
         AND ${nonOfficialTiktokSql('tp', '$1')}
     ) sub
     WHERE sub.gained > 0
     ORDER BY sub.gained DESC
     LIMIT ${TOP_N}`,
    [officialHandles],
  );

  if (rows.length === 0) {
    console.log('[TikTokPerformanceDigest] No post gained views in the last 24h — skipping.');
    return;
  }

  const dateStr = new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
  });

  const items: Flex[] = rows.map((r, i) => {
    const views = parseInt(r.views, 10);
    const likes = parseInt(r.likes, 10);
    const gained = parseInt(r.gained, 10);
    const engRate = r.engagement_rate ? parseFloat(r.engagement_rate) : null;
    const box: Flex = {
      type: 'box', layout: 'vertical', spacing: 'xs', margin: i === 0 ? 'none' : 'lg',
      contents: [
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `${RANK_MEDALS[i] ?? `${i + 1}.`} ${r.brand_name}`, size: 'sm', weight: 'bold', color: C.navy, flex: 1 },
            { type: 'text', text: r.is_new ? 'ใหม่' : 'เก่า', size: 'xxs', weight: 'bold', color: r.is_new ? C.pos : C.muted, flex: 0, gravity: 'center' },
          ],
        },
        { type: 'text', text: truncate(r.caption || '(ไม่มีแคปชั่น)'), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
        { type: 'text', text: `🚀 +${fmt(gained)} วิว ใน 24 ชม.`, size: 'sm', weight: 'bold', color: C.navy, margin: 'xs' },
        {
          type: 'box', layout: 'horizontal', margin: 'xs',
          contents: [
            { type: 'text', text: `👁 ${fmt(views)}`, size: 'xs', color: C.muted, flex: 0 },
            { type: 'text', text: `❤️ ${fmt(likes)}`, size: 'xs', color: C.muted, flex: 0, margin: 'md' },
            ...(engRate !== null ? [{ type: 'text', text: `📈 ${engRate.toFixed(2)}%`, size: 'xs', color: C.muted, flex: 0, margin: 'md' } as Flex] : []),
          ],
        },
      ],
    };
    if (i > 0) box.contents = [{ type: 'separator', margin: 'lg' } as Flex, ...(box.contents as Flex[])];
    if (r.post_url && /^https?:\/\//.test(r.post_url)) box.action = { type: 'uri', uri: r.post_url };
    return box;
  });

  const bubble: Flex = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#000000', paddingAll: '16px',
      contents: [
        platformStripe('tiktok', '4px'),
        { type: 'text', text: '🏆 TikTok Top 5 Performance วันนี้', color: C.white, weight: 'bold', size: 'lg', margin: 'md', wrap: true },
        { type: 'text', text: `${dateStr} · วัดจากวิวที่เพิ่มใน 24 ชม.`, color: '#25F4EE', size: 'xs', margin: 'xs', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: items },
  };

  const [safeBubble] = sanitizeCarousel([bubble]);
  const altText = `🏆 TikTok Top 5 Performance ${dateStr} — อันดับ 1: ${rows[0].brand_name} (+${fmt(parseInt(rows[0].gained, 10))} วิว)`;

  await sendLineFlex(altText, safeBubble);
}
