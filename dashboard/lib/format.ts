// Engagement-rate text + color-coded threshold (>3% success, >=1% warning,
// else muted) — was copy-pasted near-identically across tiktok feed/search
// tabs, instagram feed tab, and the creator detail page.
export function formatEngagement(rate: string | number | null): { text: string; color: string } {
  if (rate == null || rate === '') return { text: '—', color: 'var(--text-muted)' };
  const val = typeof rate === 'number' ? rate : parseFloat(rate);
  const text = `${val.toFixed(2)}%`;
  if (val > 3) return { text, color: 'var(--accent-success)' };
  if (val >= 1) return { text, color: 'var(--accent-warning)' };
  return { text, color: 'var(--text-muted)' };
}

// "Xh ago" / "Xd ago" style relative-time formatting for "last updated" labels.
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
