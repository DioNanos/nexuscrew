'use strict';

// LeaseManager lato server per il lease del supervisore di una cella Live host.
//
// Fetta 2b (contratto rev1): l'autenticazione del reconnect e' un proof HMAC
// firmato con un verifier PER-INSTALLAZIONE — la capability statica condivisa
// della 2a e' REVOCATA, non affiancata (A2/B1). Solo il server conosce il
// segreto; il supervisore presenta un proof firmato con claims ed expiry (B8:
// issuedAt+60s). Il proof supervisore arriva al detentore sul canale lease
// (all'attach e a ogni refresh) e non transita mai nel child (R3.1.2 invariato).
//
// Storage per-cella (D1/D2): un file per cella in <run>/cell-leases/. Il
// refresh di una cella rilegge e riscrive SOLO il proprio file: scompare la
// read-modify-write dell'intero store condiviso, la race su di essa e
// l'amplificazione O(N^2) misurata in 2a (N letture + N scritture complete
// per ciclo di 20s). L'invariante di recovery post-restart e' preservato ed
// affinato: un file corrotto salta solo la propria cella, non lo store intero
// (E3 chiusa con test). Il nome file usa la stessa sanitizeCell dell'endpoint
// UDS: due cellId che sanitizzano uguale condividono file ed endpoint, proprieta'
// gia' vera in 2a per il socket.
//
// Rotazione (C3, sospesa per scelta dichiarata): finche' la finestra di
// sovrapposizione non e' fissata la chiave NON ruota; la verifica interroga
// comunque la LISTA delle chiavi vive (oggi una) perche' quella e' la forma
// richiesta da C2 quando la rotazione sara' attivata. Fail-closed sulla
// verifica (C4); lo stato durevole non contiene mai il segreto, solo
// identificativo e impronta nel meta del verifier (C5); la verifica rende
// osservabile quale chiave ha firmato (C6, via log del keyId).
//
// Side effect isolati e iniettabili (seams) per testabilita', come altrove nel
// fleet (cell-exec.js, launch-broker.js). Protocollo sul socket lease:
// line-oriented JSON, un messaggio per riga.
//   supervisor -> server: {"type":"refresh"}
//   supervisor -> server: {"type":"reconnect","generation":..,"proof":{..}}
//   server     -> supervisor: {"type":"lease","leaseId":..,"proof":{..}}
//                          | {"type":"ack","proof":{..}} | {"type":"deny"}

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./cell-lease.js');
const { runtimeDir, ensureRuntimeDir } = require('./launch-broker.js');
const { loadOrCreateVerifier, signProof, verifyProof, PROOF_TTL_MS } = require('./lease-verifier.js');

