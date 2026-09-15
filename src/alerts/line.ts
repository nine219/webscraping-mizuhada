import { getAlerts } from '../config/settings-loader';

const PLACEHOLDER = 'PLACEHOLDER';

// Settings-backed (Settings → Alerts → LINE token/group ID), not raw env vars —
// getAlerts() falls back to LINE_NOTIFY_TOKEN/LINE_GROUP_ID env vars only until
// someone saves real values via the Settings UI (see settings-loader.ts DEFAULT_SETTINGS).
async function resolveLineConfig(): Promise<{ token: string; to: string } | null> {
  const { lineToken, lineGroupId } = await getAlerts();
  if (
    lineToken.length > 0 && !lineToken.includes(PLACEHOLDER) &&
    lineGroupId.length > 0 && !lineGroupId.includes(PLACEHOLDER)
  ) {
    return { token: lineToken, to: lineGroupId };
  }
  return null;
}

/** Returns true if the message was actually pushed to LINE, false if stubbed (not configured) or the API call failed. */
async function pushMessages(messages: unknown[], stubPreview: string): Promise<boolean> {
  const config = await resolveLineConfig();
  if (!config) {
    console.log(`[LINE] (stub — set LINE token + group ID in Settings → Alerts)\n${stubPreview}`);
    if (process.env.LINE_FLEX_DEBUG) console.log('PAYLOAD_JSON=' + JSON.stringify(messages));
    return false;
  }

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ to: config.to, messages }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[LINE] Push failed: HTTP ${res.status} — ${body}`);
    return false;
  }
  console.log('[LINE] Message sent');
  return true;
}

export async function sendLineMessage(text: string): Promise<boolean> {
  return pushMessages([{ type: 'text', text }], text);
}

/**
 * Push a Flex message. `contents` is a LINE Flex container (bubble or carousel).
 * `altText` shows in the notification preview (max 400 chars). Returns true if
 * actually delivered (false if LINE isn't configured or the push call failed).
 */
export async function sendLineFlex(altText: string, contents: unknown): Promise<boolean> {
  const alt = altText.length > 400 ? altText.slice(0, 397) + '…' : altText;
  return pushMessages([{ type: 'flex', altText: alt, contents }], alt);
}

/**
 * Plain text message immediately followed by a Flex message, sent as ONE push
 * call so they always land as two consecutive bubbles in order — never
 * interleaved with some other alert's push landing in between them. Used by
 * the digests to say "Good morning" / "Weekly recap" in plain text ahead of
 * the carousel, instead of spending a whole Flex bubble just to say that.
 */
export async function sendLineTextThenFlex(text: string, altText: string, contents: unknown): Promise<boolean> {
  const alt = altText.length > 400 ? altText.slice(0, 397) + '…' : altText;
  return pushMessages([{ type: 'text', text }, { type: 'flex', altText: alt, contents }], `${text}\n${alt}`);
}

// ── Shared Flex style kit ────────────────────────────────────────────────
// One visual language for every LINE Flex alert (morning digest, weekly
// digest, spike alerts, ...) so they read as the same product.

export type Flex = Record<string, unknown>;

export const FLEX_COLORS = {
  navy: '#0f172a',
  white: '#ffffff',
  muted: '#94a3b8',
  sub: '#cbd5e1',
  text: '#334155',
  blue: '#3b82f6',
  green: '#10b981',
  pos: '#10b981',
  neu: '#cbd5e1',
  neg: '#ef4444',
  ques: '#f59e0b',
  cardBg: '#f8fafc',
  invalid: '#78716c', // stone grey — deliberately outside the semantic palette above, so a swapped-in placeholder bubble reads as "something broke" not as any real alert state
};

// Per-platform accent colors (brand-recognizable) — used on alert/digest bubble
// headers so a glance at the LINE chat list tells TikTok vs X apart without
// reading text. Not the same axis as FLEX_COLORS (those are semantic: neg/pos/etc).
// Single value = solid header color. Multiple values (TikTok) = its real brand
// palette (cyan/magenta/black), rendered as a segmented stripe by
// platformStripe()/platformAccentBar() below — LINE Flex boxes only take one
// flat backgroundColor each, so a multi-color "block" is faked the same way
// sentimentBar() fakes a proportional bar: several solid boxes side by side.
export const PLATFORM_COLORS: Record<string, string[]> = {
  tiktok: ['#FE2C55', '#25F4EE', '#000000'], // Razzmatazz magenta first (readable on white for single-color text use), Splash cyan, black
  twitter: ['#1D9BF0', '#FFFFFF'], // X blue first (readable on white), white — stripe reads blue+white on a black header
  xiaohongshu: ['#FF2442'],
  instagram: ['#E1306C'],
};

/** True when a platform has a multi-tone accent (currently TikTok, X) vs a flat single color (XHS, IG). */
export function isMultiColorPlatform(platform: string): boolean {
  return (PLATFORM_COLORS[platform]?.length ?? 1) > 1;
}

/** Single representative color — for places that can only take one flat color (text, single-color header). */
export function platformColor(platform: string, fallback: string = FLEX_COLORS.navy): string {
  return PLATFORM_COLORS[platform]?.[0] ?? fallback;
}

/** Thin horizontal multi-color stripe — equal-width segments, one per platform accent color. */
export function platformStripe(platform: string, height = '6px'): Flex {
  const colors = PLATFORM_COLORS[platform] ?? [FLEX_COLORS.navy];
  return {
    type: 'box', layout: 'horizontal', height,
    contents: colors.map((color): Flex => ({ type: 'box', layout: 'vertical', flex: 1, backgroundColor: color, contents: [{ type: 'filler' }] })),
  };
}

/** Thin vertical multi-color accent bar (left-edge strip) — same segments as platformStripe(), stacked instead of side by side. */
export function platformAccentBar(platform: string, width = '4px'): Flex {
  const colors = PLATFORM_COLORS[platform] ?? [FLEX_COLORS.navy];
  return {
    type: 'box', layout: 'vertical', width, cornerRadius: '2px',
    contents: colors.map((color): Flex => ({ type: 'box', layout: 'vertical', flex: 1, backgroundColor: color, contents: [{ type: 'filler' }] })),
  };
}

export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Plain s.slice(0, len) can land mid-surrogate-pair (e.g. an emoji at the cut
// point), leaving a lone high surrogate. JSON.stringify then emits an escape
// LINE's Flex parser rejects outright ("Invalid characters are included in
// flex message"), failing the WHOLE push — not just that one field. Trim it
// off before appending the ellipsis.
export function truncateText(s: string, len = 70): string {
  if (s.length <= len) return s;
  let cut = s.slice(0, len);
  if (cut.charCodeAt(cut.length - 1) >= 0xD800 && cut.charCodeAt(cut.length - 1) <= 0xDBFF) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
}

// ── Carousel safety net ──────────────────────────────────────────────────
// truncateText() above closes the one known cause (mid-emoji slicing), but
// scraped caption/comment text is otherwise uncontrolled input — a lone
// surrogate or raw control char could still reach a bubble some other way
// (a different truncation site, a future field, upstream data already
// corrupted). LINE rejects the ENTIRE push — carousel and all — if even one
// bubble has invalid content, so one bad caption silently kills the whole
// weekly/morning digest. sanitizeCarousel() below swaps just that bubble for
// a visible grey placeholder instead, so the rest of the digest still lands.

// Deliberately walks the raw tree and checks each string's own char codes —
// NOT JSON.stringify(node) first. JSON.stringify re-encodes a lone surrogate
// as a 6-character backslash-u escape sequence, which erases the actual
// surrogate code unit from the resulting string, so a regex scan over the
// stringified output can never find it. Numeric charCodeAt checks on the
// pre-serialization string are the only reliable way to catch it.
function hasBadChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { i++; continue; } // valid pair, skip its low half
      return true; // lone high surrogate
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true; // lone low surrogate (unpaired high was not consumed above)
    if (code === 0x7F) return true; // DEL
    if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) return true; // C0 control, excluding tab/newline/CR
  }
  return false;
}

/** True if this Flex node (and everything nested in it) is safe to send to LINE. */
export function isValidFlexContent(node: unknown): boolean {
  if (typeof node === 'string') return !hasBadChars(node);
  if (Array.isArray(node)) return node.every(isValidFlexContent);
  if (node && typeof node === 'object') return Object.values(node).every(isValidFlexContent);
  return true;
}

/** Best-effort label pulled from a bubble's own header/body text, for the placeholder's message and the console.error. */
function guessBubbleLabel(bubble: Flex, fallback: string): string {
  const header = bubble.header as Flex | undefined;
  const firstText = (header?.contents as Flex[] | undefined)?.find((c) => c.type === 'text')?.text;
  return typeof firstText === 'string' ? firstText : fallback;
}

function invalidBubblePlaceholder(label: string): Flex {
  return {
    type: 'bubble', size: 'kilo',
    body: {
      type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: FLEX_COLORS.invalid,
      contents: [
        { type: 'text', text: '⚠️ Content skipped', color: FLEX_COLORS.white, weight: 'bold', size: 'sm' },
        { type: 'text', text: `"${label}" omitted — invalid characters`, color: '#e7e5e4', size: 'xs', wrap: true, margin: 'xs' },
      ],
    },
  };
}

/** Filters a carousel's bubble list, swapping any bubble LINE would reject for a placeholder instead of letting it take the whole message down. */
export function sanitizeCarousel(bubbles: Flex[]): Flex[] {
  return bubbles.map((b, i) => {
    if (isValidFlexContent(b)) return b;
    const label = guessBubbleLabel(b, `bubble ${i + 1}`);
    console.error(`[LINE] Dropped invalid bubble from carousel (invalid characters): ${label}`);
    return invalidBubblePlaceholder(label);
  });
}

/** Delta badge text + color for a value vs its prior-period value. */
export function deltaBadge(cur: number, prev: number): { text: string; color: string } | null {
  if (prev === 0) return cur > 0 ? { text: 'ใหม่', color: FLEX_COLORS.pos } : null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return { text: '0%', color: FLEX_COLORS.muted };
  return pct > 0
    ? { text: `▲${pct}%`, color: FLEX_COLORS.pos }
    : { text: `▼${Math.abs(pct)}%`, color: FLEX_COLORS.neg };
}

export function kpiTile(value: string, label: string, badge?: { text: string; color: string } | null): Flex {
  const valueRow: Flex[] = [{ type: 'text', text: value, weight: 'bold', size: 'lg', color: FLEX_COLORS.navy }];
  if (badge) valueRow.push({ type: 'text', text: badge.text, size: 'xs', color: badge.color, gravity: 'bottom', margin: 'xs', flex: 0 });
  return {
    type: 'box', layout: 'vertical', flex: 1,
    contents: [
      { type: 'box', layout: 'baseline', contents: valueRow },
      { type: 'text', text: label, size: 'xxs', color: FLEX_COLORS.muted, margin: 'xs' },
    ],
  };
}

export function sentimentBar(p: number, n: number, u: number): Flex {
  const total = p + n + u;
  const seg = (flex: number, color: string): Flex => ({ type: 'box', layout: 'vertical', flex: Math.max(0, flex), contents: [{ type: 'filler' }], backgroundColor: color });
  const contents: Flex[] = total === 0
    ? [seg(1, FLEX_COLORS.neu)]
    : [seg(p, FLEX_COLORS.pos), seg(u, FLEX_COLORS.neu), seg(n, FLEX_COLORS.neg)].filter((s) => (s.flex as number) > 0);
  return { type: 'box', layout: 'horizontal', height: '8px', cornerRadius: '4px', backgroundColor: '#e2e8f0', contents };
}
