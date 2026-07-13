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
nexuscrew                 avvia/riusa in background e mostra il riepilogo
nexuscrew show            apre la PWA autenticata
nexuscrew show token      stampa il link autenticato senza aprirlo
nexuscrew status          mostra servizio, porta e connessioni
nexuscrew stop            ferma servizio/tunnel, preserva tutte le sessioni tmux
nexuscrew restart         riavvia servizio e connessioni autostart senza fermare tmux
nexuscrew boot            abilita l'avvio al boot (boot off|status)
nexuscrew doctor          verifica runtime, PTY, tmux, SSH e servizio
nexuscrew help            mostra la CLI pubblica
```

Setup, nodi, Fleet, engine, provider, modelli e token si gestiscono nella PWA.
`init`, `serve`, `fleet-boot` e `mcp` sono entrypoint interni, non workflow utente.

### Per-platform (start/stop/status)

| Platform | start | stop | status |
|---|---|---|---|
| linux (systemd) | `systemctl --user start` | `systemctl --user stop` | `is-active` |
| mac (launchd) | bootstrap + `launchctl kickstart` | `launchctl bootout` | `launchctl print` |
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
- **Node < 18** → il launcher interrompe il setup prima di scrivere. Aggiorna Node.
- **OpenSSH mancante** → `nexuscrew doctor` fallisce: installa `ssh`. `autossh` è
  opzionale e non viene usato dal runtime, perché NexusCrew supervisiona direttamente OpenSSH.
- **systemctl --user fallisce** → `loginctl enable-linger $USER` (servizi user al boot).
- **doctor segnala KillMode non sicuro** → non usare `systemctl restart nexuscrew` direttamente.
  Esegui il comando CLI della versione corrente: installa il drop-in `KillMode=process`, ricarica
  systemd e rifiuta il restart se la protezione non può essere applicata.
- **launchctl fallisce** → verifica permessi `~/Library/LaunchAgents/`, sintassi plist (`plutil -lint`).
- **Termux:boot non avvia al reboot** → l'app Termux:Boot deve essere installata e aperta una volta
  (la detection da shell è best-effort, non può provare l'app Android).
- **pidfile stale** (Termux) → `nexuscrew stop` rimuove pidfile dead; `serve --pidfile` pulisce stale all'avvio.
- **voice non trascrive** → verifica `voiceUrl` + token in config.json; Web Speech browser su Chrome desktop.
