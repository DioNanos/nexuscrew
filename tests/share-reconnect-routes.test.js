'use strict';
// tests/share-reconnect-routes.test.js — P0 Share/reconnect, lato routes.
// Una stessa Share ON (stato persistito gia shared=true) deve:
//   - accelerare soltanto un supervisor "degraded" verificabilmente posseduto,
//     forzando un restart locale per ritentare il -R subito invece di attendere
//     il retry fisso; senza revocare sul hub e senza cambiare l'intento condiviso.
//   - restare idempotente su un tunnel healthy (nessun restart).
// NIENTE processi/SSH reali: stop/start sono seam, fetch federation e' mockata.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const nodesTunnel = require('../lib/nodes/tunnel.js');
const pidf = require('../lib/cli/pidfile.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function boot(t, over = {}, seams = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncshare-r-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const settingsSeams = {
    platform: 'linux', uid: 1000,
    execImpl: () => { throw new Error('exec disabled in test'); },
    serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
    keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
    spawnImpl: () => ({ pid: 4193999, unref() {} }),
    sshVersion: () => ({ major: 9, minor: 6 }),
    ...seams,
  };
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), port: 41999,
    fleetEnabled: false, settingsSeams, ...over,
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

// mock fetch: /federation/health -> healthy con instanceId atteso; /federation/share -> ok.
function mockFetch(expectedInstance) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.endsWith('/federation/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: expectedInstance }) };
    }
    if (url.endsWith('/federation/share')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 599, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

async function setupShare(t, sidecarStatus, seamOverrides = {}) {
  const stopped = [];
  const started = [];
  const expectedInstance = 'a'.repeat(32);
  const fetchImpl = mockFetch(expectedInstance);
  const ctx = await boot(t, {}, {
    stopTunnelImpl: (o) => { stopped.push(o); return { stopped: true }; },
    startForwardImpl: (o) => { started.push(o); return { started: false, reason: 'already running', pid: 4242 }; },
    fetchImpl,
    ...seamOverrides,
  });
  assert.equal((await addNode(ctx.base, ctx.token, 'hub', { ssh: 'user@hub' })).status, 200);
  let st = nodesStore.loadStoreStrict(ctx.nodesPath);
  st = nodesStore.updateNode(st, 'hub', {
    direction: 'outbound', shared: true,
    localPort: 43001, remotePort: 41820, reversePort: 44001,
    token: 't'.repeat(48), nodeId: expectedInstance,
  });
  nodesStore.atomicWriteStore(ctx.nodesPath, st);
  // Supervisor "vivo": un child idle il cui cmdline contiene 'tunnel-supervisor.js'
  // (isAlive verifica il cmd anti-PID-reuse, quindi il pid del test runner non
  // basta). MAI ssh o processi tunnel reali qui.
  fs.mkdirSync(nodesTunnel.tunnelDir(ctx.home), { recursive: true });
  const fakeSup = path.join(ctx.home, 'fake-tunnel-supervisor.js');
  fs.writeFileSync(fakeSup, "setInterval(() => {}, 1e9);\n", { mode: 0o700 });
  const supChild = spawn(process.execPath, [fakeSup], { stdio: 'ignore' });
  t.after(() => { try { supChild.kill('SIGKILL'); } catch (_) {} });
  pidf.writePidfile(nodesTunnel.tunnelPidPath(ctx.home, 'hub'), supChild.pid, 'tunnel-supervisor.js', { runId: 'gen' });
  fs.writeFileSync(nodesTunnel.tunnelStatePath(ctx.home, 'hub'), JSON.stringify({
    status: sidecarStatus, code: 'reverse-forward-bind', detail: 'bind occupata', hint: 'verifica listener',
    reversePort: 44001, ownership: 'self', steadyRetryMs: 60000, terminal: false,
    supervisorPid: supChild.pid, runId: 'gen', attempt: 3, transport: 'ssh',
  }));
  return { ...ctx, stopped, started, fetchImpl };
}

const shareOn = (base, token, name) =>
  fetch(`${base}/api/settings/nodes/${name}/share`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ shared: true }),
  });

test('same-state Share ON accelera un supervisor degraded posseduto: restart locale, nessuna revoca hub', async (t) => {
  const { base, token, stopped, fetchImpl } = await setupShare(t, 'degraded');
  const r = await shareOn(base, token, 'hub');
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.shared, true, 'Share resta ON (nessun OFF)');
  assert.equal(body.accelerated, true, 'il supervisor degraded viene accelerato');
  assert.equal(stopped.length, 1, 'restart locale: stop del supervisor chiamato (e non start idempotente)');
  const healthIndex = fetchImpl.calls.findIndex((c) => c.url.endsWith('/federation/health'));
  const shareIndex = fetchImpl.calls.findIndex((c) => c.url.endsWith('/federation/share'));
  assert.ok(healthIndex >= 0, 'il restart deve attendere la health autenticata');
  assert.ok(healthIndex < shareIndex, 'la health autenticata precede la pubblicazione Share');
  const shareCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/federation/share'));
  assert.ok(shareCalls.length >= 1, 'il hub viene (ri)annunciato');
  assert.ok(shareCalls.every((c) => /"shared":true/.test(c.body || '')), 'nessuna revoca: tutte le chiamate share sono shared=true');
});

test('same-state Share ON degraded fallisce chiuso se il restart locale non parte: nessun annuncio hub', async (t) => {
  const { base, token, fetchImpl } = await setupShare(t, 'degraded', {
    startForwardImpl: () => ({ started: false, reason: 'spawn error' }),
  });
  const r = await shareOn(base, token, 'hub');
  const body = await r.json();
  assert.equal(r.status, 502);
  assert.match(body.error, /Share non attivato/);
  const shareCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/federation/share'));
  assert.equal(shareCalls.length, 0, 'un restart fallito non puo pubblicare Share sul hub');
});

test('same-state Share ON su tunnel healthy resta idempotente: nessun restart', async (t) => {
  const { base, token, stopped } = await setupShare(t, 'transport-ready');
  const r = await shareOn(base, token, 'hub');
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.shared, true);
  assert.equal(body.reconciled, true, 'un tunnel healthy resta idempotente (reconciled)');
  assert.equal(body.accelerated, undefined, 'un tunnel healthy non va accelerato');
  assert.equal(stopped.length, 0, 'nessun restart su tunnel healthy');
});
