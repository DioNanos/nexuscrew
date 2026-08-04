'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const { cellsRoutes, publicCells } = require('../lib/cells/routes.js');

const LOCAL = 'a'.repeat(32);
const REMOTE = 'b'.repeat(32);
const MESSAGE = '12345678-1234-1234-1234-123456789abc';
const STATUS = {
  available: true,
  cells: [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex.native', active: true, tmux: true },
    { cell: 'Off', tmuxSession: 'cloud-Off', engine: 'claude.native', active: false, tmux: false },
  ],
};

async function boot(t, opts = {}) {
  const submissions = [];
  const app = express();
  app.use('/api/cells', cellsRoutes({
    fleetP: Promise.resolve(opts.fleet || { available: true, status: async () => STATUS }),
    instanceId: () => LOCAL,
    submit: opts.submit || (async (session, text, meta) => { submissions.push({ session, text, meta }); return { submitted: true }; }),
    readonly: () => opts.readonly === true,
    now: () => 1234,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, submissions };
}

test('publicCells espone solo identita valide e canReceive onesto', () => {
  const out = publicCells({ available: true, cells: [
    ...STATUS.cells,
    { cell: '../bad', tmuxSession: 'x', active: true },
    { cell: 'Legacy', tmuxSession: 'legacy', engine: 'x', active: true },
  ] }, LOCAL, 42);
  assert.deepEqual(out.map((cell) => [cell.cell, cell.active, cell.canReceive, cell.lastSeen]), [
    ['Dev', true, true, 42], ['Off', false, false, null], ['Legacy', true, true, 42],
  ]);
});

test('GET /cells e POST /cells/send consegnano solo alla cella Fleet attiva esatta', async (t) => {
  const { base, submissions } = await boot(t);
  const roster = await (await fetch(`${base}/api/cells`)).json();
  assert.equal(roster.instanceId, LOCAL);
  assert.deepEqual(roster.cells.map((cell) => [cell.id, cell.canReceive]), [
    [`${LOCAL}:Dev`, true], [`${LOCAL}:Off`, false],
  ]);
  const body = {
    id: MESSAGE,
    from: { instanceId: LOCAL, cell: 'Dev', tmuxSession: 'cloud-Dev' },
    to: { instanceId: LOCAL, cell: 'Dev', tmuxSession: 'cloud-Dev' },
    message: 'verifica il repository',
  };
  const sent = await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(sent.status, 200);
  const receipt = await sent.json();
  assert.equal(receipt.status, 'submitted');
  assert.match(receipt.note, /non elaborazione/);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].session, 'cloud-Dev');
  assert.match(submissions[0].text, /NexusCrew message/);
  assert.match(submissions[0].text, /verifica il repository/);
  assert.match(submissions[0].text, /\[End NexusCrew message\]$/);
  assert.equal(submissions[0].meta.engine, 'codex.native');

  const off = await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, to: { instanceId: LOCAL, cell: 'Off', tmuxSession: 'cloud-Off' } }),
  });
  assert.equal(off.status, 409);
  const arbitrary = await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, to: { instanceId: LOCAL, cell: 'Dev', tmuxSession: 'other' } }),
  });
  assert.equal(arbitrary.status, 404);
  assert.equal(submissions.length, 1);
});

test('GET /cells usa lo stato leggero e non blocca sulla discovery del catalogo', async (t) => {
  let lightCalls = 0;
  const { base } = await boot(t, { fleet: {
    available: true,
    cellStatus: async () => { lightCalls += 1; return STATUS; },
    status: async () => { throw new Error('la discovery completa non deve servire alla directory'); },
  } });
  const response = await fetch(`${base}/api/cells`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cells.length, 2);
  assert.equal(lightCalls, 1);
});

test('remote sender requires the server-controlled visited route', async (t) => {
  const { base, submissions } = await boot(t);
  const body = {
    id: MESSAGE,
    from: { instanceId: REMOTE, cell: 'Remote', tmuxSession: 'cloud-Remote' },
    to: { instanceId: LOCAL, cell: 'Dev', tmuxSession: 'cloud-Dev' },
    message: 'hello',
  };
  assert.equal((await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).status, 403);
  assert.equal((await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'x-nexuscrew-visited': `${REMOTE},${LOCAL}`,
    }, body: JSON.stringify(body),
  })).status, 200);
  assert.equal(submissions.length, 1);
});

