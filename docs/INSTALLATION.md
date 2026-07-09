# NexusCrew Installation Guide (portable)

Branch `portable` — installazione privata su Termux / Linux / Mac via `git clone` + `nexuscrew init`.
Nessuna pubblicazione npm pubblica. Bind loopback `127.0.0.1`, raggiungibile solo via tunnel SSH/VPN.

## Requirements

- `tmux` (su PATH)
- Node.js `>= 18`
- `git`
- (Mac) niente systemd → launchd
- (Termux) app **Termux:boot** opzionale per l'avvio al reboot

## Install — Termux

```bash
pkg update && pkg install -y tmux nodejs git
git clone https://github.com/DioNanos/nexuscrew.git && cd nexuscrew
npm ci --omit=dev                 # deps runtime (UI prebuilt in frontend/dist)
./bin/nexuscrew.js init           # detect + config + token + service + URL
```

`init` genera `~/.termux/boot/nexuscrew.sh` (se Termux:boot è installato) e stampa l'URL con `#token=`.
Per production: fai checkout di un **tag** (`git checkout v0.6.1-portable`) invece del branch mobile.

## Install — Linux

```bash
sudo apt-get install -y tmux nodejs git   # o equivalente distro
git clone https://github.com/DioNanos/nexuscrew.git && cd nexuscrew
npm ci --omit=dev
./bin/nexuscrew.js init          # genera ~/.config/systemd/user/nexuscrew.service
```

Se `systemctl --user` fallisce: `loginctl enable-linger $USER` (servizi user al boot).

## Install — macOS

```bash
brew install tmux node git
git clone https://github.com/DioNanos/nexuscrew.git && cd nexuscrew
npm ci --omit=dev
./bin/nexuscrew.js init          # genera ~/Library/LaunchAgents/com.mmmbuto.nexuscrew.plist
```

## Frontend prebuilt

`frontend/dist/` è committata sul branch `portable` → il target NON builda Vite (fragile su Termux).
`npm ci --omit=dev` serve solo per le deps runtime/native (express, ws, multer, pty).
Per rigenerare la UI (sviluppo): `npm run build` (richiede dev deps).

## Verify

```bash
./bin/nexuscrew.js status        # platform + service + porta + URL
./bin/nexuscrew.js start         # avvia il servizio (systemctl / launchctl / nohup+pidfile)
./bin/nexuscrew.js stop
```

Apri l'URL stampato da `init` (con `#token=…`) nel browser, via tunnel SSH/VPN:

```bash
ssh -L 41820:127.0.0.1:41820 dag@host    # porta da config.json
```

## First launch

`init` crea (mode 0600 dove sensibile):

- `~/.nexuscrew/config.json` — porta (+ voice opzionale)
- `~/.nexuscrew/token` — bearer token
- `~/.nexuscrew/nexuscrew.pid` — pidfile (Termux / modalità manuale)
- `~/.nexuscrew/nexuscrew.log` — log (Mac/Termux)
- `~/NexusFiles/<sessione>/{inbox,outbox}/` — file exchange
- il service file per-platform

Se `tmux` manca: `init` crea config+token ma NON installa il service (WARN). Installa tmux e ri-runna `init`.

## Update

```bash
cd nexuscrew && git pull --ff-only && npm ci --omit=dev && ./bin/nexuscrew.js init
```

`init` è idempotente: preserva config e token esistenti, rigenera il service, restart controllato
(stessa porta + stesso token; i client WebSocket si riconnettono).
