import { Router, Request, Response } from 'express';
import { getNotifications, markNotificationRead, markAllNotificationsRead } from '../../notifications/store';

const router = Router();

// Single-operator tool, no user/session system exists (CLAUDE.md) — 'default'
// is the only real account, but accepting user_id from the client meant any
// caller could pass an arbitrary value to read/mark another "user"'s
// notifications. Pinned server-side; becomes a real per-user scope only once
// actual multi-user auth exists.
const USER_ID = 'default';

router.get('/', async (req: Request, res: Response) => {
  const { limit = '20', unreadOnly } = req.query as Record<string, string>;
  try {
    const result = await getNotifications(USER_ID, {
      limit: parseInt(limit, 10) || 20,
      unreadOnly: unreadOnly === 'true',
    });
    res.json(result);
  } catch (err) {
    console.error('[notifications]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/read', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Invalid notification id' });
    return;
  }
  try {
    await markNotificationRead(id, USER_ID);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/read]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/read-all', async (_req: Request, res: Response) => {
  try {
    await markAllNotificationsRead(USER_ID);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications/read-all]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
