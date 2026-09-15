'use client';

import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

/**
 * Client-side re-sort of whatever rows are passed in (does not touch any
 * server-side `sort=` query param a page might already send — this is a
 * secondary, always-available re-order). Most callers pass the FULL filtered
 * dataset (not just one page) so a column-header click reorders every
 * matching row; pagination is then a separate slice of the sorted output.
 *
 * `accessors` maps a column key (whatever you pass to `requestSort`/render in
 * the `<th>`) to a function pulling a comparable value out of a row — needed
 * because row shapes vary (numbers, numeric strings, nullable fields).
 */
export function useClientSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => string | number | null>,
  initialKey: string | null = null,
  initialDir: SortDir = 'desc',
) {
  const [sortKey, setSortKey] = useState<string | null>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  function requestSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = useMemo(() => {
    if (!sortKey || !accessors[sortKey]) return rows;
    const getter = accessors[sortKey];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = getter(a);
      const bv = getter(b);
      let cmp: number;
      if (av == null && bv == null) cmp = 0;
      else if (av == null) cmp = -1;
      else if (bv == null) cmp = 1;
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, requestSort };
}
