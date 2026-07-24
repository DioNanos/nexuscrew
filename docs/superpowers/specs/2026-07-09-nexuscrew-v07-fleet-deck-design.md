# Design v0.7 "Fleet Deck" — griglia desktop stile Claude Code + fleet in UI + mobile restyle

Data: 2026-07-09 · Stato: DESIGN (approvato a voce da DAG, sezioni §1–§6; audit pre-commit Codex
`NEXUSCREW-V07-DESIGN:NEEDS_CHANGES:7` → 7 finding integrati in questa revisione) · Base: `develop` (include ciclo portable 0.6.0)
Riferimenti: studio v0.6 (`2026-07-06-nexuscrew-v06-studio-griglia-portabilita.md`, superseded per la parte griglia),
screenshot Claude Code desktop + app Claude Android forniti da DAG (2026-07-09).

---

## Obiettivo

NexusCrew diventa il **pannello unico della flotta AI**: da desktop una griglia di terminali
stile Claude Code desktop (drag dalla sidebar, auto-tiling a colonne, resize manuale);
da mobile un'esperienza stile app Claude Android; dentro, la **logica `fleet`**
(celle on/off, engine, key A/P, boot) — "unico comando che gestisce i tmux attivi MA non solo".

## Decisioni chiave (ratificate da DAG 2026-07-09)

| # | Decisione | Scelta |
|---|---|---|
| 1 | Tiling desktop | **Colonne stile Claude Code** (flex + divisori; NO react-grid-layout, zero dipendenze nuove) |
| 2 | Fleet in UI | **Sidebar unificata**: celle anche da spente (⏻/engine/key/boot) + tmux generiche |
| 3 | Input nel tile | Digitazione diretta xterm sempre attiva + **composer per-tile a scomparsa** (riuso ComposerBar) |
| 4 | Lifecycle sessioni | **Crea + termina con conferma** le tmux generiche; celle SOLO via `fleet up/down` |
| 5 | Card sessione | **Ricche**: dot attività, engine·key, tempo relativo, preview ultima riga, badge outbox |
| 6 | Backend fleet | **Shell su `fleet` CLI** + nuova `fleet status --json` (ai-fleet-lib unica source of truth) |
| 7 | Modello flotta | **Ibrido registry+detect**: registry dichiara ciò che PUÒ esistere, tmux osserva ciò che GIRA; identità = convenzione nome, il detect informa e non comanda |
| 8 | Linee | Lavoro su `develop` (Forge); facciata pubblica GitHub/npm = ciclo successivo; **modulo fleet opzionale feature-detected** (portable resta pulita) |

## §1 Architettura e linee

- Branch di lavoro: `develop` (Forge). `vps3-special` congelata legacy; a fine ciclo il
  deploy VPS3 passa a `develop` taggata (linea unica). Versione target: **0.7.0**
  (la label 0.6.0 è del ciclo portable già chiuso).
- **Feature-detect fleet** (trust boundary — audit F3): all'avvio il server cerca il
  binario `fleet` (configurabile `fleet.bin`, default `$HOME/.local/bin/fleet`,
  disattivabile `fleet.enabled=false` in config.json). `available:true` SOLO se:
  (a) il binario supera la validazione `realpath`/`lstat` — regular file eseguibile,
  no symlink, non world-writable; (b) `fleet status --json` risponde con lo schema
  nostro (`schemaVersion` + `kind:"ai-fleet"`, vedi §2). Un binario omonimo estraneo
  (linea portable su altri device) NON attiva la feature. Assente/non valido →
  `/api/fleet/status` risponde `{available:false}` e la UI non mostra la sezione
  Flotta. Nessun path VPS3 hardcoded nel core.
- **Modello ibrido**:
  - *Registry* (ciò che può esistere): output di `fleet status --json` — celle con
    `{cell, engine, active, boot, tmux, rc, key}`. Mostra anche le celle spente.
  - *Detect* (ciò che gira): `tmux list-sessions` + arricchimento per-sessione
    (attività, preview, badge CLI da `pane_current_command`, best-effort).
  - *Binding*: SOLO per convenzione nome (`cloud-<Cell>` ↔ cella). Mai per processo.
  - *Riconciliazione*: unit `active` ma tmux assente (o viceversa) → stato ⚠ `degraded`
    esposto in API e visibile in UI. Sessioni fuori registry = "generiche" con badge.
