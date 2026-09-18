'use strict';
// lib/live-host/bridge.js — the Live bridge (contract revision rev6 + rev4 LC).
//
// Exposure: POST /api/live-host/bridge, mounted in routes.js. Reaching
// /api/live-host directly stays a local-only path (LOCAL_ONLY_PREFIXES covers
// the whole prefix), so a peer cannot knock on the bridge that way. A peer CAN
// ask for it through the federated route /api/route/<nodes>/_/live-host/bridge:
// that is the allowlisted path of the federation, the node that owns the cell
// grants the per-peer permission (liveHostAccess, denied by default), and the
// request carries the hop proof the server signs for the last hop. A federated
// body may add one single field, `{expect}`: what the caller believes it is
// pointing at, checked by the owner against its own saved designation — a
// mismatch is a named 409.
//
// The resolution itself is unchanged: it is the SAVED designation, read where
// it lives, so no caller picks a target, locally or across nodes. The call
// represents starting a Live on the node: the app-server side of the same
// feature makes it (not built here), and the answer says what that Live is
// going to operate on.
//
// Invarianti (contratto fetta 3):
// La designazione si legge con UNA GET su loopback verso
//     /api/live-host, autenticata col token del nodo. Nessun accesso diretto
//     allo store: la route è l'unica verità, `eligible` non si ricalcola.
// Nessuna attesa introdotta. Ogni fase ha il limite
//     dichiarato cfg.liveBridgeTimeoutMs; oltre quello, o su qualunque
//     fallimento, la risposta è `none` col motivo: la Live parte senza
//     puntamento, comportamento standard. Un `none` non è un errore HTTP.
// Il prompt per-cella (LIVE_PROMPT.md accanto ai canonici della
//     cella) viaggia su developerInstructions di thread/start e SOSTITUISCE
// Le developer instructions della config per quella Live (rev4
// Emendata da rev5). La riga che decide è in codex-rs
//     core/src/config/mod.rs: `developer_instructions.or(cfg.developer_
// Instructions)` — l'override Some scarta il valore di config.
//     (verso corretto dopo revisione pre-release): l'identità della
//     cella designata viaggia SEMPRE come intestazione anteposta al campo,
//     anche senza prompt. Il campo NON è additivo: una cella senza
//     LIVE_PROMPT.md, che prima non passava nulla e riceveva le developer
//     instructions della config, ora passa la sola intestazione e QUELLE
//     NON le riceve più. Restano fuori da questa sostituzione AGENTS.md e
//     il world state (fragment user, canale separato) e il prompt base.
//     La via designata per le istruzioni di lavoro della Live è il
//     LIVE_PROMPT.md della cella: viaggia nello stesso campo.
// Il ponte crea le proprie conversazioni con thread/start e non
//     tocca MAI la thread di una TUI — né turn/start né thread/resume. La sonda
//     thread/read e' separata e sola lettura: non modifica il thread ponte ne'
//     quello della TUI. Per questo l'aggancio funziona anche su una cella che
//     sta già processando un turno: conversazioni separate, nessuna
// Interruzione (rev1 /rev2).
// La connessione al socket di controllo è ON-DEMAND (connect →
//     handshake → thread/start → close), mai permanente: la fuga notifiche
//     notata in rev5 riguarda i client permanenti.
// Il ponte opera SOLO sulla cella designata — non accetta target
// Dal chiamante, la designazione è la condizione.
// Isolabile — cfg.liveBridgeEnabled=false e il ponte non si connette
//     mai, non fa GET, risponde `none` senza toccare nulla.
//
// Protocollo del socket di controllo (misurato sul runtime 2026-08-15):
// WebSocket (text frame) sopra unix socket, JSON-RPC. Handshake: request
// `initialize` → response {userAgent, codexHome} → notifica `initialized`
// (senza params). Poi `thread/start` {cwd, developerInstructions?} → response
// {thread:{id}, cwd}, oppure `thread/read` {threadId, includeTurns:false} per
// leggere il runtime. Il socket è 0600 dell'utente: il confine è quello
// Non c'è autenticazione applicativa.

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
const THREAD_STATUS_CACHE_MS = 1500;

function normalizedThreadStatus(status) {
  const type = typeof status === 'string' ? status : status && status.type;
  switch (String(type || '').toLowerCase()) {
    case 'notloaded': return 'absent';
    case 'idle': return 'present';
    case 'active': return 'active';
    // A server-reported system error is not evidence that the thread is absent.
    case 'systemerror': return 'unknown';
    default: return null;
  }
}

