'use strict';
// tests/panel-remote-origin.test.js — P0 sicurezza, meta' remota, IL PUNTO 4:
// un nodo gia' accoppiato CHE NON HA la coppia pannello continua a funzionare
// esattamente come prima.
//
// Lo stato vecchio non si costruisce aggiungendo il campo e togliendolo: si
// scrive su disco un nodes.json come lo scrive un binary di prima della
// coppia panel (JSON crudo, mai passato per il codice nuovo), e da li' si
// ripercorre ogni strada che la nuova feature tocca: load dello store, /api
// /nodes, /api/config (la mappa che il frontend usa per scegliere l'origin
// separata), e il builder del tunnel. Nessuna di queste deve trattare il nodo
// come rotto — via storica, come oggi.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');
const tunnel = require('../lib/nodes/tunnel.js');

const TOKEN = 'remote-origin-guard';

function chiudi(srv) {
  srv.closeAllConnections?.();
  return new Promise((r) => srv.close(r));
}

// Il record di un pairing riuscito com'era PRIMA della coppia panel: v2, con
// token/acceptToken/reversePort negoziati, nessun campo panel. Scritto con
// fs.writeFileSync di proposito: passarlo per lo store nuovo scriverebbe con
// la matita di oggi, e il punto e' leggere la carta di ieri.
function scriviStoreVecchio(dir) {
  const nodesPath = path.join(dir, '.nexuscrew', 'nodes.json');
  fs.writeFileSync(nodesPath, JSON.stringify({
    schemaVersion: 2,
    nodeId: 'a'.repeat(32),
    nodes: [{
      name: 'vps', ssh: 'user@hub.example.com', sshPort: 22,
      remotePort: 41777, localPort: 43001,
      roles: { client: true, node: false }, rolesKnown: true,
      direction: 'outbound', transport: 'auto', autostart: true,
      shared: false, panelAccess: false, liveHostAccess: false,
      visibility: 'network', label: 'Hub',
      token: 'VECCHIO-REMOTE-SECRET-123', acceptToken: 'VECCHIO-ACCEPT-SECRET-1',
      nodeId: 'b'.repeat(32), reversePort: 44001,
    }],
  }, null, 2));
  return nodesPath;
}

// Un store di DOMANI: stessa installazione dopo che il peer ha annunciato la
// sua porta pannello e il pairing ha negoziato la coppia.
function scriviStoreNuovo(dir) {
  const nodesPath = path.join(dir, '.nexuscrew', 'nodes.json');
  fs.writeFileSync(nodesPath, JSON.stringify({
    schemaVersion: 2,
    nodeId: 'a'.repeat(32),
    nodes: [{
      name: 'vps', ssh: 'user@hub.example.com', sshPort: 22,
      remotePort: 41777, localPort: 43001,
      panelLocalPort: 43101, panelRemotePort: 41821,
      roles: { client: true, node: false }, rolesKnown: true,
      direction: 'outbound', transport: 'auto', autostart: true,
      shared: false, panelAccess: false, liveHostAccess: false,
      visibility: 'network', label: 'Hub',
      token: 'NUOVO-REMOTE-SECRET-123', acceptToken: 'NUOVO-ACCEPT-SECRET-1',
      nodeId: 'b'.repeat(32), reversePort: 44001,
    }],
  }, null, 2));
  return nodesPath;
}

async function serverConStore(nodesPath, dir) {
  const configDir = path.join(dir, '.nexuscrew');
  const made = createServer({
    home: dir, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'),
    bind: '127.0.0.1', port: 0, panelPort: 0, fleetEnabled: false, autoUpdate: false,
    fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
  });
  await new Promise((resolve, reject) => { made.server.once('error', reject); made.server.listen(0, '127.0.0.1', resolve); });
  return made;
}

test('PUNTO 4: stato nodi vecchio (0.9.0, nessuna coppia panel) — nessun percorso lo tratta come rotto', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const nodesPath = scriviStoreVecchio(dir);

  // 1. Lo store carica com'e': strict, nessuna migrazione forzata.
  const st = store.loadStore(nodesPath);
  assert.ok(st, 'un nodes.json di ieri carica senza errori');
  const nodo = st.nodes.find((n) => n.name === 'vps');
  assert.ok(nodo, 'il nodo accoppiato c\'e\'');
  assert.equal(nodo.panelLocalPort, undefined, 'e la coppia panel non c\'e: non si inventa');
  assert.equal(nodo.panelRemotePort, undefined);

  // 2. Il builder del tunnel resta quello di sempre: UN -L. Nessun forward
  //    pannello, nessun errore per l'assenza del campo.
  const args = tunnel.buildForwardArgs(nodo);
  const fw = args.filter((a, i) => args[i - 1] === '-L');
  assert.deepEqual(fw, ['127.0.0.1:43001:127.0.0.1:41777'],
    'il tunnel di un nodo vecchio non cambia di una virgola');

  // 3. Il server vivo serve /api/nodes senza errori, e il nodo appare senza
  //    campi panel.
  const made = await serverConStore(nodesPath, dir);
  t.after(() => chiudi(made.server));
  const rNodes = await fetch(`http://127.0.0.1:${made.server.address().port}/api/nodes`, {
    headers: { authorization: `Bearer ${made.token}` },
  });
  assert.equal(rNodes.status, 200, '/api/nodes risponde, il nodo vecchio non rompe la vista');
  const jNodes = await rNodes.json();
  const visto = (jNodes.nodes || []).find((n) => n.name === 'vps');
  assert.ok(visto, 'il nodo vecchio e\' in lista');
  assert.equal(visto.panelLocalPort, undefined, 'nessuna coppia panel nella vista redatta');

  // 4. La mappa per il frontend NON contiene il nodo vecchio: CellPanel riceve
  //    0 e resta sulla via storica — che e\' esattamente il pannello federato
  //    che oggi funziona.
  const rCfg = await fetch(`http://127.0.0.1:${made.server.address().port}/api/config`, {
    headers: { authorization: `Bearer ${made.token}` },
  });
  assert.equal(rCfg.status, 200);
  const jCfg = await rCfg.json();
  const mappa = jCfg.nodePanelPorts || {};
  assert.equal(mappa.vps, undefined, 'il nodo senza porta pannello negoziata non compare nella mappa');
});

test('stato nodi nuovo: la coppia panel arriva al frontend via /api/config', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const nodesPath = scriviStoreNuovo(dir);

  const made = await serverConStore(nodesPath, dir);
  t.after(() => chiudi(made.server));
  const r = await fetch(`http://127.0.0.1:${made.server.address().port}/api/config`, {
    headers: { authorization: `Bearer ${made.token}` },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.nodePanelPorts, { vps: 43101 },
    'il frontend scopre la porta inoltrata del pannello per nome nodo');

  // E /api/nodes la mostra nel record: stessa fonte, due consumatori.
  const rNodes = await fetch(`http://127.0.0.1:${made.server.address().port}/api/nodes`, {
    headers: { authorization: `Bearer ${made.token}` },
  });
  const visto = ((await rNodes.json()).nodes || []).find((n) => n.name === 'vps');
  assert.equal(visto.panelLocalPort, 43101);
  assert.equal(visto.panelRemotePort, 41821);
});