- **Miglioria a `fleet` (fuori repo, `~/.local/bin/fleet`)**: subcomando
  `status --json` con **contratto esatto** (audit F4) — il JSON è emesso dalla
  libreria fleet, MAI ricavato parsando la tabella umana:

  ```json
  {
    "schemaVersion": 1,
    "kind": "ai-fleet",
    "cells": [
      { "cell": "Dev", "tmuxSession": "cloud-Dev", "engine": "glm",
        "active": true, "boot": true, "tmux": true,
        "rc": "Cloud_Dev_Senior", "key": "A" }
    ]
  }
  ```

  `active`/`boot`/`tmux` booleani veri (non stringhe systemd). La tabella umana
  resta il default senza flag. Lato NexusCrew: test su fixture per output valido,
  campi mancanti, JSON invalido, `schemaVersion` futuro.

## §2 Server (Node, `lib/`)

### `lib/fleet/` (nuovo modulo)

- `detect(cfg)` → `{available, bin}`.
- `status()` → execFile `fleet status --json`, cache 2s, arricchito con `degraded`.
- `up(cell, {engine, boot})`, `down(cell, {boot})`, `engine(cell, eng)`, `boot(cell, on)`.
- Esecuzione **serializzata** (coda FIFO, 1 comando fleet alla volta), timeout 15s,
  `stderr` propagato nell'errore API. Argomenti SEMPRE array execFile (no shell).
- Validazioni: `cell` deve esistere nello status; `engine` in whitelist
  (`native|glm|glm-a|glm-p|ollama|ollama-cloud|codex-vl`).

### API (tutte dietro Bearer esistente)

| Endpoint | Descrizione |
|---|---|
| `GET /api/fleet/status` | `{available, cells:[{cell,engine,active,boot,tmux,rc,key,degraded}]}` |
| `POST /api/fleet/up` | `{cell, engine?, boot?}` |
| `POST /api/fleet/down` | `{cell, boot?}` |
| `POST /api/fleet/engine` | `{cell, engine}` |
| `POST /api/fleet/boot` | `{cell, enabled}` |
| `POST /api/sessions` | `{name, cwd, preset?}` → `tmux new-session -d`. **Niente `cmd` libero** (audit F1: sarebbe esecuzione shell arbitraria dietro Bearer): `preset` da allowlist server-side (`shell` default, `claude`, `codex-vl`, `pi`, …, estendibile in config) mappata a comandi fissi. Guardie: name `^[\w.-]{1,64}$`; cwd risolta con `fs.realpath`, DEVE restare sotto `realpath($HOME)` (niente symlink-escape), dir esistente |
| `DELETE /api/sessions/:name` | kill-session con target tmux **exact-match** (`=name`). **Denylist indipendente dal registry** (audit F2): 409 SEMPRE per le celle note (`AIFLEET_CELLS`) e in generale per QUALUNQUE `cloud-*` — anche con fleet assente/rotto/stale ("usa fleet down"). Test dedicato: 409 con fleet unavailable |

### Arricchimento `GET /api/sessions`

- `activity`: epoch da `#{session_activity}` (formato list-sessions, costo zero).
- `preview`: ultima riga non vuota via `capture-pane -p` (tail), campionata con cache
  ~3s per sessione viva; errori → campo assente, mai 500. Limiti (audit F7):
  max 240 caratteri, strip ANSI/control chars, timeout breve per sessione,
  concorrenza campionamento limitata; la preview non compare MAI in errori o log server.
- `cli`: badge best-effort da `pane_current_command` del pane attivo
  (mappa nota: `claude|codex|pi|gemini|node|zsh|…` → label o niente).
- La lista UI continua col polling attuale; **nessun canale WS nuovo** (YAGNI).

## §3 Frontend desktop (≥1024px, pointer fine)

