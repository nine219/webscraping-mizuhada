'use client';

import { useState, useEffect } from 'react';
import { Section } from './shared';
import type { Brand } from './types';

// ── Brands tab ────────────────────────────────────────────────────────────────

const EMPTY_BRAND_FORM = { name: '', slug: '', type: 'competitor' as 'own' | 'competitor', tiktok_handle: '', instagram_handle: '' };

export default function BrandsTab({ brands, onAdd, onDelete }: { brands: Brand[]; onAdd: (b: { name: string; slug: string; type: 'own' | 'competitor'; tiktok_handle: string; instagram_handle: string }) => void; onDelete: (slug: string) => void }) {
  const [form, setForm] = useState(EMPTY_BRAND_FORM);
  const [modalOpen, setModalOpen] = useState(false);
  // Editing an existing brand vs adding a new one. The upsert on the backend
  // matches on slug (ON CONFLICT (slug) DO UPDATE) — if you're editing, the
  // slug field is locked so a typo can't silently create a duplicate brand
  // instead of updating the one you meant to.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const own = brands.filter((b) => b.type === 'own');
  const competitor = brands.filter((b) => b.type === 'competitor');

  function openAdd() {
    setEditingSlug(null);
    setForm(EMPTY_BRAND_FORM);
    setModalOpen(true);
  }
  function startEdit(b: Brand) {
    setEditingSlug(b.slug);
    setForm({ name: b.name, slug: b.slug, type: b.type, tiktok_handle: b.tiktok_handle ?? '', instagram_handle: b.instagram_handle ?? '' });
    setModalOpen(true);
  }
  function closeModal() {
    setModalOpen(false);
    setEditingSlug(null);
    setForm(EMPTY_BRAND_FORM);
  }

  // Escape-to-close, only while the modal is actually open.
  useEffect(() => {
    if (!modalOpen) return;
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') closeModal(); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  return (
    <Section title="Tracked Brands" desc="Own brands receive feed scraping + own-brand handle exclusion in UGC search. Competitors get keyword tracking only.">
      <div className="flex justify-end mb-4">
        <button onClick={openAdd} className="px-5 py-2 text-sm font-medium rounded-full cursor-pointer"
          style={{ background: '#0f172a', color: '#fff', border: 'none' }}>
          + Add Brand
        </button>
      </div>
      <div className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">Own brands</div>
        <BrandList brands={own} onEdit={startEdit} onDelete={onDelete} />
      </div>
      <div className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">Competitors</div>
        <BrandList brands={competitor} onEdit={startEdit} onDelete={onDelete} />
      </div>

      {modalOpen && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal-glass p-6">
            <div className="flex items-center justify-between mb-5">
              <h4 className="text-base font-semibold text-primary">
                {editingSlug ? `Editing "${editingSlug}"` : 'Add brand'}
              </h4>
              <button onClick={closeModal} aria-label="Close" className="w-7 h-7 flex items-center justify-center rounded-full cursor-pointer text-sm"
                style={{ background: 'var(--bg-base)', border: 'none', color: 'var(--text-secondary)' }}>
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Display name (e.g. MizuMi)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="px-3 py-2 text-sm rounded-xl outline-none" style={{ border: 'none', background: 'var(--bg-base)' }} />
              <input placeholder="Slug (e.g. mizumi)" value={form.slug} disabled={!!editingSlug} onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="px-3 py-2 text-sm rounded-xl outline-none" style={{ border: 'none', background: 'var(--bg-base)', color: editingSlug ? 'var(--text-muted)' : undefined }} />
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'own' | 'competitor' })}
                className="px-3 py-2 text-sm rounded-xl outline-none" style={{ border: 'none', background: 'var(--bg-base)' }}>
                <option value="competitor">competitor</option>
                <option value="own">own</option>
              </select>
              <div />
              <input placeholder="TikTok handle (no @)" value={form.tiktok_handle} onChange={(e) => setForm({ ...form, tiktok_handle: e.target.value })}
                className="px-3 py-2 text-sm rounded-xl outline-none" style={{ border: 'none', background: 'var(--bg-base)' }} />
              <input placeholder="Instagram handle (no @)" value={form.instagram_handle} onChange={(e) => setForm({ ...form, instagram_handle: e.target.value })}
                className="px-3 py-2 text-sm rounded-xl outline-none" style={{ border: 'none', background: 'var(--bg-base)' }} />
            </div>
            <div className="flex items-center gap-2 mt-5">
              <button
                onClick={() => {
                  if (!form.name || !form.slug) return;
                  onAdd(form);
                  closeModal();
                }}
                className="px-5 py-2 text-sm font-medium rounded-full cursor-pointer"
                style={{ background: '#0f172a', color: '#fff', border: 'none' }}
              >
                {editingSlug ? 'Save changes' : 'Add brand'}
              </button>
              <button onClick={closeModal} className="px-5 py-2 text-sm font-medium rounded-full cursor-pointer"
                style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: 'none' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function BrandList({ brands, onEdit, onDelete }: { brands: Brand[]; onEdit: (b: Brand) => void; onDelete: (slug: string) => void }) {
  if (brands.length === 0) return <div className="text-xs text-muted">None yet</div>;
  return (
    <div className="space-y-1.5">
      {brands.map((b) => (
        <div key={b.id} className="flex items-center justify-between px-3 py-2 rounded-lg"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-primary">{b.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-md font-mono" style={{ background: 'var(--bg-surface)', color: 'var(--text-muted)' }}>{b.slug}</span>
            {b.tiktok_handle && <span className="text-xs text-muted">TT: @{b.tiktok_handle}</span>}
            {b.instagram_handle && <span className="text-xs text-muted">IG: @{b.instagram_handle}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onEdit(b)} className="text-xs px-2 py-1 rounded cursor-pointer"
              style={{ color: 'var(--accent-primary)', background: 'transparent', border: '1px solid var(--border)' }}>
              Edit
            </button>
            <button onClick={() => onDelete(b.slug)} className="text-xs px-2 py-1 rounded cursor-pointer"
              style={{ color: 'var(--accent-danger)', background: 'transparent', border: '1px solid var(--border)' }}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
