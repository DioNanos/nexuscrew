# NexusCrew Current State

Updated: 2026-07-09

## v0.7.0 "Fleet Deck" — branch `develop` — ciclo chiuso, pending smoke live + deploy

Griglia desktop stile Claude Code (colonne, drag da sidebar, divisori, composer
per-tile, `takeSize:false`) + fleet in UI (celle on/off/engine/key/boot, degraded,
guardie audit F1–F7) + lifecycle sessioni (preset allowlist, kill 409 `cloud-*`)
+ card ricche (activity/preview) + mobile a gruppi con FAB + i18n IT/EN/ES.
Spec+piano in `docs/superpowers/{specs,plans}/2026-07-09-nexuscrew-v07-*`.
Eseguito da 2 worker GLM-5.2 (crew, worktree separati) + coordinator Fable
(gate A/B/C auditati, merge `75192bf`/`3508b05`/`f883646`). Suite: 149 pass/0 fail.
Companion: `fleet status --json` in `~/.local/bin/fleet` (schemaVersion 1).
Deploy VPS3 (porta 41777): LIVE su **v0.7.1** (0.7.0 + license fix Apache-2.0).
Linea `vps3-special` RITIRATA (branch conservato come storico).

**PUBBLICO (2026-07-09 sera)**: GitHub `DioNanos/nexuscrew` RIFATTO — storia fresca
(1 commit sanificato, leak-grep pulito, internal docs esclusi), repo public,
release `v0.7.1` con .tgz+SHA256SUMS, topics/description aggiornati, nexuscrew nel
README profilo DioNanos. npm: `latest`=`next`=**0.7.1** (license **Apache-2.0**;
0.7.0 deprecata per metadata MIT errati). README con contratto fleet JSON e
sezione Screenshots placeholder (screen di DAG in arrivo).

## portable (0.6.0) — branch `portable` — audit APPROVE

Portatile privato su Termux/Linux/Mac via `git clone` + `nexuscrew init`. No npm pubblico.
Design+plan: `docs/superpowers/specs|plans/2026-07-08-nexuscrew-portable*` (rev 4, audit piano
APPROVE dopo 4 cicli). Audit implementazione: `test-report/2026-07-08_AUDIT_portable_impl.md`
APPROVE @842e31d (post-fix M1/M2/M3/m1).

- **CLI**: `init`/`serve`/`start`/`stop`/`status` per-platform (systemd --user / launchd /
  Termux nohup+pidfile). `serve --pidfile` = unico path server su Termux (lifecycle unificato).
- **Config**: `~/.nexuscrew/config.json` (precedence defaults<config<env); init migration rule
  preserva la porta dal service esistente (VPS3 drop-in 41777).
- **Voice split**: `serverSttConfigured` config-only; mic visibility = Web Speech OR server STT.
- **Sicurezza**: loopback fail-closed, Bearer timing-safe (anche /api/voice/status), token wx
  anti-symlink, service install no-symlink atomic, escaping per-platform + reject char systemd.
- **Suite**: `node --test` 126 pass / 0 fail (parser reali sh -n/XML/systemd-analyze, hostile paths).
- **Smoke VPS3 drop-in verde**: porta 41777 + token unchanged, init restarta (pid change),
  200/401 gate, `/api/voice/status {serverSttConfigured:true}` (voice VPS3 preservata via config.json).
- **Smoke Mac/Termux runtime**: PENDING (richiede device fisico). Test unit coprono template
  (sh -n, XML structure, hostile paths, parser) per le 3 piattaforme.
- **Distribuzione**: `frontend/dist/` committata (git clone self-contained, no build Vite sul target);
  `npm ci --omit=dev` per deps runtime. Tagged checkout per production.

Caveat: token in URL `#token=` loggato (intenzionale, ereditato da vps3, decisione owner single-user
loopback tunnel). Termux:boot detection best-effort (non prova app Android da shell).

## Canonical Release (vps3-special, linee precedenti)

- **Linea attiva: `0.5.0-vps3.1` — VPS3-special, PRIVATA** (branch `vps3-special`, remote Forge).
  Nessuna pubblicazione npm/GitHub per questa linea.
- npm package `@mmmbuto/nexuscrew` (linea pubblica, ferma):
  - `next -> 0.4.3` ("pty-core")
  - `latest -> 0.2.5`

## v0.5 VPS3-special — cosa aggiunge sopra la v0.4

- **File exchange bidirezionale**: `~/NexusFiles/<sessione>/{inbox,outbox}`;
  upload multipart → inbox con nome timbrato + auto-paste del path nella sessione
  (`send-keys -l`, mai Invio); watcher outbox (fs.watch + polling fallback) →
  frame WS `{type:'files'}` + summary/badge in `/api/sessions`; download/delete
  con guardie anti-traversal e anti-symlink (`lstat`).
- **Voice→testo**: ComposerBar con Web Speech API (it-IT) e fallback server-side
  `POST /api/voice/transcribe` → mcp-voice `127.0.0.1:3105` (whisper-local);
  token voice solo lato server.
- **Hardening**: TUTTE le REST `/api/*` dietro `Authorization: Bearer` (timing-safe);
  bind-guard loopback invariato.
- **Deploy**: unit systemd user `nexuscrew.service`, porta `41777`, al boot con la
  flotta AI. Accesso SOLO via tunnel SSH/VPN.
- **Fix tmux 3.4**: target pane/window `=sessione:` (il bare `=sessione` fallisce
  per send-keys/select-pane); `pasted` riflette il vero exit code di tmux.

## Verified In This Cycle (2026-07-06)

- Suite `node --test`: **37 pass / 0 fail** (18 baseline v0.4 + 19 nuovi).
- Build frontend: exit 0 (47 moduli).
- Audit Codex: chunk A+B `NEEDS_CHANGES` → 3 finding fixati (symlink escape,
  watcher leak, control-bytes) → chunk C + fix `AUDIT_C:APPROVE`.
- Smoke e2e su servizio deployato (127.0.0.1:41777): gate 401/200, upload→inbox
  timbrato→path nel pane, outbox→watcher→list/download, summary badge,
  transcribe 200 via whisper-local, 404 su sessione fantasma.

## Convenzione flotta

Deliverable per DAG → `~/NexusFiles/<sessione>/outbox/` (documentata in
`~/.claude/CLAUDE.md` core VPS3).

## Not Yet Closed

- TTS in UI (endpoint piper pronto, non esposto) — futura ottimizzazione.
- create/kill/rename sessioni, multi-host, PWA skin — fuori scope v0.5.

## Security — decisioni accettate (owner: DAG)

- **Token auto-ricordato dal fragment** (`readToken()`, commit e3d0f73): un token
  arrivato via `#token=…` viene salvato in localStorage senza prompt. Richiesto
  esplicitamente da DAG (2026-07-06, "salvarlo e basta"): istanza single-user,
  loopback-only dietro tunnel SSH/VPN. Caveat: non aprire il link completo su
  device condivisi. Rotazione: `rm ~/.nexuscrew/token && systemctl --user restart nexuscrew`.
  Da RIVALUTARE se questa linea confluisse mai nella release pubblica.
