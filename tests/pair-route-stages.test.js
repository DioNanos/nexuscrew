'use strict';
// POST /api/settings/nodes/pair — contratto a stadi {error, code, stage, detail,
// hint?, retryable?}: validation/conflict/ssh-start/ssh-ready/join/tunnel-final/
// confirm/health, readiness bounded al posto dello sleep fisso, join one-time mai
// rigiocato, rollback esattamente una volta, health federato autenticato prima di
// paired:true. Nessuna rete/SSH reale: tutto via settingsSeams.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const peering = require('../lib/nodes/peering.js');
const store = require('../lib/nodes/store.js');

const DEAD_PID = 4193999;
const PEER_ID = 'd'.repeat(32);
const CREDENTIAL = 'C'.repeat(43); // shape base64url 32B

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const R = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Link di pairing valido (v1 basta: il route decodifica e usa invite/port).
function makePairingUrl(dir) {
  const p = path.join(dir, 'peer-invites.json');
  return peering.createInvite({ invitesPath: p, instanceId: PEER_ID, port: 41830, label: 'Peer' }).pairingUrl;
}

// fetchImpl scriptato per join, confirm, cancel e health autenticato. Il probe
// capability-bound e' iniettato separatamente: questi test verificano la state
// machine della route; la crittografia del probe ha test reali dedicati.
function scriptedFetch(script) {
  const calls = { probe: 0, join: 0, confirm: 0, cancel: 0, health: 0, share: 0, shareBodies: [] };
  const impl = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/pair/join')) { calls.join += 1; return script.join(calls.join, opts); }
    if (u.endsWith('/pair/confirm')) { calls.confirm += 1; return script.confirm(calls.confirm, opts); }
    if (u.endsWith('/pair/cancel')) { calls.cancel += 1; return (script.cancel || (() => R(200, { ok: true })))(calls.cancel, opts); }
    if (u.endsWith('/federation/share')) {
      calls.share += 1; calls.shareBodies.push(JSON.parse(opts.body || '{}'));
      return (script.share || (() => R(200, { shared: calls.shareBodies.at(-1).shared })))(calls.share, opts);
    }
    if (u.endsWith('/federation/health')) {
      if (opts.headers && opts.headers.authorization) { calls.health += 1; return script.health(calls.health, opts); }
    }
    throw new Error(`fetch inatteso: ${u}`);
  };
  return { impl, calls };
}

