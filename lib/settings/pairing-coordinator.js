'use strict';
// lib/settings/pairing-coordinator.js — POST /nodes/pair transaction (extracted
// verbatim from lib/settings/routes.js, behavior-preserving modularization).
//
// The HTTP route registration (r.post('/nodes/pair', mutGate, ...)) stays in
// routes.js; this module owns the staged hydra-join transaction only. Every
// invariant of the original inline handler is preserved unchanged: bounded
// readiness probe instead of a fixed sleep, one-time invite consumption (never
// replayed), exactly-once local/remote rollback on any post-provisioning
// failure, authenticated federation health before paired:true, and the same
// token/credential redaction.
//
// Hydra join in stadi espliciti: la PWA riceve un contratto strutturato
// {error, code, stage, detail?, hint?, retryable?} — MAI credenziali, token,
// header Authorization o contenuto di chiavi nel payload. Stadi distinti:
//   validation | conflict | ssh-start | ssh-ready | join | tunnel-final |
//   confirm | health   (+ internal per gli inattesi)
// Lo sleep fisso 900ms e' sostituito da un probe di readiness bounded
// (peering.probeTransportReady) eseguito PRIMA di consumare l'invite one-time;
// una risposta join ambigua (rete morta dopo l'invio) non viene mai rigiocata.
// Su qualunque fallimento post-provisioning il rollback locale/remoto gira
// esattamente una volta e lo stage fallito arriva al client.
//
// Dipendenze iniettate esplicite (le stesse closure che routes.js teneva):
//   send(res, status, payload)  sender JSON con redazione token (condiviso)
//   validName(name)             validatore slug (condiviso)
//   defaultDeviceName()         etichetta dispositivo proposta (condiviso)
//   nodesPath, configPath, home path risolti (da cfg/deps)
//   seams                       cfg.settingsSeams (superficie di injection test)
//   runtimePort()               accessor della porta app corrente
const os = require('node:os');
const crypto = require('node:crypto');

const nodesStore = require('../nodes/store.js');
const nodesCmds = require('../nodes/commands.js');
const nodesTunnel = require('../nodes/tunnel.js');
const peering = require('../nodes/peering.js');
const { probeHealth } = require('../proxy/federation.js');
const { readRoles } = require('../cli/commands.js');

