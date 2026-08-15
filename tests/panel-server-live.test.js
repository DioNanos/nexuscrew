'use strict';
// Il wiring REALE del pannello dentro createServer: la chiave con cui
// resolveCellPanel cerca la cella nello status della fleet.
//
// Nasce ROSSO il 2026-08-15 dalla prova browser del dispatch D8: la PWA
// chiedeva il ticket per una cella CON panelUrl e riceveva 404 «pannello non
// disponibile» — la causa «no-panel», il nome sbagliato — mentre lo status
// elencava il pannello della stessa cella. Le suite con resolveCellPanel
// iniettata non possono vederlo: il difetto sta nel cablaggio del server,
// non nelle parti, e solo un server VERO con una fleet VERA lo incontra.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

const TOKEN = 'pannello-wiring';

// Il test parte con un tmux isolato: lo status interroga tmux per le sessioni
// vive, e nessun test deve dipendere — o peggio scrivere — sul socket
// dell'operatore. (Stessa cura di run-isolated.js.)
{
  const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-wiring-tmux-'));
  process.env.TMUX_TMPDIR = tmuxDir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
}

// Home isolata con una fleet MINIMA ma VERA: un engine custom valido e una
// cella. `panelUrl === null` omette il campo: è il modo in cui una cella
// nasce senza pannello (un valore vuoto renderebbe l'intera definizione
// invalida — fail-closed di parseCell).
function homeConCella(panelUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-wiring-'));
  const home = path.join(root, 'home');
  const state = path.join(home, '.nexuscrew');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, 'config.json'),
    JSON.stringify({ bind: '127.0.0.1', port: 0, fleetEnabled: true, autoUpdate: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  const cell = { id: 'grafica', cwd: root, engine: 'dummy', tmuxSession: 'cloud-grafica' };
  if (panelUrl !== null) cell.panelUrl = panelUrl;
  fs.writeFileSync(path.join(state, 'fleet.json'), JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'dummy', label: 'Dummy', command: 'sleep', args: ['1'], promptMode: 'send-keys' }],
    cells: [cell],
  }), { mode: 0o600 });
  return { root, home, state };
}

// Il server VERO, con le seam che toccano solo il supervisore SSH: la strada
// del pannello (status → resolveCellPanel → ticket) resta completamente autentica.
async function serverDiProva(panelUrl) {
  const p = homeConCella(panelUrl);
  const made = createServer({
    home: p.home,
    configDir: p.state,
    configPath: path.join(p.state, 'config.json'),
    nodesPath: path.join(p.state, 'nodes.json'),
    tokenPath: path.join(p.state, 'token'),
    filesRoot: path.join(p.root, 'files'),
    bind: '127.0.0.1',
    port: 0,
    autoPort: false,
    autoUpdate: false,
    fleetEnabled: true,
    log: () => {},
    settingsSeams: {
      platform: 'linux',
      fetchImpl: fetch,
      pairDelay: async () => {},
      stopTunnelImpl: () => ({ stopped: true }),
      startForwardImpl: () => ({ started: true, transport: 'panel-wiring-test' }),
      readTunnelDiagnostic: () => ({ detail: 'panel wiring test: tunnel non usato' }),
    },
  });
  await new Promise((resolve, reject) => {
    made.server.once('error', reject);
    made.server.listen(0, '127.0.0.1', resolve);
  });
  return {
    ...p,
    port: made.server.address().port,
    close: () => new Promise((resolve) => made.server.close(resolve)),
  };
}

test('server vero: il ticket arriva per una cella CON pannello — lo status la vede e il wiring la trova', async (t) => {
  const s = await serverDiProva('http://127.0.0.1:59999');
  t.after(() => s.close());

  // Premessa visibile anche dalla PWA: lo status espone la cella col suo panelUrl.
  const st = await fetch(`http://127.0.0.1:${s.port}/api/fleet/status`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  assert.equal(st.available, true, 'fleet disponibile');
  const cell = (st.cells || []).find((c) => c.cell === 'grafica');
  assert.ok(cell, 'la cella è nello status');
  assert.equal(cell.panelUrl, 'http://127.0.0.1:59999', 'il panelUrl viaggia nello status');

  // Il soggetto: la PWA (Bearer) chiede il ticket per quella cella.
  const r = await fetch(`http://127.0.0.1:${s.port}/api/panel/grafica/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(r.status, 200, 'emissione del ticket per una cella con pannello');
  const j = await r.json().catch(() => ({}));
  assert.equal(j.cell, 'grafica', 'il ticket è per la cella chiesta');
  assert.ok(typeof j.ticket === 'string' && j.ticket.length >= 32, 'ticket opaco, non il token del nodo');
});

test('server vero: cella SENZA panelUrl → 404 con causa no-panel, non un errore d\'altro nome', async (t) => {
  const s = await serverDiProva(null);
  t.after(() => s.close());

  const st = await fetch(`http://127.0.0.1:${s.port}/api/fleet/status`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json());
  const cell = (st.cells || []).find((c) => c.cell === 'grafica');
  assert.ok(cell, 'la cella senza pannello è comunque nello status');
  assert.equal(cell.panelUrl, '', 'senza campo, panelUrl reso come stringa vuota');

  const r = await fetch(`http://127.0.0.1:${s.port}/api/panel/grafica/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(r.status, 404, 'niente ticket senza pannello');
  const j = await r.json().catch(() => ({}));
  assert.equal(j.error, 'pannello non disponibile', 'la causa ha il suo nome');
});
