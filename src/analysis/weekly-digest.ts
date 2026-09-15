import { socialQuery } from '../db/social-client';
import { sendLineTextThenFlex, sanitizeCarousel } from '../alerts/line';
import {
  fetchBrandDigest, fetchTopHashtags, fetchTopPosts, fetchTopTopics, fetchUrgentComments, fetchRecentSpikePosts,
  brandBubble, needsAttentionBubble, rideTheWaveBubble, performanceBubble,
} from './digest-common';

// Rolling window (Bangkok): last 7 days up to now, compared vs the 7 days before that.
// Constant SQL expressions — no user input, safe to interpolate.
const WIN_START = "now() AT TIME ZONE 'Asia/Bangkok' - interval '7 day'";
const PRIOR_START = "now() AT TIME ZONE 'Asia/Bangkok' - interval '14 day'";

export async function sendWeeklyDigest(): Promise<void> {
  console.log('[WeeklyDigest] Building weekly digest...');

  const brandsRes = await socialQuery<{ id: string; name: string; slug: string }>(
    `SELECT id::text, name, slug FROM brands WHERE type = 'own' ORDER BY name`,
    [],
  );

  const digests = await Promise.all(
    brandsRes.map((b) => fetchBrandDigest(parseInt(b.id, 10), b.name, WIN_START, PRIOR_START, b.slug)),
  );
  const [hashtags, topics, topPosts, urgent, spikes] = await Promise.all([
    fetchTopHashtags(WIN_START),
    fetchTopTopics(WIN_START),
    fetchTopPosts(WIN_START),
    fetchUrgentComments(WIN_START, 10),
    fetchRecentSpikePosts(WIN_START, 10),
  ]);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmtDate = (d: Date) => d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
  const dateStr = `${fmtDate(weekAgo)} – ${fmtDate(now)}`;
  const bubbleOpts = { dateStr };

  const carousel = {
    type: 'carousel',
    contents: sanitizeCarousel([
      needsAttentionBubble(bubbleOpts, urgent, digests),
      ...(spikes.length ? [rideTheWaveBubble(spikes)] : []),
      performanceBubble(bubbleOpts, digests, topPosts, hashtags, topics),
      ...digests.map((d) => brandBubble(d, 'สัปดาห์นี้')),
    ]),
  };

  const totUgc = digests.reduce((s, d) => s + d.ugcMentions, 0);
  const totNeg = digests.reduce((s, d) => s + d.sentiment.negative, 0);
  const totSpikes = digests.reduce((s, d) => s + d.spikeCount, 0);
  const altText = `📅 Mizuhada Weekly Digest ${dateStr} — UGC ${totUgc} · ลบ ${totNeg} · viral ${totSpikes}`;
  const greeting = `🗓️ สรุปรอบสัปดาห์ Mizuhada (${dateStr}) มาแล้ว!`;

  console.log('[WeeklyDigest] Sending LINE Flex message...');
  await sendLineTextThenFlex(greeting, altText, carousel);
  console.log('[WeeklyDigest] Done.');
}
