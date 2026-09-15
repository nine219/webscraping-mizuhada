// PM2-compatible Next.js production server launcher (Windows-safe, no shell scripts)
// Requires a prior build: cd dashboard && npm run build
const { spawn } = require('child_process');
const path = require('path');

const next = spawn(
  process.execPath,
  [path.join(__dirname, 'node_modules/next/dist/bin/next'), 'start'],
  { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3000' } },
);

next.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT',  () => next.kill('SIGINT'));
process.on('SIGTERM', () => next.kill('SIGTERM'));
