import { socialQuery } from '../db/social-client';
import { Flex, FLEX_COLORS as C, fmtCompact as fmt, truncateText as truncate, kpiTile, sentimentBar, deltaBadge, platformColor, platformAccentBar } from '../alerts/line';

export interface BrandDigest {
  name: string;
  ownPosts: number;
  ownViews: number;
  ownLikes: number;
  ugcMentions: number;
  ugcViews: number;
  prevUgcMentions: number;
  sentiment: { positive: number; negative: number; neutral: number; question: number };
  topPost: { caption: string; views: number; likes: number; post_url: string; author: string | null; isUgc: boolean } | null;
  spikeCount: number;
  // X activity for this brand, clustered separately in brandBubble() — null when
  // the brand isn't X-scoped (docs/scope-x-campaigns.md decision 10: MizuMi only).
  twitter: PlatformStats | null;
}

export interface PlatformStats {
  posts: number;
  views: number;
  likes: number;
  sentiment: { positive: number; negative: number; neutral: number; question: number };
  topPost: { caption: string; views: number; likes: number; post_url: string; author: string | null } | null;
  spikeCount: number;
}

/** X/Twitter equivalent of the TikTok stats block below — twitter_posts + social_comments(platform='twitter'). */
export async function fetchTwitterStats(brandId: number, winStart: string): Promise<PlatformStats> {
  const [postsRes, sentimentRes, topPostRes, spikeRes] = await Promise.all([
    socialQuery<{ post_count: string; total_views: string; total_likes: string }>(
      `SELECT COUNT(*)::text AS post_count, COALESCE(SUM(views),0)::text AS total_views,
              COALESCE(SUM(likes),0)::text AS total_likes
       FROM twitter_posts
       WHERE brand_id = $1 AND posted_at >= ${winStart}`,
      [brandId],
    ),
    socialQuery<{ sentiment: string; cnt: string }>(
      `SELECT sentiment, COUNT(*)::text AS cnt
       FROM social_comments
       WHERE brand_id = $1 AND platform = 'twitter'
         AND published_at >= ${winStart}
         AND sentiment IS NOT NULL
       GROUP BY sentiment`,
      [brandId],
    ),
    socialQuery<{ caption: string; views: string; likes: string; post_url: string; author_handle: string | null }>(
      `SELECT COALESCE(caption,'') AS caption, views::text, likes::text,
              COALESCE(NULLIF(post_url,''), '') AS post_url, author_handle
       FROM twitter_posts
       WHERE brand_id = $1 AND posted_at >= ${winStart}
       ORDER BY views DESC LIMIT 1`,
      [brandId],
    ),
    socialQuery<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM twitter_posts
       WHERE brand_id = $1 AND spike_flag = true
         AND spike_detected_at >= ${winStart}`,
      [brandId],
    ),
  ]);

  const p = postsRes[0];
  const sentiment = { positive: 0, negative: 0, neutral: 0, question: 0 };
  for (const row of sentimentRes) {
    const s = row.sentiment as keyof typeof sentiment;
    if (s in sentiment) sentiment[s] = parseInt(row.cnt, 10);
  }
  const tp = topPostRes[0];

  return {
    posts: parseInt(p.post_count, 10),
    views: parseInt(p.total_views, 10),
    likes: parseInt(p.total_likes, 10),
    sentiment,
    topPost: tp && parseInt(tp.views, 10) > 0
      ? { caption: tp.caption, views: parseInt(tp.views, 10), likes: parseInt(tp.likes, 10), post_url: tp.post_url, author: tp.author_handle }
      : null,
    spikeCount: parseInt(spikeRes[0]?.cnt ?? '0', 10),
  };
}

/**
 * `winStart`/`priorStart` are constant SQL timestamp expressions (Bangkok-based) —
 * no user input, safe to interpolate. Callers pick the window (1 day for the
 * morning digest, 7 days for the weekly digest).
 */
export async function fetchBrandDigest(
  brandId: number,
  brandName: string,
  winStart: string,
  priorStart: string,
  brandSlug?: string,
): Promise<BrandDigest> {
  const [ownRes, ugcRes, prevUgcRes, sentimentRes, topPostRes, spikeRes, twitter] = await Promise.all([
    socialQuery<{ post_count: string; total_views: string; total_likes: string }>(
      `SELECT COUNT(*)::text AS post_count, COALESCE(SUM(views),0)::text AS total_views,
              COALESCE(SUM(likes),0)::text AS total_likes
       FROM tiktok_posts
       WHERE brand_id = $1 AND source_type = 'feed'
         AND posted_at >= ${winStart}`,
      [brandId],
    ),
    socialQuery<{ post_count: string; total_views: string }>(
      `SELECT COUNT(*)::text AS post_count, COALESCE(SUM(views),0)::text AS total_views
       FROM tiktok_posts
       WHERE brand_id = $1 AND source_type = 'search'
         AND posted_at >= ${winStart}`,
      [brandId],
    ),
    socialQuery<{ post_count: string }>(
      `SELECT COUNT(*)::text AS post_count
       FROM tiktok_posts
       WHERE brand_id = $1 AND source_type = 'search'
         AND posted_at >= ${priorStart} AND posted_at < ${winStart}`,
      [brandId],
    ),
    socialQuery<{ sentiment: string; cnt: string }>(
      `SELECT sentiment, COUNT(*)::text AS cnt
       FROM social_comments
       WHERE brand_id = $1
         AND published_at >= ${winStart}
         AND sentiment IS NOT NULL
       GROUP BY sentiment`,
      [brandId],
    ),
    socialQuery<{ caption: string; views: string; likes: string; post_url: string; author_handle: string | null; source_type: string }>(
      `SELECT COALESCE(tp.caption,'') AS caption, tp.views::text, tp.likes::text,
              COALESCE(
                NULLIF(tp.post_url, ''),
                CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                  ELSE '' END
              ) AS post_url,
              tp.author_handle, tp.source_type
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE tp.brand_id = $1
         AND tp.posted_at >= ${winStart}
       ORDER BY tp.views DESC LIMIT 1`,
      [brandId],
    ),
    socialQuery<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM tiktok_posts
       WHERE brand_id = $1 AND spike_flag = true
         AND spike_detected_at >= ${winStart}`,
      [brandId],
    ),
    brandSlug === 'mizumi' ? fetchTwitterStats(brandId, winStart) : Promise.resolve(null),
  ]);

  const own = ownRes[0];
  const ugc = ugcRes[0];
  const sentiment = { positive: 0, negative: 0, neutral: 0, question: 0 };
  for (const row of sentimentRes) {
    const s = row.sentiment as keyof typeof sentiment;
    if (s in sentiment) sentiment[s] = parseInt(row.cnt, 10);
  }
  const tp = topPostRes[0];

  return {
    name: brandName,
    ownPosts: parseInt(own.post_count, 10),
    ownViews: parseInt(own.total_views, 10),
    ownLikes: parseInt(own.total_likes, 10),
    ugcMentions: parseInt(ugc.post_count, 10),
    ugcViews: parseInt(ugc.total_views, 10),
    prevUgcMentions: parseInt(prevUgcRes[0]?.post_count ?? '0', 10),
    sentiment,
    topPost: tp
      ? {
          caption: tp.caption, views: parseInt(tp.views, 10), likes: parseInt(tp.likes, 10),
          post_url: tp.post_url, author: tp.author_handle, isUgc: tp.source_type === 'search',
        }
      : null,
    spikeCount: parseInt(spikeRes[0]?.cnt ?? '0', 10),
    twitter,
  };
}

