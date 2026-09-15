#!/usr/bin/env bash
# Long-running entrypoint for a scraper-<platform> container.
#
# Starts a virtual display explicitly (xvfb-run proved unreliable under detached
# Docker — didn't keep the child alive or pass stdout to `docker logs`), waits
# until the X socket is actually ready (a fixed `sleep` raced Chrome ahead of
# Xvfb), then supervises BOTH Xvfb and node. If either dies the script exits
# non-zero so Docker's `restart: unless-stopped` brings the container back with
# a fresh display — the previous version `exec`ed node and left Xvfb
# unsupervised, so when Xvfb crashed Chrome got "Missing X server" forever.
set -uo pipefail

export DISPLAY=:99

start_xvfb() {
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
}
start_xvfb

# Wait for the display socket to exist (up to ~10s) before launching node —
# scrapers call chromium with headless:false and need a live display.
for _ in $(seq 1 20); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.5
done
if [ ! -S /tmp/.X11-unix/X99 ]; then
  echo "[scraper-run] Xvfb failed to create display :99 — see /tmp/xvfb.log" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi
echo "[scraper-run] Xvfb ready on :99 (pid $XVFB_PID)"

# Expose the same display over noVNC as scraper-login.sh's one-off flow does —
# persistently this time, not just during that separate login-only container
# run. Without this, a 'login' job's Chrome window renders into Xvfb with
# nothing anywhere able to see or interact with it: the queue worker runs
# inside THIS long-running container, not the separate `docker compose run
# --rm ... scraper-login.sh` instance, so that script's noVNC never covered
# this path. Host port varies per platform (see docker-compose.yml); the
# in-container port is always 6080.
echo "[scraper-run] starting x11vnc"
x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!

echo "[scraper-run] starting noVNC (websockify) on :6080"
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

# Clear any stale Chrome singleton lock left in the profile volume by a prior
# container (esp. the noVNC login `docker compose run --rm`, which exits without
# releasing it). Without this, launchPersistentContext fails with "profile
# appears to be in use by another Chromium process on another computer".
PROFILE="/root/.${SCRAPER_PLATFORM:-}-scraper-profile"
if [ -n "${SCRAPER_PLATFORM:-}" ] && [ -d "$PROFILE" ]; then
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket" 2>/dev/null || true
fi

node -r ts-node/register src/scraper-runtime/scraper-entry.ts &
NODE_PID=$!

shutdown() { kill "$NODE_PID" "$XVFB_PID" "$X11VNC_PID" "$WEBSOCKIFY_PID" 2>/dev/null || true; exit 0; }
trap shutdown SIGTERM SIGINT

# Supervise: if EITHER Xvfb or node dies, tear down so the restart policy gives
# us a clean container (fresh Xvfb + fresh node) rather than a wedged
# half-alive one. x11vnc/websockify are NOT part of this check — losing the
# viewer doesn't affect the scraper's own ability to work, only a human's
# ability to watch it; Docker's restart policy would be overkill for that.
while kill -0 "$XVFB_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 5
done

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[scraper-run] Xvfb (pid $XVFB_PID) died — restarting container" >&2
fi
kill "$NODE_PID" "$XVFB_PID" "$X11VNC_PID" "$WEBSOCKIFY_PID" 2>/dev/null || true
exit 1
