# NexusCrew Portatile — Termux / Linux / Mac — Design (rev 4)

Data: 2026-07-08 · Stato: design rev 4 (audit APPROVE — post 4 cicli) · Base: `vps3-special` @ `af0dd71` (`0.5.0-vps3.1`)
Branch proposto: `portable` (da `vps3-special`)
Fondazione: studio v0.6 Parte 2 + design vps3.
Audit: rev 1 NEEDS_CHANGES (2B+8M+3m) → rev 2 NEEDS_CHANGES (10/13 fixed, residual R1-R4) → rev 3 recepisce R1-R4.
Report: `test-report/2026-07-08_AUDIT_portable_plan.md`.

## Obiettivo

Trasformare NexusCrew da `VPS3-special` a **portatile privato** su Termux/Linux/Mac via `git clone` +
`nexuscrew init`. No npm pubblico. Sicurezza no-public (loopback fail-closed, tunnel SSH/VPN) identica.

## Decisioni chiave (Q&A DAG + audit rev 1/2)

1. **Direzione**: portatile privato (git + init). No npm publish pubblico.
2. **Voice split**: server espone `{serverSttConfigured}`; frontend mic visibility = `SpeechRecognition in window` OR `serverSttConfigured`. Default `voiceUrl=null`.
3. **Deploy**: CLI `nexuscrew init` cross-platform + service generation (systemd/launchd/Termux:boot) con escaping per-platform.
4. **Config source** (B2): `lib/config.js` carica `~/.nexuscrew/config.json`; precedence defaults < config.json < env. `init` migration rule parse `Environment=NEXUSCREW_PORT=X` dal service esistente.
5. **Command semantics** (M6): `serve`=foreground HTTP no pidfile; `start`/`stop`/`status` per-platform (vedi §1).
6. **Termux model** (R1): niente service manager vero → `start`=nohup+pidfile verificato sempre; `stop`=kill pidfile verificato (no broad match); `status`="boot script installed" vs "server running".
7. **Retrocompat VPS3**: drop-in controlled restart — stessa porta 41777 + stesso token, sockets reconnect (non zero-interruption).
8. **Prereq policy** (M8): Node<18 abort before write; tmux mancante abort before service install; failure → preserve file + diagnosi.

## Cosa è GIÀ portabile

PTY `lib/pty/provider.js` per-piattaforma (android→Termux); backend JS puro `os.homedir()`; watcher polling fallback; bind loopback fail-closed; token 0600 (→wx M4); files anti-traversal+anti-symlink; tmux su PATH.

## 1. CLI dispatcher — command semantics per-platform (`bin/nexuscrew.js` + `lib/cli/`)

```
nexuscrew init [--dry-run] [--port N]   # setup: detect + config + token + service + print URL (dry-run: nessuna scrittura)
nexuscrew serve                          # server HTTP foreground (dev + ExecStart); no pidfile, no service manager
nexuscrew start                          # avvia il servizio (per-platform, vedi sotto)
nexuscrew stop                           # stop del servizio (per-platform, vedi sotto)
nexuscrew status                         # platform + stato servizio + porta + URL + token path
```

**`start` / `stop` / `status` per-platform** (R1):

| Platform | start | stop | status |
|---|---|---|---|
| **linux** (systemd) | `systemctl --user start nexuscrew` (fail se non installato) | `systemctl --user stop nexuscrew` | `systemctl --user is-active` + porta/URL |
| **mac** (launchd) | `launchctl kickstart -k gui/<uid>/com.mmmbuto.nexuscrew` (fail se non installato) | `launchctl kill SIGTERM gui/<uid>/com.mmmbuto.nexuscrew` | `launchctl print` parsed + porta/URL |
| **termux** (no service mgr) | check pidfile esistente+vivo → "already running"; altrimenti `nohup <nodeBin> <repoRoot>/bin/nexuscrew.js serve --pidfile >> ~/.nexuscrew/nexuscrew.log 2>&1 &` (path assoluto; `serve --pidfile` gestisce il pidfile lifecycle) + `termux-wake-lock` | kill via **pidfile verificato** (verify cmd+startTs, NO broad match by name) + `termux-wake-lock-release` + rimuove pidfile | "boot script installed" (`~/.termux/boot/nexuscrew.sh` exists) **vs** "server running" (pidfile vivo) |