export async function fetchTopHashtags(winStart: string): Promise<{ tag: string; cnt: number }[]> {
  const rows = await socialQuery<{ hashtag: string; cnt: string }>(
    `SELECT hashtag, COUNT(*)::text AS cnt
     FROM (
       SELECT unnest(hashtags) AS hashtag FROM tiktok_posts
       WHERE posted_at >= ${winStart} AND hashtags IS NOT NULL
     ) sub
     GROUP BY hashtag ORDER BY COUNT(*) DESC LIMIT 5`,
    [],
  );
  return rows.map((r) => ({ tag: r.hashtag, cnt: parseInt(r.cnt, 10) }));
}

export interface TopPost {
  brand_name: string;
  platform: string;
  caption: string;
  views: number;
  likes: number;
  post_url: string;
  author: string | null;
  isUgc: boolean;
}

/** Cross-brand, cross-platform (TikTok + X) top N posts by views, for the Performance section. */
export async function fetchTopPosts(winStart: string, limit = 5): Promise<TopPost[]> {
  const rows = await socialQuery<{
    brand_name: string; platform: string; caption: string; views: string; likes: string;
    post_url: string; author_handle: string | null; source_type: string;
  }>(
    `SELECT * FROM (
       SELECT b.name AS brand_name, 'tiktok' AS platform, COALESCE(tp.caption,'') AS caption,
              tp.views::text, tp.likes::text,
              COALESCE(
                NULLIF(tp.post_url, ''),
                CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                  ELSE '' END
              ) AS post_url,
              tp.author_handle, tp.source_type
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE b.type = 'own' AND tp.posted_at >= ${winStart}
       UNION ALL
       SELECT b.name AS brand_name, 'twitter' AS platform, COALESCE(twp.caption,'') AS caption,
              twp.views::text, twp.likes::text,
              COALESCE(
                NULLIF(twp.post_url, ''),
                CASE WHEN b.twitter_handle IS NOT NULL OR twp.author_handle IS NOT NULL
                  THEN 'https://x.com/' || COALESCE(NULLIF(twp.author_handle,''), b.twitter_handle) || '/status/' || twp.post_id
                  ELSE '' END
              ) AS post_url,
              twp.author_handle, 'feed' AS source_type
       FROM twitter_posts twp JOIN brands b ON b.id = twp.brand_id
       WHERE b.slug = 'mizumi' AND twp.posted_at >= ${winStart}
     ) sub
     ORDER BY views::bigint DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    brand_name: r.brand_name,
    platform: r.platform,
    caption: r.caption,
    views: parseInt(r.views, 10),
    likes: parseInt(r.likes, 10),
    post_url: r.post_url,
    author: r.author_handle,
    isUgc: r.source_type === 'search',
  }));
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

export interface DigestSpikePost {
  brand_name: string;
  platform: string;
  caption: string;
  views: number;
  post_url: string | null;
}

/** Own-brand posts (TikTok + X) that newly crossed the spike threshold within the window — the "ride the wave" list. */
export async function fetchRecentSpikePosts(winStart: string, limit = 6): Promise<DigestSpikePost[]> {
  const rows = await socialQuery<{ brand_name: string; platform: string; caption: string; views: string; post_url: string }>(
    `SELECT * FROM (
       SELECT b.name AS brand_name, 'tiktok' AS platform, COALESCE(tp.caption,'') AS caption, tp.views::text,
              COALESCE(
                NULLIF(tp.post_url, ''),
                CASE WHEN b.tiktok_handle IS NOT NULL OR tp.author_handle IS NOT NULL
                  THEN 'https://www.tiktok.com/@' || COALESCE(NULLIF(tp.author_handle,''), b.tiktok_handle) || '/video/' || tp.post_id
                  ELSE '' END
              ) AS post_url
       FROM tiktok_posts tp JOIN brands b ON b.id = tp.brand_id
       WHERE b.type = 'own' AND tp.spike_flag = true AND tp.spike_detected_at >= ${winStart}
       UNION ALL
       SELECT b.name AS brand_name, 'twitter' AS platform, COALESCE(twp.caption,'') AS caption, twp.views::text,
              COALESCE(
                NULLIF(twp.post_url, ''),
                CASE WHEN b.twitter_handle IS NOT NULL OR twp.author_handle IS NOT NULL
                  THEN 'https://x.com/' || COALESCE(NULLIF(twp.author_handle,''), b.twitter_handle) || '/status/' || twp.post_id
                  ELSE '' END
              ) AS post_url
       FROM twitter_posts twp JOIN brands b ON b.id = twp.brand_id
       WHERE b.slug = 'mizumi' AND twp.spike_flag = true AND twp.spike_detected_at >= ${winStart}
     ) sub
     ORDER BY views::bigint DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ brand_name: r.brand_name, platform: r.platform, caption: r.caption, views: parseInt(r.views, 10), post_url: r.post_url || null }));
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

