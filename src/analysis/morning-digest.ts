import { sendLineTextThenFlex, sanitizeCarousel } from '../alerts/line';
import {
  fetchDigestBrands, fetchDigestData, fetchUrgentComments, fetchRideTheWave,
  brandBubble, needsAttentionBubble, rideTheWaveBubble, performanceBubble,
} from './digest-common';

// Calendar window (Bangkok): from start of yesterday (00:00) up to now.
// Constant SQL expressions — no user input, safe to interpolate.
const WIN_START = "(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day') AT TIME ZONE 'Asia/Bangkok'";
const PRIOR_START = "(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - interval '2 day') AT TIME ZONE 'Asia/Bangkok'";

export async function sendMorningDigest(): Promise<void> {
  console.log('[Digest] Building morning digest...');

  const brands = await fetchDigestBrands();
  const [data, urgent, wave] = await Promise.all([
    fetchDigestData(brands, WIN_START, PRIOR_START),
    fetchUrgentComments(WIN_START),
    fetchRideTheWave(WIN_START),
  ]);

  const dateStr = new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric',
  });
  const bubbleOpts = { dateStr };

  // Needs Attention / Ride the Wave only appear when there's something in
  // them — a quiet morning shouldn't open with an "all clear" bubble.
  const carousel = {
    type: 'carousel',
    contents: sanitizeCarousel([
      ...(urgent.length ? [needsAttentionBubble(bubbleOpts, urgent)] : []),
      ...(wave.length ? [rideTheWaveBubble(wave)] : []),
      performanceBubble(bubbleOpts, data.brands, data.hashtags),
      ...data.brands.map((d) => brandBubble(d, 'เมื่อวาน')),
    ]),
  };

  const totUgc = data.brands.reduce((s, d) => s + d.ugc, 0);
  const totNeg = data.brands.reduce((s, d) => s + d.sentiment.negative, 0);
  const totSpikes = data.brands.reduce((s, d) => s + d.spikeCount, 0);
  const altText = `🌅 Mizuhada Digest ${dateStr} — UGC ${totUgc} · ลบ ${totNeg} · viral ${totSpikes}`;
  const greeting = `☀️ อรุณสวัสดิ์! สรุปโซเชียล Mizuhada ประจำวันที่ ${dateStr}`;

  console.log('[Digest] Sending LINE Flex message...');
  await sendLineTextThenFlex(greeting, altText, carousel);
  console.log('[Digest] Done.');
}
