'use strict';
// Isolamento dell'host prima dello stop. Il probe di stato non e' un'identita':
// finche' manca l'attestazione del peer, un host vivo blocca segnali, teardown
// e shutdown. Il completamento dello schema non qualifica un binario.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const host = require('../lib/fleet/vl-host-stop.js');
const { creaCoordinatore } = require('../lib/fleet/group-stop.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const { OWNER_INSTANCE_ID, scriptVlFintoConHost, preparaHostFinto } = require('./helpers/vl-attestato.js');
const { spawnSync } = require('node:child_process');

const BOOT = '11111111-1111-1111-1111-111111111111';

function identita(extra = {}) {
  return {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: 'ab'.repeat(16),
    pid: 50,
    uid: 1,
    bootId: BOOT,
    pidNamespaceInode: '9',
    startTicks: '100',
    pgid: 50,
    sid: 50,
    ...extra,
  };
}

function nodo() {
  return { bootId: BOOT, pidNamespaceInode: '9' };
}

test('schema: pending si completa solo con la tuple chiusa', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-id-'));
  const bin = path.join(home, 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const base = host.contestoIniziale({
    launchId: 'cd'.repeat(8),
    vlBin: bin,
    vlBinSha256: host.sha256File(bin),
    XDG_STATE_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CONFIG_HOME: home,
    HOME: home,
    uid: 1,
    serverRoot: path.join(home, 'root'),
    ts: 1,
  });
  host.scriviContesto(home, base);
  const letto = host.leggiContesto(home);
  assert.equal(letto.version, 2);
  assert.deepEqual(letto.hostIdentity, { state: 'pending' });
  assert.equal(host.completaIdentita(base, { pid: 50 }), null);
  const vivo = host.completaIdentita(base, identita());
  assert.equal(vivo.hostIdentity.state, 'live');
  assert.equal(vivo.hostIdentity.pid, 50);
});

test('giudizio: leader di un\'altra sessione e\' isolato; stesso gruppo no', () => {
  const registrata = identita();
  const coord = { pid: 7, pgid: 7, sid: 9 };
  assert.equal(host.giudicaIsolamento({
    registrata, osservata: identita(), coordinatore: coord, nodo: nodo(),
  }), 'isolato');
  assert.equal(host.giudicaIsolamento({
    registrata, osservata: identita(), coordinatore: { pid: 7, pgid: 50, sid: 9 }, nodo: nodo(),
  }), 'nel-gruppo');
  assert.equal(host.giudicaIsolamento({
    registrata, osservata: identita(), coordinatore: { pid: 7, pgid: 8, sid: 50 }, nodo: nodo(),
  }), 'ignoto');
  assert.equal(host.giudicaIsolamento({
    registrata, osservata: identita({ startTicks: '101' }), coordinatore: coord, nodo: nodo(),
  }), 'ignoto');
  assert.equal(host.giudicaIsolamento({
    registrata, osservata: identita({ uid: 2 }), coordinatore: coord, nodo: nodo(),
  }), 'ignoto');
  assert.equal(host.giudicaIsolamento({
    registrata: { state: 'live', pid: 50 }, osservata: identita(), coordinatore: coord, nodo: nodo(),
  }), 'ignoto');
  assert.equal(host.giudicaIsolamento({
    registrata, osservata: identita(), coordinatore: coord, nodo: { bootId: BOOT, pidNamespaceInode: '8' },
  }), 'ignoto');
});

test('record legacy o versione ignota non diventa un host noto', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-leg-'));
  const bin = path.join(home, 'vl');
  fs.writeFileSync(bin, 'x', { mode: 0o755 });
  const base = {
    launchId: 'ef'.repeat(8),
    vlBin: bin,
    vlBinSha256: host.sha256File(bin),
    XDG_STATE_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CONFIG_HOME: home,
    HOME: home,
    uid: 1,
    serverRoot: path.join(home, 'root'),
    ts: 1,
  };
  host.scriviContesto(home, base);
  const legacy = host.leggiContesto(home);
  assert.equal(legacy.version, undefined);
  host.scriviContesto(home, { ...base, version: 9, hostIdentity: { state: 'pending' } });
  const ignota = host.leggiContesto(home);
  assert.equal(ignota.errore, 'versione');
  assert.equal(ignota.launchId, base.launchId);
});

