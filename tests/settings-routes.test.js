'use strict';
// tests/settings-routes.test.js — Settings API B2 (design §4b(6)).
// Per ogni endpoint: happy path, input garbage -> 400, READONLY -> 403 sui mutanti
// config/token/service/up/down/restart bloccati, token mai in risposta,
// atomicita' di config.json (scritture concorrenti non corrompono).
//
// NIENTE processi reali: keygen/spawn/exec/probe sono seam iniettati via
// settingsSeams; i "pid" dei tunnel sono pid morti (mai kill su processi veri).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const nodesTunnel = require('../lib/nodes/tunnel.js');
const pidf = require('../lib/cli/pidfile.js');

// pid che non puo' esistere (>= pid_max tipici o comunque libero): readTunnelState
// lo vede morto, killPidfile non signala nulla. MAI usare pid vivi nei test down.
const DEAD_PID = 4193999;

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function boot(t, over = {}, seams = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncset-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  const settingsSeams = {
    platform: 'linux',
    uid: 1000,
    execImpl: () => { throw new Error('exec disabled in test'); }, // service "inactive"
    serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
    keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
    spawnImpl: () => ({ pid: DEAD_PID, unref() {} }),
    sshVersion: () => ({ major: 9, minor: 6 }),
    ...seams,
  };
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    settingsSeams,
    ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, ...paths });
  }));
}

const addNode = (base, token, name, extra = {}) =>
  fetch(`${base}/api/settings/nodes`, {
    method: 'POST', headers: H(token),
    body: JSON.stringify({ name, ssh: `user@host-${name}`, ...extra }),
  });

// Simula un tunnel "up" senza processi: pidfile col NOSTRO pid e cmd vuoto
// (isAlive: pid vivo + cmd non verificabile -> up). Solo per /test, MAI per down.
function fakeTunnelUp(home, name) {
  fs.mkdirSync(nodesTunnel.tunnelDir(home), { recursive: true });
  pidf.writePidfile(nodesTunnel.tunnelPidPath(home, name), process.pid, '');
}

// --- GET /api/settings -------------------------------------------------------

test('GET /settings: 401 senza Bearer, vista completa con Bearer (firstRun true)', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  const r = await fetch(`${base}/api/settings`, { headers: H(token) });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.firstRun, true); // config.json assente
  assert.deepEqual(s.roles, { client: false, node: false });
  assert.equal(s.port, 41999);
  assert.equal(s.platform, 'linux');
  assert.deepEqual(s.service, { installed: false, active: false, boot: false });
  assert.equal(typeof s.version, 'string');
  assert.equal(s.rendezvous, undefined);
});

test('GET /settings: firstRun resta true finche\' wizardDone non e\' true', async (t) => {
  const { base, token, configPath } = await boot(t);
  // config.json presente (come dopo `init`) ma SENZA wizardDone -> ancora firstRun
  fs.writeFileSync(configPath, JSON.stringify({ port: 41999 }), { mode: 0o600 });
  let s = await (await fetch(`${base}/api/settings`, { headers: H(token) })).json();
  assert.equal(s.firstRun, true);
  const w = await fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ wizardDone: true }),
  });
  assert.equal(w.status, 200);
  s = await (await fetch(`${base}/api/settings`, { headers: H(token) })).json();
  assert.equal(s.firstRun, false);
});

// --- POST /settings/config ----------------------------------------------------

test('config: happy path scrive atomico (0600), whitelisted, note sul cambio porta', async (t) => {
  const { base, token, configPath } = await boot(t);
  const r = await fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token),
    body: JSON.stringify({ roles: { client: true }, port: 42123, wizardDone: true }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.saved, true);
  assert.deepEqual(j.config.roles, { client: true, node: false });
  assert.equal(j.config.port, 42123);
  assert.match(j.note, /prossimo restart/); // porta != cfg.port runtime
  const file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(file.port, 42123);
  assert.equal(file.wizardDone, true);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('config: preserva le chiavi esistenti non gestite (merge, non overwrite)', async (t) => {
  const { base, token, configPath } = await boot(t);
  fs.writeFileSync(configPath, JSON.stringify({ port: 41999, custom: 'keepme' }), { mode: 0o600 });
  const r = await fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ wizardDone: true }),
  });
  assert.equal(r.status, 200);
  const file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(file.custom, 'keepme');
  assert.equal(file.port, 41999);
});

