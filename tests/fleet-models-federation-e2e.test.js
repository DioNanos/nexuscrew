'use strict';
// tests/fleet-models-federation-e2e.test.js — DUE server reali: dichiarare un
// modello sul nodo che si sta guardando.
//
// Il test sta qui e non fra gli unit sull'allowlist per una ragione imparata a
// caro prezzo su questa stessa funzione: gli unit per fetta erano tutti verdi
// mentre il giro completo non funzionava. Una riga in piu' in una regex non
// prova che la richiesta attraversi il proxy, arrivi al router fleet del nodo
// remoto e torni indietro — questo lo prova.
//
// L'invariante: cio' che si puo' fare in locale si deve poter fare a distanza,
// e cio' che READONLY toglie resta tolto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const PEER_TOKEN = 'peer-token-abcdefghijklmnopqrstuvwxyz0123456789';

// Registra cio' che il nodo riceve DAVVERO: il punto del test e' che la
// chiamata arrivi fin qui, non che il proxy risponda 200 per conto suo.
function fleetSeam() {
  const seen = { defined: [], removed: [], tested: [] };
  return {
    seen,
    seam: {
      available: true,
      provider: 'builtin',
      isCellSession: () => true,
      capabilities: () => ['status', 'definitions', 'define', 'remove', 'model-test'],
      status: async () => ({ available: true, cells: [] }),
      definitions: () => ({ engines: [], cells: [], models: seen.defined.map((d) => d.def) }),
      defineModel: (def) => { seen.defined.push({ def }); return { ok: true }; },
      removeModel: (id, engine) => { seen.removed.push({ id, engine }); return { ok: true }; },
      testModel: async (engine, model) => {
        seen.tested.push({ engine, model });
        return { engine, model, outcome: 'ok', latencyMs: 7 };
      },
    },
  };
}

async function bootNode(t, { readonlyDefault = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmodels-fed-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { seen, seam } = fleetSeam();
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), port: 0, readonlyDefault, fleetSeam: seam,
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const nodeId = nodesStore.loadStore(paths.nodesPath).nodeId;
  const call = (method, apiPath, body) => fetch(`${base}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { paths, port, base, token, nodeId, call, seen };
}

function link(a, b) {
  let stA = nodesStore.loadStoreStrict(a.paths.nodesPath);
  stA = nodesStore.addNode(stA, {
    name: 'peer-b', ssh: 'user@peer-b', remotePort: 41999, localPort: b.port,
    nodeId: b.nodeId, token: PEER_TOKEN, direction: 'outbound', shared: true, visibility: 'network',
  });
  nodesStore.atomicWriteStore(a.paths.nodesPath, stA);
  let stB = nodesStore.loadStoreStrict(b.paths.nodesPath);
  stB = nodesStore.addNode(stB, {
    name: 'peer-a', remotePort: 41999, localPort: a.port,
    nodeId: a.nodeId, acceptToken: PEER_TOKEN, direction: 'inbound', shared: true, visibility: 'network',
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, stB);
}

async function pair(t, opts = {}) {
  const a = await bootNode(t);
  const b = await bootNode(t, opts);
  link(a, b);
  return { a, b };
}

test('un modello dichiarato dalla route finisce sul nodo REMOTO, non sul proprio', async (t) => {
  const { a, b } = await pair(t);
  const def = { id: 'deepseek-v4-flash:0731', engine: 'claude.ollama-cloud' };
  const res = await a.call('POST', '/api/route/peer-b/_/fleet/define-model', { def });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual(b.seen.defined, [{ def }], 'la dichiarazione deve essere arrivata a B');
  assert.deepEqual(a.seen.defined, [], 'e NON deve essere finita su A');
});

test('la vista del nodo remoto espone i modelli appena dichiarati', async (t) => {
  // Il giro dell'operatore: dichiara, poi lo vede dove lo vedrebbe lui. Il
  // difetto trovato in audit era proprio qui — scritto ma non visibile.
  const { a, b } = await pair(t);
  await a.call('POST', '/api/route/peer-b/_/fleet/define-model', { def: { id: 'qwen3.8-max', engine: 'claude.alibaba-token-plan' } });
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/definitions');
  const defs = await res.json();
  assert.equal(res.status, 200, JSON.stringify(defs));
  assert.deepEqual((defs.models || []).map((m) => m.id), ['qwen3.8-max']);
  assert.equal(b.seen.defined.length, 1);
});

test('la prova interroga l\'API con la credenziale del nodo guardato', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.call('POST', '/api/route/peer-b/_/fleet/model-test', {
    engine: 'claude.alibaba-token-plan', model: 'qwen3.8-max',
  });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.outcome, 'ok');
  assert.deepEqual(b.seen.tested, [{ engine: 'claude.alibaba-token-plan', model: 'qwen3.8-max' }]);
  assert.deepEqual(a.seen.tested, [], 'provare il modello di B sul fleet di A non risponderebbe alla domanda');
});

test('la rimozione dalla route rimuove sul nodo remoto', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.call('POST', '/api/route/peer-b/_/fleet/remove-model', { id: 'm1', engine: 'claude.native' });
  assert.equal(res.status, 200);
  assert.deepEqual(b.seen.removed, [{ id: 'm1', engine: 'claude.native' }]);
});

test('READONLY sul nodo remoto blocca dichiarazione, rimozione E prova', async (t) => {
  // La prova non muta niente, ma fa partire una richiesta autenticata DA quel
  // nodo su comando di un peer: e' esattamente cio' che «sola lettura» toglie.
  const { a, b } = await pair(t, { readonlyDefault: true });
  for (const [azione, corpo] of [
    ['define-model', { def: { id: 'm1', engine: 'claude.native' } }],
    ['remove-model', { id: 'm1', engine: 'claude.native' }],
    ['model-test', { engine: 'claude.native', model: 'm1' }],
  ]) {
    const res = await a.call('POST', `/api/route/peer-b/_/fleet/${azione}`, corpo);
    assert.notEqual(res.status, 200, `${azione} non deve passare su un nodo in sola lettura`);
  }
  assert.deepEqual(b.seen.defined, []);
  assert.deepEqual(b.seen.removed, []);
  assert.deepEqual(b.seen.tested, [], 'nessuna richiesta autenticata deve essere partita dal nodo in sola lettura');
});

test('federare la risorsa non federa ogni verbo', async (t) => {
  const { a } = await pair(t);
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/model-test');
  assert.notEqual(res.status, 200);
});
