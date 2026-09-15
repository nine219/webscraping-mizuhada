'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchNotifications, markNotificationRead, markAllNotificationsRead, UserNotification } from '@/lib/api';

const USER_ID = 'default';

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const load = async () => {
    try {
      setLoading(true);
      const data = await fetchNotifications({ userId: USER_ID, limit: 20 });
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      console.error('Failed to fetch notifications', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleMarkRead = async (id: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await markNotificationRead(id, USER_ID);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (err) {
      console.error('Failed to mark notification read', err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead(USER_ID);
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true, read_at: new Date().toISOString() })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all read', err);
    }
  };

  const handleViewPost = (n: UserNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    if (n.related_post_id) {
      handleMarkRead(n.id);
      router.push(`/tiktok/${n.related_post_id}`);
      setOpen(false);
    }
  };

  const badgeText = unreadCount > 9 ? '9+' : unreadCount > 0 ? String(unreadCount) : null;

  return (
    <div ref={bellRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg transition-colors hover:bg-black/5"
        aria-label="Notifications"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="w-[20px] h-[20px]"
          style={{ color: open ? 'var(--text-primary)' : 'var(--text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { if (!open) e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {badgeText && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full text-[10px] font-bold text-white"
            style={{ background: 'var(--accent-danger)' }}
          >
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 z-50 rounded-xl w-80 overflow-hidden"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="font-semibold text-sm text-primary">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs font-medium hover:underline"
                style={{ color: 'var(--accent-primary)' }}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted">
                No notifications yet.
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => handleMarkRead(n.id)}
                  className="relative px-4 py-3 cursor-pointer transition-colors hover:bg-black/[0.02] border-b-light"
                >
                  <div className="flex items-start gap-3">
                    {!n.is_read && (
                      <span
                        className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: 'var(--accent-primary)' }}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate text-primary">
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="text-xs mt-0.5 line-clamp-2 text-secondary">
                          {n.body}
                        </p>
                      )}
                      <p className="text-[11px] mt-1 text-muted">
                        {formatTimeAgo(n.created_at)}
                      </p>
                      {n.related_post_id && (
                        <button
                          type="button"
                          onClick={(e) => handleViewPost(n, e)}
                          className="mt-2 text-[11px] font-medium hover:underline"
                          style={{ color: 'var(--accent-primary)' }}
                        >
                          View post
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
