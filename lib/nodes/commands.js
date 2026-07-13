'use strict';
// lib/nodes/commands.js — implementation helpers for the authenticated PWA.
//
// Nodes add/list/remove/test/up/down/restart/set-token. These helpers are not
// advertised as public CLI commands.
// Invarianti:
//   - token per-nodo MAI loggati/stampati (redazione sempre; set-token li legge
//     da stdin/env, mai da argv -> niente segreti in `ps`).
//   - NEXUSCREW_READONLY blocca le MUTAZIONI DI CONFIG (add/remove/set-token/
//     configuration), while the Settings routes separately gate process lifecycle.
//   - niente shell interpolation: ssh-keygen via execFile (argv), tunnel via spawn argv.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store.js');
const tunnel = require('./tunnel.js');
const { resolvePaths, DEFAULT_PORT } = require('../cli/url.js');

const LOCAL_PORT_BASE = 43001; // porte locali stabili per i forward (design: stabili da nodes.json)

function isReadonly(opts) {
  return process.env.NEXUSCREW_READONLY === '1' || !!opts.readonly;
}

function resolveNodePaths(opts) {
  const { home, configDir, configPath } = resolvePaths(opts);
  const nodesPath = opts.nodesPath || path.join(configDir, 'nodes.json');
  return { home, configDir, configPath, nodesPath };
}

// Prima localPort libera >= base, evitando le porte gia' assegnate (porta STABILE:
// una volta scelta resta in nodes.json, non si ricicla).
function assignLocalPort(st) {
  const used = new Set(st.nodes.map((n) => n.localPort));
  let p = LOCAL_PORT_BASE;
  while (used.has(p) && p <= 65535) p += 1;
  if (p > 65535) throw new Error('nessuna porta locale libera per il tunnel');
  return p;
}

