'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import MultiPlatformSearch, { FeedScrapeCard } from '../../components/multi-platform-search';
import { api } from './_tabs/shared';
import type { AppSettings, KeywordsSettings, ThresholdSettings, ScheduleEntry, ScheduleSettings, Brand, KeywordPlatform } from './_tabs/types';
import AccountsTab from './_tabs/accounts-tab';
import BrandsTab from './_tabs/brands-tab';
import KeywordsTab from './_tabs/keywords-tab';
import ThresholdsTab from './_tabs/thresholds-tab';
import SchedulesTab from './_tabs/schedules-tab';

// ── Main page ─────────────────────────────────────────────────────────────────
// Tab bodies live in ./_tabs/*.tsx (mirrors the tiktok/xhs page split) — this
// file only owns shared settings state (fetched once, passed down as props +
// update callbacks) and the tab strip.

type SettingsTab = 'accounts' | 'brands' | 'keywords' | 'thresholds' | 'schedules' | 'search';
const VALID_TABS: SettingsTab[] = ['accounts', 'brands', 'keywords', 'thresholds', 'schedules', 'search'];

function SettingsPageInner() {
  const params = useSearchParams();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<AppSettings | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  // Admin/Ops links here with ?tab=search (Multi-Platform Search's actual
  // location) — read once on mount so that deep link lands on the right tab
  // instead of always defaulting to Accounts.
  const [tab, setTab] = useState<SettingsTab>(() => {
    const t = params.get('tab');
    return (VALID_TABS as string[]).includes(t ?? '') ? (t as SettingsTab) : 'accounts';
  });

  // Load on mount
  useEffect(() => {
    (async () => {
      try {
        const data = await api<{ settings: AppSettings; defaults: AppSettings }>('/api/settings');
        setSettings(data.settings);
        setDefaults(data.defaults);
        const b = await api<Brand[]>('/api/settings/brands');
        setBrands(b);
      } catch (err) {
        console.error(err);
        showToast('Failed to load settings', 'err');
      }
    })();
  }, []);

  function showToast(msg: string, kind: 'ok' | 'err' = 'ok') {
    setNotice({ kind, text: msg });
  }

  useEffect(() => {
    if (!notice) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setNotice(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notice]);

  useEffect(() => {
    if (!confirmDeleteSlug) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setConfirmDeleteSlug(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDeleteSlug]);

  function update<K extends keyof AppSettings>(key: K, patch: Partial<AppSettings[K]>) {
    setSettings((prev) => prev ? { ...prev, [key]: { ...prev[key], ...patch } } : prev);
    setDirty(true);
    // Any further edit — including manually undoing what was just saved — makes
    // a "Settings saved" / "Reset to defaults" confirmation stale. Clear it.
    setNotice(null);
  }

  function updateKeywords(patch: Partial<KeywordsSettings>) { update('keywords', patch); }
  function updateThresholds(patch: Partial<ThresholdSettings>) { update('thresholds', patch); }
  function updateSchedule(job: keyof ScheduleSettings, patch: Partial<ScheduleEntry>) {
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, schedules: { ...prev.schedules, [job]: { ...prev.schedules[job], ...patch } } };
    });
    setDirty(true);
  }

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const data = await api<{ ok: boolean; settings: AppSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings(data.settings);
      setDirty(false);
      setLastSavedAt(new Date());
      // Success is silent (inline status text only, see header) — auto-save
      // fires on every edit, so a modal per keystroke-pause would be constant
      // noise. Failures still interrupt, since a lost edit is worth flagging.
    } catch (err) {
      console.error(err);
      showToast('Save failed — check API logs.', 'err');
    } finally {
      setSaving(false);
    }
  }, [settings]);

  // Auto-save — debounced so rapid edits (typing a keyword, dragging a
  // threshold slider) collapse into one PUT instead of one per keystroke.
  // The manual "Save Changes" button stays as an immediate/explicit option;
  // this just means you no longer have to remember to click it.
  useEffect(() => {
    if (!dirty || saving) return;
    // Depends on `settings` (not just `dirty`) so every subsequent edit
    // resets the timer — otherwise the 1.5s countdown starts on the FIRST
    // keystroke and could fire mid-edit instead of after the user pauses.
    const t = setTimeout(() => { handleSave(); }, 1500);
    return () => clearTimeout(t);
  }, [settings, dirty, saving, handleSave]);

  async function handleReset() {
    if (!confirm('Reset all settings to defaults? Saved brand/keyword overrides will be lost.')) return;
    try {
      const data = await api<{ ok: boolean; settings: AppSettings }>('/api/settings/reset', { method: 'POST' });
      setSettings(data.settings);
      setDirty(false);
      showToast('Settings reset to defaults.');
    } catch {
      showToast('Reset failed.', 'err');
    }
  }

  async function addBrand(form: { name: string; slug: string; type: 'own' | 'competitor'; tiktok_handle: string; instagram_handle: string }) {
    try {
      await api<Brand>('/api/settings/brands', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const b = await api<Brand[]>('/api/settings/brands');
      setBrands(b);
      showToast(`Brand "${form.name}" saved.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Brand save failed.', 'err');
    }
  }

  // Keyword CRUD — immediate (no debounce), mirrors addBrand/deleteBrand's
  // pattern instead of the whole-settings-object autosave used elsewhere on
  // this page. keyword_terms is a real table now (see settings.ts), so each
  // add/remove is its own request instead of round-tripping the full array.
  function patchKeywordState(platform: KeywordPlatform, brandSlug: string | null, mutate: (kws: string[]) => string[]) {
    setSettings((prev) => {
      if (!prev) return prev;
      const kwState = prev.keywords;
      if (platform === 'tiktok_category') {
        return { ...prev, keywords: { ...kwState, tiktokCategory: mutate(kwState.tiktokCategory) } };
      }
      if (platform === 'xhs') {
        return { ...prev, keywords: { ...kwState, xhs: mutate(kwState.xhs) } };
      }
      const field = platform === 'tiktok'
        ? (brandSlug && brands.find((b) => b.slug === brandSlug)?.type === 'competitor' ? 'competitorTiktok' : 'tiktok')
        : 'twitter';
      const map = kwState[field] as Record<string, string[]>;
      const slug = brandSlug ?? '';
      return { ...prev, keywords: { ...kwState, [field]: { ...map, [slug]: mutate(map[slug] ?? []) } } };
    });
  }

  async function addKeyword(platform: KeywordPlatform, brandSlug: string | null, kw: string) {
    patchKeywordState(platform, brandSlug, (kws) => (kws.includes(kw) ? kws : [...kws, kw]));
    try {
      await api('/api/settings/keywords', { method: 'POST', body: JSON.stringify({ platform, brandSlug, keyword: kw }) });
    } catch (err) {
      console.error(err);
      showToast('Failed to add keyword.', 'err');
      patchKeywordState(platform, brandSlug, (kws) => kws.filter((k) => k !== kw));
    }
  }

  async function removeKeyword(platform: KeywordPlatform, brandSlug: string | null, kw: string) {
    patchKeywordState(platform, brandSlug, (kws) => kws.filter((k) => k !== kw));
    try {
      await api('/api/settings/keywords', { method: 'DELETE', body: JSON.stringify({ platform, brandSlug, keyword: kw }) });
    } catch (err) {
      console.error(err);
      showToast('Failed to remove keyword.', 'err');
      patchKeywordState(platform, brandSlug, (kws) => (kws.includes(kw) ? kws : [...kws, kw]));
    }
  }

  function deleteBrand(slug: string) {
    setConfirmDeleteSlug(slug);
  }

  async function confirmDeleteBrand() {
    const slug = confirmDeleteSlug;
    if (!slug) return;
    setDeleting(true);
    try {
      await api<{ ok: boolean }>(`/api/settings/brands/${slug}`, { method: 'DELETE' });
      setBrands((prev) => prev.filter((b) => b.slug !== slug));
      setConfirmDeleteSlug(null);
      showToast('Brand deleted.');
    } catch {
      setConfirmDeleteSlug(null);
      showToast('Delete failed (brand may still be referenced).', 'err');
    } finally {
      setDeleting(false);
    }
  }

  if (!settings || !defaults) {
    return <div className="p-6 text-sm text-muted">Loading settings…</div>;
  }

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'accounts',   label: 'Account Management' },
    { id: 'brands',     label: 'Brands' },
    { id: 'keywords',   label: 'Keywords' },
    { id: 'thresholds', label: 'Thresholds' },
    { id: 'schedules',  label: 'Schedules' },
    { id: 'search',     label: 'Search' },
  ];

  return (
    <div>
      {notice && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setNotice(null); }}>
          <div className="modal-glass p-6" style={{ maxWidth: 380, textAlign: 'center' }}>
            <div className="mx-auto mb-4 flex items-center justify-center rounded-full"
              style={{
                width: 56, height: 56,
                background: notice.kind === 'ok' ? 'var(--accent-success-subtle)' : 'var(--accent-danger-subtle)',
                color: notice.kind === 'ok' ? 'var(--accent-success)' : 'var(--accent-danger)',
                fontSize: 26,
              }}>
              {notice.kind === 'ok' ? '✓' : '!'}
            </div>
            <p className="text-sm font-medium mb-5 text-primary">{notice.text}</p>
            <button onClick={() => setNotice(null)} className="px-6 py-2 text-sm font-medium rounded-full cursor-pointer"
              style={{ background: '#0f172a', color: '#fff', border: 'none' }}>
              OK
            </button>
          </div>
        </div>
      )}

      {confirmDeleteSlug && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !deleting) setConfirmDeleteSlug(null); }}>
          <div className="modal-glass p-6" style={{ maxWidth: 420, textAlign: 'center' }}>
            <div className="mx-auto mb-4 flex items-center justify-center rounded-full"
              style={{ width: 56, height: 56, background: 'var(--accent-danger-subtle)', color: 'var(--accent-danger)', fontSize: 26 }}>
              !
            </div>
            <p className="text-sm font-semibold mb-2 text-primary">Delete brand &quot;{confirmDeleteSlug}&quot;?</p>
            <p className="text-xs mb-5 text-secondary">
              This permanently deletes all its TikTok/Instagram posts and product listings — not just the link. Comments/XHS notes stay but lose the brand link. This cannot be undone.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => setConfirmDeleteSlug(null)} disabled={deleting}
                className="px-6 py-2 text-sm font-medium rounded-full cursor-pointer"
                style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
              <button onClick={confirmDeleteBrand} disabled={deleting}
                className="px-6 py-2 text-sm font-medium rounded-full cursor-pointer"
                style={{ background: 'var(--accent-danger)', color: '#fff', border: 'none', opacity: deleting ? 0.6 : 1 }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-[28px] font-bold text-primary">Settings</h2>
          <p className="text-sm mt-1 text-secondary">
            Runtime config — keywords, thresholds, schedules. Auto-saves ~1.5s after you stop editing; scrapers re-read every 60s.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {saving ? 'Saving…' : dirty ? 'Unsaved changes…' : lastSavedAt ? `Saved ${lastSavedAt.toLocaleTimeString()}` : ''}
          </span>
          <button
            onClick={handleReset}
            className="px-3 py-2 text-sm rounded-lg cursor-pointer"
            style={{ border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
          >
            Reset to defaults
          </button>
        </div>
      </div>

      {/* Tabs — horizontally scrollable instead of overflowing the page when
          narrow (width:fit-content used to force its full natural width). */}
      <div className="flex gap-1 mb-5 p-1 rounded-lg overflow-x-auto" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', maxWidth: '100%' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-4 py-1.5 text-sm rounded-md cursor-pointer transition-colors flex-shrink-0"
            style={{
              background: tab === t.id ? 'var(--bg-surface)' : 'transparent',
              color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: tab === t.id ? 600 : 400,
              boxShadow: tab === t.id ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'accounts'   && <AccountsTab />}
      {tab === 'brands'     && <BrandsTab brands={brands} onAdd={addBrand} onDelete={deleteBrand} />}
      {tab === 'keywords'   && <KeywordsTab settings={settings.keywords} brands={brands} update={updateKeywords} onAddKeyword={addKeyword} onRemoveKeyword={removeKeyword} />}
      {tab === 'thresholds' && <ThresholdsTab settings={settings.thresholds} defaults={defaults.thresholds} update={updateThresholds} />}
      {tab === 'schedules'  && <SchedulesTab settings={settings.schedules} update={updateSchedule} />}
      {tab === 'search'     && (<><MultiPlatformSearch /><FeedScrapeCard /></>)}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}
