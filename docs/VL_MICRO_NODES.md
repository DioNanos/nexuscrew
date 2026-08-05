# VL micro-device nodes

[← Documentation index](README.md)

NexusCrew can pair one native VL identity on a constrained device without
turning that device into a tmux host. The first target is Nokia N900 / Maemo 5.
The protocol is `vl-node/1`, outbound-only and independent from Fleet PTYs.

## Security and state

- Pairing uses a one-time 256-bit invite with a 30–3600 second TTL.
- NexusCrew persists only SHA-256 hashes of invites and node credentials in a
  mode-0600 atomic store. The plaintext node credential is returned once.
- One stable 128-bit device identity can have one pairing. Re-pair requires an
  explicit revoke or authenticated device unpair.
- Device endpoints accept only the one-time invite or their scoped credential.
  Operator endpoints require the existing local UI auth, and are not federated
  (see Federation).
- `NEXUSCREW_READONLY=1` blocks invites, commands and revokes.
- The bridge has no shell command, PTY adapter or persistent command queue.

## Exact online and completion semantics

A device is online only while the in-memory broker has a live long poll or one
in-flight command observed in the last 45 seconds. A process record or old
heartbeat is not enough. The broker permits one in-flight command.

An operator command returns HTTP 202 and `status:submitted` only after delivery
to a live poll. That receipt is transport evidence, not completion. Completion
requires the same command ID in `lastAck` with `ok`, `error` or `rejected`.
Nothing is queued for an offline device.

`unpair` is the terminal exception: the device first sends its `ok` ACK, then
calls the authenticated revoke endpoint and clears its local binding. The
paired node consequently disappears from `nc_vl_nodes`; that disappearance is
the durable completion proof because the ACK row is removed with the pairing.

A new session for the same identity supersedes the old poll. If a command was
delivery-unknown, the broker records a `stale-session` error instead of replaying
it into the fresh session.

## MCP workflow

The NexusCrew MCP bridge exposes four specific tools:

| Tool | Purpose |
|---|---|
| `nc_vl_nodes` | List the local owner's VL nodes (remote owners are not reachable — see Federation) |
| `nc_vl_invite` | Create one owner-bound, one-time invite |
| `nc_vl_command` | Deliver one exact bounded command to an online node |
| `nc_vl_revoke` | Explicitly revoke one owner-qualified pairing |

Mutation tools require the MCP caller to be an active local Fleet cell. Always
call `nc_vl_nodes` immediately before a command and use its full ID:
`<instanceId>:VL-<32-hex-node-id>`. A linked node can reach only owners present
in its current authorized topology. A stale or revoked owner disappears; it is
not guessed from cached routes.

The exact command allowlist is: `status`, `health`, `start`, `stop`, `restart`,
`version`, `capabilities`, `logs`, `update_candidate`, and `unpair`. `logs` is
bounded to 1–100 redacted records. An update candidate is bounded to 2.5 MiB,
hash verified and staged only; the protocol cannot activate it.

## HTTP surface

Device-scoped endpoints, mounted before UI bearer auth:

- `POST /vl-node/v1/pair`
- `POST /vl-node/v1/poll`
- `POST /vl-node/v1/unpair`

Operator endpoints, behind the local UI auth, **local only**:

- `GET /api/vl-nodes`
- `POST /api/vl-nodes/invite`
- `POST /api/vl-nodes/:nodeId/commands`
- `DELETE /api/vl-nodes/:nodeId`

## Federation

**Hydra exposes none of these.** They were on the federation allowlist while
this bridge was being written and were removed before it shipped: an operator
reaches VL nodes on the machine that owns them, never through a peer.

The one that decides is `commands`. Among the commands a node accepts there is
`update_candidate`, which names the URL the device downloads its own update
from, and it accepts `http:`. The `sha256` field guarantees nothing there,
because the sender supplies both the URL and the hash. Federated, that lets a
paired peer install an arbitrary binary on a device it does not own, while the
owner neither acts nor knows.

A paired node is otherwise trusted as its owner, and that is deliberate. This
capability is different in kind — the same reason `/settings/peering/invite`
left the allowlist on 2026-08-04. Denied by default; it can be federated the
day the update channel is bound to something the receiving owner controls.

So `nc_vl_nodes` reports remote owners as `policy-denied`, not as unreachable:
nothing is broken, the route is closed on purpose.
