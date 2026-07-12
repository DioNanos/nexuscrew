'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch, serve, start, stop, status, parseFlags, HELP,
  smartUp, url, tokenRotate, logs, update, doctor, findAvailablePort, openPwa, startPortable } = require('../lib/cli/commands.js');

// Home "inizializzata" (config.json + token) per i test url/status/token/logs. [A2]
function initHome(port = 41822, token = 'SECRETTOKEN12345') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-a2-'));
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
  return { home, token, port };
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
  assert.equal(version[0], '0.8.7');
  assert.equal(dispatch(['--bogus'], { log: () => {} }).code, 1);
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

test('dispatch: unknown command -> code 1', () => {
  const logs = [];
  const r = dispatch(['bogus'], { log: (m) => logs.push(m) });
  assert.equal(r.code, 1);
  assert.ok(logs.join('\n').includes('not a public CLI command'));
});

// --- dispatch init (tmpdir, dry-run) ---

test('legacy configuration commands are not public CLI commands', () => {
  const logs = [];
  for (const command of ['init', 'start', 'stop', 'status', 'url', 'logs', 'update', 'nodes']) {
    assert.equal(dispatch([command], { log: (m) => logs.push(m) }).code, 1);
  }
  assert.ok(logs.join('\n').includes('nexuscrew show'));
});

// --- serve ---

test('serve: serverStart chiamato (mock)', () => {
  let called = false;
  serve({ serverStart: () => { called = true; } });
  assert.equal(called, true);
});

test('serve --pidfile: scrive pidfile + cleanup (mock serverStart)', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-serve-test-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  let started = false;
  serve({ pidfile: true, serverStart: () => { started = true; } });
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
    () => serve({ pidfile: true, serverStart: () => {} }),
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
  const calls = [];
  const r = stop({ platform: 'linux', execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.stopped, true);
  assert.ok(calls.some((c) => c[1].includes('stop')));
});

test('stop mac: bootout ferma davvero il job KeepAlive e non propaga errori', () => {
  const calls = [];
  const r = stop({ platform: 'mac', uid: 501, execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.stopped, true);
  assert.deepEqual(calls[0], ['launchctl', ['bootout', 'gui/501/com.mmmbuto.nexuscrew']]);
  const failed = stop({ platform: 'mac', uid: 501, execImpl: () => { throw new Error('not loaded'); }, log: () => {} });
  assert.equal(failed.stopped, false);
  assert.match(failed.reason, /not loaded/);
});

test('stop termux: no pidfile -> no kill, reason', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-stop-nopid-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  const r = stop({ platform: 'termux', execImpl: () => {}, log: () => {} });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /no pidfile/);
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

test('dispatch serve: chiama serve + keepAlive (no exit, server resta vivo)', () => {
  let called = false;
  const r = dispatch(['serve'], { serverStart: () => { called = true; }, log: () => {} });
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
  });
  assert.ok(calls.some((c) => c[0] === 'systemctl' && c[1].includes('restart')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('token rotate end-to-end: vecchio token 401, nuovo 200 (restart = reload credenziali)', async (t) => {
  const { createServer } = require('../lib/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rot-'));
  const tokenPath = path.join(dir, 'token');
  const s1 = createServer({ tokenPath, filesRoot: path.join(dir, 'files'), fleetEnabled: false });
  await new Promise((res) => s1.server.listen(0, '127.0.0.1', res));
  const oldTok = s1.token;
  const base1 = `http://127.0.0.1:${s1.server.address().port}`;
  assert.equal((await fetch(`${base1}/api/config`, { headers: { authorization: `Bearer ${oldTok}` } })).status, 200);
  s1.server.close(); s1.watcher.close();
  // rotazione atomica del file token (service non attivo nel test -> nessun restart reale)
  tokenRotate({ home: dir, configDir: dir, tokenPath, platform: 'linux', log: () => {}, execImpl: () => { throw new Error('inactive'); } });
  // restart-equivalente: un nuovo server rilegge il file -> nuove credenziali
  const s2 = createServer({ tokenPath, filesRoot: path.join(dir, 'files'), fleetEnabled: false });
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
  fs.writeFileSync(svc, 'x');
  const l = [];
  const r = doctor({
    home, platform: 'linux', log: (m) => l.push(m), installPath: svc,
    execImpl: (b, a) => {
      if (a && a.includes('is-active')) return 'active';
      if (a && a.includes('is-enabled')) return 'enabled';
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

test('update: npm ok -> installa @latest + restart se attivo', () => {
  const calls = [];
  const r = update({
    platform: 'linux', log: () => {},
    execImpl: (b, a) => { calls.push([b, a]); if (a && a.includes('is-active')) return 'active'; return ''; },
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

// F2 (audit run multi-fase): rotate con `serve` MANUALE vivo (pidfile) e service
// manager spento -> warning esplicito (il vecchio token resta cachato nel processo).
test('token rotate: serve manuale vivo (pidfile) -> warning esplicito', () => {
  const { home } = initHome();
  const pidPath = path.join(home, '.nexuscrew', 'nexuscrew.pid');
  // pid nostro (vivo per definizione), cmd vuoto = match conservativo di isAlive
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, cmd: '' }) + '\n', { mode: 0o600 });
  process.env.NEXUSCREW_PIDFILE = pidPath;
  const l = [];
  try {
    tokenRotate({ home, platform: 'linux', log: (m) => l.push(m), execImpl: () => { throw new Error('inactive'); } });
  } finally { delete process.env.NEXUSCREW_PIDFILE; }
  assert.ok(l.join('\n').includes('server manuale attivo'), 'deve avvisare del serve manuale vivo');
  fs.rmSync(home, { recursive: true, force: true });
});
