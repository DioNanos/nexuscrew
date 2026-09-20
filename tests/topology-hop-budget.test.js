'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const store = require('../lib/nodes/store.js');
const fed = require('../lib/proxy/federation.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((resolve) => s.close(resolve));
const id = (ch) => ch.repeat(32);

// Hub con un figlio 'relay' (outbound, condiviso) e un peer 'caller' che
// interroga da remoto. Il figlio risponde con un nodo transitive 'leaf'.
function hubStore(dir, hubId, relayId, callerName = 'caller') {
  const nodesPath = path.join(dir, 'hub-nodes.json');
  let st = store.emptyStore(hubId);
  st = store.addNode(st, {
    name: 'relay', remotePort: 41830, localPort: 45901, ssh: 'relay@127.0.0.1',
    direction: 'outbound', transport: 'ssh', autostart: true, shared: true,
    visibility: 'network', nodeId: relayId, token: 'hub-to-relay', acceptToken: 'relay-to-hub',
  });
  st = store.addNode(st, {
    name: callerName, remotePort: 41831, localPort: 45902, ssh: 'caller@127.0.0.1',
    direction: 'inbound', transport: 'inbound', autostart: true, shared: true,
    visibility: 'network', nodeId: id('c'), token: 'hub-to-caller', acceptToken: 'caller-token',
  });
  store.atomicWriteStore(nodesPath, st);
  return nodesPath;
}

const leafBodyFor = (relayId, leafName = 'leaf') => ({
  instanceId: relayId,
  nodes: [{ instanceId: id('d'), name: leafName, route: [leafName], label: 'Leaf' }],
});

const mkDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('topologia federata: figlio lento oltre il budget per hop non blocca la risposta, il ramo e\' servito stale dallo snapshot', async () => {
  const relayId = id('b');
  const nodesPath = hubStore(mkDir('nc-topo-slow-'), id('a'), relayId);
  const ingress = { name: 'caller', nodeId: id('c'), visibility: 'network' };
  const fast = async () => ({ ok: true, json: async () => leafBodyFor(relayId) });
  // warm-up: una risposta rapida registra lo snapshot per-figlio in memoria.
  const warm = await fed.collectTopologyDetailed({ nodesPath, ingress, fetchImpl: fast, timeoutMs: 1500 });
  assert.ok(warm.nodes.some((n) => n.name === 'leaf' && n.stale !== true), 'warm-up con ramo vivo');
  // il figlio ora risponde dopo 1400 ms: con budget chiamante 1500 l'hub non puo'
  // aspettarlo (margine 500): abort interno a ~1000 ms e ramo servito stale.
  const slow = async () => { await sleep(1400); return { ok: true, json: async () => leafBodyFor(relayId) }; };
  const t0 = Date.now();
  const out = await fed.collectTopologyDetailed({ nodesPath, ingress, fetchImpl: slow, timeoutMs: 1500 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1250, `l'hub ha aspettato il figlio lento: ${elapsed} ms`);
  assert.ok(elapsed >= 900, `tempo anomalo (attesa mancante?): ${elapsed} ms`);
  const leaf = out.nodes.find((n) => n.name === 'leaf');
  assert.ok(leaf, 'il ramo transitive non sparisce dalla risposta al peer');
  assert.equal(leaf.stale, true);
  assert.ok(Number.isFinite(leaf.lastSeen), 'stale con lastSeen dello snapshot');
  const relay = out.nodes.find((n) => n.name === 'relay');
  assert.ok(relay && relay.direct === true && !relay.stale, 'il diretto resta vivo e non stale');
});

test('topologia federata: figlio veloce, nessuna regressione (nessuno stale)', async () => {
  const relayId = id('2');
  const nodesPath = hubStore(mkDir('nc-topo-fast-'), id('1'), relayId);
  const ingress = { name: 'caller', nodeId: id('c'), visibility: 'network' };
  const out = await fed.collectTopologyDetailed({
    nodesPath, ingress,
    fetchImpl: async () => ({ ok: true, json: async () => leafBodyFor(relayId) }),
    timeoutMs: 1500,
  });
  const leaf = out.nodes.find((n) => n.name === 'leaf');
  assert.ok(leaf, 'ramo transitive presente');
  assert.notEqual(leaf.stale, true, 'il ramo fresco non e\' stale');
  assert.ok(out.authoritative.includes('relay'), 'il figlio resta authoritative');
});

test('budget per hop: il budget del chiamante viaggia nella richiesta verso i figli', async () => {
  const relayId = id('3');
  const nodesPath = hubStore(mkDir('nc-topo-budget-'), id('4'), relayId);
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(String(u));
    return { ok: true, json: async () => leafBodyFor(relayId) };
  };
  const ingress = { name: 'caller', nodeId: id('c'), visibility: 'network' };
  await fed.collectTopologyDetailed({ nodesPath, ingress, fetchImpl, timeoutMs: 1500 });
  assert.ok(urls.some((u) => u.includes('budget=1000')), 'richiesta da peer: fan-out a budget ridotto (1500-500)');
  urls.length = 0;
  await fed.collectTopologyDetailed({ nodesPath, ingress: null, fetchImpl, timeoutMs: 1500 });
  assert.ok(urls.some((u) => u.includes('budget=1500')), 'raccolta locale: budget pieno');
});

test('peer endpoint /federation/topology: risponde entro il budget del chiamante includendo i rami stale', async (t) => {
  const relayId = id('5');
  const dir = mkDir('nc-topo-http-');
  const nodesPath = hubStore(dir, id('6'), relayId);
  // warm-up nello stesso processo: la cache per-figlio e' memoria del modulo.
  await fed.collectTopologyDetailed({
    nodesPath, ingress: { name: 'caller', nodeId: id('c'), visibility: 'network' },
    fetchImpl: async () => ({ ok: true, json: async () => leafBodyFor(relayId) }),
    timeoutMs: 1500,
  });
  const app = express();
  app.use('/federation', fed.peerRouter({
    nodesPath, localPort: 1, localCredential: () => 'hub-main',
    fetchImpl: async () => { await sleep(1400); return { ok: true, json: async () => leafBodyFor(relayId) }; },
  }));
  const server = await listen(app);
  t.after(async () => { await close(server); fs.rmSync(dir, { recursive: true, force: true }); });
  const t0 = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/federation/topology?ttl=4&budget=1500`,
    { headers: { authorization: 'Bearer caller-token' } },
  );
  const elapsed = Date.now() - t0;
  assert.equal(response.status, 200);
  // La prova del budget per hop qui e' SEMANTICA, non di wall-clock (sotto
  // carico il tempo assoluto ondeggia): il figlio risponde solo dopo 1400 ms,
  // quindi un ramo presente PUO' arrivare solo dallo snapshot con budget
  // ~1000. Il timing stretto e' misurato dal test diretto sopra.
  assert.ok(elapsed < 1400, `l'endpoint ha aspettato il figlio lento oltre il suo tempo: ${elapsed} ms`);
  const body = await response.json();
  const leaf = body.nodes.find((n) => n.name === 'leaf');
  assert.ok(leaf, 'il peer riceve anche il transitive stale');
  assert.equal(leaf.stale, true);
});

test('topologyOwners include gli owner stale con route e lastSeen (non filtrati)', () => {
  const { topologyOwners } = require('../lib/mcp/cells.js');
  const staleId = id('7');
  const freshId = id('8');
  const owners = topologyOwners({ nodes: [
    { instanceId: staleId, route: ['relay'], name: 'relay', stale: true, lastSeen: 1234567890 },
    { instanceId: freshId, route: ['relay', 'leaf'], name: 'leaf' },
  ] });
  const staleOwner = owners.find((o) => o.instanceId === staleId);
  assert.ok(staleOwner, 'lo owner stale resta in lista');
  assert.equal(staleOwner.stale, true);
  assert.equal(staleOwner.lastSeen, 1234567890);
  assert.deepEqual(staleOwner.route, ['relay']);
  const fresh = owners.find((o) => o.instanceId === freshId);
  assert.equal(fresh.stale, false);
});

test('nc_deck: un owner stale con route viva resta una sorgente interrogabile (non filtrato)', async () => {
  const { TOOLS } = require('../lib/mcp/tools.js');
  const localId = id('9');
  const staleId = id('a');
  const interrogati = [];
  const ctx = {
    identity: async () => ({ session: 'cloud-Dev', code: 'OK' }),
    api: async (method, p) => {
      if (p === '/api/config') return { instanceId: localId };
      if (p === '/api/topology') return { nodes: [
        { instanceId: staleId, route: ['relay'], name: 'relay', label: 'Relay', stale: true, lastSeen: 1234567890 },
      ] };
      if (p === '/api/decks') return { decks: [] };
      interrogati.push(p);
      if (p === '/api/route/relay/_/decks') return { decks: [{ name: 'federated', revision: 3, layout: { columns: [] } }] };
      if (p === '/api/route/relay/_/topology') return { nodes: [] };
      throw new Error('inatteso: ' + p);
    },
  };
  const tool = TOOLS.find((entry) => entry.name === 'nc_deck');
  const result = await tool.handler({}, ctx);
  assert.ok(interrogati.some((p) => p === '/api/route/relay/_/decks'), 'lo owner stale viene interrogato con la sua route');
  // il deck remoto entra fra le sorgenti; senza membri locali resta solo la
  // verifica che la sorgente sia stata raggiunta senza essere filtrata.
  assert.ok(Array.isArray(result.decks));
});

// A1: lo stato stale/lastSeen calcolato da un salto precedente deve attraversare
// TUTTI i salti successivi — altrimenti chi guarda in fondo alla catena vede
// "vivo" un ramo che il suo hub sa essere stale.
test('A1: stale/lastSeen del salto precedente si propaga nella raccolta del chiamante', async () => {
  const relayId = id('9');
  const nodesPath = hubStore(mkDir('nc-topo-prop-'), id('8'), relayId);
  const out = await fed.collectTopologyDetailed({
    nodesPath, ingress: { name: 'caller', nodeId: id('c'), visibility: 'network' },
    fetchImpl: async () => ({ ok: true, json: async () => ({
      instanceId: relayId,
      nodes: [
        { instanceId: id('d'), name: 'leaf', route: ['leaf'], label: 'Leaf', stale: true, lastSeen: 1234567890 },
        { instanceId: id('e'), name: 'live', route: ['live'], label: 'Live' },
        { instanceId: id('f'), name: 'malformato', route: ['malformato'], label: 'Bad', stale: true, lastSeen: 'x' },
      ],
    }) }),
    timeoutMs: 1500,
  });
  const leaf = out.nodes.find((n) => n.name === 'leaf');
  assert.equal(leaf.stale, true, 'il flag stale del figlio sopravvive alla validazione');
  assert.equal(leaf.lastSeen, 1234567890, 'il lastSeen originale viaggia intatto');
  const live = out.nodes.find((n) => n.name === 'live');
  assert.notEqual(live.stale, true, 'il nodo fresco resta fresco');
  const bad = out.nodes.find((n) => n.name === 'malformato');
  assert.equal(bad.stale, true);
  assert.equal(bad.lastSeen, undefined, 'lastSeen malformato scartato, flag stale conservato');
});

test('A1: un nodo arrivato gia\' stale resta stale anche nella raccolta locale (collectLocalTopology)', async () => {
  const relayId = id('a');
  const dir = mkDir('nc-topo-prop-local-');
  const nodesPath = hubStore(dir, id('7'), relayId);
  const out = await fed.collectLocalTopology({
    nodesPath, cachePath: path.join(dir, 'topology-cache.json'),
    fetchImpl: async () => ({ ok: true, json: async () => ({
      instanceId: relayId,
      nodes: [
        { instanceId: id('d'), name: 'leaf', route: ['leaf'], label: 'Leaf', stale: true, lastSeen: 1234567890 },
        { instanceId: id('e'), name: 'live', route: ['live'], label: 'Live' },
      ],
    }) }),
    now: 777,
  });
  const leaf = out.nodes.find((n) => n.name === 'leaf');
  assert.equal(leaf.stale, true, 'il nodo arrivato stale dal peer RESTA stale');
  assert.equal(leaf.lastSeen, 1234567890, 'lastSeen originale conservato, non sovrascritto con now');
  const live = out.nodes.find((n) => n.name === 'live');
  assert.equal(live.stale, false, 'il nodo visto direttamente vivo e\' stale:false');
  assert.equal(live.lastSeen, 777);
  // la cache su disco conserva il lastSeen originale per gli stale
  const cache = require('../lib/nodes/topology-cache.js').loadCache(path.join(dir, 'topology-cache.json'));
  const cachedLeaf = cache.nodes.find((x) => x.name === 'leaf');
  assert.equal(cachedLeaf.lastSeen, 1234567890, 'la cache non riscrive il lastSeen degli stale');
  fs.rmSync(dir, { recursive: true, force: true });
});
