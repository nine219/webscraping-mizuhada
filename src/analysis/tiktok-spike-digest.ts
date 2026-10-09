import { socialQuery } from '../db/social-client';
import { sendLineFlex, Flex, FLEX_COLORS as C, platformStripe, truncateText as truncate, sanitizeCarousel } from '../alerts/line';

const TOP_N = 5;

interface SpikedRow {
  brand_name: string;
  caption: string | null;
  views: string;
  likes: string;
  engagement_rate: string | null;
  post_url: string | null;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const RANK_MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

/**
 * Daily 18:00 LINE summary of the day's spiked TikTok posts (own brands) —
 * any post age qualifies, the only filter is last_alert_at falling on today's
 * Bangkok calendar date (covers both a fresh spike and a same-day resurgence
 * on an older post — see the query comment below). Separate from the
 * real-time spike alert (spike-detection.ts's spikeBubble, fired the moment a
 * spike is found) — this is the end-of-day roundup, capped at the top 5 by
 * views. Sends nothing if no post spiked today — a quiet day shouldn't page
 * anyone.
 */
export async function sendTikTokDailySpikeDigest(): Promise<void> {
  const rows = await socialQuery<SpikedRow>(
    `SELECT b.name AS brand_name, tp.caption, tp.views::text, tp.likes::text,
            tp.engagement_rate::text,
            COALESCE(
              NULLIF(tp.post_url, ''),
              CASE WHEN tp.author_handle IS NOT NULL OR b.tiktok_handle IS NOT NULL
                THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                ELSE NULL END
            ) AS post_url
     FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
     WHERE b.type = 'own' AND tp.spike_flag = true
       -- last_alert_at covers both an initial spike (set alongside
       -- spike_detected_at the moment it's first flagged) AND a same-day
       -- resurgence on an older post (detectResurgence() only ever touches
       -- last_alert_at/last_alert_views, never spike_detected_at) — filtering
       -- on spike_detected_at alone would miss resurgences on posts that
       -- first spiked on an earlier day.
       AND (tp.last_alert_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
     ORDER BY tp.views DESC
     LIMIT ${TOP_N}`,
  );

  if (rows.length === 0) {
    console.log('[TikTokSpikeDigest] No posts spiked today — skipping.');
    return;
  }

  const dateStr = new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
  });

  const items: Flex[] = rows.map((r, i) => {
    const views = parseInt(r.views, 10);
    const likes = parseInt(r.likes, 10);
    const engRate = r.engagement_rate ? parseFloat(r.engagement_rate) : null;
    const box: Flex = {
      type: 'box', layout: 'vertical', spacing: 'xs', margin: i === 0 ? 'none' : 'lg',
      contents: [
        { type: 'text', text: `${RANK_MEDALS[i] ?? `${i + 1}.`} ${r.brand_name}`, size: 'sm', weight: 'bold', color: C.navy },
        { type: 'text', text: truncate(r.caption || '(ไม่มีแคปชั่น)'), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
        {
          type: 'box', layout: 'horizontal', margin: 'xs',
          contents: [
            { type: 'text', text: `👁 ${fmt(views)}`, size: 'xs', color: C.navy, weight: 'bold', flex: 0 },
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
        { type: 'text', text: '🏆 TikTok Top 5 Spiked วันนี้', color: C.white, weight: 'bold', size: 'lg', margin: 'md' },
        { type: 'text', text: dateStr, color: '#25F4EE', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: items },
  };

  const [safeBubble] = sanitizeCarousel([bubble]);
  const topBrand = rows[0].brand_name;
  const altText = `🏆 TikTok Top 5 Spiked ${dateStr} — อันดับ 1: ${topBrand} (👁 ${fmt(parseInt(rows[0].views, 10))})`;

  await sendLineFlex(altText, safeBubble);
}
