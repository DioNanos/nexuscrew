# Connect nodes

[← Documentation index](README.md)

Every NexusCrew installation starts as a local node. Connected nodes use
supervised OpenSSH links; NexusCrew does not replace SSH, generate SSH keys or
edit `authorized_keys`.

## Pair a node

1. On the installation that will host the new node, open
   **Settings → Nodes → Invite a node**.
2. Provide the OpenSSH target the joining device can use, such as `user@host`
   or a local SSH config alias.
3. On the joining device, paste the complete pairing link in
   **Settings → Nodes** and choose **Test and connect**.
4. If the portable address cannot select the correct key, open
   **Advanced / edit** and use the SSH alias that already works on that device.

An invite belongs to the installation that will host the node, so it is issued
there and nowhere else. Minting one is not a federated operation: a node you are
connected to cannot be asked to admit a further node on your behalf. If you are
on a client and the interface refuses, open NexusCrew on the hub itself.

The pairing payload is not a browser URL. It contains a short-lived, one-time
invite and routing fields, but no SSH private key, provider key or PWA token.

For headless installations, use:

```bash
nexuscrew nodes invite --ssh user@host
nexuscrew nodes pair
nexuscrew nodes join
```

Pair/join reads the one-time payload from stdin so it does not need to appear
in process arguments.

## Where a node's controls live

**Settings → Nodes** lists nodes one per row: name, how it is reached, and what
it sees of the network. Selecting a row opens that node's sheet — a panel at the
side on a wide screen, a sheet rising from the bottom on a narrow one — and
every per-node control lives there: reachability and transport, visibility and
its grants, edit, test, connect or disconnect, remove.

Nothing in the list itself mutates a node. Publishing *this* device, and
inviting a new one, stay outside the list because they are not properties of a
node you are looking at.

## Labels and routes

The human-readable display label is separate from the local route handle. A
route defaults to a readable slug plus a stable node-ID suffix, so multiple
devices reporting `localhost` still receive distinct identities.

Rename an owned node from Settings or a roster; the same canonical label then
appears everywhere without changing route, identity, credentials, Share state
or deck identity.

For a routed node the current installation does not own, Settings offers a
local alias. That alias stays private to the viewing installation and follows
the stable instance identity.

## Private and shared state

Newly joined devices are private by default. Private pairing is administrative
inventory, not operational publication: a private client can remain listed in
Settings while staying absent from routable topology, deck bars and MCP
discovery.

Enabling **Share this device through the selected hub** adds a verified reverse
channel to the existing SSH process. The hub decides whether authorized peers
see the whole network, only the hub or an explicit subset.

Share is stored as desired state:

- Failed activation rolls back to private.
- Deactivation saves private intent first.
- The hub must acknowledge withdrawal before the reverse channel is removed.
- If acknowledgement fails, bounded boot retries reconcile the saved state
  without claiming remote removal completed.

Temporary loss of reachability does not revoke consent. An authorized node
remains visible as stale/offline until an authoritative refresh restores it or
confirms withdrawal.

## Which cells a node may see

Sharing decides whether a node is reachable. A **cell scope** decides how much
of this installation it reaches once it is:

```bash
nexuscrew nodes cells <name|nodeId> all            # default
nexuscrew nodes cells <name|nodeId> none
nexuscrew nodes cells <name|nodeId> Research,Dev
```

The scope is set here, on the installation that owns the cells — never by the
node being scoped, and never over the federation. It applies to what that node
lists (cells, fleet status, sessions) and to what it can act on, including the
terminal attach; a session belonging to no cell is outside every scope.
Switching away from the explicit list clears it, so a cell revoked today does
not come back the next time a list is set.

Within its scope a node keeps full authority. Read the cell scope section of
[Security model](SECURITY.md) before using it as a boundary against anything
you do not trust.

## Tunnel behavior

NexusCrew creates one supervised private `ssh -L` process for a hub connection
and proves the forwarded TCP endpoint before reporting success. It does not use
`autossh` as a hidden second supervisor. A shared peer with a verified
rotatable pool may additionally run a short-lived, per-slot reverse supervisor;
each one has a distinct local target so the hub can prove the exact reverse
slot it reached.

