'use client';

import type { CSSProperties } from 'react';

// Every brand/days/sort/source filter row across the dashboard (tiktok, xhs,
// instagram, x, ugc, overview, social — 11+ pages) re-implements the same
// {options}.map(pill with active-class) JSX. This is that pattern, once.
export interface FilterPillOption<T extends string | number> {
  value: T;
  label: string;
}

interface FilterPillsProps<T extends string | number> {
  options: FilterPillOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  /** Optional per-option style override when active (e.g. brand-colored pills). */
  styleFor?: (v: T) => CSSProperties;
}

export function FilterPills<T extends string | number>({
  options,
  value,
  onChange,
  className = 'flex items-center gap-1',
  styleFor,
}: FilterPillsProps<T>) {
  return (
    <div className={className}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`filter-pill${value === o.value ? ' active' : ''}`}
          style={value === o.value ? styleFor?.(o.value) : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