// Query on-demand del runtime del thread. La connessione e' dedicata a una
// sola lettura: ogni uscita, inclusi timeout ed errore di protocollo, chiude il
// WebSocket prima di risolvere la Promise. Il valore restituito e' volutamente
// piu' stretto del protocollo: presente/attivo/assente, oppure il chiamante
// classifica il fallimento come unknown.
function queryThreadStatusOnControlSocket({
  socketPath, threadId, timeoutMs, WebSocket = defaultWebSocket(),
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let nextId = 0;
    let ws;
    const close = (force = false) => {
      try {
        if (!ws) return;
        if (!force && ws.readyState === WebSocket.OPEN) ws.close(1000); else ws.terminate();
      } catch (_) { /* best effort: il socket verra' raccolto dal peer */ }
    };
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close(!!error);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      done(Object.assign(new Error('control socket thread/read timeout'), { code: 'ETIMEOUT' }));
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
      ws.pending = ws.pending || new Map();
      ws.pending.set(id, { res, rej });
      send({ jsonrpc: '2.0', id, method, params });
    });

    ws.on('open', async () => {
      if (settled) { close(); return; }
      try {
        await request('initialize', {
          clientInfo: { name: CLIENT_NAME, title: 'NexusCrew Thread Status', version: bridgeVersion() },
          capabilities: { experimentalApi: true },
        });
        send({ jsonrpc: '2.0', method: 'initialized' });
        const out = await request('thread/read', { threadId, includeTurns: false });
        const value = normalizedThreadStatus(out && out.thread && out.thread.status);
        if (!value) throw Object.assign(new Error('thread/read senza stato thread riconoscibile'), { code: 'EPROTO' });
        done(null, value);
      } catch (e) {
        done(e);
      }
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch (_) { return; }
      if (msg && msg.id != null && ws.pending && ws.pending.has(msg.id)) {
        const waiter = ws.pending.get(msg.id);
        ws.pending.delete(msg.id);
        if (msg.error) waiter.rej(Object.assign(new Error(msg.error.message || 'jsonrpc error'), { code: 'ERPC', detail: msg.error }));
        else waiter.res(msg.result);
      }
    });

    ws.on('error', (e) => done(Object.assign(new Error(`control socket: ${e.message}`), { code: 'ESOCKET' })));
    ws.on('close', () => {
      if (!settled) done(Object.assign(new Error('control socket chiuso prima della risposta'), { code: 'ESOCKET' }));
    });
  });
}

// — Prompt per-cella (rev4, nome fisso confermato il 2026-08-15) ——
// Collocazione: filesRoot/<tmuxSession>/LIVE_PROMPT.md — la sessione tmux
// ESATTA che il roster dichiara per la cella designata, la stessa fonte gia'
// Usata per l'intestazione (identityHeader). NON un prefisso ricostruito a
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
// Legittima, si procede senza
// PROMPT: the identity header
//                                   viaggia comunque). ATTENZIONE: il campo
//                                   developerInstructions viene comunque
//                                   inviato per via dell'intestazione, e il
//                                   consumer lo SOSTITUISCE alla propria
//                                   configurazione invece di sommarlo — chi
//                                   non ha prompt per-cella non riceve le
//                                   developer instructions globali che
// Riceveva prima (verificato
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

