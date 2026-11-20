# Operations

[← Documentation index](README.md)

## CLI

| Command | Purpose |
|---|---|
| `nexuscrew` | Start or reuse the background runtime and print status |
| `nexuscrew init` | Initialize missing stores idempotently |
| `nexuscrew show` | Open the authenticated PWA |
| `nexuscrew show token` | Print the authenticated link |
| `nexuscrew status` | Show service, port, role and node status |
| `nexuscrew stop` | Stop NexusCrew and managed tunnels, preserving tmux |
| `nexuscrew restart` | Restart NexusCrew and autostart links, preserving tmux |
| `nexuscrew boot` | Enable startup persistence |
| `nexuscrew boot off` | Disable persistence without stopping the runtime |
| `nexuscrew boot status` | Show whether startup persistence is enabled |
| `nexuscrew autoupdate` | Turn automatic updates on or off (`on`, `off`, `status`) |
| `nexuscrew doctor` | Check Node, PTY, tmux, SSH, service and platform integration |
| `nexuscrew vl-pin` | Register or read the local toolchain pin (Termux, or Linux after a package update) |
| `nexuscrew nodes ...` | Inspect and manage connected nodes |
| `nexuscrew help` | Show public command help |
| `nexuscrew version` | Show the installed version |

`serve`, `fleet-boot`, `mcp` and `identity` (including `identity provision`)
are internal entry points rather than the normal interactive workflow.

## Boot integration

| Platform | Integration |
|---|---|
| Linux | systemd user service |
| macOS | per-user LaunchAgent |
| Android / Termux | detached runtime and optional Termux:Boot script |

Boot starts only cells marked `boot:true`. It is startup persistence, not a
watchdog for the tmux server itself.

Linux services use `KillMode=process` so restarting NexusCrew does not stop the
shared tmux server. Lifecycle commands fail closed when this protection cannot
be verified.

Termux pidfiles include process identity data. If Android reuses a PID under
another app UID, that is not a proof of death: the record stays where it is,
nothing signals the foreign process, and only an attested death — the pid is
gone, the process birth differs, the boot id differs, or the service guard
says so — removes it. The service entry then refuses by name instead of
starting, the lifecycle commands and doctor report the record as unverifiable
rather than stopped, and the auto-updater aborts the restart. The detached
OpenSSH tunnel supervisors judge their own sidecar records: a foreign PID is
not theirs, so at most their stale record is removed and the configured
supervisor restarts, never the foreign process.

## Smoke runs and temporary prefixes

The user service manager (systemd `--user`, launchd) is **per-UID, not
per-HOME**: it resolves `nexuscrew` by name inside the namespace of the
logged-in user. `init` writes the boot definition under the HOME it was given,
so a run against a temporary HOME would otherwise install a definition the
manager never loads while the activation commands still acted on the real
installation -- restarting the production service.

For a smoke run or a throwaway prefix, use one of:

- `nexuscrew serve` -- start the runtime without touching the service manager;
- `nexuscrew init --no-activate` -- write config, token and boot definitions but
  run no service manager command at all.

Without `--no-activate`, `init` reads back which definition the manager has
loaded and skips activation with an explicit warning when that definition is not
the one just written. `nexuscrew restart` from the owning HOME activates it
afterwards.

## Backup and restore

**Settings → Fleet** can export and restore selected cells, system prompts and
reusable engines.

Restore:

- previews conflicts
- supports per-item selection
- reports active cells requiring restart
- stores working directories relative to the target user's home
- requires explicit repair for legacy or foreign absolute paths

Archives contain credential variable names, never credential values, browser
tokens or live tmux state.

## Updates

Global npm installs can follow stable `latest` automatically. NexusCrew:

1. Serializes update attempts.
2. Installs the selected stable version.
3. Verifies the CLI and same-port runtime.
4. Rolls back once to the exact previous version if health checks fail.

It never installs prereleases from `latest` or silently downgrades. Use
`NEXUSCREW_AUTO_UPDATE=0` to disable the scheduler.

## Diagnostics

**Settings → System → Diagnostics** shows a bounded in-memory event buffer for the
local installation or an authorized routed node.

Verbose collection is explicit and expires after 5, 15, 30 or 60 minutes.
Operational warnings and errors remain available while verbose mode is off.
The view supports filtering, pause, autoscroll, copy, JSON export and clear.

Records are structured and redacted before storage. Raw terminal content,
prompts, command lines, environment values, credentials and filesystem paths
are not accepted as diagnostic metadata. Fleet launch failures expose closed
`code` and `phase` values rather than raw stderr.

## Troubleshooting

- **Node older than 18** — upgrade Node before initialization.
- **tmux missing** — install tmux and rerun `nexuscrew`.
- **OpenSSH missing** — install `ssh`; `autossh` remains optional.
- **systemd user service unavailable** — consider
  `loginctl enable-linger "$USER"`.
- **LaunchAgent failure** — inspect `nexuscrew doctor` and the user
  `~/Library/LaunchAgents` permissions.
- **Termux:Boot does not start** — install and open the Android app once.
- **Voice unavailable** — distinguish browser synthesis from optional server
  speech-to-text; see [Notifications](NOTIFICATIONS.md).

## Development

```bash
npm test
npm run build
node bin/nexuscrew.js serve
```

Tests that exercise tmux use private sockets and must never attach to or stop
the operator's tmux server.

