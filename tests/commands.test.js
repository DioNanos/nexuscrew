'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const { atomicWrite: writeFleet } = require('../lib/fleet/definitions.js');
const { defaultDefinitions } = require('../lib/fleet/managed.js');
const { dispatch, serve, start, stop, status, parseFlags, HELP,
  smartUp, url, tokenRotate, logs, update, doctor, restart,
  findAvailablePort, openPwa, startPortable, stopManagedTunnels } = require('../lib/cli/commands.js');

// Home "inizializzata" (config.json + token) per i test url/status/token/logs. [A2]
function initHome(port = 41822, token = 'SECRETTOKEN12345') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-a2-'));
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
  writeFleet(path.join(dir, 'fleet.json'), defaultDefinitions());
  return { home, token, port };
}

function portableFixture(home) {
  const code = 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  const pidPath = path.join(home, '.nexuscrew', 'nexuscrew.pid');
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} -e ${code}`);
  return { child, pidPath };
}

function childExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

// --- parseFlags ---

test('parseFlags: --dry-run, --port=N, --pidfile, rest', () => {
  const r = parseFlags(['init', '--dry-run', '--port=41820']);
  assert.equal(r.rest[0], 'init');
  assert.equal(r.flags['dry-run'], true);
  assert.equal(r.flags.port, '41820');
  const r2 = parseFlags(['serve', '--pidfile']);
  assert.equal(r2.flags.pidfile, true);
});

// --- dispatch help/unknown ---

test('dispatch: help -> code 0, stampa HELP', () => {
  const logs = [];
  const r = dispatch(['help'], { log: (m) => logs.push(m) });
  assert.equal(r.code, 0);
  assert.ok(logs.join('\n').includes('Usage'));
  const long = [];
  assert.equal(dispatch(['--help'], { log: (m) => long.push(m) }).code, 0);
  assert.ok(long.join('\n').includes('nexuscrew show'));
  const version = [];
  assert.equal(dispatch(['--version'], { log: (m) => version.push(m) }).code, 0);
  assert.equal(version[0], require('../package.json').version);
  assert.equal(dispatch(['--bogus'], { log: () => {} }).code, 1);
});

test('dispatch: init e pubblico, idempotente e inoltra dry-run/port senza tmux runtime', () => {
  const calls = [];
  const opts = {
    log: () => {},
    runInitImpl: (value) => { calls.push(value); return { actions: [] }; },
  };
  assert.equal(dispatch(['init', '--dry-run', '--port', '41923'], opts).code, 0);
  assert.equal(dispatch(['init'], opts).code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].port, 41923);
  assert.equal(calls[1].dryRun, false);
  assert.equal(calls[1].port, undefined);
  assert.match(HELP, /nexuscrew init/);
  assert.equal(dispatch(['init', '--port', '70000'], opts).code, 1);
  assert.equal(calls.length, 2, 'porta invalida non deve invocare init');
});

test('dispatch: no args -> background, mini summary senza token + wizard solo al primo avvio', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-smartup-'));
  const logs = [];
  const opened = [];
  const r = await dispatch([], {
    log: (m) => logs.push(m),
    home, platform: 'linux', tmuxOk: true,
    execImpl: (_b, a) => { if (a && a.includes('is-active')) return 'active'; return ''; },
    spawnImpl: () => ({ unref() {} }),
    portAvailableImpl: async () => true,
    probeImpl: async () => true,
    openImpl: (u) => { opened.push(u); return true; },
  });
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'config.json')));
  assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'token')));
  const tok = fs.readFileSync(path.join(home, '.nexuscrew', 'token'), 'utf8').trim();
  assert.match(logs.join('\n'), /server  .*running/);
  assert.match(logs.join('\n'), /nexuscrew show token/);
  assert.equal(logs.join('\n').includes(tok), false);
  assert.equal(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service')), false, 'boot is opt-in');
  assert.equal(opened.length, 1);
  assert.ok(opened[0].includes(`#token=${tok}`));
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up configurato: avvia/riusa in background senza aprire; show apre', async () => {
  const { home } = initHome();
  const cp = path.join(home, '.nexuscrew', 'config.json');
  fs.writeFileSync(cp, JSON.stringify({ port: 41822, wizardDone: true }) + '\n', { mode: 0o600 });
  const opened = [];
  const common = {
    home, platform: 'linux', probeImpl: async () => true,
    execImpl: () => 'active', openImpl: (u) => { opened.push(u); }, log: () => {},
  };
  const background = await dispatch([], common);
  assert.equal(background.code, 0);
  assert.equal(opened.length, 0);
  const shown = await dispatch(['show'], common);
  assert.equal(shown.code, 0);
  assert.equal(opened.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up ripara fleet.json mancante e riavvia un runtime gia vivo', async () => {
  const { home } = initHome();
  const fleetPath = path.join(home, '.nexuscrew', 'fleet.json');
  fs.unlinkSync(fleetPath);
  let restarts = 0;
  const r = await smartUp({
    home, platform: 'linux', probeImpl: async () => true,
    execImpl: () => { throw new Error('inactive'); },
    restartImpl: () => { restarts += 1; return { restarted: true }; },
    waitAttempts: 1,
  });
  assert.equal(r.running, true);
  assert.equal(restarts, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(fleetPath, 'utf8')).engines.map((engine) => engine.id),
    ['claude.native', 'codex.native', 'codex-vl.native', 'pi.native', 'shell.local'],
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up migra una service definition 0.8.0 che pinna NEXUSCREW_PORT', async () => {
  const { home } = initHome();
  const cp = path.join(home, '.nexuscrew', 'config.json');
  fs.writeFileSync(cp, JSON.stringify({ port: 41822, wizardDone: true }) + '\n', { mode: 0o600 });
  const servicePath = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(servicePath, '[Service]\nEnvironment=NEXUSCREW_PORT=41822\n');
  await smartUp({
    home, platform: 'linux', installPath: servicePath, tmuxOk: true,
    execImpl: (_bin, args) => (args?.includes('is-active') ? 'active' : (args?.includes('is-enabled') ? 'enabled' : '')),
    probeImpl: async () => true,
  });
  assert.doesNotMatch(fs.readFileSync(servicePath, 'utf8'), /NEXUSCREW_PORT/);
  assert.equal(JSON.parse(fs.readFileSync(cp, 'utf8')).port, 41822);
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up migra cwd Termux:Boot legacy e riavvia una sola volta', async () => {
  const { home } = initHome();
  const script = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '#!/bin/sh\ncd -- "$HOME/.nexuscrew"\n');
  let initCalls = 0;
  let restartCalls = 0;
  const r = await smartUp({
    home, platform: 'termux', installPath: script, noOpen: true,
    runInitImpl: () => {
      initCalls += 1;
      fs.writeFileSync(script, '#!/bin/sh\ncd -- "$HOME"\n');
    },
    restartImpl: () => { restartCalls += 1; return { restarted: true }; },
    probeImpl: async () => true,
  });
  assert.equal(r.running, true);
  assert.equal(initCalls, 1);
  assert.equal(restartCalls, 1);
  assert.match(fs.readFileSync(script, 'utf8'), /cd -- "\$HOME"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up migra la cwd legacy del companion Fleet anche con service principale gia stabile', async () => {
  const { home } = initHome();
  const service = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  const companion = path.join(home, '.config', 'systemd', 'user', 'nexuscrew-fleet.service');
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.writeFileSync(service, `WorkingDirectory=${home}\n`);
  fs.writeFileSync(companion, `WorkingDirectory=${home}/replaceable-package\n`);
  let initCalls = 0;
  const r = await smartUp({
    home,
    platform: 'linux',
    installPath: service,
    fleetInstallPath: companion,
    runInitImpl: () => {
      initCalls += 1;
      fs.writeFileSync(companion, `WorkingDirectory=${home}\n`);
    },
    execImpl: (_bin, args) => (args?.includes('is-enabled') ? 'enabled' : 'active'),
    probeImpl: async () => true,
  });
  assert.equal(r.running, true);
  assert.equal(initCalls, 1);
  assert.match(fs.readFileSync(companion, 'utf8'), new RegExp(`^WorkingDirectory=${home}$`, 'm'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('show token stampa link autenticato senza aprire il browser', async () => {
  const { home } = initHome(); const logs = []; const opened = [];
  const r = await dispatch(['show', 'token'], { home, platform: 'linux', log: (x) => logs.push(x), probeImpl: async () => true, execImpl: () => '', openImpl: (u) => opened.push(u) });
  assert.equal(r.code, 0); assert.equal(opened.length, 0); assert.equal(logs.length, 1);
  const tok = fs.readFileSync(path.join(home, '.nexuscrew', 'token'), 'utf8').trim();
  assert.match(logs[0], /^http:\/\/127\.0\.0\.1:\d+\/#token=/); assert.ok(logs[0].endsWith(tok));
  fs.rmSync(home, { recursive: true, force: true });
});

test('boot status e off sono comandi pubblici idempotenti', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-boot-cli-')); const logs = [];
  assert.equal(dispatch(['boot', 'status'], { home, platform: 'termux', log: (x) => logs.push(x) }).code, 0);
  assert.match(logs[0], /boot: off/);
  const r = await dispatch(['boot', 'off'], { home, platform: 'termux', log: (x) => logs.push(x) });
  assert.equal((await r).code, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('boot on Termux installa esplicitamente lo startup script', async () => {
  const { home } = initHome();
  const cp = path.join(home, '.nexuscrew', 'config.json');
  fs.writeFileSync(cp, JSON.stringify({ port: 41822, wizardDone: true }) + '\n', { mode: 0o600 });
  const r = await dispatch(['boot'], {
    home, platform: 'termux', tmuxOk: true, log: () => {}, execImpl: () => '',
    probeImpl: async () => true,
  });
  assert.equal(r.code, 0);
  const script = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
  assert.equal(fs.existsSync(script), true);
  assert.equal(fs.statSync(script).mode & 0o777, 0o700);
  fs.rmSync(home, { recursive: true, force: true });
});

test('startPortable passa HOME e path runtime espliciti al processo detached', () => {
  const { home } = initHome(); let seen;
  const r = startPortable({
    home, filesRoot: path.join(home, 'files'),
    spawnImpl: (_bin, _args, opts) => { seen = opts; return { pid: 77, unref() {} }; },
  });
  assert.equal(r.portable, true);
  assert.equal(seen.detached, true);
  assert.equal(seen.env.HOME, home);
  assert.equal(seen.env.NEXUSCREW_CONFIG_FILE, path.join(home, '.nexuscrew', 'config.json'));
  assert.equal(seen.env.NEXUSCREW_TOKEN_FILE, path.join(home, '.nexuscrew', 'token'));
  assert.equal(seen.env.NEXUSCREW_FILES_ROOT, path.join(home, 'files'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up: porta occupata da altro processo -> successiva libera e config aggiornata', async () => {
  const { home } = initHome(41822);
  const cp = path.join(home, '.nexuscrew', 'config.json');
  fs.writeFileSync(cp, JSON.stringify({ port: 41822, wizardDone: true }) + '\n', { mode: 0o600 });
  let migrated = false;
  const r = await smartUp({
    home, platform: 'linux',
    execImpl: () => { throw new Error('inactive'); },
    probeImpl: async (port) => migrated && port === 41823,
    portAvailableImpl: async (port) => port === 41823,
    runInitImpl: ({ port }) => {
      const cfg = JSON.parse(fs.readFileSync(cp, 'utf8')); cfg.port = port;
      fs.writeFileSync(cp, JSON.stringify(cfg) + '\n', { mode: 0o600 }); migrated = true;
    },
    waitAttempts: 1,
  });
  assert.equal(r.port, 41823);
  assert.equal(JSON.parse(fs.readFileSync(cp, 'utf8')).port, 41823);
  fs.rmSync(home, { recursive: true, force: true });
});

test('smart-up: non sposta la porta se esistono peer collegati', async () => {
  const { home } = initHome(41822);
  const dir = path.join(home, '.nexuscrew');
  const nodesStore = require('../lib/nodes/store.js');
  let st = nodesStore.emptyStore('a'.repeat(32));
  st = nodesStore.addNode(st, {
    name: 'hub', ssh: 'user@hub', remotePort: 41820, localPort: 43001,
    direction: 'outbound', transport: 'auto', autostart: true,
    nodeId: 'b'.repeat(32), token: 'to-hub', acceptToken: 'from-hub',
  });
  nodesStore.atomicWriteStore(path.join(dir, 'nodes.json'), st);
  let wrote = false;
  await assert.rejects(() => smartUp({
    home, platform: 'linux', execImpl: () => { throw new Error('inactive'); },
    probeImpl: async () => false, portAvailableImpl: async (port) => port === 41823,
    runInitImpl: () => { wrote = true; }, waitAttempts: 1,
  }), /paired peers exist/);
  assert.equal(wrote, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).port, 41822);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch: unknown command -> code 1', () => {
  const logs = [];
  const r = dispatch(['bogus'], { log: (m) => logs.push(m) });
  assert.equal(r.code, 1);
  assert.ok(logs.join('\n').includes('not a public CLI command'));
});

test('dispatch: status, stop and restart are public lifecycle commands', () => {
  const { home } = initHome();
  const logs = [];
  const execImpl = (_bin, args) => args.includes('is-active') ? 'active' : '';
  assert.equal(dispatch(['status'], { home, platform: 'linux', execImpl, log: (x) => logs.push(x) }).code, 0);
  const lifecycle = { home, platform: 'linux', execImpl, ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }), log: (x) => logs.push(x) };
  assert.equal(dispatch(['stop'], lifecycle).code, 0);
  assert.equal(dispatch(['restart'], lifecycle).code, 0);
  assert.match(logs.join('\n'), /running:/);
  assert.match(logs.join('\n'), /systemctl --user stop nexuscrew/);
  assert.match(logs.join('\n'), /systemctl --user restart nexuscrew/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('managed stop/restart protect tmux before systemd and restart closes managed tunnels', () => {
  const { home } = initHome();
  const stopEvents = [];
  const stopResult = stop({
    home, platform: 'linux', log: () => {},
    execImpl: (_bin, args) => args.includes('is-active') ? 'active' : '',
    ensureTmuxSurvivalImpl: () => stopEvents.push('protect'),
    stopTunnelsImpl: () => stopEvents.push('tunnels'),
  });
  assert.equal(stopResult.stopped, true);
  assert.deepEqual(stopEvents, ['protect', 'tunnels']);

  const restartEvents = [];
  const restartResult = restart({
    home, platform: 'linux', log: () => {},
    execImpl: (_bin, args) => {
      if (args.includes('is-active')) return 'active';
      if (args.includes('restart')) restartEvents.push('restart');
      return '';
    },
    ensureTmuxSurvivalImpl: () => restartEvents.push('protect'),
    stopTunnelsImpl: () => restartEvents.push('tunnels'),
  });
  assert.equal(restartResult.restarted, true);
  assert.deepEqual(restartEvents, ['protect', 'tunnels', 'restart']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('stopManagedTunnels ripulisce anche un supervisor orfano non piu nel node store', () => {
  const { home } = initHome();
  const orphan = path.join(home, '.nexuscrew', 'tunnels', 'orphan.pid');
  pidf.writePidfile(orphan, 2147483647, 'node tunnel-supervisor.js ssh -N');
  const stopped = stopManagedTunnels({ home });
  assert.deepEqual(stopped, ['orphan']);
  assert.equal(fs.existsSync(orphan), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('managed restart fails closed when tmux survival protection cannot be installed', () => {
  const { home } = initHome();
  const calls = [];
  const result = restart({
    home, platform: 'linux', log: () => {}, stopTunnelsImpl: () => calls.push('tunnels'),
    execImpl: (_bin, args) => {
      if (args.includes('is-active')) return 'active';
      if (args.includes('restart')) calls.push('restart');
      return '';
    },
    ensureTmuxSurvivalImpl: () => { throw new Error('drop-in denied'); },
  });
  assert.equal(result.restarted, false);
  assert.match(result.reason, /drop-in denied/);
  assert.deepEqual(calls, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('managed stop/restart guard failure leaves portable owner and tunnels untouched', async (t) => {
  const { home } = initHome();
  const { child } = portableFixture(home);
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(home, { recursive: true, force: true }); });
  for (const action of [stop, restart]) {
    const mutations = [];
    const result = action({
      home, platform: 'linux', log: () => {},
      execImpl: (_bin, args) => {
        if (args.includes('is-active')) return 'active';
        mutations.push(args[2] || args[0]);
        return '';
      },
      ensureTmuxSurvivalImpl: () => { throw new Error('unsafe KillMode'); },
      stopPortableImpl: () => { mutations.push('portable'); return { killed: true, pid: child.pid }; },
      stopTunnelsImpl: () => mutations.push('tunnels'),
    });
    assert.equal(action === stop ? result.stopped : result.restarted, false);
    assert.match(result.reason, /unsafe KillMode/);
    assert.deepEqual(mutations, []);
    assert.equal(pidf.pidExists(child.pid), true);
  }
});

// --- legacy commands removed from the public surface ---

test('legacy configuration commands restano privati mentre init e pubblico', () => {
  const logs = [];
  for (const command of ['start', 'url', 'logs', 'update']) {
    assert.equal(dispatch([command], { log: (m) => logs.push(m) }).code, 1);
  }
  assert.ok(logs.join('\n').includes('nexuscrew show'));
});

// --- serve ---

test('serve: serverStart chiamato (mock)', () => {
  let called = false;
  serve({ fleetEnabled: false, serverStart: () => { called = true; } });
  assert.equal(called, true);
});

test('serve: bootstrap Fleet copre service manager e Termux:Boot', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-serve-fleet-'));
  let presentAtStart = false;
  serve({
    home,
    serverStart: () => { presentAtStart = fs.existsSync(path.join(home, '.nexuscrew', 'fleet.json')); },
  });
  assert.equal(presentAtStart, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('serve --pidfile: scrive pidfile + cleanup (mock serverStart)', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-serve-test-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  let started = false;
  serve({ pidfile: true, fleetEnabled: false, serverStart: () => { started = true; } });
  assert.equal(started, true);
  assert.ok(fs.existsSync(tmpPid)); // pidfile scritto
  // cleanup su exit
  process.emit('exit');
  assert.ok(!fs.existsSync(tmpPid)); // rimosso
  delete process.env.NEXUSCREW_PIDFILE;
});

test('serve --pidfile: already-running -> throw (no double start)', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-serve-running-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  // pre-crea pidfile con pid vivo (self)
  fs.writeFileSync(tmpPid, JSON.stringify({ pid: process.pid, cmd: 'node', startTs: Date.now() }) + '\n');
  assert.throws(
    () => serve({ pidfile: true, fleetEnabled: false, serverStart: () => {} }),
    /already running/i,
  );
  fs.rmSync(tmpPid, { force: true });
  delete process.env.NEXUSCREW_PIDFILE;
});

// --- start/stop/status per-platform (mock execImpl) ---

test('start linux: systemctl --user start (mock)', () => {
  const calls = [];
  const r = start({ platform: 'linux', execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.started, true);
  assert.ok(calls.some((c) => c[0] === 'systemctl' && c[1].includes('start')));
});

test('start mac: launchctl kickstart (mock)', () => {
  const calls = [];
  const r = start({ platform: 'mac', uid: 501, execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.started, true);
  assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1].includes('kickstart')));
});

test('start mac: se non caricato bootstrap domain-target, poi kickstart; errori non crashano', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mac-start-'));
  const calls = [];
  const r = start({
    platform: 'mac', uid: 501, home,
    execImpl: (b, a) => {
      calls.push([b, a]);
      if (a[0] === 'kickstart' && calls.length === 1) throw new Error('not loaded');
    },
    log: () => {},
  });
  assert.equal(r.started, true);
  assert.ok(calls.some(([b, a]) => b === 'launchctl' && a[0] === 'bootstrap'
    && a[1] === 'gui/501' && a[2].endsWith('com.mmmbuto.nexuscrew.plist')));
  const failed = start({ platform: 'mac', uid: 501, home, execImpl: () => { throw new Error('launchd down'); }, log: () => {} });
  assert.equal(failed.started, false);
  assert.match(failed.reason, /launchd down/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('stop linux: systemctl --user stop (mock)', () => {
  const calls = []; let tunnelsStopped = 0;
  const r = stop({
    platform: 'linux',
    execImpl: (b, a) => { calls.push([b, a]); return a.includes('is-active') ? 'active' : ''; },
    ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }),
    stopTunnelsImpl: () => { tunnelsStopped += 1; }, log: () => {},
  });
  assert.equal(r.stopped, true);
  assert.ok(calls.some((c) => c[1].includes('stop')));
  assert.equal(tunnelsStopped, 1);
  const failed = stop({
    platform: 'linux',
    execImpl: (_b, a) => { if (a.includes('is-active')) return 'active'; throw new Error('unit missing'); },
    ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }),
    stopTunnelsImpl: () => { tunnelsStopped += 1; }, log: () => {},
  });
  assert.equal(failed.stopped, false);
  assert.equal(tunnelsStopped, 2, 'i tunnel vengono fermati anche se systemd fallisce');
});

test('stop mac: bootout ferma davvero il job KeepAlive e pulisce i tunnel anche su errore', () => {
  const calls = [];
  const r = stop({ platform: 'mac', uid: 501, execImpl: (b, a) => calls.push([b, a]), stopTunnelsImpl: () => {}, log: () => {} });
  assert.equal(r.stopped, true);
  assert.ok(calls.some(([b, a]) => b === 'launchctl' && a[0] === 'bootout' && a[1] === 'gui/501/com.mmmbuto.nexuscrew'));
  let cleaned = 0;
  const failed = stop({
    platform: 'mac', uid: 501,
    execImpl: (_b, a) => { if (a[0] === 'print') return ''; throw new Error('not loaded'); },
    stopTunnelsImpl: () => { cleaned += 1; }, log: () => {},
  });
  assert.equal(failed.stopped, false);
  assert.match(failed.reason, /not loaded/);
  assert.equal(cleaned, 1);
});

test('stop termux: no pidfile e idempotente e pulisce supervisor orfani', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-stop-nopid-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  let tunnelsStopped = 0;
  const r = stop({ platform: 'termux', execImpl: () => {}, stopTunnelsImpl: () => { tunnelsStopped += 1; }, log: () => {} });
  assert.equal(r.stopped, true);
  assert.equal(r.alreadyStopped, true);
  assert.match(r.reason, /no pidfile/);
  assert.equal(tunnelsStopped, 1, 'Termux stop pulisce anche supervisor orfani');
  delete process.env.NEXUSCREW_PIDFILE;
});

test('status linux: systemctl is-active (mock)', () => {
  const r = status({
    platform: 'linux',
    execImpl: (b, a) => 'active',
    log: () => {},
    home: os.homedir(),
  });
  assert.equal(r.platform, 'linux');
  assert.equal(r.running, true);
});

test('status termux: boot-script + pidfile state', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-st-'));
  const tmpPid = path.join(tmpHome, 'nexuscrew.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  // no boot script, no pidfile -> not installed, not running
  const r = status({ platform: 'termux', execImpl: () => {}, log: () => {}, home: tmpHome });
  assert.equal(r.bootScriptInstalled, false);
  assert.equal(r.running, false);
  // crea boot script -> installed
  fs.mkdirSync(path.join(tmpHome, '.termux', 'boot'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.termux', 'boot', 'nexuscrew.sh'), 'x');
  const r2 = status({ platform: 'termux', execImpl: () => {}, log: () => {}, home: tmpHome });
  assert.equal(r2.bootScriptInstalled, true);
  assert.equal(r2.running, false); // nessun pidfile vivo
  delete process.env.NEXUSCREW_PIDFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('linux/mac lifecycle riconosce un runtime portable anche col service manager inattivo', async (t) => {
  for (const platform of ['linux', 'mac']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `nc-portable-${platform}-`));
    fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
    const { child } = portableFixture(home);
    t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(home, { recursive: true, force: true }); });
    const out = status({ home, platform, uid: 501, log: () => {}, execImpl: () => { throw new Error('inactive'); } });
    assert.equal(out.running, true);
    assert.equal(out.runtimeOwner, 'portable');
    assert.equal(out.portablePid, child.pid);
    const stopped = stop({ home, platform, uid: 501, log: () => {}, execImpl: () => { throw new Error('inactive'); }, stopTunnelsImpl: () => {} });
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.stoppedOwners, ['portable']);
    await childExit(child);
  }
});

test('restart portable usa lo stesso owner; un conflitto viene ricondotto al managed owner', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runtime-owner-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let portableStarts = 0;
  const first = portableFixture(home);
  t.after(() => { try { first.child.kill('SIGKILL'); } catch (_) {} });
  const portable = restart({
    home, platform: 'linux', log: () => {}, execImpl: () => { throw new Error('inactive'); },
    stopTunnelsImpl: () => {}, startPortableImpl: () => { portableStarts += 1; return { started: true }; },
  });
  assert.equal(portable.owner, 'portable');
  assert.equal(portable.runtimeOwner, 'portable');
  assert.equal(portable.restarted, true);
  assert.equal(portableStarts, 1);
  await childExit(first.child);

  const second = portableFixture(home);
  t.after(() => { try { second.child.kill('SIGKILL'); } catch (_) {} });
  const calls = [];
  const conflict = restart({
    home, platform: 'linux', log: () => {}, stopTunnelsImpl: () => {},
    execImpl: (bin, args) => { calls.push([bin, args]); return args.includes('is-active') ? 'active' : ''; },
    ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }),
  });
  assert.equal(conflict.owner, 'conflict');
  assert.equal(conflict.runtimeOwner, 'managed');
  assert.equal(conflict.restarted, true);
  assert.ok(calls.some(([bin, args]) => bin === 'systemctl' && args.includes('restart')));
  await childExit(second.child);
});

test('dispatch serve: chiama serve + keepAlive (no exit, server resta vivo)', () => {
  let called = false;
  const r = dispatch(['serve'], { fleetEnabled: false, serverStart: () => { called = true; }, log: () => {} });
  assert.equal(r.code, 0);
  assert.equal(r.keepAlive, true); // serve non deve exit (server.listen tiene il processo)
  assert.equal(called, true);
});

// ---------------------------------------------------------------------------
// Helpers interni usati dalla PWA/runtime; non sono comandi CLI pubblici.
// ---------------------------------------------------------------------------

test('url helper: costruisce URL autenticato', () => {
  const { home, token } = initHome();
  const l = [];
  const r = url({ log: (m) => l.push(m), home });
  assert.equal(r.hasToken, true);
  assert.ok(l.join('\n').includes(`#token=${token}`)); // url e' l'UNICO posto col token in chiaro
  const l2 = [];
  url({ log: (m) => l2.push(m), home, qr: true });
  assert.ok(l2.join('\n').includes('█')); // QR ASCII presente (no snapshot fragile)
  fs.rmSync(home, { recursive: true, force: true });
});

test('status --json: roles+nodes progettati, porta da config, MAI il token', () => {
  const { home, token, port } = initHome();
  const l = [];
  status({
    home, platform: 'linux', log: (m) => l.push(m),
    execImpl: () => { throw new Error('inactive'); },
    json: true,
  });
  const out = JSON.parse(l.join('\n'));
  assert.deepEqual(out.roles, { client: false, node: false });
  assert.deepEqual(out.nodes, []);
  assert.equal(out.port, port);
  assert.equal(out.url, `http://127.0.0.1:${port}/`); // url in status SENZA token
  assert.ok(!l.join('\n').includes(token));
  fs.rmSync(home, { recursive: true, force: true });
});

test('status: roles letti dal config.json (default entrambi off)', () => {
  const { home } = initHome();
  const cp = path.join(home, '.nexuscrew', 'config.json');
  fs.writeFileSync(cp, JSON.stringify({ port: 41822, roles: { client: true, node: false } }) + '\n');
  const r = status({ home, platform: 'linux', json: true, log: () => {}, execImpl: () => { throw new Error('x'); } });
  assert.deepEqual(r.roles, { client: true, node: false });
  fs.rmSync(home, { recursive: true, force: true });
});

test('no token nei log: status e logs non stampano il token', () => {
  const { home, token } = initHome();
  const s = [];
  status({ home, platform: 'linux', log: (m) => s.push(m), execImpl: () => { throw new Error('x'); } });
  assert.ok(!s.join('\n').includes(token));
  const l = [];
  logs({ home, platform: 'linux', log: (m) => l.push(m), spawnImpl: () => ({}) });
  assert.ok(!l.join('\n').includes(token));
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate: riscrive il token (0600), non lo stampa, READONLY blocca', () => {
  const { home, token: oldTok } = initHome();
  const tokenPath = path.join(home, '.nexuscrew', 'token');
  const l = [];
  const r = tokenRotate({ home, platform: 'linux', log: (m) => l.push(m), execImpl: () => { throw new Error('inactive'); } });
  assert.equal(r.rotated, true);
  const newTok = fs.readFileSync(tokenPath, 'utf8').trim();
  assert.notEqual(newTok, oldTok);
  assert.ok(!l.join('\n').includes(newTok)); // il nuovo token NON si stampa
  assert.ok(!l.join('\n').includes(oldTok));
  assert.equal(fs.lstatSync(tokenPath).mode & 0o777, 0o600); // permessi preservati
  // READONLY blocca la rotazione
  process.env.NEXUSCREW_READONLY = '1';
  const l2 = [];
  const r2 = tokenRotate({ home, platform: 'linux', log: (m) => l2.push(m) });
  delete process.env.NEXUSCREW_READONLY;
  assert.equal(r2.rotated, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate: service attivo -> restart (invalidazione reale)', () => {
  const { home } = initHome();
  const calls = [];
  tokenRotate({
    home, platform: 'linux', log: () => {},
    execImpl: (b, a) => { calls.push([b, a]); return (a && a.includes('is-active')) ? 'active' : ''; },
    ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }),
  });
  assert.ok(calls.some((c) => c[0] === 'systemctl' && c[1].includes('restart')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate: guard failure happens before the token is changed', () => {
  const { home, token: oldToken } = initHome();
  const logs = [];
  const result = tokenRotate({
    home, platform: 'linux', log: (line) => logs.push(line),
    execImpl: (_bin, args) => args.includes('is-active') ? 'active' : '',
    ensureTmuxSurvivalImpl: () => { throw new Error('unsafe KillMode'); },
    restartImpl: () => { throw new Error('must not restart'); },
  });
  assert.equal(result.rotated, false);
  assert.equal(result.tokenWritten, false);
  assert.equal(result.restarted, false);
  assert.equal(fs.readFileSync(path.join(home, '.nexuscrew', 'token'), 'utf8').trim(), oldToken);
  assert.match(logs.join('\n'), /annullata/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate: restart failure reports an incomplete rotation without false invalidation claim', () => {
  const { home, token: oldToken } = initHome();
  const logs = [];
  const result = tokenRotate({
    home, platform: 'linux', log: (line) => logs.push(line),
    execImpl: (_bin, args) => args.includes('is-active') ? 'active' : '',
    ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }),
    restartImpl: () => ({ restarted: false, reason: 'health check failed' }),
  });
  assert.equal(result.rotated, false);
  assert.equal(result.tokenWritten, true);
  assert.equal(result.restarted, false);
  assert.notEqual(fs.readFileSync(path.join(home, '.nexuscrew', 'token'), 'utf8').trim(), oldToken);
  assert.match(logs.join('\n'), /INCOMPLETA/);
  assert.doesNotMatch(logs.join('\n'), /vecchio token invalidato \(401\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate end-to-end: vecchio token 401, nuovo 200 (restart = reload credenziali)', async (t) => {
  const { createServer } = require('../lib/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rot-'));
  const tokenPath = path.join(dir, 'token');
  const s1 = createServer({ home: dir, tokenPath, nodesPath: path.join(dir, 'nodes.json'), filesRoot: path.join(dir, 'files'), fleetEnabled: false, autoUpdate: false });
  await new Promise((res) => s1.server.listen(0, '127.0.0.1', res));
  const oldTok = s1.token;
  const base1 = `http://127.0.0.1:${s1.server.address().port}`;
  assert.equal((await fetch(`${base1}/api/config`, { headers: { authorization: `Bearer ${oldTok}` } })).status, 200);
  s1.server.close(); s1.watcher.close();
  // rotazione atomica del file token (service non attivo nel test -> nessun restart reale)
  tokenRotate({ home: dir, configDir: dir, tokenPath, platform: 'linux', log: () => {}, execImpl: () => { throw new Error('inactive'); } });
  // restart-equivalente: un nuovo server rilegge il file -> nuove credenziali
  const s2 = createServer({ home: dir, tokenPath, nodesPath: path.join(dir, 'nodes.json'), filesRoot: path.join(dir, 'files'), fleetEnabled: false, autoUpdate: false });
  await new Promise((res) => s2.server.listen(0, '127.0.0.1', res));
  t.after(() => { s2.server.close(); s2.watcher.close(); });
  const base2 = `http://127.0.0.1:${s2.server.address().port}`;
  const newTok = s2.token;
  assert.notEqual(newTok, oldTok);
  assert.equal((await fetch(`${base2}/api/config`, { headers: { authorization: `Bearer ${oldTok}` } })).status, 401);
  assert.equal((await fetch(`${base2}/api/config`, { headers: { authorization: `Bearer ${newTok}` } })).status, 200);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logs linux: journalctl --user -u nexuscrew; -f segue', () => {
  const cap = [];
  logs({ platform: 'linux', spawnImpl: (b, a) => { cap.push([b, a]); return {}; }, log: () => {} });
  assert.equal(cap[0][0], 'journalctl');
  assert.ok(cap[0][1].includes('nexuscrew'));
  assert.ok(!cap[0][1].includes('-f'));
  const cap2 = [];
  logs({ platform: 'linux', spawnImpl: (b, a) => { cap2.push([b, a]); return {}; }, follow: true, log: () => {} });
  assert.ok(cap2[0][1].includes('-f'));
});

test('logs helper termux: tail del logfile con follow', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-logs-'));
  const cap = [];
  const r = logs({ platform: 'termux', home, follow: true, spawnImpl: (b, a) => { cap.push([b, a]); return {}; }, log: () => {} });
  assert.equal(r.keepAlive, true);
  assert.equal(cap[0][0], 'tail');
  assert.ok(cap[0][1].includes('-f'));
  assert.ok(cap[0][1].some((x) => String(x).includes('nexuscrew.log')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: tutto ok -> code 0', () => {
  const { home } = initHome();
  const svc = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  fs.mkdirSync(path.dirname(svc), { recursive: true });
  fs.writeFileSync(svc, `WorkingDirectory=${home}\n`);
  const l = [];
  const r = doctor({
    home, platform: 'linux', log: (m) => l.push(m), installPath: svc,
    execImpl: (b, a) => {
      if (a && a.includes('is-active')) return 'active';
      if (a && a.includes('is-enabled')) return 'enabled';
      if (a && a.includes('--property=KillMode')) return 'process';
      return '';
    },
    ptyLoad: () => ({ spawn() {} }),
    commandExists: () => true,
  });
  assert.equal(r.code, 0);
  assert.ok(r.ok);
  assert.ok(l.some((line) => line.startsWith('OK')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: tmux mancante -> code 1', () => {
  const { home } = initHome();
  const r = doctor({
    home, platform: 'linux', log: () => {},
    execImpl: (b, a) => { if (a && a.includes('is-active')) return 'active'; return ''; },
    ptyLoad: () => ({}),
    commandExists: (bin) => bin !== 'tmux',
  });
  assert.equal(r.code, 1);
  assert.ok(r.checks.some((c) => c.name.includes('tmux') && !c.ok));
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: launchd WorkingDirectory sostituibile e un blocker su macOS', () => {
  const { checkMacServiceWorkingDirectory } = require('../lib/cli/doctor.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-mac-cwd-'));
  const plist = path.join(home, 'nexuscrew.plist');
  const render = (cwd) => `<plist><dict><key>WorkingDirectory</key><string>${cwd}</string></dict></plist>\n`;

  const missing = checkMacServiceWorkingDirectory('mac', home, path.join(home, 'missing.plist'));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /service non installato/);

  fs.writeFileSync(plist, render(home));
  assert.equal(checkMacServiceWorkingDirectory('mac', home, plist).ok, true);

  fs.writeFileSync(plist, render(`${home}/.nexuscrew`));
  const stale = checkMacServiceWorkingDirectory('mac', home, plist);
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /atteso HOME stabile/);

  assert.equal(checkMacServiceWorkingDirectory('linux', home, plist).ok, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: fleet.json mancante o invalido e un FAIL azionabile', () => {
  const { checkFleetDefinitions } = require('../lib/cli/doctor.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-fleet-'));
  const fleetPath = path.join(home, '.nexuscrew', 'fleet.json');
  const missing = checkFleetDefinitions(home, fleetPath, true);
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /assente.*nexuscrew/);
  fs.mkdirSync(path.dirname(fleetPath), { recursive: true });
  fs.writeFileSync(fleetPath, '{broken\n', { mode: 0o600 });
  const invalid = checkFleetDefinitions(home, fleetPath, true);
  assert.equal(invalid.ok, false);
  assert.match(invalid.detail, /invalido.*preservato/);
  const disabled = checkFleetDefinitions(home, fleetPath, false);
  assert.equal(disabled.ok, true);
  assert.equal(disabled.warn, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: cwd stabile copre systemd e Termux:Boot senza seguire symlink', () => {
  const { checkServiceWorkingDirectory } = require('../lib/cli/doctor.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-service-cwd-'));
  const unit = path.join(home, 'nexuscrew.service');
  const boot = path.join(home, 'nexuscrew.sh');
  fs.writeFileSync(unit, `WorkingDirectory=${home}\n`);
  assert.equal(checkServiceWorkingDirectory('linux', home, unit).ok, true);
  fs.writeFileSync(unit, `WorkingDirectory=${home}/.nexuscrew\n`);
  const staleLinux = checkServiceWorkingDirectory('linux', home, unit);
  assert.equal(staleLinux.ok, false);
  assert.match(staleLinux.detail, /atteso HOME stabile/);

  fs.writeFileSync(boot, '#!/bin/sh\ncd -- "$HOME"\n');
  assert.equal(checkServiceWorkingDirectory('termux', home, boot).ok, true);
  fs.writeFileSync(boot, '#!/bin/sh\ncd -- "$HOME/.nexuscrew"\n');
  const staleTermux = checkServiceWorkingDirectory('termux', home, boot);
  assert.equal(staleTermux.ok, false);
  assert.match(staleTermux.detail, /atteso HOME stabile/);

  const real = path.join(home, 'real.service');
  const link = path.join(home, 'link.service');
  fs.writeFileSync(real, `WorkingDirectory=${home}\n`);
  fs.symlinkSync(real, link);
  const unsafe = checkServiceWorkingDirectory('linux', home, link);
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.detail, /non regolare/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor e smart-up coprono anche la cwd del companion Fleet', () => {
  const {
    checkFleetServiceWorkingDirectory,
  } = require('../lib/cli/doctor.js');
  const {
    serviceDefinitionNeedsRefresh,
  } = require('../lib/cli/commands.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-fleet-cwd-'));
  const service = path.join(home, 'nexuscrew.service');
  const companion = path.join(home, 'nexuscrew-fleet.service');
  fs.writeFileSync(service, `WorkingDirectory=${home}\n`);

  const missing = checkFleetServiceWorkingDirectory('linux', home, companion);
  assert.equal(missing.ok, true);
  assert.equal(missing.warn, true);
  assert.equal(serviceDefinitionNeedsRefresh('linux', home, service, companion), false);

  fs.writeFileSync(companion, `WorkingDirectory=${home}/replaceable-package\n`);
  const stale = checkFleetServiceWorkingDirectory('linux', home, companion);
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /atteso HOME stabile/);
  assert.equal(serviceDefinitionNeedsRefresh('linux', home, service, companion), true);

  fs.writeFileSync(companion, `WorkingDirectory=${home}\n`);
  assert.equal(checkFleetServiceWorkingDirectory('linux', home, companion).ok, true);
  assert.equal(serviceDefinitionNeedsRefresh('linux', home, service, companion), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor: controlla anche il companion Fleet e blocca KillMode control-group', () => {
  const { home } = initHome();
  const svc = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  fs.mkdirSync(path.dirname(svc), { recursive: true });
  fs.writeFileSync(svc, `WorkingDirectory=${home}\n`);
  const r = doctor({
    home, platform: 'linux', installPath: svc, log: () => {},
    execImpl: (_bin, args) => {
      if (args.includes('is-active')) return 'active';
      if (args.includes('is-enabled')) return 'enabled';
      if (args.includes('--property=LoadState')) return 'loaded';
      if (args.includes('--property=KillMode')) {
        return args.includes('nexuscrew-fleet.service') ? 'control-group' : 'process';
      }
      return '';
    },
    ptyLoad: () => ({}), commandExists: () => true,
  });
  assert.equal(r.code, 1);
  assert.ok(r.checks.some((c) => c.name.includes('tmux survival')
    && !c.ok
    && /nexuscrew\.service: KillMode=process/.test(c.detail)
    && /nexuscrew-fleet\.service: KillMode=control-group/.test(c.detail)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor helpers: Termux dichiara il limite Termux:Boot e Linux segnala linger disabilitato', () => {
  const { checkBoot, checkUserLinger } = require('../lib/cli/doctor.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-boot-'));
  const script = path.join(home, '.termux', 'boot', 'nexuscrew.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '#!/bin/sh\n');
  const termux = checkBoot('termux', home, () => '');
  assert.equal(termux.ok, true);
  assert.equal(termux.warn, true);
  assert.match(termux.detail, /Termux:Boot non verificabile/);
  const calls = [];
  const linger = checkUserLinger('linux', (bin, args) => {
    calls.push([bin, args]); return 'no\n';
  }, 1000);
  assert.equal(linger.ok, true);
  assert.equal(linger.warn, true);
  assert.match(linger.detail, /enable-linger/);
  assert.deepEqual(calls[0], ['loginctl', ['show-user', '1000', '--property=Linger', '--value']]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor checkMcpIdentity: NON-FAILING (PWA-only non rompe), WARN se nessuna identity env', () => {
  const { checkMcpIdentity } = require('../lib/cli/doctor.js');
  // PWA-only / nessuna identita: ok SEMPRE true, WARN informativo (mai FAIL).
  const empty = checkMcpIdentity({});
  assert.equal(empty.ok, true);
  assert.equal(empty.warn, true);
  assert.match(empty.detail, /TMUX\/NEXUSCREW_MCP_SESSION assenti/i);
  assert.match(empty.detail, /PWA-only/i);
  // Identita osservabile via NEXUSCREW_MCP_SESSION -> OK, nessun warn.
  const byEnv = checkMcpIdentity({ NEXUSCREW_MCP_SESSION: 'cloud-Dev' });
  assert.equal(byEnv.ok, true);
  assert.equal(byEnv.warn, undefined);
  assert.match(byEnv.detail, /NEXUSCREW_MCP_SESSION/);
  // Identita osservabile via TMUX -> OK, nessun warn.
  const byTmux = checkMcpIdentity({ TMUX: '/tmp/tmux,1,0' });
  assert.equal(byTmux.ok, true);
  assert.equal(byTmux.warn, undefined);
  assert.match(byTmux.detail, /TMUX/);
  // Stringa solo-spazi NON conta come presenza (trim a vuoto).
  const blank = checkMcpIdentity({ NEXUSCREW_MCP_SESSION: '   ' });
  assert.equal(blank.ok, true);
  assert.equal(blank.warn, true);
});

test('doctor: check MCP incluso ma non fail su PWA-only (env senza identita -> code 0)', () => {
  const { home } = initHome();
  const svc = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  fs.mkdirSync(path.dirname(svc), { recursive: true });
  fs.writeFileSync(svc, `WorkingDirectory=${home}\n`);
  const r = doctor({
    home, platform: 'linux', log: () => {}, installPath: svc, env: {}, // PWA-only: no identity env
    execImpl: (b, a) => {
      if (a && a.includes('is-active')) return 'active';
      if (a && a.includes('is-enabled')) return 'enabled';
      if (a && a.includes('--property=KillMode')) return 'process';
      return '';
    },
    ptyLoad: () => ({ spawn() {} }),
    commandExists: () => true,
  });
  // Il check MCP e' presente e WARN, ma ok=true quindi NON fail.
  const mcp = r.checks.find((c) => c.name === 'MCP identity env');
  assert.ok(mcp);
  assert.equal(mcp.ok, true);
  assert.equal(mcp.warn, true);
  assert.equal(r.code, 0); // PWA-only non va in FAIL
  assert.ok(r.ok);
  fs.rmSync(home, { recursive: true, force: true });
});

test('update: npm ok -> installa @latest + restart se attivo', () => {
  const calls = [];
  const r = update({
    platform: 'linux', log: () => {},
    execImpl: (b, a) => { calls.push([b, a]); if (a && a.includes('is-active')) return 'active'; return ''; },
    ensureTmuxSurvivalImpl: () => ({ killMode: 'process' }),
  });
  assert.equal(r.code, 0);
  assert.ok(calls.some((c) => c[0] === 'npm' && c[1].join(' ').includes('@mmmbuto/nexuscrew@latest')));
  assert.ok(calls.some((c) => c[0] === 'systemctl' && c[1].includes('restart')));
});

test('update: npm fallito -> code 1 + messaggio chiaro', () => {
  const l = [];
  const r = update({
    platform: 'linux', log: (m) => l.push(m),
    execImpl: (b) => { if (b === 'npm') throw new Error('EACCES'); return ''; },
  });
  assert.equal(r.code, 1);
  assert.equal(r.updated, false);
  assert.ok(l.join('\n').includes('fallito'));
});

test('update: restart fallito restituisce code 1 e non dichiara successo', () => {
  const logs = [];
  const r = update({
    platform: 'linux', log: (line) => logs.push(line),
    execImpl: (_bin, args) => args && args.includes('is-active') ? 'active' : '',
    restartImpl: () => ({ restarted: false, reason: 'tmux survival guard failed' }),
  });
  assert.equal(r.updated, true);
  assert.equal(r.restarted, false);
  assert.equal(r.code, 1);
  assert.match(r.reason, /tmux survival guard failed/);
  assert.match(logs.join('\n'), /restart fallito/);
  assert.doesNotMatch(logs.join('\n'), /servizio riavviato sul nuovo codice/);
});

test('smart-up idempotente: gia\' attivo e configurato -> no start, no output, no browser', async () => {
  const { home } = initHome();
  const cp = path.join(home, '.nexuscrew', 'config.json');
  fs.writeFileSync(cp, JSON.stringify({ port: 41822, wizardDone: true }) + '\n', { mode: 0o600 });
  const calls = [];
  const l = [];
  let opened = false;
  const r = await smartUp({
    home, platform: 'linux', log: (m) => l.push(m),
    execImpl: (b, a) => { calls.push([b, a]); if (a && a.includes('is-active')) return 'active'; return ''; },
    probeImpl: async () => true,
    openImpl: () => { opened = true; },
    runInitImpl: () => { throw new Error('non deve re-init'); },
  });
  assert.equal(r.running, true);
  assert.ok(!calls.some((c) => c[1] && c[1].includes('start'))); // gia' attivo -> nessuno start
  assert.equal(l.length, 0);
  assert.equal(opened, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate: runtime portable vivo viene riavviato e invalida il vecchio token', async (t) => {
  const { home } = initHome();
  const { child } = portableFixture(home);
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(home, { recursive: true, force: true }); });
  const l = [];
  let portableStarts = 0;
  const result = tokenRotate({
    home, platform: 'linux', log: (m) => l.push(m),
    execImpl: () => { throw new Error('inactive'); }, stopTunnelsImpl: () => {},
    startPortableImpl: () => { portableStarts += 1; return { started: true }; },
  });
  assert.equal(result.running, true);
  assert.equal(portableStarts, 1);
  assert.ok(l.join('\n').includes('servizio riavviato'));
  await childExit(child);
});
