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

### Reverse-port recovery

For a shared peer, a reverse-port pool is a fixed SSH policy boundary, not a
permission NexusCrew can expand. The application never modifies
`authorized_keys`; a hub operator explicitly grants the three loopback
`permitlisten` entries for a rotatable peer.

Before accepting a pool slot, the hub sends a fresh HMAC challenge to the
specific loopback listener and verifies its instance, generation and port. The
probe never sends the peer bearer credential to an unknown listener. A failed
or unknown listener is quarantined for diagnosis: NexusCrew does not kill SSH
processes or release ports it cannot prove it owns. Removed pools remain
retired, preventing an old SSH key from binding a port reassigned to another
peer.

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

**A paired admin node is trusted as you are. Pair only devices you own.**

A node with the `admin` access preset can create tmux sessions — including a shell — attach to them over
the federated WebSocket and write into them as the user running NexusCrew. It
can define engines and cells, and a custom engine may name an existing
executable with arguments of its choosing: the trust gate checks the binary's
ownership, mode and path, not the intent of its arguments.

Admission is the exception. Minting a pairing invite is not federated: an invite
belongs to the installation that will host the new node, so it is issued there,
locally. A paired node cannot admit a third party on your behalf.

The `user` preset grants event and file-read access, without administrative
operations or ASK replies. The `nexushost` preset grants no cell visibility or
those access rights. Choose the preset on the installation that owns the
resources. An `admin` peer is trusted as you are; the other presets grant less.

Federated ASK creation and closure go only to configured `admin` peers, hop by
hop. Each hub checks its own next peer before forwarding. This rule does not
change generic notifications or the relay of ASK replies.

### Host-only publication

`nexuscrew nodes publish-remote <peer> on --audience <ids>` publishes a remote
peer to an explicit audience of your own operator nodes and nothing else (see
[Connect nodes](NODES.md)). The security properties, each covered by a test:

- **One way.** The check is on the authenticated peer record found by its token,
  never on a header, a query or the visited chain. Audience → peer is allowed;
  peer → anything is refused in the route relay, in the WebSocket upgrade, in
  the topology collector and on every protocol endpoint except the health
  probe.
- **Two locks on the peer's own access.** All grants towards it are zeroed in
  the same save that turns the mode on, and the class gate refuses a host-only
  peer regardless of the grants its record shows. The `user` preset with no
  visible cell does **not** give this: it keeps events, node events and file
  reads granted. Do not use it as an isolation boundary.
- **Re-read, not remembered.** Audience membership and the operator grant are
  read from the store on every call; revoking either, or turning the mode off,
  takes effect on the next request.
- **No Share, no reverse channel.** The mode cannot coexist with Share on the
  same peer, and enabling Share on a published peer is refused before any SSH
  restart is attempted.
- **Not covered:** a stream opened before `off` stays open until it closes (the
  next upgrade is refused), a reader that cannot reach this installation keeps
  its cached view of the peer until its next authoritative answer, and an
  audience member is itself trusted to forward further according to its own
  access rules.

### What the access views show

`nodes inspect`, `nodes access` and the node lists of Settings show, for each
peer, the grants **the resource gate applies** — the stored values, read the way
the gate reads them — together with a label and a *configured* flag. The label
and the flag say how the vector was set (a preset, or a record from before the
grants existed that was never configured); they do not change what is granted.
A record that is not configured but carries a grant is shown with that grant on
and the label `unconfigured`. The event stream is stricter than the resource
gate: it also requires a configured vector. Apply a preset to make a legacy
record explicit.

### Cell scope

A per-node cell scope narrows what one paired node sees and can act on. It is
set locally, on the installation that owns the cells:

```bash
nexuscrew nodes cells <node> all            # default: every cell
nexuscrew nodes cells <node> none           # no cell at all
nexuscrew nodes cells <node> cella-a,cella-b   # exactly these
```

The scope is enforced on the federated request, in one place in front of the
API router, so a listing and an action pass the same predicate. Route targets
are declared in an explicit table rather than inferred, and a federated request
that names a cell or a session on a route missing from that table is refused
rather than allowed — a route added later starts closed, not open. Defining,
editing or importing a cell is refused outright for a scoped node: it must not
be able to create the cell it was not granted. The terminal attach is gated
with the same predicate, and a tmux session that maps to no cell is outside
every scope.

Cell scope limits the cells a peer can reach; the access preset also limits
what it can do. Neither is a sandbox for an executable launched with
administrative authority.

So: do not accept a pairing invite from an installation you do not own, and do
not treat a cell scope as a sandbox for code you do not trust. It is a
reduction of surface between machines that are already yours.

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

Audio Share is a separate backend path for a node with a real speaker. Its
local consent defaults to off and is independent of node Share and visibility;
neither routing control grants permission to make sound. Calls use an
HMAC-proven active Fleet origin, exact node IDs, target-side ACL and rate
limits. Audio groups are local delivery preferences, never an authorization.
See [Audio Share and native TTS](AUDIO_SHARE.md).

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
- [Audio Share and native TTS](AUDIO_SHARE.md)
- [Operations](OPERATIONS.md)
