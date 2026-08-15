# NexusCrew Portatile — Implementation Plan (TDD, rev 4)

Data: 2026-07-08 · Design: `docs/superpowers/specs/2026-07-08-nexuscrew-portable-design.md` (rev 4)
Base: `vps3-special` @ `af0dd71` · Branch: `portable` (nuovo, da `vps3-special`)
Audit: rev 1 (2B+8M+3m) → rev 2 (10/13 fixed, R1-R4) → rev 3 (R2-R4 fixed, R1.1/R1.2) → rev 4 APPROVE (R1.1/R1.2 closed).
**Vincolo DAG**: commit atomici per task + branch `portable` dedicato.
Metodo: TDD — test prima dell'impl; suite `node --test` (39/39) verde prima e dopo ogni task.

## prerequisiti

- [ ] P0. Branch `portable` da `vps3-special`. Normalizzare `package-lock.json` root a `0.5.0-vps3.1` (m2)
      via `npm install`. Rimuovere `frontend/dist` dal `.gitignore` (solo questo branch); commit `dist/`
      prebuilt corrente. Suite verde (39/39). Commit atomico: `chore(portable): branch setup + lockfile + dist tracked`.

## Fase 1 — fondazioni platform-agnostic

- [ ] T1. `lib/cli/platform.js` + test. [M1]
      `detectPlatform()` 4 segnali: TERMUX_VERSION, PREFIX.includes('com.termux'), `android`, darwin/linux.
      `nodeBin()`=`process.execPath`; `repoRoot()`=`__dirname/../..`; `uid()` per launchd.
      Test: 4 casi detect (android senza env Termux); stabilità nodeBin/repoRoot/uid.
      Commit: `feat(portable): platform detection (termux/linux/mac, 4 signals)`
- [ ] T2. `lib/config.js` — config source of truth + test. [B2]
      `loadConfig()`: merge defaults ← `~/.nexuscrew/config.json` ← env. `defaults()`: voiceUrl=null,
      voiceTokenFile=null, port=41820. `voiceTokenFile=null` → loadVoiceToken skip readFileSync.
      Test: precedence; config.json assente → defaults; env override; null voiceTokenFile safe.
      Commit: `feat(portable): config.json source of truth (defaults<config<env)`
- [ ] T3. `lib/voice/transcribe.js` — modello split + test. [M5]
      `GET /api/voice/status` → `{serverSttConfigured:!!cfg.voiceUrl}`. `POST /api/voice/transcribe` →
      503 `{error:"server STT not configured"}` se voiceUrl null.
      Test: status true/false; transcribe 503 senza voiceUrl; success con mock.
      Commit: `feat(portable): voice split model (serverSttConfigured, 503 if not configured)`
- [ ] T4. `lib/auth/token.js` — exclusive create + test. [M4]
      `writeFileSync` `{flag:'wx',mode:0o600}`; esiste non-vuoto → preserva; esiste vuoto → lstat (reject
      symlink) → unlink → crea wx; symlink → reject.
      Test: preserva esistente; symlink rejected; concurrent safe; mode 0600.
      Commit: `fix(portable): token exclusive create (wx) + anti-symlink`

## Fase 2 — CLI dispatcher

- [ ] T5. `bin/nexuscrew.js` → dispatcher, semantica per-platform + test. [M6][R1]
      Subcomandi `init`/`serve`/`start`/`stop`/`status`. `serve`=foreground HTTP; accetta flag interno `--pidfile`
      (scrive/rimuove pidfile lifecycle, handler SIGINT/SIGTERM/exit) — usato da Termux start + boot.
      `start`/`stop`/`status` per-platform: linux (systemctl --user), mac (launchctl kickstart/kill/print),
      termux (check pidfile already-running → nohup `serve --pidfile` background path assoluto + wake-lock;
      kill pidfile verificato; status boot-script-installed vs running). Path assoluti `<nodeBin>` + `<repoRoot>/bin/nexuscrew.js` + cwd=repoRoot (R1.2).
      Parsing argv minimale (no dep); help.
      Test: dispatch; `serve` avvia server (mock); `serve --pidfile` scrive+rimuove pidfile (mock server lifecycle);
      `start` linux chiama systemctl (mock); `start` termux nohup `serve --pidfile` path assoluto (mock) + already-running se pidfile vivo;
      `start` termux da cwd non-repo usa path assoluto (R1.2); `stop` termux kill verificato (no broad match);
      `status` termux boot-script-installed vs running (pidfile vivo); unknown → help+exit1.
      Commit: `feat(portable): CLI dispatcher init/serve/start/stop/status (per-platform)`
