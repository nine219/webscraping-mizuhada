// Watchlist star — was copy-pasted with a hardcoded #f59e0b fill/stroke in 5
// places across TikTok feed/search tabs and the post detail page. Uses
// var(--accent-warning) instead (same value, per globals.css) so it tracks
// the theme variable rather than a hardcoded hex.
interface WatchlistIconProps {
  active: boolean;
  size?: number;
  strokeWidth?: number;
  /** Override for contexts where the icon should inherit a button's own
   * text color (e.g. currentColor) instead of the fixed warning color. */
  color?: string;
}

export function WatchlistIcon({ active, size = 12, strokeWidth = 2, color = 'var(--accent-warning)' }: WatchlistIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={active ? color : 'none'}
      stroke={color}
      strokeWidth={strokeWidth}
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
