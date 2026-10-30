import { socialQuery } from '../db/social-client';
import { getOfficialTiktokHandles, nonOfficialTiktokSql } from './spike-detection';
import { Flex, FLEX_COLORS as C, fmtCompact as fmt, truncateText as truncate, kpiTile, sentimentBar, deltaBadge, platformColor } from '../alerts/line';

// Shared by the morning (07:00, since yesterday 00:00) and weekly (Mon 08:00,
// last 7 days) LINE digests. Carousel order, built by the callers:
//   Needs Attention (U4–U5 negatives) → Ride the Wave (Top 5 spiked by
//   engagement, UGC only) → Performance (cross-brand KPIs) → one bubble per
//   brand (MizuMi, Bomi, Gentle Colors) with KPIs + Top 5 posts.
//
// `winStart`/`priorStart` are constant SQL timestamp expressions picked by the
// caller — no user input, safe to interpolate.

export interface SentimentCounts { positive: number; negative: number; neutral: number; question: number }

export interface TagCount { tag: string; cnt: number }

export interface DigestPost {
  brand_name: string;
  platform: string;
  caption: string;
  views: number;
  likes: number;
  engagementRate: number | null;
  post_url: string | null;
  author: string | null;
  isOfficial: boolean;
}

export interface BrandDigest {
  name: string;
  slug: string;
  posts: number;
  ugc: number;
  official: number;
  views: number;
  prevUgc: number;
  postsByPlatform: Record<string, number>;
  sentiment: SentimentCounts;
  hashtags: TagCount[];
  topPosts: DigestPost[];
  spikeCount: number;
}

export interface DigestBrand { id: number; name: string; slug: string }

export interface DigestData {
  brands: BrandDigest[];
  hashtags: TagCount[];
}

const BRAND_ORDER = ['mizumi', 'bomi', 'gentle-colors'];
const TOP_N = 5;

const TIKTOK_URL_SQL = `COALESCE(
  NULLIF(tp.post_url, ''),
  CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
    THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
    ELSE NULL END)`;

const X_URL_SQL = `COALESCE(
  NULLIF(twp.post_url, ''),
  CASE WHEN b.twitter_handle IS NOT NULL OR twp.author_handle IS NOT NULL
    THEN 'https://x.com/' || COALESCE(NULLIF(twp.author_handle,''), b.twitter_handle) || '/status/' || twp.post_id
    ELSE NULL END)`;

/** Own brands in digest order: MizuMi, Bomi, Gentle Colors, then any others by name. */
export async function fetchDigestBrands(): Promise<DigestBrand[]> {
  const rows = await socialQuery<{ id: string; name: string; slug: string }>(
    `SELECT id::text, name, slug FROM brands WHERE type = 'own'`,
  );
  const rank = (slug: string) => {
    const i = BRAND_ORDER.indexOf(slug);
    return i === -1 ? BRAND_ORDER.length : i;
  };
  return rows
    .map((r) => ({ id: parseInt(r.id, 10), name: r.name, slug: r.slug }))
    .sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name));
}

interface PostRow {
  brand_id: number; brand_name: string; platform: string; caption: string;
  views: string | null; likes: string | null; engagement_rate: string | null;
  hashtags: string[] | null; author_handle: string | null; post_url: string | null; is_official: boolean;
}

function toDigestPost(r: Omit<PostRow, 'brand_id' | 'hashtags'>): DigestPost {
  return {
    brand_name: r.brand_name,
    platform: r.platform,
    caption: r.caption,
    views: parseInt(r.views ?? '0', 10) || 0,
    likes: parseInt(r.likes ?? '0', 10) || 0,
    engagementRate: r.engagement_rate != null ? parseFloat(r.engagement_rate) : null,
    post_url: r.post_url,
    author: r.author_handle,
    isOfficial: r.is_official,
  };
}

