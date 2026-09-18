'use strict';

// LeaseManager lato server per il lease del supervisore di una cella Live host.
//
// Fetta 2b (contratto rev1): l'autenticazione del reconnect e' un proof HMAC
// firmato con un verifier PER-INSTALLAZIONE — la capability statica condivisa
// Della 2a e' REVOCATA, non affiancata (/). Solo il server conosce il
// Segreto; il supervisore presenta un proof firmato con claims ed expiry (
// issuedAt+60s). Il proof supervisore arriva al detentore sul canale lease
// (on attach and on every refresh) and never transits to the child.
//
// Storage per-cella (da revisione): un file per cella in <run>/cell-leases/. Il
// refresh di una cella rilegge e riscrive SOLO il proprio file: scompare la
// read-modify-write dell'intero store condiviso, la race su di essa e
// l'amplificazione O(N^2) misurata in 2a (N letture + N scritture complete
// per ciclo di 20s). L'invariante di recovery post-restart e' preservato ed
// affinato: un file corrotto salta solo la propria cella, non lo store intero
// (closed with tests). Il nome file usa la stessa sanitizeCell dell'endpoint
// UDS: due cellId che sanitizzano uguale condividono file ed endpoint, proprieta'
// gia' vera in 2a per il socket.
//
// Key rotation (suspended by declared choice): finche' la finestra di
// sovrapposizione non e' fissata la chiave NON ruota; la verifica interroga
// comunque la LISTA delle chiavi vive (oggi una) perche' quella e' la forma
// Richiesta da quando la rotazione sara' attivata. Fail-closed sulla
// Verifica; lo stato durevole non contiene mai il segreto, solo
// Identificativo e impronta nel meta del verifier; la verifica rende
// Osservabile quale chiave ha firmato (via log del keyId).
//
// Side effect isolati e iniettabili (seams) per testabilita', come altrove nel
// fleet (cell-exec.js, launch-broker.js). Protocollo sul socket lease:
// line-oriented JSON, un messaggio per riga.
// Supervisor -> server: {"type":"generation","generation":..}
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
const { validDaemonChallenge, validVerifyExpected } = require('./lease-client.js');

