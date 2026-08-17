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
const { generaCoppia } = require('./helpers/pubkey.js');
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
  const calls = {
    probe: 0, join: 0, confirm: 0, cancel: 0, health: 0, reverseStatus: 0, share: 0, spawns: 0,
    shareBodies: [], spawnArgs: [], events: [],
  };
  const impl = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/pair/join')) { calls.join += 1; return script.join(calls.join, opts); }
    if (u.endsWith('/pair/confirm')) { calls.confirm += 1; return script.confirm(calls.confirm, opts); }
    if (u.endsWith('/pair/cancel')) { calls.cancel += 1; return (script.cancel || (() => R(200, { ok: true })))(calls.cancel, opts); }
    if (u.endsWith('/federation/share')) {
      calls.share += 1; calls.shareBodies.push(JSON.parse(opts.body || '{}'));
      calls.events.push(`hub:${calls.shareBodies.at(-1).shared ? 'on' : 'off'}`);
      return (script.share || (() => R(200, { shared: calls.shareBodies.at(-1).shared })))(calls.share, opts);
    }
    if (u.endsWith('/federation/reverse-status')) {
      calls.reverseStatus += 1;
      return (script.reverseStatus || (() => R(404, {})))(calls.reverseStatus, opts);
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
    spawnImpl: (bin, args) => {
      calls.spawns += 1;
      calls.spawnArgs.push([...args]);
      calls.events.push(`spawn:${args.includes('-R') ? 'on' : 'off'}`);
      return typeof fetchScript.spawn === 'function'
        ? fetchScript.spawn(calls.spawns, bin, args, calls)
        : { pid: DEAD_PID, unref() {} };
    },
    spawnSyncImpl: () => ({ status: 0 }),
    sshVersion: () => ({ major: 9, minor: 6 }),
    fetchImpl: impl,
    pairDelay: async () => {},
    pairRequestTimeoutMs: 25,
    ...(fetchScript.hostname ? { hostname: fetchScript.hostname } : {}),
    ...(fetchScript.diagnosis ? { readTunnelDiagnostic: () => fetchScript.diagnosis } : {}),
    // Seam separato per la riserva della porta PANNELLO: cosi' un test puo'
    // rompere solo quella (la porta di controllo usa il binder di default).
    ...(fetchScript.createPanelPortServer ? { createPanelPortServer: fetchScript.createPanelPortServer } : {}),
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
  const badLocalName = await pairReq(base, token, {
    name: 'peer', ssh: 'relay', pairingUrl: link, localName: 'localhost',
  });
  const jLocal = await badLocalName.json();
  assert.equal(jLocal.stage, 'validation');
  assert.equal(jLocal.code, 'bad-local-name');
  assert.equal(jLocal.retryable, true);
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

test('pair stages: client legacy senza localName deriva handle stabile e mai localhost nudo', async (t) => {
  let joinBody;
  const { base, token, dir } = await boot(t, {
    hostname: () => 'localhost',
    probe: () => R(401, {}),
    join: (_n, opts) => { joinBody = JSON.parse(opts.body); return R(410, { error: 'stop after capture' }); },
  });
  const response = await pairReq(base, token, {
    name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir), localLabel: 'AsusRP3',
  });
  assert.equal(response.status, 502);
  assert.equal(joinBody.name, 'asus-rp3-aaaa');
  assert.equal(joinBody.label, 'AsusRP3');
  assert.notEqual(joinBody.name, 'localhost');
});

