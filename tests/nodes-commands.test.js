'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cmds = require('../lib/nodes/commands.js');
const store = require('../lib/nodes/store.js');
const tunnel = require('../lib/nodes/tunnel.js');
const peering = require('../lib/nodes/peering.js');
const pidf = require('../lib/cli/pidfile.js');
const { status, doctor, dispatch } = require('../lib/cli/commands.js');

function nodeHome({ init = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ncmd-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  if (init) store.initStore(path.join(home, '.nexuscrew', 'nodes.json'));
  return home;
}
const nodesPathFor = (home) => path.join(home, '.nexuscrew', 'nodes.json');
const FAKE_PUB = 'ssh-ed25519 AAAAFAKEKEY nexuscrew-tunnel';
const keygenSeam = () => FAKE_PUB;

// --- nodes add --------------------------------------------------------------

test('nodes add: scrive nodes.json 0600 + stampa authorized_keys forward (permitopen)', () => {
  const home = nodeHome();
  const l = [];
  const r = cmds.nodesAdd({ home, log: (m) => l.push(m), name: 'vps', ssh: 'user@example.com', remotePort: 41820, keygen: keygenSeam });
  assert.equal(r.code, 0);
  const p = nodesPathFor(home);
  assert.equal(fs.lstatSync(p).mode & 0o777, 0o600);
  const st = store.loadStore(p);
  assert.equal(st.nodes[0].name, 'vps');
  assert.equal(st.nodes[0].localPort, 43001); // prima porta stabile
  const out = l.join('\n');
  assert.ok(out.includes('restrict,port-forwarding,permitopen="127.0.0.1:41820",command="/bin/false"'));
  assert.ok(out.includes(FAKE_PUB));
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes add: READONLY blocca, nessun file scritto', () => {
  const home = nodeHome({ init: false });
  process.env.NEXUSCREW_READONLY = '1';
  const r = cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@h', keygen: keygenSeam });
  delete process.env.NEXUSCREW_READONLY;
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'readonly');
  assert.ok(!fs.existsSync(nodesPathFor(home)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes add: store mancante fallisce 503 senza inizializzarlo implicitamente', () => {
  const home = nodeHome({ init: false });
  const out = cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@h', keygen: keygenSeam });
  assert.equal(out.code, 1);
  assert.equal(out.status, 503);
  assert.equal(out.errorCode, 'NODES_STORE_MISSING');
  assert.equal(fs.existsSync(nodesPathFor(home)), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes add: nome duplicato e self-reference rifiutati', () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@h', keygen: keygenSeam });
  const dup = cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@h2', keygen: keygenSeam });
  assert.equal(dup.code, 1);
  // self-reference: nodeId == quello dell'installazione
  const ownId = store.loadStore(nodesPathFor(home)).nodeId;
  const self = cmds.nodesAdd({ home, log: () => {}, name: 'me', ssh: 'user@h3', nodeId: ownId, keygen: keygenSeam });
  assert.equal(self.code, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes add: Host alias valido; target argv ostile rifiutato', () => {
  const home = nodeHome();
  const l = [];
  const r = cmds.nodesAdd({ home, log: (m) => l.push(m), name: 'vps', ssh: 'nohost', keygen: keygenSeam });
  assert.equal(r.code, 0);
  const bad = cmds.nodesAdd({ home, log: () => {}, name: 'bad', ssh: '-oProxyCommand=evil' });
  assert.equal(bad.code, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('pairing port reservation: salta una porta realmente occupata dal sistema operativo', async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  t.after(() => { try { occupied.close(); } catch (_) {} });
  const start = occupied.address().port;
  if (start === 65535) return;
  const reservation = await cmds.reserveLocalPort({ nodes: [] }, { start });
  assert.notEqual(reservation.port, start);
  assert.ok(reservation.port > start);
  await reservation.release();
  await reservation.release(); // idempotente
});

// --- nodes list -------------------------------------------------------------

test('nodes list --json: redatto (hasToken, mai il token) + stato tunnel', () => {
  const home = nodeHome();
  let st = store.addNode(store.emptyStore(), { name: 'vps', ssh: 'user@h', remotePort: 41820, localPort: 43001, keyPath: '/k' });
  st = store.setNodeToken(st, 'vps', 'SUPER-SECRET-TOKEN');
  store.atomicWriteStore(nodesPathFor(home), st);
  const l = [];
  const r = cmds.nodesList({ home, log: (m) => l.push(m), json: true });
  assert.equal(r.code, 0);
  const out = l.join('\n');
  assert.ok(!out.includes('SUPER-SECRET-TOKEN'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.nodes[0].hasToken, true);
  assert.equal(parsed.nodes[0].token, undefined);
  assert.equal(parsed.nodes[0].tunnel.status, 'down');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- nodes remove -----------------------------------------------------------

test('nodes remove: rimuove; READONLY blocca', () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@h', keygen: keygenSeam });
  process.env.NEXUSCREW_READONLY = '1';
  assert.equal(cmds.nodesRemove({ home, log: () => {}, name: 'vps' }).code, 1);
  delete process.env.NEXUSCREW_READONLY;
  assert.equal(cmds.nodesRemove({ home, log: () => {}, name: 'vps' }).code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('F4 nodes remove: ferma un tunnel ATTIVO prima di rimuovere la config (no orphan)', async () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  // tunnel "up" reale: figlio sleep detached + pidfile col suo pid (cmd matcha).
  const { spawn } = require('node:child_process');
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  const childPid = child.pid;
  pidf.writePidfile(tunnel.tunnelPidPath(home, 'vps'), childPid, 'sleep 30');
  const exited = new Promise((res) => {
    child.on('exit', () => res(true));
    setTimeout(() => res(false), 2000);
  });
  const r = cmds.nodesRemove({ home, log: () => {}, name: 'vps' });
  assert.equal(r.code, 0);
  assert.equal(r.stopped, true, 'nodesRemove ha fermato il tunnel attivo (killPidfile killed:true)');
  assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 0, 'nodo rimosso dalla config');
  assert.ok(!fs.existsSync(tunnel.tunnelPidPath(home, 'vps')), 'pidfile del tunnel rimosso');
  assert.equal(await exited, true, 'il tunnel figlio e\' stato realmente terminato (no orphan)');
  try { process.kill(childPid, 'SIGKILL'); } catch (_) { /* giÃ  morto */ }
  fs.rmSync(home, { recursive: true, force: true });
});

test('F4 nodes remove: se lo stop fallisce preserva la config', () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  const original = tunnel.stopTunnel;
  tunnel.stopTunnel = () => ({ stopped: false, reason: 'operation not permitted' });
  try {
    const r = cmds.nodesRemove({ home, log: () => {}, name: 'vps' });
    assert.equal(r.code, 1);
    assert.equal(r.reason, 'tunnel stop failed');
    assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 1);
  } finally {
    tunnel.stopTunnel = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- nodes set-token --------------------------------------------------------

test('nodes set-token: salva (da opts.token), non stampa il token, READONLY blocca', () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@h', keygen: keygenSeam });
  process.env.NEXUSCREW_READONLY = '1';
  assert.equal(cmds.nodesSetToken({ home, log: () => {}, name: 'vps', token: 'X' }).code, 1);
  delete process.env.NEXUSCREW_READONLY;
  const l = [];
  const r = cmds.nodesSetToken({ home, log: (m) => l.push(m), name: 'vps', token: 'ROTATED-REMOTE-TOKEN' });
  assert.equal(r.code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].token, 'ROTATED-REMOTE-TOKEN');
  assert.ok(!l.join('\n').includes('ROTATED-REMOTE-TOKEN')); // mai stampato
  fs.rmSync(home, { recursive: true, force: true });
});

// --- nodes test (NON-mutante): 3 failure distinte ---------------------------

function seedNode(home, { token } = {}) {
  let st = store.addNode(store.emptyStore(), { name: 'vps', ssh: 'user@h', remotePort: 41820, localPort: 43001, keyPath: '/k' });
  if (token) st = store.setNodeToken(st, 'vps', token);
  store.atomicWriteStore(nodesPathFor(home), st);
}
function markTunnelUp(home, name) {
  // pidfile vivo con cmd vuoto -> isAlive true senza match cmdline (self pid)
  pidf.writePidfile(tunnel.tunnelPidPath(home, name), process.pid, '');
}

function seedInbound(home, { shared = true, token = 'T' } = {}) {
  const st = store.addNode(store.emptyStore(), {
    name: 'mac', remotePort: 41820, localPort: 44001,
    direction: 'inbound', transport: 'inbound', autostart: false,
    shared, token, nodeId: 'b'.repeat(32), roles: { client: true, node: true }, rolesKnown: true,
  });
  store.atomicWriteStore(nodesPathFor(home), st);
}

test('nodes test: tunnel DOWN', async () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  const lines = [];
  const r = await cmds.nodesTest({ home, log: (x) => lines.push(x), name: 'vps', httpProbe: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.result, 'tunnel-down');
  assert.equal(r.code, 1);
  assert.doesNotMatch(lines.join('\n'), /nexuscrew nodes|nexuscrew up/);
  assert.match(lines.join('\n'), /PWA/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes test: HEALTH KO (tunnel up, / non risponde)', async () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  markTunnelUp(home, 'vps');
  const r = await cmds.nodesTest({ home, log: () => {}, name: 'vps', httpProbe: async (url) => (url.endsWith('/') ? { ok: false, status: 0 } : { ok: true, status: 200 }) });
  assert.equal(r.result, 'health-ko');
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes test: TOKEN KO (health ok, /api/config 401)', async () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  markTunnelUp(home, 'vps');
  const r = await cmds.nodesTest({ home, log: () => {}, name: 'vps', httpProbe: async (url) => (url.endsWith('/api/config') ? { ok: false, status: 401 } : { ok: true, status: 200 }) });
  assert.equal(r.result, 'token-ko');
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes test: OK e token-missing', async () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  markTunnelUp(home, 'vps');
  const ok = await cmds.nodesTest({ home, log: () => {}, name: 'vps', httpProbe: async (url) => (url.endsWith('/api/config') ? { ok: true, status: 200 } : { ok: true, status: 200 }) });
  assert.equal(ok.result, 'ok');
  assert.equal(ok.code, 0);
  // token assente -> token-missing
  const home2 = nodeHome();
  seedNode(home2, {}); // niente token
  markTunnelUp(home2, 'vps');
  const tm = await cmds.nodesTest({ home: home2, log: () => {}, name: 'vps', httpProbe: async () => ({ ok: true, status: 200 }) });
  assert.equal(tm.result, 'token-missing');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(home2, { recursive: true, force: true });
});

test('nodes test: nodo sconosciuto -> code 1', async () => {
  const home = nodeHome();
  const r = await cmds.nodesTest({ home, log: () => {}, name: 'ghost', httpProbe: async () => ({ ok: true, status: 200 }) });
  assert.equal(r.result, 'unknown-node');
  fs.rmSync(home, { recursive: true, force: true });
});

test('nodes test: inbound usa la health federation, non un pidfile locale o /api/config', async () => {
  const home = nodeHome(); seedInbound(home);
  let calls = 0;
  const ok = await cmds.nodesTest({
    home, log: () => {}, name: 'mac',
    federationProbe: async (opts) => {
      calls += 1;
      assert.equal(opts.port, 44001);
      assert.equal(opts.expectedInstanceId, 'b'.repeat(32));
      return { status: 'healthy', transport: 'up', auth: 'ok', reachability: 'ok' };
    },
    httpProbe: async () => { throw new Error('/api/config must not be used for inbound peers'); },
  });
  assert.equal(calls, 1);
  assert.equal(ok.code, 0);
  assert.equal(ok.result, 'ok');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- nodes up/down (spawn mockato) -----------------------------------------

test('nodes up/down: spawn SSH e persistenza autostart quando richiesto dalla PWA', () => {
  const home = nodeHome();
  seedNode(home, { token: 'T' });
  const calls = [];
  const r = cmds.nodesUp({ home, log: () => {}, name: 'vps', logFd: null, spawnImpl: (bin, args) => { calls.push([bin, args]); return { pid: 999999999, unref() {} }; } });
  assert.equal(r.code, 0);
  assert.equal(calls[0][0], process.execPath);
  assert.ok(calls[0][1][0].endsWith('tunnel-supervisor.js'));
  assert.ok(calls[0][1].includes('-L') && calls[0][1].includes('127.0.0.1:43001:127.0.0.1:41820'));
  // la config nodes.json e' intatta dopo up
  assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 1);
  const d = cmds.nodesDown({ home, log: () => {}, name: 'vps', persistAutostart: true });
  assert.equal(d.code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].autostart, false);
  const again = cmds.nodesUp({ home, log: () => {}, name: 'vps', persistAutostart: true, logFd: null,
    spawnImpl: (bin, args) => { calls.push([bin, args]); return { pid: 999999998, unref() {} }; } });
  assert.equal(again.code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].autostart, true);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- integrazione A2: status --json + doctor -------------------------------

test('status --json: nodes[] con stato tunnel reale, token REDATTI', () => {
  const home = nodeHome();
  let st = store.addNode(store.emptyStore(), { name: 'vps', ssh: 'user@h', remotePort: 41820, localPort: 43001, keyPath: '/k' });
  st = store.setNodeToken(st, 'vps', 'STATUS-SECRET-TOKEN');
  store.atomicWriteStore(nodesPathFor(home), st);
  const l = [];
  status({ home, platform: 'linux', json: true, log: (m) => l.push(m), execImpl: () => { throw new Error('inactive'); } });
  const out = l.join('\n');
  assert.ok(!out.includes('STATUS-SECRET-TOKEN'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].name, 'vps');
  assert.equal(parsed.nodes[0].hasToken, true);
  assert.equal(parsed.nodes[0].tunnel.status, 'down');
  assert.equal(parsed.nodes[0].token, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: riporta SSH/autossh usati senza fingere di certificare lo sshd remoto', () => {
  const home = nodeHome();
  fs.writeFileSync(path.join(home, '.nexuscrew', 'token'), 'TOK\n', { mode: 0o600 });
  const svc = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  fs.mkdirSync(path.dirname(svc), { recursive: true });
  fs.writeFileSync(svc, `WorkingDirectory=${home}\n`);
  const common = {
    home, platform: 'linux', installPath: svc, fleetEnabled: false, log: () => {},
    execImpl: (b, a) => { if (a && a.includes('is-active')) return 'active'; if (a && a.includes('is-enabled')) return 'enabled'; if (a && a.includes('--property=KillMode')) return 'process'; return ''; },
    ptyLoad: () => ({ spawn() {} }),
    commandExists: () => true,
  };
  const good = doctor({ ...common, sshVersion: () => ({ stdout: '', stderr: 'OpenSSH_9.6p1\n' }) });
  assert.ok(good.checks.some((c) => c.name.includes('OpenSSH') && c.ok && /USATO/.test(c.detail)));
  assert.ok(good.checks.some((c) => c.name === 'autossh' && /NON usato/.test(c.detail)));
  assert.ok(good.checks.some((c) => c.name === 'OpenSSH version' && c.ok));
  assert.equal(good.code, 0);
  const old = doctor({ ...common, sshVersion: () => ({ stdout: '', stderr: 'OpenSSH_7.2p2\n' }) });
  assert.ok(old.checks.some((c) => c.name === 'OpenSSH version' && c.ok));
  assert.equal(old.code, 0, 'la versione locale non prova nega la policy del server');
  const missing = doctor({ ...common, commandExists: (bin) => !['ssh', 'autossh'].includes(bin), sshVersion: () => ({ error: { code: 'ENOENT' } }) });
  assert.ok(missing.checks.some((c) => c.name.includes('OpenSSH') && !c.ok));
  assert.ok(missing.checks.some((c) => c.name === 'autossh' && c.warn));
  assert.equal(missing.code, 1);
  const noAutossh = doctor({ ...common, commandExists: (bin) => bin !== 'autossh' });
  assert.equal(noAutossh.code, 0, 'autossh non e un requisito quando SSH e supervisionato');
  assert.ok(noAutossh.checks.some((c) => c.name === 'autossh' && c.warn && /opzionale/.test(c.detail)));
  const autosshCannotReplaceSsh = doctor({ ...common, commandExists: (bin) => bin !== 'ssh' });
  assert.equal(autosshCannotReplaceSsh.code, 1, 'autossh presente non sostituisce il binario ssh obbligatorio');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- dispatch wiring --------------------------------------------------------

test('dispatch: gestione nodes pubblica con remove esplicitamente confermato', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  const logs = [];
  assert.equal((await dispatch(['nodes', 'list', '--json'], { home, log: (m) => logs.push(m) })).code, 0);
  const listed = JSON.parse(logs.join('\n'));
  assert.equal(listed.peers[0].name, 'vps');
  assert.equal(listed.peers[0].actions.remove, true);
  assert.equal((await dispatch(['nodes', 'remove', 'vps'], { home, log: () => {} })).code, 1);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 1);
  assert.equal((await dispatch(['nodes', 'remove', 'vps', '--yes'], { home, log: () => {} })).code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes edit: risolve nodeId e READONLY blocca lifecycle e config', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', nodeId: 'b'.repeat(32), keygen: keygenSeam });
  assert.equal((await dispatch(['nodes', 'edit', 'b'.repeat(32), '--label', 'Asus Hub'], { home, log: () => {} })).code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].label, 'Asus Hub');
  process.env.NEXUSCREW_READONLY = '1';
  try {
    assert.equal((await dispatch(['nodes', 'edit', 'vps', '--label', 'Blocked'], { home, log: () => {} })).code, 1);
    assert.equal((await dispatch(['nodes', 'down', 'vps'], { home, log: () => {} })).code, 1);
  } finally { delete process.env.NEXUSCREW_READONLY; }
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].label, 'Asus Hub');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes aliases: show/rename/visibility/doctor usano il dominio canonico', async () => {
  const home = nodeHome();
  let st = store.loadStore(nodesPathFor(home));
  st = store.addNode(st, {
    name: 'asus', remotePort: 41820, localPort: 44001,
    direction: 'inbound', transport: 'inbound', autostart: false,
    visibility: 'network', nodeId: 'c'.repeat(32), token: 'PEER', acceptToken: 'ACCEPT',
  });
  store.atomicWriteStore(nodesPathFor(home), st);

  assert.equal((await dispatch(['nodes', 'show', 'c'.repeat(32)], { home, log: () => {} })).code, 0);
  assert.equal((await dispatch(['nodes', 'rename', 'c'.repeat(32), '--label', 'AsusRP3'], { home, log: () => {} })).code, 0);
  assert.equal((await dispatch(['nodes', 'visibility', 'asus', 'relay-only'], { home, log: () => {} })).code, 0);
  const saved = store.loadStore(nodesPathFor(home)).nodes[0];
  assert.equal(saved.label, 'AsusRP3');
  assert.equal(saved.visibility, 'relay-only');

  const logs = [];
  assert.equal((await dispatch(['doctor', '--peers', '--json'], { home, log: (line) => logs.push(line) })).code, 0);
  const report = JSON.parse(logs.join('\n'));
  assert.equal(report.checks[0].result, 'passive');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes share risolve nodeId e usa PATCH locale senza segreti in argv', async () => {
  const home = nodeHome();
  cmds.nodesAdd({
    home, log: () => {}, name: 'hub', ssh: 'user@example.com',
    nodeId: 'd'.repeat(32), keygen: keygenSeam,
  });
  const calls = [];
  const out = await dispatch(['nodes', 'share', 'd'.repeat(32), 'on'], {
    home, log: () => {},
    localApiImpl: async (pathname, body, request) => {
      calls.push({ pathname, body, request });
      return { name: 'hub', shared: true };
    },
  });
  assert.equal(out.code, 0);
  assert.deepEqual(calls, [{
    pathname: '/api/settings/nodes/hub/share',
    body: { shared: true }, request: { method: 'PATCH' },
  }]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes invite/pair: link passa via stdout/stdin, mai come argv', async () => {
  const inviteHome = nodeHome();
  const link = peering.createInvite({
    invitesPath: path.join(inviteHome, '.nexuscrew', 'invites.json'),
    instanceId: 'a'.repeat(32), port: 41777, linkPort: 41777,
    label: 'Asus', name: 'asus', ssh: 'asus-vps',
  }).pairingUrl;
  const calls = [];
  const inviteLogs = [];
  const invited = await dispatch(['nodes', 'invite', '--ssh', 'asus-vps'], {
    log: (x) => inviteLogs.push(x),
    localApiImpl: async (pathname, body) => { calls.push([pathname, body]); return { pairingUrl: link, expiresAt: Date.now() + 1000 }; },
  });
  assert.equal(invited.code, 0);
  assert.equal(calls[0][0], '/api/settings/peering/invite');
  assert.match(inviteLogs[0], /#pair=/);
  const paired = await dispatch([
    'nodes', 'pair', '--local-label', 'AsusRP3', '--local-name', 'asus-rp3-5bd6',
  ], {
    stdin: `${link.slice(0, 20)}\r\n${link.slice(20)}`, log: () => {},
    localApiImpl: async (pathname, body) => { calls.push([pathname, body]); return { name: body.name, instanceId: 'a'.repeat(32) }; },
  });
  assert.equal(paired.code, 0);
  assert.equal(calls[1][0], '/api/settings/nodes/pair');
  assert.equal(calls[1][1].pairingUrl, link);
  assert.equal(calls[1][1].localLabel, 'AsusRP3');
  assert.equal(calls[1][1].localName, 'asus-rp3-5bd6');
  const joined = await dispatch(['nodes', 'join'], {
    stdin: link, log: () => {},
    localApiImpl: async () => ({ name: 'asus', instanceId: 'a'.repeat(32) }),
  });
  assert.equal(joined.code, 0);
  fs.rmSync(inviteHome, { recursive: true, force: true });
});
