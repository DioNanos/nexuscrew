# NexusCrew VPS3-special (v0.5 "vps3") — Design

Data: 2026-07-06 · Approvato da DAG (carta bianca esecuzione fino a deploy locale)
Base: branch `v0.4-pty-core` (0.4.3) · Branch di lavoro: `vps3-special` · Remote: Forge (privato)

## Obiettivo

Versione privata di NexusCrew ottimizzata per VPS3: client tmux da browser per la flotta
AI (sessioni tmux lanciate al boot da unit systemd user), con allegati bidirezionali,
voice→testo, lista sessioni e terminale interattivo. Bind `127.0.0.1` porta custom,
raggiungibile SOLO via tunnel SSH / VPN. Nessuna pubblicazione npm/GitHub.

## Decisioni chiave (Q&A con DAG)

1. **Base**: v0.4 pty-core + estensioni. Lo strato chat/sqlite v0.3 resta morto.
2. **Inbox**: upload → copia in cartella condivisa → auto-paste del path nella sessione
   tmux via `send-keys -l` (literal, SENZA Invio — conferma manuale dal terminale).
3. **Outbox**: per-sessione, watcher server-side + badge in UI, download al tap.
4. **Voice**: Web Speech API primario, fallback STT server-side via mcp-voice (:3105).
5. **Distribuzione**: privata, branch dedicato, push solo su Forge. Nessun vincolo di
   branch pubblico.

## 1. Profilo VPS3 e sicurezza

- Bind `127.0.0.1` con `assertLoopback` fail-closed esistente; porta `NEXUSCREW_PORT`,
  default profilo VPS3: **41777** (nella unit systemd).
- Accesso: `ssh -L 41777:127.0.0.1:41777 dag@vps3` o VPN. Nessun vhost, nessun proxy.
- Token file 0600 persistente (`~/.nexuscrew/token`), consegnato in URL fragment.
- **Hardening nuovo**: TUTTI gli endpoint REST (inclusi `/api/sessions` e `/api/config`,
  oggi aperti) richiedono `Authorization: Bearer <token>`. Il WebSocket resta
  token-gated come oggi. Confronto token in tempo costante (riuso `auth/token.js`).
- Unit systemd user `nexuscrew.service`: `Type=simple`, `Restart=on-failure`,
  `WantedBy=default.target`, `Environment=NEXUSCREW_PORT=41777`. Parte al boot con la
  flotta AI.

## 2. Allegati — file exchange bidirezionale

Layout (root configurabile `NEXUSCREW_FILES_ROOT`, default `~/NexusFiles`):

```
~/NexusFiles/<sessione>/inbox/    # UI → AI/CLI
~/NexusFiles/<sessione>/outbox/   # AI/CLI → UI
```

Cartelle create lazy al primo uso. `<sessione>` = nome sessione tmux validato con la
stessa regex di `sessionExists` (`/^[\w.@%:+-]{1,128}$/`) — mai path arbitrari.

### Inbox (upload)

- `POST /api/files/upload` — multipart (multer), campo `file` + `session`.
- Nome sanificato (basename, strip caratteri di controllo/separatori) + prefisso
  timestamp anti-collisione: `20260706-1432_foto.jpg`.
- Limite dimensione: `NEXUSCREW_MAX_UPLOAD` (default 100 MB).
- Dopo il salvataggio il server digita il path assoluto nella sessione tmux con
  `send-keys -l` (literal, senza Enter), come nuova azione allowlisted in
  `lib/tmux/actions.js` (`pastePath`). Se la sessione non esiste → 404, file non salvato.

### Outbox (download)

- Watcher per-sessione: `fs.watch` con debounce (300 ms); se `fs.watch` fallisce o
  emette errore → fallback a polling (5 s) trasparente.
- Notifica: nuovo frame WebSocket `{type:"files", session, files:[...]}` sul canale già
  aperto; la UI mostra badge sulla sessione e aggiorna il pannello.
- `GET /api/files?session=<s>` — lista inbox+outbox (nome, size, mtime).
- `GET /api/files/download?session=<s>&box=outbox&name=<n>` — download con guardia
  path-traversal: `path.resolve` confinato dentro la box, altrimenti 400.
- `DELETE /api/files?session=<s>&box=<b>&name=<n>` — pulizia manuale dal pannello.

### Convenzione flotta

Riga da aggiungere ai CLAUDE.md di cella / loop-script: *"deliverable file per DAG →
`~/NexusFiles/<tua-sessione>/outbox/`"*. (Fuori dal codice; fa parte del deploy.)

## 3. Voice → testo

Nuova **ComposerBar** (comprimibile) sopra la KeyBar: campo testo multilinea, microfono,
graffetta (upload), bottone invio (`send-keys -l` del testo + Enter come azione separata).

- **Primario**: Web Speech API (`SpeechRecognition`), `it-IT`, interim results nel campo.
  Secure context ok su `http://localhost` via tunnel.
- **Fallback** (browser senza Web Speech): MediaRecorder → `POST /api/voice/transcribe`
  (audio/webm|ogg) → il server proxa a `http://127.0.0.1:3105/v1/audio/transcriptions`
  (whisper-local) con token voice letto server-side (`MCP_VOICE_TOKEN` o token-file
  mcp-voice). Testo trascritto → risposta JSON → campo composer. L'audio non lascia la VPS.
- Se mcp-voice è giù → errore leggibile nel composer ("STT non disponibile").
- **TTS: fuori scope** in questa versione (endpoint piper esiste, si aggiunge dopo).

## 4. UI

Shell v0.4 invariata (SessionList | Terminal + KeyBar). Aggiunte:

- **Badge outbox** su ogni sessione in SessionList (conteggio nuovi file).
- **FilesPanel**: slide-over per sessione, tab Inbox/Outbox, upload drag&drop/click,
  download, delete.
- **ComposerBar**: come sopra; stato collassato di default su schermi piccoli.

Nessuno store conversazioni, nessun database: il terminale è la storia.

## 5. Error handling

- Upload fallito / oltre limite → toast con motivo (413/400/404).
- Voice: catena WebSpeech → fallback server → errore leggibile.
- Watcher rotto → downgrade silenzioso a polling (log lato server).
- Sessione tmux sparita tra lista e azione → 404 pulito, UI torna alla lista.
- REST senza/con token errato → 401 uniforme, nessun leak di dettagli.

## 6. Testing

`node --test` (suite v0.4 esistente 18/18 DEVE restare verde):

- token-gate REST: 401 senza token, 200 con token su tutti i nuovi endpoint;
- sanificazione nomi file + anti path-traversal (`../`, assoluti, null byte);
- collisione nomi → suffisso/timestamp, mai overwrite;
- azione `pastePath` allowlisted (literal, no Enter, sessione validata);
- listing/download/delete outbox con box e sessione invalide;
- transcribe: mock del servizio :3105 (successo, giù, audio invalido).

Build frontend (`npm run build`) parte del gate di release.

## 7. Deploy locale (definition of done)

1. Branch `vps3-special` pushato su Forge.
2. `nexuscrew.service` user unit installata e attiva al boot.
3. Server su `127.0.0.1:41777`, token stampato, raggiungibile via tunnel SSH.
4. Smoke reale: lista sessioni flotta visibile, attach a una sessione live, upload di
   un file che appare in inbox + path digitato nella sessione, file creato in outbox
   che genera badge e si scarica, voice fallback trascrive un sample.
5. Suite test verde + build frontend ok.

## Fuori scope (esplicito)

TTS in UI · create/kill/rename sessioni · multi-host · pubblicazione npm ·
esposizione di rete non-loopback.
