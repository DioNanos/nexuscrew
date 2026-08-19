'use strict';
// lib/live-host/bridge.js — il ponte Live (fetta 3, contratto rev5 + rev4 LC).
//
// Esposizione: POST /api/live-host/bridge (montata in routes.js, stesso
// requireToken e stessa policy local-only del proxy: LOCAL_ONLY_PREFIXES copre
// l'intero prefisso /api/live-host, quindi nessun peer federato può innescare
// il ponte). La chiamata rappresenta l'avvio di una Live sul nodo: chi la fa è
// il lato app-server della stessa feature (non costruito qui), e il risultato
// dice su che cosa quella Live va a operare.
//
// Invarianti (contratto fetta 3):
//   - MC1: la designazione si legge con UNA GET su loopback verso
//     /api/live-host, autenticata col token del nodo. Nessun accesso diretto
//     allo store: la route è l'unica verità, `eligible` non si ricalcola.
//   - MC1.5 / JC3.3: nessuna attesa introdotta. Ogni fase ha il limite
//     dichiarato cfg.liveBridgeTimeoutMs; oltre quello, o su qualunque
//     fallimento, la risposta è `none` col motivo: la Live parte senza
//     puntamento, comportamento standard. Un `none` non è un errore HTTP.
//   - MC2: il prompt per-cella (LIVE_PROMPT.md accanto ai canonici della
//     cella) viaggia su developerInstructions di thread/start e SOSTITUISCE
//     le developer instructions della config per quella Live (rev4 LC2
//     emendata da rev5 MC2). La riga che decide è in codex-rs
//     core/src/config/mod.rs: `developer_instructions.or(cfg.developer_
//     instructions)` — l'override Some scarta il valore di config. R2
//     (2026-08-16, verso corretto dopo audit pre-release): l'identità della
//     cella designata viaggia SEMPRE come intestazione anteposta al campo,
//     anche senza prompt. Il campo NON è additivo: una cella senza
//     LIVE_PROMPT.md, che prima non passava nulla e riceveva le developer
//     instructions della config, ora passa la sola intestazione e QUELLE
//     NON le riceve più. Restano fuori da questa sostituzione AGENTS.md e
//     il world state (fragment user, canale separato) e il prompt base.
//     La via designata per le istruzioni di lavoro della Live è il
//     LIVE_PROMPT.md della cella: viaggia nello stesso campo.
//   - MC3: il ponte crea le proprie conversazioni con thread/start e non
//     tocca MAI la thread di una TUI — né turn/start né thread/resume: chi
//     guarda i metodi visti dal server deve vedere solo initialize,
//     initialized e thread/start. Per questo l'aggancio funziona anche su una
//     cella che sta già processando un turno: conversazioni separate, nessuna
//     interruzione (rev1 HC2/rev2 JC4).
//   - MC3.3: la connessione al socket di controllo è ON-DEMAND (connect →
//     handshake → thread/start → close), mai permanente: la fuga notifiche
//     notata in rev5 riguarda i client permanenti.
//   - MC3.4: il ponte opera SOLO sulla cella designata — non accetta target
//     dal chiamante, la designazione è la condizione (LC3).
//   - MC0: isolabile — cfg.liveBridgeEnabled=false e il ponte non si connette
//     mai, non fa GET, risponde `none` senza toccare nulla.
//
// Protocollo del socket di controllo (misurato sul runtime 2026-08-15):
// WebSocket (text frame) sopra unix socket, JSON-RPC. Handshake: request
// `initialize` → response {userAgent, codexHome} → notifica `initialized`
// (senza params). Poi `thread/start` {cwd, developerInstructions?} → response
// {thread:{id}, cwd}. Il socket è 0600 dell'utente: il confine è quello
// (MC1.3), non c'è autenticazione applicativa.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ws+unix:// è supportato nativamente da ws >= 8 (isIpcUrl): il path prima dei
// `:` è il socket, dopo è la resource. Iniettabile per i test.
let WebSocketImpl = null;
function defaultWebSocket() {
  if (!WebSocketImpl) WebSocketImpl = require('ws');
  return WebSocketImpl;
}

const CLIENT_NAME = 'nexuscrew-live-bridge';
// Finestra concessa alla risposta di una thread/start ancora in volo quando il
// ponte ha gia' dichiarato l'esito: se arriva, la thread e' nata davvero e la
// chiudiamo. Breve di proposito — non allunga la risposta a chi ha chiesto il
// ponte, che e' gia' stata data.
const ORPHAN_GRACE_MS = 1500;

