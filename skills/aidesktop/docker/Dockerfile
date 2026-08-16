# AI Desktop = a webtop base plus Chromium's real sandbox.
#
# WHY A CUSTOM IMAGE
# The upstream webtop image ships Chromium but not `chromium-sandbox`, and the
# container denies unprivileged user namespaces. Result: Chromium has neither
# sandbox mechanism available and refuses to start ("No usable sandbox").
#
# The shortcut would be `--no-sandbox`. It is deliberately not taken here:
# this browser is meant to hold authenticated sessions and visit arbitrary
# sites — exactly the workload the renderer sandbox exists to contain.
#
# CONSEQUENCE for the compose file: the setuid sandbox helper needs to elevate
# privileges, so `no-new-privileges` must NOT be set for this container. That
# is a deliberate trade: give up a weak protection (privilege escalation
# inside a container that is already isolated, where the asset of value — the
# browser profile — belongs to the unprivileged user anyway) to keep a strong
# one (renderer isolation against hostile web content).
FROM lscr.io/linuxserver/webtop:debian-xfce

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium-sandbox socat \
 && rm -rf /var/lib/apt/lists/*

# socat: modern Chrome IGNORES --remote-debugging-address and binds CDP to
# 127.0.0.1 inside the container, so a Docker port mapping alone never
# reaches it. The relay 0.0.0.0:9223 -> 127.0.0.1:9222 is the only bridge,
# and it still only leaves the container through a port you publish to the
# host's own loopback (see docker-compose.example.yml).
