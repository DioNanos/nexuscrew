# Installation

[← Documentation index](README.md)

## Requirements

- Node.js 18 or newer
- tmux 3.4 or newer
- OpenSSH client (`ssh`)
- Linux x64/ARM64, macOS x64/ARM64, or Android ARM64 through Termux

NexusCrew ships scriptless PTY prebuilds for the supported targets. A normal
global install does not need a compiler or native install-script approval.

## Linux

Install Node.js, tmux and OpenSSH with your distribution package manager, then:

```bash
npm install -g @mmmbuto/nexuscrew
nexuscrew
```

NexusCrew uses a systemd user service when it is available. If user services
cannot survive logout, enable lingering for your account:

```bash
loginctl enable-linger "$USER"
```

## macOS

```bash
brew install node tmux
npm install -g @mmmbuto/nexuscrew
nexuscrew
```

NexusCrew installs a per-user LaunchAgent. It does not require a system daemon.

## Android / Termux

```bash
pkg update
pkg install nodejs-lts tmux openssh
npm install -g @mmmbuto/nexuscrew
nexuscrew
```

Optional boot persistence uses the Termux:Boot app. Install and open that app
once before enabling boot from NexusCrew.

On Android, `nexuscrew doctor` also verifies the Termux execution bridge.
NexusCrew carries forward only a validated `libtermux-exec` preload from the
active Termux prefix. Package upgrades repair enabled Termux:Boot scripts so
they do not launch from a replaceable npm directory.

## First run

The first `nexuscrew` command:

1. Creates the local configuration and bearer token.
2. Selects a free loopback port, preferring `41820`.
3. Installs the platform background integration.
4. Starts NexusCrew without replacing or stopping tmux.
5. Opens the authenticated PWA and setup wizard.

Later runs reuse the configured service, print a compact status and exit.

Use `nexuscrew show` to open the PWA again, or `nexuscrew show token` to print
the authenticated link without opening a browser.

## Verify

```bash
nexuscrew status
nexuscrew doctor
nexuscrew version
```

A missing OpenSSH client is a blocking diagnostic. `autossh` is optional;
NexusCrew supervises OpenSSH directly.

## Remote access

NexusCrew listens only on loopback. Bring the remote loopback port to your
device through SSH or a VPN you control:

```bash
ssh -L 41820:127.0.0.1:41820 user@your-host
```

Use the port shown by `nexuscrew status`, then open the link returned by
`nexuscrew show token`. Do not expose NexusCrew through a public listener.

## Update

```bash
npm install -g @mmmbuto/nexuscrew@latest
nexuscrew restart
nexuscrew doctor
```

The built-in updater can follow the stable npm `latest` tag automatically. It
serializes updates, verifies the new CLI and same-port runtime, and rolls back
once to the exact previous version if health checks fail. Disable its scheduler
with `NEXUSCREW_AUTO_UPDATE=0`.

## Install from source

Use a release tag rather than a moving branch:

```bash
git clone https://github.com/DioNanos/nexuscrew.git
cd nexuscrew
git checkout vX.Y.Z
npm ci --omit=dev
node bin/nexuscrew.js
```

The repository includes the prebuilt frontend in `frontend/dist`. Rebuilding
the PWA is only needed for development.

## Next

- [Configure the runtime](CONFIGURATION.md)
- [Connect another node](NODES.md)
- [Learn the operational CLI](OPERATIONS.md)