## Related guides

- [Installation](INSTALLATION.md)
- [Configuration](CONFIGURATION.md)
- [Security](SECURITY.md)

## Termux: publication without hard links and the service guard

Publication without hard links. Where `link(2)` is denied (the errors EACCES,
EPERM, ENOSYS, ENOTSUP, EXDEV, decided per call and never remembered) the final
name is created exclusively and filled through the same descriptor. That keeps
exclusivity and never overwrites, but a reader may observe an empty or partial
file while the write is in progress and a crash can leave a truncated file
under the final name. Readers refuse such objects (type, owner, mode, size and
content are checked) and nothing repairs or removes them automatically. To
recover a residue: stop the producers, identify the directory and the object,
keep its content and hash, move it to a new quarantine name, then retry. Never
remove by glob or by age. Refusal codes: `PIN_STAGE` (the object could not be
staged), `PIN_REREAD` (the staged or stored object does not match what was
read), `PIN_VERSION` (the flock version is really not recognised), `PIN_EXISTS`
(a pin is already registered and an explicit replace is required), `PIN_WRITE`
(the record could not be published), `PIN_DIR` (the private storage directory
could not be ensured), `PIN_ABSENT` (a pinned source file is missing),
`PIN_MISMATCH` (the pinned bytes are no longer the registered ones),
`PIN_HELPER` (the helper hash does not match the release), `PIN_PREFIX`
(provision only: the requested flock is not in the closed system set on Linux,
or not inside the runtime prefix on Android),
`PIN_UNCOVERED` (the platform is not covered by the local pin) and
`PIN_ATTESTATORE` (the operator identity recorded with the pin is not
acceptable).

After a Linux package update the system flock may no longer match the release
catalog (`PIN_ABSENT`, `PIN_MISMATCH` or `PIN_VERSION`, component `flock`).
Register the local pin to restore vl root claims on that node:
`nexuscrew vl-pin provision --again`. Only the closed system set is accepted
(`/usr/bin/flock`, or `/bin/flock` when it resolves to the same file),
root-owned and not writable by group or others. Removing the pin file revokes
the consent; nothing re-creates it.

Service guard. The service entry takes a lock on `<pid file>.guard/lock`
before it judges the pid file, and holds it until the process exits. Refusals
are named: `GUARD_BUSY` (another service holds it), `GUARD_UNAVAILABLE` (the
`flock` of the Node prefix is missing or unusable), `GUARD_UNSAFE` (the guard
directory or file is not private to the user), `PIDFILE_UNVERIFIABLE` (a record
that cannot be attested: the process is left alone and the file untouched),
`PIDFILE_INVALID`, `PIDFILE_CONFLICT`, `PIDFILE_ALIVE` (the record attests a
running service), `PIDFILE_WRITE` (the new record could not be written). Do
not delete the guard file and do not remove the pid file to get around a
refusal: a record written by an older
version cannot be proven dead by the lock, so after stopping the old service
with the lifecycle commands the safe recovery is a controlled reboot of the
device with the boot launchers disarmed, then moving the old record to a new
quarantine name before the first start. The boot script never removes it.

## Termux: recovering a partial residue (operator procedure)

This is a manual procedure. NexusCrew has no command that removes these
residues, by design: an uncertain object fails closed ("busy / uncertain")
and stays where it is until a person has excluded every possible producer.

When it applies. Where `link(2)` is denied, an object is created under its
final name and then filled. If its creator dies in between, a partial object
remains: a claim object (`<hash>.own`, `<hash>.lease` or `<hash>.reserve` in
the claims directory; refusals `CORRUPT` or `RESERVE`) or the launch writer
lock (`launch-targets/.writer-lock.json`, or `.writer-lock.takeover.json`,
under the files root; reported as an unreadable lock). A reader that finds
such an object never repairs it and never reclaims it on a parse failure.

Do not proceed unless every condition holds.

1. All producers are excluded, not only the creator. The service guard does
   not exclude every claim writer: other launchers, the boot script, an update
   in progress, a second node process of the same user, a cell restarting
   itself can all write these objects. Disarm every launcher and the boot
   integration first (no autostart, no scheduled restart), then stop the
   service and the fleet with the lifecycle commands.
2. The death of the creator is attested, never assumed. Either the creator is
   identified and proven gone (its pid file or lock names a pid and a process
   birth, and the process birth no longer matches or the pid does not exist),
   or the device is rebooted in a controlled way with the autostart disarmed,
   which kills every possible producer. The death of the creator alone does
   not suffice if any other producer could still run.
3. Evidence is kept before anything is moved: record the directory, the file
   name, size, mode, owner, device and inode, the sha256 of the bytes and a
   copy of the bytes to a private place. Look at the object again right before
   moving it: if its identity or hash changed, someone is still writing; stop
   and start over from condition 1.
4. The object is quarantined, never deleted: move that one named object, by
   its exact name, to a new private name inside a private directory of the
   same filesystem (for example `quarantine-<date>` created with mode 0700,
   target name not existing yet). No glob, no age-based cleanup, no recursive
   removal, no overwrite of an existing name.

Afterwards re-arm the launchers, start the service, and verify that the next
launch publishes a complete object. Keep the quarantined copy and the
evidence until the node has run normally; they are the only record of what
the residue contained. If any condition cannot be met, leave the object
where it is and ask for help instead of removing it.
