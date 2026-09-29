'use strict';
// U2: npm dell'update = STESSO node del demone, prova del prefix prima di installare, log d'ambiente redatto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const npmEnv = require('../lib/update/npm-env.js');
const { runUpdate } = require('../lib/update/runner.js');
const core = require('../lib/update/core.js');

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ne-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const NODE = '/opt/daemon/bin/node';
const CLI = '/opt/daemon/lib/node_modules/npm/bin/npm-cli.js';

test('resolveNpmInvocation: usa il node del demone con l\'npm-cli accanto (Linux/Termux/Homebrew/nvm)', () => {
  for (const [node, cli] of [
    ['/opt/daemon/bin/node', '/opt/daemon/lib/node_modules/npm/bin/npm-cli.js'],
    ['/data/data/com.termux/files/usr/bin/node', '/data/data/com.termux/files/usr/lib/node_modules/npm/bin/npm-cli.js'],
    ['/opt/homebrew/Cellar/node/26.0.0/bin/node', '/opt/homebrew/Cellar/node/26.0.0/lib/node_modules/npm/bin/npm-cli.js'],
  ]) {
    const inv = npmEnv.resolveNpmInvocation({ execPath: node, exists: (p) => p === cli, realpath: (p) => p, env: { PATH: '/usr/bin' } });
    assert.equal(inv.bin, node); assert.deepEqual(inv.argvPrefix, [cli]); assert.equal(inv.kind, 'node-npm-cli');
    assert.ok(inv.env.PATH.startsWith(path.dirname(node)), 'il PATH degli script parte dal node del demone');
  }
});

test('proot: il PATH della shell ha un altro node in testa, ma npm gira col node del DEMONE (mai «npm» nudo)', () => {
  const inv = npmEnv.resolveNpmInvocation({ execPath: NODE, exists: (p) => p === CLI, realpath: (p) => p, env: { PATH: '/usr/bin:/usr/local/bin' } });
  assert.notEqual(inv.bin, 'npm');
  assert.equal(inv.bin, NODE);
});

test('senza npm-cli accanto: ripiego su npm del PATH, dichiarato come tale (la preflight deve provare dove scrive)', () => {
  const inv = npmEnv.resolveNpmInvocation({ execPath: '/x/bin/node', exists: () => false, realpath: (p) => p, env: { PATH: '/usr/bin' } });
  assert.equal(inv.kind, 'path-npm'); assert.equal(inv.bin, 'npm');
});

test('nodeRangeOk: engines di npm 12 contro versioni di node', () => {
  const r = '^22.14.0 || >=24.10.0';
  assert.equal(npmEnv.nodeRangeOk('v20.11.0', r), false);
  assert.equal(npmEnv.nodeRangeOk('v22.15.0', r), true);
  assert.equal(npmEnv.nodeRangeOk('v26.0.0', r), true);
  assert.equal(npmEnv.nodeRangeOk('v22.10.0', r), false);
  assert.equal(npmEnv.nodeRangeOk('v20.0.0', '>=18'), true);
  assert.equal(npmEnv.nodeRangeOk('v20.0.0', 'roba-strana'), true, 'range illeggibile: non blocca');
});

function preflightSeams(over = {}) {
  return { invocation: { bin: NODE, argvPrefix: [CLI], env: {}, npmCli: CLI }, packageRoot: '/opt/daemon/lib/node_modules/@mmmbuto/nexuscrew', home: '/home/u',
    nodeVersion: 'v26.0.0', realpath: (p) => p, readFile: () => JSON.stringify({ engines: { node: '^22.14.0 || >=24.10.0' } }),
    execImpl: () => '/opt/daemon/lib/node_modules\n', ...over };
}

test('preflight: engines di npm non soddisfatti dal node del demone -> errore prima di installare', () => {
  assert.throws(() => npmEnv.npmPreflight(preflightSeams({ nodeVersion: 'v20.11.0' })), /npm richiede node .* v20\.11\.0/);
});

test('preflight: npm -g installerebbe altrove (portatile, npx, copia locale) -> errore che nomina i due percorsi, redatti', () => {
  assert.throws(() => npmEnv.npmPreflight(preflightSeams({ execImpl: () => '/home/u/.local/lib/node_modules\n' })), (e) => /installerebbe in ~\/\.local\/lib\/node_modules\/@mmmbuto\/nexuscrew/.test(e.message) && /esegue \/opt\/daemon/.test(e.message) && !/\/home\/u/.test(e.message));
});

test('preflight: prefix coerente (anche via symlink) -> ok', () => {
  const r = npmEnv.npmPreflight(preflightSeams({ realpath: (p) => p.replace('/opt/link', '/opt/daemon'), execImpl: () => '/opt/link/lib/node_modules\n' }));
  assert.equal(r.globalRoot, '/opt/link/lib/node_modules');
});

test('readInstalledFrom: legge il package.json del percorso ESEGUITO (realpath), non di un altro albero', (t) => {
  const real = tmp(t); const link = path.join(tmp(t), 'link');
  fs.writeFileSync(path.join(real, 'package.json'), JSON.stringify({ version: '0.9.53' }));
  fs.symlinkSync(real, link);
  const r = npmEnv.readInstalledFrom(link);
  assert.equal(r.version, '0.9.53'); assert.equal(r.path, fs.realpathSync(real));
});

