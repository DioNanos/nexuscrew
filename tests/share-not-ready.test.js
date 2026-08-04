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
const { settingsRoutes } = require('../lib/settings/routes.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const listen = (app) => new Promise((resolve) => {
  const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s));
});
const close = (s) => new Promise((resolve) => s.close(resolve));

// Upgrade WS grezzo: restituisce la risposta cruda, senza completare
// l'handshake. Un upgrade rifiutato chiude il socket senza rispondere, quindi
// `close`/`error` sono esiti attesi.
function rawUpgradeWithHeaders(port, target, headers = {}) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write([
        `GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==', 'Sec-WebSocket-Version: 13',
        'Connection: Upgrade', 'Upgrade: websocket', '', '',
      ].join('\r\n'));
    });
    let buf = ''; let settled = false;
    const done = () => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) {} resolve(buf); };
    sock.on('data', (c) => { buf += c.toString('latin1'); if (buf.includes('\r\n\r\n')) done(); });
    sock.on('close', done); sock.on('error', done);
    sock.setTimeout(4000, done);
  });
}

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
    // Canale non ancora salito: la connessione viene rifiutata, che e' il
    // transport 'down' vero. Un 503 sarebbe un peer che risponde, cioe' un
    // guasto diverso e NON ritentabile.
    fetchImpl: async () => { probes += 1; throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
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

// --- classificazione: ritentabile solo cio' che e' transitorio --------------
// Appiattire ogni esito non healthy in "non ancora pronto" farebbe ritentare
// anche una credenziale non valida o un nodo sbagliato in fondo al tunnel:
// il tempo non li ripara e il ritentativo nasconde la causa vera.

test('classifyShareFailure: solo il canale non ancora salito e\' ritentabile', () => {
  const cases = [
    // Transitori: il canale non e' ancora su, o non si e' riusciti a OTTENERE
    // la prova, o il peer risponde con un errore server.
    [{ transport: 'down', status: 'down', detail: 'peer non raggiungibile' }, fed.SHARE_NOT_READY_CODE],
    [{ status: 'degraded', slotProof: true, code: 'reverse-slot-proof-unavailable' }, fed.SHARE_NOT_READY_CODE],
    [{ transport: 'up', auth: 'ok', reachability: 'failed', httpStatus: 503 }, fed.SHARE_NOT_READY_CODE],
    // Definitivi: il tempo non li ripara.
    [{ transport: 'up', auth: 'failed', status: 'degraded' }, 'share-peer-unauthorized'],
    [{ status: 'degraded', slotProof: true, code: 'slot-mac-mismatch' }, 'share-slot-proof-failed'],
    [{ transport: 'up', auth: 'ok', reachability: 'failed', httpStatus: 200 }, 'share-peer-mismatch'],
    [{ transport: 'up', auth: 'ok', reachability: 'ok', status: 'degraded' }, 'share-peer-unreachable'],
  ];
  for (const [health, expected] of cases) {
    assert.equal(fed.classifyShareFailure(health).code, expected, JSON.stringify(health));
  }
  // La prova NON ottenuta e la prova SBAGLIATA non devono finire nello stesso
  // codice: la prima si attende, la seconda no.
  assert.notEqual(
    fed.classifyShareFailure({ slotProof: true, code: 'reverse-slot-proof-unavailable' }).code,
    fed.classifyShareFailure({ slotProof: true, code: 'slot-mac-mismatch' }).code,
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

async function peerWithHub(t, fetchImpl, extraNode = {}) {
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
    ...extraNode,
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

test('peer: una credenziale non valida non viene mai ritentata', async (t) => {
  const fetchImpl = hubFetch('a'.repeat(32), 99, 'share-peer-unauthorized');
  const ctx = await peerWithHub(t, fetchImpl);
  const res = await shareOn(ctx.base, ctx.token);
  assert.notEqual(res.status, 200);
  assert.equal(fetchImpl.calls.share, 1, 'un guasto permanente si riporta subito');
  assert.equal(store.getNode(store.loadStoreStrict(ctx.nodesPath), 'hub').shared, false);
});

// Il rollback e' best-effort per costruzione, ma il suo esito non puo' andare
// perduto: `close` restituisce false quando non riesce a DIMOSTRARE la
// proprieta' del supervisor, e in quel caso il canale resta in quarantena —
// vivo — mentre lo store dice privato.
test('peer: se il canale reverse non si spegne in modo dimostrabile lo dichiara', async (t) => {
  const fetchImpl = hubFetch('a'.repeat(32), 99, 'share-peer-unauthorized');
  // reversePool presente ma nessun listener tracciato: la chiusura non puo'
  // dimostrarsi e restituisce false.
  const ctx = await peerWithHub(t, fetchImpl, { reversePool: store.reversePoolDefault(44001) });
  const res = await shareOn(ctx.base, ctx.token);
  const body = await res.json();
  assert.notEqual(res.status, 200);
  assert.equal(body.reversePoolPending, true, 'la quarantena del canale va dichiarata');
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

// Stesso difetto sul ramo OFF esplicito, dove pero' finisce in una risposta di
// SUCCESSO: dichiarare "revocato" un canale che e' soltanto in quarantena e'
// peggio che dirlo in un errore.
const shareOff = (base, token) => fetch(`${base}/api/settings/nodes/hub/share`, {
  method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: false }),
});

test('peer: anche lo spegnimento dichiara un canale che non si e\' spento in modo dimostrabile', async (t) => {
  const fetchImpl = hubFetch('a'.repeat(32), 0, null); // l'hub accetta la revoca
  const ctx = await peerWithHub(t, fetchImpl, {
    shared: true, reversePool: store.reversePoolDefault(44001),
  });
  const res = await shareOff(ctx.base, ctx.token);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.revoked, true);
  assert.equal(body.reversePoolPending, true, 'la quarantena va dichiarata anche in caso di successo');
  assert.equal(store.getNode(store.loadStoreStrict(ctx.nodesPath), 'hub').shared, false);
});

// --- lacune dichiarate al primo audit, ora coperte ---------------------------

// Una chiusura che LANCIA non e' una chiusura riuscita: se fosse l'unico caso
// silenzioso, l'unica situazione in cui non sappiamo nulla del canale sarebbe
// anche l'unica che non viene dichiarata.
test('peer: una chiusura che lancia vale come non dimostrabile', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-throw-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'hub', ssh: 'user@hub', remotePort: 41820, localPort: 43001, reversePort: 44001,
    direction: 'outbound', transport: 'auto', autostart: true, shared: true,
    visibility: 'network', nodeId: 'a'.repeat(32), token: 't'.repeat(48),
    reversePool: store.reversePoolDefault(44001),
  });
  store.atomicWriteStore(nodesPath, st);

  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes({
    cfg: {
      home: dir, configDir, nodesPath,
      configPath: path.join(configDir, 'config.json'),
      tokenPath: path.join(configDir, 'token'),
      settingsSeams: {
        platform: 'linux', uid: 1000,
        stopTunnelImpl: () => ({ stopped: true }),
        startForwardImpl: () => ({ started: false, reason: 'already running', pid: 4242 }),
        // health sana: il fallimento in prova e' SOLO quello della chiusura.
        fetchImpl: async (url) => (String(url).endsWith('/federation/health')
          ? { ok: true, status: 200, json: async () => ({ ok: true, instanceId: 'a'.repeat(32) }) }
          : { ok: true, status: 200, json: async () => ({ ok: true }) }),
        pairDelay: async () => {},
      },
    },
    nodesPath,
    reverseSlots: { close: async () => { throw new Error('supervisor non raggiungibile'); } },
    runtimePort: () => 41777,
  }));
  const srv = await listen(app);
  t.after(async () => { await close(srv); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/settings/nodes/hub/share`, {
    method: 'PATCH', headers: H('irrilevante'), body: JSON.stringify({ shared: false }),
  });
  const body = await res.json();
  assert.equal(body.reversePoolPending, true, 'una close che lancia va dichiarata come le altre');
});

