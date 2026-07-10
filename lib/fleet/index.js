'use strict';
const fs = require('node:fs');
const { createFleetExec } = require('./exec.js');

const STATUS_TTL_MS = 2000;
const ENGINE_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_ENGINES = 24;

// Engines dichiarati dal contratto fleet (opzionale, additivo al v1):
// array di stringhe o {id, label?, rc?}. id per i comandi, label per la UI,
// rc=true se l'engine supporta il remote-control (default: solo id 'native',
// compat col vincolo storico). Malformato → null (fail-closed come le celle).
function parseEngines(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ENGINES) return null;
  const out = []; const seen = new Set();
  for (const e of raw) {
    let id; let label; let rc;
    if (typeof e === 'string') { id = e; } else if (e && typeof e === 'object' && typeof e.id === 'string') {
      id = e.id;
      if (e.label != null && typeof e.label !== 'string') return null;
      label = e.label;
      if (e.rc != null && typeof e.rc !== 'boolean') return null;
      rc = e.rc;
    } else return null;
    if (!ENGINE_ID_RE.test(id) || seen.has(id)) return null;
    seen.add(id);
    out.push({ id, label: (label || id).slice(0, 48), rc: rc != null ? rc : id === 'native' });
  }
  return out;
}

// Trust boundary sul binario (audit F3): regular file, NO symlink,
// eseguibile dall'owner, NON world-writable.
function binTrusted(bin) {
  try {
    const st = fs.lstatSync(bin);
    if (!st.isFile()) return false;                 // lstat: un symlink NON è file
    if (!(st.mode & 0o100)) return false;           // owner-executable
    if (st.mode & 0o002) return false;              // world-writable
    return true;
  } catch (_) { return false; }
}

function parseStatus(raw) {
  let d;
  try { d = JSON.parse(raw); } catch (_) { return null; }
  if (!d || d.kind !== 'ai-fleet' || d.schemaVersion !== 1 || !Array.isArray(d.cells)) return null;
  // Strict per cella (audit finale #2): campi obbligatori e tipizzati; una sola
  // cella malformata invalida l'intero status (fail-closed, feature spenta).
  const cells = [];
  for (const c of d.cells) {
    if (!c || typeof c !== 'object'
      || typeof c.cell !== 'string' || !c.cell
      || typeof c.tmuxSession !== 'string' || !c.tmuxSession
      || typeof c.engine !== 'string' || !c.engine
      || typeof c.active !== 'boolean' || typeof c.boot !== 'boolean'
      || typeof c.tmux !== 'boolean'
      || typeof c.rc !== 'string' || typeof c.key !== 'string') return null;
    cells.push({
      cell: c.cell, tmuxSession: c.tmuxSession, engine: c.engine,
      active: c.active, boot: c.boot, tmux: c.tmux, rc: c.rc, key: c.key,
      degraded: c.active !== c.tmux,                 // unit e tmux in disaccordo
    });
  }
  const engines = parseEngines(d.engines);
  if (engines === null) return null;                 // engines malformati → fail-closed
  return { cells, engines };
}

// Lista engine effettiva: dichiarata dal fleet se presente, altrimenti
// derivata dagli engine in uso nelle celle (fallback conservativo, no hardcode).
function effectiveEngines(cache) {
  if (cache.engines.length) return cache.engines;
  const seen = new Set();
  const out = [];
  for (const c of cache.cells) {
    if (!seen.has(c.engine)) { seen.add(c.engine); out.push({ id: c.engine, label: c.engine, rc: c.engine === 'native' }); }
  }
  return out;
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function createFleet(cfg = {}) {
  const off = { available: false, isCellSession: () => false };
  if (cfg.fleetEnabled === false) return off;
  const bin = cfg.fleetBin;
  if (!bin || !binTrusted(bin)) return off;

  const fx = createFleetExec(bin);
  let parsed;
  try { parsed = parseStatus(await fx.run(['status', '--json'])); } catch (_) { return off; }
  if (!parsed) return off;                           // schema estraneo → feature spenta

  let cache = { at: Date.now(), cells: parsed.cells, engines: parsed.engines };
  const sessions = () => new Set(cache.cells.map((c) => c.tmuxSession));

  async function status() {
    if (Date.now() - cache.at > STATUS_TTL_MS) {
      const fresh = parseStatus(await fx.run(['status', '--json']));
      if (fresh) cache = { at: Date.now(), cells: fresh.cells, engines: fresh.engines };
    }
    return { available: true, cells: cache.cells, engines: effectiveEngines(cache) };
  }

  function assertCell(cell) {
    if (!cache.cells.some((c) => c.cell === cell)) throw httpError(400, `cella sconosciuta: ${cell}`);
  }
  function assertEngine(eng) {
    if (!effectiveEngines(cache).some((e) => e.id === eng)) throw httpError(400, `engine non valido: ${eng}`);
  }
  async function cmd(args) {
    try { await fx.run(args); } catch (e) { throw httpError(502, e.message); }
    cache = { ...cache, at: 0 };                     // invalida: il prossimo status rilegge
    return { ok: true };
  }

  return {
    available: true,
    status,
    up: async (cell, { engine, boot } = {}) => {
      assertCell(cell); if (engine != null) assertEngine(engine);
      const a = ['up', cell]; if (engine) a.push('--engine', engine); if (boot) a.push('--boot');
      return cmd(a);
    },
    down: async (cell, { boot } = {}) => {
      assertCell(cell);
      const a = ['down', cell]; if (boot) a.push('--boot');
      return cmd(a);
    },
    engine: async (cell, eng) => { assertCell(cell); assertEngine(eng); return cmd(['engine', cell, eng]); },
    boot: async (cell, enabled) => { assertCell(cell); return cmd([enabled ? 'boot' : 'noboot', cell]); },
    isCellSession: (name) => sessions().has(name),
  };
}

module.exports = { createFleet, parseStatus, binTrusted };
