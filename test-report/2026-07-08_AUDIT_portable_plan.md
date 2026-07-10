# Audit NexusCrew Portable Plan

Marker: `nexuscrew-portable-audit:APPROVE:working-tree:rev4-closes-termux-pidfile-lifecycle-and-path-model`

Scope: re-audit pre-implementation rev 4 of:

- `docs/superpowers/specs/2026-07-08-nexuscrew-portable-design.md`
- `docs/superpowers/plans/2026-07-08-nexuscrew-portable.md`

Context:

- Rev 1 report found 2 BLOCKER, 8 major, 3 minor.
- Rev 2 fixed 10/13 and left R1-R4.
- Rev 3 fixed R2-R4 and left R1.1/R1.2.
- Rev 4 was checked specifically against R1.1/R1.2 and new failure modes around Termux `serve --pidfile`.
- This is still a design/plan audit only. No implementation code was changed.

## Verdict

APPROVE. Rev 4 is implementable as a pre-implementation design/plan. The Termux lifecycle now has one coherent process identity model: both manual `start` and Termux:boot use `serve --pidfile`, while Linux/macOS keep service-manager ownership without pidfile. The path model is also explicit: absolute `<nodeBin>` + absolute `<repoRoot>/bin/nexuscrew.js` + `cwd=repoRoot`.

## Rev 4 Verification

| Residual | Status | Evidence |
|---|---|---|
| R1.1 Termux:boot bypasses pidfile | ADDRESSED | Design defines `serve --pidfile` as the only Termux server path. `nexuscrew start` uses nohup `serve --pidfile`; Termux:boot uses foreground `exec ... serve --pidfile`; status/stop use verified pidfile only. Plan T5/T6/T9 test the shared lifecycle. |
| R1.2 Termux relative path | ADDRESSED | Design requires absolute `<nodeBin>` + `<repoRoot>/bin/nexuscrew.js` + `cwd=repoRoot`; plan T5 tests Termux start from a non-repo cwd and T9 asserts the boot script contains the absolute script path. |

## Adversarial Checks

- Concurrent manual start vs boot: acceptable. `serve --pidfile` uses `wx`; one process owns the pidfile and the other must fail cleanly. Plan T6 includes concurrent safety.
- Stale pidfile after crash/SIGKILL: acceptable. `pidfile.js` owns stale removal for dead pids; plan T6 covers stale removal.
- Normal shutdown cleanup: acceptable. `serve --pidfile` registers SIGINT/SIGTERM/exit cleanup.
- PID reuse: acceptable. Stop/status verify `{pid, cmd, startTs}` and explicitly avoid broad process-name kill.
- Linux/mac regression: acceptable. systemd/launchd ExecStart remains `serve` without `--pidfile`, so process ownership stays with the service manager.

## Non-Blocking Note

The document headers still say `Design (rev 3)` and `Implementation Plan (TDD, rev 3)` while the user-facing content is rev 4. This is cosmetic, not a design blocker, but update the headings before committing to avoid audit/history confusion.

## Previously Fixed And Still Accepted

- B1 launchd plist validity and escaped `${homeXml}` log paths.
- B2 config source and VPS3 migration.
- M1 Android/Termux detection.
- M2 escaping strategy and hostile-path test gate.
- M3 no-symlink install and file modes.
- M4 token exclusive create and symlink rejection.
- M5 voice split model.
- M6 command semantics, with Termux now covered by `serve --pidfile`.
- M7 Termux boot script context, logging and best-effort detection.
- M8 prerequisite ordering and dry-run no-write.
- m1 frontend-prebuilt/tagged release trade-off.
- m2 package-lock normalization.
- m3 real parser validators.

