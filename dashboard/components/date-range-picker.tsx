'use client';

import { useEffect, useRef, useState } from 'react';
import type { DateRange } from '@/lib/api';

// Replaces the hardcoded DAYS_OPTIONS pill row used across every platform page
// (tiktok/xhs/instagram/x/social/overview/ugc) with quick presets + a real
// calendar range picker for an arbitrary from/to window. Mirrors FilterPills'
// controlled value/onChange shape so call sites swap in with minimal churn.
export type { DateRange };

interface Preset { key: string; label: string; days: number }

const DEFAULT_PRESETS: Preset[] = [
  { key: 'd1',  label: 'Today', days: 1 },
  { key: 'd7',  label: '7D',    days: 7 },
  { key: 'd14', label: '14D',   days: 14 },
  { key: 'd30', label: '30D',   days: 30 },
  { key: 'all', label: 'All time', days: 0 },
];

interface DateRangePickerProps {
  value: DateRange;
  onChange: (v: DateRange) => void;
  presets?: Preset[];
  className?: string;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtShort(iso: string): string {
  return parseIso(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function activePresetKey(value: DateRange, presets: Preset[]): string | null {
  if (value.from && value.to) return null;
  const found = presets.find((p) => p.days === value.days);
  return found?.key ?? null;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function DateRangePicker({ value, onChange, presets = DEFAULT_PRESETS, className = 'flex items-center gap-1' }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const base = value.to ? parseIso(value.to) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [draftStart, setDraftStart] = useState<string | null>(value.from ?? null);
  const [draftEnd, setDraftEnd] = useState<string | null>(value.to ?? null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeKey = activePresetKey(value, presets);
  const customLabel = value.from && value.to
    ? (value.from === value.to ? fmtShort(value.from) : `${fmtShort(value.from)} – ${fmtShort(value.to)}`)
    : 'Custom';

  function openCalendar() {
    setDraftStart(value.from ?? null);
    setDraftEnd(value.to ?? null);
    const base = value.to ? parseIso(value.to) : new Date();
    setViewMonth(new Date(base.getFullYear(), base.getMonth(), 1));
    setOpen(true);
  }

  function pickDay(iso: string) {
    if (!draftStart || (draftStart && draftEnd)) {
      // Starting a fresh selection
      setDraftStart(iso);
      setDraftEnd(null);
    } else if (iso < draftStart) {
      setDraftStart(iso);
      setDraftEnd(draftStart);
    } else {
      setDraftEnd(iso);
    }
  }

  function apply() {
    if (draftStart && draftEnd) {
      onChange({ from: draftStart, to: draftEnd });
      setOpen(false);
    } else if (draftStart) {
      onChange({ from: draftStart, to: draftStart });
      setOpen(false);
    }
  }

  const monthLabel = viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const firstDow = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const todayIso = toIso(new Date());

  const cells: (string | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => toIso(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), i + 1))),
  ];

  return (
    <div className={className} ref={rootRef} style={{ position: 'relative' }}>
      {presets.map((p) => (
        <button
          key={p.key}
          onClick={() => onChange({ days: p.days })}
          className={`filter-pill${activeKey === p.key ? ' active' : ''}`}
        >
          {p.label}
        </button>
      ))}
      <button
        onClick={() => (open ? setOpen(false) : openCalendar())}
        className={`filter-pill${activeKey === null ? ' active' : ''}`}
      >
        📅 {activeKey === null ? customLabel : 'Custom'}
      </button>

      {open && (
        <div
          className="p-3"
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)',
            zIndex: 'var(--z-popover)', width: 280,
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
              className="w-6 h-6 flex items-center justify-center rounded cursor-pointer text-sm"
              style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className="text-xs font-semibold text-primary">{monthLabel}</span>
            <button
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
              className="w-6 h-6 flex items-center justify-center rounded cursor-pointer text-sm"
              style={{ border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-y-1" style={{ textAlign: 'center' }}>
            {WEEKDAYS.map((w) => (
              <span key={w} className="text-[10px] text-muted" style={{ fontWeight: 600 }}>{w}</span>
            ))}
            {cells.map((iso, i) => {
              if (!iso) return <span key={i} />;
              const inRange = draftStart && draftEnd && iso >= draftStart && iso <= draftEnd;
              const isEdge = iso === draftStart || iso === draftEnd;
              const isToday = iso === todayIso;
              return (
                <button
                  key={iso}
                  onClick={() => pickDay(iso)}
                  className="text-[11px] cursor-pointer"
                  style={{
                    width: 28, height: 28, borderRadius: isEdge ? '50%' : 4,
                    border: isToday && !isEdge ? '1px solid var(--accent-primary)' : 'none',
                    background: isEdge ? 'var(--accent-primary)' : inRange ? 'var(--accent-primary-subtle)' : 'transparent',
                    color: isEdge ? '#fff' : 'var(--text-primary)',
                    fontWeight: isEdge ? 600 : 400,
                  }}
                >
                  {parseIso(iso).getDate()}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between mt-3 pt-2" style={{ borderTop: '1px solid var(--border-light)' }}>
            <span className="text-[11px] text-muted">
              {draftStart ? fmtShort(draftStart) : '—'} {draftEnd ? `– ${fmtShort(draftEnd)}` : ''}
            </span>
            <div className="flex gap-2">
              <button onClick={() => setOpen(false)} className="btn btn-xs">
                Cancel
              </button>
              <button onClick={apply} disabled={!draftStart} className="btn btn-primary btn-xs">
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