function bindLocalPort(port, createServerImpl = net.createServer) {
  return new Promise((resolve, reject) => {
    const server = createServerImpl();
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      if (typeof server.unref === 'function') server.unref();
      let released = false;
      resolve({
        port,
        release: () => new Promise((done) => {
          if (released) return done();
          released = true;
          try { server.close(() => done()); } catch (_) { done(); }
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

// Selezione OS-aware per il pairing: nodes.json evita collisioni logiche, il
// bind reale evita porte gia' occupate da processi estranei. La socket resta
// riservata fino all'avvio del supervisor SSH e viene poi rilasciata una volta.
async function reserveLocalPort(st, opts = {}) {
  const used = new Set((st.nodes || []).map((n) => n.localPort));
  const createServerImpl = opts.createServerImpl || net.createServer;
  for (let port = opts.start || LOCAL_PORT_BASE; port <= 65535; port += 1) {
    if (used.has(port)) continue;
    try { return await bindLocalPort(port, createServerImpl); }
    catch (error) {
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) continue;
      throw error;
    }
  }
  throw new Error('nessuna porta locale disponibile per il tunnel');
}

function defaultKeyPath(home, name) {
  return path.join(home, '.nexuscrew', 'keys', `${name}_ed25519`);
}

// Genera (o riusa) una chiave SSH dedicata per-tunnel; ritorna la pubkey (single-line).
// Seam opts.keygen(keyPath, name) -> pubkey per i test (niente ssh-keygen reale).
function ensureKey(keyPath, name, opts = {}) {
  if (typeof opts.keygen === 'function') return opts.keygen(keyPath, name);
  const execFileImpl = opts.execFileImpl || execFileSync;
  const pubPath = `${keyPath}.pub`;
  if (fs.existsSync(keyPath)) {
    if (fs.existsSync(pubPath)) return fs.readFileSync(pubPath, 'utf8').trim();
    return String(execFileImpl('ssh-keygen', ['-y', '-f', keyPath], { encoding: 'utf8' })).trim();
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  // chiave dedicata: ed25519, senza passphrase (BatchMode), commento identificante.
  execFileImpl('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `nexuscrew-tunnel-${name}`], { stdio: 'ignore' });
  try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
  return fs.readFileSync(pubPath, 'utf8').trim();
}

// Legge il token remoto da fonte NON-argv: opts.token (test) > env > stdin.
// MAI da flag CLI: il token comparirebbe in `ps`/history.
function readSecretToken(opts) {
  if (typeof opts.token === 'string') return opts.token.trim();
  if (process.env.NEXUSCREW_NODE_TOKEN) return String(process.env.NEXUSCREW_NODE_TOKEN).trim();
  try { return fs.readFileSync(0, 'utf8').trim(); } catch (_) { return ''; }
}

// --- nodes add -------------------------------------------------------------
function nodesAdd(opts) {
  const log = opts.log || console.log;
  if (isReadonly(opts)) { log('nodes add: READONLY, mutazione bloccata'); return { code: 1, reason: 'readonly' }; }

  const { home, nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  const ssh = opts.ssh;
  if (!name) { log('nodes add: name mancante (configura il nodo dalla PWA)'); return { code: 1, reason: 'name mancante' }; }
  if (!ssh) { log('nodes add: --ssh user@host obbligatorio'); return { code: 1, reason: 'ssh mancante' }; }

  const remotePort = opts.remotePort ? Number(opts.remotePort) : DEFAULT_PORT;
  const sshPort = opts.sshPort === undefined ? undefined : Number(opts.sshPort);

  let st;
  try { st = store.loadOrInitStore(nodesPath); }
  catch (e) { log(`nodes add: ${e.message}`); return { code: 1, reason: 'store invalido' }; }

  const localPort = opts.localPort ? Number(opts.localPort) : assignLocalPort(st);
  const keyPath = opts.identityFile || opts.key || (typeof opts.keygen === 'function' ? defaultKeyPath(home, name) : undefined);

  const entry = {
    name, ssh, remotePort, localPort,
    direction: opts.direction || 'outbound',
    transport: opts.transport || 'auto',
    autostart: opts.autostart !== false,
    visibility: opts.visibility || 'network',
    roles: { client: true, node: false },
  };
  if (keyPath) entry.identityFile = keyPath;
  if (opts.token) entry.token = opts.token;
  if (opts.reversePort) entry.reversePort = Number(opts.reversePort);
  if (sshPort !== undefined) entry.sshPort = sshPort;
  if (opts.nodeId) entry.nodeId = opts.nodeId;

  // Valida + inserisci in memoria (dup name/id, self-reference, schema) PRIMA di
  // toccare la chiave: un errore qui non deve lasciare artefatti.
  let next;
  try { next = store.addNode(st, entry); }
  catch (e) { log(`nodes add: ${e.message}`); return { code: 1, reason: 'add rifiutato' }; }

  // chiave dedicata per-tunnel (genera o riusa)
  let pub = null;
  if (keyPath && typeof opts.keygen === 'function') {
    try { pub = ensureKey(keyPath, name, opts); }
    catch (e) { log(`nodes add: generazione chiave fallita (${e.message}) — nodo NON salvato`); return { code: 1, reason: 'keygen fallita' }; }
  }

  try { store.atomicWriteStore(nodesPath, next); }
  catch (e) { log(`nodes add: scrittura nodes.json fallita: ${e.message}`); return { code: 1, reason: 'write fallita' }; }

  log(`nodes add: nodo "${name}" aggiunto (ssh ${ssh}${sshPort ? `:${sshPort}` : ''}, nexus remoto ${remotePort} -> locale ${localPort})`);
  log('Incolla nel ~/.ssh/authorized_keys del NODO (lato forward, chiave dedicata):');
  // permitopen vincola i -L alla SOLA porta nexus remota; command=/bin/false + restrict.
  if (pub) log(`restrict,port-forwarding,permitopen="127.0.0.1:${remotePort}",command="/bin/false" ${pub}`);
  return { code: 0, name, sshPort, localPort, remotePort, transport: entry.transport };
}

// --- nodes list ------------------------------------------------------------
function nodesList(opts) {
  const log = opts.log || console.log;
  const { home, nodesPath } = resolveNodePaths(opts);

  const st = store.loadStore(nodesPath);
  if (!st) {
    if (fs.existsSync(nodesPath)) { log('nodes list: nodes.json presente ma invalido (schema strict) — correggi o rimuovi il file'); return { code: 1, nodes: [] }; }
    if (opts.json) { log(JSON.stringify({ nodeId: null, nodes: [] }, null, 2)); }
    else log('nodes: (nessun nodo)');
    return { code: 0, nodes: [] };
  }

  const view = store.redactStore(st); // MAI il token
  const nodes = view.nodes.map((n) => ({ ...n, tunnel: tunnel.readTunnelState(home, n.name) }));
  const out = { nodeId: view.nodeId, nodes };

  if (opts.json) { log(JSON.stringify(out, null, 2)); return { code: 0, nodes }; }
  if (nodes.length === 0) { log('nodes: (nessun nodo)'); return { code: 0, nodes }; }
  for (const n of nodes) {
    log(`${n.name}\t${n.ssh}${n.sshPort ? `:${n.sshPort}` : ''}\tlocal:${n.localPort} -> nexus:${n.remotePort}\ttunnel:${n.tunnel.status}\ttoken:${n.hasToken ? 'set' : 'unset'}`);
  }
  return { code: 0, nodes };
}

// --- nodes remove ----------------------------------------------------------
function nodesRemove(opts) {
  const log = opts.log || console.log;
  if (isReadonly(opts)) { log('nodes remove: READONLY, mutazione bloccata'); return { code: 1, reason: 'readonly' }; }
  const { home, nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  if (!name) { log('nodes remove: name mancante'); return { code: 1 }; }
  const st = store.loadStore(nodesPath);
  if (!st) { log('nodes remove: nessun nodes.json valido'); return { code: 1 }; }
  let next;
  try { next = store.removeNode(st, name); }
  catch (e) { log(`nodes remove: ${e.message}`); return { code: 1 }; }
  // Ferma un eventuale forward tunnel ATTIVO prima di togliere la config (audit F4):
  // senza questo il ssh resterebbe orfano — porta locale aperta verso un nodo che non
  // e' piu' in config, irraggiungibile e senza piu' uno stop pulito via CLI/API.
  let stopped = false;
  try {
    const sr = tunnel.stopTunnel({ home, name });
    stopped = !!sr.stopped;
    const safeAbsent = ['no pidfile', 'stale (pid dead)', 'pid reuse (cmd mismatch)'].includes(sr.reason);
    if (!stopped && !safeAbsent) {
      log(`nodes remove: impossibile fermare il tunnel (${sr.reason || 'errore sconosciuto'}); config preservata`);
      return { code: 1, reason: 'tunnel stop failed' };
    }
  } catch (e) {
    log(`nodes remove: impossibile fermare il tunnel (${e.message}); config preservata`);
    return { code: 1, reason: 'tunnel stop failed' };
  }
  store.atomicWriteStore(nodesPath, next);
  log(`nodes remove: nodo "${name}" rimosso${stopped ? ' (tunnel attivo fermato)' : ''}`);
  return { code: 0, name, stopped };
}

// --- nodes test (NON-mutante): distingue tunnel-down / health-ko / token-ko ---
async function nodesTest(opts) {
  const log = opts.log || console.log;
  const { home, nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  if (!name) { log('nodes test: name mancante'); return { code: 1 }; }
  const st = store.loadStore(nodesPath);
  const node = st ? store.getNode(st, name) : null;
  if (!node) { log(`nodes test: nodo sconosciuto "${name}"`); return { code: 1, result: 'unknown-node' }; }

  const state = tunnel.readTunnelState(home, name);
  if (state.status !== 'up') {
    const diagnostic = tunnel.diagnoseTunnel(home, node, state);
    log(`nodes test [${name}]: ${diagnostic.code.toUpperCase()} — ${diagnostic.detail}${diagnostic.hint ? ` · ${diagnostic.hint}` : ''}`);
    return { code: 1, result: 'tunnel-down', diagnostic };
  }

  const httpProbe = opts.httpProbe || defaultHttpProbe;
  const base = `http://127.0.0.1:${node.localPort}`;

  // health: GET / non autenticato -> 2xx significa "server remoto raggiungibile via tunnel".
  let health;
  try { health = await httpProbe(`${base}/`, {}); }
  catch (e) { health = { ok: false, error: e && e.message }; }
  if (!health || !health.ok) {
    const diagnostic = tunnel.diagnoseTunnel(home, node);
    const realCause = diagnostic.code !== 'transport-ready' ? diagnostic.detail : ((health && health.error) || 'server HTTP non raggiungibile');
    log(`nodes test [${name}]: HEALTH KO — ${realCause}${diagnostic.hint ? ` · ${diagnostic.hint}` : ''}`);
    return { code: 1, result: 'health-ko', diagnostic: diagnostic.code === 'transport-ready'
      ? { stage: 'http', code: 'peer-http-unreachable', detail: realCause, hint: 'verifica la porta NexusCrew contenuta nel link' }
      : diagnostic };
  }

  // token: GET /api/config con Bearer del nodo -> 200 ok, 401 token KO.
  if (!node.token) {
    log(`nodes test [${name}]: ASSOCIAZIONE INCOMPLETA — rimuovi il nodo e ripeti il pairing dalla PWA`);
    return { code: 1, result: 'token-missing' };
  }
  let authed;
  try { authed = await httpProbe(`${base}/api/config`, { authorization: `Bearer ${node.token}` }); }
  catch (e) { authed = { ok: false, error: e && e.message }; }
  if (authed && authed.status === 200) {
    log(`nodes test [${name}]: OK — tunnel up, health ok, token valido`);
    return { code: 0, result: 'ok' };
  }
  log(`nodes test [${name}]: CREDENZIALE KO — il pairing non e' piu' valido (status ${(authed && authed.status) || '?'}); ripeti il pairing dalla PWA`);
  return { code: 1, result: 'token-ko' };
}

// probe HTTP di default (fetch built-in, Node >=18). Ritorna {ok, status}.
async function defaultHttpProbe(url, headers) {
  const res = await fetch(url, { headers, redirect: 'manual' });
  return { ok: res.status >= 200 && res.status < 400, status: res.status };
}

// --- nodes up/down/restart (lifecycle tunnel, NON tocca la config) ----------
function loadNodeOrFail(opts, log) {
  const { home, nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  if (!name) { log('nodes: name mancante'); return null; }
  const st = store.loadStore(nodesPath);
  const node = st ? store.getNode(st, name) : null;
  if (!node) { log(`nodes: nodo sconosciuto "${name}"`); return null; }
  return { home, nodesPath, store: st, node };
}

function persistAutostart(ctx, enabled) {
  const next = store.updateNode(ctx.store, ctx.node.name, { autostart: enabled });
  store.atomicWriteStore(ctx.nodesPath, next);
  ctx.store = next;
  ctx.node = store.getNode(next, ctx.node.name);
}

function nodesUp(opts) {
  const log = opts.log || console.log;
  const ctx = loadNodeOrFail(opts, log);
  if (!ctx) return { code: 1 };
  if (ctx.node.direction === 'inbound') return { code: 0, started: false, inbound: true };
  if (opts.persistAutostart === true && ctx.node.autostart !== true) {
    try { persistAutostart(ctx, true); }
    catch (e) { log(`nodes up [${ctx.node.name}]: impossibile salvare l'avvio automatico — ${e.message}`); return { code: 1, reason: 'autostart write failed' }; }
  }
  const r = tunnel.startForward({ home: ctx.home, node: ctx.node, localAppPort: opts.localAppPort, spawnImpl: opts.spawnImpl, spawnSyncImpl: opts.spawnSyncImpl, sshBin: opts.sshBin, logFd: opts.logFd });
  if (r.started) {
    log(`nodes up [${ctx.node.name}]: tunnel avviato (pid ${r.pid}, local ${ctx.node.localPort})`);
    return { code: 0, started: true, pid: r.pid, diagnostic: tunnel.diagnoseTunnel(ctx.home, ctx.node) };
  }
  if (r.reason === 'already running') {
    log(`nodes up [${ctx.node.name}]: gia' attivo (pid ${r.pid})`);
    return { code: 0, started: false, pid: r.pid, diagnostic: tunnel.diagnoseTunnel(ctx.home, ctx.node) };
  }
  // failure esplicita (ssh mancante / spawn error): surfacciata a CLI e Settings API.
  log(`nodes up [${ctx.node.name}]: avvio tunnel fallito — ${r.reason}`);
  return { code: 1, started: false, reason: r.reason, diagnostic: tunnel.diagnoseTunnel(ctx.home, ctx.node) };
}

function nodesDown(opts) {
  const log = opts.log || console.log;
  const ctx = loadNodeOrFail(opts, log);
  if (!ctx) return { code: 1 };
  if (ctx.node.direction === 'inbound') return { code: 0, stopped: false, inbound: true };
  if (opts.persistAutostart === true && ctx.node.autostart !== false) {
    try { persistAutostart(ctx, false); }
    catch (e) { log(`nodes down [${ctx.node.name}]: impossibile salvare lo stop — ${e.message}`); return { code: 1, reason: 'autostart write failed' }; }
  }
  const r = tunnel.stopTunnel({ home: ctx.home, name: ctx.node.name });
  log(`nodes down [${ctx.node.name}]: ${r.stopped ? `fermato (pid ${r.pid})` : r.reason}`);
  return { code: 0, stopped: r.stopped };
}

function nodesRestart(opts) {
  const log = opts.log || console.log;
  const ctx = loadNodeOrFail(opts, log);
  if (!ctx) return { code: 1 };
  if (ctx.node.direction === 'inbound') return { code: 0, started: false, inbound: true };
  tunnel.stopTunnel({ home: ctx.home, name: ctx.node.name });
  const r = tunnel.startForward({ home: ctx.home, node: ctx.node, localAppPort: opts.localAppPort, spawnImpl: opts.spawnImpl, spawnSyncImpl: opts.spawnSyncImpl, sshBin: opts.sshBin, logFd: opts.logFd });
  if (r.started) {
    log(`nodes restart [${ctx.node.name}]: tunnel riavviato (pid ${r.pid})`);
    return { code: 0, started: true, pid: r.pid, diagnostic: tunnel.diagnoseTunnel(ctx.home, ctx.node) };
  }
  // dopo stop+start, 'already running' non e' atteso: qualunque !started e' un problema
  // esplicito (ssh mancante / spawn error), surfacciato a CLI e Settings API.
  log(`nodes restart [${ctx.node.name}]: riavvio tunnel fallito — ${r.reason || 'sconosciuto'}`);
  return { code: 1, started: false, reason: r.reason || 'spawn failed', diagnostic: tunnel.diagnoseTunnel(ctx.home, ctx.node) };
}

// --- nodes set-token (aggiorna il token remoto; MAI da argv) ----------------
function nodesSetToken(opts) {
  const log = opts.log || console.log;
  if (isReadonly(opts)) { log('nodes set-token: READONLY, mutazione bloccata'); return { code: 1, reason: 'readonly' }; }
  const { nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  if (!name) { log('nodes set-token: name mancante'); return { code: 1 }; }
  const st = store.loadStore(nodesPath);
  if (!st || !store.getNode(st, name)) { log(`nodes set-token: nodo sconosciuto "${name}"`); return { code: 1 }; }
  const token = readSecretToken(opts);
  if (!token) { log('nodes set-token: nessun token fornito (stdin/env vuoti)'); return { code: 1, reason: 'token vuoto' }; }
  let next;
  try { next = store.setNodeToken(st, name, token); }
  catch (e) { log(`nodes set-token: ${e.message}`); return { code: 1 }; }
  store.atomicWriteStore(nodesPath, next);
  log(`nodes set-token: token del nodo "${name}" aggiornato (valore redatto)`); // MAI il token
  return { code: 0, name };
}

module.exports = {
  nodesAdd, nodesList, nodesRemove, nodesTest,
  nodesUp, nodesDown, nodesRestart, nodesSetToken,
  // helper esposti per test/riuso
  assignLocalPort, bindLocalPort, reserveLocalPort, defaultKeyPath, ensureKey, readSecretToken,
  resolveNodePaths, defaultHttpProbe,
};