// La politica di ritentativo non e' solo "quante volte": anche "quanto attende"
// fa parte del contratto, altrimenti una regressione a raffica passerebbe.
test('peer: i ritardi fra un tentativo e l\'altro crescono e sono quelli attesi', async (t) => {
  const waits = [];
  const fetchImpl = hubFetch('a'.repeat(32), 99, fed.SHARE_NOT_READY_CODE);
  const ctx = await bootPeer(t, { fetchImpl, pairDelay: async (ms) => { waits.push(ms); } });
  await fetch(`${ctx.base}/api/settings/nodes`, {
    method: 'POST', headers: H(ctx.token), body: JSON.stringify({ name: 'hub', ssh: 'user@hub' }),
  });
  let st = store.loadStoreStrict(ctx.nodesPath);
  st = store.updateNode(st, 'hub', {
    direction: 'outbound', shared: false, localPort: 43001, remotePort: 41820,
    reversePort: 44001, token: 't'.repeat(48), nodeId: 'a'.repeat(32),
  });
  store.atomicWriteStore(ctx.nodesPath, st);
  await shareOn(ctx.base, ctx.token);
  // Fra i ritardi ci sono anche quelli della salute locale: qui conta che la
  // sequenza dei ritentativi verso l'hub sia presente, in ordine crescente.
  const retryWaits = waits.filter((ms) => [1000, 2000, 3000].includes(ms));
  assert.deepEqual(retryWaits, [1000, 2000, 3000], `attese viste: ${waits.join(',')}`);
});

