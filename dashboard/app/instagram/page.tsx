'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const FeedTab        = dynamic(() => import('./_tabs/feed-tab'),        { ssr: false, loading: () => <TabLoading /> });
const CompetitorsTab = dynamic(() => import('./_tabs/competitors-tab'), { ssr: false, loading: () => <TabLoading /> });

type Tab = 'feed' | 'competitors';

const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'feed',        label: 'Feed Monitor', sub: 'Own-brand posts from MizuMi, Gentle Colors, and Bomi' },
  { key: 'competitors', label: 'Competitors',  sub: 'Raw scraped data for competitor brands' },
];

function isTab(s: string | null): s is Tab {
  return s === 'feed' || s === 'competitors';
}

function TabLoading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 rounded-full animate-spin"
        style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
    </div>
  );
}

function InstagramHostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(initial) ? initial : 'feed');
  // Mount-once-then-keep-alive (see /tiktok host for rationale).
  const [mounted, setMounted] = useState<Set<Tab>>(() => new Set([isTab(initial) ? initial : 'feed']));

  useEffect(() => {
    setMounted((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
    const current = params.get('tab');
    if (current !== tab) {
      const next = new URLSearchParams(Array.from(params.entries()));
      next.set('tab', tab);
      router.replace(`/instagram?${next.toString()}`);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">Instagram</h1>
          <p className="page-header-subtitle">{TABS.find((t) => t.key === tab)?.sub}</p>
        </div>
        <span className="live-indicator"><span className="live-dot"></span> Live monitoring</span>
      </div>

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

      {mounted.has('feed')        && <div style={{ display: tab === 'feed'        ? 'block' : 'none' }}><FeedTab /></div>}
      {mounted.has('competitors') && <div style={{ display: tab === 'competitors' ? 'block' : 'none' }}><CompetitorsTab /></div>}
    </div>
  );
}

export default function InstagramHost() {
  return (
    <Suspense fallback={<TabLoading />}>
      <InstagramHostInner />
    </Suspense>
  );
}
