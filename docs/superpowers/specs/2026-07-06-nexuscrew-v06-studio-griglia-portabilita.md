# Studio v0.6 — Desktop a griglia multi-sessione + installazione npm portabile

Data: 2026-07-06 · Stato: STUDIO (nessuna implementazione) · Base: v0.5.0-vps3.1 (`vps3-special`)
Ordine richiesto da DAG: prima la griglia desktop, poi la portabilità.

---

## Parte 1 — Desktop multi-sessione: griglia trascinabile e ridimensionabile

### Obiettivo

Da desktop, aprire PIÙ sessioni tmux contemporaneamente in una griglia di
riquadri (tile), ognuno un terminale live; tile trascinabili, ridimensionabili,
con layout che si ricorda. Il telefono resta com'è (vista singola).

### Perché è quasi gratis lato server

L'architettura v0.4/v0.5 già regge il multi-attach: **ogni WebSocket = un PTY
`tmux attach` indipendente** (bridge.js), N client concorrenti già gestiti
(la Map `attachedWs` e il push dei frame `files` sono già per-connessione).
Non serve NESSUNA modifica al protocollo. Unico punto d'attenzione: ogni tile
DEVE attaccarsi con `takeSize:false` esplicito (il default "prendi la size se
sei solo" farebbe ridimensionare la sessione alla size del tile piccolo — il
campo esiste già nell'handshake, bridge.js:39).

Costo per tile: 1 processo `tmux attach` + 1 WS. Con 6–9 tile sulla VPS è
irrilevante (~2-3 MB a client tmux).

### Design UI

- **Rotta/vista "Griglia"** (solo pointer fine + viewport ≥ 1024px; toggle
  nell'header della home). La home attuale resta l'ingresso; ogni card
  sessione guadagna un'azione "aggiungi alla griglia" (＋) accanto al tap
  normale (che apre la vista singola come oggi).
- **Layout manager**: `react-grid-layout` (drag + resize + reflow + layout
  serializzabile, ~30 KB gz, zero styling imposto). Il vincolo "zero nuove
  dipendenze frontend" era della v0.5: per la v0.6 UNA dipendenza dedicata è
  giustificata — reimplementare drag/resize/collision a mano è la parte più
  fragile e costosa, non il valore.
- **Tile**: header compatto (nome + dot attached + badge outbox + azioni:
  focus ↗, file 📁, chiudi ✕) + xterm. Config xterm per tile: `fontSize` 11
  default (zoom globale griglia con gli stessi A−/A+), `scrollback 500`,
  `cursorBlink` solo sul tile a fuoco (risparmio CPU con molti terminali).
- **Focus**: un solo tile riceve la tastiera; bordo verde sul tile attivo,
  click per cambiare. Doppio click sull'header → apre la vista singola piena
  (KeyBar + composer, quella attuale).
- **Persistenza layout**: localStorage `nc_grid_layout` = array
  `{session, x, y, w, h}` (formato nativo react-grid-layout). Niente API
  server (YAGNI): il layout è una preferenza del device.
- **Sessione morta**: il tile mostra l'overlay "[sessione finita]" già
  esistente + bottone rimuovi.

### Componenti (stima file)

- `GridView.jsx` + css (layout manager, gestione focus, zoom griglia)
- `GridTile.jsx` + css (header tile + Terminal riusato com'è: già accetta
  `fontSize`, `onFiles`, refs — serve solo la prop `takeSize` passata
  all'handshake, oggi non esposta da `Terminal`/`ws-client`: modifica di 3 righe)
- Home: bottone "griglia" + azione ＋ per card
- App: stato `view: 'home' | 'single' | 'grid'`

### Rischi / decisioni aperte

1. **CPU con molti xterm**: sopra ~9 tile il rendering pesa su laptop deboli.
   Mitigazione: cap morbido a 9 + `cursorBlink` solo sul focus. (Renderer
   WebGL di xterm come ottimizzazione successiva, non nel primo giro.)
2. **KeyBar/composer in griglia**: NON nel primo giro — il composer appartiene
   alla vista singola; in griglia si digita diretto (desktop = tastiera vera).
3. **Stesso session in due tile**: consentito (tmux lo regge), nessun blocco.

**Stima**: 1 giornata worker + audit (la parte server è zero, il Terminal si
riusa intero). Versione target: `0.6.0-vps3.1`.

---

## Parte 2 — Installazione npm unica: Termux / Linux / Mac

### Cosa è GIÀ portabile (eredità v0.4 + scelte v0.5)

- **PTY**: risoluzione provider per piattaforma già in `lib/pty/provider.js` —
  `node-pty` (Linux/macOS), `@lydell/node-pty-linux-x64` (prebuilt), provider
  arm64 nativo su Termux (`@mmmbuto/pty-termux-utils`). Risolto in v0.4.
- **Backend**: express/ws/multer = JS puro. `os.homedir()` corretto ovunque
  (su Termux → `/data/data/com.termux/files/home`).
- **Watcher outbox**: `fs.watch` inaffidabile su alcuni fs Android — il
  fallback a polling è GIÀ nel design v0.5 (silenzioso). Nessun lavoro.
- **Tarball npm**: `package.json.files` include già `frontend/dist/` →
  il pacchetto viaggia con la UI PREBUILT, il target non deve buildare nulla.

### Cosa va parametrizzato (delta piccolo)

1. **Voice**: default `voiceTokenFile=/opt/mcp-voice/state/http.token` è
   VPS3-only. Fix: se il file non c'è e manca `NEXUSCREW_VOICE_TOKEN`, il
   fallback STT si dichiara "non configurato" (già oggi degrada con 502
   pulito; basta rendere il default vuoto fuori da VPS3 — env-first).
   Web Speech nel browser funziona ovunque comunque.
2. **Convenzione porta**: 41820 default upstream vs 41777 profilo VPS3 —
   resta env (`NEXUSCREW_PORT`), nessun codice.
3. **Service manager per piattaforma** (avvio al boot):
   - Linux systemd: `deploy/nexuscrew.service` (già fatto)
   - Termux: `deploy/termux/` — sv script per termux-services (runit) +
     nota `termux-wake-lock`
   - macOS: `deploy/launchd/com.mmmbuto.nexuscrew.plist`
   Solo file di esempio + sezione README; NIENTE installer magico nel primo
   giro (un `nexuscrew install-service` cross-platform è rifinitura futura).
4. **Node path hardcoded nella unit** (nvm v24): variante con
   `/usr/bin/env node` per installazioni globali npm.

### Distribuzione SENZA npm pubblico (repo privato)

Il vincolo "mai npm publish" vale per il registry pubblico. Opzioni:

| Opzione | Comando install | Pro | Contro |
|---|---|---|---|
| **A. Registry npm di Forgejo** (consigliata) | `npm i -g @mmmbuto/nexuscrew --registry https://cloud.alpacalibre.com/git/api/packages/dag/npm/` | versionato, un comando, dist prebuilt nel tarball, auth via token Forgejo | setup una tantum del registry + token sui device |
| B. Tarball su release Forgejo | `npm i -g https://…/releases/download/v0.6.0/nexuscrew.tgz` | zero config registry | URL lungo, auth manuale su repo privato |
| C. `npm i -g git+ssh://forge…` | un comando se hai la chiave SSH | niente artifact | **richiede build della UI sul target** (dist è gitignored): pesante/fragile su Termux → sconsigliata |

Raccomandazione: **A** — Forgejo ha il registry npm nativo; `npm publish
--registry …` dal repo (dist buildata prima, il tarball la contiene), e ogni
device fa UNA install/upgrade con lo stesso comando. La C va esclusa proprio
per il vincolo dist-gitignored.

### Sicurezza invariata

Bind loopback fail-closed e token restano identici su tutte le piattaforme
(su Termux il "tunnel" è spesso solo localhost del telefono stesso — modello
ancora valido).

**Stima**: mezza giornata (parametrizzazione voice + deploy/ variants +
README install + primo publish sul registry Forgejo). Dipende dalla Parte 1
solo per il numero di versione.

---

## Sequenza proposta

1. `0.6.0`: griglia desktop (Parte 1) — worker + audit Codex + smoke mio.
2. `0.6.1`: portabilità + publish registry Forgejo (Parte 2).
3. Post: valutare cherry-pick verso la linea pubblica di ciò che non è
   VPS3-specifico (griglia sì, voice server-side no).

Aperto per DAG: ok a `react-grid-layout` come unica dipendenza nuova? Cap
tile a 9 va bene? Registry Forgejo come canale di distribuzione?