test('config: garbage -> 400 con causa (fail-closed, mai guess)', async (t) => {
  const { base, token } = await boot(t);
  const post = (body, raw = false) => fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: raw ? body : JSON.stringify(body),
  });
  for (const [body, why] of [
    [{ tokenPath: '/tmp/evil' }, /chiave non ammessa/],
    [{ port: 'ottanta' }, /port/],
    [{ port: 0 }, /port/],
    [{ port: 70000 }, /port/],
    [{ wizardDone: 'yes' }, /wizardDone/],
    [{ roles: { admin: true } }, /roles/],
    [{ roles: { client: 'si' } }, /roles\.client/],
    [{ roles: [] }, /roles/],
    [{}, /nessuna chiave/],
    [[1, 2], /oggetto/],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(body)}`);
    assert.match((await r.json()).error, why);
  }
  const bad = await post('not-json{{', true);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON non valido/);
});

test('config: scritture concorrenti non corrompono (finale = uno dei due validi)', async (t) => {
  const { base, token, configPath } = await boot(t);
  const post = (body) => fetch(`${base}/api/settings/config`, {
    method: 'POST', headers: H(token), body: JSON.stringify(body),
  });
  const [a, b] = await Promise.all([
    post({ port: 42001, wizardDone: true }),
    post({ port: 42002, wizardDone: false }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const file = JSON.parse(fs.readFileSync(configPath, 'utf8')); // parse ok = non corrotto
  assert.ok(
    (file.port === 42001 && file.wizardDone === true)
    || (file.port === 42002 && file.wizardDone === false),
    `contenuto finale deve essere UNA delle due scritture valide: ${JSON.stringify(file)}`,
  );
});

// --- POST /settings/token/rotate ----------------------------------------------

test('token/rotate: ruota live, vecchio 401, nuovo 200, token MAI in risposta', async (t) => {
  const { base, token, tokenPath } = await boot(t);
  const before = fs.readFileSync(tokenPath, 'utf8').trim();
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${before}` } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const wsClosed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS non chiuso dopo token rotate')), 2000);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  const r = await fetch(`${base}/api/settings/token/rotate`, { method: 'POST', headers: H(token) });
  assert.equal(r.status, 200);
  const raw = await r.text();
  const j = JSON.parse(raw);
  assert.equal(j.rotated, true);
  assert.match(j.note, /nexuscrew url/);
  const after = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.notEqual(after, before);            // file ruotato davvero
  assert.ok(!raw.includes(after), 'il NUOVO token non deve MAI comparire in risposta');
  assert.ok(!raw.includes(before), 'nemmeno il vecchio');
  assert.equal(await wsClosed, 4001, 'le sessioni WS preesistenti vengono invalidate live');
  assert.equal((await fetch(`${base}/api/settings`, { headers: H(before) })).status, 401);
  assert.equal((await fetch(`${base}/api/settings`, { headers: H(after) })).status, 200);
});

// --- POST /settings/nodes + DELETE /settings/nodes/:name -----------------------

test('nodes add: happy path con riga authorized_keys (pubkey restrict, non un segreto)', async (t) => {
  const { base, token } = await boot(t);
  const r = await addNode(base, token, 'vps');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.added, true);
  assert.equal(j.name, 'vps');
  assert.equal(j.remotePort, 41820); // default
  assert.ok(Number.isInteger(j.localPort));
  assert.match(j.authorizedKeys, /^restrict,port-forwarding,permitopen="127\.0\.0\.1:41820",command="\/bin\/false" ssh-ed25519 /);
  // visibile dalla read-only API nodes (redatta)
  const nodes = await (await fetch(`${base}/api/nodes`, { headers: H(token) })).json();
  assert.equal(nodes.nodes.length, 1);
  assert.equal(nodes.nodes[0].name, 'vps');
  assert.equal(nodes.nodes[0].hasToken, false);
});

