'use strict';
// lib/settings/routes.js — Settings API per wizard/settings UI (design §4b(6), B2).
//
// Contratto duro:
//   - read-only: GET /api/settings (roles, firstRun, port, platform, service,
//     rendezvous redatto, version).
//   - mutanti (LISTA CHIUSA §4b(6)), tutti dietro requireToken (montati sotto il
//     router /api gia' autenticato) + gate READONLY route-level (pattern
//     lib/fleet/routes.js, 403 esplicito):
//       POST   /config             scrittura config.json ATOMICA (whitelist chiavi)
//       POST   /token/rotate       riusa rotateToken(); token MAI in risposta (§4b(3))
//       POST   /nodes              nodes add (riusa lib/nodes/commands.js)
//       DELETE /nodes/:name        nodes remove
//       POST   /node-role          node on/off (rendezvous config)
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
//   - NIENTE reimplementazione della logica B0: i mutanti nodes/node-role
//     incapsulano le funzioni CLI di lib/nodes/commands.js (log catturato per
//     estrarre esito/authorized_keys); config.json scritto col pattern atomico
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
const { rotateToken } = require('../auth/token.js');
const { generateService, installService, installPath: svcInstallPath } = require('../cli/service.js');
const { detectPlatform, nodeBin, repoRoot, uid } = require('../cli/platform.js');
const { isServiceRunning, readRoles } = require('../cli/commands.js');
const { configJsonPath } = require('../config.js');
const VERSION = require('../../package.json').version;