- **Sidebar** persistente e collassabile: gruppo Flotta (card ricche, ⏻ su spente con
  sheet engine+boot) + gruppo Altre sessioni + `[+ nuova sessione]`.
- **Griglia a colonne**: drag card → drop indicator (bordo colonna = nuova colonna,
  metà tile = split verticale nella colonna); i tile riempiono sempre il 100%;
  divisori trascinabili (flex ratios); chiusura tile → reflow automatico.
  Stato: `{columns:[{width, tiles:[{session, height}]}]}` in localStorage `nc_grid_v1`.
- **Tile**: header = nome + dot stato + badge outbox + azioni (⌨ composer, 📁 file,
  ↗ vista singola, ✕ rimuovi dal grid — la sessione VIVE); xterm con **`takeSize:false`
  obbligatorio**. Attenzione implementativa (audit F6): il server lo supporta già
  (`lib/ws/bridge.js:39`) ma `Terminal.jsx`/`ws-client.js` oggi NON espongono il
  campo — va aggiunta la prop `takeSize` e passata nel frame di attach, con test
  sull'handshake. Inoltre i refs (`sendRef`/`actionRef`/`ctrlRef`) diventano
  **per-tile**: ComposerBar/KeyBar del tile devono parlare SOLO col proprio terminale;
  **focus singolo** (click, bordo evidenziato, tastiera solo lì, `cursorBlink` solo sul
  fuoco); composer per-tile a scomparsa (riuso ComposerBar, mic incluso); FilesPanel
  come overlay del tile. Cap morbido **9 tile**.
- Vista griglia solo su viewport ≥1024px + pointer fine; sotto → home mobile.

## §4 Frontend mobile (stile app Claude Android)

- **Home**: titolo grande, gruppi "Flotta"/"Altre sessioni", card ricche
  (dot attività, engine·key, tempo relativo, preview, badge outbox), celle spente
  con ⏻ → sheet conferma (engine picker + boot toggle), **FAB "+ nuova sessione"**.
- **Vista singola**: struttura attuale (KeyBar + composer, vincolo IME Gboard
  invariato: composer aperto di default su touch) con rifinitura header e transizioni.

## §5 Sicurezza / errori

- Tutto il nuovo dietro Bearer timing-safe esistente; loopback-only invariato.
- Kill: conferma UI + guardia server anti-cella (409). Create: validazioni §2.
- Comandi fleet: seriali, timeout, errori shell → toast con stderr.
- Stati degraded espliciti (mai silenziosi). Preview/detect best-effort: il fallimento
  di un arricchimento non degrada mai la lista sessioni.

## §6 Testing e rollout

- `node --test` (pattern esistente, binari finti da fixture): modulo fleet (parse JSON
  su fixture: valido/campi mancanti/JSON invalido/schemaVersion futuro, guardie, coda,
  timeout, trust-check binario), create/kill (allowlist preset, realpath cwd,
  409 anti-cella ANCHE con fleet unavailable), preview sampler (limiti, strip ANSI),
  degraded. Suite: **126+N pass / 0 fail**.
- Build frontend exit 0; smoke e2e su VPS3 (41777) a fine ciclo. Comandi fleet nei
  test SOLO contro **fake fleet da fixture** (audit F5: `fleet down` ferma
  systemd/tmux reali). Live smoke: percorso read-only (`/api/fleet/status`, griglia
  2 colonne, create/kill di una tmux generica usa-e-getta); un eventuale up/down
  live SOLO su cella esplicitamente disposable, con snapshot/restore di
  engine+boot+active e OK operatore (DAG).
- Mockup **Claude Design/DesignSync** prima del chunk frontend.
- **Esecuzione**: worker GLM-5.2 via crew — key **A** = server+fleet+test,
  key **P** = frontend desktop, poi mobile restyle; coordinator (Fable) = audit,
  gate per chunk, fix finale. Audit esterno Codex su dubbio reale (policy 2026-06-25).

## Fuori scope v0.7

- Facciata pubblica GitHub/npm multi-piattaforma (ciclo dedicato, stile codex-vl).
- TTS in UI, multi-host, PWA skin.
- Renderer WebGL xterm (ottimizzazione successiva se CPU pesa con 6+ tile).
