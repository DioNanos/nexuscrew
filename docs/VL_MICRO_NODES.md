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
  Operator endpoints require the local UI auth or the federation ACL.
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
| `nc_vl_nodes` | Aggregate authorized local/routed VL owners and nodes |
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

Operator endpoints, behind UI/federation auth:

- `GET /api/vl-nodes`
- `POST /api/vl-nodes/invite`
- `POST /api/vl-nodes/:nodeId/commands`
- `DELETE /api/vl-nodes/:nodeId`

## Federation

**These four are federated, like every other resource.** Where you connect, you
see everything: that is how NexusCrew works, and VL nodes are its arms. An
operator reaches a node from any authorized peer, not only from the machine
that owns it. Hydra still exposes those exact resources and methods — federating
a resource does not federate every verb.

They were briefly removed on 2026-08-05 and put back the same day. The removal
was meant to contain `update_candidate`, which names the URL a device fetches
its own update from and accepts `http:` — and whose `sha256` binds nothing,
because the sender supplies both the URL and the hash. It was the wrong place
for that fix, on two counts that do not carry equal weight.

**Incoherent, always.** A paired node is trusted as its owner
(`docs/SECURITY.md`); singling out VL nodes made them the only unfederated
resource inside their own control plane.

**Ineffective, but only where fleet is available.** `/fleet/define-engine`,
`/fleet/define-cell` and `/fleet/up` are federated, and a managed shell engine
carrying a raw `commands[shell]` resolves to `bash -lic "<raw>"`: a peer can
already run anything on the host, including a local call to these endpoints. But
VL is orthogonal to fleet — on an owner with VL enabled and `/fleet/*`
unavailable, that path does not exist and federating these four **does** add
capability. It stays inside the trust model, so it is not a violation; it is
simply not free. Do not restate "it grants nothing" without that condition.

**`update_candidate` remains a real defect**, and it belongs to the command:
bind the update channel to something the receiving owner controls. Denying the
route only hid it.
