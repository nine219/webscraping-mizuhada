import { socialQuery, socialQueryOne } from '../db/social-client';

export interface CreateNotificationInput {
  userId?: string;
  type: 'schedule' | 'new_post_feed' | 'new_post_search' | 'scrape_job';
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  relatedPostId?: string;
}

export interface UserNotification {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  related_post_id: string | null;
  created_at: string;
}

interface NotificationRow {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  is_read: boolean;
  read_at: Date | null;
  related_post_id: string | null;
  created_at: Date;
}

function toISO(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function mapRow(row: NotificationRow): UserNotification {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload,
    is_read: row.is_read,
    read_at: toISO(row.read_at),
    related_post_id: row.related_post_id,
    created_at: row.created_at.toISOString(),
  };
}

export async function createNotification(input: CreateNotificationInput): Promise<UserNotification> {
  const userId = input.userId ?? 'default';
  const row = await socialQueryOne<NotificationRow>(
    `INSERT INTO user_notifications (
      user_id, type, title, body, payload, related_post_id
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      userId,
      input.type,
      input.title,
      input.body ?? null,
      input.payload ? JSON.stringify(input.payload) : '{}',
      input.relatedPostId ?? null,
    ],
  );
  if (!row) {
    throw new Error('Failed to create notification');
  }
  return mapRow(row);
}

export async function getNotifications(
  userId: string,
  opts?: { limit?: number; unreadOnly?: boolean },
): Promise<{ notifications: UserNotification[]; unreadCount: number }> {
  const uid = userId || 'default';
  const limit = opts?.limit ?? 20;
  const rows = await socialQuery<NotificationRow>(
    `SELECT * FROM user_notifications
     WHERE user_id = $1 ${opts?.unreadOnly ? 'AND is_read = false' : ''}
     ORDER BY created_at DESC
     LIMIT $2`,
    [uid, limit],
  );
  const countRow = await socialQueryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM user_notifications WHERE user_id = $1 AND is_read = false`,
    [uid],
  );
  return {
    notifications: rows.map(mapRow),
    unreadCount: parseInt(countRow?.count ?? '0', 10),
  };
}

export async function markNotificationRead(id: number, userId: string): Promise<void> {
  await socialQuery(
    `UPDATE user_notifications
     SET is_read = true, read_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, userId || 'default'],
  );
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await socialQuery(
    `UPDATE user_notifications
     SET is_read = true, read_at = NOW()
     WHERE user_id = $1 AND is_read = false`,
    [userId || 'default'],
  );
}
