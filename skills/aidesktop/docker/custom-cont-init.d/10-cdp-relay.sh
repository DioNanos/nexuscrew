#!/bin/bash
# Runs at every container start, as root, BEFORE the desktop session starts.
#
# 1) Orphaned profile locks: if the container dies while Chromium is still
#    running, Singleton{Lock,Cookie,Socket} files are left behind pointing at
#    a dead pid, and Chromium then REFUSES to start on the next boot.
#    Observed symptom: autostart present, zero processes, no visible error.
#    It is safe to remove them here: the desktop session has not started yet,
#    so no browser can possibly be alive.
rm -f /config/browser-profile/Singleton* 2>/dev/null || true

# 2) CDP relay: modern Chrome ignores --remote-debugging-address and binds
#    DevTools to 127.0.0.1 inside the container, unreachable through a Docker
#    port mapping. socat bridges it. What leaves the container through this
#    port still only reaches the host's own loopback — see the port mapping
#    in docker-compose.example.yml.
pkill -f "TCP-LISTEN:9223" 2>/dev/null || true
nohup socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 >/dev/null 2>&1 &

echo "[cdp-relay] stale profile locks cleared; socat 9223 -> 9222 started"
