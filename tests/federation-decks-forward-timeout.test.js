'use strict';
// tests/federation-decks-forward-timeout.test.js — il forward federato
// delle GET (decks, fleet/status, sessions…) deve degradare IN TEMPO quando il
// tunnel del peer è «su a metà» (connessione accettata, nessuna risposta):
// 504 entro il timeout configurato, non un 502 dopo 30 s o una GET pendente.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const fed = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');

const PEER_NODE_ID = 'd'.repeat(32);

function tokenStoreWithMutePeer(mutePort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-decks-timeout-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('c'.repeat(32));
  st = store.addNode(st, {
    name: 'hub', direction: 'outbound', remotePort: 2222, localPort: mutePort,
    ssh: 'user@hub', token: 'b'.repeat(32), shared: true,
  });
  const hub = (Array.isArray(st.nodes) ? st.nodes : Object.values(st.nodes || {}))
    .find((n) => n && n.name === 'hub');
  hub.visibility = 'network';            // canTransit: visibilità di rete
  hub.selected = [PEER_NODE_ID];         // canTransit: peerAllows bidirezionale
  store.atomicWriteStore(nodesPath, st);
  return { dir, nodesPath };
}

const INGRESS = {
  nodeId: PEER_NODE_ID, cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true,
  askReplyAccess: false, filesReadAccess: true, liveHostAccess: false, panelAccess: false,
  peerOperatorAccess: true, visibility: 'network',
};

test('GET /decks verso un peer muta → 504 federation-peer-timeout entro il timeout', async (t) => {
  // Server MUTA: accetta la connessione e non risponde mai (tunnel «su a metà»).
  const mute = http.createServer(() => {});
  await new Promise((resolve) => mute.listen(0, '127.0.0.1', resolve));
  t.after(() => mute.close());
  const { dir, nodesPath } = tokenStoreWithMutePeer(mute.address().port);
  const app = express();
  app.use('/api/route', (req, res) => fed.routeHandler({
    nodesPath, localPort: mute.address().port, localCredential: () => 'owner-local-token',
    ingress: INGRESS, readonly: () => false, hopSecret: () => 'owner-hop-secret',
    forwardGetTimeoutMs: 400,
  })(req, res));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const t0 = Date.now();
  const res = await fetch(`${base}/api/route/hub/_/decks`, {
    headers: { 'x-nexuscrew-visited': PEER_NODE_ID },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 504, `atteso 504, arrivato ${res.status} body=${JSON.stringify(await res.clone().json().catch(() => null))}`);
  const body = await res.json();
  assert.equal(body.reason, 'federation-peer-timeout');
  assert.ok(elapsed >= 300 && elapsed < 5000, `timeout: ${elapsed} ms (atteso ~400 ms)`);
  await new Promise((r) => setTimeout(r, 20)); // niente crash asincrono dopo la risposta
});
