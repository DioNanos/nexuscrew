'use strict';

// LeaseManager lato server per il lease del supervisore di una cella Live host.
//
// Compone le transizioni pure di cell-lease.js con i side effect: endpoint UDS
// STABILE di reconnect (R3.3.2), capability di reconnect DISTINTA dal nonce
// one-shot e PERSISTITA (R3.3.3: vive nel supervisore e non transita al child;
// sopravvive al restart del server per validare il reconnect), EOF che arma la
// grace monotonica (R3.1.3), refresh 20s (R3.2), reconnect che produce lease
// NUOVO con stessa identita' (R3.3.4). Lo stato live del lease e' in memoria e
// NON sopravvive al restart del processo server (R3.3.1 fail-closed); solo
// {launchEpoch, capability} sono persistiti, per riconoscere il supervisore al
// reconnect senza resuscitare l'eligibilita'.
//
// Side effect isolati e iniettabili (seams) per testabilita', come altrove nel
// fleet (cell-exec.js, launch-broker.js). Protocollo sul socket lease:
// line-oriented JSON, un messaggio per riga.
//   supervisor -> server: {"type":"refresh"}                     (ogni 20s)
//   supervisor -> server: {"type":"reconnect","launchEpoch":..,"generation":..,"capability":..}
//   server     -> supervisor: {"type":"ack"} | {"type":"lease","leaseId":..} | {"type":"deny"}

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./cell-lease.js');
const { runtimeDir, ensureRuntimeDir } = require('./launch-broker.js');