test('redact + describeEnv: niente home ne\' segreti nel log d\'ambiente', () => {
  const tok = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const text = npmEnv.describeEnv({ execPath: '/home/u/n/bin/node', envPath: `/home/u/.local/bin:/opt/${tok}/bin:/usr/bin`, home: '/home/u', nodeVersion: 'v26.0.0' });
  assert.match(text, /node=~\/n\/bin\/node/); assert.match(text, /PATH=~\/\.local\/bin:/);
  assert.ok(!text.includes(tok)); assert.ok(!text.includes('/home/u'));
});

// ---- wiring in runUpdate ----------------------------------------------------------------------------------------

function runSeams(dir, over = {}) {
  const calls = []; const logs = []; let installed = '0.9.50';
  return { calls, logs, opts: {
    version: '0.9.51', home: dir, statusPath: path.join(dir, '.nexuscrew', 'npm-update.json'), cwd: dir,
    log: (m) => logs.push(String(m)),
    npmInvocationImpl: () => ({ kind: 'node-npm-cli', bin: NODE, argvPrefix: [CLI], env: { PATH: '/opt/daemon/bin' }, npmCli: CLI }),
    npmPreflightImpl: () => ({ globalRoot: '/x' }),
    execImpl: (bin, argv, o) => { calls.push({ bin, argv, env: o && o.env }); logs.push('<npm>'); const v = argv.find((a) => a.startsWith('@mmmbuto/nexuscrew@')); if (v) installed = v.split('@').pop(); },
    readInstalledVersion: () => installed, preflightImpl: async () => true, healBootImpl: () => ({}),
    restartImpl: async () => { logs.push('<restart>'); return 'portable'; }, ...over,
  } };
}

test('runUpdate: npm parte come <node del demone> <npm-cli> install --global, con l\'env di quel node', async (t) => {
  const dir = tmp(t); const s = runSeams(dir);
  await runUpdate(s.opts);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].bin, NODE);
  assert.deepEqual(s.calls[0].argv.slice(0, 3), [CLI, 'install', '--global']);
  assert.ok(s.calls[0].argv.includes('@mmmbuto/nexuscrew@0.9.51'));
  assert.equal(s.calls[0].env.PATH, '/opt/daemon/bin');
});

test('runUpdate: preflight che fallisce = nessun install, stato errore con la causa, nessun blocco versione', async (t) => {
  const dir = tmp(t);
  const s = runSeams(dir, { npmPreflightImpl: () => { throw new Error('npm -g installerebbe in ~/x ma il processo esegue /y'); } });
  await assert.rejects(runUpdate(s.opts), /installerebbe/);
  assert.equal(s.calls.length, 0, 'npm install non e\' stato lanciato');
  const st = core.readState(s.opts.statusPath);
  assert.equal(st.phase, 'error'); assert.match(st.lastError, /installerebbe/); assert.equal(st.blockedVersion, '');
});

test('runUpdate: il log d\'ambiente esce PRIMA di npm e DOPO il restart, redatto', async (t) => {
  const dir = tmp(t); const s = runSeams(dir, { envPath: `${dir}/bin:/usr/bin`, execPath: `${dir}/node` });
  await runUpdate(s.opts);
  const marks = s.logs.map((l) => (/env-check\[pre-install\]/.test(l) ? 'pre' : /env-check\[post-restart\]/.test(l) ? 'post' : l));
  assert.ok(marks.indexOf('pre') !== -1 && marks.indexOf('pre') < marks.indexOf('<npm>'));
  assert.ok(marks.indexOf('post') > marks.indexOf('<restart>'));
  assert.ok(!s.logs.join('\n').includes(dir), 'nessun percorso di home in chiaro');
});

test('runUpdate: verifica di versione col percorso eseguito nel messaggio (redatto) quando non corrisponde', async (t) => {
  const dir = tmp(t);
  const s = runSeams(dir, { readInstalledVersion: () => '0.9.50', readInstalledFromImpl: () => ({ path: `${dir}/lib/@mmmbuto/nexuscrew`, version: '0.9.50' }) });
  await assert.rejects(runUpdate(s.opts), (e) => /attesa 0\.9\.51, trovata 0\.9\.50/.test(e.message));
});

test('lookupLatestNpm: anche la lettura del registry usa il node del demone, non «npm» nudo', async (t) => {
  const { lookupLatestNpm } = require('../lib/update/manager.js');
  const dir = tmp(t); let seen;
  const v = await lookupLatestNpm({
    home: dir, cwd: dir,
    npmInvocationImpl: () => ({ kind: 'node-npm-cli', bin: NODE, argvPrefix: [CLI], env: { PATH: '/opt/daemon/bin' }, npmCli: CLI }),
    execFileImpl: (bin, argv, o, cb) => { seen = { bin, argv, env: o.env }; cb(null, '"0.9.51"\n'); },
  });
  assert.equal(v, '0.9.51');
  assert.equal(seen.bin, NODE);
  assert.deepEqual(seen.argv.slice(0, 2), [CLI, 'view']);
  assert.equal(seen.env.PATH, '/opt/daemon/bin');
});
