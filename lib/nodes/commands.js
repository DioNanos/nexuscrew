'use strict';
// lib/nodes/commands.js — subcomandi CLI `nodes` e `node` (design §3, §4, §4b).
//
// nodes add/list/remove/test/up/down/restart/set-token + node on/off.
// Invarianti:
//   - token per-nodo MAI loggati/stampati (redazione sempre; set-token li legge
//     da stdin/env, mai da argv -> niente segreti in `ps`).
//   - NEXUSCREW_READONLY blocca le MUTAZIONI DI CONFIG (add/remove/set-token/
//     on/off), non list/test/status/up/down/restart (lifecycle tunnel, non config).
//   - niente shell interpolation: ssh-keygen via execFile (argv), tunnel via spawn argv.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('./store.js');
const tunnel = require('./tunnel.js');
const { resolvePaths, loadPort, DEFAULT_PORT } = require('../cli/url.js');

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

// Scrittura atomica di config.json preservando il resto (per roles).
function writeConfigRole(configPath, key, value) {
  let cfg = {};
  try { const c = JSON.parse(fs.readFileSync(configPath, 'utf8')); if (c && typeof c === 'object') cfg = c; } catch (_) {}
  const roles = (cfg.roles && typeof cfg.roles === 'object') ? cfg.roles : {};
  cfg.roles = { client: !!roles.client, node: !!roles.node };
  cfg.roles[key] = value;
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(configPath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  return cfg.roles;
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
  if (!name) { log('usage: nexuscrew nodes add <name> --ssh user@host [--ssh-port N] [--remote-port N] [--key path] [--local-port N]'); return { code: 1, reason: 'name mancante' }; }
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
  if (view.rendezvous) out.rendezvous = view.rendezvous;

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
  if (!name) { log('usage: nexuscrew nodes remove <name>'); return { code: 1 }; }
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
  if (!name) { log('usage: nexuscrew nodes test <name>'); return { code: 1 }; }
  const st = store.loadStore(nodesPath);
  const node = st ? store.getNode(st, name) : null;
  if (!node) { log(`nodes test: nodo sconosciuto "${name}"`); return { code: 1, result: 'unknown-node' }; }

  const state = tunnel.readTunnelState(home, name);
  if (state.status !== 'up') {
    log(`nodes test [${name}]: TUNNEL DOWN — avvia con \`nexuscrew nodes up ${name}\``);
    return { code: 1, result: 'tunnel-down' };
  }

  const httpProbe = opts.httpProbe || defaultHttpProbe;
  const base = `http://127.0.0.1:${node.localPort}`;

  // health: GET / non autenticato -> 2xx significa "server remoto raggiungibile via tunnel".
  let health;
  try { health = await httpProbe(`${base}/`, {}); }
  catch (e) { health = { ok: false, error: e && e.message }; }
  if (!health || !health.ok) {
    log(`nodes test [${name}]: HEALTH KO — tunnel up ma il server remoto non risponde (${(health && health.error) || 'no 2xx'})`);
    return { code: 1, result: 'health-ko' };
  }

  // token: GET /api/config con Bearer del nodo -> 200 ok, 401 token KO.
  if (!node.token) {
    log(`nodes test [${name}]: TOKEN ASSENTE — salva il token remoto con \`nexuscrew nodes set-token ${name}\``);
    return { code: 1, result: 'token-missing' };
  }
  let authed;
  try { authed = await httpProbe(`${base}/api/config`, { authorization: `Bearer ${node.token}` }); }
  catch (e) { authed = { ok: false, error: e && e.message }; }
  if (authed && authed.status === 200) {
    log(`nodes test [${name}]: OK — tunnel up, health ok, token valido`);
    return { code: 0, result: 'ok' };
  }
  log(`nodes test [${name}]: TOKEN KO — il token remoto salvato non e' valido (status ${(authed && authed.status) || '?'}); ruota con \`nexuscrew nodes set-token ${name}\``);
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
  if (!name) { log('usage: nexuscrew nodes up|down|restart <name>'); return null; }
  const st = store.loadStore(nodesPath);
  const node = st ? store.getNode(st, name) : null;
  if (!node) { log(`nodes: nodo sconosciuto "${name}"`); return null; }
  return { home, node };
}

function nodesUp(opts) {
  const log = opts.log || console.log;
  const ctx = loadNodeOrFail(opts, log);
  if (!ctx) return { code: 1 };
  if (ctx.node.direction === 'inbound') return { code: 0, started: false, inbound: true };
  const r = tunnel.startForward({ home: ctx.home, node: ctx.node, localAppPort: opts.localAppPort, spawnImpl: opts.spawnImpl, spawnSyncImpl: opts.spawnSyncImpl, sshBin: opts.sshBin, logFd: opts.logFd });
  if (r.started) {
    log(`nodes up [${ctx.node.name}]: tunnel avviato (pid ${r.pid}, local ${ctx.node.localPort})`);
    return { code: 0, started: true, pid: r.pid };
  }
  if (r.reason === 'already running') {
    log(`nodes up [${ctx.node.name}]: gia' attivo (pid ${r.pid})`);
    return { code: 0, started: false, pid: r.pid };
  }
  // failure esplicita (ssh mancante / spawn error): surfacciata a CLI e Settings API.
  log(`nodes up [${ctx.node.name}]: avvio tunnel fallito — ${r.reason}`);
  return { code: 1, started: false, reason: r.reason };
}

function nodesDown(opts) {
  const log = opts.log || console.log;
  const { home, nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  if (!name) { log('usage: nexuscrew nodes down <name>'); return { code: 1 }; }
  const st = store.loadStore(nodesPath);
  if (!st || !store.getNode(st, name)) { log(`nodes down: nodo sconosciuto "${name}"`); return { code: 1 }; }
  const r = tunnel.stopTunnel({ home, name });
  log(`nodes down [${name}]: ${r.stopped ? `fermato (pid ${r.pid})` : r.reason}`);
  return { code: 0, stopped: r.stopped };
}

function nodesRestart(opts) {
  const log = opts.log || console.log;
  const ctx = loadNodeOrFail(opts, log);
  if (!ctx) return { code: 1 };
  const args = tunnel.buildForwardArgs(ctx.node);
  const r = tunnel.restartTunnel({ home: ctx.home, name: ctx.node.name, args, spawnImpl: opts.spawnImpl, spawnSyncImpl: opts.spawnSyncImpl, sshBin: opts.sshBin, logFd: opts.logFd });
  if (r.started) {
    log(`nodes restart [${ctx.node.name}]: tunnel riavviato (pid ${r.pid})`);
    return { code: 0, started: true, pid: r.pid };
  }
  // dopo stop+start, 'already running' non e' atteso: qualunque !started e' un problema
  // esplicito (ssh mancante / spawn error), surfacciato a CLI e Settings API.
  log(`nodes restart [${ctx.node.name}]: riavvio tunnel fallito — ${r.reason || 'sconosciuto'}`);
  return { code: 1, started: false, reason: r.reason || 'spawn failed' };
}

// --- nodes set-token (aggiorna il token remoto; MAI da argv) ----------------
function nodesSetToken(opts) {
  const log = opts.log || console.log;
  if (isReadonly(opts)) { log('nodes set-token: READONLY, mutazione bloccata'); return { code: 1, reason: 'readonly' }; }
  const { nodesPath } = resolveNodePaths(opts);
  const name = opts.name;
  if (!name) { log('usage: nexuscrew nodes set-token <name>  (token da stdin o env NEXUSCREW_NODE_TOKEN)'); return { code: 1 }; }
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

// --- node on|off (ruolo "nodo raggiungibile", reverse tunnel) ---------------
function nodeOn(opts) {
  const log = opts.log || console.log;
  if (isReadonly(opts)) { log('node on: READONLY, mutazione bloccata'); return { code: 1, reason: 'readonly' }; }
  const { home, configPath, nodesPath } = resolveNodePaths(opts);

  // Gate permitlisten (§7 advisory a): il ruolo node richiede reverse tunnel con
  // permitlisten sul rendezvous (OpenSSH >=7.8). Se la versione e' nota ed e'
  // troppo vecchia -> rifiuta PRIMA di abilitare. Ignota -> warn, non blocca.
  const v = (opts.sshVersion || tunnel.readSshVersion)(opts.spawnSyncImpl);
  const supp = tunnel.sshSupportsPermitlisten(v);
  if (supp === false) {
    log(`node on: OpenSSH ${v.major}.${v.minor} < 7.8 — permitlisten non supportato dal client; il ruolo node NON e' abilitabile con questa toolchain`);
    return { code: 1, reason: 'permitlisten' };
  }
  if (supp === null) log('node on: versione OpenSSH non determinabile — verifica che il rendezvous supporti permitlisten (>=7.8)');

  // Configurazione rendezvous opzionale (flags) o gia' presente in nodes.json.
  let st;
  try { st = store.loadOrInitStore(nodesPath); }
  catch (e) { log(`node on: ${e.message}`); return { code: 1 }; }

  if (opts.rendezvousSsh) {
    const localPort = loadPort(opts); // porta nexus locale da esporre
    const publishedPort = opts.publishedPort ? Number(opts.publishedPort) : localPort;
    const keyPath = opts.key || path.join(home, '.nexuscrew', 'keys', 'rendezvous_ed25519');
    let pub;
    try { pub = ensureKey(keyPath, 'rendezvous', opts); }
    catch (e) { log(`node on: generazione chiave rendezvous fallita (${e.message})`); return { code: 1 }; }
    let next;
    try { next = store.setRendezvous(st, { ssh: opts.rendezvousSsh, publishedPort, localPort, keyPath }); }
    catch (e) { log(`node on: ${e.message}`); return { code: 1 }; }
    store.atomicWriteStore(nodesPath, next);
    st = next;
    log(`node on: rendezvous configurato (${opts.rendezvousSsh}, published ${publishedPort} <- local ${localPort})`);
    log('Incolla nel ~/.ssh/authorized_keys del RENDEZVOUS (lato reverse, chiave dedicata):');
    // permitlisten vincola i -R alla SOLA porta pubblicata (loopback esplicito).
    log(`restrict,port-forwarding,permitlisten="127.0.0.1:${publishedPort}",command="/bin/false" ${pub}`);
  } else if (!st.rendezvous) {
    log('node on: nessun rendezvous configurato — passa --rendezvous user@host [--published-port N] [--key path]');
    return { code: 1, reason: 'no rendezvous' };
  }

  // Avvia un supervisor detached per il reverse tunnel. Il supervisor ritenta
  // con backoff: al primo setup può partire prima che la pubkey sia stata
  // incollata sul rendezvous e convergerà automaticamente appena autorizzata.
  const tr = tunnel.startReverse({
    home, rendezvous: st.rendezvous,
    spawnImpl: opts.spawnImpl, spawnSyncImpl: opts.spawnSyncImpl,
    sshBin: opts.sshBin, logFd: opts.logFd,
  });
  if (!tr.started && tr.reason !== 'already running') {
    log(`node on: reverse tunnel non avviato — ${tr.reason || 'errore sconosciuto'}; ruolo NON abilitato`);
    return { code: 1, reason: 'reverse tunnel failed' };
  }

  const roles = writeConfigRole(configPath, 'node', true);
  log(`node on: ruolo node ABILITATO (roles: client=${roles.client} node=${roles.node}, reverse pid=${tr.pid})`);
  return { code: 0, roles, tunnel: { started: !!tr.started, pid: tr.pid } };
}

function nodeOff(opts) {
  const log = opts.log || console.log;
  if (isReadonly(opts)) { log('node off: READONLY, mutazione bloccata'); return { code: 1, reason: 'readonly' }; }
  const { home, configPath } = resolveNodePaths(opts);
  const roles = writeConfigRole(configPath, 'node', false);
  // Ferma un eventuale reverse tunnel attivo (best-effort, non tocca la config rendezvous).
  try { tunnel.stopTunnel({ home, name: tunnel.REVERSE_NAME }); } catch (_) {}
  log(`node off: ruolo node DISABILITATO (roles: client=${roles.client} node=${roles.node})`);
  return { code: 0, roles };
}

module.exports = {
  nodesAdd, nodesList, nodesRemove, nodesTest,
  nodesUp, nodesDown, nodesRestart, nodesSetToken,
  nodeOn, nodeOff,
  // helper esposti per test/riuso
  assignLocalPort, defaultKeyPath, ensureKey, writeConfigRole, readSecretToken,
  resolveNodePaths, defaultHttpProbe,
};