- [ ] T6. `lib/cli/pidfile.js` + test. [R1]
      `~/.nexuscrew/nexuscrew.pid`. write `{flag:'wx'}` + metadata `{pid,cmd,startTs}`; `kill` verify
      cmd+startTs (no PID reuse, no broad match); `isAlive` check pid+cmd; `remove`; stale removal.
      Primario su Termux (lifecycle gestito da `serve --pidfile`); opzionale `--manual` su linux/mac.
      Test: round-trip; pid morto rimosso; PID reuse check (cmd mismatch → no kill); concurrent safe;
      `serve --pidfile` scrive pidfile all'avvio e lo rimuove all'exit (lifecycle unico per start manuale + boot).
      Commit: `feat(portable): pidfile with verified kill (cmd+startTs, no PID reuse)`

## Fase 3 — service generation (3 template, escaping + parser)

- [ ] T7. `lib/cli/service.js` — `generateService('linux', ctx)` + escape systemd + test. [M2]
      Template systemd `--user`, escape (`%`→`%%`, ExecStart quoted). Validazione `systemd-analyze verify`
      se disponibile + assert stringhe.
      Test: snapshot; hostile paths (spazi, `&`, `%`, `$`) → valido; verify OK o skip.
      Commit: `feat(portable): systemd --user service template + escaping`
- [ ] T8. `lib/cli/service.js` — `generateService('mac', ctx)` + XML-escape + test. [B1][R2]
      Template launchd plist valido (`key/string/array/dict`, ProgramArguments, EnvironmentVariables/dict,
      RunAtLoad, KeepAlive, StandardOutPath/StandardErrorPath con `${homeXml}`). XML-escape tutti i path.
      Validazione: parse XML + struttura key/string/array/dict.
      Test: snapshot; parse XML OK; **hostile home con `&`,`<`,`>`,`"` in StandardOutPath/StandardErrorPath
      sopravvive** (R2); struttura valida.
      Commit: `feat(portable): launchd plist template (valid XML, escaped paths)`
- [ ] T9. `lib/cli/service.js` — `generateService('termux', ctx)` + shell-quote + log redirect + test. [M7][R3]
      Template `~/.termux/boot/nexuscrew.sh` 0700: PATH/HOME/NEXUSCREW_PORT export, `cd -- 'escaped'`,
      `termux-wake-lock`, `mkdir -p "$HOME/.nexuscrew"`, `exec '<nodeBin>' '<repoRoot>/bin/nexuscrew.js' serve --pidfile >> "$HOME/.nexuscrew/nexuscrew.log" 2>&1`
      (path assoluto + `serve --pidfile` — R1.1/R1.2). Shell-quote singolo. Validazione `sh -n`.
      Test: snapshot; `sh -n` OK; hostile paths (spazi, `$`, `;`, backtick) shell-safe; shebang Termux;
      mode 0700; **log redirect presente** (R3); **boot script invoca `serve --pidfile` non `serve` raw** (R1.1);
      **path assoluto repoRoot/bin/nexuscrew.js** (R1.2).
      Commit: `feat(portable): Termux:boot script template (shell-quoted, log redirect)`
- [ ] T10. `lib/cli/service.js` — `installService` no-symlink + mode + test. [M3]
      lstat target → reject symlink → temp stessa dir → chmod mode → atomic rename. Mode: systemd 0644,
      plist 0644, termux 0700, parent dirs 0755. Esegue systemctl/launchctl/chmod (mock in test). `--dry-run` skip.
      Test: mock spawn; pre-existing symlink → reject; mode file; atomic rename; dry-run non scrive.
      Commit: `feat(portable): service install (no-symlink, atomic rename, explicit modes)`

