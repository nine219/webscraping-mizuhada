import { socialQuery } from '../db/social-client';
import { sendLineFlex, Flex, platformStripe, truncateText as truncate } from '../alerts/line';

const C = {
  navy: '#0f172a',
  white: '#ffffff',
  muted: '#94a3b8',
  sub: '#cbd5e1',
  text: '#334155',
  blue: '#3b82f6',
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface BrandRow { name: string; cnt: number; views: number }
interface TopPost { caption: string; views: number; likes: number; author: string | null; post_url: string; brand: string }

export async function sendScrapeSummary(label: string, runStartedAt: number): Promise<void> {
  const [brandRows, topRows] = await Promise.all([
    socialQuery<{ name: string; cnt: string; views: string }>(
      // New this run (first_seen) AND actually posted recently — excludes old posts the
      // keyword search keeps re-surfacing, so this reports genuinely-fresh UGC mentions.
      `SELECT b.name, COUNT(*)::text AS cnt, COALESCE(SUM(tp.views),0)::text AS views
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE tp.first_seen_at >= to_timestamp($1 / 1000.0) AND tp.source_type = 'search'
         AND tp.posted_at >= NOW() - INTERVAL '3 days'
         AND b.type = 'own'
       GROUP BY b.name ORDER BY COUNT(*) DESC`,
      [runStartedAt],
    ),
    socialQuery<{ caption: string; views: string; likes: string; author_handle: string | null; post_url: string; name: string }>(
      `SELECT COALESCE(tp.caption,'') AS caption, tp.views::text, tp.likes::text,
              tp.author_handle, b.name,
              COALESCE(
                NULLIF(tp.post_url, ''),
                CASE WHEN tp.author_handle IS NOT NULL OR b.tiktok_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                  ELSE '' END
              ) AS post_url
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE tp.first_seen_at >= to_timestamp($1 / 1000.0) AND tp.source_type = 'search'
         AND tp.posted_at >= NOW() - INTERVAL '3 days'
         AND b.type = 'own'
       ORDER BY tp.views DESC LIMIT 1`,
      [runStartedAt],
    ),
  ]);

  const brands: BrandRow[] = brandRows.map((r) => ({ name: r.name, cnt: parseInt(r.cnt, 10), views: parseInt(r.views, 10) }));
  const total = brands.reduce((s, b) => s + b.cnt, 0);
  const totalViews = brands.reduce((s, b) => s + b.views, 0);
  const tp = topRows[0];
  const top: TopPost | null = tp
    ? { caption: tp.caption, views: parseInt(tp.views, 10), likes: parseInt(tp.likes, 10), author: tp.author_handle, post_url: tp.post_url, brand: tp.name }
    : null;

  const time = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });

  const bubble = total === 0
    ? buildEmptyBubble(label, time)
    : buildBubble(label, time, total, totalViews, brands, top);

  const altText = total === 0
    ? `✅ ${label} เสร็จ (${time}) — ไม่พบโพสต์ใหม่`
    : `✅ ${label} เสร็จ (${time}) — โพสต์ใหม่ ${total} · วิว ${fmt(totalViews)}`;

  await sendLineFlex(altText, bubble);
}

function buildEmptyBubble(label: string, time: string): Flex {
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#000000', paddingAll: '14px',
      contents: [
        platformStripe('tiktok', '4px'),
        { type: 'text', text: '✅ สแครปเสร็จ', color: C.white, weight: 'bold', size: 'md', margin: 'md' },
        { type: 'text', text: `${label} · ${time}`, color: '#25F4EE', size: 'xs', margin: 'xs' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
      contents: [
        { type: 'text', text: 'ไม่พบโพสต์ใหม่ในรอบนี้', size: 'sm', color: C.text },
      ],
    },
  };
}

function buildBubble(label: string, time: string, total: number, totalViews: number, brands: BrandRow[], top: TopPost | null): Flex {
  const body: Flex[] = [];

  // KPI tiles — new posts + total views
  body.push({
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [
      kpiTile(String(total), 'โพสต์ใหม่'),
      kpiTile(fmt(totalViews), 'วิวรวม'),
    ],
  });

  // Per-brand breakdown
  body.push({ type: 'text', text: 'แยกตามแบรนด์', size: 'xxs', color: C.muted, margin: 'lg' });
  for (const b of brands) {
    body.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: b.name, size: 'sm', color: C.text, flex: 3 },
        { type: 'text', text: `${b.cnt} โพสต์`, size: 'sm', color: C.navy, weight: 'bold', flex: 2, align: 'end' },
        { type: 'text', text: `👁 ${fmt(b.views)}`, size: 'xs', color: C.muted, flex: 2, align: 'end', gravity: 'center' },
      ],
    });
  }

  // Top new post
  if (top && top.views > 0) {
    const who = top.author ? `@${top.author}` : top.brand;
    body.push(
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: `🔥 โพสต์ใหม่มาแรง · ${who}`, size: 'xxs', color: C.muted, margin: 'lg' },
      { type: 'text', text: truncate(top.caption || '(ไม่มีแคปชั่น)'), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
      { type: 'text', text: `👁 ${fmt(top.views)}   ❤️ ${fmt(top.likes)}`, size: 'xs', color: C.navy, weight: 'bold', margin: 'xs' },
    );
  }

  const bubble: Flex = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: '#000000', paddingAll: '16px',
      contents: [
        platformStripe('tiktok', '4px'),
        { type: 'text', text: '✅ สแครปเสร็จแล้ว', color: C.white, weight: 'bold', size: 'lg', margin: 'md' },
        { type: 'text', text: `${label} · ${time}`, color: '#25F4EE', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
  };

  if (top?.post_url && /^https?:\/\//.test(top.post_url)) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'button', style: 'primary', color: C.blue, height: 'sm',
        action: { type: 'uri', label: 'ดูโพสต์มาแรง', uri: top.post_url },
      }],
    };
  }

  return bubble;
}

function kpiTile(value: string, label: string): Flex {
  return {
    type: 'box', layout: 'vertical', flex: 1,
    contents: [
      { type: 'text', text: value, weight: 'bold', size: 'xl', color: C.navy },
      { type: 'text', text: label, size: 'xxs', color: C.muted, margin: 'xs' },
    ],
  };
}
