#!/usr/bin/env bash
# Interactive login for a scraper-<platform> container. Starts a virtual
# display, exposes it over noVNC in the browser, and runs the platform's
# persistent-profile login script. Log in through the noVNC window; the login
# script auto-detects the session cookie and exits, leaving the session in the
# platform's profile volume.
#
# Usage (from the repo root, with the stack up):
#   docker compose run --rm -p 6080:6080 scraper-xhs /app/docker/scraper-login.sh
#   → open http://localhost:6080/vnc.html  (click Connect), log in, done.
#
# SCRAPER_PLATFORM is already set on the service (xhs/tiktok/instagram/twitter),
# so the matching `npm run <platform>:login` is chosen automatically.
set -euo pipefail

PLATFORM="${SCRAPER_PLATFORM:?SCRAPER_PLATFORM must be set}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"

echo "[login] starting Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 &
sleep 2

echo "[login] starting x11vnc"
x11vnc -display "${DISPLAY}" -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
sleep 1

echo "[login] starting noVNC (websockify) on :6080"
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
sleep 1

# Clear any stale Chrome singleton lock left in the profile volume by a prior
# container (e.g. an earlier `docker compose run --rm` login or run that
# didn't exit cleanly) — without this, launchPersistentContext fails with
# "profile appears to be in use by another Chromium process on another
# computer". Same guard as scraper-run.sh's, needed here too since login is
# often the very first thing run against a fresh/reused profile volume.
PROFILE="/root/.${PLATFORM}-scraper-profile"
if [ -d "$PROFILE" ]; then
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket" 2>/dev/null || true
fi

echo "[login] ➜ open http://localhost:6080/vnc.html then log into ${PLATFORM}"
npm run "${PLATFORM}:login"