function sanitizeCell(cellId) {
  return String(cellId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function createLeaseManager(cfg = {}, seams = {}) {
  const dir = runtimeDir(cfg);
  const statePath = cfg.leaseStatePath || path.join(dir, 'cell-leases.json');
  const now = seams.now || Date.now;
  const setTimer = seams.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = seams.clearTimeout || ((t) => { if (t) clearTimeout(t); });
  const netImpl = seams.net || net;
  const fsImpl = seams.fs || fs;
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};

  // cellId -> entry:
  //   { launchEpoch, capability, stablePath, stableServer, lease, socket, graceTimer }
  // lease/socket vivono in memoria (persi al restart); launchEpoch/capability
  // sono anche persistiti.
  const cells = new Map();

  function stablePathFor(cellId) { return path.join(dir, `cell-${sanitizeCell(cellId)}.sock`); }

  function readPersisted() {
    try {
      const raw = fsImpl.readFileSync(statePath, 'utf8');
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  }

  function writePersisted(obj) {
    try {
      ensureRuntimeDir(dir);
      const tmp = `${statePath}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fsImpl.renameSync(tmp, statePath);
      try { fsImpl.chmodSync(statePath, 0o600); } catch (_) {}
    } catch (e) { log(`cell-lease: persist failed: ${e && e.message}`); }
  }

  function persistEntry(cellId, entry) {
    const obj = readPersisted();
    // graceDeadline e' persistito SOLO come bound per rifiutare reconnect stale
    // post-restart (R3.3.5): non resuscita il lease (fail-closed R3.3.1) — il lease
    // vivo resta in memoria — ma permette al server riavviato di rifiutare un
    // reconnect oltre la grace. null quando la cella e' live (mai graced).
    obj[cellId] = {
      launchEpoch: entry.launchEpoch,
      capability: entry.capability,
      graceDeadline: entry.graceDeadline != null ? entry.graceDeadline : null,
    };
    writePersisted(obj);
  }

  function clearGraceTimer(entry) {
    if (entry.graceTimer) { clearTimer(entry.graceTimer); entry.graceTimer = null; }
  }

  function armGraceTimer(cellId, entry) {
    clearGraceTimer(entry);
    // R3.2: deadline non estendibile, armata una sola volta.
    const ms = Math.max(0, (entry.lease.graceDeadline - now()));
    entry.graceTimer = setTimer(() => {
      const e = cells.get(cellId);
      if (!e || !e.lease || e.lease.leaseId !== entry.lease.leaseId) return;
      // Grace scaduta senza reconnect: lease terminal. L'eligibilita' (binding host)
      // e' out-of-scope 2a; qui marchiamo il lease come expired.
      log(`cell-lease: ${cellId} grace expired (lease ${entry.lease.leaseId})`);
    }, ms);
    if (entry.graceTimer && typeof entry.graceTimer.unref === 'function') entry.graceTimer.unref();
  }

  function detachSocket(entry) {
    if (!entry.socket) return;
    try { entry.socket.removeAllListeners('data'); entry.socket.removeAllListeners('close'); entry.socket.removeAllListeners('end'); entry.socket.destroy(); } catch (_) {}
    entry.socket = null;
  }

  function bindLiveSocket(cellId, entry, socket, { lease }) {
    detachSocket(entry);
    entry.lease = lease;
    entry.socket = socket;
    // Sync del bound di grace a livello entry (persistito): null quando il lease e'
    // live, graceDeadline quando in grace. Aggiornato anche in onEOF.
    entry.graceDeadline = lease && lease.graceDeadline != null ? lease.graceDeadline : null;
    clearGraceTimer(entry);
    persistEntry(cellId, entry);
    let buf = '';
    const onLine = (line) => {
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'refresh') {
        // Heartbeat lato supervisore (R3.2): aggiorna lastRefreshedAt, NON cambia state.
        const cur = cells.get(cellId);
        if (cur && cur.lease && cur.socket === socket) {
          const refreshed = L.refresh(cur.lease, { now: now() });
          if (refreshed) cur.lease = refreshed;
          writeSafe(socket, { type: 'ack' });
        }
        return;
      }
      // Messaggi non riconosciuti su una connessione gia' associata sono ignorati:
      // reconnect e identita' si presentano sull'endpoint stabile, non qui.
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    };
    const onEOF = () => {
      const cur = cells.get(cellId);
      if (!cur || cur.socket !== socket) return; // gia' sostituita da un reconnect
      // R3.1.3: EOF arma UNA sola transizione monotonica Live -> Grace; deadline
      // non estendibile. armGrace e' no-op se gia' in grace.
      const g = L.armGrace(cur.lease, { now: now() });
      if (g) cur.lease = g;
      // R3.3.5: persistiamo il nuovo bound di grace per rifiutare reconnect stale
      // post-restart (il lease vivo non sopravvive, ma il bound di reject si').
      cur.graceDeadline = cur.lease && cur.lease.graceDeadline != null ? cur.lease.graceDeadline : null;
      persistEntry(cellId, cur);
      armGraceTimer(cellId, cur);
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('close', onEOF);
    socket.once('end', onEOF);
  }

  function writeSafe(socket, obj) {
    if (!socket || socket.destroyed) return;
    try { socket.write(`${JSON.stringify(obj)}\n`); } catch (_) {}
  }

  function onStableConnection(cellId, socket) {
    // Endpoint stabile: reconnect (R3.3.2-4). Legge identita' + capability, valida.
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch (_) { writeSafe(socket, { type: 'deny' }); socket.destroy(); return; }
      socket.removeAllListeners('data');
      handleReconnect(cellId, socket, msg);
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('close', () => { try { socket.destroy(); } catch (_) {} });
  }

  function handleReconnect(cellId, socket, msg) {
    if (!msg || msg.type !== 'reconnect') { writeSafe(socket, { type: 'deny' }); socket.destroy(); return; }
    const entry = cells.get(cellId);
    if (!entry) { writeSafe(socket, { type: 'deny' }); socket.destroy(); return; }
    // R3.3.3: capability di reconnect distinta dal nonce, validata (timing-safe).
    if (!timingSafeEqualHex(msg.capability, entry.capability)) {
      writeSafe(socket, { type: 'deny' }); socket.destroy(); return;
    }
    // Identita' launchEpoch deve combaciare (stessa epoca di lancio).
    if (msg.launchEpoch !== entry.launchEpoch) {
      writeSafe(socket, { type: 'deny' }); socket.destroy(); return;
    }
    const generation = Number.isInteger(msg.generation) && msg.generation >= 0 ? msg.generation : (entry.lease ? entry.lease.generation : 0);
    // R3.3.4: la generation e' non-decreasing (avanza coi restart del supervisore).
    // Un reconnect con generation minore di quella nota e' stale (supervisore
    // precedente / replay) e va rifiutato. msg.generation assente -> fallback alla
    // generation corrente (compat), accettato.
    if (entry.lease && Number.isInteger(msg.generation) && msg.generation < entry.lease.generation) {
      writeSafe(socket, { type: 'deny' }); socket.destroy(); return;
    }
    // R3.3.5: oltre la grace il reconnect e' rifiutato. Con entry.lease vivo ci
    // pensa reattach (null su grace scaduta). Post-restart (lease null) usiamo il
    // bound di grace persistito: se noto e la richiesta arriva oltre, rifiuta.
    // Senza bound noto (cella live mai graced, o deadline non disponibile) si apre
    // un lease nuovo (recovery post-restart con supervisore e child vivi).
    if (!entry.lease && entry.graceDeadline != null && now() > entry.graceDeadline) {
      writeSafe(socket, { type: 'deny' }); socket.destroy(); return;
    }
    const base = entry.lease || L.openLease({ cellId, launchEpoch: entry.launchEpoch, generation, leaseId: L.newLeaseId(), now: now() });
    const reattached = entry.lease
      ? L.reattach(entry.lease, { leaseId: L.newLeaseId(), generation, now: now() })
      : base;
    if (!reattached) { writeSafe(socket, { type: 'deny' }); socket.destroy(); return; }
    // R3.3.4: lease NUOVO (leaseId nuovo), stessa identita'. Associa la nuova connessione.
    bindLiveSocket(cellId, entry, socket, { lease: reattached });
    writeSafe(socket, { type: 'lease', leaseId: reattached.leaseId });
  }

  // --- API pubblica ---

  // Apre l'endpoint stabile UDS 0o600 per una cella (R3.3.2), riusando l'identity
  // e lo stablePath gia' noti nell'entry. Idempotente: se l'entry ha gia' uno
  // stableServer vivo non fa nulla. Condiviso da track() (prima apertura) e da
  // boot() (riapertura dopo restart per le celle persistite).
  async function openEndpoint(cellId, entry) {
    if (entry.stableServer) return entry.stablePath;
    ensureRuntimeDir(dir);
    const sp = entry.stablePath || stablePathFor(cellId);
    try { fsImpl.unlinkSync(sp); } catch (_) {}
    const server = netImpl.createServer((sock) => onStableConnection(cellId, sock));
    await new Promise((resolve, reject) => {
      const onErr = (err) => { restore(); reject(err); };
      // R3.3.2: la socket stabile deve NASCERE 0o600 (0o777 & ~0o177), non diventar-
      // lo dopo. umask(0o177) al bind neutralizza qualunque umask esterno: nessuna
      // finestra in cui l'endpoint sia leggibile/scrivibile da altri (con umask(0)
      // prima era 0o777 fino al chmod). restore() in ogni uscita.
      const prevUmask = process.umask(0o177);
      const restore = () => process.umask(prevUmask);
      server.once('error', onErr);
      server.listen(sp, () => {
        restore();
        server.removeListener('error', onErr);
        server.unref();
        // Il chmod forza/verifica 0o600; il suo fallimento NON va ingoiato (R3.3.2).
        try {
          fsImpl.chmodSync(sp, 0o600);
        } catch (e) {
          try { server.close(); } catch (_) {}
          try { fsImpl.unlinkSync(sp); } catch (_) {}
          reject(e);
          return;
        }
        resolve();
      });
    });
    entry.stablePath = sp;
    entry.stableServer = server;
    return sp;
  }

  // Apertura lato server in up(): genera launchEpoch + capability, persiste,
  // apre l'endpoint stabile UDS 0o600. Ritorna i dati da inserire nel payload.
  async function track(cellId) {
    ensureRuntimeDir(dir);
    // Rispetta un'identity gia' nota (in memoria o persistita): al restart del
    // server NON si genera una nuova launchEpoch/capability, perche' il
    // supervisore vivo reconnecta con quella originale. Solo una cella mai
    // tracciata genera una nuova identity.
    const existing = cells.get(cellId);
    const persisted = readPersisted()[cellId];
    const launchEpoch = (existing && existing.launchEpoch)
      || (persisted && persisted.launchEpoch)
      || crypto.randomBytes(8).toString('hex');
    const capability = (existing && existing.capability)
      || (persisted && persisted.capability)
      || crypto.randomBytes(32).toString('hex');
    const entry = existing
      || { launchEpoch, capability, stablePath: stablePathFor(cellId), stableServer: null, lease: null, socket: null, graceTimer: null, graceDeadline: null };
    entry.launchEpoch = launchEpoch;
    entry.capability = capability;
    if (!entry.stablePath) entry.stablePath = stablePathFor(cellId);
    // Idempotente: se l'endpoint e' gia' aperto (es. boot() poi up()) non lo ricrea.
    await openEndpoint(cellId, entry);
    cells.set(cellId, entry);
    persistEntry(cellId, entry);
    return { stablePath: entry.stablePath, launchEpoch, capability };
  }

  // Recovery di produzione (R3.3.1 fail-closed): al boot del server la map e'
  // vuota e nessun lease sopravvive. Ricarichiamo {launchEpoch, capability}
  // persistiti e RIAPRIAMO l'endpoint stabile per ogni cella nota, cosicche' un
  // supervisore vivo (boot:false) che reconnecta dopo il restart trovi l'endpoint.
  // Prima loadPersisted non aveva chiamanti in produzione: e' il rilievo 3.
  async function boot() {
    loadPersisted();
    for (const [cellId, entry] of cells) {
      if (entry.stableServer) continue;
      try {
        await openEndpoint(cellId, entry);
      } catch (e) {
        log(`cell-lease: boot endpoint failed for ${cellId}: ${e && e.message}`);
      }
    }
  }

  // Connessione broker one-shot iniziale (R3.1.1): autenticata dal nonce del
  // broker; qui associamo la connessione al lease (primo contatto).
  function attachInitial(cellId, socket, { generation = 0 } = {}) {
    const entry = cells.get(cellId);
    if (!entry) return false;
    const lease = L.openLease({ cellId, launchEpoch: entry.launchEpoch, generation, leaseId: L.newLeaseId(), now: now() });
    if (!lease) return false;
    bindLiveSocket(cellId, entry, socket, { lease });
    return true;
  }

  // Al boot del server (R3.3.1 fail-closed): la map e' vuota. Ricarichiamo solo
  // {launchEpoch, capability, graceDeadline} persistiti, per riconoscere i
  // supervisori che reconnectano dopo il restart e per rifiutare reconnect oltre
  // la grace (R3.3.5). Nessun lease/eligibilita' sopravvive.
  function loadPersisted() {
    const obj = readPersisted();
    for (const [cellId, info] of Object.entries(obj)) {
      if (cells.has(cellId)) continue;
      // L'endpoint stabile viene (ri)aperto da boot()/track(); qui registriamo
      // solo l'identita' nota + il bound di grace, se assenti, cosicche'
      // handleReconnect possa validarli anche quando la cella non sia ancora
      // passata di nuovo per track().
      cells.set(cellId, {
        launchEpoch: info.launchEpoch, capability: info.capability,
        graceDeadline: info.graceDeadline != null ? info.graceDeadline : null,
        stablePath: stablePathFor(cellId), stableServer: null, lease: null, socket: null, graceTimer: null,
      });
    }
  }

  function status(cellId) {
    const entry = cells.get(cellId);
    if (!entry || !entry.lease) return { cellId, state: 'none' };
    const n = now();
    if (L.isLive(entry.lease)) return { cellId, state: 'live', leaseId: entry.lease.leaseId, generation: entry.lease.generation };
    if (L.isGrace(entry.lease, { now: n })) return { cellId, state: 'grace', leaseId: entry.lease.leaseId, graceDeadline: entry.lease.graceDeadline };
    if (L.isExpired(entry.lease, { now: n })) return { cellId, state: 'expired', leaseId: entry.lease.leaseId };
    return { cellId, state: 'none' };
  }

  function close() {
    for (const [cellId, entry] of cells) {
      clearGraceTimer(entry);
      detachSocket(entry);
      if (entry.stableServer) { try { entry.stableServer.close(); } catch (_) {} }
      try { if (entry.stablePath) fsImpl.unlinkSync(entry.stablePath); } catch (_) {}
    }
    cells.clear();
  }

  return { boot, track, attachInitial, loadPersisted, status, close, _cells: cells };
}

module.exports = { createLeaseManager, sanitizeCell };
