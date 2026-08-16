# AI Desktop = a webtop base plus the one thing the base is missing: a way to
# reach Chrome DevTools Protocol from outside the container.
#
# WHAT THIS IMAGE DELIBERATELY DOES NOT DO
# It does not try to give the browser its own sandbox. That is a decision, not
# an omission, and it was made after measuring — see ../SKILL.md, "Where the
# boundary is". In short: inside this container the browser's own sandbox
# cannot start (setuid helper blocked by no-new-privileges, unprivileged user
# namespaces denied), and the changes that would let it start are exactly the
# ones that weaken the container — the boundary that actually holds here.
FROM lscr.io/linuxserver/webtop:debian-xfce

RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/*

# socat: modern Chrome IGNORES --remote-debugging-address and binds CDP to
# 127.0.0.1 inside the container, so a Docker port mapping alone never
# reaches it. The relay 0.0.0.0:9223 -> 127.0.0.1:9222 is the only bridge,
# and it still only leaves the container through a port you publish to the
# host's own loopback (see docker-compose.example.yml).
