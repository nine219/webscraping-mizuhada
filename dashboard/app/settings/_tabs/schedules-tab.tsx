'use client';

import { useState } from 'react';
import { Section, Toggle } from './shared';
import type { ScheduleEntry, ScheduleSettings } from './types';

// ── Schedules tab ─────────────────────────────────────────────────────────────

// ── Cron parse + format helpers ───────────────────────────────────────────────

type CronMode = 'interval' | 'daily' | 'weekly' | 'custom';
interface CronModel {
  mode: CronMode;
  startMinute: number;
  startHour: number;     // for interval: starting hour; for daily/weekly: time
  everyHours: number;    // interval only
  hours: number[];       // interval expanded — for display
  weekday: number;       // 0-6 (Sun..Sat) for weekly
  raw: string;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string { return n.toString().padStart(2, '0'); }

function parseCron(expr: string): CronModel {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { mode: 'custom', startMinute: 0, startHour: 0, everyHours: 0, hours: [], weekday: 0, raw: expr };
  }
  const [minPart, hourPart, dom, mon, dow] = parts;
  const minute = /^\d+$/.test(minPart) ? parseInt(minPart, 10) : NaN;

  // Weekly: weekday specified, hour single
  if (dom === '*' && mon === '*' && dow !== '*' && /^\d+$/.test(dow) && /^\d+$/.test(hourPart) && !Number.isNaN(minute)) {
    return { mode: 'weekly', startMinute: minute, startHour: parseInt(hourPart, 10), everyHours: 0, hours: [], weekday: parseInt(dow, 10), raw: expr };
  }
  // Daily: single hour, every day
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(hourPart) && !Number.isNaN(minute)) {
    return { mode: 'daily', startMinute: minute, startHour: parseInt(hourPart, 10), everyHours: 0, hours: [], weekday: 0, raw: expr };
  }
  // Interval — */N
  if (dom === '*' && mon === '*' && dow === '*' && /^\*\/\d+$/.test(hourPart) && !Number.isNaN(minute)) {
    const n = parseInt(hourPart.slice(2), 10);
    const hours: number[] = [];
    for (let h = 0; h < 24; h += n) hours.push(h);
    return { mode: 'interval', startMinute: minute, startHour: 0, everyHours: n, hours, weekday: 0, raw: expr };
  }
  // Comma-list hours — show as interval if evenly spaced + same start
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+(?:,\d+)*$/.test(hourPart) && !Number.isNaN(minute)) {
    const hours = hourPart.split(',').map((s) => parseInt(s, 10)).sort((a, b) => a - b);
    const diffs = hours.slice(1).map((h, i) => h - hours[i]);
    const evenly = diffs.length > 0 && diffs.every((d) => d === diffs[0]);
    if (evenly) {
      return { mode: 'interval', startMinute: minute, startHour: hours[0], everyHours: diffs[0], hours, weekday: 0, raw: expr };
    }
    return { mode: 'custom', startMinute: minute, startHour: hours[0] ?? 0, everyHours: 0, hours, weekday: 0, raw: expr };
  }
  return { mode: 'custom', startMinute: Number.isNaN(minute) ? 0 : minute, startHour: 0, everyHours: 0, hours: [], weekday: 0, raw: expr };
}

function buildCron(m: { mode: CronMode; startMinute: number; startHour: number; everyHours: number; weekday: number; raw: string }): string {
  if (m.mode === 'daily')   return `${m.startMinute} ${m.startHour} * * *`;
  if (m.mode === 'weekly')  return `${m.startMinute} ${m.startHour} * * ${m.weekday}`;
  if (m.mode === 'interval') {
    const n = Math.max(1, Math.min(23, m.everyHours));
    if (m.startHour === 0 && 24 % n === 0) return `${m.startMinute} */${n} * * *`;
    const hours: number[] = [];
    for (let h = m.startHour; h < 24; h += n) hours.push(h);
    return `${m.startMinute} ${hours.join(',')} * * *`;
  }
  return m.raw;
}

