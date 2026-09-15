'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_SECTIONS = [
  {
    title: 'Social Intel',
    items: [
      {
        href: '/overview',
        label: 'Command Center',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
        ),
      },
      {
        href: '/ugc',
        label: 'UGC Performance',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        ),
      },
      // Hidden per SCOPE v3: /crisis duplicates /overview brand-card crisis indicator.
      // Route kept; code intact. Re-enable by uncommenting.
      // {
      //   href: '/crisis',
      //   label: 'Crisis Center',
      //   icon: (
      //     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
      //       <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      //       <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      //     </svg>
      //   ),
      // },
      {
        href: '/social',
        label: 'Social Listening',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        ),
      },
    ],
  },
  {
    title: 'Platform',
    items: [
      // Per SCOPE v3 compression: each platform is a single page with tabs
      // (Feed/Brand Monitor · UGC Search · Hashtags · Influencers, per
      // platform's own capabilities). Standalone per-feature routes deleted.
      {
        href: '/tiktok',
        label: 'TikTok',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        ),
      },
      {
        href: '/xhs',
        label: 'Xiaohongshu',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
        ),
      },
      {
        href: '/instagram',
        label: 'Instagram',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
            <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
          </svg>
        ),
      },
      {
        href: '/x',
        label: 'X (Twitter)',
        icon: (
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] opacity-80">
            <path d="M18.244 2H21.5l-7.5 8.573L23 22h-6.828l-5.32-6.955L4.75 22H1.5l8.03-9.176L1 2h7l4.807 6.35L18.244 2zm-1.208 18h1.833L6.032 4h-1.98L17.036 20z"/>
          </svg>
        ),
      },
    ],
  },
  // Hidden per SCOPE v3: Monday digest auto-delivers via LINE; CSV deferred. Route kept.
  // {
  //   title: 'Monitor',
  //   items: [
  //     {
  //       href: '/reports',
  //       label: 'Reports',
  //       icon: (
  //         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
  //           <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  //           <polyline points="14 2 14 8 20 8"/>
  //         </svg>
  //       ),
  //     },
  //   ],
  // },
  // /alerts page removed entirely — its "Alert Rules"/"Recent Triggers" CRUD
  // was dead (nothing ever evaluated alert_rules or wrote alert_history); the
  // one real thing it showed (engagement spikes) now surfaces via the Command
  // Center fire ribbon → /social.
  {
    title: 'System',
    items: [
      {
        href: '/admin',
        label: 'Admin / Ops',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="9" y1="13" x2="15" y2="13"/>
            <line x1="9" y1="17" x2="15" y2="17"/>
          </svg>
        ),
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px] opacity-80">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.68 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        ),
      },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  // Sidebar is a fixed 260px column with no mobile fallback — below 768px
  // (same breakpoint .page-header already uses) it becomes an off-canvas
  // drawer instead, toggled by the hamburger button rendered below (that
  // button only shows up in that same breakpoint, see .sidebar-toggle).
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the drawer on navigation — otherwise tapping a link on mobile
  // leaves the drawer covering the page it just navigated to.
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Find most-specific nav item that matches current path (prevents /tiktok matching when at /tiktok/spikes)
  const allNavItems = NAV_SECTIONS.flatMap((s) => s.items);
  const activeHref = allNavItems
    .filter((i) => pathname === i.href || (i.href.length > 1 && pathname.startsWith(i.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? pathname;

  return (
    <>
      <button
        aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
        onClick={() => setMobileOpen((v) => !v)}
        className="sidebar-toggle"
        style={{
          position: 'fixed', top: 12, left: 12, zIndex: 60,
          width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer',
          alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-sidebar)', color: 'var(--text-on-dark)',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {mobileOpen
            ? <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
            : <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>}
        </svg>
      </button>
      <div
        className={`sidebar-backdrop${mobileOpen ? ' open' : ''}`}
        onClick={() => setMobileOpen(false)}
      />
      <aside
        style={{ background: 'var(--bg-sidebar)', color: 'var(--text-on-dark)' }}
        className={`sidebar flex flex-col py-6 fixed w-[260px] h-screen overflow-y-auto z-50${mobileOpen ? ' sidebar-open' : ''}`}
      >
      {/* Brand */}
      <div className="px-6 pb-6 mb-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <h1 className="text-xl font-bold flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
          Mizuhada
          <span
            style={{ background: 'var(--accent-primary)' }}
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
          >
            Beta
          </span>
        </h1>
        {/* <p className="text-xs mt-1.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
          Competitor Intelligence
        </p> */}
      </div>

      {/* Navigation */}
      {NAV_SECTIONS.map((section) => (
        <div key={section.title} className="px-4 py-2">
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.12em] px-2 pt-2 pb-1.5 mb-1"
            style={{ color: 'var(--text-sidebar-muted)' }}
          >
            {section.title}
          </div>
          {section.items.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm mb-0.5 transition-all"
                style={{
                  background: active ? 'var(--bg-sidebar-active)' : 'transparent',
                  color: active ? 'var(--text-sidebar-active)' : 'var(--text-sidebar)',
                  fontWeight: active ? 500 : 400,
                }}
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--bg-sidebar-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                {item.icon}
                {item.label}
                {active && (
                  <span 
                    className="ml-auto w-1.5 h-1.5 rounded-full"
                    style={{ background: 'var(--accent-primary)' }}
                  />
                )}
              </Link>
            );
          })}
        </div>
      ))}
      </aside>
    </>
  );
}
