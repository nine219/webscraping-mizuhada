'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

// Lazy-loaded tabs — each chunk fetches data only when its tab opens.
const FeedTab        = dynamic(() => import('./_tabs/feed-tab'),        { ssr: false, loading: () => <TabLoading /> });
const ViralTab       = dynamic(() => import('./_tabs/viral-tab'),       { ssr: false, loading: () => <TabLoading /> });
const SearchTab      = dynamic(() => import('./_tabs/search-tab'),      { ssr: false, loading: () => <TabLoading /> });
const HashtagsTab    = dynamic(() => import('./_tabs/hashtags-tab'),    { ssr: false, loading: () => <TabLoading /> });
const InfluencersTab = dynamic(() => import('./_tabs/influencers-tab'), { ssr: false, loading: () => <TabLoading /> });
const CompetitorsTab = dynamic(() => import('./_tabs/competitors-tab'), { ssr: false, loading: () => <TabLoading /> });

type Tab = 'feed' | 'viral' | 'search' | 'hashtags' | 'influencers' | 'competitors';

// Viral sits right after Feed Monitor — the second-most-visible slot without
// disturbing the default landing tab — since "what's actually going viral"
// is marketing's lead ask driving this whole milestone (see plan context).
const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: 'feed',        label: 'Feed Monitor', sub: 'Own brand posts + UGC mentions' },
  { key: 'viral',       label: 'Viral',        sub: 'Spiking now — feed + UGC search together' },
  { key: 'search',      label: 'UGC Search',   sub: 'Mentions from any creator (Analyst view)' },
  { key: 'hashtags',    label: 'Hashtags',     sub: 'Top hashtags' },
  { key: 'influencers', label: 'Influencers',  sub: 'Creators who mention own brands' },
  // Was "Mockup — Her Hyness only, raw data" — stale the moment kage/laglace
  // got added as real tracked competitors alongside Her Hyness. The in-tab
  // info banner (competitors-tab.tsx) already correctly explains the actual
  // "raw data, no sentiment/theme/spike" limitation without naming any one
  // competitor, so this just needed to stop pretending only one exists.
  { key: 'competitors', label: 'Competitors',  sub: 'Raw scraped data, no sentiment/theme/spike analysis' },
];

function isTab(s: string | null): s is Tab {
  return s === 'feed' || s === 'viral' || s === 'search' || s === 'hashtags' || s === 'influencers' || s === 'competitors';
}

function TabLoading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 rounded-full animate-spin"
        style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
    </div>
  );
}

function TikTokHostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(initial) ? initial : 'feed');
  // Mount-once-then-keep-alive: tabs that have been opened stay mounted with
  // display:none. State + fetched data persist; switching back is instant and
  // does NOT refetch. Each tab is only mounted (and only fetches) on first open.
  const [mounted, setMounted] = useState<Set<Tab>>(() => new Set([isTab(initial) ? initial : 'feed']));

  useEffect(() => {
    setMounted((prev) => prev.has(tab) ? prev : new Set(prev).add(tab));
    const current = params.get('tab');
    if (current !== tab) {
      const next = new URLSearchParams(Array.from(params.entries()));
      next.set('tab', tab);
      router.replace(`/tiktok?${next.toString()}`);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // The above only pushes local tab state OUT to the URL. Without this, a
  // child tab navigating with router.push (e.g. Hashtags' "view posts using
  // this hashtag" -> /tiktok?tab=search&q=X) updated the URL and the target
  // tab's own filters, but this host's visible active-tab strip stayed on
  // whatever tab was already open — the URL said "search" while the UI kept
  // showing "Hashtags" selected. Syncs the reverse direction too.
  useEffect(() => {
    const fromUrl = params.get('tab');
    if (isTab(fromUrl) && fromUrl !== tab) setTab(fromUrl);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-header-title">TikTok</h1>
          <p className="page-header-subtitle">{TABS.find((t) => t.key === tab)?.sub}</p>
        </div>
        <span className="live-indicator"><span className="live-dot"></span> Live monitoring</span>
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

      {mounted.has('feed')        && <div style={{ display: tab === 'feed'        ? 'block' : 'none' }}><FeedTab /></div>}
      {mounted.has('viral')       && <div style={{ display: tab === 'viral'       ? 'block' : 'none' }}><ViralTab /></div>}
      {mounted.has('search')      && <div style={{ display: tab === 'search'      ? 'block' : 'none' }}><SearchTab /></div>}
      {mounted.has('hashtags')    && <div style={{ display: tab === 'hashtags'    ? 'block' : 'none' }}><HashtagsTab /></div>}
      {mounted.has('influencers') && <div style={{ display: tab === 'influencers' ? 'block' : 'none' }}><InfluencersTab /></div>}
      {mounted.has('competitors') && <div style={{ display: tab === 'competitors' ? 'block' : 'none' }}><CompetitorsTab /></div>}
    </div>
  );
}

export default function TikTokHost() {
  return (
    <Suspense fallback={<TabLoading />}>
      <TikTokHostInner />
    </Suspense>
  );
}