/** One-line interpreted takeaway — the "so what" for the brand. */
export function takeaway(d: BrandDigest): string {
  const { positive, negative, neutral, question } = d.sentiment;
  const totalS = positive + negative + neutral + question;
  const negShare = totalS > 0 ? negative / totalS : 0;
  const ugcDelta = d.prevUgcMentions > 0 ? Math.round(((d.ugcMentions - d.prevUgcMentions) / d.prevUgcMentions) * 100) : null;

  if (negative >= 5 && negShare >= 0.2) return `⚠️ ความเห็นลบ ${Math.round(negShare * 100)}% — ตรวจสอบด่วน`;
  if (d.spikeCount > 0) return `โพสต์ viral ${d.spikeCount} รายการ กระแสกำลังมา`;
  if (ugcDelta != null && ugcDelta >= 50 && d.ugcMentions >= 3) {
    return d.topPost?.isUgc && d.topPost.author ? `UGC โต ${ugcDelta}% — นำโดย @${d.topPost.author}` : `UGC โต ${ugcDelta}% จากรอบก่อน`;
  }
  if (d.prevUgcMentions === 0 && d.ugcMentions >= 3) return `เริ่มมีคนพูดถึง ${d.ugcMentions} โพสต์`;
  if (question >= 5) return `คำถาม ${question} รายการ — โอกาสตอบเพื่อปิดการขาย`;
  if (d.ownPosts > 0) return `โพสต์ทางการใหม่ ${d.ownPosts} รายการ`;
  if (d.ugcMentions > 0) return `มี UGC ${d.ugcMentions} โพสต์`;
  return 'ทรงตัว ไม่มีสัญญาณเด่น';
}

