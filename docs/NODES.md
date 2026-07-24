# Connect nodes

[← Documentation index](README.md)

Every NexusCrew installation starts as a local node. Connected nodes use
supervised OpenSSH links; NexusCrew does not replace SSH, generate SSH keys or
edit `authorized_keys`.

## Pair a node

1. On the reachable installation, open **Settings → Nodes → Invite a node**.
2. Provide the OpenSSH target the joining device can use, such as `user@host`
   or a local SSH config alias.
3. On the joining device, paste the complete pairing link in
   **Settings → Nodes** and choose **Test and connect**.
4. If the portable address cannot select the correct key, open
   **Advanced / edit** and use the SSH alias that already works on that device.

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

## Tunnel behavior

NexusCrew creates one supervised `ssh` process for a hub connection and proves
the forwarded TCP endpoint before reporting success. It does not use `autossh`
as a hidden second supervisor.

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

## CLI

```text
nexuscrew nodes list [--json]
nexuscrew nodes inspect <name|nodeId>
nexuscrew nodes edit <name|nodeId> ...
nexuscrew nodes up|down|connect|disconnect <name|nodeId>
nexuscrew nodes restart|reconnect <name|nodeId>
nexuscrew nodes share <name|nodeId> on|off
nexuscrew nodes remove <name|nodeId> --yes
```

Node and deck identities remain owner-qualified across the network. Routed
HTTP and WebSocket requests recheck authorization, hop count and cycle rules.

## Related guides

- [Installation](INSTALLATION.md)
- [Fleet and terminals](FLEET.md)
- [Security](SECURITY.md)
