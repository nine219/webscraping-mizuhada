import { sendLineTextThenFlex, sanitizeCarousel } from '../alerts/line';
import {
  fetchDigestBrands, fetchDigestData, fetchTopTopics, fetchUrgentComments, fetchRideTheWave,
  brandBubble, needsAttentionBubble, rideTheWaveBubble, performanceBubble,
} from './digest-common';

// Rolling window: last 7 days up to now, compared vs the 7 days before that.
// Plain timestamptz arithmetic — an absolute instant needs no timezone shift.
// Constant SQL expressions — no user input, safe to interpolate.
const WIN_START = "now() - interval '7 day'";
const PRIOR_START = "now() - interval '14 day'";

export async function sendWeeklyDigest(): Promise<void> {
  console.log('[WeeklyDigest] Building weekly digest...');

  const brands = await fetchDigestBrands();
  const [data, topics, urgent, wave] = await Promise.all([
    fetchDigestData(brands, WIN_START, PRIOR_START),
    fetchTopTopics(WIN_START),
    fetchUrgentComments(WIN_START, 10),
    fetchRideTheWave(WIN_START),
  ]);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmtDate = (d: Date) => d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
  const dateStr = `${fmtDate(weekAgo)} – ${fmtDate(now)}`;
  const bubbleOpts = { dateStr };

  const carousel = {
    type: 'carousel',
    contents: sanitizeCarousel([
      needsAttentionBubble(bubbleOpts, urgent),
      ...(wave.length ? [rideTheWaveBubble(wave)] : []),
      performanceBubble(bubbleOpts, data.brands, data.hashtags, topics),
      ...data.brands.map((d) => brandBubble(d, 'สัปดาห์นี้')),
    ]),
  };

  const totUgc = data.brands.reduce((s, d) => s + d.ugc, 0);
  const totNeg = data.brands.reduce((s, d) => s + d.sentiment.negative, 0);
  const totSpikes = data.brands.reduce((s, d) => s + d.spikeCount, 0);
  const altText = `📅 Mizuhada Weekly Digest ${dateStr} — UGC ${totUgc} · ลบ ${totNeg} · viral ${totSpikes}`;
  const greeting = `🗓️ สรุปรอบสัปดาห์ Mizuhada (${dateStr}) มาแล้ว!`;

  console.log('[WeeklyDigest] Sending LINE Flex message...');
  await sendLineTextThenFlex(greeting, altText, carousel);
  console.log('[WeeklyDigest] Done.');
}