/** Colored accent bar + label marking which platform a cluster of stats belongs to. */
function platformClusterLabel(platform: string, label: string): Flex {
  return {
    type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'lg',
    contents: [
      platformAccentBar(platform),
      { type: 'text', text: label, size: 'xs', weight: 'bold', color: platformColor(platform), margin: 'sm' },
    ],
  };
}

export function brandBubble(d: BrandDigest, sentimentPeriodLabel: string): Flex {
  const totalViews = d.ownViews + d.ugcViews;
  const { positive, negative, neutral, question } = d.sentiment;
  const newComments = positive + negative + neutral + question;

  const body: Flex[] = [
    platformClusterLabel('tiktok', '📱 TikTok'),
    {
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
      contents: [
        kpiTile(String(d.ownPosts), 'โพสต์ใหม่'),
        kpiTile(String(d.ugcMentions), 'UGC พูดถึง', deltaBadge(d.ugcMentions, d.prevUgcMentions)),
        kpiTile(String(newComments), 'คอมเมนต์ใหม่'),
      ],
    },
    { type: 'text', text: `👁 วิวรวม ${fmt(totalViews)}`, size: 'xxs', color: C.muted, margin: 'sm' },
  ];

  if (newComments > 0) {
    body.push(
      { type: 'text', text: `ความรู้สึก (คอมเมนต์${sentimentPeriodLabel} · อาจอยู่บนโพสต์เก่า)`, size: 'xxs', color: C.muted, margin: 'lg', wrap: true },
      sentimentBar(positive, neutral, negative),
      {
        type: 'text', size: 'xs', color: C.text, margin: 'sm', wrap: true,
        text: `บวก ${positive} · กลาง ${neutral} · ลบ ${negative} · คำถาม ${question}`,
      },
    );
  }

  if (d.topPost && d.topPost.views > 0) {
    const tag = d.topPost.isUgc ? `UGC${d.topPost.author ? ` @${d.topPost.author}` : ''}` : 'ทางการ';
    body.push(
      { type: 'text', text: `🔥 โพสต์เด่น · ${tag}`, size: 'xxs', color: C.muted, margin: 'lg' },
      { type: 'text', text: truncate(d.topPost.caption || '(ไม่มีแคปชั่น)'), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
      { type: 'text', text: `👁 ${fmt(d.topPost.views)}   ❤️ ${fmt(d.topPost.likes)}`, size: 'xs', color: C.navy, weight: 'bold', margin: 'xs' },
    );
  }

  // X cluster — only rendered when this brand has X coverage (twitter !== null,
  // i.e. MizuMi — see docs/scope-x-campaigns.md decision 10).
  if (d.twitter) {
    const tw = d.twitter;
    const twSentimentTotal = tw.sentiment.positive + tw.sentiment.negative + tw.sentiment.neutral + tw.sentiment.question;

    body.push(
      { type: 'separator', margin: 'lg' },
      platformClusterLabel('twitter', '🐦 X'),
      {
        type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
        contents: [
          kpiTile(String(tw.posts), 'โพสต์/ทวีต'),
          kpiTile(String(tw.spikeCount), 'Viral'),
          kpiTile(fmt(tw.views), 'วิวรวม'),
        ],
      },
    );

    if (twSentimentTotal > 0) {
      body.push(
        { type: 'text', text: `ความรู้สึก (คอมเมนต์${sentimentPeriodLabel})`, size: 'xxs', color: C.muted, margin: 'lg', wrap: true },
        sentimentBar(tw.sentiment.positive, tw.sentiment.neutral, tw.sentiment.negative),
        {
          type: 'text', size: 'xs', color: C.text, margin: 'sm', wrap: true,
          text: `บวก ${tw.sentiment.positive} · กลาง ${tw.sentiment.neutral} · ลบ ${tw.sentiment.negative} · คำถาม ${tw.sentiment.question}`,
        },
      );
    }

    if (tw.topPost) {
      body.push(
        { type: 'text', text: `🔥 โพสต์เด่น${tw.topPost.author ? ` · @${tw.topPost.author}` : ''}`, size: 'xxs', color: C.muted, margin: 'lg' },
        { type: 'text', text: truncate(tw.topPost.caption || '(no caption)'), size: 'xs', color: C.text, wrap: true, margin: 'xs' },
        { type: 'text', text: `👁 ${fmt(tw.topPost.views)}   ❤️ ${fmt(tw.topPost.likes)}`, size: 'xs', color: C.navy, weight: 'bold', margin: 'xs' },
      );
    }
  }

  const footer: Flex[] = [];
  if (d.topPost?.post_url && /^https?:\/\//.test(d.topPost.post_url)) {
    footer.push({
      type: 'button', style: 'primary', color: platformColor('tiktok'), height: 'sm',
      action: { type: 'uri', label: 'ดูโพสต์เด่น (TikTok)', uri: d.topPost.post_url },
    });
  }
  if (d.twitter?.topPost?.post_url && /^https?:\/\//.test(d.twitter.topPost.post_url)) {
    footer.push({
      type: 'button', style: 'primary', color: platformColor('twitter'), height: 'sm',
      action: { type: 'uri', label: 'ดูโพสต์เด่น (X)', uri: d.twitter.topPost.post_url },
    });
  }
  const dash = process.env.DASHBOARD_PUBLIC_URL;
  if (dash && /^https?:\/\//.test(dash)) {
    footer.push({
      type: 'button', style: 'secondary', height: 'sm',
      action: { type: 'uri', label: 'เปิด Dashboard', uri: dash },
    });
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
  if (footer.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer };
  return bubble;
}

export interface DigestBubbleOpts {
  dateStr: string;
}

/** Brands whose negative-comment share crossed 20% this window (same bar as takeaway() elsewhere). */
export function negSpikeBrands(digests: BrandDigest[]): BrandDigest[] {
  return digests.filter((d) => {
    const { positive, negative, neutral, question } = d.sentiment;
    const total = positive + negative + neutral + question;
    return negative >= 5 && total > 0 && negative / total >= 0.2;
  });
}

/**
 * "🔥 Needs Attention" — lead bubble of the carousel. Which digest this is
 * (morning vs weekly) is conveyed by a plain text message sent right before
 * this carousel, not by anything inside the bubbles themselves. Two signal
 * types, both with a direct post link when one exists: (1) individual
 * urgency>=4 negative comments/tweets within the window, (2) negSpikeBrands()
 * above — that one has no single post to link since it's a brand-wide ratio,
 * not one comment.
 */
export function needsAttentionBubble(opts: DigestBubbleOpts, urgent: UrgentDigestComment[], digests: BrandDigest[]): Flex {
  const negBrands = negSpikeBrands(digests);

  const body: Flex[] = [];

  if (urgent.length === 0 && negBrands.length === 0) {
    body.push({ type: 'text', text: '✓ ไม่มีสัญญาณผิดปกติ — ทุกอย่างเรียบร้อย', size: 'sm', color: C.text, wrap: true });
  } else {
    if (urgent.length > 0) {
      body.push({ type: 'text', text: `🚨 คอมเมนต์เร่งด่วน (${urgent.length})`, size: 'xxs', color: C.muted });
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
        if (u.post_url && /^https?:\/\//.test(u.post_url)) box.action = { type: 'uri', uri: u.post_url };
        body.push(box);
      });
    }
    if (negBrands.length > 0) {
      if (urgent.length > 0) body.push({ type: 'separator', margin: 'lg' });
      body.push({ type: 'text', text: '⚠️ ความเห็นลบสูง', size: 'xxs', color: C.muted, margin: urgent.length > 0 ? 'lg' : 'none' });
      for (const d of negBrands) {
        const { negative, positive, neutral, question } = d.sentiment;
        const total = positive + negative + neutral + question;
        body.push({
          type: 'text', size: 'xs', color: C.text, margin: 'sm', wrap: true,
          text: `${d.name}: ลบ ${Math.round((negative / total) * 100)}% (${negative} คอมเมนต์)`,
        });
      }
    }
  }

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: (urgent.length > 0 || negBrands.length > 0) ? C.neg : C.green, paddingAll: '16px',
      contents: [
        { type: 'text', text: '🔥 Needs Attention', color: C.white, weight: 'bold', size: 'xl' },
        { type: 'text', text: `Mizuhada · ${opts.dateStr}`, color: '#fff1f2', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
  };
}

/** Second bubble — "📈 Ride the Wave": posts that newly crossed spike threshold this window, each linked. Caller skips this bubble entirely when the list is empty. */
export function rideTheWaveBubble(spikes: DigestSpikePost[]): Flex {
  const rows: Flex[] = [];
  spikes.forEach((p, i) => {
    if (i > 0) rows.push({ type: 'separator', margin: 'lg' });
    const box: Flex = {
      type: 'box', layout: 'vertical', spacing: 'xs', margin: i === 0 ? 'none' : 'lg',
      contents: [
        { type: 'text', text: `${p.brand_name} · ${p.platform}`, size: 'xxs', weight: 'bold', color: platformColor(p.platform) },
        { type: 'text', text: truncate(p.caption || '(no caption)'), size: 'sm', color: C.text, wrap: true, margin: 'xs' },
        { type: 'text', text: `👁 ${fmt(p.views)}`, size: 'xs', color: C.navy, weight: 'bold', margin: 'xs' },
      ],
    };
    if (p.post_url && /^https?:\/\//.test(p.post_url)) box.action = { type: 'uri', uri: p.post_url };
    rows.push(box);
  });

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.ques, paddingAll: '14px',
      contents: [
        { type: 'text', text: '📈 Ride the Wave', color: C.white, weight: 'bold', size: 'lg' },
        { type: 'text', text: 'โพสต์ viral ใหม่ — ควรรีบแชร์/ตอบขณะกระแสมา', color: '#fff7ed', size: 'xs', margin: 'sm', wrap: true },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: rows },
  };
}

/**
 * Third bubble — "📊 Performance": cross-brand pulse (with vs-prior-period
 * delta where cheaply available) + ranked top posts across TikTok and X.
 * Consolidates what summaryBubble()/topPostsBubble() used to split across two
 * generic bubbles into one purposeful "how are we doing" section.
 */
export function performanceBubble(opts: DigestBubbleOpts, digests: BrandDigest[], topPosts: TopPost[], hashtags: { tag: string; cnt: number }[], topics: TopicCount[]): Flex {
  const totUgc = digests.reduce((s, d) => s + d.ugcMentions, 0);
  const totPrevUgc = digests.reduce((s, d) => s + d.prevUgcMentions, 0);
  const totTkPosts = digests.reduce((s, d) => s + d.ownPosts + d.ugcMentions, 0);
  const totViews = digests.reduce((s, d) => s + d.ownViews + d.ugcViews + (d.twitter?.views ?? 0), 0);
  const totSpikes = digests.reduce((s, d) => s + d.spikeCount + (d.twitter?.spikeCount ?? 0), 0);
  const totPos = digests.reduce((s, d) => s + d.sentiment.positive + (d.twitter?.sentiment.positive ?? 0), 0);
  const totNeu = digests.reduce((s, d) => s + d.sentiment.neutral + (d.twitter?.sentiment.neutral ?? 0), 0);
  const totNeg = digests.reduce((s, d) => s + d.sentiment.negative + (d.twitter?.sentiment.negative ?? 0), 0);
  const totQ = digests.reduce((s, d) => s + d.sentiment.question + (d.twitter?.sentiment.question ?? 0), 0);
  const totSentiment = totPos + totNeu + totNeg + totQ;
  const pct = (n: number) => totSentiment > 0 ? Math.round((n / totSentiment) * 100) : 0;
  const totTwPosts = digests.reduce((s, d) => s + (d.twitter?.posts ?? 0), 0);
  const hasTwitter = digests.some((d) => d.twitter);

  const body: Flex[] = [
    {
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [
        kpiTile(String(totTkPosts + totTwPosts), 'โพสต์รวม'),
        kpiTile(String(totUgc), 'UGC พูดถึง', deltaBadge(totUgc, totPrevUgc)),
      ],
    },
    {
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
      contents: [kpiTile(fmt(totViews), 'วิวรวม'), kpiTile(String(totSpikes), 'โพสต์ viral')],
    },
  ];

  if (hasTwitter) {
    body.push(
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: '🌐 แยกตามแพลตฟอร์ม', size: 'xxs', color: C.muted, margin: 'lg' },
      {
        type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
        contents: [
          { type: 'text', text: `📱 TikTok: ${totTkPosts}`, size: 'xs', color: platformColor('tiktok'), weight: 'bold' },
          { type: 'text', text: `🐦 X: ${totTwPosts}`, size: 'xs', color: platformColor('twitter'), weight: 'bold' },
        ],
      },
    );
  }

  if (totSentiment > 0) {
    body.push(
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: '📊 ภาพรวมความรู้สึก', size: 'xxs', color: C.muted, margin: 'lg' },
      sentimentBar(totPos, totNeg, totNeu),
      {
        type: 'text', size: 'xs', color: C.text, margin: 'sm', wrap: true,
        text: `บวก ${totPos} (${pct(totPos)}%) · กลาง ${totNeu} (${pct(totNeu)}%) · ลบ ${totNeg} (${pct(totNeg)}%) · คำถาม ${totQ}`,
      },
    );
  }

  if (hashtags.length) {
    body.push(
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: '🏷 แฮชแท็กมาแรง', size: 'xxs', color: C.muted, margin: 'lg' },
      { type: 'text', size: 'xs', color: C.text, wrap: true, margin: 'xs', text: hashtags.map((h) => `#${h.tag} (${h.cnt})`).join('   ') },
    );
  }

  if (topics.length) {
    body.push(
      { type: 'separator', margin: 'lg' },
      { type: 'text', text: '🗣 หัวข้อยอดนิยม', size: 'xxs', color: C.muted, margin: 'lg' },
      { type: 'text', size: 'xs', color: C.text, wrap: true, margin: 'xs', text: topics.map((t) => `${t.topic} (${t.cnt})`).join('   ') },
    );
  }

  if (topPosts.length) {
    body.push({ type: 'separator', margin: 'lg' }, { type: 'text', text: '🏆 โพสต์เด่นที่สุด', size: 'xxs', color: C.muted, margin: 'lg' });
    topPosts.forEach((p, i) => {
      const tag = p.isUgc ? `UGC${p.author ? ` @${p.author}` : ''}` : 'ทางการ';
      const box: Flex = {
        type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm',
        contents: [
          { type: 'text', text: `${i + 1}. ${p.brand_name} · ${p.platform} · ${tag}`, size: 'xxs', weight: 'bold', color: platformColor(p.platform) },
          { type: 'text', text: truncate(p.caption || '(ไม่มีแคปชั่น)'), size: 'sm', color: C.text, wrap: true, margin: 'xs' },
          { type: 'text', text: `👁 ${fmt(p.views)}   ❤️ ${fmt(p.likes)}`, size: 'xs', color: C.navy, weight: 'bold', margin: 'xs' },
        ],
      };
      if (p.post_url && /^https?:\/\//.test(p.post_url)) box.action = { type: 'uri', uri: p.post_url };
      body.push(box);
    });
  }

  return {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: C.navy, paddingAll: '16px',
      contents: [
        { type: 'text', text: '📊 Performance', color: C.white, weight: 'bold', size: 'xl' },
        { type: 'text', text: `Mizuhada · ${opts.dateStr}`, color: '#dbeafe', size: 'sm', margin: 'xs' },
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: body },
  };
}
