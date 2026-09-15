import { socialQuery } from '../db/social-client';
import { sendLineTextThenFlex, sanitizeCarousel } from '../alerts/line';
import {
  fetchBrandDigest, fetchTopHashtags, fetchTopPosts, fetchUrgentComments, fetchRecentSpikePosts,
  brandBubble, needsAttentionBubble, rideTheWaveBubble, performanceBubble, negSpikeBrands,
} from './digest-common';

// Calendar window (Bangkok): from start of yesterday (00:00) up to now.
// Constant SQL expressions — no user input, safe to interpolate.
const WIN_START = "(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day') AT TIME ZONE 'Asia/Bangkok'";
const PRIOR_START = "(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - interval '2 day') AT TIME ZONE 'Asia/Bangkok'";

export async function sendMorningDigest(): Promise<void> {
  console.log('[Digest] Building morning digest...');

  const brandsRes = await socialQuery<{ id: string; name: string; slug: string }>(
    `SELECT id::text, name, slug FROM brands WHERE type = 'own' ORDER BY name`,
    [],
  );

  const digests = await Promise.all(
    brandsRes.map((b) => fetchBrandDigest(parseInt(b.id, 10), b.name, WIN_START, PRIOR_START, b.slug)),
  );
  const [hashtags, topPosts, urgent, spikes] = await Promise.all([
    fetchTopHashtags(WIN_START),
    fetchTopPosts(WIN_START),
    fetchUrgentComments(WIN_START),
    fetchRecentSpikePosts(WIN_START),
  ]);

  const dateStr = new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
  });
  const bubbleOpts = { dateStr };

  // Needs Attention only fires when there's something to report — a quiet
  // morning shouldn't open with a bubble whose only content is "all clear".
  const hasAttention = urgent.length > 0 || negSpikeBrands(digests).length > 0;

  const carousel = {
    type: 'carousel',
    contents: sanitizeCarousel([
      ...(hasAttention ? [needsAttentionBubble(bubbleOpts, urgent, digests)] : []),
      ...(spikes.length ? [rideTheWaveBubble(spikes)] : []),
      performanceBubble(bubbleOpts, digests, topPosts, hashtags, []),
      ...digests.map((d) => brandBubble(d, 'เมื่อวาน')),
    ]),
  };

  const totUgc = digests.reduce((s, d) => s + d.ugcMentions, 0);
  const totNeg = digests.reduce((s, d) => s + d.sentiment.negative, 0);
  const totSpikes = digests.reduce((s, d) => s + d.spikeCount, 0);
  const altText = `🌅 Mizuhada Digest ${dateStr} — UGC ${totUgc} · ลบ ${totNeg} · viral ${totSpikes}`;
  const greeting = `☀️ อรุณสวัสดิ์! สรุปโซเชียล Mizuhada ประจำวันที่ ${dateStr}`;

  console.log('[Digest] Sending LINE Flex message...');
  await sendLineTextThenFlex(greeting, altText, carousel);
  console.log('[Digest] Done.');
}
