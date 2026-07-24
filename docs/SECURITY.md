# Security model

[← Documentation index](README.md)

NexusCrew is local-first and fail-closed. It has no hosted control plane,
required account or supported public-listener mode.

## Network boundary

NexusCrew binds only to `127.0.0.1`. Non-loopback binds are rejected.

To reach a remote installation, carry its loopback port through SSH or a VPN
you control:

```bash
ssh -L 41820:127.0.0.1:41820 user@your-host
```

Direct public exposure through a reverse proxy, public port forward or network
bind is not supported.

## Browser authentication

Every API and WebSocket connection requires the local bearer token. The token
is stored in a user-only file and passed to the browser in the URL fragment:

```text
http://127.0.0.1:41820/#token=...
```

Fragments are not sent in the initial HTTP request or written to server access
logs. Treat the complete link as a credential and do not open it on a shared
device.

## Session and transport authority

- tmux remains the session authority.
- OpenSSH remains the network and identity authority.
- NexusCrew supervises SSH but does not create keys or edit
  `authorized_keys`.
- Node and deck identities remain owner-qualified.
- Routed HTTP and WebSocket requests recheck ACL, hop count and cycle rules.

## Provider credentials

Provider keys are resolved only on the node launching the process. NexusCrew
can use its service environment, compatible user-owned provider files or an
optional node-local write-only store.

Credential values are excluded from:

- Fleet cell and engine definitions
- backups
- API and status responses
- tmux state
- process arguments
- temporary files
- diagnostics and logs

The PWA reports only whether a required variable is configured. Replacement
values are transient in the browser and are written only to the selected
node's credential store.

## Files

Per-session file exchange is scoped under `~/NexusFiles/<session>`. Upload and
download operations reject traversal and symlink escapes.

Clipboard images and dropped files are stored in the selected session inbox;
their path is inserted into the terminal without automatically pressing Enter.

## Pairing and sharing

Pairing links contain a short-lived one-time invite and routing data, but no
SSH private key, provider key or PWA token.

Newly paired nodes are private by default. Sharing is explicit desired state
and uses a verified reverse channel in the supervised SSH process. Revocation
is saved locally before the hub is asked to withdraw the node; the UI does not
claim remote removal until acknowledgement.

## Diagnostics and speech

Diagnostics accept structured, bounded metadata and reject raw terminal
content, prompts, command lines, environment values, credentials and private
paths.

Optional spoken notifications use the browser's device-local speech engine.
Credential-shaped values and private home paths are redacted before speech;
notification text is not sent to a speech service.

## Updates and process safety

Stable updates verify the new CLI and same-port runtime, and roll back once to
the exact previous version on failure. tmux sessions remain outside the
service process group.

Termux process handling verifies process identity before sending a signal.
Android PID reuse under another app UID is treated as a stale pidfile, never as
permission to signal the foreign process.

## Report a security issue

Do not include live tokens, credentials, private keys or complete authenticated
links in a public issue. Use the repository's private security-reporting
channel when available.

## Related guides

- [Connect nodes](NODES.md)
- [Configuration](CONFIGURATION.md)
- [Notifications](NOTIFICATIONS.md)
- [Operations](OPERATIONS.md)