Su linux/mac il pidfile è opzionale (`--manual`/nohup mode). Su **Termux il pidfile è il modello primario** (non c'è service manager). **Path assoluti** (R1.2): tutti i comandi avviati da service/boot usano `<nodeBin>` + `<repoRoot>/bin/nexuscrew.js` (assoluto) + `cwd=repoRoot`, così funzionano da qualsiasi directory (boot Android, shell non-repo).

**`serve --pidfile`** (R1.1) — flag interno del comando `serve`: all'avvio scrive il pidfile (`wx` + metadata `{pid,cmd,startTs}`), registra handler SIGINT/SIGTERM/`exit` per rimuoverlo. È l'**unico** path che gira il server su Termux — usato sia da `nexuscrew start` (nohup background) sia dal boot script (`exec` foreground). Così ogni processo server su Termux partecipa allo stesso lifecycle pidfile, e `status`/`stop` lavorano sempre sul pidfile verificato (no broad match, no processo orfano dopo reboot). Su linux/mac il service ExecStart usa `serve` **senza** `--pidfile` (il service manager traccia il processo).

`serve` è l'unico comando che fa girare il server HTTP (usato da `start` via service manager / nohup, e in dev foreground).

Moduli `lib/cli/`:

- **`platform.js`** (M1) — `detectPlatform()` → termux/linux/mac. Segnali ordinati: `TERMUX_VERSION` → termux; `PREFIX?.includes('com.termux')` → termux; `process.platform === 'android'` → termux; `darwin` → mac; `linux` → linux. `nodeBin()`=`process.execPath`. `repoRoot()`=`path.resolve(__dirname,'../..')`. `uid()` per launchd gui/uid.

- **`service.js`** — `generateService(platform, ctx)` + `installService(platform, content, ctx)`.
  - **Escaping per-platform** (M2): systemd (`%`→`%%`, ExecStart quoted); launchd (XML-escape `&<>`" di tutti i path, **incluso `home`** — R2); Termux (shell-quote singolo).
  - **Install no-symlink + mode** (M3): `lstat` target → reject symlink → temp file stessa dir → `chmod` mode → atomic `rename`. Mode: systemd unit 0644, launchd plist 0644, Termux boot script 0700, parent dirs 0755.
  - **Template** (ctx = `{repoRoot, nodeBin, port, home, uid}`, tutti escaped):

    - **systemd `--user`** → `~/.config/systemd/user/nexuscrew.service` (0644):
      ```
      [Unit]
      Description=NexusCrew — browser tmux client (loopback, solo tunnel SSH/VPN)
      After=network-online.target
      [Service]
      Type=simple
      WorkingDirectory=<repoRoot escaped>
      Environment=NEXUSCREW_PORT=<port>
      Environment=PATH=<nodeBinDir>:/usr/local/bin:/usr/bin:/bin
      ExecStart=<nodeBin escaped> bin/nexuscrew.js serve
      Restart=on-failure
      RestartSec=3
      [Install]
      WantedBy=default.target
      ```
      Install: `systemctl --user daemon-reload && systemctl --user enable --now nexuscrew`.

    - **launchd** → `~/Library/LaunchAgents/com.mmmbuto.nexuscrew.plist` (0644) — **plist valido + `${homeXml}` placeholder** (R2):
      ```xml
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>com.mmmbuto.nexuscrew</string>
        <key>ProgramArguments</key>
        <array>
          <string>${nodeBinXml}</string>
          <string>bin/nexuscrew.js</string>
          <string>serve</string>
        </array>
        <key>WorkingDirectory</key>
        <string>${repoRootXml}</string>
        <key>EnvironmentVariables</key>
        <dict>
          <key>NEXUSCREW_PORT</key>
          <string>${port}</string>
        </dict>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict>
          <key>SuccessfulExit</key>
          <false/>
        </dict>
        <key>StandardOutPath</key>
        <string>${homeXml}/.nexuscrew/nexuscrew.log</string>
        <key>StandardErrorPath</key>
        <string>${homeXml}/.nexuscrew/nexuscrew.log</string>
      </dict>
      </plist>
      ```
      Tutti i `${varXml}` sono XML-escaped (`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`, `"`→`&quot;`). Validazione: parse XML + assert struttura `key/string/array/dict`. Install: `launchctl bootout gui/<uid>/com.mmmbuto.nexuscrew` (ignore error) → `launchctl bootstrap gui/<uid> <plist>`. Fallback `launchctl load -w` su macOS vecchi.

    - **Termux:boot** → `~/.termux/boot/nexuscrew.sh` (0700) — **con log redirect** (R3):
      ```sh
      #!/data/data/com.termux/files/usr/bin/sh
      # NexusCrew boot (Termux)
      export PATH=/data/data/com.termux/files/usr/bin:$PATH
      export HOME=/data/data/com.termux/files/home
      export NEXUSCREW_PORT=<port>
      cd -- '<repoRoot shell-quoted>'
      termux-wake-lock 2>/dev/null || true
      mkdir -p "$HOME/.nexuscrew"
      exec '<nodeBin shell-quoted>' '<repoRoot shell-quoted>/bin/nexuscrew.js' serve --pidfile >> "$HOME/.nexuscrew/nexuscrew.log" 2>&1
      ```
      Validazione: `sh -n`. **Detection best-effort** (R4): `init` check `~/.termux/boot/` esiste — NON può provare app Android Termux:boot installata/abilitata da shell. CLI output esplicito: stampa il path dello script generato + disclaimer "installa/apri Termux:Boot una volta se l'avvio automatico non avviene al reboot". Test limitati a generazione script + `sh -n` (non app presence).
      Fallback manuale (se Termux:boot non disponibile): `nexuscrew start` (nohup + pidfile + wake-lock, come sopra).

- **`pidfile.js`** (R1) — `~/.nexuscrew/nexuscrew.pid`. write `{flag:'wx'}` + metadata `{pid,cmd,startTs}`. `kill`: **verify cmd+startTs** prima di killare (no PID reuse, no broad match by name). `isAlive`: check pid + cmd match. `remove` su stop. Stale removal (pid morto). Primario su Termux; opzionale (`--manual`) su linux/mac. Il lifecycle (write/remove) è gestito da `serve --pidfile` (vedi sotto), non da `start`.

## 2. Config source of truth (B2) — `lib/config.js`

- Carica `~/.nexuscrew/config.json` (nuovo). Precedence: defaults < config.json < env.
- `defaults()`: `port=41820`, `voiceUrl=null`, `voiceTokenFile=null`.
- `loadConfig()`: merge defaults ← config.json ← env. `config.json` scritto solo in `init`.
- **Migration rule**: se non c'è `config.json` E esiste service file con `Environment=NEXUSCREW_PORT=X` (parse), migra `port=X` in config.json prima di rigenerare il service. VPS3 (41777) preservato anche da shell senza env.
- `voiceTokenFile=null` → `loadVoiceToken` skip readFileSync (ritorna '').

## 3. Voice — modello split (M5)

- `GET /api/voice/status` → `{serverSttConfigured: !!cfg.voiceUrl}` (config-only).
- `POST /api/voice/transcribe` → 503 `{error:"server STT not configured"}` se `voiceUrl=null`.
- Frontend: mic visibility = `('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) OR serverSttConfigured`. Matrice test: WS presente+server off (mic on, Web Speech) · WS assente+server off (mic off) · WS assente+server on (mic on, MediaRecorder→server).

## 4. Token security (M4)

`lib/auth/token.js`: exclusive create `writeFileSync(path, tok, {flag:'wx', mode:0o600})`. Se file esiste e non vuoto → preserva. Se esiste vuoto → `lstat` (reject symlink) → unlink → crea wx. Symlink path → reject (no follow). Test: preserva esistente; symlink rejected; concurrent safe; mode 0600.

## 5. Distribuzione — frontend prebuilt (m1)

Committare `frontend/dist/` sul branch `portable` (gitignore rimosso per questo branch). Target non builda Vite. **"frontend-prebuilt"** (non self-contained): `npm ci --omit=dev` serve per deps runtime/native. Flow: `git clone -b portable --single-branch` + checkout **tag pinned** per production + `npm ci --omit=dev` + `./bin/nexuscrew.js init`. Registry Forgejo = futura upgrade path (deferita, `dist` ora tracciata).

## Retrocompatibilità VPS3 (drop-in controlled restart)

`init` su VPS3: migration rule legge `NEXUSCREW_PORT=41777` dal service esistente → config.json → rigenera unit con path correnti → preserva token. `systemctl --user daemon-reload && restart nexuscrew` → controlled restart: stessa porta 41777, stesso token, client WS reconnect dopo restart.

## Sicurezza

Invariata: loopback fail-closed; Bearer timing-safe `/api/*`; anti-traversal+anti-symlink files; token 0600 wx; tunnel SSH/VPN. Nuova superficie: service generation con path runtime + escaping per-platform; install no-symlink + mode; init non accetta path arbitrari (solo `--port`/`--dry-run`).

## Testing (parser reali — m3)

Suite `node --test` (39/39) verde. Nuovi test:
- **platform**: 4 segnali detect (TERMUX_VERSION, PREFIX, android, linux); nodeBin/repoRoot/uid stabili.
- **service generation**: parser/validator reali — mac (parse XML + struttura key/string/array/dict, **incluso StandardOutPath/StandardErrorPath sopravvivono a home con `&<>`"** — R2); linux (`systemd-analyze verify` se disponibile + assert); termux (`sh -n` + mode 0700 + shebang + **log redirect presente** — R3). Hostile paths: spazi, `&`, `%`, `$`, `;`, backtick → template valido, nessuna iniezione.
- **install**: pre-existing symlink → reject; mode file; atomic rename; dry-run non scrive.
- **config**: precedence defaults<config<env; migration rule (service 41777 → config 41777 senza env); null voiceTokenFile safe.
- **voice**: status `{serverSttConfigured}`; transcribe 503 se null.
- **token**: exclusive create preserva; symlink rejected; concurrent safe; mode 0600.
- **init --dry-run**: nessuna scrittura FS (mock); prereq abort prima di write; failure install → file preserved + diagnosi; Termux:boot detection best-effort + CLI output disclaimer (R4).
- **pidfile** (R1): write/read/kill round-trip; PID reuse check (cmd+startTs mismatch → no kill); stale removal; Termux start scrive pidfile, stop kill verificato, status boot-script-installed vs running.

Build frontend (`npm run build`) parte del gate pre-commit.

## Error handling

Node<18 abort before write · tmux mancante abort before service install · Termux:boot non rilevabile → fallback manuale (start nohup+pidfile) + disclaimer · `launchctl bootstrap`/`bootout` fail → fallback `load -w` + diagnosi · `systemctl --user` fail → suggerimento `loginctl enable-linger` · service install failure → file preserved + messaggio · pidfile kill: pid morto o cmd mismatch → no kill + messaggio.

## Fuori scope

Griglia desktop (studio v0.6 Parte 1) · TTS in UI · create/kill/rename sessioni · multi-host SSH · PWA skin · registry Forgejo (futura) · npm pubblico.

## Definition of done

1. Branch `portable` pushato Forge, working tree pulito, `package-lock` root normalizzato (m2).
2. `nexuscrew init` testato su VPS3 (linux) + almeno 1 altra piattaforma (Mac o Termux): service generato valido (parser/verify OK), installato, attivo al boot; su Termux `start`/`stop`/`status` operativi via pidfile.
3. VPS3 drop-in controlled restart: stessa porta 41777 + stesso token, sockets reconnect.
4. Voice split: Web Speech browser attivo dove supportato anche senza server STT.
5. Suite `node --test` verde (39 + nuovi); build ok; `dist/` committata.
6. Audit Codex APPROVE su rev 3 + implementazione.
7. docs `INSTALLATION.md`/`CONFIGURATION.md` aggiornati (3 piattaforme + init + prereq + voice env + Termux start/stop model).