/** Count hashtags by number of posts using them — strips '#', case-insensitive, keeps first-seen spelling. */
function countHashtags(posts: { hashtags: string[] | null }[], limit = TOP_N): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const p of posts) {
    const seen = new Set<string>();
    for (const raw of p.hashtags ?? []) {
      const tag = raw.trim().replace(/^#+/, '');
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      const cur = counts.get(key);
      if (cur) cur.cnt++;
      else counts.set(key, { tag, cnt: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.cnt - a.cnt).slice(0, limit);
}

/**
 * Every own-brand post (TikTok, plus X for MizuMi — docs/scope-x-campaigns.md
 * decision 10) posted in the window, aggregated per brand: post / UGC /
 * official counts, views, comment sentiment (all platforms), hashtags, Top 5
 * posts by views. Official = TikTok feed rows or an own handle found via
 * search (same rule as the spike alerts); X official = source_type 'feed'.
 */
export async function fetchDigestData(brands: DigestBrand[], winStart: string, priorStart: string): Promise<DigestData> {
  const ids = brands.map((b) => b.id);
  const handles = await getOfficialTiktokHandles();

  const [posts, sentimentRows, prevUgcRows, spikeRows] = await Promise.all([
    socialQuery<PostRow>(
      `SELECT tp.brand_id, b.name AS brand_name, 'tiktok' AS platform, COALESCE(tp.caption,'') AS caption,
              tp.views::text, tp.likes::text, tp.engagement_rate::text, tp.hashtags, tp.author_handle,
              ${TIKTOK_URL_SQL} AS post_url,
              NOT COALESCE(${nonOfficialTiktokSql('tp', '$2')}, false) AS is_official
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE tp.brand_id = ANY($1::int[]) AND tp.posted_at >= ${winStart}
       UNION ALL
       SELECT twp.brand_id, b.name, 'twitter', COALESCE(twp.caption,''),
              twp.views::text, twp.likes::text, twp.engagement_rate::text, twp.hashtags, twp.author_handle,
              ${X_URL_SQL},
              COALESCE(twp.source_type, 'feed') <> 'search'
       FROM twitter_posts twp JOIN brands b ON b.id = twp.brand_id
       WHERE twp.brand_id = ANY($1::int[]) AND b.slug = 'mizumi' AND twp.posted_at >= ${winStart}`,
      [ids, handles],
    ),
    socialQuery<{ brand_id: number; sentiment: string; cnt: string }>(
      `SELECT brand_id, sentiment, COUNT(*)::text AS cnt
       FROM social_comments
       WHERE brand_id = ANY($1::int[]) AND published_at >= ${winStart} AND sentiment IS NOT NULL
       GROUP BY brand_id, sentiment`,
      [ids],
    ),
    socialQuery<{ brand_id: number; cnt: string }>(
      `SELECT tp.brand_id, COUNT(*)::text AS cnt
       FROM tiktok_posts tp
       WHERE tp.brand_id = ANY($1::int[]) AND tp.posted_at >= ${priorStart} AND tp.posted_at < ${winStart}
         AND ${nonOfficialTiktokSql('tp', '$2')}
       GROUP BY tp.brand_id`,
      [ids, handles],
    ),
    socialQuery<{ brand_id: number; cnt: string }>(
      `SELECT tp.brand_id, COUNT(*)::text AS cnt
       FROM tiktok_posts tp
       WHERE tp.brand_id = ANY($1::int[]) AND tp.spike_flag = true AND tp.spike_detected_at >= ${winStart}
         AND ${nonOfficialTiktokSql('tp', '$2')}
       GROUP BY tp.brand_id`,
      [ids, handles],
    ),
  ]);

  const countFor = (rows: { brand_id: number; cnt: string }[], id: number) =>
    parseInt(rows.find((r) => r.brand_id === id)?.cnt ?? '0', 10);

  const digests = brands.map((b): BrandDigest => {
    const mine = posts.filter((p) => p.brand_id === b.id);
    const official = mine.filter((p) => p.is_official).length;
    const sentiment: SentimentCounts = { positive: 0, negative: 0, neutral: 0, question: 0 };
    for (const r of sentimentRows) {
      if (r.brand_id !== b.id) continue;
      const s = r.sentiment as keyof SentimentCounts;
      if (s in sentiment) sentiment[s] = parseInt(r.cnt, 10);
    }
    const postsByPlatform: Record<string, number> = {};
    for (const p of mine) postsByPlatform[p.platform] = (postsByPlatform[p.platform] ?? 0) + 1;

    const digestPosts = mine.map(toDigestPost);
    return {
      name: b.name,
      slug: b.slug,
      posts: mine.length,
      ugc: mine.length - official,
      official,
      views: digestPosts.reduce((s, p) => s + p.views, 0),
      prevUgc: countFor(prevUgcRows, b.id),
      postsByPlatform,
      sentiment,
      hashtags: countHashtags(mine),
      topPosts: [...digestPosts].sort((x, y) => y.views - x.views).slice(0, TOP_N),
      spikeCount: countFor(spikeRows, b.id),
    };
  });

  return { brands: digests, hashtags: countHashtags(posts) };
}

/**
 * "Ride the Wave" — own-brand UGC posts that spiked (newly flagged, or a
 * resurgence alert) within the window, any brand, ranked by engagement rate.
 * Official-account posts excluded (same rule as the real-time spike alerts).
 */
export async function fetchRideTheWave(winStart: string, limit = TOP_N): Promise<DigestPost[]> {
  const handles = await getOfficialTiktokHandles();
  const rows = await socialQuery<Omit<PostRow, 'brand_id' | 'hashtags'>>(
    `SELECT brand_name, platform, caption, views::text, likes::text, engagement_rate::text, author_handle, post_url, is_official
     FROM (
       SELECT b.name AS brand_name, 'tiktok' AS platform, COALESCE(tp.caption,'') AS caption,
              tp.views, tp.likes, tp.engagement_rate, tp.author_handle, ${TIKTOK_URL_SQL} AS post_url, false AS is_official
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE b.type = 'own' AND tp.spike_flag = true
         AND (tp.spike_detected_at >= ${winStart} OR tp.last_alert_at >= ${winStart})
         AND ${nonOfficialTiktokSql('tp', '$2')}
       UNION ALL
       SELECT b.name, 'twitter', COALESCE(twp.caption,''),
              twp.views, twp.likes, twp.engagement_rate, twp.author_handle, ${X_URL_SQL}, false
       FROM twitter_posts twp JOIN brands b ON b.id = twp.brand_id
       WHERE b.slug = 'mizumi' AND twp.spike_flag = true AND twp.spike_detected_at >= ${winStart}
         AND twp.source_type = 'search'
     ) sub
     -- sub.-qualified so these sort the numeric source columns, not the ::text outputs
     ORDER BY sub.engagement_rate DESC NULLS LAST, sub.views DESC NULLS LAST
     LIMIT $1`,
    [limit, handles],
  );
  return rows.map(toDigestPost);
}

export interface UrgentDigestComment {
  content: string;
  brand_name: string;
  platform: string;
  urgency: number;
  post_url: string | null;
}

/** Own-brand urgency>=4 negative comments/tweets in the window, each resolved to a post link where possible. */
export async function fetchUrgentComments(winStart: string, limit = 6): Promise<UrgentDigestComment[]> {
  const rows = await socialQuery<{
    content: string; brand_name: string; platform: string; urgency: number;
    post_id: string | null; post_url: string | null; author_handle: string | null;
  }>(
    `SELECT sc.content, b.name AS brand_name, sc.platform, sc.urgency, sc.post_id,
            COALESCE(tp.post_url, twp.post_url) AS post_url,
            COALESCE(tp.author_handle, twp.author_handle) AS author_handle
     FROM social_comments sc
     JOIN brands b ON b.id = sc.brand_id
     LEFT JOIN tiktok_posts tp ON sc.platform = 'tiktok' AND tp.brand_id = sc.brand_id AND tp.post_id = sc.post_id
     LEFT JOIN twitter_posts twp ON sc.platform = 'twitter' AND twp.brand_id = sc.brand_id AND twp.post_id = sc.post_id
     WHERE b.type = 'own' AND sc.sentiment = 'negative' AND sc.urgency >= 4
       AND sc.published_at >= ${winStart}
     ORDER BY sc.urgency DESC, sc.published_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => {
    let postUrl = r.post_url;
    if (!postUrl && r.post_id && r.author_handle) {
      if (r.platform === 'tiktok') postUrl = `https://www.tiktok.com/@${r.author_handle}/video/${r.post_id}`;
      else if (r.platform === 'twitter') postUrl = `https://x.com/${r.author_handle}/status/${r.post_id}`;
    }
    return { content: r.content, brand_name: r.brand_name, platform: r.platform, urgency: r.urgency, post_url: postUrl };
  });
}

export interface TopicCount { topic: string; cnt: number }

/** Top comment topics (the ราคา/คุณภาพ/... taxonomy sentiment.ts assigns) — distinct from hashtags. */
export async function fetchTopTopics(winStart: string, limit = 5): Promise<TopicCount[]> {
  const rows = await socialQuery<{ topic: string; cnt: string }>(
    `SELECT topic, COUNT(*)::text AS cnt
     FROM social_comments
     WHERE published_at >= ${winStart} AND topic IS NOT NULL AND topic <> ''
     GROUP BY topic ORDER BY COUNT(*) DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ topic: r.topic, cnt: parseInt(r.cnt, 10) }));
}

function sentimentTotal(s: SentimentCounts): number {
  return s.positive + s.negative + s.neutral + s.question;
}

/** One-line interpreted takeaway — the "so what" for the brand. */
export function takeaway(d: BrandDigest): string {
  const { negative, question } = d.sentiment;
  const totalS = sentimentTotal(d.sentiment);
  const negShare = totalS > 0 ? negative / totalS : 0;
  const ugcDelta = d.prevUgc > 0 ? Math.round(((d.ugc - d.prevUgc) / d.prevUgc) * 100) : null;
  const leadUgc = d.topPosts.find((p) => !p.isOfficial && p.author);

  if (negative >= 5 && negShare >= 0.2) return `⚠️ ความเห็นลบ ${Math.round(negShare * 100)}% — ตรวจสอบด่วน`;
  if (d.spikeCount > 0) return `โพสต์ viral ${d.spikeCount} รายการ กระแสกำลังมา`;
  if (ugcDelta != null && ugcDelta >= 50 && d.ugc >= 3) {
    return leadUgc ? `UGC โต ${ugcDelta}% — นำโดย @${leadUgc.author}` : `UGC โต ${ugcDelta}% จากรอบก่อน`;
  }
  if (d.prevUgc === 0 && d.ugc >= 3) return `เริ่มมีคนพูดถึง ${d.ugc} โพสต์`;
  if (question >= 5) return `คำถาม ${question} รายการ — โอกาสตอบเพื่อปิดการขาย`;
  if (d.official > 0) return `โพสต์ทางการใหม่ ${d.official} รายการ`;
  if (d.ugc > 0) return `มี UGC ${d.ugc} โพสต์`;
  return 'ทรงตัว ไม่มีสัญญาณเด่น';
}

export interface DigestBubbleOpts {
  dateStr: string;
}

function sectionLabel(text: string): Flex {
  return { type: 'text', text, size: 'xxs', color: C.muted, margin: 'lg' };
}

/** 2×2 KPI grid: posts / UGC (with delta) / official / views. */
function kpiGrid(posts: number, ugc: number, prevUgc: number, official: number, views: number): Flex[] {
  return [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [kpiTile(String(posts), 'โพสต์ทั้งหมด'), kpiTile(String(ugc), 'UGC', deltaBadge(ugc, prevUgc))],
    },
    {
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
      contents: [kpiTile(String(official), 'ทางการ'), kpiTile(fmt(views), 'วิวรวม')],
    },
  ];
}

function sentimentSection(s: SentimentCounts, caption: string): Flex[] {
  const total = sentimentTotal(s);
  if (total === 0) return [];
  const pct = (n: number) => Math.round((n / total) * 100);
  return [
    { type: 'separator', margin: 'lg' },
    { type: 'text', text: caption, size: 'xxs', color: C.muted, margin: 'lg', wrap: true },
    sentimentBar(s.positive, s.negative, s.neutral),
    {
      type: 'text', size: 'xs', color: C.text, margin: 'sm', wrap: true,
      text: `บวก ${s.positive} (${pct(s.positive)}%) · กลาง ${s.neutral} (${pct(s.neutral)}%) · ลบ ${s.negative} (${pct(s.negative)}%) · คำถาม ${s.question}`,
    },
  ];
}

function hashtagSection(tags: TagCount[]): Flex[] {
  if (!tags.length) return [];
  return [
    { type: 'separator', margin: 'lg' },
    sectionLabel('🏷 แฮชแท็กยอดนิยม'),
    { type: 'text', size: 'xs', color: C.text, wrap: true, margin: 'xs', text: tags.map((h) => `#${h.tag} (${h.cnt})`).join('   ') },
  ];
}

/** Ranked, tappable post rows (→ the post). `showBrand` for cross-brand lists. */
function postRows(posts: DigestPost[], showBrand: boolean): Flex[] {
  const rows: Flex[] = [];
  posts.forEach((p, i) => {
    const tag = p.isOfficial ? 'ทางการ' : `UGC${p.author ? ` @${p.author}` : ''}`;
    const label = [showBrand ? p.brand_name : null, p.platform, tag].filter(Boolean).join(' · ');
    const stats = [`👁 ${fmt(p.views)}`, `❤️ ${fmt(p.likes)}`];
    if (p.engagementRate != null) stats.push(`📈 ${p.engagementRate.toFixed(2)}%`);
    const box: Flex = {
      type: 'box', layout: 'vertical', spacing: 'xs', margin: i === 0 ? 'sm' : 'md',
      contents: [
        { type: 'text', text: `${i + 1}. ${label}`, size: 'xxs', weight: 'bold', color: platformColor(p.platform), wrap: true },
        { type: 'text', text: truncate(p.caption || '(ไม่มีแคปชั่น)'), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
        { type: 'text', text: stats.join('   '), size: 'xs', color: C.navy, weight: 'bold', margin: 'xs' },
      ],
    };
    if (p.post_url && /^https?:\/\//.test(p.post_url)) box.action = { type: 'uri', label: 'ดูโพสต์', uri: p.post_url };
    if (i > 0) rows.push({ type: 'separator', margin: 'md' });
    rows.push(box);
  });
  return rows;
}

/**
 * "🔥 Needs Attention" — urgency 4–5 negative comments/tweets in the window,
 * each linked to its post. Which digest this is (morning vs weekly) is
 * conveyed by the plain text message sent right before the carousel.
 */
export function needsAttentionBubble(opts: DigestBubbleOpts, urgent: UrgentDigestComment[]): Flex {
  const body: Flex[] = [];

  if (urgent.length === 0) {
    body.push({ type: 'text', text: '✓ ไม่มีคอมเมนต์ลบระดับ U4–U5', size: 'sm', color: C.text, wrap: true });
  } else {
    body.push({ type: 'text', text: `🚨 คอมเมนต์ลบเร่งด่วน U4–U5 (${urgent.length})`, size: 'xxs', color: C.muted });
    urgent.forEach((u, i) => {
      const box: Flex = {
        type: 'box', layout: 'vertical', spacing: 'xs', margin: i === 0 ? 'sm' : 'md',
        contents: [
          {
            type: 'text', size: 'xs', weight: 'bold', color: platformColor(u.platform, C.neg),
            text: `U${u.urgency} · ${u.brand_name} · ${u.platform}`,
          },
          { type: 'text', text: truncate(u.content), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
        ],
      };
      if (u.post_url && /^https?:\/\//.test(u.post_url)) {
        (box.contents as Flex[]).push({ type: 'text', text: '🔗 ดูโพสต์', size: 'xs', color: C.blue, weight: 'bold', margin: 'xs' });
        box.action = { type: 'uri', label: 'ดูโพสต์', uri: u.post_url };
      }
      if (i > 0) body.push({ type: 'separator', margin: 'md' });
      body.push(box);
    });
  }

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: urgent.length > 0 ? C.neg : C.green, paddingAll: '16px',
      contents: [
        { type: 'text', text: '🔥 Needs Attention', color: C.white, weight: 'bold', size: 'xl' },
        { type: 'text', text: `Mizuhada · ${opts.dateStr}`, color: '#fff1f2', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
  };
}

/** "📈 Ride the Wave" — Top 5 spiked UGC posts by engagement, any brand. Caller skips this bubble when the list is empty. */
export function rideTheWaveBubble(posts: DigestPost[]): Flex {
  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.ques, paddingAll: '14px',
      contents: [
        { type: 'text', text: '📈 Ride the Wave', color: C.white, weight: 'bold', size: 'lg' },
        { type: 'text', text: `Top ${posts.length} โพสต์กำลังมาแรง — เรียงตาม engagement`, color: '#fff7ed', size: 'xs', margin: 'sm', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: postRows(posts, true) },
  };
}

/** "📊 Performance" — cross-brand KPIs: posts / UGC / official / views, sentiment, hashtags (+ comment topics when given). */
export function performanceBubble(opts: DigestBubbleOpts, digests: BrandDigest[], hashtags: TagCount[], topics: TopicCount[] = []): Flex {
  const sum = (f: (d: BrandDigest) => number) => digests.reduce((s, d) => s + f(d), 0);
  const sentiment: SentimentCounts = {
    positive: sum((d) => d.sentiment.positive),
    negative: sum((d) => d.sentiment.negative),
    neutral: sum((d) => d.sentiment.neutral),
    question: sum((d) => d.sentiment.question),
  };

  const body: Flex[] = [
    ...kpiGrid(sum((d) => d.posts), sum((d) => d.ugc), sum((d) => d.prevUgc), sum((d) => d.official), sum((d) => d.views)),
    ...sentimentSection(sentiment, '📊 ภาพรวมความรู้สึก (คอมเมนต์ทุกแพลตฟอร์ม)'),
    ...hashtagSection(hashtags),
  ];
  if (topics.length) {
    body.push(
      { type: 'separator', margin: 'lg' },
      sectionLabel('🗣 หัวข้อยอดนิยม'),
      { type: 'text', size: 'xs', color: C.text, wrap: true, margin: 'xs', text: topics.map((t) => `${t.topic} (${t.cnt})`).join('   ') },
    );
  }

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.navy, paddingAll: '16px',
      contents: [
        { type: 'text', text: '📊 Performance', color: C.white, weight: 'bold', size: 'xl' },
        { type: 'text', text: `ทุกแบรนด์ · ${opts.dateStr}`, color: '#dbeafe', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
  };
}

/** Per-brand bubble: posts / UGC / official / views, sentiment, hashtags, Top 5 posts (tappable). */
export function brandBubble(d: BrandDigest, periodLabel: string): Flex {
  const body: Flex[] = kpiGrid(d.posts, d.ugc, d.prevUgc, d.official, d.views);

  const platforms = Object.entries(d.postsByPlatform);
  if (platforms.length > 1) {
    const label = (p: string) => (p === 'tiktok' ? '📱 TikTok' : p === 'twitter' ? '🐦 X' : p);
    body.push({ type: 'text', text: platforms.map(([p, n]) => `${label(p)} ${n}`).join(' · '), size: 'xxs', color: C.muted, margin: 'sm' });
  }

  body.push(
    ...sentimentSection(d.sentiment, `ความรู้สึก (คอมเมนต์${periodLabel} · อาจอยู่บนโพสต์เก่า)`),
    ...hashtagSection(d.hashtags),
  );

  if (d.topPosts.length) {
    body.push({ type: 'separator', margin: 'lg' }, sectionLabel(`🏆 Top ${d.topPosts.length} โพสต์ (ยอดวิว)`), ...postRows(d.topPosts, false));
  }

  const bubble: Flex = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.navy, paddingAll: '14px',
      contents: [
        { type: 'text', text: d.name, color: C.white, weight: 'bold', size: 'lg' },
        { type: 'text', text: takeaway(d), color: C.sub, size: 'xs', wrap: true, margin: 'sm' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: body },
  };

  const dash = process.env.DASHBOARD_PUBLIC_URL;
  if (dash && /^https?:\/\//.test(dash)) {
    bubble.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{ type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: 'เปิด Dashboard', uri: dash } }],
    };
  }
  return bubble;
}
