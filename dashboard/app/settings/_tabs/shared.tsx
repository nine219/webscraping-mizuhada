'use client';

import { useState } from 'react';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
// Matches src/api/require-api-key.ts on the backend — only enforced there
// when API_KEY is actually set, so leaving this unset locally still works.
// This helper had been missing it entirely (unlike dashboard/lib/api.ts's
// apiFetch), so every Settings-page write (auto-save, brand add/delete,
// account triggers) silently 401'd once a real API_KEY was configured.
export const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // ngrok-skip-browser-warning: see dashboard/lib/api.ts's apiFetch for why —
    // same reasoning applies here, this is the Settings page's own fetch helper.
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-6 mb-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
      <div className="mb-5 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <h3 className="text-base font-semibold text-primary">{title}</h3>
        {desc && <p className="text-xs mt-1 text-muted">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

export function KeywordChips({ keywords, onAdd, onRemove, placeholder }: {
  keywords: string[]; onAdd: (kw: string) => void; onRemove: (kw: string) => void; placeholder: string;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  function trySubmit() {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      setError(`"${trimmed}" is already in the list.`);
      return;
    }
    setError('');
    onAdd(trimmed);
    setInput('');
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        {keywords.length === 0 && (
          <span className="text-xs text-muted">No keywords yet</span>
        )}
        {keywords.map((kw) => (
          <span key={kw} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium"
            style={{ background: '#eff6ff', border: '1px solid #bfdbfe', color: '#0284c7' }}>
            {kw}
            <span className="cursor-pointer opacity-60 hover:opacity-100" onClick={() => onRemove(kw)}>×</span>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          placeholder={placeholder}
          onChange={(e) => { setInput(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') trySubmit(); }}
          className="px-3 py-1.5 text-sm rounded-lg outline-none flex-1"
          style={{ border: error ? '1px solid var(--accent-danger)' : '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-primary)', maxWidth: 280 }}
        />
        <button
          onClick={trySubmit}
          className="px-3 py-1.5 text-sm rounded-lg cursor-pointer"
          style={{ border: '1px solid var(--accent-primary)', background: 'transparent', color: 'var(--accent-primary)' }}
        >
          + Add
        </button>
      </div>
      {error && <div className="text-xs mt-1.5" style={{ color: 'var(--accent-danger)' }}>{error}</div>}
    </div>
  );
}

export function Field({ label, desc, children }: { label: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start py-3 gap-4 border-b-light">
      <div className="flex-1">
        <div className="text-sm font-medium text-primary">{label}</div>
        {desc && <div className="text-xs mt-0.5 text-muted">{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function NumInput({ value, onChange, step, min }: { value: number; onChange: (n: number) => void; step?: number; min?: number }) {
  return (
    <input
      type="number"
      value={value}
      step={step ?? 1}
      min={min ?? 0}
      onChange={(e) => onChange(Number(e.target.value))}
      className="px-3 py-1.5 text-sm rounded-lg outline-none font-mono"
      style={{ border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-primary)', width: 140 }}
    />
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <label className="toggle" onClick={() => onChange(!checked)}>
      <input type="checkbox" readOnly checked={checked} />
      <span className="toggle-track" />
      <span className="toggle-thumb" />
    </label>
  );
}