// — Identità della Live (2026-08-16): la porta il ponte, non il prompt ——
// Il ponte ha la designazione IN MANO: è la sua condizione di
// Funzionamento) e un prompt può legittimamente mancare: se
// l'identità dipendesse dal prompt, l'assenza del prompt diventerebbe assenza
// di identità — è esattamente il difetto visto sul campo (la voce andava a
// leggere tmux per capire dove si trovava).
//
// (v2, 2026-08-19): the header also states HOW to reach the tools
// NexusCrew. Il daemon app-server espone UN solo insieme di server MCP a
// tutte le Live, con l'ambiente del daemon: nexuscrew è l'unico che prende
// l'identità dall'ambiente ereditato, quindi i suoi tool con sessione
// resterebbero fail-closed (nc_identity: MISSING). La via d'uscita ce l'ha
// il ponte: il nome esatto della sessione, che il server MCP accetta da
// NEXUSCREW_MCP_SESSION via stdio. Il valore NON si mette in systemd
// Environment= (una identità statica condivisa = impersonare una cella
// fissa, demolito in revisione v1): lo dice l'intestazione, per-cella.
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
  declaredSession,
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
          clientInfo: {
            name: CLIENT_NAME,
            title: 'NexusCrew Live Bridge',
            version: bridgeVersion(),
            // Identita della connessione: la sessione gia' risolta della cella
            // Designata (mai env grezzi, mai guess — roster). Se assente
            // il campo SI OMETTE (Option None lato protocollo): il resolver a
            // valle classifica MISSING nominando la causa; sanitizzare qui la
            // duplicherebbe senza guadagno.
            ...(declaredSession ? { nexuscrewSession: declaredSession } : {}),
          },
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
      // On-demand, la finestra di esposizione alla fuga è minima).
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
  const threadIdsByCell = new Map();
  const threadStatusCache = new Map();
  const threadStatusInFlight = new Map();
  // Riserve in-process per l'avvio Live. La chiave è la cella host: una
  // sola start provvisoria per cella alla volta, e il commit ricontrolla la
  // tupla congelata in riserva prima di accettare il thread creato.
  const pendingLiveByCell = new Map();
  const threadStatusCacheMs = Number.isFinite(cfg.liveThreadStatusCacheMs)
    ? Math.max(0, cfg.liveThreadStatusCacheMs) : THREAD_STATUS_CACHE_MS;

  const none = (reason, extra) => ({ mode: 'none', reason, ...(extra || {}), at: now() });

  // La designazione si legge dalla ROUTE, con il token del nodo, entro
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

  // Tupla dell'avvio Live come la osserva questo ponte: designazione (cella,
  // revision, idoneità) più stato firmato del lease dell'host. Generation ed
  // epoch arrivano dallo stesso status quando il lease manager li espone.
  function liveTuple(snap, leaseStatus) {
    const lease = leaseStatus && typeof leaseStatus === 'object' ? leaseStatus : { state: leaseStatus };
    return JSON.stringify({
      hostCell: snap ? snap.hostCell : null,
      revision: snap ? snap.revision : null,
      eligible: snap ? snap.eligible === true : false,
      lease: {
        state: lease.state == null ? null : lease.state,
        leaseId: lease.leaseId == null ? null : lease.leaseId,
        generation: lease.generation == null ? null : lease.generation,
        launchEpoch: lease.launchEpoch == null ? null : lease.launchEpoch,
      },
    });
  }

  async function leaseTupleFor(cellId) {
    try {
      const fleet = await fleetP;
      const lease = fleet && fleet.lease;
      if (!lease || typeof lease.status !== 'function') return { state: 'unavailable' };
      return lease.status(cellId) || { state: 'none' };
    } catch (_) {
      return { state: 'unavailable' };
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

  async function threadStatus(cellId) {
    const threadId = threadIdsByCell.get(cellId);
    if (!threadId) return 'unknown';

    const current = now();
    const cached = threadStatusCache.get(cellId);
    if (cached && cached.expiresAt > current) return cached.value;
    if (cached) threadStatusCache.delete(cellId);
    if (threadStatusInFlight.has(cellId)) return threadStatusInFlight.get(cellId);

    const query = queryThreadStatusOnControlSocket({
      socketPath: cfg.liveBridgeSocketPath,
      threadId,
      timeoutMs: cfg.liveBridgeTimeoutMs,
      WebSocket,
    }).catch(() => 'unknown').then((value) => {
      // Anche unknown e' la risposta della query corrente: non riusiamo un
      // valore buono oltre la sua finestra, e il prossimo tick potra' misurare
      // di nuovo il nodo.
      threadStatusCache.set(cellId, { value, expiresAt: now() + threadStatusCacheMs });
      return value;
    }).finally(() => { threadStatusInFlight.delete(cellId); });
    threadStatusInFlight.set(cellId, query);
    return query;
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
    // il problema era una sessione chiusa. Rilievo di una revisione indipendente.
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

    // La modalità è una funzione dell'engine, non una scelta. Nativa solo
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
        // In modalità tmux le regole le applica la cella; nessuna
        // iniezione da parte del ponte.
        prompt: { applied: false, reason: 'tmux-mode' },
        at: now(),
      };
      log(`[live-bridge] Live su ${snap.hostCell} in modalita' tmux (engine ${engine || 'sconosciuto'})`);
      return out;
    }

    // L'identità viaggia SEMPRE, anteposta al prompt quando c'è. Il campo
    // non è mai più assente: senza LIVE_PROMPT.md porta la sola intestazione
    // — e poiché il campo SOSTITUISCE le developer instructions della config
// (see: the .or() in config/mod.rs), that cell no longer receives them.
    const intestazione = identityHeader(snap.hostCell, cell.tmuxSession);
    const developerInstructions = prompt.applied
      ? `${intestazione}\n\n${prompt.text}`
      : intestazione;

    // Riserva della tupla e start provvisorio. Finché il commit non
    // ricontrolla la stessa tupla, il thread NON viene accettato: nessun tool
    // può attraversarlo, perché il ponte non ne registra l'id.
    if (pendingLiveByCell.has(snap.hostCell)) return none('reservation-in-flight');
    const reservedLease = await leaseTupleFor(snap.hostCell);
    const reservedTuple = liveTuple(snap, reservedLease);
    pendingLiveByCell.set(snap.hostCell, reservedTuple);

    let started;
    try {
      started = await startThreadOnControlSocket({
        socketPath: cfg.liveBridgeSocketPath,
        cwd: cell.cwd,
        developerInstructions,
        // Stessa fonte dell'intestazione e del prompt per-cella (roster:
        //). Dichiarata per connessione: batte qualunque ambiente
        // Ereditato, anche quando e' popolato ma stantio (-bis).
        declaredSession: cell.tmuxSession,
        timeoutMs: cfg.liveBridgeTimeoutMs,
        WebSocket,
        log,
      });
    } catch (e) {
      const reason = e && e.code === 'ETIMEOUT' ? 'bridge-timeout' : 'bridge-socket-failed';
      log(`[live-bridge] thread ponte NON creata (${reason}): ${e.message}`);
      pendingLiveByCell.delete(snap.hostCell);
      return none(reason, { cell: snap.hostCell, detail: String(e.message) });
    }

    // Commit. La designazione e il lease vengono riletti e confrontati con
    // la tupla riservata: se qualcosa è cambiato durante lo start, il thread
    // resta scartato (zero dispatch) e l'esito lo dichiara con l'id scartato.
    let commitSnap;
    let commitLease;
    try {
      commitSnap = await readDesignation();
      commitLease = await leaseTupleFor(snap.hostCell);
    } catch (e) {
      pendingLiveByCell.delete(snap.hostCell);
      log(`[live-bridge] commit illeggibile: thread ${started.threadId} scartato (${e.message})`);
      return none('commit-unreadable', {
        cell: snap.hostCell, discardedThread: started.threadId, detail: String(e.message),
      });
    }
    if (liveTuple(commitSnap, commitLease) !== reservedTuple) {
      // Primato alla causa radice: se il lease è cambiato, eligible oscilla
      // con lui, e la designazione NON è la causa.
      const leaseOf = (value) => liveTuple({ hostCell: null, revision: null, eligible: null }, value);
      const reason = leaseOf(commitLease) !== leaseOf(reservedLease)
        ? 'lease-changed' : 'designation-changed';
      pendingLiveByCell.delete(snap.hostCell);
      log(`[live-bridge] tupla cambiata in volo (${reason}): thread ${started.threadId} scartato`);
      return none(reason, { cell: snap.hostCell, discardedThread: started.threadId });
    }
    pendingLiveByCell.delete(snap.hostCell);

    const { text, ...promptEcho } = prompt; // il testo del prompt non viaggia in risposta
    const out = {
      mode: 'native', cell: snap.hostCell, engine,
      threadId: started.threadId, cwd: started.cwd,
      prompt: promptEcho,
      socketPath: cfg.liveBridgeSocketPath,
      at: now(),
    };
    threadIdsByCell.set(snap.hostCell, started.threadId);
    threadStatusCache.delete(snap.hostCell);
    // Il puntamento è visibile lato nostro — log con cella, thread e
    // prompt applicato. È il "dirottamento dichiarato" del contratto. Il
    // Campo SOSTITUISCE le developer instructions della config (la
    // .or() in config/mod.rs): il log lo dichiara, perché chi lo legge sappia
    // cosa quella Live NON riceve.
    log(`[live-bridge] Live puntata su ${snap.hostCell}: thread ${started.threadId} (cwd ${started.cwd}, identità nell'intestazione, prompt ${prompt.applied ? 'per-cella applicato' : `non applicato (${promptEcho.reason})`}, sostituisce le developer instructions di config)`);
    return out;
  }

  return {
    resolveForLive,
    threadStatus,
    readCellPrompt: (tmuxSession) => { const { text, ...rest } = readCellPrompt(root, tmuxSession); return rest; },
  };
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

module.exports = {
  createLiveBridge, readCellPrompt, startThreadOnControlSocket,
  queryThreadStatusOnControlSocket, CLIENT_NAME,
};
