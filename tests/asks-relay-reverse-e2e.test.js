'use strict';
// tests/asks-relay-reverse-e2e.test.js — e2e con DUE istanze NC locali reali.
//
// Topologia: A = hub (dove l'operatore risponde), B = peer che si collega a A
// (record INBOUND su A, condiviso, con slot reverse che punta alla porta reale
// del server B). Nessun nodo vero: due server locali su 127.0.0.1.
//
// Cosa prova: (1) un ask aperto sul peer B e' rispondibile dall'hub solo se il
// canale reverse e' VERIFICATO; senza listener reverse su B la preflight
// fallisce e la risposta e' un RIFIUTO NETTO (404 reverse-slot-unverified),
// mai un esito incerto, e nessun attempt resta registrato (mai reinvio cieco).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const SECRET = 'tok-' + '7'.repeat(24);

function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskrev-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    sessionExistsSeam: () => true,
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4194999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, ...paths });
  }));
}

const H = (tok) => ({ 'content-type': 'application/json', authorization: `Bearer ${tok}` });

test('e2e: hub+peer inbound — risposta con canale reverse non verificato = rifiuto netto, ask intatto', async (t) => {
  const A = await boot(t);   // hub: qui risponde l'operatore
  const B = await boot(t);   // peer: qui vive la domanda
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  // A registra B come peer INBOUND condiviso, con consenso eventi+risposta e
  // slot reverse che punta alla porta reale del server B (tunnel finto).
  const entry = {
    name: 'peer', remotePort: 41999, localPort: B.port, nodeId: selfB,
    acceptToken: SECRET, direction: 'inbound', shared: true, visibility: 'network',
  };
  console.log('DBG-ENTRY:', JSON.stringify(entry));
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), entry);
  stA = nodesStore.setPeerAccessPreset(stA, 'peer', 'admin');
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  // Domanda aperta sul PEER B (creata da B stesso).
  const created = await fetch(`${B.base}/api/asks`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({
      question: 'procedo?', options: ['si', 'no'],
      session: tmuxSessionForCell('dev-peer'),
    }),
  });
  assert.equal(created.status, 201);
  const { id: ownerAskId } = await created.json();
  // La risposta dall'hub: il canale reverse non e' verificato (B non espone il
  // listener) -> RIFIUTO NETTO, mai esito incerto.
  const relay = await fetch(`${A.base}/api/asks-relay`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ ownerId: selfB, askId: ownerAskId, text: 'risposta dal hub' }),
  });
  assert.equal(relay.status, 404);
  const body = await relay.json();
  assert.equal(body.reason, 'reverse-slot-unverified');
  // Mai esito incerto: l'operatore non vede una «verifica» impossibile.
  assert.notStrictEqual(body.uncertain, true);
  // La domanda resta aperta e intatta sul peer.
  const open = await fetch(`${B.base}/api/asks?open=1`, { headers: H(B.token) })
    .then(async (r) => (await r.json()).asks);
  assert.equal(open.length, 1);
  // Nessun attempt registrato per un rifiuto netto: niente reinvio cieco.
  const st = await fetch(`${A.base}/api/asks-relay/state`, { headers: H(A.token) })
    .then(async (r) => r.json());
  assert.equal((st.attempts || []).length, 0);
});