test('nodes add: duplicato -> 409, garbage -> 400 con causa', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await addNode(base, token, 'vps')).status, 200);
  const dup = await addNode(base, token, 'vps');
  assert.equal(dup.status, 409);
  assert.match((await dup.json()).error, /duplicato/);
  const post = (body) => fetch(`${base}/api/settings/nodes`, {
    method: 'POST', headers: H(token), body: JSON.stringify(body),
  });
  for (const [body, why] of [
    [{ name: 'UPPER', ssh: 'a@b' }, /name non valido/],
    [{ name: 'ok-1' }, /ssh/],
    [{ name: 'ok-1', ssh: 'niente-chiocciola' }, /ssh/],
    [{ name: 'ok-1', ssh: 'a@b', remotePort: 'x' }, /remotePort/],
    [{ name: 'ok-1', ssh: 'a@b', localPort: 99999 }, /localPort/],
    [{ name: 'ok-1', ssh: 'a@b', keyPath: 'relativa/key' }, /keyPath/],
    [{ name: 'ok-1', ssh: 'a@b', evil: true }, /chiave non ammessa/],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, `atteso 400 per ${JSON.stringify(body)}`);
    assert.match((await r.json()).error, why);
  }
});

test('nodes remove: happy path, sconosciuto -> 404, name invalido -> 400', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await addNode(base, token, 'phone')).status, 200);
  const del = (name) => fetch(`${base}/api/settings/nodes/${name}`, { method: 'DELETE', headers: H(token) });
  const ok = await del('phone');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { removed: true, name: 'phone', stopped: false });
  const missing = await del('phone');
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /sconosciuto|nessun nodes/);
  assert.equal((await del('UPPER')).status, 400);
});

// --- POST /settings/nodes/:name/test -------------------------------------------

test('nodes test: distingue unknown-node/tunnel-down/health-ko/token-missing/token-ko/ok', async (t) => {
  const probes = [];
  let probeMode = 'ok';
  const httpProbe = async (url, headers) => {
    probes.push({ url, headers });
    if (probeMode === 'health-ko') return { ok: false, status: 500 };
    if (probeMode === 'token-ko' && url.includes('/api/config')) return { ok: false, status: 401 };
    return { ok: true, status: 200 };
  };
  const { base, token, home, nodesPath } = await boot(t, {}, { httpProbe });
  const doTest = (name) => fetch(`${base}/api/settings/nodes/${name}/test`, { method: 'POST', headers: H(token) });

  assert.equal((await doTest('ghost')).status, 404);            // unknown-node
  assert.equal((await doTest('IN VALID')).status, 400);         // name garbage

  assert.equal((await addNode(base, token, 'alpha')).status, 200);
  let j = await (await doTest('alpha')).json();
  assert.deepEqual([j.ok, j.result], [false, 'tunnel-down']);   // nessun pidfile

  fakeTunnelUp(home, 'alpha');
  probeMode = 'health-ko';
  j = await (await doTest('alpha')).json();
  assert.deepEqual([j.ok, j.result], [false, 'health-ko']);

  probeMode = 'ok';
  j = await (await doTest('alpha')).json();
  assert.deepEqual([j.ok, j.result], [false, 'token-missing']); // health ok ma token assente

  // salva un token remoto noto direttamente nello store (fixture)
  let st = nodesStore.loadStore(nodesPath);
  st = nodesStore.setNodeToken(st, 'alpha', 'REMOTE-SECRET-42');
  nodesStore.atomicWriteStore(nodesPath, st);

  probeMode = 'token-ko';
  j = await (await doTest('alpha')).json();
  assert.deepEqual([j.ok, j.result], [false, 'token-ko']);

  probeMode = 'ok';
  probes.length = 0;
  const r = await doTest('alpha');
  const raw = await r.text();
  j = JSON.parse(raw);
  assert.deepEqual([j.ok, j.result], [true, 'ok']);
  // il token remoto viene iniettato SOLO verso il nodo (probe), MAI in risposta
  const authed = probes.find((p) => p.url.includes('/api/config'));
  assert.equal(authed.headers.authorization, 'Bearer REMOTE-SECRET-42');
  assert.ok(!raw.includes('REMOTE-SECRET-42'), 'token remoto MAI in risposta');
});