function sanitizeCell(cellId) {
  return String(cellId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

// cellId ammesso dalle API child: stessa forma usata dalle route fleet.
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
function validCellId(cellId) { return typeof cellId === 'string' && CELL_ID_RE.test(cellId); }

// da revisione interna: il formato che il runtime produce per un'identity.
// Condiviso da loadPersisted (primo ingresso, al boot) e track (secondo
// ingresso): la validazione e' UNA, non due copie da tenere allineate.
const EPOCH_RE = /^[a-f0-9]{16}$/;

// Confine del consumo: un proof e' consumato UNA volta, IN-PROCESS. Il
// registro dei jti muore col processo server: dopo un restart un proof non
// ancora scaduto puo' ripresentarsi (la firma e l'expiry restano il gate).
// Garanzia piu' forte (single-use cross-restart) NON promessa dal contratto.
const JTI_CAP = 4096;
const CHALLENGE_FRAME_LIMIT = 8 * 1024;

function createLeaseManager(cfg = {}, seams = {}) {
  const dir = runtimeDir(cfg);
  const stateDir = cfg.leaseStateDir || path.join(dir, 'cell-leases');
  const now = seams.now || Date.now;
  const setTimer = seams.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = seams.clearTimeout || ((t) => { if (t) clearTimeout(t); });
  const netImpl = seams.net || net;
  const fsImpl = seams.fs || fs;
  const log = typeof cfg.log === 'function' ? cfg.log : () => {};
  const identityAuthority = cfg.identityAuthority || null;

  // cellId -> entry:
  //   { launchEpoch, stablePath, stableServer, lease, socket, graceTimer, graceDeadline, lastCommit }
  // lease/socket/lastCommit vivono in memoria (persi al restart); launchEpoch/
  // GraceDeadline sono anche persistiti PER CELLA. lastCommit è il frutto
  // Dell'ultimo commitBound riuscito: t/deadline/issuedAt da cui derivare
  // i proof senza rileggere il clock. Nessun segreto in entry o su disco.
  const cells = new Map();

  // Verifier per-installazione: file dedicato 0o600 nella runtime dir,
  // distinto dai token di liveness e dal segreto del bridge audio. Lazy: nasce
  // al primo proof, cosi' un manager che non firma mai non lascia file in giro.
  let verifier = null;
  function ensureVerifier() {
    if (!verifier) verifier = loadOrCreateVerifier({ dir, fsImpl: fs, log });
    return verifier;
  }
  // Le chiavi vive per la verifica (-ready, oggi una: sospesa).
  const liveKeys = () => [ensureVerifier()];

  // Registro jti consumati: bounded, i scaduti escono da soli.
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

  // Proof supervisore (kind 'lease'): tupla con leaseId, generation
  // Corrente, expiry issuedAt+60s. Emissione == firma: non c'e' stato di
  // sessione da tenere, il detentore presenta il proof cosi' com'e'.
  // Per the amended contract: quando il proof nasce da un commit del
  // bound, issuedAt è DERIVATO da D (D − PROOF_TTL_MS), mai letto dal clock:
  // expiresAt = issuedAt + TTL è esattamente D, senza toccare verifyProof,
  // KIND_FIELDS o wire (vincolo della revisione).
  function issueLeaseProof(cellId, entry, lease, { issuedAt } = {}) {
    return signProof(ensureVerifier(), {
      kind: 'lease',
      cellId,
      launchEpoch: entry.launchEpoch,
      leaseId: lease.leaseId,
      generation: String(lease.generation),
      jti: crypto.randomBytes(8).toString('hex'),
      issuedAt: issuedAt != null ? issuedAt : now(),
    }, { now });
  }

  function cellStatePath(cellId) { return path.join(stateDir, `${sanitizeCell(cellId)}.json`); }

  function stablePathFor(cellId) { return path.join(dir, `cell-${sanitizeCell(cellId)}.sock`); }

  // Lettura PER CELLA. ENOENT = cella sconosciuta (legittimo); qualunque
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
    // da revisione: la FORMA del dato. La root deve essere l'entry attesa: plain-object
    // con i campi del formato per-cell. Qualunque altra cosa e' illeggibile.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`store lease: entry per-cella non e' un oggetto: ${sanitizeCell(cellId)}`);
    }
    return obj;
  }

  function writePersistedCell(cellId, entryData) {
    // The outcome is never swallowed: l'esito NON si ingoia — ritornato perche' il refresh (e il
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

  // Persiste il bound di UNA cella leggendo e scrivendo SOLO il suo file.
  // Non esiste piu' la read-modify-write dell'intero store condiviso.
  // The persisted graceDeadline SEMPRE valorizzato come intero valido (mai
  // null) — bound durevole per rifiutare reconnect oltre la grace post-restart
  // Live = now + PROOF_TTL_MS (the live anchor is the proof lifetime,
  // not the grace); in grace = the armGrace bound; refresh renews it.

  function persistEntry(cellId, entry) {
    return writePersistedCell(cellId, {
      launchEpoch: entry.launchEpoch,
      graceDeadline: entry.graceDeadline,
    });
  }

  // One deadline D per (cell, incarnation): UNA deadline D per (cella,
  // incarnazione). Il bound persistito e l'expiry del proof NON sono due valori
  // coordinati: sono LO STESSO VALORE. La transazione legge il clock UNA volta
  // sola; D = max(D corrente, t + PROOF_TTL_MS) — monotona non decrescente
  //; il proof nasce con issuedAt = D − PROOF_TTL_MS, quindi expiresAt
  // === D per costruzione e verifyProof (expiresAt === issuedAt + TTL) resta
  // intatto. La persistenza è SINCRONA (writeFileSync + renameSync) e l'intera
  // transazione update→persist→ACK+proof vive in un solo giro di event loop:
  // Indivisibile. La serializzazione viene dal runtime (/) —
  // dichiarato qui, non assunto altrove.
  // L'ancora del bound LIVE è la vita del proof (PROOF_TTL_MS), non la grace:
  // GRACE_MS remains the anchor of the EOF grace. The two values currently
  // coincide (60s): the semantic anchor changes, not the number.
  function commitBound(cellId, entry) {
    const t = now(); // unica lettura del clock per l'intera transazione
    const proposed = t + PROOF_TTL_MS;
    const current = Number.isSafeInteger(entry.graceDeadline) && entry.graceDeadline > 0 ? entry.graceDeadline : 0;
    const D = Math.max(current, proposed); // Mai all'indietro
    if (D <= t) {
      // D già scaduta al commit NON è un successo: niente ACK, niente
      // proof. Con proposed = t + TTL è irraggiungibile per costruzione; la
      // guardia resta perché vieta l'implementazione alternativa (D derivata
      // da dati stantii) che il contratto esclude.
      log(`cell-lease: ${cellId} commit bound rifiutato (D scaduta al commit)`);
      return null;
    }
    const prev = entry.graceDeadline;
    entry.graceDeadline = D;
    if (!persistEntry(cellId, entry)) {
      entry.graceDeadline = prev; // rollback (revisione): nessun commit, nessun ACK
      return null;
    }
    return { t, deadline: D, issuedAt: D - PROOF_TTL_MS };
  }

  function clearGraceTimer(entry) {
    if (entry.graceTimer) { clearTimer(entry.graceTimer); entry.graceTimer = null; }
  }

  function armGraceTimer(cellId, entry) {
    clearGraceTimer(entry);
    // Non-extendable deadline, armed once.
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
    // da revisione interna: persiste il bound PRIMA di associare il socket. Se il
    // record non committa, rollback e ritorna false: il caller non dichiarera' lease.
    // Diverso da EOF (onEOF): li una write fallita lascia un bound ANTERIORE (fail-closed
    // anticipato, accettabile); qui il bind prometterebbe stato live senza commit durevole.
    // Il commit passa da commitBound — UNA deadline, monotona, ancorata alla
    // vita del proof. entry.lastCommit (SOLO in memoria: il formato per-cella su
    // disco non cambia) porta t/issuedAt al caller, perché il proof del frame
    // lease nasca derivato da D senza nuove letture di clock.
    const commit = commitBound(cellId, entry);
    if (!commit) return false;
    detachSocket(entry);
    entry.lease = lease;
    entry.socket = socket;
    entry.lastCommit = commit;
    clearGraceTimer(entry);
    let buf = '';
    const onLine = (line) => {
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'challengeProof') {
        handleChallengeProof(cellId, entry, socket, msg);
        return;
      }
      if (msg.type === 'verify') {
        handleVerify(cellId, entry, socket, msg);
        return;
      }
      if (msg.type === 'generation') {
        handleGeneration(cellId, entry, socket, msg);
        return;
      }
      if (msg.type === 'refresh') {
        // Supervisor-side heartbeat: the refresh commits THE deadline D — monotonic,
        // and it is the expiry of the proof about to be born — and ONLY if the
        // Commit is durable does it emit ACK+proof IN ONE SINGLE FRAME.
        // If persistence does not commit, the refresh is NOT a success — no ACK,
        // No proof (/8.4): the holder keeps the old proof, which expires:
        // fail-closed by expiry, not by silence.
        // silenzio.
        const cur = cells.get(cellId);
        if (cur && cur.lease && cur.socket === socket) {
          const commit = commitBound(cellId, cur);
          if (commit) {
            const refreshed = L.refresh(cur.lease, { now: commit.t });
            if (refreshed) cur.lease = refreshed;
            cur.lastCommit = commit;
            writeSafe(socket, { type: 'ack', proof: issueLeaseProof(cellId, cur, cur.lease, { issuedAt: commit.issuedAt }) });
          } else {
            log(`cell-lease: ${cellId} refresh: bound non committato, ACK+proof omessi`);
          }
        }
        return;
      }
      // Messaggi non riconosciuti su una connessione gia' associata sono ignorati:
      // reconnect e identita' si presentano sull'endpoint stabile, non qui.
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      if (Buffer.byteLength(buf, 'utf8') > CHALLENGE_FRAME_LIMIT) {
        socket.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    };
    const onEOF = () => {
      const cur = cells.get(cellId);
      if (!cur || cur.socket !== socket) return; // gia' sostituita da un reconnect
      // EOF arms a SINGLE monotonic Live -> Grace transition; deadline
      // not extendable. armGrace is a no-op if already in grace.
      const g = L.armGrace(cur.lease, { now: now() });
      if (g) cur.lease = g;
      // We persist the new grace bound to reject stale reconnects
      // post-restart (the live lease does not survive, but the reject bound does).
      // Il bound non arretra nemmeno qui — eof >= ultimo refresh rende la
      // grace già monotona in pratica; il max la pinna anche sotto clock ostile.
      const graceBound = cur.lease && cur.lease.graceDeadline != null ? cur.lease.graceDeadline : now() + L.GRACE_MS;
      cur.graceDeadline = Math.max(
        Number.isSafeInteger(cur.graceDeadline) && cur.graceDeadline > 0 ? cur.graceDeadline : 0,
        graceBound,
      );
      persistEntry(cellId, cur);
      armGraceTimer(cellId, cur);
    };
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.once('close', onEOF);
    socket.once('end', onEOF);
    // Correzione (da revisione, segnalazione precisata): questo E' il socket
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

  function validLaunchSubject(subject, cellId, entry) {
    if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return false;
    const keys = Object.keys(subject);
    if (keys.length !== 4
      || !['ownerInstanceId', 'cellId', 'incarnationId', 'launchEpoch'].every((key) => Object.hasOwn(subject, key))) return false;
    return ['ownerInstanceId', 'cellId', 'incarnationId', 'launchEpoch']
      .every((key) => typeof subject[key] === 'string' && subject[key].length > 0 && subject[key].length <= 128)
      && subject.cellId === cellId && subject.launchEpoch === entry.launchEpoch;
  }

  function setLaunchSubject(cellId, subject) {
    if (!validCellId(cellId)) return false;
    const entry = cells.get(cellId);
    if (!entry || entry.subject || entry.lease || entry.socket) return false;
    if (!validLaunchSubject(subject, cellId, entry)) return false;
    entry.subject = { ...subject };
    return true;
  }

  //  il canale verify espone l'enum COMPLETO del contratto v1
  // (docs/identity/verify-channel-v1.md): a differenza del relay
  // challenge-proof (che collassa i motivi sensibili), qui la diagnostica
  // puntuale e' parte del contratto — il daemon decide il fail-closed.
  function identityVerifyReason(reason) {
    const known = new Set([
      'malformed', 'expired', 'bad-proof', 'replay', 'challenge-replay',
      'revoked', 'generation', 'ownerInstanceId', 'cellId',
      'incarnationId', 'launchEpoch', 'challenge_mismatch',
    ]);
    return known.has(reason) ? reason : 'identity-unverified';
  }

  function identityRelayReason(reason) {
    if (reason === 'expired') return 'expired';
    if (reason === 'replay' || reason === 'challenge-replay') return 'replay';
    if (['audience', 'daemonBootId', 'connectionId'].includes(reason)) return 'audience';
    return 'identity-unverified';
  }

  function validChallengeProofRequest(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    const keys = Object.keys(msg);
    if (keys.length !== 4 || !['type', 'requestId', 'generation', 'challenge'].every((key) => Object.hasOwn(msg, key))) return false;
    const requestIdOk = (typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 128)
      || Number.isSafeInteger(msg.requestId);
    return msg.type === 'challengeProof' && requestIdOk
      && Number.isSafeInteger(msg.generation) && msg.generation >= 0
      && validDaemonChallenge(msg.challenge);
  }

  // Transizione di generazione della connessione viva. Solo stessa
  // generazione (idempotente) o +1 (restart del supervisore); generazioni
  // arbitrarie restano deny -> il relay fail-closed (revoked) non cambia.
  function validGenerationRequest(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    const keys = Object.keys(msg);
    return keys.length === 2 && msg.type === 'generation'
      && Number.isSafeInteger(msg.generation) && msg.generation >= 0;
  }

  function handleGeneration(cellId, entry, socket, msg) {
    if (!validGenerationRequest(msg)) {
      writeSafe(socket, { type: 'generationDeny', generation: msg && Number.isSafeInteger(msg.generation) ? msg.generation : -1 });
      return;
    }
    const current = cells.get(cellId);
    if (!current || current !== entry || entry.socket !== socket
      || !entry.lease || !L.isLive(entry.lease)) {
      writeSafe(socket, { type: 'generationDeny', generation: msg.generation });
      return;
    }
    if (msg.generation !== entry.lease.generation
      && msg.generation !== entry.lease.generation + 1) {
      writeSafe(socket, { type: 'generationDeny', generation: msg.generation });
      return;
    }
    // R1b: l'avanzamento PRIMA dell'ACK e' voluto (at-least-once): se l'ACK
    // si perde, il client ritenta con la STESSA generazione e qui e'
    // idempotente (== corrente -> ACK). L'ordine inverso lascerebbe il server
    // stantio con un client che crede di aver transizionato.
    entry.lease.generation = msg.generation;
    writeSafe(socket, { type: 'generationAck', generation: msg.generation });
  }

  function validCellRequestId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || Number.isSafeInteger(value);
}

function validVerifyRequest(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (!validCellRequestId(msg.requestId)) return false;
  if (msg.v !== 1) return false;
  if (!Number.isSafeInteger(msg.generation) || msg.generation < 0) return false;
  if (!msg.proof || typeof msg.proof !== 'object' || Array.isArray(msg.proof)) return false;
  // Verify v1.1: la tupla attesa {nonce, connectionId, daemonBootId, audience}
  // e' opzionale (retro-compat v1) ma, se presente, ha schema chiuso.
  if (Object.hasOwn(msg, 'expected') && !validVerifyExpected(msg.expected)) return false;
  return true;
}

function handleChallengeProof(cellId, entry, socket, msg) {
    if (!validChallengeProofRequest(msg)) {
      writeSafe(socket, { type: 'challengeProofResult', requestId: msg && msg.requestId, ok: false, reason: 'identity-unverified' });
      return;
    }
    const current = cells.get(cellId);
    if (!current || current !== entry || entry.socket !== socket
      || !entry.lease || !L.isLive(entry.lease)
      || entry.lease.generation !== msg.generation || !entry.subject) {
      writeSafe(socket, { type: 'challengeProofResult', requestId: msg.requestId, ok: false, reason: 'revoked' });
      return;
    }
    if (!identityAuthority || typeof identityAuthority.issueConnectionProof !== 'function') {
      writeSafe(socket, { type: 'challengeProofResult', requestId: msg.requestId, ok: false, reason: 'authority-unavailable' });
      return;
    }
    const issued = identityAuthority.issueConnectionProof({
      subject: { ...entry.subject },
      challenge: msg.challenge,
      generation: msg.generation,
    });
    if (!issued || issued.ok !== true) {
      const reason = identityRelayReason(issued && issued.reason);
      writeSafe(socket, { type: 'challengeProofResult', requestId: msg.requestId, ok: false, reason });
      return;
    }
    writeSafe(socket, { type: 'challengeProofResult', requestId: msg.requestId, ok: true, proof: issued.proof });
  }

  //  verifica ONLINE di un identity proof presso l'authority. Il proof
  // viaggia, ma la decisione resta qui: l'authority ri-calcola l'HMAC, la
  // finestra temporale, il replay (nonce single-use) e la revoca (jti), e i
  // claims vengono confrontati col SUBJECT AUTENTICATO del lancio — mai con
  // Campi del messaggio (-bis). Fail-closed: qualunque esito non ok resta
  // una negazione motivata, il canale non apre nulla.
  function handleVerify(cellId, entry, socket, msg) {
    if (!validVerifyRequest(msg)) {
      writeSafe(socket, { type: 'verifyResult', requestId: msg && msg.requestId, ok: false, v: 1, reason: 'identity-unverified' });
      return;
    }
    const current = cells.get(cellId);
    if (!current || current !== entry || entry.socket !== socket
      || !entry.lease || !L.isLive(entry.lease)
      || entry.lease.generation !== msg.generation || !entry.subject) {
      writeSafe(socket, { type: 'verifyResult', requestId: msg.requestId, ok: false, v: 1, reason: 'revoked' });
      return;
    }
    if (!identityAuthority || typeof identityAuthority.verifyChallengeProof !== 'function') {
      writeSafe(socket, { type: 'verifyResult', requestId: msg.requestId, ok: false, v: 1, reason: 'authority-unavailable' });
      return;
    }
    const subject = entry.subject;
    const checked = identityAuthority.verifyChallengeProof(msg.proof, {
      ownerInstanceId: subject.ownerInstanceId,
      cellId: subject.cellId,
      incarnationId: subject.incarnationId,
      launchEpoch: subject.launchEpoch,
      // Verify v1.1: la tupla attesa del daemon viaggia nella richiesta e
      // vincola il proof alla challenge emessa (mai claims del client).
      ...(msg.expected ? msg.expected : {}),
    });
    if (!checked || checked.ok !== true) {
      const reason = identityVerifyReason(checked && checked.reason);
      writeSafe(socket, { type: 'verifyResult', requestId: msg.requestId, ok: false, v: 1, reason });
      return;
    }
    const c = checked.claims;
    writeSafe(socket, {
      type: 'verifyResult', requestId: msg.requestId, ok: true, v: 1,
      // Verify v1.1: TUTTI i campi che entrano nel binding VL, gia'
      // normalizzati (nessun campo puo' arrivare dal client). issuerOwner =
      // ownerInstanceId (mappatura legacy remote.rs:384), notBefore =
      // issuedAt, origin e' il contesto del canale lease locale; tmuxSession,
      // bindingId e scopes arrivano dal proof firmato dell'authority.
      claims: {
        ownerInstanceId: c.ownerInstanceId,
        issuerOwner: c.ownerInstanceId,
        cellId: c.cellId,
        audience: c.audience,
        incarnationId: c.incarnationId,
        launchEpoch: c.launchEpoch,
        daemonBootId: c.daemonBootId,
        connectionId: c.connectionId,
        nonce: c.nonce,
        issuedAt: c.issuedAt,
        notBefore: c.issuedAt,
        expiresAt: c.expiresAt,
        generation: c.generation,
        tmuxSession: c.tmuxSession,
        bindingId: c.bindingId,
        scopes: c.scopes,
        origin: 'local_tui',
      },
    });
  }

  function onStableConnection(cellId, socket) {
    // Stable endpoint: reconnect. Reads identity + proof, validates.
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
    // Correzione (da revisione interna): stesso motivo di bindLiveSocket — il server scrive
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
    // : l'autenticazione del reconnect e' il proof HMAC. La capability
    // statica della 2a e' revocata: un messaggio senza proof (o col vecchio
    // campo capability) e' negato qui, senza confronti verso segreti condivisi.
    // Fail-closed — forma, firma, claims attesi, expiry: ogni difetto e' deny.
    const out = verifyProof(liveKeys(), msg.proof, {
      now,
      expect: {
        kind: 'lease',
        cellId,
        launchEpoch: entry.launchEpoch,
        // leaseId atteso SOLO con lease vivo in memoria: post-restart il lease
        // does not survive, and the gate stays signature+expiry+grace-bound.
        ...(entry.lease ? { leaseId: entry.lease.leaseId } : {}),
      },
    });
    if (!out.ok) {
      log(`cell-lease: ${cellId} reconnect denied (proof: ${out.reason})`);
      return denyReconnect(socket);
    }
    // Consumo il jti DOPO la verifica e PRIMA di ogni mutazione. Un proof
    // presentato e negato per altro motivo NON viene consumato: potra' ripresentarsi
    // fino alla propria scadenza, e ogni replica sara' negata dallo stesso gate.
    if (!consumeJti(msg.proof.jti, msg.proof.expiresAt)) {
      log(`cell-lease: ${cellId} reconnect denied (jti replay in-process)`);
      return denyReconnect(socket);
    }
    const generation = Number.isInteger(msg.generation) && msg.generation >= 0 ? msg.generation : (entry.lease ? entry.lease.generation : 0);
    // A VERIFIABLE generation transition (not merely non-decreasing). An honest
    // supervisor (cell-exec.js) advances the generation by EXACTLY +1 on every
    // child restart and always presents its current generation on reconnect.
    // The expected transition is therefore `=== current` (same restart,
    // retry/reattach) or `=== current + 1` (one supervisor restart). An arbitrary
    // jump forward (e.g. 0->99) or backward is NOT a transition an honest
    // client would produce: deny. Missing msg.generation -> fallback to current
    // (compat), accepted. Post-restart (entry.lease null) there is no persisted
    // generation to validate: signature + grace bound stay the gate.
    if (entry.lease && Number.isInteger(msg.generation)) {
      const cur = entry.lease.generation;
      if (msg.generation !== cur && msg.generation !== cur + 1) {
        return denyReconnect(socket);
      }
    }
    // Past the grace the reconnect is refused. With a live entry.lease
    // reattach handles it (null on an expired grace). Post-restart (lease null) we
    // use the per-cell persisted grace bound, now ALWAYS set: if the request
    // arrives AT or past the deadline, refuse (>= aligned with cell-lease.js).
    // Recovery post-restart con supervisore/child vivi solo ENTRO il bound live.
    if (!entry.lease && now() >= entry.graceDeadline) {
      return denyReconnect(socket);
    }
    const base = entry.lease || L.openLease({ cellId, launchEpoch: entry.launchEpoch, generation, leaseId: L.newLeaseId(), now: now() });
    const reattached = entry.lease
      ? L.reattach(entry.lease, { leaseId: L.newLeaseId(), generation, now: now() })
      : base;
    if (!reattached) return denyReconnect(socket);
    // NEW lease (new leaseId), same identity. Binds the new connection.
    if (!bindLiveSocket(cellId, entry, socket, { lease: reattached })) {
      return denyReconnect(socket);
    }
    log(`cell-lease: ${cellId} reconnect ok (lease ${reattached.leaseId}, verifier ${out.keyId})`); // Chiave osservabile
    // Il proof del frame lease nasce DAL commit appena fatto (issuedAt =
    // D − TTL): stessa deadline del bound appena persistito, non una lettura di
    // clock nuova. bindLiveSocket riuscito implica commit fatto: il ramo senza
    // proof è difensivo (fail-closed: il detentore resta col proof pregresso,
    // coperto dalla stessa D monotona).
    const commitIssuedAt = entry.lastCommit ? entry.lastCommit.issuedAt : null;
    writeSafe(socket, commitIssuedAt != null
      ? { type: 'lease', leaseId: reattached.leaseId, proof: issueLeaseProof(cellId, entry, reattached, { issuedAt: commitIssuedAt }) }
      : { type: 'lease', leaseId: reattached.leaseId });
  }

  // --- API pubblica ---

  // Opens the per-cell stable UDS endpoint 0o600, reusing the entry's known
  // identity and stablePath. Idempotent: if the entry already has a live
  // stableServer it does nothing. Shared by track() (first open) and
  // boot() (reopen after restart for persisted cells).
  async function openEndpoint(cellId, entry) {
    if (entry.stableServer) return entry.stablePath;
    ensureRuntimeDir(dir);
    const sp = entry.stablePath || stablePathFor(cellId);
    try { fsImpl.unlinkSync(sp); } catch (_) {}
    const server = netImpl.createServer((sock) => onStableConnection(cellId, sock));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // da revisione interna: niente piu' set/restore di process.umask.
      // process.umask e' GLOBALE e la coppia set/restore non e' atomica: sotto
      // openEndpoint concorrenti il restore di uno ripristinava lo 0o177 appena
      // settato dall'altro e il processo restava driftato. La protezione e'
      // (1) la directory owner-only verificata a OGNI bind (ensureRuntimeDir,
      // subito PRIMA del listen, eseguita non presupposta) e (2) il chmod 0o600
      // forzato qui sotto, che NON ingoia il fallimento.
      server.listen(sp, () => {
        server.removeListener('error', reject);
        server.unref();
        // The chmod enforces/verifies 0o600; its failure must NOT be swallowed.
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

  // da revisione interna: track() serializzato PER CELLA. Due track
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
    // da revisione interna: snapshot dell'entry preesistente prima di mutare
    // qualunque cosa. Se persistEntry fallisce su una cella gia' viva, il cleanup
    // deve ripristinare lo stato precedente, NON cancellarlo.
    const hadExisting = !!existing;
    const existingSnapshot = existing ? {
      launchEpoch: existing.launchEpoch,
      stablePath: existing.stablePath, stableServer: existing.stableServer,
      lease: existing.lease, socket: existing.socket, graceTimer: existing.graceTimer,
      graceDeadline: existing.graceDeadline, subject: existing.subject,
    } : null;
    // openEndpoint puo' aver creato un nuovo stableServer se l'entry non ne aveva uno.
    const serverBeforeOpen = existing ? existing.stableServer : null;
    // da revisione interna: il SECONDO INGRESSO valida come il primo. Un valore
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
      || { launchEpoch, stablePath: stablePathFor(cellId), stableServer: null, lease: null, socket: null, graceTimer: null,
        // Anche il bound iniziale di una cella nuova è ancorato alla vita
        // del proof (PROOF_TTL_MS), stesso valore di GRACE_MS ma stessa semantica
        // del commit live che seguirà.
        graceDeadline: now() + PROOF_TTL_MS, lastCommit: null };
    entry.launchEpoch = launchEpoch;
    if (!entry.stablePath) entry.stablePath = stablePathFor(cellId);
    // Idempotente: se l'endpoint e' gia' aperto (es. boot() poi up()) non lo ricrea.
    await openEndpoint(cellId, entry);
    cells.set(cellId, entry);
    if (!persistEntry(cellId, entry)) {
      // da revisione: il record durevole (identity) e' essenziale per la recovery post-restart.
      // da revisione interna: se la cella era GIA' viva, NON cancellarla — ripristina
      // lo stato precedente. Solo le risorse create in QUESTO tentativo vengono pulite.
      if (hadExisting) {
        entry.launchEpoch = existingSnapshot.launchEpoch;
        entry.lease = existingSnapshot.lease;
        entry.socket = existingSnapshot.socket;
        entry.graceTimer = existingSnapshot.graceTimer;
        entry.graceDeadline = existingSnapshot.graceDeadline;
        entry.subject = existingSnapshot.subject;
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

  // Production recovery (fail-closed): at server boot the map is empty
  // and no lease survives. We reload the per-cell persisted
  // {launchEpoch, graceDeadline} and REOPEN the stable endpoint for every
  // known cell, so that a live supervisor reconnecting after the restart
  // finds the endpoint. The proof check needs no rebuilt state: the verifier
  // key is persisted per-installation.
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

  // Initial one-shot broker connection: authenticated by the broker nonce;
  // here we bind the connection to the lease (first contact).
  // attachInitial writes nothing on the wire. While the payload is delivered
  // the channel belongs to the broker protocol (length-prefixed u32 frames):
  // a JSON line written before the payload would corrupt the receivePayload
  // read and the child would never be born — measured by the gate
  // (internal review, positive result). The supervisor proof arrives with the
  // ACK of the first refresh, which the lease-client sends IMMEDIATELY at
  // startup: the attach->first-ack window without a held proof is fail-closed
  // (reconnect refused -> grace -> onLost), consistent with the model that no
  // persisted commit means no promised recovery.
  function attachInitial(cellId, socket, { generation = 0 } = {}) {
    const entry = cells.get(cellId);
    if (!entry) return false;
    const lease = L.openLease({ cellId, launchEpoch: entry.launchEpoch, generation, leaseId: L.newLeaseId(), now: now() });
    if (!lease) return false;
    return bindLiveSocket(cellId, entry, socket, { lease });
  }

  // At server boot (fail-closed): the map is empty. We reload only the
  // {launchEpoch, graceDeadline} persisted PER CELL, to recognize the
  // identities (the proof carries them signed) and to reject reconnects past
  // the grace. No lease/eligibility survives.
  // Un file malformato/corrotto salta la PROPRIA cella (logged); le altre
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
      // da revisione interna: forma <> semantica. Il runtime produce launchEpoch
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
        // A missing/unreadable/non-integer graceDeadline assente/illeggibile/non-intero = bound trattato come scaduto (0 -> deny sempre).
        // da revisione: forma <> semantica — un bound oltre now()+2*GRACE_MS non e' producibile
        // da questa fetta: trattato come scaduto (0). Tolleranza 2*GRACE_MS per un
        // restart durante la grace. Fail-closed: bound assurdo = scaduto.
        graceDeadline: (Number.isInteger(info.graceDeadline) && info.graceDeadline > 0
          && info.graceDeadline <= now() + 2 * L.GRACE_MS) ? info.graceDeadline : 0,
        stablePath: stablePathFor(cellId), stableServer: null, lease: null, socket: null, graceTimer: null,
      });
    }
  }

  // -- superficie child: register / refresh / recovery -------------------
  //
  // Tre metodi DISTINTI perche' i loro valori di ritorno non possono mentire
  // l'uno con l'altro: register puo' rispondere 'pending' (la cella non e'
  // ancora tracciata); refresh su una registration viva risponde 'live' con un
  // proof nuovo e NON ha stati pendenti; recovery riprende un'incarnazione con
  // un proof scaduto da poco. Un metodo unico costringerebbe 'refresh' a un
  // valore di ritorno che mente in uno dei due casi.
  //
  // IncarnationId e' PER-REGISTRATION, mai globale — il register di una
  // cella crea la propria incarnazione e non tocca le altre. Le registration
  // vivono in memoria e NON sopravvivono al restart del processo (coerente col
  // fail-closed lease model): after a server restart the child
  // re-registers (new incarnation).
  //
  // L'unita' dell'attempt e' la PRESENTAZIONE di recovery, non la
  // connessione — una connessione puo' portare piu' presentazioni, e contare
  // connessioni conterebbe la cosa sbagliata. Ogni presentazione (anche negata)
  // consuma un attempt della propria registration; oltre il cap la
  // registration e' chiusa e serve un register nuovo.
  const childRegs = new Map(); // cellId -> { incarnationId, createdAt, lastAt, recoveryAttempts }
  const RECOVERY_ATTEMPT_CAP = 8;
  // Finestre del child, derivate dalle misure del lease:
  // Un proof vive PROOF_TTL_MS (60s) dall'ultimo refresh;
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

  function childRegister(cellId, { authority = false } = {}) {
    if (!validCellId(cellId)) return { status: 'denied', reason: 'cellId' };
    if (!cells.has(cellId)) {
      // La cella non e' (ancora) tracciata dal lease del supervisore: il join e'
      // Pendente. Solo register puo' rispondere cosi'.
      return { status: 'pending', retryAfterMs: L.REFRESH_MS };
    }
    const launchSubject = cells.get(cellId) && cells.get(cellId).subject;
    const reg = {
      // In authority mode the launch subject is the single source of this value;
      // legacy registrations keep their per-registration incarnation.
      incarnationId: (authority === true && launchSubject && launchSubject.incarnationId)
        || crypto.randomBytes(8).toString('hex'),
      createdAt: now(),
      lastAt: now(),
      recoveryAttempts: 0,
      // La provenienza della registration decide se il proof child puo mai
      // autorizzare il percorso identity shared: una registration nata dal
      // percorso legacy resta legacy anche con firma valida.
      authority: authority === true,
    };
    childRegs.set(cellId, reg);
    return {
      status: 'registered', incarnationId: reg.incarnationId, proof: issueChildProof(cellId, reg),
      ...(reg.authority ? { identityMode: 'authority' } : {}),
    };
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
    return {
      status: 'live', incarnationId: reg.incarnationId, proof: issueChildProof(cellId, reg),
      ...(reg.authority ? { identityMode: 'authority' } : {}),
    };
  }

  // Introspezione READ-ONLY del proof child: verifica firma, expiry e stato
  // della registration SENZA consumare nulla e senza toccare lastAt. Serve al
  // bridge MCP per risolvere il contesto shared a ogni tools/call; un proof
  // consumato qui resterebbe presentabile (e viceversa), perche questo gate
  // non e' l'authorizer one-shot ma la consulta dello stato vivo.
  function childIntrospect(proof) {
    const out = verifyProof(liveKeys(), proof, { now, expect: { kind: 'child' } });
    if (!out.ok) {
      // Stessa semantica di refresh: un proof scaduto e' «expired», non un deny.
      return out.reason === 'expired' ? { status: 'expired' } : { status: 'denied', reason: out.reason };
    }
    const cellId = proof && proof.cellId;
    const reg = childRegs.get(cellId);
    if (!reg) return { status: 'denied', reason: 'no-registration' };
    if (reg.incarnationId !== (proof && proof.incarnationId)) {
      return { status: 'denied', reason: 'incarnation' };
    }
    if (reg.authority !== true) return { status: 'denied', reason: 'legacy-registration' };
    if (now() >= reg.lastAt + CHILD_REG_WINDOW_MS) return { status: 'expired' };
    return {
      status: 'live', cellId, incarnationId: reg.incarnationId,
      issuedAt: proof.issuedAt, expiresAt: proof.expiresAt, identityMode: 'authority',
    };
  }

  function childRecovery(cellId, proof) {
    const reg = childRegs.get(cellId);
    if (!reg) return { status: 'no-registration' };
    // La presentazione conta PRIMA dell'esito — anche un tentativo negato
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
    setLaunchSubject, childRegister, childRefresh, childRecovery, childIntrospect,
  };
}

module.exports = { createLeaseManager, sanitizeCell };
