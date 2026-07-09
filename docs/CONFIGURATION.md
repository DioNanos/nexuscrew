# NexusCrew Configuration Guide (portable)

## Paths

Stato locale sotto `~/.nexuscrew/`:

- `config.json` — porta + voice (opzionale)
- `token` — bearer token (0600, consegnato in URL `#token=`)
- `nexuscrew.pid` — pidfile (Termux / modalità `--manual`)
- `nexuscrew.log` — log stdout/stderr (Mac launchd, Termux boot)

File exchange: `~/NexusFiles/<sessione>/{inbox,outbox}/` (cartelle create lazy).

## config.json

```json
{
  "port": 41820,
  "voiceUrl": null,
  "voiceTokenFile": null
}
```

Precedence: **defaults < config.json < env**.

- `port` — porta HTTP loopback (default `41820`).
- `voiceUrl` — URL del proxy STT server-side (es. `http://127.0.0.1:3105` per mcp-voice).
  `null` = voice server off (graceful); Web Speech nel browser resta disponibile dove supportato.
- `voiceTokenFile` — path del token voice (letto server-side, mai inviato al browser).

Migrazione da un'installazione esistente (drop-in): `init` migra la porta dal service esistente; voice va configurato
esplicitamente nel config.json (es. `voiceUrl: "http://127.0.0.1:3105"`, `voiceTokenFile: "/opt/mcp-voice/state/http.token"`).

## Env override

Tutti i campi hanno un env che vince su config.json:

- `NEXUSCREW_PORT`
- `NEXUSCREW_TOKEN_FILE`, `NEXUSCREW_PIDFILE`
- `NEXUSCREW_TMUX`
- `NEXUSCREW_FILES_ROOT`, `NEXUSCREW_MAX_UPLOAD_MB`
- `NEXUSCREW_VOICE_URL`, `NEXUSCREW_VOICE_TOKEN`, `NEXUSCREW_VOICE_TOKEN_FILE`
- `NEXUSCREW_CONFIG_FILE` (override path config.json, per test)
- `NEXUSCREW_READONLY=1`

## Voice (split model)

- **Server STT** (`voiceUrl`): proxy verso mcp-voice (whisper-local). Opzionale.
  `GET /api/voice/status` → `{serverSttConfigured: !!voiceUrl}`.
  `POST /api/voice/transcribe` → 503 se `voiceUrl=null` (graceful, non 502).
- **Browser Web Speech**: primario dove supportato (Chrome desktop/Mac). Indipendente dal server.
- Visibilità del microfono nella UI = `('SpeechRecognition' in window) || serverSttConfigured`.
  Se nessuno dei due → mic nascosto.

Matrice:

| Web Speech | server STT | mic |
|---|---|---|
| presente | off | visibile (usa Web Speech) |
| assente | off | nascosto |
| assente | on | visibile (MediaRecorder → server) |

## CLI

```
nexuscrew init [--dry-run] [--port N]   setup: detect + config + token + service + URL
nexuscrew serve [--pidfile]             HTTP server foreground (dev / ExecStart)
nexuscrew start                         avvia il servizio (systemctl / launchctl / nohup+pidfile)
nexuscrew stop                          stop del servizio (service manager / pidfile verificato)
nexuscrew status                        platform + service + porta + URL
```

### Per-platform (start/stop/status)

| Platform | start | stop | status |
|---|---|---|---|
| linux (systemd) | `systemctl --user start` | `systemctl --user stop` | `is-active` |
| mac (launchd) | `launchctl kickstart` | `launchctl kill SIGTERM` | `launchctl print` |
| termux | `nohup serve --pidfile` + wake-lock | kill pidfile verificato + wake-lock-release | boot-script vs pidfile vivo |

Su Termux (niente service manager) il server gira via `serve --pidfile` che gestisce il
lifecycle del pidfile (`{pid, cmd, startTs}`). `stop` verifica `cmd+startTs` prima di
killare (no PID reuse, no broad match by name). `status` distingue "boot script installed"
da "server running".

## Sicurezza

- Bind **loopback `127.0.0.1`** fail-closed (`assertLoopback` rifiuta non-loopback).
- Tutte le `/api/*` dietro `Authorization: Bearer` (timing-safe).
- Token `0600`, exclusive create (`wx`), anti-symlink.
- Files: anti-traversal + anti-symlink (`lstat`).
- Accesso solo via tunnel SSH/VPN (no LAN, no public bind).
- Token auto-ricordato dal fragment `#token=` (decisione owner: single-user loopback-only;
  non aprire il link completo su device condivisi; ruota con `rm ~/.nexuscrew/token && restart`).

## Troubleshooting

- **tmux mancante** → `init` non installa il service (WARN). Installa tmux, ri-runna `init`.
- **Node < 18** → `init` abort before any write. Aggiorna Node.
- **systemctl --user fallisce** → `loginctl enable-linger $USER` (servizi user al boot).
- **launchctl fallisce** → verifica permessi `~/Library/LaunchAgents/`, sintassi plist (`plutil -lint`).
- **Termux:boot non avvia al reboot** → l'app Termux:Boot deve essere installata e aperta una volta
  (la detection da shell è best-effort, non può provare l'app Android).
- **pidfile stale** (Termux) → `nexuscrew stop` rimuove pidfile dead; `serve --pidfile` pulisce stale all'avvio.
- **voice non trascrive** → verifica `voiceUrl` + token in config.json; Web Speech browser su Chrome desktop.