// --- POST /settings/nodes/:name/up|down|restart ---------------------------------

test('nodes lifecycle: up/down/restart riusano il tunnel manager (spawn seam)', async (t) => {
  const spawned = [];
  const { base, token } = await boot(t, {}, {
    spawnImpl: (bin, args) => { spawned.push([bin, args]); return { pid: DEAD_PID, unref() {} }; },
  });
  const act = (name, a) => fetch(`${base}/api/settings/nodes/${name}/${a}`, { method: 'POST', headers: H(token) });

  assert.equal((await act('ghost', 'up')).status, 404);
  assert.equal((await act('IN VALID', 'up')).status, 400);

  assert.equal((await addNode(base, token, 'beta', { localPort: 43101 })).status, 200);
  const up = await act('beta', 'up');
  assert.equal(up.status, 200);
  const uj = await up.json();
  assert.equal(uj.started, true);
  assert.equal(uj.pid, DEAD_PID);
  // template ssh §4b(1): argv puro, forward loopback
  const [bin, args] = spawned[0];
  assert.equal(bin, process.execPath);
  assert.ok(args[0].endsWith('tunnel-supervisor.js'));
  assert.ok(args.includes('-L'));
  assert.ok(args.some((a) => a.startsWith('127.0.0.1:43101:127.0.0.1:')));

  // down: pid gia' morto -> stale, nessun kill reale (stopped false, 200 esplicito)
  const down = await act('beta', 'down');
  assert.equal(down.status, 200);
  assert.equal((await down.json()).stopped, false);

  const restart = await act('beta', 'restart');
  assert.equal(restart.status, 200);
  const rj = await restart.json();
  assert.equal(rj.restarted, true);
  assert.equal(rj.pid, DEAD_PID);
});

// --- POST /settings/node-role ----------------------------------------------------

test('node-role: on con rendezvous (permitlisten in authorized_keys), off, garbage', async (t) => {
  const { base, token, configPath } = await boot(t);
  const post = (body) => fetch(`${base}/api/settings/node-role`, {
    method: 'POST', headers: H(token), body: JSON.stringify(body),
  });

  for (const [body, status] of [
    [{ enabled: 'si' }, 400],
    [{}, 400],
    [{ enabled: true, evil: 1 }, 400],
    [{ enabled: true, rendezvousSsh: 'senza-chiocciola' }, 400],
    [{ enabled: true, rendezvousSsh: 'a@b', publishedPort: 'x' }, 400],
    [{ enabled: true }, 400], // nessun rendezvous configurato
  ]) {
    assert.equal((await post(body)).status, status, JSON.stringify(body));
  }

  const on = await post({ enabled: true, rendezvousSsh: 'user@host', publishedPort: 45001 });
  assert.equal(on.status, 200);
  const oj = await on.json();
  assert.equal(oj.enabled, true);
  assert.deepEqual(oj.roles, { client: false, node: true });
  assert.match(oj.authorizedKeys, /^restrict,port-forwarding,permitlisten="127\.0\.0\.1:45001",command="\/bin\/false" ssh-ed25519 /);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).roles.node, true);

  // GET /settings ora espone il rendezvous (redatto: nessun token nello shape)
  const s = await (await fetch(`${base}/api/settings`, { headers: H(token) })).json();
  assert.equal(s.rendezvous.ssh, 'user@host');
  assert.equal(s.rendezvous.publishedPort, 45001);

  const off = await post({ enabled: false });
  assert.equal(off.status, 200);
  assert.deepEqual((await off.json()).roles, { client: false, node: false });
});

