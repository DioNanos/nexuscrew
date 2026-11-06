'use strict';
// 0.9.80 strato 2c, fix R1: il campo promptDelivery/promptMcp attraversa le
// route VERE (GET /api/fleet/status e il percorso federato /federation/route)
// con server reali e ACL reali: la cella in scope porta la tupla, quella fuori
// scope non lascia ne' voce ne' identificatori. Il runtime e' quello vero
// (fleetP del server); nessun tmux reale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { mondoStato, SESSIONE } = require('./helpers/prompt-stato-world.js');
const { registraLancioCorrente, scriviRecordPrompt } = require('../lib/files/activity.js');

const SECRET = 'pairing-secret-token';
const LANCIO_VISIBILE = 'a1b2c3d4e5f60718';
const LANCIO_NASCOSTO = 'fedcba9876543210';

function costruisciFleet(w) {
  const defs = JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));
  defs.cells.push({ ...defs.cells[0], id: 'Nascosta', tmuxSession: 'cloud-Nascosta' });
  atomicWrite(w.defsPath, defs);
  fs.writeFileSync(w.tmuxBin, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('list-sessions')) { process.stdout.write('cloud-Cella\\t1\\ncloud-Nascosta\\t1\\n'); }
process.exit(0);
`, { mode: 0o755 });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: LANCIO_VISIBILE, canale: 'none' });
  registraLancioCorrente(w.filesRoot, 'cloud-Nascosta', { launchId: LANCIO_NASCOSTO, canale: 'none' });
  fs.mkdirSync(w.dirSessione, { recursive: true, mode: 0o700 });
  scriviRecordPrompt(w.dirSessione, { version: 1, event: 'prompt-delivery', launchId: LANCIO_VISIBILE, generation: 4, state: 'submitted', ts: Date.now() });
  const dirN = path.join(w.filesRoot, 'cloud-Nascosta');
  fs.mkdirSync(dirN, { recursive: true, mode: 0o700 });
  scriviRecordPrompt(dirN, { version: 1, event: 'prompt-delivery', launchId: LANCIO_NASCOSTO, generation: 7, state: 'submitted', ts: Date.now() });
  const lease = {
    status: () => ({ state: 'live' }),
    readPromptSnapshot: async (cellId) => (cellId === 'Cella'
      ? { ok: true, launchId: LANCIO_VISIBILE, applicable: true, generation: 4, epoch: 1, leaseId: 'x', mcp: { state: 'degraded', failed: ['alfa'], pending: [] } }
      : { ok: true, launchId: LANCIO_NASCOSTO, applicable: true, generation: 7, epoch: 1, leaseId: 'x', mcp: { state: 'degraded', failed: ['segreto-nascosto'], pending: [] } }),
    promptSnapshotBinding: () => true,
  };
  const rt = w.apri(lease);
  return { available: true, provider: 'builtin', status: () => rt.status({}), rt };
}

function avvia(t, dir, fleet) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir, configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'), tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    protectSharedTmuxServer: false, ...paths, filesRoot: path.join(dir, 'files'), port: 41999,
    fleetP: Promise.resolve(fleet), sessionExistsSeam: () => true,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, ...paths });
  }));
}

test('route reali: GET /api/fleet/status e percorso federato filtrato per scope, senza leak e senza scritture', async (t) => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  t.after(() => fs.rmSync(w.root, { recursive: true, force: true }));
  const fleet = costruisciFleet(w);
  t.after(() => fleet.rt.shutdown());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await avvia(t, dir, fleet);
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  const PEER = 'b'.repeat(32);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'ospite', remotePort: 41999, localPort: 9, nodeId: PEER,
    acceptToken: SECRET, direction: 'inbound', shared: true, visibility: 'network',
  });
  st = nodesStore.setPeerAccessGrants(st, 'ospite', {
    cellVisibility: 'selected', cells: ['Cella'], eventsAccess: false, nodeEventsAccess: false,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(A.nodesPath, st);

  // locale (operatore): entrambe le celle, entrambe con la loro tupla
  const prima = fs.readdirSync(w.root).sort().join(',');
  const loc = await fetch(`${A.base}/api/fleet/status`, { headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(loc.status, 200);
  const locJson = await loc.json();
  const cella = locJson.cells.find((c) => c.cell === 'Cella');
  const nascosta = locJson.cells.find((c) => c.cell === 'Nascosta');
  assert.equal(cella.promptDelivery.launchId, LANCIO_VISIBILE);
  assert.equal(cella.promptDelivery.generation, 4);
  assert.deepEqual(cella.promptMcp, { launchId: LANCIO_VISIBILE, generation: 4, state: 'degraded', failed: ['alfa'], pending: [] });
  assert.equal(nascosta.promptDelivery.launchId, LANCIO_NASCOSTO);

  // federato: stessa composizione, filtro per scope della voce INTERA
  const fed = await fetch(`${A.base}/federation/route/_/fleet/status`, {
    headers: { authorization: `Bearer ${SECRET}`, 'x-nexuscrew-visited': PEER },
  });
  const testo = await fed.text();
  assert.equal(fed.status, 200, testo.slice(0, 300));
  const fedJson = JSON.parse(testo);
  assert.deepEqual(fedJson.cells.map((c) => c.cell), ['Cella']);
  assert.equal(fedJson.cells[0].promptDelivery.launchId, LANCIO_VISIBILE);
  assert.equal(fedJson.cells[0].promptMcp.failed[0], 'alfa');
  for (const nascosto of [LANCIO_NASCOSTO, 'segreto-nascosto', 'Nascosta', '"generation":7']) {
    assert.equal(testo.includes(nascosto), false, `non deve uscire: ${nascosto}`);
  }
  assert.equal(fs.readdirSync(w.root).sort().join(','), prima, 'nessuna scrittura dalla GET');
  void selfA;
});

test('catena reale a DUE server: il proxy federato A inoltra a B, lo scope di B filtra la voce intera, nessun leak', async (t) => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  t.after(() => fs.rmSync(w.root, { recursive: true, force: true }));
  const fleet = costruisciFleet(w);
  t.after(() => fleet.rt.shutdown());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfed2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // B = proprietario della flotta; A = nodo del visitatore (nessuna flotta sua)
  const B = await avvia(t, path.join(root, 'b'), fleet);
  const A = await avvia(t, path.join(root, 'a'), { available: false, provider: 'disabled' });
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  // B accetta A come peer INBOUND con scope limitato alla sola cella 'Cella'
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'a', remotePort: 41999, localPort: A.port, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: true, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessGrants(stB, 'a', {
    cellVisibility: 'selected', cells: ['Cella'], eventsAccess: false, nodeEventsAccess: false,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  // A raggiunge B come peer OUTBOUND (porta locale del tunnel = porta di B)
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'b', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@b',
  });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  const prima = fs.readdirSync(w.root).sort().join(',');
  const r = await fetch(`${A.base}/api/route/b/_/fleet/status`, { headers: { authorization: `Bearer ${A.token}` } });
  const testo = await r.text();
  assert.equal(r.status, 200, testo.slice(0, 300));
  const corpo = JSON.parse(testo);
  assert.deepEqual(corpo.cells.map((c) => c.cell), ['Cella'], 'solo la cella in scope attraversa la catena');
  assert.equal(corpo.cells[0].promptDelivery.launchId, LANCIO_VISIBILE);
  assert.equal(corpo.cells[0].promptDelivery.generation, 4);
  assert.equal(corpo.cells[0].promptMcp.failed[0], 'alfa');
  for (const nascosto of [LANCIO_NASCOSTO, 'segreto-nascosto', 'Nascosta', '"generation":7']) {
    assert.equal(testo.includes(nascosto), false, `non deve uscire dalla catena: ${nascosto}`);
  }
  assert.equal(fs.readdirSync(w.root).sort().join(','), prima, 'nessuna scrittura dalla catena');
  // controllo positivo: con scope «tutte» la stessa catena porta ENTRAMBE le celle
  // (il filtro, non l'assenza di dati, spiega l'esito sopra)
  let stB2 = nodesStore.setPeerAccessGrants(nodesStore.loadStoreStrict(B.nodesPath), 'a', {
    cellVisibility: 'all', cells: [], eventsAccess: false, nodeEventsAccess: false,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(B.nodesPath, stB2);
  const r2 = await fetch(`${A.base}/api/route/b/_/fleet/status`, { headers: { authorization: `Bearer ${A.token}` } });
  const c2 = JSON.parse(await r2.text());
  assert.deepEqual(c2.cells.map((c) => c.cell).sort(), ['Cella', 'Nascosta']);
});