test('prepare del coordinatore non invia segnali', async () => {
  const frames = [];
  const segnali = [];
  let cancellata = false;
  const launchId = 'aa'.repeat(8);
  const c = creaCoordinatore({
    token: 't'.repeat(32),
    launchId,
    monoNow: () => 0,
    sleep: async () => {},
    killGruppo: (s) => segnali.push(s),
    osserva: () => ({ inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
    invia: (f) => frames.push(f),
    dichiaraStopping: () => {},
    disarmaLegacy: () => {},
    installaIgnoraTerm: () => {},
    cancellaDelivery: async () => { cancellata = true; },
  });
  c.onFrame({
    op: 'prepare', requestId: 'bb'.repeat(8), launchId, epoch: 1, payload: {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(cancellata, true);
  assert.deepEqual(segnali, []);
  assert.equal(frames[0] && frames[0].op, 'prepare-ack');
});

function mondoLive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-iso-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaIso');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const logPath = path.join(root, 'vl.log');
  fs.writeFileSync(logPath, '');
  const killPath = path.join(root, 'kill.log');
  fs.writeFileSync(killPath, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  // Binario finto QUALIFICATO peer/stop con host VERO: la tuple dichiarata in
  // `host status` viene letta da /proc del pid vivo nel pidfile. L'up attesta
  // il peer; il test poi sostituisce l'host (respawn) prima del down, così la
  // tuple osservata non e' più quella registrata: attestazione persa.
  const hostScript = preparaHostFinto(root);
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ version: 'vl 0.3.1', hostpid, vllog: logPath }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const HOSTSCRIPT = ${JSON.stringify(hostScript)};
const HOSTPID = ${JSON.stringify(hostpid)};
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === 'kill-session') fs.appendFileSync(${JSON.stringify(killPath)}, 'kill\\n');
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue; // apertura: gia' risolta dal frame iniziale
      n += 1;
      if (riga.startsWith('kill-session')) fs.appendFileSync(${JSON.stringify(killPath)}, 'kill\\n');
      process.stdout.write('%begin 1 ' + n + ' 1\\n' + (riga.startsWith('display-message') && riga.includes('pane_pid') ? '4242\\t2222\\n' : '') + '%end 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
if (args[0] === 'new-session') {
  // Come la TUI vera, che l'host lo fa nascere all'avvio: ogni new-session
  // fa nascere un host nuovo (il vecchio pid, se vivo, viene spento per pid
  // esatto dall'helper).
  { const { spawnSync: riavviaHost } = require('node:child_process');
    riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
  process.stdout.write('$3\\t@3\\t%3\\n'); process.exit(0);
}
if (args[0] === 'display-message' && process.argv.join(' ').includes('pane_pid')) { process.stdout.write('4242\\t2222\\n'); process.exit(0); }
if (args[0] === 'display-message') { process.stdout.write('0\\t0\\t%3\\n'); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaIso', tmuxSession: 'cloud-CellaIso', cwd, engine: 'vl.native', boot: false }],
  });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: false, vlLaunchCooldownMs: 0, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    // Owner hex32 della tuple attestata all'up: con `local` l'up e' rifiutato.
    // Qui e' un'opzione del runtime (in createBuiltinFleet sta dentro cfg).
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'f'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: loadDefinitions(defsPath),
  });
  t.after(() => {
    // Zero orfani: l'host finto si spegne per pid esatto prima della pulizia.
    try {
      const p = Number(fs.readFileSync(hostpid, 'utf8').trim()) || 0;
      if (p > 0) process.kill(p, 'SIGKILL');
    } catch (_) {}
    try { runtime.shutdown(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { runtime, home, filesRoot, logPath, killPath, hostScript, hostpid };
}

// Con il pezzo 2 l'attestazione nasce ALL'UP (peer verified registrato nel
// contesto del lancio): un binario qualificato senza attestazione rifiuta
// l'up, non il down. Quello che qui resta da provare è l'altro lato del
// contratto: l'host REGISTRATO viene SOSTITUITO prima del down — la tuple
// osservata non è più quella attestata — e il down rifiuta senza segnali,
// conservando claim e blocco del riavvio.
test('host sostituito dopo l\'up: attestazione persa — niente segnali, claim conservato, riavvio bloccato', async (t) => {
  const w = mondoLive(t);
  await w.runtime.up('CellaIso');
  // Sostituzione: l'host attestato esce e il suo posto è preso da un ALTRO
  // processo (respawn: spegne il vecchio per pid esatto, ne fa nascere uno).
  spawnSync(process.execPath, [w.hostScript, '--respawn', w.hostpid]);
  await assert.rejects(() => w.runtime.down('CellaIso'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  const log = fs.readFileSync(w.logPath, 'utf8');
  assert.match(log, /host status/);
  assert.doesNotMatch(log, /shutdown/);
  assert.doesNotMatch(log, /host-stop/, 'nessun comando di stop emesso');
  assert.equal(fs.readFileSync(w.killPath, 'utf8'), '');
  const lease = fs.readdirSync(path.join(w.home, '.nexuscrew', 'vl-root-claims')).filter((n) => n.endsWith('.lease'));
  assert.ok(lease.length >= 1);
  const record = path.join(w.filesRoot, launchTarget.DIR, 'cloud-CellaIso.json');
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).incerto, true);
  await assert.rejects(() => w.runtime.up('CellaIso'), (e) => e.fleetCode === 'STOP_UNKNOWN');
});
