'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

// Lazy-loaded tabs — each chunk fetches data only when its tab opens.
const MentionsTab  = dynamic(() => import('./_tabs/mentions-tab'),  { ssr: false, loading: () => <TabLoading /> });
const CampaignsTab = dynamic(() => import('./_tabs/campaigns-tab'), { ssr: false, loading: () => <TabLoading /> });

type Tab = 'mentions' | 'campaigns';

const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'mentions',  label: 'Mentions',  sub: 'UGC mentions from any handle · Playwright via persistent Chrome session' },
  { key: 'campaigns', label: 'Campaigns', sub: 'MizuMi ambassador & hashtag campaigns — anchor posts, replies, quote tweets' },
];

function isTab(s: string | null): s is Tab {
  return s === 'mentions' || s === 'campaigns';
}

function TabLoading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 rounded-full animate-spin"
        style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
    </div>
  );
}

function XHostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(initial) ? initial : 'mentions');
  // Mount-once-then-keep-alive: tabs that have been opened stay mounted with
  // display:none. State + fetched data persist; switching back is instant and
  // does NOT refetch. Each tab is only mounted (and only fetches) on first open.
  const [mounted, setMounted] = useState<Set<Tab>>(() => new Set([isTab(initial) ? initial : 'mentions']));

  useEffect(() => {
    setMounted((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
    const current = params.get('tab');
    if (current !== tab) {
      const next = new URLSearchParams(Array.from(params.entries()));
      next.set('tab', tab);
      router.replace(`/x?${next.toString()}`);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">X (Twitter)</h1>
          <p className="page-header-subtitle">{TABS.find((t) => t.key === tab)?.sub}</p>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex gap-2 mb-5 overflow-x-auto" style={{ borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2.5 text-sm font-medium transition-colors flex-shrink-0"
            style={{
              color: tab === t.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
              borderBottom: tab === t.key ? '2px solid var(--accent-primary)' : '2px solid transparent',
              marginBottom: -1,
            }}
            title={t.sub}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mounted.has('mentions')  && <div style={{ display: tab === 'mentions'  ? 'block' : 'none' }}><MentionsTab /></div>}
      {mounted.has('campaigns') && <div style={{ display: tab === 'campaigns' ? 'block' : 'none' }}><CampaignsTab /></div>}
    </div>
  );
}

export default function XHost() {
  return (
    <Suspense fallback={<TabLoading />}>
      <XHostInner />
    </Suspense>
  );
}