test('pair stages: conflitto localName propaga proposta e riusa lo stesso invito', async (t) => {
  const seenNames = [];
  const { base, token, dir, calls } = await boot(t, {
    hostname: () => 'localhost',
    probe: () => R(401, {}),
    join: (attempt, opts) => {
      const body = JSON.parse(opts.body); seenNames.push(body.name);
      if (attempt === 1) {
        return R(409, {
          error: `nome peer gia' in uso: ${body.name}`,
          code: 'peer-name-conflict',
          suggestedName: 'asus-rp3-aaaaaa',
        });
      }
      return R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID });
    },
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
  });
  const link = makePairingUrl(dir);
  const first = await pairReq(base, token, {
    name: 'peer', ssh: 'relay', pairingUrl: link,
    localLabel: 'AsusRP3', localName: 'asus-rp3-aaaa',
  });
  assert.equal(first.status, 409);
  const conflict = await first.json();
  assert.equal(conflict.stage, 'conflict');
  assert.equal(conflict.code, 'peer-name-conflict');
  assert.equal(conflict.suggestedName, 'asus-rp3-aaaaaa');
  assert.equal(conflict.retryable, true);
  assert.match(conflict.hint, /non e' stato consumato/);

  const second = await pairReq(base, token, {
    name: 'peer', ssh: 'relay', pairingUrl: link,
    localLabel: 'AsusRP3', localName: conflict.suggestedName,
  });
  assert.equal(second.status, 200);
  assert.deepEqual(seenNames, ['asus-rp3-aaaa', 'asus-rp3-aaaaaa']);
  assert.equal(calls.join, 2);
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
  // La bounded-ness e' la RISPOSTA stessa, non una misura: il join finto risponde
  // solo all'abort del coordinator (pairRequestTimeoutMs), quindi se la state
  // machine si appendeva qui il test resterebbe appeso e il gate lo fermerebbe
  // con lo stall-watchdog di tests/run-isolated.js. La vecchia soglia
  // elapsed<1000 misurava la velocita' della macchina (il timer di abort da
  // 25ms piu' la coda di eventi superava il secondo sotto carico: falso rosso).
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  const j = await r.json();
  assert.equal(j.stage, 'join'); assert.equal(j.code, 'join-ambiguous');
  assert.equal(calls.join, 1);
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

// IL CABLAGGIO, non il pezzo che compone la riga. La funzione che la costruisce
// ha i suoi test; qui si attraversa l'HANDLER VERO, perche' questa classe di
// difetto — helper verde e chiamante che perde il dato — si e' gia' presentata
// due volte in questa stessa riparazione.
//
// E fissa una proprieta' che e' un LIMITE DICHIARATO, non un difetto: nel
// percorso normale della PWA il corpo non porta `identityFile`, il nodo non ne
// riceve uno, e ssh usera' le chiavi di default dell'utente — che il prodotto
// non conosce e non puo' nominare. In quel caso la riga NON esce, e non deve:
// mezza istruzione e' peggio di nessuna. Il payload resta un'estensione
// condizionale per chi un'identita' dedicata ce l'ha.
test('pair panel: la riga authorized_keys esce SOLO quando la chiave e\' determinabile', async (t) => {
  const { base, token, dir } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID, panelPort: 41821 }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
  });
  // 1. percorso PWA normale: nessuna identita' nel corpo -> nessuna riga
  const pwa = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(pwa.status, 200);
  const jp = await pwa.json();
  assert.equal(jp.paired, true);
  assert.equal(jp.authorizedKeys, undefined,
    'senza identita\' dedicata la riga non e\' componibile: non si promette');
  assert.equal(jp.authorizedKeysNote, undefined, 'e nemmeno la nota che la accompagna');
});

test('pair panel: con un\'identita\' dedicata la riga esce, con entrambe le destinazioni', async (t) => {
  const { base, token, dir } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID, panelPort: 41821 }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
  });
  const key = generaCoppia(dir, 'id_ed25519_dedicata', 'dedicata');
  const r = await pairReq(base, token, {
    name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir), identityFile: key,
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.paired, true);
  assert.ok(typeof j.authorizedKeys === 'string' && j.authorizedKeys,
    `la riga deve arrivare al client — chiavi: ${Object.keys(j).join(',')}`);
  assert.ok(j.authorizedKeys.startsWith('restrict,port-forwarding,permitopen='),
    'la riga intera, derivata dalla privata dichiarata nel corpo');
  assert.ok(j.authorizedKeys.includes('permitopen="127.0.0.1:41821"'), 'la destinazione pannello');
  assert.match(j.authorizedKeys, /permitopen="127\.0\.0\.1:\d+".*permitopen="127\.0\.0\.1:41821"/,
    'due destinazioni distinte, controllo e pannello');
  assert.ok(j.authorizedKeysNote && j.authorizedKeysNote.includes('41821'),
    'la nota dice quale porta ha reso necessaria la sostituzione');
});

