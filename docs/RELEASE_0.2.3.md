# NexusCrew 0.2.3

Date: 2026-04-09

## Summary

`0.2.3` is the corrected stable release after the refactor shipped in `0.2.2`.

`0.2.2` introduced the right runtime model, but the npm package had invalid CLI `bin` metadata. `0.2.3` fixes that packaging issue and remains the canonical release.

## Included Runtime Changes

- tmux standalone sessions instead of an implicit master tmux session
- real active tmux sessions as chat targets
- explicit tmux creation flow
- runtime-driven launcher discovery
- shell-file detections gated from creation unless runnable
- Termux-compatible install path for SQLite dependency
- home/workspace defaults derived from the runtime user

## Packaging Fix

The published `bin` field is now:

```json
{
  "nexuscrew": "bin/nexuscrew.js"
}
```

## Registry Outcome

- `latest -> 0.2.3`
- `next -> 0.2.3`
- `0.2.2` deprecated
- `0.2.1` deprecated
