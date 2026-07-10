# Audit NexusCrew Portable Implementation

Marker: `nexuscrew-portable-audit-impl:APPROVE:842e31d:post-fix-implementation-closes-service-token-systemd-and-temp-cleanup-findings`

Scope: re-audit implementation post-fix on branch `portable` at `842e31d`.

Files rechecked:

- `lib/cli/service.js`
- `lib/cli/init.js`
- `lib/auth/token.js`
- `tests/service.test.js`
- `tests/init.test.js`
- `tests/token.test.js`

Verification run:

- `npm test` -> 126 pass / 0 fail / 1 skip.

## Verdict

APPROVE. The four findings from the implementation audit at `e0fe2c0` are closed at `842e31d`.

## Fix Verification

| Finding | Status | Evidence |
|---|---|---|
| M1 service activation failures hidden | ADDRESSED | `installService()` now returns `failures[]` instead of swallowing `systemctl`/`launchctl` errors; `runInit()` emits `WARN: ... activation fallita` with failed commands. Tests cover throwing `execImpl` and init warning. |
| M2 token EEXIST symlink race | ADDRESSED | `readTokenSafe()` uses `lstat`, rejects symlinks, and is used in the `EEXIST` branch before reading an existing token. Tests cover regular safe read and symlink rejection. |
| M3 systemd hostile-path gap | ADDRESSED | `assertSystemdSafe()` rejects characters the current systemd template cannot represent safely (`"`, `$`, `;`, backtick, newline, apostrophe) with a clear error, while allowing spaces and `%`. `systemd-analyze verify` now fails the test when available instead of being ignored. |
| m1 temp cleanup on install failure | ADDRESSED | Temp write/chmod/rename is wrapped in cleanup logic; tests inject write failure and assert no temp residue. |

## Adversarial Checks

- `failures[]` shape is consistent enough for callers: dry-run returns `failures: []`; full install returns command failure objects; `runInit()` handles non-empty failures visibly.
- The systemd path restriction is conservative but acceptable. It rejects legal Unix path characters, but only for Linux service generation where the current template cannot safely encode them. The error is explicit and avoids writing a broken unit.
- `readTokenSafe()` is design-level race-safe for the previous finding: the `EEXIST` branch no longer follows symlinks blindly. A fully kernel-level no-follow read would require an `open`/`O_NOFOLLOW` style implementation, but that is beyond the existing lstat-based design and not required to approve this private line.
- Temp cleanup covers write/chmod/rename failures because the whole temp-file critical section is inside the same `try/catch`.

## Previously Confirmed OK

- Loopback fail-closed remains intact via `assertLoopback`.
- Bearer gate covers all `/api/*`, including `/api/voice/status`.
- File exchange anti-traversal and anti-symlink behavior remains covered.
- `serve --pidfile` lifecycle is coherent for Termux start and Termux:boot.
- Config precedence is `defaults < config.json < env < opts`.
- Voice graceful behavior and frontend mic split are implemented.
- VPS3 URL-fragment token persistence remains an owner-accepted local/tunnel trade-off for this private line.