// P0 sicurezza, meta' remota. Un peer che ANNUNCIA la sua porta pannello nel
// join (0.9.1+) fa ottenere al nodo una coppia panelLocalPort/panelRemotePort,
// e il supervisor finale inoltra ENTRAMBE le destinazioni. Lo spawn provvisorio
// resta a un solo -L: prima del join la porta pannello del peer non si conosce.
test('pair panel: il peer che annuncia panelPort nel join ottiene il secondo -L', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID, panelPort: 41821 }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).paired, true);

  const n = store.getNode(store.loadStore(nodesPath), 'peer');
  assert.equal(n.panelRemotePort, 41821, 'la porta pannello annunciata dal peer finisce nel record');
  assert.ok(store.isPort(n.panelLocalPort) && n.panelLocalPort !== n.localPort,
    'la controparte locale e una porta vera, diversa da quella di controllo');

  // Due supervisor: provvisorio (pre-join, un -L) e finale (negoziato, due -L).
  assert.equal(calls.spawnArgs.length, 2, 'spawn provvisorio + spawn finale');
  const [provvisorio, finale] = calls.spawnArgs;
  const fwProvvisorio = provvisorio.filter((a, i) => provvisorio[i - 1] === '-L');
  assert.deepEqual(fwProvvisorio.map((x) => x.endsWith(':41830')), [true],
    'prima del join si inoltra solo il control plane: la porta pannello non si conosce ancora');
  const fwFinale = finale.filter((a, i) => finale[i - 1] === '-L');
  assert.equal(fwFinale.length, 2, 'il supervisor finale porta controllo E pannello');
  assert.ok(fwFinale.some((x) => x === `127.0.0.1:${n.panelLocalPort}:127.0.0.1:41821`),
    'il -L pannello usa la coppia negoziata');
  assert.ok(fwFinale.some((x) => x === '127.0.0.1:43001:127.0.0.1:41830'),
    'il -L di controllo resta al suo posto');
});

// Il punto 4 dal lato pairing: un peer di versione precedente non manda
// panelPort, e il pairing deve riuscire ESATTAMENTE come prima — nessun campo
// nel record, un solo -L, stessa risposta.
test('pair panel: il peer che NON annuncia panelPort si accoppia come sempre, senza secondo -L', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 200, 'nessun effetto del pannello sul pairing con un peer vecchio');
  assert.equal((await r.json()).paired, true);

  const n = store.getNode(store.loadStore(nodesPath), 'peer');
  assert.equal(n.panelLocalPort, undefined, 'nessun campo inventato');
  assert.equal(n.panelRemotePort, undefined);
  for (const args of calls.spawnArgs) {
    const fw = args.filter((a, i) => args[i - 1] === '-L');
    assert.equal(fw.length, 1, 'un solo -L: il tunnel e quello di sempre');
  }
});

// Il pannello e' un'estensione, il legame viene prima: se la porta locale per
// il forward pannello non si riesce a riservare, il pairing NON fallisce — si
// accoppia senza coppia e il pannello remoto resta sulla via storica.
test('pair panel: riserva della porta pannello fallita -> pairing riuscito senza coppia', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID, panelPort: 41821 }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    // Solo la riserva del PANNELLO salta (errore non-EADDRINUSE: niente
    // scan, throw subito); la porta di controllo usa il binder di default.
    createPanelPortServer: () => ({
      _err: null,
      once(ev, fn) { if (ev === 'error') this._err = fn; },
      removeListener() {},
      listen() { this._err(Object.assign(new Error('binder pannello rotto'), { code: 'EPANEL' })); },
    }),
  });
  const r = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(r.status, 200, 'il legame non fallisce per una porta pannello che non c\'e\'');
  assert.equal((await r.json()).paired, true);

  const n = store.getNode(store.loadStore(nodesPath), 'peer');
  assert.equal(n.panelLocalPort, undefined, 'nessuna coppia senza porta riservata');
  assert.equal(n.panelRemotePort, undefined);
  const finale = calls.spawnArgs.at(-1);
  const fw = finale.filter((a, i) => finale[i - 1] === '-L');
  assert.equal(fw.length, 1, 'il tunnel finale resta a un -L: via storica per il pannello');
});

test('Share PWA: OFF persiste, revoca sul -L vivo e solo dopo riavvia senza -R', async (t) => {
  let nodesPathRef = '';
  let observedOffStore = false;
  const started = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    share: (_attempt, opts) => {
      const shared = JSON.parse(opts.body || '{}').shared;
      if (shared === false) observedOffStore = store.getNode(store.loadStore(nodesPathRef), 'peer').shared === false;
      return R(200, { shared });
    },
  });
  const { base, token, dir, nodesPath, calls } = started;
  nodesPathRef = nodesPath;
  const paired = await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) });
  assert.equal(paired.status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);

  const setShare = (shared) => fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared }),
  });
  const on = await setShare(true);
  assert.equal(on.status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, true);
  const offStart = calls.events.length;
  const off = await setShare(false);
  assert.equal(off.status, 200);
  const offBody = await off.json();
  assert.equal(offBody.revoked, true);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
  assert.equal(observedOffStore, true, 'shared:false e durevole prima della richiesta al hub');
  assert.deepEqual(calls.events.slice(offStart), ['hub:off', 'spawn:off'],
    'la revoca precede deterministicamente il restart locale');
  assert.equal(calls.spawnArgs.at(-1).includes('-R'), false, 'il supervisor sostitutivo non pubblica il reverse');
  assert.deepEqual(calls.shareBodies, [{ shared: true }, { shared: false }]);
});

