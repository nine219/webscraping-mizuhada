'use client';

import { useEffect, useState } from 'react';
import { fetchSocialBrands, createSocialBrand, SocialBrand } from '@/lib/api';

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brand';
}

// Shared brand-list fetch for both Search-tab cards (Multi-Platform Search,
// Feed Scrape) — each card owns its own instance so a brand created from one
// card is immediately reflected there without needing cross-card state.
export function useSocialBrands() {
  const [brands, setBrands] = useState<SocialBrand[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSocialBrands().then(setBrands).catch(() => {}).finally(() => setLoading(false));
  }, []);

  return { brands, setBrands, loading };
}

export default function BrandPicker({
  brands,
  value,
  onChange,
  onCreated,
  newBrandDefaultType = 'competitor',
  disabled,
}: {
  brands: SocialBrand[];
  value: string;
  onChange: (slug: string) => void;
  onCreated: (b: SocialBrand) => void;
  newBrandDefaultType?: 'own' | 'competitor';
  disabled?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<'own' | 'competitor'>(newBrandDefaultType);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Enter a brand name.'); return; }
    const slug = slugify(trimmed);
    if (brands.some((b) => b.slug === slug || b.name.toLowerCase() === trimmed.toLowerCase())) {
      setErr(`"${trimmed}" already exists — pick it from the list instead.`);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const created = await createSocialBrand({ name: trimmed, slug, type });
      onCreated(created);
      onChange(created.slug);
      setCreating(false);
      setName('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create brand');
    } finally {
      setBusy(false);
    }
  }

  if (creating) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); if (err) setErr(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submitCreate(); }}
          placeholder="New brand name"
          disabled={busy}
          className="text-sm px-3 py-2 rounded-lg outline-none"
          style={{ border: err ? '1px solid var(--accent-danger)' : '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)', minWidth: 180 }}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as 'own' | 'competitor')}
          disabled={busy}
          className="text-sm px-2 py-2 rounded-lg outline-none"
          style={{ border: '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)' }}
        >
          <option value="competitor">Competitor</option>
          <option value="own">Own brand</option>
        </select>
        <button className="btn btn-primary" onClick={submitCreate} disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
        <button className="filter-pill" onClick={() => { setCreating(false); setErr(''); setName(''); }} disabled={busy}>Cancel</button>
        {err && <div className="text-xs w-full" style={{ color: 'var(--accent-danger)' }}>{err}</div>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="text-sm px-3 py-2 rounded-lg outline-none"
        style={{ border: '1px solid var(--border-light)', background: 'var(--bg-base)', color: 'var(--text-primary)', minWidth: 180 }}
      >
        <option value="" disabled>Select brand…</option>
        {brands.map((b) => (
          <option key={b.slug} value={b.slug}>{b.name} ({b.type})</option>
        ))}
      </select>
      <button className="filter-pill" onClick={() => setCreating(true)} disabled={disabled}>+ New brand</button>
    </div>
  );
}
