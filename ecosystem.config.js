/**
 * PM2 ecosystem — host-side processes only.
 *
 * Since the 2026-07 Docker cutover, `api`/`dashboard`/`captcha-solver`/
 * `scheduler-core`/`scraper-tiktok`/`scraper-instagram`/`scraper-twitter` all
 * run as Docker Compose services instead (see docker-compose.yml) — this file
 * only starts what still has to run on the host: the XHS scraper (blocked by
 * anti-bot in a container, needs the host's real Chrome).
 *
 * First time:
 *   docker compose up -d                  # everything except XHS
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 startup                           # follow the printed command to enable boot autostart
 *   pm2 save                              # save process list
 *
 * Daily use:
 *   pm2 status                    # see host processes
 *   pm2 logs scheduler            # XHS scraper logs
 *   pm2 restart scheduler         # after code changes to XHS scraper code
 *   pm2 stop all
 */

const path = require('path');
const root  = __dirname;
const env   = { dotenv_config_path: path.join(root, '.env.local') };

const logDir = path.join(root, 'logs');

module.exports = {
  apps: [
    // Host XHS scraper node — cron (XHS only) + queue worker, using the
    // host's real Chrome (XHS is blocked in containers, see dockerplan.md).
    // Everything else (TikTok/Instagram/Twitter cron + core jobs) moved to
    // the scheduler-core + scraper-<platform> Docker containers — this used
    // to be the legacy all-in-one 'scheduler' app; keeping the same PM2 name
    // so `pm2 restart scheduler` / existing tooling still finds it.
    {
      name: 'scheduler',
      script: 'node',
      args: [
        '-r', 'ts-node/register',
        '-r', 'dotenv/config',
        path.join(root, 'src/scraper-runtime/scraper-entry.ts'),
      ].join(' '),
      cwd: root,
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '2G', // Playwright browser sessions can grow large
      kill_timeout: 10000,
      out_file: path.join(logDir, 'scheduler-out.log'),
      error_file: path.join(logDir, 'scheduler-err.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: { ...env, TS_NODE_PROJECT: path.join(root, 'tsconfig.json'), SCHEDULER_ROLE: 'scraper', SCRAPER_PLATFORM: 'xhs' },
    },
  ],
};
