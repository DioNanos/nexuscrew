# AI Desktop = a webtop base, plus what it takes to attempt a real sandbox
# for the browser inside it (NOT confirmed working as shipped — see below and
# ../SKILL.md's "The sandbox: installed, but not engaged").
#
# WHY A CUSTOM IMAGE
# The upstream webtop image does not install Chromium's setuid sandbox helper
# on its own; this Dockerfile puts it there. That line is NECESSARY for a
# real sandbox but not SUFFICIENT: the base image launches Chromium through a
# wrapper that hardcodes --no-sandbox regardless, so the helper this line
# installs sits unused unless that wrapper is also overridden — which this
# recipe does not yet do. Read the full explanation before assuming this
# container's browser is sandboxed; as shipped, it is not confirmed to be.
FROM lscr.io/linuxserver/webtop:debian-xfce

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium-sandbox socat \
 && rm -rf /var/lib/apt/lists/*

# socat: modern Chrome IGNORES --remote-debugging-address and binds CDP to
# 127.0.0.1 inside the container, so a Docker port mapping alone never
# reaches it. The relay 0.0.0.0:9223 -> 127.0.0.1:9222 is the only bridge,
# and it still only leaves the container through a port you publish to the
# host's own loopback (see docker-compose.example.yml).