function boot(t, fetchScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pairstage-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  store.atomicWriteStore(nodesPath, store.emptyStore('a'.repeat(32)));
  const { impl, calls } = scriptedFetch(fetchScript);
  const settingsSeams = {
    platform: 'linux',
    uid: 1000,
    execImpl: () => { throw new Error('exec disabled in test'); },
    spawnImpl: () => ({ pid: DEAD_PID, unref() {} }),
    spawnSyncImpl: () => ({ status: 0 }),
    sshVersion: () => ({ major: 9, minor: 6 }),
    fetchImpl: impl,
    pairDelay: async () => {},
    pairRequestTimeoutMs: 25,
    ...(fetchScript.diagnosis ? { readTunnelDiagnostic: () => fetchScript.diagnosis } : {}),
    probeTransportReady: async () => {
      let lastError = '';
      for (let i = 0; i < 6; i += 1) {
        calls.probe += 1;
        try {
          const response = await fetchScript.probe(calls.probe);
          if (response) return { ready: true, attempts: i + 1 };
        } catch (e) { lastError = String((e && e.message) || e); }
      }
      return { ready: false, attempts: 6, code: 'transport-not-ready', lastError };
    },
  };
  const made = createServer({
    home: dir, configDir, nodesPath,
    configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(dir, 'files'),
    port: 41999, fleetEnabled: false, settingsSeams,
  });
  return new Promise((res) => made.server.listen(0, '127.0.0.1', () => {
    t.after(() => { made.server.close(); if (made.watcher) made.watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${made.server.address().port}`, token: made.token, dir, nodesPath, calls });
  }));
}

const pairReq = (base, token, body) => fetch(`${base}/api/settings/nodes/pair`, {
  method: 'POST', headers: H(token), body: JSON.stringify(body),
});

test('pair stages: validation distingue name/ssh/link con code e retryable', async (t) => {
  const { base, token, dir } = await boot(t, {});
  const link = makePairingUrl(dir);
  const badName = await pairReq(base, token, { name: 'NOT VALID!', ssh: 'relay', pairingUrl: link });
  assert.equal(badName.status, 400);
  const jn = await badName.json();
  assert.equal(jn.stage, 'validation'); assert.equal(jn.code, 'bad-name'); assert.equal(jn.retryable, true);
  const badSsh = await pairReq(base, token, { name: 'peer', ssh: '-oProxyCommand=x', pairingUrl: link });
  assert.equal((await badSsh.json()).code, 'bad-ssh');
  const badLink = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: 'http://x/#pair=garbage' });
  const jl = await badLink.json();
  assert.equal(jl.code, 'bad-link'); assert.ok(jl.hint);
});

test('pair stages: nome gia\' presente -> 409 conflict', async (t) => {
  const { base, token, dir, nodesPath } = await boot(t, {});
  let st = store.loadStore(nodesPath);
  st = store.addNode(st, { name: 'peer', ssh: 'user@old', remotePort: 41830, localPort: 45001, direction: 'outbound', transport: 'auto', autostart: true, visibility: 'network' });
  store.atomicWriteStore(nodesPath, st);
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.stage, 'conflict'); assert.equal(j.code, 'name-exists'); assert.equal(j.retryable, true);
});

test('pair stages: self-pairing e peer gia noto falliscono prima di SSH/join', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {});
  const selfLink = peering.createInvite({
    invitesPath: path.join(dir, 'self-invites.json'), instanceId: 'a'.repeat(32), port: 41830, label: 'Self',
  }).pairingUrl;
  const self = await pairReq(base, token, { name: 'self', ssh: 'relay', pairingUrl: selfLink });
  assert.equal(self.status, 409);
  assert.equal((await self.json()).code, 'self-pairing');

  let st = store.loadStore(nodesPath);
  st = store.addNode(st, { name: 'known', ssh: 'known-host', remotePort: 41830, localPort: 45001, direction: 'outbound', transport: 'auto', autostart: true, visibility: 'network', nodeId: PEER_ID });
  store.atomicWriteStore(nodesPath, st);
  const peerLink = peering.createInvite({
    invitesPath: path.join(dir, 'known-invites.json'), instanceId: PEER_ID, port: 41830, label: 'Known',
  }).pairingUrl;
  const known = await pairReq(base, token, { name: 'other-name', ssh: 'relay', pairingUrl: peerLink });
  assert.equal(known.status, 409);
  assert.equal((await known.json()).code, 'peer-exists');
  assert.equal(calls.join, 0);
});

test('pair stages: identita risposta diversa dal link -> rollback e nessuna conferma', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: 'f'.repeat(32) }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.stage, 'join'); assert.equal(j.code, 'peer-identity-mismatch');
  assert.equal(calls.join, 1); assert.equal(calls.confirm, 0); assert.equal(calls.cancel, 1);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer'), null);
});

test('pair stages: transport mai pronto -> ssh-ready, invite NON consumato, rollback', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => { throw new Error('ECONNREFUSED'); },
    diagnosis: {
      code: 'forward-denied',
      detail: 'SSH autenticato, ma il server ha negato il port forwarding verso 127.0.0.1:41830',
      hint: "verifica AllowTcpForwarding e l'eventuale permitopen per 127.0.0.1:41830; il link NON e' stato consumato",
    },
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.stage, 'ssh-ready');
  assert.equal(j.code, 'forward-denied');
  assert.match(j.detail, /SSH autenticato/);
  assert.match(j.detail, /127\.0\.0\.1:41830/);
  assert.equal(j.retryable, true, 'link non consumato -> retryable');
  assert.ok(j.hint.includes('NON'), 'hint dice che il link non e\' stato consumato');
  assert.equal(calls.join, 0, 'join MAI chiamato senza transport pronto');
  assert.ok(calls.probe >= 2, 'readiness bounded con retry, non un colpo secco');
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer'), null, 'nodo provvisorio rimosso');
});

test('pair stages: peer 410 -> join/invite-expired, un solo join, niente replay', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(410, { error: 'invite scaduto' }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.stage, 'join'); assert.equal(j.code, 'invite-expired');
  assert.equal(calls.join, 1, 'join one-time: mai rigiocato');
  assert.equal(calls.cancel, 0, 'nessuna credenziale emessa -> niente cancel remoto');
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer'), null);
});

test('pair stages: rete morta DOPO il join -> join-ambiguous, mai replay', async (t) => {
  const { base, token, dir, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => { throw new Error('socket hang up'); },
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  const j = await r.json();
  assert.equal(j.stage, 'join'); assert.equal(j.code, 'join-ambiguous'); assert.equal(j.retryable, false);
  assert.equal(calls.join, 1, 'risposta ambigua: il join non viene rigiocato');
});

test('pair stages: join half-open termina col timeout strutturato invece di restare appeso', async (t) => {
  const { base, token, dir, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: (_n, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('request timed out'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    }),
  });
  const started = Date.now();
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  const j = await r.json();
  assert.equal(j.stage, 'join'); assert.equal(j.code, 'join-ambiguous');
  assert.equal(calls.join, 1);
  assert.ok(Date.now() - started < 1000, 'timeout bounded nel test, nessun hang');
});

test('pair stages: confirm fallisce -> stage confirm, cancel remoto UNA volta, nodo rimosso', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(500, { error: 'boom interno peer' }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.stage, 'confirm'); assert.equal(j.code, 'confirm-failed');
  assert.ok(j.detail.includes('boom'), 'detail del peer arriva al client');
  assert.equal(calls.confirm, 3, 'confirm idempotente -> bounded retry');
  assert.equal(calls.cancel, 1, 'rollback remoto esattamente una volta');
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer'), null, 'nodo locale rimosso');
  assert.ok(!JSON.stringify(j).includes(CREDENTIAL), 'nessuna credenziale nel payload di errore');
});

test('pair stages: health federato degradato -> stage health + rollback (mai paired su verde finto)', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: 'f'.repeat(32) }), // nodo sbagliato
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.stage, 'health'); assert.equal(j.code, 'federation-health-failed');
  assert.ok(j.detail.includes('instanceId'), 'causa reale (identita\' peer) nel detail');
  assert.equal(calls.cancel, 1);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer'), null);
});

test('pair stages: happy path -> paired:true solo dopo health autenticato ok', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: (_n, opts) => {
      assert.equal(opts.headers.authorization, `Bearer ${CREDENTIAL}`, 'health probe autenticato con la credenziale negoziata');
      return R(200, { ok: true, instanceId: PEER_ID });
    },
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir), label: 'Peer Relay', sshPort: 2222 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.paired, true);
  assert.equal(j.instanceId, PEER_ID);
  assert.equal(j.health.status, 'healthy');
  assert.equal(calls.join, 1); assert.equal(calls.health, 1); assert.equal(calls.cancel, 0);
  const n = store.getNode(store.loadStore(nodesPath), 'peer');
  assert.equal(n.token, CREDENTIAL);
  assert.equal(n.nodeId, PEER_ID);
  assert.equal(n.reversePort, 44001);
  assert.equal(n.shared, false, 'pairing e privato finche Share non viene attivato');
  assert.equal(n.sshPort, 2222);
});

test('Share PWA: pairing resta -L privato, toggle aggiunge/rimuove pubblicazione in modo esplicito', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    share: () => R(200, { shared: true }),
  });
  const paired = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(paired.status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);

  const setShare = (shared) => fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared }),
  });
  const on = await setShare(true);
  assert.equal(on.status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, true);
  const off = await setShare(false);
  assert.equal(off.status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
  assert.deepEqual(calls.shareBodies, [{ shared: true }, { shared: false }]);
});

test('Share ON: ACK hub fallito torna deterministicamente a -L privato', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    share: () => R(500, { error: 'hub unavailable' }),
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  const response = await fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });
  assert.equal(response.status, 502);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
  assert.deepEqual(calls.shareBodies, [{ shared: true }]);
});

test('Share OFF: stato locale resta false se l ACK hub fallisce e il boot potra riconciliare', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    share: (_n, opts) => JSON.parse(opts.body || '{}').shared ? R(200, { shared: true }) : R(500, { error: 'hub unavailable' }),
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  const setShare = (shared) => fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared }),
  });
  assert.equal((await setShare(true)).status, 200);
  const off = await setShare(false);
  assert.equal(off.status, 502);
  const body = await off.json();
  assert.equal(body.shared, false);
  assert.equal(body.reconcilePending, true);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false,
    'un ACK perso non deve riattivare il reverse channel');
  assert.deepEqual(calls.shareBodies, [{ shared: true }, { shared: false }]);
});

test('pair stages: i dettagli di errore redigono token/credenziali', async (t) => {
  const secret = 'S'.repeat(43);
  const { base, token, dir } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(403, { error: `denied Bearer ${secret} for peer` }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  const j = await r.json();
  assert.equal(j.stage, 'join'); assert.equal(j.code, 'join-rejected');
  assert.ok(!JSON.stringify(j).includes(secret), 'secret redatto');
  assert.ok(j.detail.includes('***'), 'redazione visibile');
});
