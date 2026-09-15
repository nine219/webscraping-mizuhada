'use client';

import type { SortDir } from '@/lib/use-client-sort';

/** Clickable `<th>` for use-client-sort — shows a direction arrow when active. */
export function SortableTh({
  label, sortKey, activeKey, dir, onSort, align, style,
}: {
  label: React.ReactNode;
  sortKey: string;
  activeKey: string | null;
  dir: SortDir;
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  style?: React.CSSProperties;
}) {
  const active = activeKey === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title="Click to sort"
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: align ?? 'left', whiteSpace: 'nowrap', ...style }}
    >
      {label}{' '}
      <span style={{ opacity: active ? 0.9 : 0.3, fontSize: 9 }}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}