## Fase 4 — init orchestrazione

- [ ] T11. `nexuscrew init` + migration rule + `--dry-run` + prereq + Termux detection + test. [B2][M8][R4]
      Orchestrazione: detectPlatform → prereq (Node>=18 abort, tmux abort prima di write) → migration rule
      (service esistente `NEXUSCREW_PORT=X` → config.json) → config.json (no overwrite porta migrata) →
      token (wx) → dir NexusFiles → generateService → installService (skip dry-run) → print URL `#token`.
      Termux:boot detection best-effort: check `~/.termux/boot/` exists; CLI output path script + disclaimer
      app Android (non provabile da shell). Failure install → file preserved + diagnosi.
      Test: dry-run nessuna scrittura (mock FS); migration rule (service 41777 → config 41777 senza env);
      prereq abort prima di write; token preservato; URL stampato; Termux detection best-effort + disclaimer; failure → file preserved.
      Commit: `feat(portable): nexuscrew init (migration, dry-run, prereq, Termux detection)`

## Fase 5 — frontend + retrocompat + docs

- [ ] T12. Frontend: voice split — mic visibility `SpeechRecognition in window OR serverSttConfigured`. [M5]
      ComposerBar: `/api/voice/status` all'avvio; mic visibile se WS supportato (indipendente da server STT);
      fallback MediaRecorder→server solo se WS assente e server on. Matrice manuale 3 casi.
      Build: `npm run build` → rigenera `dist/`.
      Commit: `feat(portable): frontend voice split (mic visibility browser OR server STT)`
- [ ] T13. Retrocompat VPS3 drop-in controlled restart + smoke. [B2]
      `init` su VPS3: migration rule legge 41777 dal service → config.json → rigenera unit path correnti →
      preserva token. `systemctl --user daemon-reload && restart nexuscrew`.
      Smoke: stessa porta 41777, stesso token; 200/401 gate; upload/download; voice fallback (mcp-voice VPS3
      → mic visibile); client WS reconnect dopo restart (documentato: non zero-interruption).
      Commit: `test(portable): VPS3 drop-in controlled restart smoke`
- [ ] T14. docs `INSTALLATION.md`/`CONFIGURATION.md` aggiornati (3 piattaforme + init + prereq + voice env + tagged checkout + Termux start/stop model). [m1]
      Sostituire `npm i -g` con git clone + tag pinned + `npm ci --omit=dev` + `nexuscrew init`; documentare
      voice env, prereq (tmux, Node>=18, Termux:boot best-effort), Termux start/stop via pidfile, sicurezza tunnel, "frontend-prebuilt".
      Commit: `docs(portable): installation/configuration for termux/linux/mac`
- [ ] T15. Suite completa + build + commit `dist/` + push branch `portable`.
      `node --test` verde (39 + nuovi); `npm run build`; commit `dist/` + lockfile; push Forge.
      Commit: `chore(portable): final build + dist + push`

## Fase 6 — audit + done

- [ ] T16. Audit Codex (cella `codex-audit`) su rev 3 + implementazione → marker
      `nexuscrew-portable-audit:<APPROVE|NEEDS_CHANGES>:<commit>:<motivo>` + report `test-report/`.
      Fix residuali; re-audit fino a APPROVE. Consultabile a metà via cell_send_task per dubbi.
- [ ] T17. Smoke e2e su seconda piattaforma (Mac o Termux) + chiusura.
      Verifica `init` + `start`/`stop`/`status` su piattaforma non-VPS3; aggiorna `CURRENT_STATE.md`;
      aggiorna `dev_state` (esito portabilità).

## Note

- TDD rigoroso: test rosso → impl → test verde. **Commit atomico per task** (messaggi come da task).
- Validator reali nei test service (plist XML parse, `systemd-analyze verify`, `sh -n`) — non solo snapshot (m3).
- Non toccare superficie sicurezza senza test di equivalenza.
- `dist/` rigenerata con `npm run build` prima di commit che tocchi `frontend/src/`.
- Auditor consultabile a metà (cell_send_task) per dubbi implementativi.