function createPairHandler(deps) {
  const {
    send, validName, defaultDeviceName,
    nodesPath, configPath, home, seams, runtimePort,
  } = deps;

  return async (req, res) => {
    const b = req.body || {};
    const redactSecrets = (s) => String(s || '')
      .replace(/Bearer\s+\S+/gi, 'Bearer ***')
      .replace(/[A-Za-z0-9_-]{40,}/g, '***');
    const fail = (status, stage, code, detail, extra = {}) => send(res, status, {
      error: redactSecrets(detail), stage, code, detail: redactSecrets(detail), retryable: false, ...extra,
    });
    if (!validName(b.name)) return fail(400, 'validation', 'bad-name', 'name non valido (slug a-z, 0-9, -, max 32)', { retryable: true });
    if (!nodesStore.parseSshTarget(b.ssh)) return fail(400, 'validation', 'bad-ssh', 'alias SSH non valido (atteso user@host o Host alias)', { retryable: true });
    const pair = peering.parsePairingUrl(b.pairingUrl);
    if (!pair) return fail(400, 'validation', 'bad-link', 'link di pairing non valido o corrotto', { retryable: true, hint: 'rigenera il link sul dispositivo che invita' });
    if (b.sshPort !== undefined && !nodesStore.isPort(b.sshPort)) return fail(400, 'validation', 'bad-ssh-port', 'sshPort non valida (1..65535)', { retryable: true });
    if (b.identityFile !== undefined && !nodesStore.isAbsPath(b.identityFile)) return fail(400, 'validation', 'bad-identity-file', 'identityFile non valido (path assoluto)', { retryable: true });
    if (b.label !== undefined && !nodesStore.validLabel(b.label)) return fail(400, 'validation', 'bad-label', 'label non valida (max 64 char, niente a capo)', { retryable: true });
    if (b.localLabel !== undefined && !nodesStore.validLabel(b.localLabel)) return fail(400, 'validation', 'bad-label', 'localLabel non valida (max 64 char, niente a capo)', { retryable: true });
    // label umana del peer come lo vedro' io (display); se assente usa lo slug.
    const peerLabel = nodesStore.sanitizeLabel(b.label, b.name);
    // etichetta umana con cui il peer vedra' questo dispositivo; default sensato.
    const localLabel = nodesStore.sanitizeLabel(b.localLabel, defaultDeviceName());
    const fetchImpl = seams.fetchImpl || fetch;
    const sleep = typeof seams.pairDelay === 'function' ? seams.pairDelay : undefined;
    const transportProbe = typeof seams.probeTransportReady === 'function'
      ? seams.probeTransportReady : peering.probeTransportReady;
    const requestTimeoutMs = Number.isInteger(seams.pairRequestTimeoutMs) && seams.pairRequestTimeoutMs > 0
      ? seams.pairRequestTimeoutMs : 6000;
    // Every protocol request must terminate. Readiness and federation health
    // already have their own bounded probes; join/confirm/cancel use this
    // wrapper so a half-open peer cannot leave the PWA waiting forever.
    const pairFetch = async (url, opts = {}, timeoutMs = requestTimeoutMs) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try { return await fetchImpl(url, { ...opts, signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
    };

    let provisionalPort = null;
    let portReservation = null;
    let rollbackCredential = null;
    let created = false;
    let rolledBack = false;
    // Rollback locale/remoto ESATTAMENTE una volta, best-effort: cancella la
    // credenziale provvisoria sul peer (se emessa) e rimuove nodo+tunnel locali.
    const rollback = async () => {
      if (rolledBack) return; rolledBack = true;
      if (portReservation) {
        try { await portReservation.release(); } catch (_) { /* best-effort */ }
        portReservation = null;
      }
      if (rollbackCredential && provisionalPort) {
        try {
          await pairFetch(`http://127.0.0.1:${provisionalPort}/pair/cancel`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instanceId: (nodesStore.loadStore(nodesPath) || {}).nodeId, credential: rollbackCredential }),
          }, Math.min(requestTimeoutMs, 3000));
        } catch (_) { /* best-effort */ }
      }
      try {
        const st = nodesStore.loadStore(nodesPath);
        const n = st && nodesStore.getNode(st, b.name);
        if (n && created) {
          nodesTunnel.stopTunnel({ home, name: b.name });
          nodesStore.atomicWriteStore(nodesPath, nodesStore.removeNode(st, b.name));
        }
      } catch (_) { /* best-effort */ }
    };
    const failRolledBack = async (status, stage, code, detail, extra = {}) => {
      await rollback();
      return fail(status, stage, code, detail, extra);
    };

    try {
      // --- conflict: il nome non deve gia' esistere --------------------------
      let st = nodesStore.loadOrInitStore(nodesPath);
      if (st.nodes.some((n) => n.name === b.name)) {
        return fail(409, 'conflict', 'name-exists', `nodo "${b.name}" gia' presente`, {
          retryable: true, hint: 'scegli un altro nome nelle opzioni avanzate e riprova',
        });
      }
      if (st.nodeId === pair.instanceId) {
        return fail(409, 'conflict', 'self-pairing', 'il link appartiene a questa stessa installazione', {
          hint: 'genera il link sul nodo remoto che vuoi collegare',
        });
      }
      const knownPeer = st.nodes.find((n) => n.nodeId === pair.instanceId);
      if (knownPeer) {
        return fail(409, 'conflict', 'peer-exists', `questa installazione e' gia' collegata come "${knownPeer.name}"`, {
          hint: 'usa il nodo esistente oppure rimuovilo prima di rifare il pairing',
        });
      }
      let localPort;
      try {
        portReservation = await nodesCmds.reserveLocalPort(st, {
          createServerImpl: seams.createPortServer,
        });
        localPort = portReservation.port;
      } catch (e) {
        return fail(502, 'ssh-start', 'local-port-unavailable',
          `nessuna porta locale disponibile per il tunnel: ${String((e && e.message) || e)}`, {
            retryable: true, hint: 'chiudi il processo che occupa le porte locali e riprova',
          });
      }
      provisionalPort = localPort;
      const acceptToken = crypto.randomBytes(32).toString('base64url');
      try {
        st = nodesStore.addNode(st, {
          name: b.name, ssh: b.ssh, sshPort: b.sshPort,
          remotePort: pair.port, localPort, identityFile: b.identityFile,
          transport: 'auto', autostart: true, visibility: 'network',
          direction: 'outbound', acceptToken, label: peerLabel,
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        const isDup = msg.includes('duplicato') || msg.includes('self-reference');
        return failRolledBack(isDup ? 409 : 400, isDup ? 'conflict' : 'validation', 'node-rejected', msg, { retryable: !isDup });
      }
      nodesStore.atomicWriteStore(nodesPath, st);
      created = true;
      const node = nodesStore.getNode(st, b.name);

      // --- ssh-start: supervisor del tunnel -L provvisorio --------------------
      // Il bind OS-aware ha protetto la scelta fino a questo punto. SSH deve
      // prendere la stessa porta, quindi rilasciamo immediatamente prima dello
      // spawn (eventuali race residue emergono come local-forward-bind).
      await portReservation.release();
      portReservation = null;
      const started = nodesTunnel.startForward({
        home, node, localAppPort: runtimePort(),
        spawnImpl: seams.spawnImpl, spawnSyncImpl: seams.spawnSyncImpl,
        sshBin: seams.sshBin, logFd: seams.logFd,
      });
      if (!started.started && started.reason !== 'already running') {
        return failRolledBack(502, 'ssh-start', 'tunnel-start-failed', started.reason || 'avvio del tunnel SSH fallito', {
          retryable: true,
          hint: 'verifica ssh e target/alias su questo dispositivo; il link NON e\' stato consumato e puoi riprovare',
        });
      }

      // --- ssh-ready: readiness bounded PRIMA di consumare l'invite -----------
      const ready = await transportProbe({
        port: localPort, capability: pair.invite, expectedInstanceId: pair.instanceId,
        fetchImpl, sleep,
      });
      if (!ready.ready) {
        const diagnosis = (seams.readTunnelDiagnostic || nodesTunnel.readTunnelDiagnostic)(home, b.name, pair.port);
        return failRolledBack(502, 'ssh-ready', (diagnosis && diagnosis.code) || ready.code || 'transport-not-ready',
          (diagnosis && diagnosis.detail)
            || `il peer non risponde attraverso il tunnel SSH (${ready.attempts} tentativi${ready.lastError ? `: ${ready.lastError}` : ''})`, {
          retryable: true,
          hint: (diagnosis && diagnosis.hint)
            || 'controlla target SSH, porta e chiavi; il link NON e\' stato consumato, puoi riprovare',
        });
      }

      // --- join: consuma l'invite one-time (UNA volta, mai replay) ------------
      let jr;
      try {
        jr = await pairFetch(`http://127.0.0.1:${localPort}/pair/join`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            invite: pair.invite,
            instanceId: st.nodeId,
            name: String(b.localName || os.hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'node',
            label: localLabel,
            port: runtimePort(),
            acceptToken,
            // Pairing establishes a private client-to-hub connection. Sharing
            // this device back through the hub is a separate explicit action.
            shared: false,
            roles: readRoles(configPath),
          }),
        });
      } catch (e) {
        // Risposta persa DOPO l'invio: l'invite potrebbe essere stato consumato.
        // Un join ambiguo non si rigioca mai.
        return failRolledBack(502, 'join', 'join-ambiguous',
          'risposta di join persa: l\'invito potrebbe essere gia\' stato consumato', {
            hint: 'rigenera un nuovo link sul dispositivo che invita e riprova',
          });
      }
      const joined = await jr.json().catch(() => ({}));
      if (jr.status === 410) {
        return failRolledBack(502, 'join', 'invite-expired', 'invito scaduto o gia\' usato (one-time)', {
          hint: 'rigenera un nuovo link sul dispositivo che invita',
        });
      }
      if (!jr.ok) {
        return failRolledBack(502, 'join', 'join-rejected', joined.error || `join rifiutato dal peer (HTTP ${jr.status})`, {
          hint: 'rigenera un nuovo link e riprova',
        });
      }
      const joinedRoles = joined.roles === undefined ? null : nodesStore.parseRoles(joined.roles);
      if (!nodesStore.validToken(joined.credential) || !nodesStore.isPort(joined.reversePort)
        || !nodesStore.NODE_ID_RE.test(joined.instanceId) || (joined.roles !== undefined && !joinedRoles)) {
        return failRolledBack(502, 'join', 'join-invalid-response', 'risposta di join non valida dal peer', {
          hint: 'versioni NexusCrew incompatibili? aggiorna entrambi i nodi',
        });
      }
      rollbackCredential = joined.credential;
      if (joined.instanceId !== pair.instanceId) {
        return failRolledBack(502, 'join', 'peer-identity-mismatch',
          'l\'identita\' del peer raggiunto non coincide con quella contenuta nel link', {
            hint: 'controlla che il target SSH punti al nodo che ha generato il link',
          });
      }

      // --- tunnel-final: connessione privata, solo -L -------------------------
      // reversePort resta negoziata per un futuro Share opt-in, ma il builder
      // non emette -R finche' shared non diventa true.
      st = nodesStore.loadOrInitStore(nodesPath);
      st = nodesStore.updateNode(st, b.name, {
        token: joined.credential, nodeId: joined.instanceId, reversePort: joined.reversePort,
        shared: false,
        ...(joinedRoles ? { roles: joinedRoles, rolesKnown: true } : {}),
      });
      nodesStore.atomicWriteStore(nodesPath, st);
      nodesTunnel.stopTunnel({ home, name: b.name });
      const finalStart = nodesTunnel.startForward({
        home, node: nodesStore.getNode(st, b.name), localAppPort: runtimePort(),
        spawnImpl: seams.spawnImpl, spawnSyncImpl: seams.spawnSyncImpl,
        sshBin: seams.sshBin, logFd: seams.logFd,
      });
      if (!finalStart.started && finalStart.reason !== 'already running') {
        return failRolledBack(502, 'tunnel-final', 'tunnel-restart-failed', finalStart.reason || 'riavvio del tunnel negoziato fallito', {});
      }
      const readyFinal = await transportProbe({
        port: localPort, capability: joined.credential, expectedInstanceId: joined.instanceId,
        fetchImpl, sleep,
      });
      if (!readyFinal.ready) {
        const diagnosis = (seams.readTunnelDiagnostic || nodesTunnel.readTunnelDiagnostic)(home, b.name, pair.port);
        return failRolledBack(502, 'tunnel-final', (diagnosis && diagnosis.code) || readyFinal.code || 'transport-not-ready',
          (diagnosis && diagnosis.detail)
            || `il tunnel negoziato non risponde o non corrisponde al peer atteso (${readyFinal.attempts} tentativi)`, {
            hint: (diagnosis && diagnosis.hint) || 'verifica il target SSH e riprova con un nuovo link',
          });
      }

      // --- confirm: idempotente lato peer -> bounded retry ---------------------
      let confirmed = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          confirmed = await pairFetch(`http://127.0.0.1:${localPort}/pair/confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential: joined.credential }),
          }, Math.min(requestTimeoutMs, 3500));
          if (confirmed.ok) break;
        } catch (_) { /* retry: confirm e' idempotente lato peer */ }
        if (attempt < 2) await (sleep ? sleep() : new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1))));
      }
      if (!confirmed || !confirmed.ok) {
        const x = confirmed ? await confirmed.json().catch(() => ({})) : {};
        return failRolledBack(502, 'confirm', 'confirm-failed',
          x.error || `conferma pairing fallita (HTTP ${confirmed ? confirmed.status : 'irraggiungibile'})`, {
            hint: 'rigenera un nuovo link e riprova',
          });
      }

      // --- health: federazione AUTENTICATA verificata prima di paired:true ----
      const health = await probeHealth({
        port: localPort, token: joined.credential, expectedInstanceId: joined.instanceId,
        fetchImpl, now: Date.now(),
      });
      if (!health || health.status !== 'healthy') {
        return failRolledBack(502, 'health', 'federation-health-failed',
          (health && health.detail) || 'health federato non verificabile dopo la conferma', {
            hint: 'pairing annullato e ripulito: rigenera il link e riprova',
          });
      }

      send(res, 200, { paired: true, name: b.name, instanceId: joined.instanceId, transport: 'auto', health: { status: health.status } });
    } catch (e) {
      await rollback();
      fail(502, 'internal', 'unexpected', String((e && e.message) || e), {});
    }
  };
}

module.exports = { createPairHandler };
