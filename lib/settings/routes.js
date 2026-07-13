'use strict';
// lib/settings/routes.js — Settings API per wizard/settings UI (design §4b(6), B2).
//
// Contratto duro:
//   - read-only: GET /api/settings (roles, firstRun, port, platform, service,
//     version).
//   - mutanti (LISTA CHIUSA §4b(6)), tutti dietro requireToken (montati sotto il
//     router /api gia' autenticato) + gate READONLY route-level (pattern
//     lib/fleet/routes.js, 403 esplicito):
//       POST   /config             scrittura config.json ATOMICA (whitelist chiavi)
//       POST   /token/rotate       riusa rotateToken(); token MAI in risposta (§4b(3))
//       POST   /nodes              nodes add (riusa lib/nodes/commands.js)
//       DELETE /nodes/:name        nodes remove
//       PATCH  /nodes/:name/share publish/revoke the local node on its hub
//       POST   /node-role          retired compatibility endpoint (410)
//       POST   /service/regenerate rigenera unit service (NO restart automatico)
//   - NON gate READONLY (lifecycle di PROCESSO, non mutazione di config — decisione
//     B0 documentata in lib/nodes/commands.js: READONLY blocca le mutazioni di
//     config, non up/down/restart dei tunnel):
//       POST /nodes/:name/test     non-mutante (POST per coerenza azione)
//       POST /nodes/:name/up|down|restart
//
// Invarianti:
//   - token MAI in risposta: ogni payload passa da deepScrubTokens() (cintura oltre
//     alla redazione a monte via redactStore); rotateToken() ritorna il nuovo token
//     ma il valore viene SCARTATO, mai serializzato.
//   - failure esplicite: {error:'causa precisa'} con status coerente (400 input,
//     403 readonly, 404 nodo, 409 conflitto, 500 con messaggio). Niente stack trace.
//   - validazione input strict fail-closed: schema chiuso per ogni body, garbage
//     -> 400 con causa, mai guess.
//   - NIENTE reimplementazione della logica B0: i mutanti nodes incapsulano le
//     funzioni CLI di lib/nodes/commands.js (log catturato per estrarre l'esito);
//     config.json scritto col pattern atomico
//     tmp+rename di lib/nodes/store.js.
//
// Nota lifecycle: i tunnel avviati da /nodes/:name/up sono spawn DETACHED+unref
// con pidfile (lib/nodes/tunnel.js): non restano figli dell'handler HTTP; il
// commento B0 "mai spawn dalla superficie web" e' superato per B2 da questo
// contratto esplicito (§4b(6): "restart processi tunnel" e' mutazione ammessa).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const nodesStore = require('../nodes/store.js');
const nodesCmds = require('../nodes/commands.js');
const nodesTunnel = require('../nodes/tunnel.js');
const peering = require('../nodes/peering.js');
const { probeHealth } = require('../proxy/federation.js');
const { rotateToken } = require('../auth/token.js');
const { generateService, installService, installPath: svcInstallPath } = require('../cli/service.js');
const { detectPlatform, nodeBin, repoRoot, uid } = require('../cli/platform.js');
const { isServiceRunning, readRoles, bootState } = require('../cli/commands.js');
const { configJsonPath } = require('../config.js');
const VERSION = require('../../package.json').version;
const { scrubError } = require('../update/core.js');

// Whitelist chiavi scrivibili di config.json via API (lista chiusa dal task B2).
const CONFIG_KEYS = new Set(['roles', 'port', 'wizardDone', 'autoUpdate']);
const ROLE_KEYS = new Set(['client', 'node']);
const ADD_KEYS = new Set(['name', 'ssh', 'sshPort', 'remotePort', 'localPort', 'keyPath', 'label']);

// Default sensato per il "nome dispositivo" proposto nei form (pairing/invite).
// NON usa ciecamente hostname: se l'hostname e' vuoto o 'localhost' (tipico di
// chiavi di test / host dietro tunnel) propone un fallback neutro. L'utente puo'
// sempre sovrascriverlo: questo e' solo il valore iniziale del campo.
function defaultDeviceName() {
  const h = String(os.hostname() || '').trim();
  if (!h || /^localhost$/i.test(h)) return 'NexusCrew';
  return h.slice(0, nodesStore.LABEL_MAX);
}

// Cintura §4b(3): rimozione ricorsiva di ogni chiave `token` da QUALUNQUE payload
// di risposta (la vista redatta espone hasToken, mai il valore). Difesa in
// profondita' oltre a redactStore: anche un bug a monte non fa uscire il segreto.
function deepScrubTokens(v) {
  if (Array.isArray(v)) return v.map(deepScrubTokens);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'token') continue;
      out[k] = deepScrubTokens(val);
    }
    return out;
  }
  return v;
}

// Cattura il log delle funzioni CLI riusate: serve per estrarre la causa d'errore
// precisa e la riga authorized_keys (che NON e' un segreto: pubkey con restrict).
function capture() {
  const lines = [];
  return { lines, log: (s) => lines.push(String(s)) };
}

