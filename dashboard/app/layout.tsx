import type { Metadata } from 'next';
import './globals.css';
import Sidebar from '@/components/sidebar';
import NotificationBell from '@/components/notification-bell';

export const metadata: Metadata = {
  title: 'Mizuhada — Competitor Intelligence Platform',
  description: 'Real-time competitor pricing and social sentiment for Mizuhada Group',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="main-content flex-1 min-w-0 flex flex-col">
            {/* Global top bar */}
            <div
              className="topbar flex items-center justify-between px-8 py-3 sticky top-0 z-40"
              style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-widest text-muted">
                  Mizuhada Intelligence Platform
                </span>
                <span className="live-indicator"><span className="live-dot"></span> Live</span>
              </div>
              <NotificationBell />
            </div>
            <main className="flex-1" style={{ padding: '28px 32px' }}>
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