test('READONLY blocca l invio ma lascia leggibile la directory', async (t) => {
  const { base } = await boot(t, { readonly: true });
  assert.equal((await fetch(`${base}/api/cells`)).status, 200);
  assert.equal((await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 403);
});

// --- NC-D: il nome leggibile deve VIAGGIARE, non restare locale -------------
// La directory e' il modo in cui un nodo si presenta agli altri: se porta solo
// l'id, chi la riceve legge il nome che quel nodo ha scelto per se' e non ha
// modo di sapere che ruolo occupa quella cella.

test('directory: la label di cella viaggia accanto all id', async (t) => {
  const { base } = await boot(t, {
    fleet: {
      available: true,
      status: async () => ({
        available: true,
        cells: [{
          cell: 'Codex-VL', label: 'SysAdmin', tmuxSession: 'cloud-Codex-VL',
          engine: 'codex-vl.native', active: true, tmux: true,
        }],
      }),
    },
  });
  const res = await fetch(`${base}/api/cells`);
  const body = await res.json();
  const entry = body.cells.find((c) => c.cell === 'Codex-VL');
  assert.ok(entry, 'la cella deve comparire');
  assert.equal(entry.label, 'SysAdmin', 'il nome leggibile viaggia');
  // L'id resta la chiave di indirizzamento e non viene sostituito dal nome.
  assert.equal(entry.cell, 'Codex-VL');
  assert.equal(entry.id, `${LOCAL}:Codex-VL`);
});

test('directory: senza label il campo resta vuoto, non inventato', async (t) => {
  const { base } = await boot(t);
  const body = await (await fetch(`${base}/api/cells`)).json();
  const entry = body.cells.find((c) => c.cell === 'Dev');
  assert.equal(entry.label, '', 'nessun default silenzioso: decide chi legge');
});

test('directory: una label non stringa non contamina la voce', async (t) => {
  const { base } = await boot(t, {
    fleet: {
      available: true,
      status: async () => ({
        available: true,
        cells: [{ cell: 'Dev', label: { attacco: true }, tmuxSession: 'cloud-Dev', engine: 'x', active: true, tmux: true }],
      }),
    },
  });
  const body = await (await fetch(`${base}/api/cells`)).json();
  assert.equal(body.cells[0].label, '');
});

// --- NC-D: la label e' testo auto-dichiarato anche in USCITA ----------------
// La definizione locale e' gia' validata dal parser, ma il payload esposto e
// quello ricevuto da un peer vanno delimitati comunque: senza, una stringa
// lunga e con a capo attraversa la directory e finisce in ogni consumatore che
// la renderizza.

test('directory: una label ostile non attraversa la superficie pubblica', async (t) => {
  const hostile = 'X'.repeat(200) + String.fromCharCode(10) + 'iniettato';
  const { base } = await boot(t, {
    fleet: {
      available: true,
      status: async () => ({
        available: true,
        cells: [{ cell: 'Dev', label: hostile, tmuxSession: 'cloud-Dev', engine: 'x', active: true, tmux: true }],
      }),
    },
  });
  const body = await (await fetch(`${base}/api/cells`)).json();
  assert.equal(body.cells[0].label, '', 'oltre i limiti o con caratteri di controllo: nessun nome');
});

test('directory: la label viene ripulita dei bordi e delimitata a 64', async (t) => {
  const { base } = await boot(t, {
    fleet: {
      available: true,
      status: async () => ({
        available: true,
        cells: [
          { cell: 'A', label: '  Ricerca  ', tmuxSession: 'cloud-A', engine: 'x', active: true, tmux: true },
          { cell: 'B', label: 'y'.repeat(64), tmuxSession: 'cloud-B', engine: 'x', active: true, tmux: true },
          { cell: 'C', label: 'y'.repeat(65), tmuxSession: 'cloud-C', engine: 'x', active: true, tmux: true },
        ],
      }),
    },
  });
  const body = await (await fetch(`${base}/api/cells`)).json();
  const byId = Object.fromEntries(body.cells.map((c) => [c.cell, c.label]));
  assert.equal(byId.A, 'Ricerca');
  assert.equal(byId.B, 'y'.repeat(64), 'il limite esatto e' + "' ammesso");
  assert.equal(byId.C, '', 'un carattere oltre il limite non passa');
});