test('Share PWA: stato OFF invariato revoca prima e poi ripara uno supervisor stale', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    share: () => R(200, { shared: false }),
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
  const before = calls.spawns;
  const eventStart = calls.events.length;

  const response = await fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: false }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.unchanged, true);
  assert.equal(body.reconciled, true);
  assert.equal(calls.spawns, before + 1,
    'same-state OFF deve rientrare nello start spec-aware, non limitarsi alla notifica hub');
  assert.deepEqual(calls.events.slice(eventStart), ['hub:off', 'spawn:off']);
  assert.deepEqual(calls.shareBodies, [{ shared: false }]);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
});

test('Share PWA: un reverse rifiutato espone la permitlisten esatta senza log grezzo', async (t) => {
  const required = 'permitlisten="127.0.0.1:44001"';
  const { base, token, dir, nodesPath } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: (attempt) => attempt === 1
      ? R(200, { ok: true, instanceId: PEER_ID }) : R(503, { error: 'not ready' }),
    diagnosis: {
      code: 'reverse-forward-failed',
      detail: 'il canale inverso non è stato aperto dal nodo hub',
      hint: `verifica che la chiave SSH autorizzi ${required}`,
    },
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  const response = await fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.detail, /canale inverso/);
  assert.match(body.hint, /permitlisten="127\.0\.0\.1:44001"/);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false,
    'la diagnosi non deve impedire il rollback privato');
});

test('Share PWA: conflitto reverse gia noto dal hub non riavvia ne modifica il peer', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    reverseStatus: () => R(409, { available: false, code: 'reverse-port-in-use' }),
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  const beforeSpawns = calls.spawns;
  const response = await fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'reverse-port-conflict');
  assert.match(body.error, /porta reverse/i);
  assert.equal(calls.reverseStatus, 1);
  assert.equal(calls.spawns, beforeSpawns, 'un preflight conflittuale non interrompe il -L privato');
  assert.equal(calls.share, 0, 'un canale non aperto non viene pubblicato sul hub');
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
});

test('Share PWA: reverse gia verificato del peer stesso procede senza falso conflitto', async (t) => {
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    reverseStatus: () => R(200, { available: false, ownedByAuthenticatedPeer: true }),
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  const response = await fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).shared, true);
  assert.equal(calls.reverseStatus, 1);
  assert.equal(calls.share, 1);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, true);
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
  assert.equal(body.revoked, false);
  assert.equal(body.reconcilePending, true);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false,
    'un ACK perso non deve riattivare il reverse channel');
  assert.deepEqual(calls.shareBodies, [
    { shared: true }, { shared: false }, { shared: false }, { shared: false },
  ], 'OFF ha almeno lo stesso budget bounded di ON');
  assert.equal(calls.events.slice(calls.events.lastIndexOf('hub:on') + 1).includes('spawn:off'), false,
    'senza ACK hub non avviene alcun restart locale');
});

test('Share OFF: ACK hub seguito da restart fallito resta revocato senza rollback ON', async (t) => {
  let failPrivateSpawn = false;
  const { base, token, dir, nodesPath, calls } = await boot(t, {
    probe: () => R(401, {}),
    join: () => R(200, { credential: CREDENTIAL, reversePort: 44001, instanceId: PEER_ID }),
    confirm: () => R(200, { ok: true }),
    health: () => R(200, { ok: true, instanceId: PEER_ID }),
    share: (_n, opts) => R(200, { shared: JSON.parse(opts.body || '{}').shared }),
    spawn: (_n, _bin, args) => failPrivateSpawn && !args.includes('-R')
      ? { unref() {} }
      : { pid: DEAD_PID, unref() {} },
  });
  assert.equal((await pairReq(base, token, { name: 'peer', ssh: 'relay', pairingUrl: makePairingUrl(dir) })).status, 200);
  const setShare = (shared) => fetch(`${base}/api/settings/nodes/peer/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared }),
  });
  assert.equal((await setShare(true)).status, 200);
  failPrivateSpawn = true;
  const eventStart = calls.events.length;
  const response = await setShare(false);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(calls.shareBodies, [{ shared: true }, { shared: false }],
    'il hub deve osservare OFF prima del restart locale iniettato come fallito');
  assert.equal(body.shared, false);
  assert.equal(body.revoked, true);
  assert.equal(body.localReconcilePending, true);
  assert.equal(body.reconcilePending, undefined);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'peer').shared, false);
  assert.deepEqual(calls.events.slice(eventStart), ['hub:off', 'spawn:off']);
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