test('node-role: OpenSSH < 7.8 (niente permitlisten) -> 409 conflitto esplicito', async (t) => {
  const { base, token } = await boot(t, {}, { sshVersion: () => ({ major: 7, minor: 4 }) });
  const r = await fetch(`${base}/api/settings/node-role`, {
    method: 'POST', headers: H(token),
    body: JSON.stringify({ enabled: true, rendezvousSsh: 'user@host' }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /permitlisten/);
});

// --- POST /settings/service/regenerate --------------------------------------------

test('service/regenerate: scrive l\'unit ma NON esegue restart (activation skippata)', async (t) => {
  const { base, token, configPath } = await boot(t, {}, {
    execImpl: (_bin, args) => {
      if (args.includes('is-enabled')) return 'enabled';
      throw new Error('inactive');
    },
  });
  // porta configurata diversa da quella runtime: resta solo nel config autoritativo
  fs.writeFileSync(configPath, JSON.stringify({ port: 42555 }), { mode: 0o600 });
  const r = await fetch(`${base}/api/settings/service/regenerate`, { method: 'POST', headers: H(token) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.regenerated, true);
  assert.match(j.note, /nessun restart automatico/);
  // i comandi di attivazione sono stati SKIPPATI, non eseguiti (contratto B2)
  assert.ok(j.skippedActivation.some((c) => /restart/.test(c)));
  const unit = fs.readFileSync(j.target, 'utf8');
  assert.match(unit, /ExecStart=/);
  assert.doesNotMatch(unit, /NEXUSCREW_PORT/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).port, 42555);
  // ora il service risulta installato nella vista read-only
  const s = await (await fetch(`${base}/api/settings`, { headers: H(token) })).json();
  assert.equal(s.service.installed, true);
});

test('service/regenerate: boot opt-in assente -> 409 e nessuna unit creata', async (t) => {
  const { base, token } = await boot(t);
  const r = await fetch(`${base}/api/settings/service/regenerate`, { method: 'POST', headers: H(token) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /nexuscrew boot/);
});

// --- READONLY route-level -----------------------------------------------------------

test('READONLY: 403 su TUTTI i mutanti (inclusi up/down/restart); test resta non-gated', async (t) => {
  const { base, token } = await boot(t, { readonlyDefault: true });
  const post = (p, body) => fetch(`${base}/api/settings/${p}`, {
    method: 'POST', headers: H(token), body: body === undefined ? undefined : JSON.stringify(body),
  });
  // lista chiusa dei mutanti -> 403 con {error} esplicito, PRIMA di ogni dispatch
  for (const [p, body] of [
    ['config', { wizardDone: true }],
    ['token/rotate', undefined],
    ['nodes', { name: 'x', ssh: 'a@b' }],
    ['node-role', { enabled: false }],
    ['service/regenerate', undefined],
  ]) {
    const r = await post(p, body);
    assert.equal(r.status, 403, `${p} deve dare 403 in READONLY`);
    assert.match((await r.json()).error, /READONLY/);
  }
  const del = await fetch(`${base}/api/settings/nodes/x`, { method: 'DELETE', headers: H(token) });
  assert.equal(del.status, 403);
  // test (probe diagnostica, NON mutante) NON gated: passa il gate e fallisce solo
  // perche' il nodo non esiste (404, non 403).
  assert.equal((await post('nodes/ghost/test')).status, 404, 'test non deve essere bloccato dal READONLY');
  // up/down/restart SONO mutanti di processo (§4b(6)): 403 PRIMA del dispatch.
  for (const a of ['up', 'down', 'restart']) {
    const r = await post(`nodes/ghost/${a}`);
    assert.equal(r.status, 403, `${a} deve essere 403 in READONLY (mutante di processo §4b(6))`);
    assert.match((await r.json()).error, /READONLY/);
  }
  // read-only sempre disponibile
  assert.equal((await fetch(`${base}/api/settings`, { headers: H(token) })).status, 200);
});

test('F6 READONLY: up/down/restart -> 403 e NESSUNO spawn/kill (contract §4b(6))', async (t) => {
  let spawnCalls = 0;
  const { base, token, home, nodesPath } = await boot(t, { readonlyDefault: true }, {
    spawnImpl: () => { spawnCalls += 1; return { pid: DEAD_PID, unref() {} }; },
  });
  // seed diretto dello store (addNode sarebbe gated in READONLY)
  let st = nodesStore.loadStore(nodesPath) || nodesStore.emptyStore();
  st = nodesStore.addNode(st, { name: 'beta', ssh: 'user@host-b', remotePort: 41820, localPort: 43150, keyPath: '/tmp/kbeta', roles: { client: true, node: false } });
  nodesStore.atomicWriteStore(nodesPath, st);
  // tunnel finto "up" con PID MORTO: se down fosse eseguito (bug), killPidfile
  // rimuoverebbe il pidfile stale -> lo useremmo come discriminante (mai pid vivi).
  fs.mkdirSync(nodesTunnel.tunnelDir(home), { recursive: true });
  pidf.writePidfile(nodesTunnel.tunnelPidPath(home, 'beta'), DEAD_PID, '');
  const pidPath = nodesTunnel.tunnelPidPath(home, 'beta');

  const act = (a) => fetch(`${base}/api/settings/nodes/beta/${a}`, { method: 'POST', headers: H(token) });
  for (const a of ['up', 'down', 'restart']) {
    const r = await act(a);
    assert.equal(r.status, 403, `${a} deve dare 403 in READONLY`);
    assert.match((await r.json()).error, /READONLY/);
  }
  assert.equal(spawnCalls, 0, 'nessuno spawn sotto READONLY (up/restart gated prima del dispatch)');
  assert.ok(fs.existsSync(pidPath), 'down gated: il tunnel non e\' stato fermato/killato (pidfile intatto)');
});

// --- Redazione: NESSUNA risposta dell'intera settings API contiene token ------------

test('redazione: sweep di TUTTI gli endpoint con token noti -> mai in risposta', async (t) => {
  const KNOWN = 'KNOWN-REMOTE-TOKEN-c8f2a1b7d4e5';
  const { base, token, home, nodesPath, tokenPath } = await boot(t, {}, {
    httpProbe: async () => ({ ok: true, status: 200 }),
  });

  // fixture: nodo con token remoto NOTO + tunnel finto up (per il ramo test autenticato)
  assert.equal((await addNode(base, token, 'alpha')).status, 200);
  let st = nodesStore.loadStore(nodesPath);
  st = nodesStore.setNodeToken(st, 'alpha', KNOWN);
  nodesStore.atomicWriteStore(nodesPath, st);
  fakeTunnelUp(home, 'alpha');

  const responses = [];
  const call = async (method, p, body) => {
    const r = await fetch(`${base}/api/settings${p}`, {
      method, headers: H(token), body: body === undefined ? undefined : JSON.stringify(body),
    });
    responses.push({ where: `${method} ${p} [${r.status}]`, text: await r.text() });
  };

  await call('GET', '');
  await call('POST', '/config', { roles: { client: true }, wizardDone: true });
  await call('POST', '/nodes', { name: 'beta', ssh: 'user@host-beta' });
  await call('POST', '/nodes/alpha/test');
  await call('POST', '/nodes/beta/up');
  await call('POST', '/nodes/beta/down');
  await call('POST', '/nodes/beta/restart');
  await call('POST', '/node-role', { enabled: true, rendezvousSsh: 'user@host', publishedPort: 45002 });
  await call('POST', '/node-role', { enabled: false });
  await call('POST', '/service/regenerate');
  await call('DELETE', '/nodes/beta');
  await call('POST', '/token/rotate');
  await call('GET', ''); // vista finale post-mutazioni
  // errori inclusi: nemmeno le failure devono veicolare segreti
  await call('POST', '/nodes', { name: 'alpha', ssh: 'user@host-alpha' }); // 409
  await call('POST', '/config', { port: 'garbage' });                    // 400

  const localToken = token;                                  // Bearer locale della sessione
  const rotated = fs.readFileSync(tokenPath, 'utf8').trim(); // nuovo token post-rotate
  for (const { where, text } of responses) {
    assert.ok(!text.includes(KNOWN), `token remoto in risposta: ${where}`);
    assert.ok(!text.includes(localToken), `token locale in risposta: ${where}`);
    assert.ok(!text.includes(rotated), `token ruotato in risposta: ${where}`);
    assert.ok(!/"token"\s*:/.test(text), `chiave "token" in risposta: ${where}`);
  }
});