// Plain-English frequency phrases — selecting one switches mode AND fills sensible defaults.
const FREQ_OPTIONS: Array<{ key: string; label: string; mode: CronMode; everyHours?: number }> = [
  { key: 'every-1h',  label: 'every hour',     mode: 'interval', everyHours: 1 },
  { key: 'every-2h',  label: 'every 2 hours',  mode: 'interval', everyHours: 2 },
  { key: 'every-3h',  label: 'every 3 hours',  mode: 'interval', everyHours: 3 },
  { key: 'every-4h',  label: 'every 4 hours',  mode: 'interval', everyHours: 4 },
  { key: 'every-6h',  label: 'every 6 hours',  mode: 'interval', everyHours: 6 },
  { key: 'every-8h',  label: 'every 8 hours',  mode: 'interval', everyHours: 8 },
  { key: 'every-12h', label: 'every 12 hours', mode: 'interval', everyHours: 12 },
  { key: 'daily',     label: 'once a day',     mode: 'daily' },
  { key: 'weekly',    label: 'once a week',    mode: 'weekly' },
  { key: 'custom',    label: 'custom (raw cron)', mode: 'custom' },
];

function currentFreqKey(m: CronModel): string {
  if (m.mode === 'interval') return `every-${m.everyHours}h`;
  if (m.mode === 'daily')    return 'daily';
  if (m.mode === 'weekly')   return 'weekly';
  return 'custom';
}

function nextRuns(m: CronModel, max = 4): string[] {
  if (m.mode === 'interval') {
    return m.hours.slice(0, max).map((h) => `${pad2(h)}:${pad2(m.startMinute)}`);
  }
  if (m.mode === 'daily')  return [`every day at ${pad2(m.startHour)}:${pad2(m.startMinute)}`];
  if (m.mode === 'weekly') return [`every ${WEEKDAY_NAMES[m.weekday]} at ${pad2(m.startHour)}:${pad2(m.startMinute)}`];
  return [];
}

// Custom-styled select w/ shadow + chevron. Native <select> kept for keyboard + a11y.
const PRETTY_SELECT_CSS: React.CSSProperties = {
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  background: `var(--bg-surface) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%230284c7' stroke-width='2.5'><polyline points='6 9 12 15 18 9'/></svg>") no-repeat right 8px center`,
  paddingRight: 26,
  paddingLeft: 12,
  paddingTop: 6,
  paddingBottom: 6,
  border: '1px solid #bfdbfe',
  borderRadius: 8,
  color: '#0284c7',
  fontWeight: 500,
  fontSize: 13,
  cursor: 'pointer',
  boxShadow: '0 1px 2px rgba(2, 132, 199, 0.08), 0 1px 1px rgba(0,0,0,0.04)',
  outline: 'none',
  transition: 'box-shadow 120ms, border-color 120ms',
};

const PRETTY_TIME_CSS: React.CSSProperties = {
  border: '1px solid #bfdbfe',
  borderRadius: 8,
  padding: '6px 10px',
  background: 'var(--bg-surface)',
  color: '#0284c7',
  fontWeight: 500,
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  width: 92,
  boxShadow: '0 1px 2px rgba(2, 132, 199, 0.08), 0 1px 1px rgba(0,0,0,0.04)',
  outline: 'none',
};

function CronEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseCron(value);
  // Mode is normally INFERRED from the cron string's shape (there's no
  // separate "mode" field in ScheduleEntry) — which means picking "custom"
  // from the dropdown while the string still matches a friendly pattern did
  // nothing observable: buildCron('custom') just returns the raw string
  // unchanged, so re-parsing it snapped straight back to the original mode.
  // This override remembers an explicit "custom" pick until the user
  // chooses a different frequency, so it actually sticks.
  const [forceCustom, setForceCustom] = useState(false);
  const model: CronModel = forceCustom ? { ...parsed, mode: 'custom' } : parsed;

  function commit(next: Partial<CronModel> & { mode: CronMode }) {
    const merged: CronModel = { ...model, ...next };
    const cron = buildCron({ mode: merged.mode, startMinute: merged.startMinute, startHour: merged.startHour, everyHours: merged.everyHours, weekday: merged.weekday, raw: merged.raw });
    onChange(cron);
  }

  function handleFreqChange(key: string) {
    const opt = FREQ_OPTIONS.find((o) => o.key === key);
    if (!opt) return;
    setForceCustom(opt.mode === 'custom');
    if (opt.mode === 'interval') {
      commit({ mode: 'interval', everyHours: opt.everyHours ?? 1, startHour: model.startHour || 0, startMinute: model.startMinute || 0 });
    } else if (opt.mode === 'daily') {
      commit({ mode: 'daily', startHour: model.startHour || 0, startMinute: model.startMinute || 0 });
    } else if (opt.mode === 'weekly') {
      commit({ mode: 'weekly', weekday: model.weekday || 1, startHour: model.startHour || 8, startMinute: model.startMinute || 0 });
    }
    // 'custom' needs no commit — the raw cron string is left exactly as-is;
    // only the display mode (via forceCustom above) changes, revealing the
    // editable raw-cron textbox for the user to type into.
  }

  function handleTimeChange(s: string, mode: CronMode) {
    // s is "HH:MM"; ignore invalid intermediate states
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
    if (!m) return;
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const mn = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    commit({ mode, startHour: h, startMinute: mn });
  }

  const timeValue = `${pad2(model.startHour)}:${pad2(model.startMinute)}`;
  const sentence = (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm text-primary">
      <span>Run</span>
      <select
        value={currentFreqKey(model)}
        onChange={(e) => handleFreqChange(e.target.value)}
        style={PRETTY_SELECT_CSS}
        onFocus={(e) => { e.currentTarget.style.boxShadow = '0 0 0 3px rgba(2,132,199,0.18)'; }}
        onBlur={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(2,132,199,0.08), 0 1px 1px rgba(0,0,0,0.04)'; }}
      >
        {FREQ_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {(model.mode === 'interval' || model.mode === 'daily') && (
        <>
          <span className="text-muted">{model.mode === 'interval' ? 'starting at' : 'at'}</span>
          <input
            type="time"
            value={timeValue}
            onChange={(e) => handleTimeChange(e.target.value, model.mode)}
            style={PRETTY_TIME_CSS}
          />
        </>
      )}
      {model.mode === 'weekly' && (
        <>
          <span className="text-muted">on</span>
          <select
            value={model.weekday}
            onChange={(e) => commit({ mode: 'weekly', weekday: parseInt(e.target.value, 10) })}
            style={PRETTY_SELECT_CSS}
          >
            {WEEKDAY_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
          </select>
          <span className="text-muted">at</span>
          <input
            type="time"
            value={timeValue}
            onChange={(e) => handleTimeChange(e.target.value, 'weekly')}
            style={PRETTY_TIME_CSS}
          />
        </>
      )}
      {model.mode === 'custom' && (
        <input
          value={model.raw}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0 */2 * * *"
          style={{ ...PRETTY_TIME_CSS, width: 200, fontFamily: 'ui-monospace, monospace' }}
        />
      )}
    </span>
  );

  const runs = nextRuns(model);

  return (
    <div className="flex flex-col gap-1.5">
      {sentence}
      {runs.length > 0 && (
        <div className="text-xs text-muted">
          → {model.mode === 'interval'
              ? <>fires at <span style={{ fontFamily: 'ui-monospace, monospace' }}>{runs.join(', ')}{model.hours.length > runs.length ? ', …' : ''}</span></>
              : runs[0]}
        </div>
      )}
    </div>
  );
}

export default function SchedulesTab({ settings, update }: { settings: ScheduleSettings; update: (job: keyof ScheduleSettings, patch: Partial<ScheduleEntry>) => void }) {
  const jobs: Array<keyof ScheduleSettings> = [
    'sentiment', 'tiktokFeed', 'tiktokSearch', 'tiktokStatsRefresh', 'instagram',
    'twitterSearch', 'twitterComments', 'twitterStatsRefresh', 'campaignSync',
    'cleanup', 'morningDigest', 'weeklyDigest',
  ];
  return (
    <Section title="Cron jobs" desc="Enable/disable picks up within 60s. Editing a schedule requires `pm2 restart scheduler` to take effect.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th className="text-left py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Job</th>
              <th className="text-left py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Schedule</th>
              <th className="text-right py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const j = settings[job];
              return (
                <tr key={job}>
                  <td className="py-3 px-2 align-top" style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-primary)', minWidth: 160 }}>{j.label}</td>
                  <td className="py-3 px-2 border-b-light">
                    <CronEditor value={j.cron} onChange={(v) => update(job, { cron: v })} />
                  </td>
                  <td className="py-3 px-2 text-right align-top border-b-light">
                    <div className="inline-block">
                      <Toggle checked={j.enabled} onChange={(b) => update(job, { enabled: b })} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
