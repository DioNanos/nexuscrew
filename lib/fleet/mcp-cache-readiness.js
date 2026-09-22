'use strict';
// Readiness MCP per-server dalla cache del client Claude Code.
//
// Il client 2.1.280 scrive, per ogni server MCP e per ogni avvio di processo,
// un log diagnostico in:
//   ~/.cache/claude-cli-nodejs/<encoded-cwd>/mcp-logs-<server>/<bootUTC>.jsonl
// con encoded-cwd = ogni non-alfanumerico sostituito da '-', un file jsonl per
// boot del processo client e `sessionId` in ogni riga. Stati osservati sul
// 2.1.280 (misurato con 8 probe tmux su sessioni usa-e-getta):
//   pending: "Starting connection with timeout of 30000ms"
//   ready:   "Successfully connected (transport: stdio) in <N>ms"
//   failed:  "Connection failed after <N>ms (CONNECTION_CLOSED): Connection closed"
//            e/o record {"error": "..."} SENZA campo `debug` (schema variabile).
//
// QUESTO E' UN ADATTATORE VERSIONATO su client 2.1.280: il formato e'
// diagnostica del client, non un contratto. Ogni lettura e' tollerante (righe
// non-JSON o senza campi noti vengono ignorate, errori di I/O degradano a
// pending) e il modulo dichiara la versione supportata in
// ADAPTER_CLIENT_VERSION; un client futuro che cambia formato degrada a
// pending visibile, mai crash.
//
// L'insieme atteso e' quello MATERIALIZZATO della cella (chiavi del file
// cell-mcp/<cellId>.json): un server non concesso non esiste per il launch
// (disabled per costruzione, non uno stato di questo adattatore). Il boot
// corrente e' il file con nome-stamp >= notBeforeMs del launch: i log delle
// generazioni precedenti non sbloccano mai (nessun handshake vecchio).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Versione del client su cui il formato dei log e' stato misurato (probe).
const ADAPTER_CLIENT_VERSION = '2.1.280';

// Stati bounded per server e per insieme. 'degraded' = insieme non tutti
// ready ma concluso (almeno un failed/pending scaduto il budget).
const SERVER_STATES = Object.freeze(['pending', 'ready', 'failed']);
const SET_STATES = Object.freeze(['pending', 'ready', 'degraded']);

const READY_RE = /Successfully connected/;
const FAILED_RE = /Connection failed/;
const BOOT_RE = /Starting connection/;

// '2026-09-22T18:46:09.220Z' -> '2026-09-22T18-46-09-220Z': lo stesso stamp
// che il client usa per i nomi dei boot file. Ordina lessicograficamente
// come il tempo.
function bootStampOf(ms) {
  return new Date(Number(ms) || 0).toISOString().replace(/[^A-Za-z0-9TZ]/g, '-');
}

function encodeCwdForCache(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function clampInt(value, dflt, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// Stato di UN server nel boot corrente: il file piu' recente con nome-stamp
// >= notBeforeStamp decide; i boot vecchi non vengono nemmeno letti.
function readServerState(fsImpl, serverDir, notBeforeStamp) {
  let names = [];
  try {
    names = fsImpl.readdirSync(serverDir)
      .filter((n) => n.endsWith('.jsonl') && n.slice(0, -6) >= notBeforeStamp)
      .sort()
      .reverse();
  } catch (_) {
    return 'pending'; // directory assente o illeggibile: server non ancora partito
  }
  if (!names.length) return 'pending';
  let text = '';
  try {
    text = fsImpl.readFileSync(path.join(serverDir, names[0]), 'utf8');
  } catch (_) {
    return 'pending';
  }
  let sawBoot = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue; // riga malformata: ignorata, mai crash su diagnostica
    }
    if (!rec || typeof rec !== 'object') continue;
    const dbg = typeof rec.debug === 'string' ? rec.debug : '';
    // Le failure usano la chiave `error` senza campo `debug` (misurato 2.1.280).
    if (!dbg && typeof rec.error === 'string' && rec.error) return 'failed';
    if (READY_RE.test(dbg)) return 'ready';
    if (FAILED_RE.test(dbg)) return 'failed';
    if (BOOT_RE.test(dbg)) sawBoot = true;
  }
  return sawBoot ? 'pending' : 'pending';
}

// Istantanea dell'insieme materializzato: {state, servers, ready, failed,
// pending, adapterClientVersion}. Con attesa vuota lo stato e' 'ready'
// (nessun server da aspettare: il gate non deve ritardare la consegna).
function readinessNow({
  cacheRoot, cwd, expectedServers, notBeforeMs, fsImpl = fs,
} = {}) {
  const root = typeof cacheRoot === 'string' && cacheRoot
    ? cacheRoot
    : path.join(os.homedir(), '.cache', 'claude-cli-nodejs');
  const encoded = encodeCwdForCache(cwd);
  const notBeforeStamp = bootStampOf(notBeforeMs);
  const servers = {};
  const attesi = Array.isArray(expectedServers) ? expectedServers : [];
  for (const name of attesi) {
    if (typeof name !== 'string' || !name) continue;
    servers[name] = readServerState(fsImpl, path.join(root, encoded, `mcp-logs-${name}`), notBeforeStamp);
  }
  const ready = Object.keys(servers).filter((k) => servers[k] === 'ready').sort();
  const failed = Object.keys(servers).filter((k) => servers[k] === 'failed').sort();
  const pending = Object.keys(servers).filter((k) => servers[k] === 'pending').sort();
  const state = attesi.length === 0
    ? 'ready'
    : (failed.length === 0 && pending.length === 0 ? 'ready'
      : (pending.length === 0 ? 'degraded' : 'pending'));
  return { state, servers, ready, failed, pending, adapterClientVersion: ADAPTER_CLIENT_VERSION };
}

// Attesa bounded dell'insieme: termina su insieme concluso (zero pending),
// su deadline, o su cancellazione. La DEADLINE e' assoluta e composta dal
// chiamante (un solo budget composto): `deadlineMs` e' l'epoch del tetto MCP,
// tipicamente launchStartMs + 20000, che consume lo stesso orologio del
// composer (readyWaitMs). Ritorna {cancelled:true} oppure l'ultima
// readinessNow piu' `waited` e `timedOut`.
async function waitMcpReadiness({
  params, deadlineMs, pollMs = 500, sleepImpl, nowImpl, isCancelled, fsImpl,
} = {}) {
  const sleepFn = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = nowImpl || Date.now;
  const deadline = Number(deadlineMs) || 0;
  const started = now();
  let last = null;
  for (;;) {
    if (typeof isCancelled === 'function' && isCancelled()) {
      return { cancelled: true };
    }
    last = readinessNow({ ...(params || {}), fsImpl: fsImpl || (params && params.fsImpl) });
    if (last.state !== 'pending') return { ...last, waited: now() - started, timedOut: false };
    if (now() >= deadline) return { ...last, waited: now() - started, timedOut: true };
    await sleepFn(clampInt(pollMs, 500, 50, 5000));
  }
}

module.exports = {
  ADAPTER_CLIENT_VERSION, SERVER_STATES, SET_STATES,
  bootStampOf, encodeCwdForCache, readinessNow, waitMcpReadiness, readServerState,
};
