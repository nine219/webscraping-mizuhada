import express from 'express';
import cors from 'cors';
import scrapeRouter from './routes/scrape';
import socialRouter from './routes/social';
import brandsRouter from './routes/brands';
import notificationsRouter from './routes/notifications';
import tiktokRouter from './routes/tiktok';
import tiktokJobsRouter from './routes/tiktok-jobs';
import tiktokInfluencersRouter from './routes/tiktok-influencers';
import commandCenterRouter from './routes/command-center';
import instagramRouter from './routes/instagram';
import xhsRouter from './routes/xhs';
import adminRouter from './routes/admin';
import settingsRouter from './routes/settings';
import twitterRouter from './routes/twitter';
import campaignsRouter from './routes/campaigns';
import { requireApiKey } from './require-api-key';

const app = express();
const PORT = parseInt(process.env.API_PORT ?? '3001', 10);

app.use(cors({ origin: process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use(requireApiKey);

app.use('/api/scrape', scrapeRouter);
app.use('/api/social', socialRouter);
app.use('/api/brands', brandsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/tiktok', tiktokRouter);
app.use('/api/tiktok', tiktokJobsRouter);
app.use('/api/tiktok', tiktokInfluencersRouter);
app.use('/api/command-center', commandCenterRouter);
app.use('/api/instagram', instagramRouter);
app.use('/api/xhs', xhsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/twitter', twitterRouter);
app.use('/api/campaigns', campaignsRouter);

app.listen(PORT, () => {
  console.log(`[API] Mizuhada Social Intelligence API running on http://localhost:${PORT}`);
});

export default app;