Reverse ports are reserved across active and pending pairings, probed before
use and protected by a persistent uniqueness check. A stale same-name peer or
late collision returns an actionable conflict instead of silently consuming
the invitation.

OpenSSH restrictions still apply. A shared client may need its accepted hub key
to allow the negotiated reverse listener:

```text
permitlisten="127.0.0.1:44002"
```

Use the exact port printed by the tunnel diagnostic.

## Rotatable reverse-port pools

A new shared peer receives a three-port pool with the same base and offsets
`+100` and `+200`. Read the base this installation actually assigned — do not
copy the one below, it is a placeholder — and grant exactly those three ports
**on the hub**, in the `~/.ssh/authorized_keys` entry that the hub accepts from
that device:

```text
permitlisten="127.0.0.1:<BASE>",permitlisten="127.0.0.1:<BASE+100>",permitlisten="127.0.0.1:<BASE+200>"
```

Add those options when you install or update the key. NexusCrew never writes,
widens, removes, or otherwise edits `authorized_keys`. A legacy peer with only
one `permitlisten` remains usable, but is reported as not rotatable until the
operator installs its full pool.

The direction is worth stating plainly, because getting it backwards sends you
looking where nothing is wrong: **the device asks for the reverse bind, the
hub's sshd grants or refuses it.** Nothing needs changing on the device — the
grant lives on the hub, in the entry carrying that device's key.

**Re-pairing a device changes its base.** Pool bases are monotonic and a
removed peer retires its own, so a device paired again is assigned a new one
while its key still carries the previous grant. Nothing warns you: the pairing
succeeds, the private `-L` works, the device looks connected — and Share alone
fails, because it is the only operation that needs the reverse channel. The
symptom is `share-channel-not-ready` with HTTP 409, and no amount of re-pairing
fixes it, because pairing is not what is broken.

The hub records every refusal it issues as a `SHARE_CHANNEL_REFUSED`
diagnostic, naming the peer, the typed failure code and **the port it probed**.
Read it in the Diagnostics view of the PWA. Confirm the cause on the hub with
`journalctl -u ssh` or `auth.log`:

```text
Received request ... to remote forward to host 127.0.0.1 port <BASE>, but the request was denied
```

That line names the exact port SSH policy is refusing. Grant that port on that
key, and remove any grant pointing at a base that now belongs to another peer:
one key must never hold a listen right on another peer's pool.

Rotation is deliberately narrow:

- The peer proposes a pre-authorized slot over its existing private `-L`; the
  hub alone assigns the lease and generation.
- Every slot is proven over a slot-specific local endpoint before automatic
  rotation is allowed. A generic SSH failure or a missing grant stops the
  episode after one candidate instead of consuming the pool.
- A verified collision can switch to one ready slot at most once every ten
  minutes. The old slot drains briefly; an unproven or unattributable listener
  is quarantined and reported, never terminated automatically.
- Pool bases are monotonic. Removing a peer retires its base so a key that
  still has old `permitlisten` rights cannot claim a later peer's port.

If the pool is exhausted, degraded, unverified, or not configured, NexusCrew
does not guess a new port or change SSH policy. Correct the displayed
`permitlisten` line, then retry Share from the device.

## CLI

```text
nexuscrew nodes list [--json]
nexuscrew nodes inspect <name|nodeId>
nexuscrew nodes edit <name|nodeId> ...
nexuscrew nodes test                    # every peer, plus what is only claimed
nexuscrew nodes up|down|connect|disconnect <name|nodeId>
nexuscrew nodes restart|reconnect <name|nodeId>
nexuscrew nodes share <name|nodeId> on|off
nexuscrew nodes cells <name|nodeId> all|none|Cell1,Cell2
nexuscrew nodes remove <name|nodeId> --yes
```

Node and deck identities remain owner-qualified across the network. Routed
HTTP and WebSocket requests recheck authorization, hop count and cycle rules.

## Related guides

- [Installation](INSTALLATION.md)
- [Fleet and terminals](FLEET.md)
- [Security](SECURITY.md)
