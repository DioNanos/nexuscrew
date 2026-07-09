'use strict';
const fs = require('node:fs');
const { createFleetExec } = require('./exec.js');

const ENGINES = new Set(['native', 'glm', 'glm-a', 'glm-p', 'ollama', 'ollama-cloud', 'codex-vl']);
const STATUS_TTL_MS = 2000;

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
  return cells;
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function createFleet(cfg = {}) {
  const off = { available: false, isCellSession: () => false };
  if (cfg.fleetEnabled === false) return off;
  const bin = cfg.fleetBin;
  if (!bin || !binTrusted(bin)) return off;

  const fx = createFleetExec(bin);
  let cells;
  try { cells = parseStatus(await fx.run(['status', '--json'])); } catch (_) { return off; }
  if (!cells) return off;                            // schema estraneo → feature spenta

  let cache = { at: Date.now(), cells };
  const sessions = () => new Set(cache.cells.map((c) => c.tmuxSession));

  async function status() {
    if (Date.now() - cache.at > STATUS_TTL_MS) {
      const fresh = parseStatus(await fx.run(['status', '--json']));
      if (fresh) cache = { at: Date.now(), cells: fresh };
    }
    return { available: true, cells: cache.cells };
  }

  function assertCell(cell) {
    if (!cache.cells.some((c) => c.cell === cell)) throw httpError(400, `cella sconosciuta: ${cell}`);
  }
  function assertEngine(eng) {
    if (!ENGINES.has(eng)) throw httpError(400, `engine non valido: ${eng}`);
  }
  async function cmd(args) {
    try { await fx.run(args); } catch (e) { throw httpError(502, e.message); }
    cache = { at: 0, cells: cache.cells };           // invalida: il prossimo status rilegge
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
