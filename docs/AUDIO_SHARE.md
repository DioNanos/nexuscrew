# Audio Share and native TTS

[← Documentation index](README.md)

Audio Share lets an authorized Fleet cell ask a **specific node with a real
speaker** to synthesize a short utterance. It is separate from browser spoken
notifications: browser speech remains a visible-and-focused PWA convenience,
while Audio Share is a node-local backend capability.

There is no cloud speech provider, central voice service, browser relay, or
`play arbitrary audio file` command in this feature.

## Consent and routing are separate

Three independent controls must all permit delivery:

1. **Share** publishes a node to the authorized transport topology.
2. **Visibility** controls which peers may route through it.
3. **Audio consent** is local to the node that would make sound, defaults to
   off, and is never mutable through federation.

Turning on Share never grants permission to make a device speak. A target node
also applies its own ACL, `READONLY` state, rate limit, native-adapter
availability and local consent immediately before synthesis.

Configure consent under **Settings → Audio** on the device that owns the
speaker. The panel exposes only redacted capability metadata, an explicit
fixed-text local test, and a local Stop button. Stop remains available in
`READONLY`; speaking does not.

## Exact targets and groups

`nc_speak` accepts one exact 32-character node instance ID. There is no
wildcard, `all`, label or route-name target.

Settings can also save local named groups of up to eight exact node IDs:

- **Primary + failover** is the default. It tries the ordered primary, waits up
  to five seconds for a start acknowledgement, then tries the next endpoint on
  `refused`, `unreachable`, or `unknown`.
- **Fan-out** is explicit. It tries all configured endpoints in parallel.

A group is only an origin-side delivery preference. It cannot override consent,
ACL, liveness, `READONLY`, or a local Stop on any member. A temporarily absent
member remains visible in group editing but is not treated as ready.

## MCP commands

The caller must be an active local Fleet cell. NexusCrew signs the bridge
request with a node-local HMAC and resolves the real tmux/Fleet identity; a UI
bearer token, a request header, or a body field cannot declare a cell identity.

| Tool | Purpose |
|---|---|
| `nc_speak` | Speak to one exact node ID. |
| `nc_speak_status` | Read the caller-scoped receipt for one exact-target utterance. |
| `nc_speak_stop` | Stop an exact-target utterance, or all caller-owned utterances on that target. |
| `nc_speak_group` | Start a local named primary/failover or explicit fan-out group. |
| `nc_speak_group_status` | Read the caller-scoped per-endpoint group receipt. |
| `nc_speak_group_stop` | Prevent later failover candidates and send Stop to endpoints already admitted. |

Text is limited to 320 characters. Receipts intentionally never retain text,
language, voice, binary path, route, secret, or an aggregate success boolean.
Each endpoint is reported independently as:

```text
refused | unreachable | accepted | spoken | unknown
```

`spoken` means only that the native adapter confirmed it started synthesis. It
does **not** prove that a person heard anything: an output sink can be muted,
null, disconnected, or unavailable. `accepted` is transitional; the caller
queries status by immutable utterance ID for later state changes.

## Native platform adapters

| Platform | Preferred native command | Important limitation |
|---|---|---|
| Android / Termux | `termux-tts-speak` | Requires Termux:API and its permissions; Android Doze can suspend the process. |
| macOS | `say` | Requires an active GUI/CoreAudio output path; command success is not an audibility test. |
| Linux | `espeak-ng`, then `spd-say` | Requires a real output sink; a null or headless sink can return exit 0 without sound. |

The implementation probes executable availability without playing sound. It
sends text on stdin whenever the command supports it; `spd-say` is a declared
fallback whose text must be placed in argv. Automatic tests use fakes and do
not claim physical audibility on any platform.

## Safety behavior

- One node serializes its own utterances; normal pending work is bounded.
- A high-urgency utterance may preempt queue order but never bypasses rate
  limits or consent.
- An adapter-start watchdog reports `unknown`, not a fabricated success.
- Remote Stop is scoped by origin and utterance ID. Local Stop is sovereign and
  works without network, hub, credentials, or a running caller.
- Audio receipt and group receipt storage are bounded to 512 records with a
  24-hour TTL.
- An utterance ID cannot be reused between group and single-target commands by
  the same caller while its receipt remains live.

## Local state

All Audio Share state remains local to the node:

| File | Contents |
|---|---|
| `~/.nexuscrew/audio.json` | Closed-schema local audio consent. |
| `~/.nexuscrew/audio-groups.json` | Local named target groups, user-only and atomic. |
| `~/.nexuscrew/audio-bridge.key` | User-only HMAC secret for MCP-to-server origin proof. |

These files are not Fleet credentials, are not federated, and must not be
copied into logs, tickets, or a shared repository.

## Related guides

- [MCP bridge](MCP.md)
- [Notifications](NOTIFICATIONS.md)
- [Connect nodes](NODES.md)
- [Security](SECURITY.md)