function sanitizeCell(cellId) {
  return String(cellId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

// cellId ammesso dalle API child: stessa forma usata dalle route fleet.
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
function validCellId(cellId) { return typeof cellId === 'string' && CELL_ID_RE.test(cellId); }

// F-A (audit 2a @ 142e272): il formato che il runtime produce per un'identity.
// Condiviso da loadPersisted (primo ingresso, al boot) e track (secondo
// ingresso): la validazione e' UNA, non due copie da tenere allineate.
const EPOCH_RE = /^[a-f0-9]{16}$/;

// A3 — confine del consumo: un proof e' consumato UNA volta, IN-PROCESS. Il
// registro dei jti muore col processo server: dopo un restart un proof non
// ancora scaduto puo' ripresentarsi (la firma e l'expiry restano il gate).
// Garanzia piu' forte (single-use cross-restart) NON promessa dal contratto.
const JTI_CAP = 4096;

function createLeaseManager(cfg = {}, seams = {}) {
  const dir = runtimeDir(cfg);
  const stateDir = cfg.leaseStateDir || path.join(dir, 'cell-leases');
  const now = seams.now || Date.now;
  const setTimer = seams.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = seams.clearTimeout || ((t) => { if (t) clearTimeout(t); });
  const netImpl = seams.net || net;
  const fsImpl = seams.fs || fs;
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};

  // cellId -> entry:
  //   { launchEpoch, stablePath, stableServer, lease, socket, graceTimer, graceDeadline }
  // lease/socket vivono in memoria (persi al restart); launchEpoch/graceDeadline
  // sono anche persistiti PER CELLA (D1). Nessun segreto in entry o su disco.
  const cells = new Map();

  // Verifier per-installazione (B7): file dedicato 0o600 nella runtime dir,
  // distinto dai token di liveness e dal segreto del bridge audio. Lazy: nasce
  // al primo proof, cosi' un manager che non firma mai non lascia file in giro.
  let verifier = null;
  function ensureVerifier() {
    if (!verifier) verifier = loadOrCreateVerifier({ dir, fsImpl: fs, log });
    return verifier;
  }
  // Le chiavi vive per la verifica (C2-ready, oggi una: C3 sospesa).
  const liveKeys = () => [ensureVerifier()];

  // Registro jti consumati (A3): bounded, i scaduti escono da soli.
  const consumedJti = new Map(); // jti -> expiresAt
  function consumeJti(jti, expiresAt) {
    const t = now();
    for (const [j, exp] of consumedJti) if (exp <= t) consumedJti.delete(j);
    if (consumedJti.has(jti)) return false;
    consumedJti.set(jti, expiresAt);
    while (consumedJti.size > JTI_CAP) {
      const oldest = consumedJti.keys().next();
      if (oldest.done) break;
      consumedJti.delete(oldest.value);
    }
    return true;
  }

  // Proof supervisore (kind 'lease'): tupla con leaseId (B6), generation
  // corrente, expiry issuedAt+60s (B8). Emissione == firma: non c'e' stato di
  // sessione da tenere, il detentore presenta il proof cosi' com'e'.
  function issueLeaseProof(cellId, entry, lease) {
    return signProof(ensureVerifier(), {
      kind: 'lease',
      cellId,
      launchEpoch: entry.launchEpoch,
      leaseId: lease.leaseId,
      generation: String(lease.generation),
      jti: crypto.randomBytes(8).toString('hex'),
      issuedAt: now(),
    }, { now });
  }

  function cellStatePath(cellId) { return path.join(stateDir, `${sanitizeCell(cellId)}.json`); }

  function stablePathFor(cellId) { return path.join(dir, `cell-${sanitizeCell(cellId)}.sock`); }

  // D1: lettura PER CELLA. ENOENT = cella sconosciuta (legittimo); qualunque
  // altro errore (EIO, parse, forma) = illeggibile: propaga, perche' una
  // scrittura che ignora un file illeggibile cancellerebbe lo stato di quella
  // cella senza saperlo.
  function readPersistedCell(cellId) {
    let raw;
    try {
      raw = fsImpl.readFileSync(cellStatePath(cellId), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
    const obj = JSON.parse(raw);
    // P1-1b: la FORMA del dato. La root deve essere l'entry attesa: plain-object
    // con i campi del formato per-cell. Qualunque altra cosa e' illeggibile.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`store lease: entry per-cella non e' un oggetto: ${sanitizeCell(cellId)}`);
    }
    return obj;
  }

  function writePersistedCell(cellId, entryData) {
    // GC1.2 (rev27): l'esito NON si ingoia — ritornato perche' il refresh (e il
    // proof) dipende dal commit effettivo del bound. Il log resta diagnostico.
    try {
      ensureRuntimeDir(dir);
      fsImpl.mkdirSync(stateDir, { recursive: true });
      const target = cellStatePath(cellId);
      const tmp = `${target}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(entryData), { mode: 0o600 });
      fsImpl.renameSync(tmp, target);
      try { fsImpl.chmodSync(target, 0o600); } catch (_) {}
      return true;
    } catch (e) {
      log(`cell-lease: persist failed: ${e && e.message}`);
      return false;
    }
  }

  // D1: persiste il bound di UNA cella leggendo e scrivendo SOLO il suo file.
  // Non esiste piu' la read-modify-write dell'intero store condiviso.
  // GC1 (rev27): graceDeadline SEMPRE valorizzato (mai null) — bound durevole
  // per rifiutare reconnect oltre la grace post-restart (R3.3.5). Live =
  // now+GRACE_MS; in grace = bound di armGrace; refresh lo rinfresca.
  function persistEntry(cellId, entry) {
    return writePersistedCell(cellId, {
      launchEpoch: entry.launchEpoch,
      graceDeadline: entry.graceDeadline,
    });
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
    // P1-2b (audit 2a05db2): persiste il bound PRIMA di associare il socket. Se il
    // record non committa, rollback e ritorna false: il caller non dichiarera' lease.
    // Diverso da EOF (onEOF): li una write fallita lascia un bound ANTERIORE (fail-closed
    // anticipato, accettabile); qui il bind prometterebbe stato live senza commit durevole.
    const prevGraceDeadline = entry.graceDeadline;
    // GC1 (rev27): bound durevole SEMPRE valorizzato. Lease live -> now+GRACE_MS (bound
    // preventivo); lease in grace -> lease.graceDeadline (bound di armGrace). Mai null.
    entry.graceDeadline = lease && lease.graceDeadline != null ? lease.graceDeadline : now() + L.GRACE_MS;
    if (!persistEntry(cellId, entry)) {
      entry.graceDeadline = prevGraceDeadline; // rollback: socket non associato
      return false;
    }
    detachSocket(entry);
    entry.lease = lease;
    entry.socket = socket;
    clearGraceTimer(entry);
    let buf = '';
    const onLine = (line) => {
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'refresh') {
        // Heartbeat lato supervisore (R3.2) + GC1.1/GC1.2 (rev27): il refresh
        // rinfresca il bound durevole (now+GRACE_MS) e lo persiste PRIMA dell'ACK
        // e del proof nuovo (hook 2a ora realta'): se la persistenza non committa
        // il refresh NON e' un successo — nessun ACK, nessun proof (il detentore
        // resta col proof vecchio, che scade: fail-closed per scadenza, non per
        // silenzio).
        const cur = cells.get(cellId);
        if (cur && cur.lease && cur.socket === socket) {
          const refreshed = L.refresh(cur.lease, { now: now() });
          if (refreshed) cur.lease = refreshed;
          cur.graceDeadline = now() + L.GRACE_MS; // GC1.1: bound rinfrescato
          if (persistEntry(cellId, cur)) {
            writeSafe(socket, { type: 'ack', proof: issueLeaseProof(cellId, cur, cur.lease) });
          } else {
            log(`cell-lease: ${cellId} refresh: bound non persistito, ACK+proof omessi`);
          }
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
      cur.graceDeadline = cur.lease && cur.lease.graceDeadline != null ? cur.lease.graceDeadline : now() + L.GRACE_MS;
      persistEntry(cellId, cur);
      armGraceTimer(cellId, cur);
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('close', onEOF);
    socket.once('end', onEOF);
    // Correzione (audit 2a, segnalazione precisata in revisione): questo E' il socket
    // su cui il server SCRIVE (l'ack di refresh — proprio dove l'EPIPE nasce se
    // il peer muore mentre la write e' in volo). Un EventEmitter che emette
    // 'error' senza listener fa un throw che termina l'INTERO processo — non
    // muore la cella, muore NexusCrew con dentro tutte le celle. Assorbe
    // l'errore, non lo propaga: la naturale 'close' che segue attiva comunque
    // onEOF (grace), la stessa forma del close-handler di onStableConnection.
    socket.once('error', () => { try { socket.destroy(); } catch (_) {} });
    return true;
  }

  function writeSafe(socket, obj) {
    if (!socket || socket.destroyed) return;
    try { socket.write(`${JSON.stringify(obj)}\n`); } catch (_) {}
  }

  function onStableConnection(cellId, socket) {
    // Endpoint stabile: reconnect (R3.3.2-4). Legge identita' + proof, valida.
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
    // Correzione (audit 2a): stesso motivo di bindLiveSocket — il server scrive
    // 'deny' su questo socket (onData sopra, JSON malformato); senza un
    // handler 'error' un peer che muore mentre quella write e' in volo manda
    // in throw fatale l'intero processo. Se la connessione avanza a
    // handleReconnect->bindLiveSocket, questo handler resta attivo insieme al
    // suo (entrambi fanno solo destroy: innocuo, mai un secondo effetto).
    socket.once('error', () => { try { socket.destroy(); } catch (_) {} });
  }

  function denyReconnect(socket) {
    writeSafe(socket, { type: 'deny' });
    socket.destroy();
  }

  function handleReconnect(cellId, socket, msg) {
    if (!msg || msg.type !== 'reconnect') return denyReconnect(socket);
    const entry = cells.get(cellId);
    if (!entry) return denyReconnect(socket);
    // A2/B1: l'autenticazione del reconnect e' il proof HMAC. La capability
    // statica della 2a e' revocata: un messaggio senza proof (o col vecchio
    // campo capability) e' negato qui, senza confronti verso segreti condivisi.
    // C4: fail-closed — forma, firma, claims attesi, expiry: ogni difetto e' deny.
    const out = verifyProof(liveKeys(), msg.proof, {
      now,
      expect: {
        kind: 'lease',
        cellId,
        launchEpoch: entry.launchEpoch,
        // leaseId atteso SOLO con lease vivo in memoria: post-restart il lease
        // non sopravvive (R3.3.1) e il gate resta firma+expiry+bound di grace.
        ...(entry.lease ? { leaseId: entry.lease.leaseId } : {}),
      },
    });
    if (!out.ok) {
      log(`cell-lease: ${cellId} reconnect denied (proof: ${out.reason})`);
      return denyReconnect(socket);
    }
    // A3: consumo il jti DOPO la verifica e PRIMA di ogni mutazione. Un proof
    // presentato e negato per altro motivo NON viene consumato: potra' ripresentarsi
    // fino alla propria scadenza, e ogni replica sara' negata dallo stesso gate.
    if (!consumeJti(msg.proof.jti, msg.proof.expiresAt)) {
      log(`cell-lease: ${cellId} reconnect denied (jti replay in-process)`);
      return denyReconnect(socket);
    }
    const generation = Number.isInteger(msg.generation) && msg.generation >= 0 ? msg.generation : (entry.lease ? entry.lease.generation : 0);
    // R3.3.4: transizione di generation VERIFICABILE (non solo non-decreasing). Il
    // supervisore onesto (cell-exec.js) fa avanzare la generation di ESATTAMENTE +1
    // a ogni restart del child e al reconnect presenta sempre la propria generation
    // corrente. La transizione attesa e' quindi `=== current` (stesso restart,
    // retry/reattach) oppure `=== current + 1` (un restart del supervisore). Un salto
    // avanti arbitrario (es. 0->99) o all'indietro NON e' una transizione che il
    // client onesto produrrebbe: deny. msg.generation assente -> fallback alla
    // current (compat), accettato. Post-restart (entry.lease null) non c'e' generation
    // persistita da validare (contratto rev25 EC6): firma+bound di grace resta il gate.
    if (entry.lease && Number.isInteger(msg.generation)) {
      const cur = entry.lease.generation;
      if (msg.generation !== cur && msg.generation !== cur + 1) {
        return denyReconnect(socket);
      }
    }
    // R3.3.5/GC1 (rev27): oltre la grace il reconnect e' rifiutato. Con entry.lease
    // vivo ci pensa reattach (null su grace scaduta). Post-restart (lease null) usiamo
    // il bound di grace persistito PER CELLA, ora SEMPRE valorizzato: se la richiesta
    // arriva ALLA deadline o oltre, rifiuta (>= allineato a cell-lease.js).
    // Recovery post-restart con supervisore/child vivi solo ENTRO il bound live.
    if (!entry.lease && now() >= entry.graceDeadline) {
      return denyReconnect(socket);
    }
    const base = entry.lease || L.openLease({ cellId, launchEpoch: entry.launchEpoch, generation, leaseId: L.newLeaseId(), now: now() });
    const reattached = entry.lease
      ? L.reattach(entry.lease, { leaseId: L.newLeaseId(), generation, now: now() })
      : base;
    if (!reattached) return denyReconnect(socket);
    // R3.3.4: lease NUOVO (leaseId nuovo), stessa identita'. Associa la nuova connessione.
    if (!bindLiveSocket(cellId, entry, socket, { lease: reattached })) {
      return denyReconnect(socket);
    }
    log(`cell-lease: ${cellId} reconnect ok (lease ${reattached.leaseId}, verifier ${out.keyId})`); // C6: chiave osservabile
    writeSafe(socket, { type: 'lease', leaseId: reattached.leaseId, proof: issueLeaseProof(cellId, entry, reattached) });
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
      server.once('error', reject);
      // F-C (audit 2a @ 142e272): niente piu' set/restore di process.umask.
      // process.umask e' GLOBALE e la coppia set/restore non e' atomica: sotto
      // openEndpoint concorrenti il restore di uno ripristinava lo 0o177 appena
      // settato dall'altro e il processo restava driftato. La protezione e'
      // (1) la directory owner-only verificata a OGNI bind (ensureRuntimeDir,
      // subito PRIMA del listen, eseguita non presupposta) e (2) il chmod 0o600
      // forzato qui sotto, che NON ingoia il fallimento.
      server.listen(sp, () => {
        server.removeListener('error', reject);
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

  // F-C (audit 2a @ 142e272): track() serializzato PER CELLA. Due track
  // simultanei sulla stessa cella vedevano entrambi cells.get() vuoto, generavano
  // due identity divergenti e il perdente restava con un'identity inutile. La
  // catena per cellId fa attendere al secondo la fine del primo; poi
  // l'idempotenza esistente fa riusare la STESSA identity.
  const trackGates = new Map(); // cellId -> Promise<void> (completamento del turno)
  function track(cellId) {
    const prev = trackGates.get(cellId) || Promise.resolve();
    const run = prev.then(() => trackSerialized(cellId));
    const next = run.then(() => {}, () => {});
    trackGates.set(cellId, next);
    next.then(() => { if (trackGates.get(cellId) === next) trackGates.delete(cellId); });
    return run;
  }

  // Apertura lato server in up(): genera launchEpoch, persiste PER CELLA, apre
  // l'endpoint stabile UDS 0o600. Ritorna i dati da inserire nel payload.
  // 2b: nessuna capability nel ritorno — il proof supervisore arriva sul canale
  // lease all'attach, non nel payload (il detentore lo riceve dal server).
  // Chiamata SOLO tramite track() qui sopra (serializzazione per cella).
  async function trackSerialized(cellId) {
    ensureRuntimeDir(dir);
    // Rispetta un'identity gia' nota (in memoria o persistita): al restart del
    // server NON si genera una nuova launchEpoch, perche' il supervisore vivo
    // reconnecta con quella originale (e il suo proof la porta firmata).
    const existing = cells.get(cellId);
    // P1-2 (reaudit dd38c83): snapshot dell'entry preesistente prima di mutare
    // qualunque cosa. Se persistEntry fallisce su una cella gia' viva, il cleanup
    // deve ripristinare lo stato precedente, NON cancellarlo.
    const hadExisting = !!existing;
    const existingSnapshot = existing ? {
      launchEpoch: existing.launchEpoch,
      stablePath: existing.stablePath, stableServer: existing.stableServer,
      lease: existing.lease, socket: existing.socket, graceTimer: existing.graceTimer,
      graceDeadline: existing.graceDeadline,
    } : null;
    // openEndpoint puo' aver creato un nuovo stableServer se l'entry non ne aveva uno.
    const serverBeforeOpen = existing ? existing.stableServer : null;
    // F-A (audit 2a): il SECONDO INGRESSO valida come il primo. Un valore
    // persistito e' riusato SOLO se ha il formato che il runtime produce
    // (hex-16 l'epoch); malformato -> identity NUOVA generata, e la persistEntry
    // qui sotto la scrive, riparando la entry corrotta sul disco.
    let persistedEpoch = null;
    try {
      const persisted = readPersistedCell(cellId);
      if (persisted && typeof persisted.launchEpoch === 'string' && EPOCH_RE.test(persisted.launchEpoch)) {
        persistedEpoch = persisted.launchEpoch;
      }
    } catch (e) {
      log(`cell-lease: read per-cell failed per ${cellId}: ${e && e.message}`);
    }
    const launchEpoch = (existing && existing.launchEpoch)
      || persistedEpoch
      || crypto.randomBytes(8).toString('hex');
    const entry = existing
      || { launchEpoch, stablePath: stablePathFor(cellId), stableServer: null, lease: null, socket: null, graceTimer: null, graceDeadline: now() + L.GRACE_MS };
    entry.launchEpoch = launchEpoch;
    if (!entry.stablePath) entry.stablePath = stablePathFor(cellId);
    // Idempotente: se l'endpoint e' gia' aperto (es. boot() poi up()) non lo ricrea.
    await openEndpoint(cellId, entry);
    cells.set(cellId, entry);
    if (!persistEntry(cellId, entry)) {
      // P1-2b: il record durevole (identity) e' essenziale per la recovery post-restart.
      // P1-2 (reaudit dd38c83): se la cella era GIA' viva, NON cancellarla — ripristina
      // lo stato precedente. Solo le risorse create in QUESTO tentativo vengono pulite.
      if (hadExisting) {
        entry.launchEpoch = existingSnapshot.launchEpoch;
        entry.lease = existingSnapshot.lease;
        entry.socket = existingSnapshot.socket;
        entry.graceTimer = existingSnapshot.graceTimer;
        entry.graceDeadline = existingSnapshot.graceDeadline;
        if (entry.stableServer && entry.stableServer !== serverBeforeOpen) {
          try { entry.stableServer.close(); } catch (_) {}
          entry.stableServer = serverBeforeOpen;
          entry.stablePath = existingSnapshot.stablePath;
        }
        cells.set(cellId, entry);
      } else {
        // Cella nuova: il tentativo e' fallito, cleanup completo e' sicuro
        cells.delete(cellId);
        if (entry.stableServer) { try { entry.stableServer.close(); } catch (_) {} try { fsImpl.unlinkSync(entry.stablePath); } catch (_) {} }
      }
      throw new Error(`cell-lease: track(${cellId}) non persistito: store illeggibile`);
    }
    return { stablePath: entry.stablePath, launchEpoch };
  }

  // Recovery di produzione (R3.3.1 fail-closed): al boot del server la map e'
  // vuota e nessun lease sopravvive. Ricarichiamo {launchEpoch, graceDeadline}
  // persistiti PER CELLA e RIAPRIAMO l'endpoint stabile per ogni cella nota,
  // cosicche' un supervisore vivo che reconnecta dopo il restart trovi
  // l'endpoint. La verifica del proof non richiede stato ricostruito: la chiave
  // verifier e' persistita per-installazione.
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
  // broker; qui associiamo la connessione al lease (primo contatto).
  // 2b: attachInitial NON scrive nulla sul canale. Durante la consegna del
  // payload il canale appartiene al protocollo del broker (frame length-
  // prefixed u32): una riga JSON scritta prima del payload corromperebbe la
  // lettura di receivePayload e il child non nascerebbe — misurato dal gate
  // (lease-audit-2a-fixes, F-B positivo). Il proof supervisore arriva con
  // l'ACK del primo refresh, che il lease-client invia IMMEDIATAMENTE
  // all'avvio: la finestra attach->primo-ack senza proof detenuto e' fail-closed
  // (reconnect negato -> grace -> onLost), coerente col modello per cui nessun
  // commit persistito = nessuna recovery promessa.
  function attachInitial(cellId, socket, { generation = 0 } = {}) {
    const entry = cells.get(cellId);
    if (!entry) return false;
    const lease = L.openLease({ cellId, launchEpoch: entry.launchEpoch, generation, leaseId: L.newLeaseId(), now: now() });
    if (!lease) return false;
    return bindLiveSocket(cellId, entry, socket, { lease });
  }

  // Al boot del server (R3.3.1 fail-closed): la map e' vuota. Ricarichiamo solo
  // {launchEpoch, graceDeadline} persistiti PER CELLA (D1), per riconoscere le
  // identity (il proof le porta firmate) e per rifiutare reconnect oltre la
  // grace (R3.3.5). Nessun lease/eligibilita' sopravvive.
  // E3: un file malformato/corrotto salta la PROPRIA cella (logged); le altre
  // caricano. Con lo store unico di 2a un parse error buttava tutte.
  function loadPersisted() {
    let files;
    try {
      files = fsImpl.readdirSync(stateDir);
    } catch (e) {
      if (e && e.code !== 'ENOENT') log(`cell-lease: loadPersisted readdir fallita, nessuna cella recuperata: ${e && e.message}`);
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const cellId = file.slice(0, -'.json'.length);
      if (cells.has(cellId)) continue;
      let info;
      try {
        info = readPersistedCell(cellId);
      } catch (e) {
        log(`cell-lease: loadPersisted entry '${cellId}' illeggibile, saltata: ${e && e.message}`);
        continue;
      }
      // P1-4 (reaudit dd38c83): forma <> semantica. Il runtime produce launchEpoch
      // come hex di 16 char. Fail-closed: formato errato = entry saltata.
      if (!info || typeof info.launchEpoch !== 'string' || !EPOCH_RE.test(info.launchEpoch)) {
        log(`cell-lease: loadPersisted entry '${cellId}' malformata, saltata`);
        continue;
      }
      // L'endpoint stabile viene (ri)aperto da boot()/track(); qui registriamo
      // solo l'identita' nota + il bound di grace, cosicche' handleReconnect possa
      // validarli anche quando la cella non sia ancora passata di nuovo per track().
      cells.set(cellId, {
        launchEpoch: info.launchEpoch,
        // GC1.6: graceDeadline assente/illeggibile/non-intero = grace gia' scaduta (0 -> deny sempre).
        // P1-4: forma <> semantica — un bound oltre now()+2*GRACE_MS non e' producibile
        // da questa fetta: trattato come scaduto (0). Tolleranza 2*GRACE_MS per un
        // restart durante la grace. Fail-closed: bound assurdo = scaduto.
        graceDeadline: (Number.isInteger(info.graceDeadline) && info.graceDeadline > 0
          && info.graceDeadline <= now() + 2 * L.GRACE_MS) ? info.graceDeadline : 0,
        stablePath: stablePathFor(cellId), stableServer: null, lease: null, socket: null, graceTimer: null,
      });
    }
  }

  // --- superficie child (B5): register / refresh / recovery -------------------
  //
  // Tre metodi DISTINTI perche' i loro valori di ritorno non possono mentire
  // l'uno con l'altro: register puo' rispondere 'pending' (la cella non e'
  // ancora tracciata); refresh su una registration viva risponde 'live' con un
  // proof nuovo e NON ha stati pendenti; recovery riprende un'incarnazione con
  // un proof scaduto da poco. Un metodo unico costringerebbe 'refresh' a un
  // valore di ritorno che mente in uno dei due casi.
  //
  // B2: incarnationId e' PER-REGISTRATION, mai globale — il register di una
  // cella crea la propria incarnazione e non tocca le altre. Le registration
  // vivono in memoria e NON sopravvivono al restart del processo (coerente col
  // fail-closed R3.3.1 del lease): dopo un restart del server il child
  // re-registra (nuova incarnazione).
  //
  // B3: l'unita' dell'attempt e' la PRESENTAZIONE di recovery, non la
  // connessione — una connessione puo' portare piu' presentazioni, e contare
  // connessioni conterebbe la cosa sbagliata. Ogni presentazione (anche negata)
  // consuma un attempt della propria registration; oltre il cap la
  // registration e' chiusa e serve un register nuovo.
  const childRegs = new Map(); // cellId -> { incarnationId, createdAt, lastAt, recoveryAttempts }
  const RECOVERY_ATTEMPT_CAP = 8;
  // Finestre del child, derivate dalle misure del lease:
  //   - un proof vive PROOF_TTL_MS (B8: 60s) dall'ultimo refresh;
  //   - il recovery accetta un proof scaduto da meno di una grace (L.GRACE_MS):
  //     il detentore ha saltato i refresh, non e' stato sostituito;
  //   - quindi la registration e' viva fino a lastAt + PROOF_TTL_MS + GRACE_MS.
  // Senza il margine di grace la finestra di recovery sarebbe VUOTA: la
  // registration morirebbe esattamente col proof che dovrebbe riprendere.
  const CHILD_REG_WINDOW_MS = PROOF_TTL_MS + L.GRACE_MS;
  const CHILD_PROOF_GRACE_MS = L.GRACE_MS;

  function issueChildProof(cellId, reg) {
    return signProof(ensureVerifier(), {
      kind: 'child',
      cellId,
      incarnationId: reg.incarnationId,
      jti: crypto.randomBytes(8).toString('hex'),
      issuedAt: now(),
    }, { now });
  }

  function childRegister(cellId) {
    if (!validCellId(cellId)) return { status: 'denied', reason: 'cellId' };
    if (!cells.has(cellId)) {
      // La cella non e' (ancora) tracciata dal lease del supervisore: il join e'
      // pendente. Solo register puo' rispondere cosi' (B5).
      return { status: 'pending', retryAfterMs: L.REFRESH_MS };
    }
    const reg = {
      incarnationId: crypto.randomBytes(8).toString('hex'), // B2: per-registration
      createdAt: now(),
      lastAt: now(),
      recoveryAttempts: 0,
    };
    childRegs.set(cellId, reg);
    return { status: 'registered', incarnationId: reg.incarnationId, proof: issueChildProof(cellId, reg) };
  }

  function childRefresh(cellId, proof) {
    const reg = childRegs.get(cellId);
    if (!reg) return { status: 'no-registration' };
    const out = verifyProof(liveKeys(), proof, {
      now,
      expect: { kind: 'child', cellId, incarnationId: reg.incarnationId },
    });
    if (!out.ok) return { status: 'denied', reason: out.reason };
    if (now() >= reg.lastAt + CHILD_REG_WINDOW_MS) return { status: 'expired' };
    reg.lastAt = now();
    return { status: 'live', incarnationId: reg.incarnationId, proof: issueChildProof(cellId, reg) };
  }

  function childRecovery(cellId, proof) {
    const reg = childRegs.get(cellId);
    if (!reg) return { status: 'no-registration' };
    // B3: la presentazione conta PRIMA dell'esito — anche un tentativo negato
    // consuma un attempt della registration.
    reg.recoveryAttempts += 1;
    if (reg.recoveryAttempts > RECOVERY_ATTEMPT_CAP) {
      return { status: 'denied', reason: 'attempt-bound' };
    }
    // Recovery (ResumeFirst): la firma dev'essere valida e i claims della
    // STESSA incarnazione; la scadenza e' tollerata entro una finestra di grace
    // (il proof e' morto per un gap di refresh, non per sostituzione). Oltre
    // quella finestra il proof non e' piu' presentabile NEanche in recovery:
    // per il child l'esito utile e' «expired, serve register», non un deny.
    const out = verifyProof(liveKeys(), proof, {
      now,
      expect: { kind: 'child', cellId, incarnationId: reg.incarnationId },
      graceMs: CHILD_PROOF_GRACE_MS,
    });
    if (!out.ok) {
      if (out.reason === 'expired') return { status: 'expired' };
      return { status: 'denied', reason: out.reason };
    }
    if (now() >= reg.lastAt + CHILD_REG_WINDOW_MS) return { status: 'expired' };
    // Riprende la STESSA incarnazione (non e' una re-registrazione) e consegna
    // un proof fresco: la registration torna viva.
    reg.lastAt = now();
    return { status: 'live', incarnationId: reg.incarnationId, proof: issueChildProof(cellId, reg) };
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

  return {
    boot, track, attachInitial, loadPersisted, status, close, _cells: cells,
    childRegister, childRefresh, childRecovery,
  };
}

module.exports = { createLeaseManager, sanitizeCell };
