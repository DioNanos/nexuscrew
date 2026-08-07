'use strict';
// tests/ws-federated-origin.test.js — un attach federato deve DIRE da dove viene.
//
// Il percorso HTTP federato firma sempre l'ultimo hop (routeHandler ->
// proxyHttp con visited + hopProof), cosi' il nodo che possiede la risorsa puo'
// distinguere una richiesta federata da un POST diretto di chi ha il Bearer
// locale. Il percorso WebSocket non lo faceva: sull'ultimo hop passava
// `visited: null` e non calcolava nessuna prova.
//
// Conseguenza, ed e' la ragione per cui questo test esiste PRIMA di qualunque
// filtro sulle celle: `/ws` attacca un PTY per NOME DI SESSIONE, e il nodo
// destinatario non aveva modo di sapere quale peer stesse aprendo quel
// terminale. Nascondere una cella dagli elenchi e lasciare aperto questo canale
// significa costruire un permesso decorativo: basta indovinare `cloud-Dev`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const federation = require('../lib/proxy/federation.js');
const { verifyHop, HOP_HEADER } = require('../lib/proxy/hop-proof.js');
const store = require('../lib/nodes/store.js');

const PEER_ID = 'b'.repeat(32);

// Server finto che sta al posto dell'API locale: accetta la connessione TCP e
// cattura gli header dell'upgrade, senza completare l'handshake.
function captureUpgrade() {
  const seen = { headers: null, requestLine: null };
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n\r\n')) return;
      const [head] = buf.split('\r\n\r\n');
      const lines = head.split('\r\n');
      seen.requestLine = lines[0];
      seen.headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) seen.headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      sock.end();
    });
    sock.on('error', () => {});
  });
  return { srv, seen };
}

function bootStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-origin-'));
  const nodesPath = path.join(dir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'peer-a', remotePort: 41999, localPort: 44999, nodeId: PEER_ID,
    acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network',
  });
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { nodesPath, localNodeId: store.loadStore(nodesPath).nodeId };
}

test('l\'attach federato porta la provenienza fino al nodo che possiede la sessione', async (t) => {
  const { nodesPath, localNodeId } = bootStore(t);
  const { srv, seen } = captureUpgrade();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  const localPort = srv.address().port;

  const hopSecret = Buffer.from('a'.repeat(64), 'hex');
  // Richiesta come la costruisce il peerRouter: ultimo hop, la risorsa e' di
  // questo nodo (route vuota dopo il delimitatore).
  const req = {
    url: '/federation/route/_/ws',
    method: 'GET',
    headers: { host: '127.0.0.1', 'x-nexuscrew-visited': PEER_ID },
  };
  const client = new net.Socket();
  federation.forwardUpgrade({
    req, socket: client, head: null, nodesPath,
    localPort, localCredential: () => 'LOCAL-TOKEN',
    ingress: { nodeId: PEER_ID, visibility: 'network', shared: true },
    hopSecret: () => hopSecret,
  });

  await new Promise((res) => { const t0 = Date.now(); const i = setInterval(() => { if (seen.headers || Date.now() - t0 > 3000) { clearInterval(i); res(); } }, 20); });
  client.destroy();

  assert.ok(seen.headers, 'l\'upgrade non ha raggiunto il server locale');
  // 1) la catena deve arrivare: senza, il destinatario non sa chi ha originato
  const visited = seen.headers['x-nexuscrew-visited'];
  assert.ok(visited, 'x-nexuscrew-visited assente: il nodo non puo\' sapere da chi viene l\'attach');
  const chain = visited.split(',');
  assert.equal(chain[0], PEER_ID, `l'origine deve essere il peer, non ${chain[0]}`);
  assert.equal(chain.at(-1), localNodeId, 'la catena deve terminare su questo nodo');

  // 2) e deve essere PROVATA: un header non firmato lo puo' scrivere chiunque
  //    abbia il Bearer locale, e allora non distingue nulla.
  const proof = seen.headers[HOP_HEADER];
  assert.ok(proof, 'prova di hop assente: la catena da sola non e\' una prova');
  assert.equal(
    verifyHop(hopSecret, { method: 'GET', path: '/ws', visited: chain }, proof),
    true,
    'la prova di hop non verifica su (metodo, path, catena)',
  );
});