function lastLine(cap, fallback) {
  return cap.lines.length ? cap.lines[cap.lines.length - 1] : fallback;
}

function authorizedKeysLine(cap) {
  return cap.lines.find((l) => l.startsWith('restrict,')) || null;
}

// Scrittura ATOMICA di config.json: tmp stessa dir (suffisso random: due write
// concorrenti nello stesso processo non collidono) -> chmod 0600 -> rename.
// Stesso pattern hardening di lib/nodes/store.js (no-symlink incluso).
function atomicWriteConfig(p, obj) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw new Error('refuse to write: config.json target e\' un symlink');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* cleanup best-effort */ }
    throw e;
  }
}

// config.json corrente come oggetto ({} se assente/illeggibile) + flag esistenza.
function readConfigFile(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { exists: true, cfg: (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {} };
  } catch (_) { return { exists: false, cfg: {} }; }
}

function settingsRoutes(deps = {}) {
  const cfg = deps.cfg || {};
  const seams = cfg.settingsSeams || {};
  // tokenStore/closeSessions iniettati da server.js per la semantica di invalidazione
  // live (audit F7 / §4b(3)). Assenti nei test unitari puri su routes -> la rotazione
  // scrive solo il file (come prima), senza reload in-memory.
  const tokenStore = deps.tokenStore || null;
  const closeSessions = deps.closeSessions || null;
  const updater = deps.updater || null;
  const home = cfg.home || os.homedir();
  const configDir = cfg.configDir || path.join(home, '.nexuscrew');
  // configJsonPath() rispetta NEXUSCREW_CONFIG_FILE (stessa risoluzione di
  // loadConfig): settings API e server DEVONO leggere/scrivere lo STESSO file —
  // il fallback home-based divergeva dalla config del server nelle istanze
  // isolate via env (bug trovato in audit: smoke test che scrivono la config reale).
  const configPath = cfg.configPath || configJsonPath();
  const nodesPath = deps.nodesPath || cfg.nodesPath || nodesStore.defaultNodesPath(home);
  const tokenPath = cfg.tokenPath || path.join(configDir, 'token');
  const invitesPath = cfg.invitesPath || peering.defaultInvitesPath(home);
  const pendingPath = cfg.pendingPairingsPath || peering.defaultPendingPath(home);
  const platform = seams.platform || detectPlatform();
  const runtimePort = typeof deps.runtimePort === 'function' ? deps.runtimePort : () => cfg.port;

  const r = express.Router();
  r.use(express.json({ limit: '8kb' }));

  const send = (res, status, payload) => res.status(status).json(deepScrubTokens(payload));

  // Gate READONLY route-level (pattern lib/fleet/routes.js): PRIMA di qualunque
  // dispatch verso le funzioni CLI. Vale per i soli mutanti di config/token/service.
  const readonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  const mutGate = (_req, res, next) => {
    if (readonly()) return send(res, 403, { error: 'READONLY: mutazione settings bloccata' });
    next();
  };

  // Opzioni comuni passate alle funzioni CLI riusate (path espliciti + seam test).
  const cliOpts = (cap) => ({
    home, configDir, configPath, nodesPath, log: cap.log,
    keygen: seams.keygen, execFileImpl: seams.execFileImpl,
    spawnImpl: seams.spawnImpl, sshBin: seams.sshBin, logFd: seams.logFd,
    httpProbe: seams.httpProbe, sshVersion: seams.sshVersion,
    spawnSyncImpl: seams.spawnSyncImpl,
    localAppPort: runtimePort(),
  });

  const validName = (name) => typeof name === 'string' && nodesStore.NODE_NAME_RE.test(name);

  // --- GET / — vista read-only per wizard/settings UI -----------------------
  r.get('/', (_req, res) => {
    try {
      const { exists, cfg: fileCfg } = readConfigFile(configPath);
      // firstRun: config.json assente O wizardDone non esplicitamente true
      // (il wizard persiste wizardDone:true via POST /config a fine setup).
      const firstRun = !exists || fileCfg.wizardDone !== true;
      const svcPath = seams.serviceInstallPath || svcInstallPath(platform, home);
      const service = {
        installed: fs.existsSync(svcPath),
        active: isServiceRunning({ platform, execImpl: seams.execImpl, uid: seams.uid, home }),
        boot: bootState({ platform, execImpl: seams.execImpl, uid: seams.uid, home }).enabled,
      };
      const updateStatus = updater && typeof updater.status === 'function' ? updater.status() : null;
      const out = {
        roles: readRoles(configPath),
        firstRun,
        port: cfg.port,
        platform,
        service,
        version: VERSION,
        autoUpdate: updateStatus ? updateStatus.enabled : fileCfg.autoUpdate !== false,
        // Nome dispositivo proposto per i form di pairing (etichetta umana, non
        // lo slug). La UI lo precompila e lascia editing libero.
        deviceName: defaultDeviceName(),
      };
      if (updateStatus) out.update = updateStatus;
      send(res, 200, out);
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // --- POST /config — scrittura atomica, subset whitelisted ------------------
  r.post('/config', mutGate, (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return send(res, 400, { error: 'body deve essere un oggetto JSON' });
      }
      for (const k of Object.keys(b)) {
        if (!CONFIG_KEYS.has(k)) return send(res, 400, { error: `chiave non ammessa: "${k}" (whitelist: roles, port, wizardDone, autoUpdate)` });
      }
      if (Object.keys(b).length === 0) {
        return send(res, 400, { error: 'nessuna chiave da scrivere (whitelist: roles, port, wizardDone, autoUpdate)' });
      }
      if (b.roles !== undefined) {
        if (!b.roles || typeof b.roles !== 'object' || Array.isArray(b.roles)) {
          return send(res, 400, { error: 'roles deve essere un oggetto {client?, node?}' });
        }
        for (const k of Object.keys(b.roles)) {
          if (!ROLE_KEYS.has(k)) return send(res, 400, { error: `roles: chiave non ammessa "${k}" (solo client, node)` });
          if (typeof b.roles[k] !== 'boolean') return send(res, 400, { error: `roles.${k} deve essere boolean` });
        }
      }
      if (b.port !== undefined && !nodesStore.isPort(b.port)) {
        return send(res, 400, { error: 'port deve essere un intero 1..65535' });
      }
      if (b.port !== undefined && b.port !== runtimePort()) {
        const peers = nodesStore.loadStore(nodesPath);
        if (nodesStore.hasPairedPeers(peers)) {
          return send(res, 409, {
            error: 'porta non modificata: esistono nodi già collegati',
            code: 'paired-port-change-refused',
            hint: 'libera la porta corrente oppure rimuovi e ricollega intenzionalmente i peer',
          });
        }
      }
      if (b.wizardDone !== undefined && typeof b.wizardDone !== 'boolean') {
        return send(res, 400, { error: 'wizardDone deve essere boolean' });
      }
      if (b.autoUpdate !== undefined && typeof b.autoUpdate !== 'boolean') {
        return send(res, 400, { error: 'autoUpdate deve essere boolean' });
      }

      // merge sul config esistente (preserva le chiavi non gestite qui)
      const { cfg: current } = readConfigFile(configPath);
      const next = { ...current };
      if (b.roles !== undefined) {
        const prev = (current.roles && typeof current.roles === 'object') ? current.roles : {};
        next.roles = { client: !!prev.client, node: !!prev.node, ...b.roles };
      }
      if (b.port !== undefined) next.port = b.port;
      if (b.wizardDone !== undefined) next.wizardDone = b.wizardDone;
      if (b.autoUpdate !== undefined) next.autoUpdate = b.autoUpdate;
      atomicWriteConfig(configPath, next);
      if (b.autoUpdate !== undefined && updater && typeof updater.setEnabled === 'function') {
        updater.setEnabled(b.autoUpdate);
      }

      const out = {
        saved: true,
        config: { roles: next.roles, port: next.port, wizardDone: next.wizardDone, autoUpdate: next.autoUpdate !== false },
      };
      // Il server legge la porta SOLO allo startup: il cambio vale al prossimo
      // restart (contratto dichiarato nella risposta, la UI avvisa).
      if (b.port !== undefined && b.port !== cfg.port) {
        out.note = 'la porta cambia al prossimo restart del service';
      }
      send(res, 200, out);
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // Auto-update npm: check e apply sono autenticati, READONLY-gated e non
  // accettano mai package/versione dal browser. Il manager usa esclusivamente
  // @mmmbuto/nexuscrew@latest, confronta semver e installa la versione esatta.
  r.post('/update/check', mutGate, async (_req, res) => {
    if (!updater) return send(res, 501, { error: 'auto-update non disponibile' });
    try { send(res, 200, await updater.check()); }
    catch (e) { send(res, e.status || 500, { error: scrubError(e), ...(e.code ? { code: e.code } : {}) }); }
  });
  r.post('/update/apply', mutGate, async (_req, res) => {
    if (!updater) return send(res, 501, { error: 'auto-update non disponibile' });
    try { send(res, 202, await updater.apply()); }
    catch (e) { send(res, e.status || 500, { error: scrubError(e), ...(e.code ? { code: e.code } : {}) }); }
  });

  // --- POST /token/rotate — atomico + reload live + chiusura WS; token MAI in risposta
  // Contratto §4b(3): "scrittura atomica del token file + chiusura delle sessioni
  // WS/API attive locali + reload credenziali proxy". Audit F7: prima questa route
  // scriveva solo il file, e il server teneva il VECCHIO token in memoria -> restava
  // accettato fino al restart manuale. Ora: (1) scrittura atomica, (2) reload live
  // dell'holder in memoria (requireToken/verify vedono il nuovo), (3) chiusura delle
  // sessioni WS long-lived (autenticate solo all'upgrade). Il nuovo token NON trapela
  // mai: rotateToken() lo ritorna ma il valore viene SCARTATO, e reload() non lo espone.
  r.post('/token/rotate', mutGate, (_req, res) => {
    try {
      rotateToken(tokenPath);
      if (tokenStore && typeof tokenStore.reload === 'function') tokenStore.reload();
      if (typeof closeSessions === 'function') closeSessions();
      send(res, 200, {
        rotated: true,
        note: 'token ruotato: sessioni attive chiuse, vecchio token invalidato (401) — recupera il nuovo con `nexuscrew show token`',
      });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // One-time PWA pairing capability. It is not the UI bearer token and is
  // persisted hashed, 0600, for ten minutes only. Il `label` nel payload e'
  // l'etichetta umana con cui il peer vedra' questo dispositivo: default sensato
  // (mai 'localhost' crudo), sovrascrivibile dal form.
  // v2: il creatore puo' includere l'Host/alias SSH raggiungibile (+ slug + porta
  // SSH opzionale) cosicché il ricevente incolla/scansiona UN solo link e precompila
  // tutto. NIENTE segreti: solo routing. L'invite one-time resta l'unica credenziale.
  r.post('/peering/invite', mutGate, (req, res) => {
    try {
      const b = req.body || {};
      const label = nodesStore.sanitizeLabel(b.label, defaultDeviceName());
      const st = nodesStore.loadOrInitStore(nodesPath);
      const extra = {};
      if (typeof b.ssh === 'string' && b.ssh.trim()) {
        const ssh = nodesStore.parseSshTarget(b.ssh.trim());
        if (!ssh) return send(res, 400, { error: 'ssh non valido (atteso user@host o alias)' });
        extra.ssh = ssh.value;
      }
      if (b.sshPort !== undefined && b.sshPort !== null && b.sshPort !== '') {
        if (!nodesStore.isPort(Number(b.sshPort))) return send(res, 400, { error: 'sshPort non valida (1..65535)' });
        extra.sshPort = Number(b.sshPort);
      }
      if (extra.sshPort && !extra.ssh) return send(res, 400, { error: 'sshPort richiede un target SSH' });
      if (!extra.ssh) return send(res, 400, { error: 'indica l’Host SSH pubblico/alias con cui gli altri dispositivi raggiungono questo hub' });
      let remotePort = runtimePort();
      if (b.remotePort !== undefined && b.remotePort !== null && b.remotePort !== '') {
        if (!nodesStore.isPort(Number(b.remotePort))) return send(res, 400, { error: 'remotePort non valida (1..65535)' });
        remotePort = Number(b.remotePort);
      }
      if (typeof b.name === 'string' && b.name.trim()) {
        if (!nodesStore.NODE_NAME_RE.test(b.name.trim())) return send(res, 400, { error: 'name non valido (a-z 0-9 -, max 32)' });
        extra.name = b.name.trim();
      }
      if (extra.ssh && !extra.name) extra.name = nodesStore.toSlug(label);
      send(res, 200, peering.createInvite({
        invitesPath, instanceId: st.nodeId, port: remotePort, linkPort: runtimePort(), label, ...extra,
      }));
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

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
  r.post('/nodes/pair', mutGate, async (req, res) => {
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
  });

  // --- POST /nodes — nodes add (riusa nodesCmds.nodesAdd) --------------------
  r.post('/nodes', mutGate, (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return send(res, 400, { error: 'body deve essere un oggetto JSON' });
      }
      for (const k of Object.keys(b)) {
        if (!ADD_KEYS.has(k)) return send(res, 400, { error: `chiave non ammessa: "${k}" (schema: name, ssh, sshPort?, remotePort?, localPort?, keyPath?)` });
      }
      if (!validName(b.name)) return send(res, 400, { error: 'name non valido (^[a-z0-9-]{1,32}$)' });
      if (!nodesStore.parseSsh(b.ssh)) return send(res, 400, { error: 'ssh non valido (atteso user@host strict)' });
      if (b.sshPort !== undefined && !nodesStore.isPort(b.sshPort)) {
        return send(res, 400, { error: 'sshPort deve essere un intero 1..65535' });
      }
      if (b.remotePort !== undefined && !nodesStore.isPort(b.remotePort)) {
        return send(res, 400, { error: 'remotePort deve essere un intero 1..65535' });
      }
      if (b.localPort !== undefined && !nodesStore.isPort(b.localPort)) {
        return send(res, 400, { error: 'localPort deve essere un intero 1..65535' });
      }
      if (b.keyPath !== undefined && !nodesStore.isAbsPath(b.keyPath)) {
        return send(res, 400, { error: 'keyPath deve essere un path assoluto' });
      }
      if (b.label !== undefined && !nodesStore.validLabel(b.label)) {
        return send(res, 400, { error: 'label non valida (max 64 char, niente a capo)' });
      }

      const cap = capture();
      const out = nodesCmds.nodesAdd({
        ...cliOpts(cap),
        name: b.name, ssh: b.ssh, sshPort: b.sshPort,
        remotePort: b.remotePort, localPort: b.localPort, key: b.keyPath,
      });
      if (out.code === 0) {
        // label (display) opzionale: la persistiamo dopo l'add come rename che NON
        // tocca il name (route stabile). Best-effort: una label malformata qui e'
        // impossibile (validata sopra), ma non facciamo mai fallire l'add per lei.
        if (b.label !== undefined) {
          try {
            let st = nodesStore.loadOrInitStore(nodesPath);
            st = nodesStore.updateNode(st, out.name, { label: nodesStore.sanitizeLabel(b.label, out.name) });
            nodesStore.atomicWriteStore(nodesPath, st);
          } catch (_) { /* best-effort: il nodo e' gia' creato */ }
        }
        return send(res, 200, {
          added: true,
          name: out.name,
          sshPort: out.sshPort,
          remotePort: out.remotePort,
          localPort: out.localPort,
          // La riga authorized_keys NON e' un segreto: pubkey con restrict/permitopen.
          authorizedKeys: authorizedKeysLine(cap),
        });
      }
      const msg = lastLine(cap, 'nodes add fallito');
      if (out.reason === 'readonly') return send(res, 403, { error: msg });
      if (out.reason === 'add rifiutato') {
        // duplicato/self-reference = conflitto (409); schema rifiutato = 400.
        const status = /duplicato|self-reference/.test(msg) ? 409 : 400;
        return send(res, status, { error: msg });
      }
      // store invalido / keygen fallita / write fallita: errore lato server.
      return send(res, 500, { error: msg });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // --- DELETE /nodes/:name — nodes remove ------------------------------------
  r.delete('/nodes/:name', mutGate, (req, res) => {
    try {
      const name = String(req.params.name || '');
      if (!validName(name)) return send(res, 400, { error: 'name non valido (^[a-z0-9-]{1,32}$)' });
      const cap = capture();
      const out = nodesCmds.nodesRemove({ ...cliOpts(cap), name });
      if (out.code === 0) return send(res, 200, { removed: true, name, stopped: !!out.stopped });
      const msg = lastLine(cap, 'nodes remove fallito');
      if (out.reason === 'readonly') return send(res, 403, { error: msg });
      const status = /sconosciuto|nessun nodes\.json/.test(msg) ? 404 : 500;
      send(res, status, { error: msg });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // --- POST /nodes/:name/test — non-mutante (POST per coerenza azione) -------
  // NON gated READONLY: e' una probe diagnostica, coerente col `nodes test` CLI.
  r.post('/nodes/:name/test', async (req, res) => {
    try {
      const name = String(req.params.name || '');
      if (!validName(name)) return send(res, 400, { error: 'name non valido (^[a-z0-9-]{1,32}$)' });
      const cap = capture();
      const out = await nodesCmds.nodesTest({ ...cliOpts(cap), name });
      if (out.result === 'unknown-node') return send(res, 404, { error: `nodo sconosciuto "${name}"` });
      // result distingue: ok | tunnel-down | health-ko | token-missing | token-ko
      send(res, 200, {
        ok: out.result === 'ok', result: out.result, detail: lastLine(cap, ''),
        ...(out.diagnostic ? { diagnostic: out.diagnostic } : {}),
      });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // --- POST /nodes/:name/up|down|restart — lifecycle tunnel ------------------
  // GATE READONLY (audit F6, contract §4b(6): "restart processi tunnel" e' tra i
  // mutanti della lista chiusa e NEXUSCREW_READONLY blocca TUTTI i mutanti). Prima
  // questi endpoint erano esplicitamente NON gated ("decisione B0") — ma cio'
  // contradiceva il contratto duro §4b(6): up/down/restart mutano processi e vanno
  // bloccati in READONLY. /nodes/:name/test resta NON gated (probe diagnostica).
  function lifecycleHandler(action) {
    return (req, res) => {
      try {
        const name = String(req.params.name || '');
        if (!validName(name)) return send(res, 400, { error: 'name non valido (^[a-z0-9-]{1,32}$)' });
        const cap = capture();
        const fn = action === 'up' ? nodesCmds.nodesUp
          : action === 'down' ? nodesCmds.nodesDown
            : nodesCmds.nodesRestart;
        const out = fn({ ...cliOpts(cap), name, persistAutostart: action === 'up' || action === 'down' });
        if (out.code !== 0) {
          const msg = lastLine(cap, `nodes ${action} fallito`);
          const status = /sconosciuto/.test(msg) ? 404 : 500;
          return send(res, status, { error: msg, ...(out.diagnostic ? { diagnostic: out.diagnostic } : {}) });
        }
        if (action === 'up') return send(res, 200, { name, started: out.started, pid: out.pid, diagnostic: out.diagnostic });
        if (action === 'down') return send(res, 200, { name, stopped: out.stopped });
        return send(res, 200, { name, restarted: true, pid: out.pid, diagnostic: out.diagnostic });
      } catch (e) { send(res, 500, { error: String(e.message || e) }); }
    };
  }
  r.post('/nodes/:name/up', mutGate, lifecycleHandler('up'));
  r.post('/nodes/:name/down', mutGate, lifecycleHandler('down'));
  r.post('/nodes/:name/restart', mutGate, lifecycleHandler('restart'));

  // Share is the only publication control exposed to the user. The normal
  // paired connection is -L only; enabling Share restarts the same supervised
  // SSH session with its negotiated -R and asks the hub to advertise it only
  // after the reverse channel passes an authenticated health probe.
  r.patch('/nodes/:name/share', mutGate, async (req, res) => {
    const name = String(req.params.name || '');
    const body = req.body || {};
    if (!validName(name)) return send(res, 400, { error: 'name non valido (^[a-z0-9-]{1,32}$)' });
    if (Object.keys(body).some((k) => k !== 'shared') || typeof body.shared !== 'boolean') {
      return send(res, 400, { error: 'body non valido: atteso {shared:boolean}' });
    }
    let st = nodesStore.loadStore(nodesPath);
    let node = st && nodesStore.getNode(st, name);
    if (!node) return send(res, 404, { error: `nodo sconosciuto "${name}"` });
    if (node.direction !== 'outbound') return send(res, 409, { error: 'Share si attiva sul dispositivo che possiede la connessione SSH' });
    if (!node.token || !node.nodeId) return send(res, 409, { error: 'nodo non associato: ripeti il pairing' });
    if (body.shared && !nodesStore.isPort(node.reversePort)) {
      return send(res, 409, { error: 'canale share non negoziato: ripeti il pairing' });
    }
    if (node.shared === body.shared) return send(res, 200, { name, shared: body.shared, unchanged: true });

    const fetchImpl = seams.fetchImpl || fetch;
    const notifyHub = async (shared) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const response = await fetchImpl(`http://127.0.0.1:${node.localPort}/federation/share`, {
          method: 'POST', signal: ctrl.signal,
          headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ shared }),
        });
        if (!response.ok) throw new Error(`hub HTTP ${response.status}`);
      } finally { clearTimeout(timer); }
    };
    const applyLocal = async (shared) => {
      st = nodesStore.loadOrInitStore(nodesPath);
      st = nodesStore.updateNode(st, name, { shared });
      nodesStore.atomicWriteStore(nodesPath, st);
      node = nodesStore.getNode(st, name);
      nodesTunnel.stopTunnel({ home, name });
      const started = nodesTunnel.startForward({
        home, node, localAppPort: runtimePort(),
        spawnImpl: seams.spawnImpl, spawnSyncImpl: seams.spawnSyncImpl,
        sshBin: seams.sshBin, logFd: seams.logFd,
      });
      if (!started.started && started.reason !== 'already running') {
        throw new Error(started.reason || 'avvio SSH fallito');
      }
      const ready = await probeHealth({
        port: node.localPort, token: node.token, expectedInstanceId: node.nodeId,
        fetchImpl,
      });
      if (!ready || ready.status !== 'healthy') {
        const diagnosis = (seams.readTunnelDiagnostic || nodesTunnel.readTunnelDiagnostic)(home, name, node.remotePort);
        throw new Error((diagnosis && diagnosis.detail) || (ready && ready.detail) || 'hub non raggiungibile dopo il riavvio SSH');
      }
    };

    try {
      if (body.shared) {
        await applyLocal(true);
        await notifyHub(true);
      } else {
        // Revoke at the hub while -R is still alive, then remove -R locally.
        await notifyHub(false);
        await applyLocal(false);
      }
      return send(res, 200, { name, shared: body.shared });
    } catch (e) {
      // Share-on is transactional: a failed hub acknowledgement returns to the
      // safe private -L-only state. Never include remote response bodies/tokens.
      if (body.shared) {
        try { await applyLocal(false); } catch (_) { /* best-effort safe rollback */ }
      }
      return send(res, 502, {
        error: body.shared ? 'Share non attivato' : 'Share non disattivato',
        detail: String(e && e.message || e).replace(/Bearer\s+\S+/gi, 'Bearer ***'),
      });
    }
  });

  r.patch('/nodes/:name/visibility', mutGate, (req, res) => {
    try {
      const name = String(req.params.name || '');
      const visibility = req.body && req.body.visibility;
      const selected = (req.body && req.body.selected) || [];
      if (!validName(name) || !['network', 'relay-only', 'selected'].includes(visibility)) {
        return send(res, 400, { error: 'visibility non valida' });
      }
      let st = nodesStore.loadOrInitStore(nodesPath);
      st = nodesStore.updateNode(st, name, { visibility, selected: visibility === 'selected' ? selected : [] });
      nodesStore.atomicWriteStore(nodesPath, st);
      send(res, 200, { saved: true, name, visibility });
    } catch (e) { send(res, 400, { error: String(e.message || e) }); }
  });
  // Rinomina la label umana di un nodo SENZA toccare il name (route/URL stabili).
  r.patch('/nodes/:name/label', mutGate, (req, res) => {
    try {
      const name = String(req.params.name || '');
      const label = req.body && req.body.label;
      if (!validName(name)) return send(res, 400, { error: 'name non valido (^[a-z0-9-]{1,32}$)' });
      if (!nodesStore.validLabel(label)) return send(res, 400, { error: 'label non valida (max 64 char, niente a capo)' });
      let st = nodesStore.loadOrInitStore(nodesPath);
      if (!nodesStore.getNode(st, name)) return send(res, 404, { error: `nodo sconosciuto "${name}"` });
      st = nodesStore.updateNode(st, name, { label: nodesStore.sanitizeLabel(label, name) });
      nodesStore.atomicWriteStore(nodesPath, st);
      send(res, 200, { saved: true, name, label: nodesStore.nodeLabel(nodesStore.getNode(st, name)) });
    } catch (e) { send(res, 400, { error: String(e.message || e) }); }
  });

  // Legacy compatibility endpoint: the old node-role/rendezvous flow opened a
  // second SSH process and is intentionally retired. Existing data is kept for
  // migration, but all new publication goes through pairing + Share on the
  // already-connected hub.
  r.post('/node-role', mutGate, (_req, res) => send(res, 410, {
    error: 'node-role/rendezvous ritirato: collega un hub e usa “Condividi questo nodo”',
  }));

  // --- POST /service/regenerate — rigenera l'unit service --------------------
  // Riusa generateService/installService (lib/cli/service.js: escaping per-platform,
  // no-symlink, tmp+rename atomico). L'execImpl e' un NO-OP che registra i comandi
  // di attivazione SENZA eseguirli: il contratto B2 vieta il restart automatico
  // dall'API (la UI avvisa di riavviare a mano).
  r.post('/service/regenerate', mutGate, (_req, res) => {
    try {
      if (!bootState({ platform, execImpl: seams.execImpl, uid: seams.uid, home }).enabled) {
        return send(res, 409, { error: 'boot non abilitato: usa `nexuscrew boot`' });
      }
      const { cfg: fileCfg } = readConfigFile(configPath);
      const port = nodesStore.isPort(fileCfg.port) ? fileCfg.port : cfg.port;
      const ctx = {
        repoRoot: repoRoot(),
        nodeBin: nodeBin(),
        port, home,
        uid: seams.uid || uid(),
        installPath: seams.serviceInstallPath,
      };
      const content = generateService(platform, ctx);
      const skipped = [];
      const noExec = (bin, args) => { skipped.push(`${bin} ${(args || []).join(' ')}`); };
      const out = installService(platform, content, ctx, { execImpl: noExec });
      send(res, 200, {
        regenerated: true,
        target: out.target,
        note: 'unit rigenerata; nessun restart automatico — riavvia il service per applicarla',
        skippedActivation: skipped,
      });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // Error handler del router: body JSON malformato (express.json) -> 400 con causa;
  // qualunque altro errore -> status coerente. MAI stack trace in risposta.
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      return send(res, 400, { error: 'body JSON non valido' });
    }
    if (err && err.type === 'entity.too.large') {
      return send(res, 400, { error: 'body troppo grande (limite 8kb)' });
    }
    send(res, (err && err.status) || 500, { error: String((err && err.message) || err) });
  });

  return r;
}

// Public only because the one-time invite itself is the capability. The route
// exposes no generic API and creates a scoped peer credential, never a UI token.
function publicPeeringRoutes(deps = {}) {
  const cfg = deps.cfg || {};
  const home = cfg.home || os.homedir();
  const configPath = cfg.configPath || configJsonPath();
  const nodesPath = deps.nodesPath || cfg.nodesPath || nodesStore.defaultNodesPath(home);
  const invitesPath = cfg.invitesPath || peering.defaultInvitesPath(home);
  const pendingPath = cfg.pendingPairingsPath || peering.defaultPendingPath(home);
  const r = express.Router();
  const attempts = new Map();
  r.use(express.json({ limit: '8kb' }));
  // Identity proof non consuma la capability e non riceve mai invite/token in
  // chiaro. Serve a impedire che un qualunque listener HTTP sulla porta -L
  // venga scambiato per il nodo contenuto nel link.
  r.post('/identity', (req, res) => {
    const key = `identity:${String(req.socket && req.socket.remoteAddress || 'local')}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 30) return res.status(429).json({ error: 'troppi tentativi' });
    const b = req.body || {};
    const proof = peering.capabilityIdentity({
      invitesPath, pendingPath, capabilityId: b.capabilityId, challenge: b.challenge, now,
    });
    if (!proof) return res.status(404).json({ error: 'capability non valida' });
    const st = nodesStore.loadStore(nodesPath);
    if (!st || !nodesStore.NODE_ID_RE.test(st.nodeId)) return res.status(503).json({ error: 'identita nodo non disponibile' });
    return res.json({ ok: true, instanceId: st.nodeId, proof });
  });
  r.post('/join', (req, res) => {
    const key = `join:${String(req.socket && req.socket.remoteAddress || 'local')}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 10) return res.status(429).json({ error: 'troppi tentativi di pairing' });
    const b = req.body || {};
    const peerRoles = b.roles === undefined ? null : nodesStore.parseRoles(b.roles);
    if (!nodesStore.validToken(b.invite) || !nodesStore.NODE_ID_RE.test(b.instanceId)
      || !validPeerName(b.name) || !nodesStore.isPort(b.port) || !nodesStore.validToken(b.acceptToken)
      || (b.roles !== undefined && !peerRoles)
      // Pairing is always private. Publishing is a separate authenticated
      // action after the reverse channel is live and health-checked.
      || (b.shared !== undefined && b.shared !== false)) {
      return res.status(400).json({ error: 'pairing request non valida' });
    }
    if (b.label !== undefined && !nodesStore.validLabel(b.label)) {
      return res.status(400).json({ error: 'label non valida' });
    }
    if (!peering.consumeInvite({ invitesPath, invite: b.invite })) return res.status(410).json({ error: 'invito scaduto o gia usato' });
    try {
      const st = nodesStore.loadOrInitStore(nodesPath);
      if (st.nodeId === b.instanceId || st.nodes.some((n) => n.nodeId === b.instanceId)) return res.status(409).json({ error: 'peer duplicato' });
      let name = b.name;
      for (let i = 2; nodesStore.getNode(st, name); i += 1) name = `${b.name.slice(0, 28)}-${i}`;
      const reversePort = peering.allocateReversePort(st.nodes);
      const credential = peering.createPending({ pendingPath, data: {
        name, remotePort: b.port, reversePort, instanceId: b.instanceId, acceptToken: b.acceptToken,
        shared: false,
        label: nodesStore.sanitizeLabel(b.label, name),
        ...(peerRoles ? { roles: { ...peerRoles, node: false }, rolesKnown: true } : { rolesKnown: false }),
      } });
      res.json({ paired: true, instanceId: st.nodeId, reversePort, credential, roles: readRoles(configPath) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  r.post('/confirm', (req, res) => {
    const b = req.body || {};
    if (!nodesStore.validToken(b.credential)) return res.status(400).json({ error: 'confirm non valido' });
    const pending = peering.consumePending({ pendingPath, credential: b.credential });
    if (!pending) {
      const st = nodesStore.loadStore(nodesPath);
      if (st && st.nodes.some((n) => n.acceptToken && peering.safeEqual(n.acceptToken, b.credential))) return res.json({ confirmed: true, idempotent: true });
      return res.status(410).json({ error: 'pairing pending scaduto o gia usato' });
    }
    try {
      let st = nodesStore.loadOrInitStore(nodesPath);
      if (st.nodeId === pending.instanceId || st.nodes.some((n) => n.nodeId === pending.instanceId)) return res.status(409).json({ error: 'peer duplicato' });
      st = nodesStore.addNode(st, {
        name: pending.name, remotePort: pending.remotePort, localPort: pending.reversePort,
        direction: 'inbound', transport: 'inbound', autostart: true,
        visibility: 'network', shared: pending.shared === true, nodeId: pending.instanceId,
        token: pending.acceptToken, acceptToken: b.credential,
        ...(pending.roles ? { roles: pending.roles } : {}),
        rolesKnown: pending.rolesKnown === true,
        ...(pending.label ? { label: pending.label } : {}),
      });
      nodesStore.atomicWriteStore(nodesPath, st);
      res.json({ confirmed: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  r.post('/cancel', (req, res) => {
    const b = req.body || {};
    if (!nodesStore.NODE_ID_RE.test(b.instanceId) || !nodesStore.validToken(b.credential)) return res.status(400).json({ error: 'cancel non valido' });
    try {
      const pending = peering.consumePending({ pendingPath, credential: b.credential });
      if (!pending || pending.instanceId !== b.instanceId) {
        const st = nodesStore.loadStore(nodesPath);
        const peer = st && st.nodes.find((n) => n.nodeId === b.instanceId && n.acceptToken && peering.safeEqual(n.acceptToken, b.credential));
        if (!peer) return res.status(404).json({ error: 'pair non trovato' });
        nodesStore.atomicWriteStore(nodesPath, nodesStore.removeNode(st, peer.name));
      }
      res.json({ cancelled: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  return r;
}

function validPeerName(name) { return typeof name === 'string' && nodesStore.NODE_NAME_RE.test(name); }

module.exports = { settingsRoutes, publicPeeringRoutes, deepScrubTokens };