// —— Prompt per-cella (rev4 LC2, nome fisso confermato il 2026-08-15) ——
// Collocazione: filesRoot/<tmuxSession>/LIVE_PROMPT.md — la sessione tmux
// ESATTA che il roster dichiara per la cella designata, la stessa fonte gia'
// usata per l'intestazione R2 (identityHeader). NON un prefisso ricostruito a
// mano: fino al 2026-08-16 questa funzione anteponeva 'cloud-' come default
// universale quando il cellId non ce l'aveva gia' — su un device che chiama
// le proprie sessioni con un prefisso diverso il file non veniva MAI trovato,
// e l'esito era 'missing' ("assenza legittima"): il bug si mascherava
// esattamente nel ramo che avrebbe dovuto segnalarlo. Bug trovato scrivendo
// docs/LIVE_PROMPT.md, corretto qui.
//
// Quattro esiti DISTINTI, perché «non so nemmeno dove cercare», «ho cercato
// e non c'è» e «c'è ma non si può leggere» portano chi indaga in posti
// diversi:
//   applied:true                        → il testo va su developerInstructions
//   applied:false, reason session-unknown → il roster non dichiara la sessione
//                                   tmux per questa cella: NESSUN path viene
//                                   costruito (mai un prefisso indovinato),
//                                   quindi non si tenta nemmeno la lettura
//   applied:false, reason missing       → ENOENT sul path dichiarato: assenza
//                                   legittima (LC2.3), si procede senza
//                                   PROMPT (R2: l'intestazione identità
//                                   viaggia comunque). ATTENZIONE: il campo
//                                   developerInstructions viene comunque
//                                   inviato per via dell'intestazione, e il
//                                   consumer lo SOSTITUISCE alla propria
//                                   configurazione invece di sommarlo — chi
//                                   non ha prompt per-cella non riceve le
//                                   developer instructions globali che
//                                   riceveva prima (vedi MC2, verificato
//                                   sulla riga che decide)
//   applied:false, reason unreadable|empty → presente ma inutilizzabile: va
//                                   dichiarato, mai silenziato
function readCellPrompt(filesRoot, tmuxSession) {
  if (typeof tmuxSession !== 'string' || !tmuxSession) return { applied: false, reason: 'session-unknown' };
  const file = path.join(filesRoot, tmuxSession, 'LIVE_PROMPT.md');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { applied: false, reason: 'missing' };
    return { applied: false, reason: 'unreadable', detail: String((e && e.code) || e) };
  }
  const text = String(raw).trim();
  if (!text) return { applied: false, reason: 'empty' };
  return { applied: true, source: 'LIVE_PROMPT.md', text };
}

// —— Identità della Live (R2, 2026-08-16): la porta il ponte, non il prompt ——
// Il ponte ha la designazione IN MANO (MC3.4: è la sua condizione di
// funzionamento) e un prompt può legittimamente mancare (MC2.4): se
// l'identità dipendesse dal prompt, l'assenza del prompt diventerebbe assenza
// di identità — è esattamente il difetto visto sul campo (la voce andava a
// leggere tmux per capire dove si trovava).
//
// R30 (v2, 2026-08-19): l'intestazione dice anche COME raggiungere i tool
// NexusCrew. Il daemon app-server espone UN solo insieme di server MCP a
// tutte le Live, con l'ambiente del daemon: nexuscrew è l'unico che prende
// l'identità dall'ambiente ereditato, quindi i suoi tool con sessione
// resterebbero fail-closed (nc_identity: MISSING). La via d'uscita ce l'ha
// il ponte: il nome esatto della sessione, che il server MCP accetta da
// NEXUSCREW_MCP_SESSION via stdio. Il valore NON si mette in systemd
// Environment= (una identità statica condivisa = impersonare una cella
// fissa, demolito in audit v1): lo dice l'intestazione, per-cella.
//
// Il fatto, niente di più: quale cella (id Fleet) e, se il roster la dichiara,
// la sessione tmux esatta — quella con cui la voce raggiunge i canonici della
// cella in ~/NexusFiles/<tmuxSession>/ — e la via ai tool per quella sessione.
// Restano qui FUORI le istruzioni di lavoro: quelle vivono nel prompt
// per-cella, che questa intestazione PRECEDE sempre.
//
// Senza tmuxSession dichiarata non c'è identità possibile: il testo lo DICE,
// non suggerisce un comando che fallirebbe comunque (e una sessione indovinata
// sarebbe l'identità di un'altra cella).
function identityHeader(cellId, tmuxSession) {
  if (!tmuxSession) {
    return `Live NexusCrew agganciata alla cella ${cellId}. `
      + 'Il roster non dichiara una sessione tmux per questa cella: senza sessione '
      + 'non c\'è identità, quindi i tool NexusCrew che la richiedono non sono '
      + 'raggiungibili da questa Live.';
  }
  return `Live NexusCrew agganciata alla cella ${cellId} (sessione tmux ${tmuxSession}). `
    + 'Questa Live eredita l\'ambiente del daemon, condiviso fra tutte le Live e senza identità: '
    + 'i tool NexusCrew che richiedono la sessione restano chiusi finché non li chiami con la tua. '
    + 'Per usarli avvia il server MCP NexusCrew via stdio con la sessione di questa cella '
    + `nell'ambiente — NEXUSCREW_MCP_SESSION=${tmuxSession} nexuscrew mcp — e parlagli `
    + 'JSON-RPC su stdin (initialize, notifications/initialized, tools/call). '
    + `Il valore esatto per questa conversazione è ${tmuxSession}: mai un'altra sessione.`;
}

