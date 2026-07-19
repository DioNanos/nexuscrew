---
name: alibaba-token-media
description: "Generate or edit images with Wan 2.7 and create videos with HappyHorse through an Alibaba Qwen Cloud Token Plan Individual subscription. Use when the user asks Claude Code, Codex, Codex-VL, or Pi to draw, generate, or edit an image with wan2.7-image or wan2.7-image-pro; create text-to-video or image-to-video media with happyhorse-1.1-t2v or happyhorse-1.1-i2v; inspect a submitted HappyHorse task; or validate the Token Plan media setup. Do not use this skill for chat, visual understanding, batch automation, backend services, or pay-as-you-go DashScope APIs."
---

# Alibaba Token Media

Use the bundled, dependency-free CLI to access only the media models included
in Alibaba Token Plan Individual Lite. The same skill and Python script work
with Claude Code, Codex, Codex-VL, and Pi. Invoke the script directly from Pi;
do not assume that Pi provides a native MCP client.

Keep this workflow interactive. Every generation consumes plan Credits, and
the plan is not for unattended batch or backend workloads.

## Safety contract

- Read the credential only from `ALIBABA_CODE_API_KEY`. Never request it in
  chat, pass it on the command line, print it, persist it, or send it through
  an agent bus.
- Use only the fixed Token Plan host and exact model allowlist implemented by
  the script. Never fall back to DashScope pay-as-you-go endpoints.
- Run `status` and then a `--dry-run` before the first real request in a
  session. Dry runs never require or reveal the key.
- Show the user the normalized model, operation, size or duration, resolution,
  and confirmation flags before spending Credits. A real image request needs
  `--confirm-credit-use`; a real video request additionally needs
  `--confirm-expensive`.
- Require `--confirm-high-cost` for Wan Pro, 2K or 4K images, 1080P video, or
  video longer than five seconds. Keep Lite defaults at one 1K base image or
  one 720P three-second video.
- Never batch, enable sequential image sets, retry a generation POST
  automatically, or run more than one generation submit concurrently. A task
  status GET may be retried, but never with a tight polling loop.
- Accept local input only as a regular, non-symlink JPEG, PNG, BMP, or WEBP
  file below 20 MiB and under the current user's home. Accept remote input only
  over public HTTPS; reject localhost, private IP literals, credentials, and
  non-standard ports.
- Download signed result URLs immediately. Never paste signed URLs into chat,
  logs, source files, or an agent bus; they expire after 24 hours.

## Locate the CLI

Resolve `scripts/alibaba_token_media.py` relative to this `SKILL.md`, then run
it with Python 3:

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py status
```

Keep this packaged skill as the source of truth; do not copy the script into a
project before using it.

## Generate or edit an image

Start with a sanitized preview:

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py image \
  --prompt "A quiet alpine lake at sunrise" \
  --dry-run
```

After explicit approval, repeat without `--dry-run` and add
`--confirm-credit-use`. For an edit, add one to nine `--image` values. Each
value may be a permitted local image under the current user's home or a public
HTTPS URL:

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py image \
  --prompt "Preserve the subject; replace the background with a night city" \
  --image /absolute/path/input.png \
  --confirm-credit-use
```

Use `--model wan2.7-image-pro --size 2K --confirm-high-cost` only after the
user selects that higher-cost variant. `4K` is allowed only for Pro
text-to-image with no input images. The script fixes `n=1` and disables image
sets.

## Submit a video

Text-to-video Lite preview:

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py video-submit \
  --prompt "A paper model city slowly lights up at dusk" \
  --dry-run
```

For a real request, add both `--confirm-credit-use` and
`--confirm-expensive`. For image-to-video, select `happyhorse-1.1-i2v` and
supply exactly one first-frame image with `--image`. Do not supply `--ratio`
for image-to-video; its aspect ratio follows the input.

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py video-submit \
  --model happyhorse-1.1-i2v \
  --image /absolute/path/first-frame.png \
  --prompt "The camera slowly moves forward" \
  --confirm-credit-use --confirm-expensive
```

Return the task ID after a real submit. Do not hide submission success behind
polling.

## Check and download a video

Query a task once:

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py video-status <task-id>
```

When it is `SUCCEEDED`, repeat with `--download`. If recurring monitoring is
requested and the client exposes a loop facility, use an interval of at least
five minutes. Do not implement a private tight polling loop.

```bash
python3 <skill-dir>/scripts/alibaba_token_media.py video-status <task-id> \
  --download
```

Default downloads go to
`~/Downloads/alibaba-token-plan/YYYY-MM-DD/` with unique names and no
overwrite. An explicit `--output` must remain under the current user's home.

## Reference

Read [references/api-contract.md](references/api-contract.md) before changing
payloads, limits, endpoints, or model handling.
