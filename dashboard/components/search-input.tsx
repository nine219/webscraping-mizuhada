'use client';

// Every list page hand-rolled its own search box — inconsistent width, some
// with a magnifying-glass icon (UGC Performance) and some without, several
// duplicating the same onFocus/onBlur border-color JS instead of using the
// .search-input CSS class that already existed for this (globals.css) but
// nothing actually used. This is that pattern, once — always icon-first,
// always shrinks on narrow viewports instead of forcing horizontal overflow.
export function SearchInput({
  value,
  onChange,
  placeholder,
  className = 'relative flex-1',
  minWidth = 160,
  maxWidth = 320,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  minWidth?: number;
  maxWidth?: number;
}) {
  return (
    // min/max-width as inline style, not a min-w-[..]/max-w-[..] utility class —
    // globals.css's `.flex > * { min-width: 0 }` (added so grids/tables can
    // shrink instead of overflowing) sits later in the stylesheet than
    // Tailwind's generated utilities and wins at equal specificity, which
    // silently clobbered the min-width here and let the box shrink to a
    // sliver. Inline style always wins regardless of source order.
    <div className={className} style={{ minWidth, maxWidth }}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="search-input"
      />
    </div>
  );
}
