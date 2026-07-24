# Notifications

[← Documentation index](README.md)

NexusCrew can deliver live cell notifications through three independent
surfaces:

1. In-app toasts over the live event stream.
2. Best-effort Web Push when the browser and operating system support it.
3. Optional on-device spoken alerts while the PWA is visible and focused.

## In-app and push delivery

Toasts are the primary live UI signal. Web Push requires browser permission;
on iOS it also requires an installed PWA.

The service worker cannot synthesize speech. A hidden or closed PWA therefore
uses only its normal system-notification path.

Depending on the operating system, a visible toast, Web Push notification and
spoken alert may coexist.

## Spoken alerts

Enable **Settings → System → Read notifications aloud**.

Spoken alerts are:

- off by default
- stored as a browser-local, per-device preference
- available even when server settings are read-only
- synthesized by the device's browser speech engine
- spoken in the current UI language
- never sent to a remote speech service

Enabling speech runs an audible preview. NexusCrew reports success only after
the browser emits both speech start and speech end. A silent, missing or failed
native voice reports **voice unavailable** rather than a false success.

The preview must succeed once per page session, including after a reload.

## Focus and privacy

Speech runs only while the document is visible and has operating-system focus.
Blur, background, opt-out and unmount cancel the current utterance and clear
pending work. Skipped notifications are not replayed when focus returns.

Focus provides one speaker among NexusCrew windows on the same device. Two
separately opted-in devices may both speak when each PWA is visible and
focused; this is intentional.

Credential-shaped values and private home paths are redacted before speech.
Spoken alerts do not replace the toast's accessibility status, so screen-reader
users can keep the feature disabled if their assistive technology already
announces notifications.

## Queue behavior

- Duplicate live frames are suppressed for 60 seconds.
- At most two normal alerts remain pending.
- A high-urgency alert interrupts the current queue.
- A 30-second watchdog cancels a stuck browser utterance and advances.
- Failures are isolated from the event stream and visual toast delivery.

Only new live notification frames are spoken. Persisted questions and previous
events are not replayed.

## Platform notes

| Platform | Expected behavior |
|---|---|
| Chrome / Edge desktop | System voice while the focused PWA is visible |
| Firefox desktop | System voice where Web Speech synthesis is available |
| Safari desktop | System voice while the page is focused |
| Android Chrome | Visible/focused PWA can speak; background uses normal push |
| iOS installed PWA | Visible/focused PWA can speak; lock screen relies on normal push |

Browser and operating-system voice availability remains device-dependent.

## Related guides

- [Configuration](CONFIGURATION.md)
- [Security](SECURITY.md)