// --- il cablaggio PRODUTTIVO dello slot, non uno parallelo ------------------
// Un test che costruisce da se' i listener con un attachUpgrade corretto non
// vincola il wiring di server.js: mutandolo a no-op resterebbe verde. Qui lo
// slot viene aperto dal server reale (flusso Share ON -> reverseSlots.ensure)
// e si osserva il server creato davvero.
test('produzione: lo slot aperto dal server reale onora un upgrade', async (t) => {
  const created = [];
  const instanceId = 'a'.repeat(32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-slot-prod-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  store.initStore(nodesPath);

  const { server, token, watcher } = createServer({
    home: dir, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'), fleetEnabled: false,
    // Nessun ssh reale: lo spawn del tunnel e' un seam.
    tunnelSpawnImpl: () => ({ pid: 4193777, unref() {} }),
    tunnelSpawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    // Cattura i server creati per gli slot: sono quelli che ci interessano.
    reverseSlotCreateServerImpl: (app) => {
      const srv = http.createServer(app);
      created.push(srv);
      return srv;
    },
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
      stopTunnelImpl: () => ({ stopped: true }),
      startForwardImpl: () => ({ started: false, reason: 'already running', pid: 4242 }),
      pairDelay: async () => {},
      fetchImpl: async (url) => (String(url).endsWith('/federation/health')
        ? { ok: true, status: 200, json: async () => ({ ok: true, instanceId }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) }),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/api/settings/nodes`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ name: 'hub', ssh: 'user@hub' }),
  });
  let st = store.loadStoreStrict(nodesPath);
  st = store.updateNode(st, 'hub', {
    direction: 'outbound', shared: true, localPort: 43001, remotePort: 41820,
    reversePort: 44001, token: 't'.repeat(48), acceptToken: 'k'.repeat(48), nodeId: instanceId,
    reversePool: store.reversePoolDefault(44001),
  });
  store.atomicWriteStore(nodesPath, st);

  // Share ON su stato gia' condiviso: passa da ensureLocal -> reverseSlots.ensure.
  await fetch(`${base}/api/settings/nodes/hub/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });

  assert.ok(created.length >= 1, 'il server reale deve aver aperto almeno uno slot listener');
  const slotServer = created[0];
  assert.equal(slotServer.listenerCount('upgrade'), 1,
    'lo slot creato in produzione deve avere il routing di upgrade');
  const slotPort = slotServer.address() && slotServer.address().port;
  assert.ok(slotPort, 'lo slot listener deve essere in ascolto');

  // Prova reale sul listener aperto dal server, non su uno costruito qui.
  const upgraded = await rawUpgradeWithHeaders(slotPort, '/federation/route/_/ws', {
    authorization: `Bearer ${'k'.repeat(48)}`,
    'x-nexuscrew-visited': instanceId,
  });
  assert.ok(!/^HTTP\/1\.1 200 /.test(upgraded), 'mai la SPA su un upgrade');
  assert.ok(!/<html/i.test(upgraded), 'mai corpo HTML su un upgrade');
});