// Whitelist chiavi scrivibili di config.json via API (lista chiusa dal task B2).
const CONFIG_KEYS = new Set(['roles', 'port', 'wizardDone']);
const ROLE_KEYS = new Set(['client', 'node']);
const ADD_KEYS = new Set(['name', 'ssh', 'sshPort', 'remotePort', 'localPort', 'keyPath']);
const NODE_ROLE_KEYS = new Set(['enabled', 'rendezvousSsh', 'publishedPort', 'keyPath']);

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
      };
      const out = {
        roles: readRoles(configPath),
        firstRun,
        port: cfg.port,
        platform,
        service,
        version: VERSION,
      };
      // rendezvous via redactStore (view sicura §4b(4)): non contiene token, ma
      // la si prende comunque SOLO dalla vista redatta.
      const st = nodesStore.loadStore(nodesPath);
      if (st) {
        const view = nodesStore.redactStore(st);
        if (view.rendezvous) out.rendezvous = view.rendezvous;
      }
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
        if (!CONFIG_KEYS.has(k)) return send(res, 400, { error: `chiave non ammessa: "${k}" (whitelist: roles, port, wizardDone)` });
      }
      if (Object.keys(b).length === 0) {
        return send(res, 400, { error: 'nessuna chiave da scrivere (whitelist: roles, port, wizardDone)' });
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
      if (b.wizardDone !== undefined && typeof b.wizardDone !== 'boolean') {
        return send(res, 400, { error: 'wizardDone deve essere boolean' });
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
      atomicWriteConfig(configPath, next);

      const out = {
        saved: true,
        config: { roles: next.roles, port: next.port, wizardDone: next.wizardDone },
      };
      // Il server legge la porta SOLO allo startup: il cambio vale al prossimo
      // restart (contratto dichiarato nella risposta, la UI avvisa).
      if (b.port !== undefined && b.port !== cfg.port) {
        out.note = 'la porta cambia al prossimo restart del service';
      }
      send(res, 200, out);
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
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
        note: 'token ruotato: sessioni attive chiuse, vecchio token invalidato (401) — recupera il nuovo con `nexuscrew url`',
      });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // One-time PWA pairing capability. It is not the UI bearer token and is
  // persisted hashed, 0600, for ten minutes only.
  r.post('/peering/invite', mutGate, (_req, res) => {
    try {
      const st = nodesStore.loadOrInitStore(nodesPath);
      send(res, 200, peering.createInvite({
        invitesPath, instanceId: st.nodeId, port: cfg.port, label: os.hostname(),
      }));
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // Hydra join: add once from the PWA. A provisional -L reaches the invite
  // endpoint, then the negotiated -R makes the same SSH link reciprocal.
  r.post('/nodes/pair', mutGate, async (req, res) => {
    const b = req.body || {};
    if (!validName(b.name) || !nodesStore.parseSshTarget(b.ssh)) {
      return send(res, 400, { error: 'name o alias SSH non valido' });
    }
    const pair = peering.parsePairingUrl(b.pairingUrl);
    if (!pair) return send(res, 400, { error: 'link di pairing non valido' });
    if (b.sshPort !== undefined && !nodesStore.isPort(b.sshPort)) return send(res, 400, { error: 'sshPort non valida' });
    if (b.identityFile !== undefined && !nodesStore.isAbsPath(b.identityFile)) return send(res, 400, { error: 'identityFile non valido' });
    let provisionalPort = null;
    let rollbackCredential = null;
    let created = false;
    try {
      let st = nodesStore.loadOrInitStore(nodesPath);
      const localPort = nodesCmds.assignLocalPort(st);
      provisionalPort = localPort;
      const acceptToken = crypto.randomBytes(32).toString('base64url');
      st = nodesStore.addNode(st, {
        name: b.name, ssh: b.ssh, sshPort: b.sshPort,
        remotePort: pair.port, localPort, identityFile: b.identityFile,
        transport: 'auto', autostart: true, visibility: 'network',
        direction: 'outbound', acceptToken,
      });
      nodesStore.atomicWriteStore(nodesPath, st);
      created = true;
      const node = nodesStore.getNode(st, b.name);
      const started = nodesTunnel.startForward({
        home, node, localAppPort: cfg.port,
        spawnImpl: seams.spawnImpl, spawnSyncImpl: seams.spawnSyncImpl,
        sshBin: seams.sshBin, logFd: seams.logFd,
      });
      if (!started.started && started.reason !== 'already running') throw new Error(started.reason || 'tunnel start failed');
      if (typeof seams.pairDelay === 'function') await seams.pairDelay();
      else await new Promise((resolve) => setTimeout(resolve, 900));
      const fetchImpl = seams.fetchImpl || fetch;
      const jr = await fetchImpl(`http://127.0.0.1:${localPort}/pair/join`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invite: pair.invite,
          instanceId: st.nodeId,
          name: String(b.localName || os.hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'node',
          port: cfg.port,
          acceptToken,
        }),
      });
      const joined = await jr.json().catch(() => ({}));
      if (!jr.ok || !nodesStore.validToken(joined.credential) || !nodesStore.isPort(joined.reversePort)
        || !nodesStore.NODE_ID_RE.test(joined.instanceId)) throw new Error(joined.error || `pairing HTTP ${jr.status}`);
      rollbackCredential = joined.credential;
      st = nodesStore.loadOrInitStore(nodesPath);
      st = nodesStore.updateNode(st, b.name, {
        token: joined.credential, nodeId: joined.instanceId, reversePort: joined.reversePort,
      });
      nodesStore.atomicWriteStore(nodesPath, st);
      nodesTunnel.stopTunnel({ home, name: b.name });
      const finalStart = nodesTunnel.startForward({
        home, node: nodesStore.getNode(st, b.name), localAppPort: cfg.port,
        spawnImpl: seams.spawnImpl, spawnSyncImpl: seams.spawnSyncImpl,
        sshBin: seams.sshBin, logFd: seams.logFd,
      });
      if (!finalStart.started && finalStart.reason !== 'already running') throw new Error(finalStart.reason || 'final tunnel start failed');
      if (typeof seams.pairDelay === 'function') await seams.pairDelay();
      else await new Promise((resolve) => setTimeout(resolve, 900));
      let confirmed = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          confirmed = await fetchImpl(`http://127.0.0.1:${localPort}/pair/confirm`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential: joined.credential }),
          });
          if (confirmed.ok) break;
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
      if (!confirmed || !confirmed.ok) {
        const x = confirmed ? await confirmed.json().catch(() => ({})) : {};
        throw new Error(x.error || `pair confirm HTTP ${confirmed ? confirmed.status : 'unreachable'}`);
      }
      send(res, 200, { paired: true, name: b.name, instanceId: joined.instanceId, transport: 'auto' });
    } catch (e) {
      if (rollbackCredential && provisionalPort) {
        try {
          const fetchImpl = seams.fetchImpl || fetch;
          await fetchImpl(`http://127.0.0.1:${provisionalPort}/pair/cancel`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instanceId: (nodesStore.loadStore(nodesPath) || {}).nodeId, credential: rollbackCredential }),
          });
        } catch (_) {}
      }
      try {
        const st = nodesStore.loadStore(nodesPath);
        const n = st && nodesStore.getNode(st, b.name);
        if (n && created) {
          nodesTunnel.stopTunnel({ home, name: b.name });
          nodesStore.atomicWriteStore(nodesPath, nodesStore.removeNode(st, b.name));
        }
      } catch (_) {}
      send(res, 502, { error: String(e.message || e) });
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

      const cap = capture();
      const out = nodesCmds.nodesAdd({
        ...cliOpts(cap),
        name: b.name, ssh: b.ssh, sshPort: b.sshPort,
        remotePort: b.remotePort, localPort: b.localPort, key: b.keyPath,
      });
      if (out.code === 0) {
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
      send(res, 200, { ok: out.result === 'ok', result: out.result, detail: lastLine(cap, '') });
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
        const out = fn({ ...cliOpts(cap), name });
        if (out.code !== 0) {
          const msg = lastLine(cap, `nodes ${action} fallito`);
          const status = /sconosciuto/.test(msg) ? 404 : 500;
          return send(res, status, { error: msg });
        }
        if (action === 'up') return send(res, 200, { name, started: out.started, pid: out.pid });
        if (action === 'down') return send(res, 200, { name, stopped: out.stopped });
        return send(res, 200, { name, restarted: true, pid: out.pid });
      } catch (e) { send(res, 500, { error: String(e.message || e) }); }
    };
  }
  r.post('/nodes/:name/up', mutGate, lifecycleHandler('up'));
  r.post('/nodes/:name/down', mutGate, lifecycleHandler('down'));
  r.post('/nodes/:name/restart', mutGate, lifecycleHandler('restart'));
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

  // --- POST /node-role — node on/off (rendezvous config) ---------------------
  r.post('/node-role', mutGate, (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return send(res, 400, { error: 'body deve essere un oggetto JSON' });
      }
      for (const k of Object.keys(b)) {
        if (!NODE_ROLE_KEYS.has(k)) return send(res, 400, { error: `chiave non ammessa: "${k}" (schema: enabled, rendezvousSsh?, publishedPort?, keyPath?)` });
      }
      if (typeof b.enabled !== 'boolean') return send(res, 400, { error: 'enabled deve essere boolean' });
      if (b.rendezvousSsh !== undefined && !nodesStore.parseSsh(b.rendezvousSsh)) {
        return send(res, 400, { error: 'rendezvousSsh non valido (atteso user@host strict)' });
      }
      if (b.publishedPort !== undefined && !nodesStore.isPort(b.publishedPort)) {
        return send(res, 400, { error: 'publishedPort deve essere un intero 1..65535' });
      }
      if (b.keyPath !== undefined && !nodesStore.isAbsPath(b.keyPath)) {
        return send(res, 400, { error: 'keyPath deve essere un path assoluto' });
      }

      const cap = capture();
      if (b.enabled === false) {
        const out = nodesCmds.nodeOff({ ...cliOpts(cap) });
        if (out.code === 0) return send(res, 200, { enabled: false, roles: out.roles });
        return send(res, 500, { error: lastLine(cap, 'node off fallito') });
      }
      const out = nodesCmds.nodeOn({
        ...cliOpts(cap),
        rendezvousSsh: b.rendezvousSsh,
        publishedPort: b.publishedPort,
        key: b.keyPath,
        port: cfg.port, // porta nexus locale da esporre = quella del server attivo
      });
      if (out.code === 0) {
        const resp = { enabled: true, roles: out.roles, tunnel: out.tunnel || null };
        const line = authorizedKeysLine(cap);
        if (line) resp.authorizedKeys = line; // pubkey con permitlisten: non un segreto
        return send(res, 200, resp);
      }
      const msg = lastLine(cap, 'node on fallito');
      if (out.reason === 'readonly') return send(res, 403, { error: msg });
      if (out.reason === 'no rendezvous') return send(res, 400, { error: msg });
      if (out.reason === 'permitlisten') return send(res, 409, { error: msg });
      send(res, 500, { error: msg });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });

  // --- POST /service/regenerate — rigenera l'unit service --------------------
  // Riusa generateService/installService (lib/cli/service.js: escaping per-platform,
  // no-symlink, tmp+rename atomico). L'execImpl e' un NO-OP che registra i comandi
  // di attivazione SENZA eseguirli: il contratto B2 vieta il restart automatico
  // dall'API (la UI avvisa di riavviare a mano).
  r.post('/service/regenerate', mutGate, (_req, res) => {
    try {
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
  const nodesPath = deps.nodesPath || cfg.nodesPath || nodesStore.defaultNodesPath(home);
  const invitesPath = cfg.invitesPath || peering.defaultInvitesPath(home);
  const pendingPath = cfg.pendingPairingsPath || peering.defaultPendingPath(home);
  const r = express.Router();
  const attempts = new Map();
  r.use(express.json({ limit: '8kb' }));
  r.post('/join', (req, res) => {
    const key = String(req.socket && req.socket.remoteAddress || 'local');
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 10) return res.status(429).json({ error: 'troppi tentativi di pairing' });
    const b = req.body || {};
    if (!nodesStore.validToken(b.invite) || !nodesStore.NODE_ID_RE.test(b.instanceId)
      || !validPeerName(b.name) || !nodesStore.isPort(b.port) || !nodesStore.validToken(b.acceptToken)) {
      return res.status(400).json({ error: 'pairing request non valida' });
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
      } });
      res.json({ paired: true, instanceId: st.nodeId, reversePort, credential });
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
        visibility: 'network', nodeId: pending.instanceId,
        token: pending.acceptToken, acceptToken: b.credential,
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
