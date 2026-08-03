'use strict';
// tests/share-not-ready.test.js — Share ON subito dopo un pairing.
// Il reverse channel viene stabilito un istante prima di essere annunciato:
// finche' il bind non e' pronto l'hub non puo' accettare, ma quella condizione
// e' TEMPORANEA e va distinta da un guasto definitivo. L'hub la dichiara con un
// codice tipizzato; il peer la ritenta in modo limitato invece di far cadere
// l'intera transazione e lasciare Share spento finche' l'operatore non riprova.
// Nessun processo o SSH reale: fetch e spawn sono seam.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');
const fed = require('../lib/proxy/federation.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const listen = (app) => new Promise((resolve) => {
  const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s));
});
const close = (s) => new Promise((resolve) => s.close(resolve));

// --- lato hub: la risposta deve essere ritentabile e riconoscibile ----------

test('hub: un canale share non ancora pronto risponde 409 con un codice tipizzato', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-nr-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, {
    name: 'pixel', remotePort: 41820, localPort: 44003,
    direction: 'inbound', transport: 'inbound', autostart: true, shared: false,
    visibility: 'network', nodeId: 'b'.repeat(32), token: 'hub-to-pixel', acceptToken: 'pixel-to-hub',
  });
  store.atomicWriteStore(nodesPath, st);
  let probes = 0;
  const app = express();
  app.use('/federation', fed.peerRouter({
    nodesPath, localPort: 1, localCredential: () => 'hub-main',
    // Il peer non e' ancora raggiungibile: nessun probe diventa healthy.
    fetchImpl: async () => { probes += 1; return { ok: false, status: 503, json: async () => ({}) }; },
  }));
  const hub = await listen(app);
  t.after(async () => { await close(hub); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await fetch(`http://127.0.0.1:${hub.address().port}/federation/share`, {
    method: 'POST', headers: H('pixel-to-hub'), body: JSON.stringify({ shared: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.code, fed.SHARE_NOT_READY_CODE);
  // La finestra e' limitata: si attende, non si martella all'infinito.
  assert.ok(probes > 1 && probes <= 12, `probe attesi fra 2 e 12, visti ${probes}`);
  // Lo stato non cambia finche' il canale non e' verificato.
  assert.equal(store.getNode(store.loadStoreStrict(nodesPath), 'pixel').shared, false);
});

// --- propagazione del codice ------------------------------------------------

test('notifyHubShare: il codice tipizzato dell\'hub arriva a chi chiama, il corpo remoto no', async () => {
  const node = { localPort: 44003, token: 't'.repeat(48) };
  const withBody = async () => ({
    ok: false, status: 409,
    json: async () => ({ error: 'canale share non raggiungibile', code: fed.SHARE_NOT_READY_CODE, detail: 'Bearer segreto' }),
  });
  await assert.rejects(
    () => fed.notifyHubShare({ node, shared: true, fetchImpl: withBody }),
    (e) => {
      assert.equal(e.code, fed.SHARE_NOT_READY_CODE);
      assert.equal(e.status, 409);
      assert.ok(!/segreto/i.test(String(e.message)), 'il corpo remoto non entra nel messaggio');
      return true;
    },
  );
});

test('notifyHubShare: un corpo non-JSON lascia l\'errore definitivo, che e\' il default sicuro', async () => {
  const node = { localPort: 44003, token: 't'.repeat(48) };
  const noJson = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
  await assert.rejects(
    () => fed.notifyHubShare({ node, shared: true, fetchImpl: noJson }),
    (e) => { assert.equal(e.code, undefined); return true; },
  );
});

// --- lato peer: ritentativo limitato invece di rollback immediato ------------

function bootPeer(t, seams = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-peer-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  store.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), fleetEnabled: false,
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
      stopTunnelImpl: () => ({ stopped: true }),
      startForwardImpl: () => ({ started: false, reason: 'already running', pid: 4242 }),
      // Le attese diventano istantanee: si verifica la POLITICA di ritentativo,
      // non la durata reale.
      pairDelay: async () => {},
      ...seams,
    },
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    resolve({ base: `http://127.0.0.1:${server.address().port}`, token, ...paths });
  }));
}

// fetch del peer verso l'hub: health sempre sana, /federation/share fallisce le
// prime `failures` volte con il codice indicato, poi accetta.
function hubFetch(instanceId, failures, code) {
  const calls = { share: 0 };
  const fn = async (url, opts = {}) => {
    const target = String(url);
    if (target.endsWith('/federation/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, instanceId }) };
    }
    if (target.endsWith('/federation/share')) {
      calls.share += 1;
      if (calls.share <= failures) {
        return { ok: false, status: 409, json: async () => ({ error: 'canale share non raggiungibile', ...(code ? { code } : {}) }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

async function peerWithHub(t, fetchImpl) {
  const instanceId = 'a'.repeat(32);
  const ctx = await bootPeer(t, { fetchImpl });
  await fetch(`${ctx.base}/api/settings/nodes`, {
    method: 'POST', headers: H(ctx.token), body: JSON.stringify({ name: 'hub', ssh: 'user@hub' }),
  });
  let st = store.loadStoreStrict(ctx.nodesPath);
  st = store.updateNode(st, 'hub', {
    direction: 'outbound', shared: false,
    localPort: 43001, remotePort: 41820, reversePort: 44001,
    token: 't'.repeat(48), nodeId: instanceId,
  });
  store.atomicWriteStore(ctx.nodesPath, st);
  return ctx;
}

const shareOn = (base, token) => fetch(`${base}/api/settings/nodes/hub/share`, {
  method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
});

test('peer: un canale non ancora pronto viene atteso, non fatto fallire', async (t) => {
  const fetchImpl = hubFetch('a'.repeat(32), 2, fed.SHARE_NOT_READY_CODE);
  const ctx = await peerWithHub(t, fetchImpl);
  const res = await shareOn(ctx.base, ctx.token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'hub', shared: true });
  assert.equal(fetchImpl.calls.share, 3, 'due attese e poi l\'accettazione');
  assert.equal(store.getNode(store.loadStoreStrict(ctx.nodesPath), 'hub').shared, true);
});

test('peer: un errore senza quel codice resta definitivo e non viene ritentato', async (t) => {
  const fetchImpl = hubFetch('a'.repeat(32), 2, null); // 409 generico, nessun codice
  const ctx = await peerWithHub(t, fetchImpl);
  const res = await shareOn(ctx.base, ctx.token);
  assert.notEqual(res.status, 200);
  assert.equal(fetchImpl.calls.share, 1, 'nessun ritentativo su un errore definitivo');
  // Rollback allo stato privato sicuro.
  assert.equal(store.getNode(store.loadStoreStrict(ctx.nodesPath), 'hub').shared, false);
});

test('peer: il ritentativo e\' limitato e alla fine si arrende', async (t) => {
  const fetchImpl = hubFetch('a'.repeat(32), 99, fed.SHARE_NOT_READY_CODE);
  const ctx = await peerWithHub(t, fetchImpl);
  const res = await shareOn(ctx.base, ctx.token);
  assert.notEqual(res.status, 200);
  assert.ok(fetchImpl.calls.share > 1 && fetchImpl.calls.share <= 5,
    `tentativi attesi fra 2 e 5, visti ${fetchImpl.calls.share}`);
  assert.equal(store.getNode(store.loadStoreStrict(ctx.nodesPath), 'hub').shared, false);
});