// —— Client on-demand del socket di controllo (sezione protocollo sopra) ——
// Una sola richiesta per connessione: aperta, handshake, thread/start, chiusa.
// Le eventuali notifiche broadcast che arrivano nel frattempo vengono ignorate
// e la finestra resta minima.
function startThreadOnControlSocket({
  socketPath, cwd, developerInstructions, timeoutMs,
  WebSocket = defaultWebSocket(), now = () => Date.now(), log = () => {},
}) {
  return new Promise((resolve, reject) => {
    const deadline = now() + timeoutMs;
    let settled = false;
    let nextId = 0;
    const pending = new Map();
    let ws;
    // Id della richiesta thread/start: serve a riconoscerne la risposta anche
    // quando arriva dopo che abbiamo gia' risolto, per non lasciare orfana una
    // thread che nel frattempo e' nata davvero.
    let startRequestId = null;
    let orphanTimer = null;

    // Chiusura del socket, separata dalla risoluzione della promessa: chi ha
    // chiesto il ponte riceve subito la risposta, la pulizia puo' prendersi
    // qualche istante in piu'.
    const chiudi = () => {
      try {
        if (!ws) return;
        // Se non e' OPEN, `close()` non fa nulla e la connessione resta
        // appesa: su un socket in CONNECTING l'evento 'open' scatterebbe DOPO,
        // e senza la guardia in cima al gestore aprirebbe una thread su un
        // ponte gia' risolto. `terminate()` la chiude davvero.
        if (ws.readyState === WebSocket.OPEN) ws.close(1000); else ws.terminate();
      } catch (_) { /* best effort */ }
    };

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Se una thread/start e' ancora in volo, la thread potrebbe nascere UN
      // ISTANTE DOPO che abbiamo dichiarato il fallimento: chiudere ora la
      // lascerebbe orfana, viva e senza nessuno che la usi. Diamo una finestra
      // breve per riceverne la risposta e chiuderla noi. E' best effort, ma la
      // differenza fra "nessuno la chiude" e "quasi sempre la chiudiamo" e'
      // esattamente il difetto.
      if (startRequestId !== null && pending.has(startRequestId)) {
        orphanTimer = setTimeout(chiudi, ORPHAN_GRACE_MS);
      } else {
        chiudi();
      }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => {
      done(Object.assign(new Error('control socket timeout'), { code: 'ETIMEOUT' }));
    }, timeoutMs);

    try {
      ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: timeoutMs });
    } catch (e) {
      done(Object.assign(new Error(`control socket: ${e.message}`), { code: 'ESOCKET' }));
      return;
    }

    const send = (obj) => ws.send(JSON.stringify(obj));
    const request = (method, params) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      send({ jsonrpc: '2.0', id, method, params });
    });
    // Come `request`, ma comunica l'id al chiamante prima di attendere: serve a
    // riconoscere la risposta tardiva di thread/start.
    const requestTracked = (method, params, onId) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      onId(id);
      send({ jsonrpc: '2.0', id, method, params });
    });

    ws.on('open', async () => {
      // Il ponte puo' essere gia' stato risolto (timeout durante l'handshake):
      // procedere qui aprirebbe una thread che nessuno aspetta piu'.
      if (settled) { chiudi(); return; }
      try {
        await request('initialize', {
          clientInfo: { name: CLIENT_NAME, title: 'NexusCrew Live Bridge', version: bridgeVersion() },
          capabilities: { experimentalApi: true },
        });
        send({ jsonrpc: '2.0', method: 'initialized' }); // notifica, senza params
        const params = { cwd };
        if (developerInstructions) params.developerInstructions = developerInstructions;
        const out = await requestTracked('thread/start', params, (id) => { startRequestId = id; });
        const threadId = out && out.thread && out.thread.id;
        if (!threadId) {
          done(Object.assign(new Error('thread/start senza thread.id'), { code: 'EPROTO' }));
          return;
        }
        done(null, { threadId, cwd: out.cwd || cwd });
      } catch (e) {
        done(e);
      }
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch (_) { return; /* frame non JSON: ignorato */ }
      // Risposta tardiva a thread/start su un ponte gia' risolto: la thread
      // ESISTE. Chiuderla e' l'unica cosa che la distingue da un'orfana.
      if (settled && msg && msg.id != null && msg.id === startRequestId) {
        pending.delete(msg.id);
        const threadId = msg.result && msg.result.thread && msg.result.thread.id;
        if (threadId) {
          try { send({ jsonrpc: '2.0', id: ++nextId, method: 'thread/stop', params: { threadId } }); } catch (_) { /* best effort */ }
          log({ event: 'live-bridge', outcome: 'orphan-thread-stopped', threadId });
        }
        if (orphanTimer) { clearTimeout(orphanTimer); orphanTimer = null; }
        setTimeout(chiudi, 50);
        return;
      }
      if (msg && msg.id != null && pending.has(msg.id)) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter.rej(Object.assign(new Error(msg.error.message || 'jsonrpc error'), { code: 'ERPC', detail: msg.error }));
        else waiter.res(msg.result);
        return;
      }
      // Notifiche broadcast e risposte non attese: ignorate (connessione
      // on-demand, la finestra di esposizione alla fuga MC3.3 è minima).
    });

    ws.on('error', (e) => done(Object.assign(new Error(`control socket: ${e.message}`), { code: 'ESOCKET' })));
    ws.on('close', () => {
      if (!settled) done(Object.assign(new Error('control socket chiuso prima della risposta'), { code: 'ESOCKET' }));
    });
    void deadline; // il timer copre l'intera finestra, il deadline è informativo
  });
}

// —— Il ponte ——
function createLiveBridge({
  cfg,
  fleetP,
  tokenGet,
  filesRoot,
  fetchImpl = globalThis.fetch,
  WebSocket,
  now = () => Date.now(),
  log = () => {},
}) {
  const root = filesRoot || cfg.filesRoot || path.join(os.homedir(), 'NexusFiles');

  const none = (reason, extra) => ({ mode: 'none', reason, ...(extra || {}), at: now() });

  // MC1: la designazione si legge dalla ROUTE, con il token del nodo, entro
  // il limite dichiarato. retry no, cache no: una lettura per avvio Live.
  async function readDesignation() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.liveBridgeTimeoutMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${cfg.port}/api/live-host`, {
        headers: { authorization: `Bearer ${tokenGet()}` },
        signal: ctrl.signal,
      });
      if (res.status !== 200) {
        const e = new Error(`live-host HTTP ${res.status}`);
        e.code = 'EHTTP';
        throw e;
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function rosterCell(cellId) {
    const fleet = await fleetP;
    if (!fleet || fleet.available !== true) return null;
    const statusFn = fleet && (typeof fleet.status === 'function' ? fleet.status : fleet.cellStatus);
    if (typeof statusFn !== 'function') return null;
    // La cwd va chiesta: la vista pubblica non la porta piu', perche' finiva
    // anche nella risposta federata di /fleet/status.
    const st = await statusFn.call(fleet, { includeCwd: true });
    const cells = Array.isArray(st && st.cells) ? st.cells : [];
    return cells.find((c) => c && c.cell === cellId) || null;
  }

  // Risolve il puntamento per l'avvio di una Live. Sempre una risposta utile:
  // i `none` sono modi legittimi di non puntare, e il reason distingue le
  // cause (designazione assente, cella non idonea, fallback su fallimento).
  async function resolveForLive() {
    if (cfg.liveBridgeEnabled !== true) return none('bridge-disabled');

    let snap;
    try {
      snap = await readDesignation();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)));
      return none(aborted ? 'live-host-timeout' : 'live-host-unreachable');
    }
    if (!snap || snap.hostCell == null) return none('no-designation');
    // Tre condizioni diverse, tre nomi: la designazione dichiarata non
    // eleggibile dall'hub, la cella che non esiste piu' nel roster, e la cella
    // che c'e' ma e' spenta. Un nome solo mandava a guardare l'hub anche quando
    // il problema era una sessione chiusa. Rilievo di un audit indipendente.
    if (snap.eligible !== true) return none('host-ineligible');

    let cell;
    try {
      cell = await rosterCell(snap.hostCell);
    } catch (_) {
      cell = null;
    }
    if (!cell) return none('host-cell-unknown');
    if (cell.active !== true) return none('host-cell-inactive');
    if (typeof cell.cwd !== 'string' || !cell.cwd) return none('cell-cwd-unknown');

    // JC2: la modalità è una funzione dell'engine, non una scelta. Nativa solo
    // su engine codex-vl (il thread ponte vive nell'app-server del fork); per
    // qualunque altro engine la Live lavora ATTRAVERSO la cella e il ponte non
    // ha nulla da creare qui.
    const engine = String(cell.engine || '');
    // Stessa fonte dell'intestazione qui sotto: la sessione tmux che il
    // roster dichiara, mai il cellId ricostruito con un prefisso indovinato.
    const prompt = readCellPrompt(root, cell.tmuxSession);

    if (!engine.startsWith('codex-vl')) {
      const out = {
        mode: 'tmux', cell: snap.hostCell, engine: cell.engine || null, cwd: cell.cwd,
        // JC5.5: in modalità tmux le regole le applica la cella; nessuna
        // iniezione da parte del ponte.
        prompt: { applied: false, reason: 'tmux-mode' },
        at: now(),
      };
      log(`[live-bridge] Live su ${snap.hostCell} in modalita' tmux (engine ${engine || 'sconosciuto'})`);
      return out;
    }

    // R2: l'identità viaggia SEMPRE, anteposta al prompt quando c'è. Il campo
    // non è mai più assente: senza LIVE_PROMPT.md porta la sola intestazione
    // — e poiché il campo SOSTITUISCE le developer instructions della config
    // (vedi MC2: la .or() in config/mod.rs), quella cella non le riceve più.
    const intestazione = identityHeader(snap.hostCell, cell.tmuxSession);
    const developerInstructions = prompt.applied
      ? `${intestazione}\n\n${prompt.text}`
      : intestazione;

    let started;
    try {
      started = await startThreadOnControlSocket({
        socketPath: cfg.liveBridgeSocketPath,
        cwd: cell.cwd,
        developerInstructions,
        timeoutMs: cfg.liveBridgeTimeoutMs,
        WebSocket,
        log,
      });
    } catch (e) {
      const reason = e && e.code === 'ETIMEOUT' ? 'bridge-timeout' : 'bridge-socket-failed';
      log(`[live-bridge] thread ponte NON creata (${reason}): ${e.message}`);
      return none(reason, { cell: snap.hostCell, detail: String(e.message) });
    }

    const { text, ...promptEcho } = prompt; // il testo del prompt non viaggia in risposta
    const out = {
      mode: 'native', cell: snap.hostCell, engine,
      threadId: started.threadId, cwd: started.cwd,
      prompt: promptEcho,
      socketPath: cfg.liveBridgeSocketPath,
      at: now(),
    };
    // LC1.4: il puntamento è visibile lato nostro — log con cella, thread e
    // prompt applicato. È il "dirottamento dichiarato" del contratto. Il
    // campo SOSTITUISCE le developer instructions della config (MC2, la
    // .or() in config/mod.rs): il log lo dichiara, perché chi lo legge sappia
    // cosa quella Live NON riceve.
    log(`[live-bridge] Live puntata su ${snap.hostCell}: thread ${started.threadId} (cwd ${started.cwd}, identità nell'intestazione, prompt ${prompt.applied ? 'per-cella applicato' : `non applicato (${promptEcho.reason})`}, sostituisce le developer instructions di config)`);
    return out;
  }

  return { resolveForLive, readCellPrompt: (tmuxSession) => { const { text, ...rest } = readCellPrompt(root, tmuxSession); return rest; } };
}

let cachedVersion = null;
function bridgeVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = require('../../package.json').version || '0';
  } catch (_) {
    cachedVersion = '0';
  }
  return cachedVersion;
}

module.exports = { createLiveBridge, readCellPrompt, startThreadOnControlSocket, CLIENT_NAME };
