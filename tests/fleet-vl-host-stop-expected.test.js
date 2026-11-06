'use strict';
// Il DOWN con stop protetto. Il comando amministrativo porta
// `--expected <tuple>` con la tuple REGISTRATA NEL CONTESTO ALL'UP (pezzo 2):
// il down ferma solo l'host che il lancio ha attestato. I rifiuti protetti
// (peer_mismatch, peer_unknown, expected_invalid) sono un NO assoluto: zero
// Shutdown, nessun ripiego sul vecchio `vl shutdown`, nessuna adozione di un
// record pending. Un contesto v2 senza tuple registrata non si promuove al
// down: rifiuto visibile, zero comandi.
//
// Fixture: fake tmux a stato vero (control-channel), fake `vl` qualificato con
// processo host VERO (helper detached: pid==pgid==sid, osservabile in /proc),
// HOME isolata in /tmp. Nessun tmux/vl/cella veri, nessun ~/.nexuscrew reale.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const hostStop = require('../lib/fleet/vl-host-stop.js');

const SESSIONE = 'cloud-CellaExp';
const OWNER = 'a'.repeat(32);
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

// Un host VERO: leader del proprio gruppo e della propria sessione
// (spawn detached => setsid), vive finché il test non lo ferma.
function avviaHostHelper() {
  const figlio = spawn(process.execPath, ['-e',
    'process.on("SIGTERM", () => process.exit(0)); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1 << 30);'],
  { detached: true, stdio: 'ignore' });
  figlio.unref();
  return figlio;
}

const vivo = (p) => {
  try { process.kill(p, 0); return true; } catch { return false; }
};

const attendiVivo = async (figlio) => {
  for (let i = 0; i < 100; i += 1) {
    if (vivo(figlio.pid)) return;
    await dormi(20);
  }
  throw new Error('helper host non partito');
};

function mondo(t, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-host-stop-expected-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaExp');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  // Modalita' del comando di stop: '' (ack normale) oppure la REASON del
  // rifiuto protetto ('peer_mismatch', 'peer_unknown', 'expected_invalid'):
  // nessun segnale all'host, solo la riga di esito e exit 1. I valori sono le
  // reason del contratto VL, cosi' il test scrive nel file la stessa parola
  // che aspetta di leggere nell'esito.
  const modef = path.join(root, 'stopmode');
  const vllog = path.join(root, 'vl.log');
  fs.writeFileSync(vllog, '');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const LOG = ${JSON.stringify(vllog)};
const HOSTPID = ${JSON.stringify(hostpid)};
const MODE = ${JSON.stringify(modef)};
const nota = (c) => fs.appendFileSync(LOG, c + '\\n');
const leggiPid = () => { try { return Number(fs.readFileSync(HOSTPID, 'utf8').trim()) || 0; } catch { return 0; } };
const esiste = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// La tuple kernel del peer, letta da /proc col parsing di osservaPeerKernel:
// coincide con quella che il runtime registra all'up e confronta al down.
const identitaKernel = (p) => {
  let stat;
  try { stat = fs.readFileSync('/proc/' + p + '/stat', 'utf8'); } catch { return null; }
  const fine = stat.lastIndexOf(')');
  if (fine < 0) return null;
  const campi = stat.slice(fine + 2).trim().split(/\\s+/);
  let uid = null;
  try {
    const riga = fs.readFileSync('/proc/' + p + '/status', 'utf8')
      .split('\\n').find((r) => r.startsWith('Uid:'));
    uid = Number(riga.trim().split(/\\s+/)[2]);
  } catch { return null; }
  let ino = null;
  try { ino = fs.statSync('/proc/' + p + '/ns/pid').ino; } catch { return null; }
  let boot = null;
  try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; }
  return { schema_version: 1, state: 'verified', pid: p, uid,
    starttime: Number(campi[19]), boot_id: boot, pidns: ino,
    pgid: Number(campi[2]), sid: Number(campi[3]) };
};
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('vl 0.4.0\\n'); process.exit(0); }
if (argv[0] === 'host' && argv[1] === 'status') {
  nota('status');
  const p = leggiPid();
  const iRoot = argv.lastIndexOf('--server-root');
  const comune = {
    schema_version: 1, explicit_root: true, profile: 'e2emock', profile_source: 'config',
    residual_lock: null, error: null,
    server_root: iRoot >= 0 ? String(argv[iRoot + 1] || '') : '',
    capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
    peer_identity_support: 'supported',
  };
  if (String(comune.server_root).indexOf('nc-vl-cap-') !== -1) {
    process.stdout.write(JSON.stringify({ ...comune, state: 'none', declared_pid: null,
      pid_number_in_use: null, since: null }) + '\\n');
    process.exit(0);
  }
  if (p > 0 && esiste(p)) {
    process.stdout.write(JSON.stringify({ ...comune, state: 'live', declared_pid: p,
      pid_number_in_use: true, since: { source: 'declared', unix: 1 },
      peer_identity: identitaKernel(p) }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ ...comune, state: 'none', declared_pid: null,
      pid_number_in_use: null, since: null }) + '\\n');
  }
  process.exit(0);
}
if ((argv[0] === 'internal' && argv[1] === 'host-stop') || argv[0] === 'shutdown') {
  // Argv COMPLETO nel log: il test prova che lo stop porta --expected con la
  // tuple registrata, e che il vecchio comando non viene mai chiamato.
  nota('stop ' + argv.join(' '));
  const mode = fs.existsSync(MODE) ? fs.readFileSync(MODE, 'utf8').trim() : '';
  const rifiuta = (reason) => {
    process.stdout.write(JSON.stringify({ ok: false, reason }) + '\\n');
    process.exit(1);
  };
  if (mode === 'peer_mismatch') rifiuta('peer_mismatch');
  if (mode === 'peer_unknown') rifiuta('peer_unknown');
  if (mode === 'expected_invalid') rifiuta('expected_invalid');
  const p = leggiPid();
  if (p > 0) {
    try { process.kill(p, 'SIGTERM'); } catch {}
    for (let i = 0; i < 80 && esiste(p); i += 1) attesa(25);
    fs.writeFileSync(HOSTPID, '0\\n');
  }
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const killLog = path.join(root, 'kill.log');
  fs.writeFileSync(killLog, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      n += 1;
      const r = spawnSync(process.execPath,
        [__filename, '-S', process.argv[3] || 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      } else {
        process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const STATO = ${JSON.stringify(statoPath)};
const KILLLOG = ${JSON.stringify(killLog)};
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
const cmd = args[0] || '';
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('@nc_delivery')) { process.stdout.write('submitted\\n'); process.exit(0); }
  if ((typeof fmt === 'string' ? fmt : process.argv.join(' ')).includes('pane_pid')) { process.stdout.write('4242\\t2222\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  if (mia) {
    fs.appendFileSync(KILLLOG, 'kill\\n');
    fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(SESSIONE)}).map((n) => n + '\\n').join(''));
  }
  process.exit(0);
}
if (cmd === 'has-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  process.exit(mia && vive().includes(${JSON.stringify(SESSIONE)}) ? 0 : 1);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL', rc: false,
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaExp', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: 'Leggi CLAUDE.md e parti' }],
  });

  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {},
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    platform: 'linux', env: {},
    identityOwnerInstanceId: OWNER,
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    now: () => 0, monotonicNow: () => 0,
    ...extraCfg,
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, home, hostpid, modef, vllog, statoPath, cfgBase,
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

const righeStop = (w) => fs.readFileSync(w.vllog, 'utf8').split('\n')
  .filter((r) => r.startsWith('stop '));
const stopLegacy = (w) => righeStop(w).filter((r) => r.startsWith('stop shutdown')).length;
const sessioniVive = (w) => fs.readFileSync(w.statoPath, 'utf8').split('\n').filter(Boolean);
const leggiCtx = (w) => {
  const dir = vlCellBaseDir(w.home, OWNER, 'CellaExp');
  return { dir, ctx: hostStop.leggiContesto(dir) };
};

// 1. Il positivo: il down ferma l'host con lo stop protetto — il comando porta
//    `--expected` con la TUPLE REGISTRATA ALL'UP (non una letta al volo),
//    l'host esce davvero e il lancio si chiude (un nuovo up e' ammesso).
test('stop expected positivo: --expected con la tuple registrata, host fermo, lancio chiuso', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);

  const up = await fleet.up('CellaExp');
  assert.equal(up.ok, true, JSON.stringify(up));
  const { ctx } = leggiCtx(w);
  assert.ok(ctx && !ctx.errore, 'contesto v2 leggibile');
  const tupla = hostStop.tuplaAttesaDaRecord({ hostIdentity: ctx.hostIdentity });
  assert.ok(tupla, 'tuple registrata all\'up');

  const down = await fleet.down('CellaExp');
  assert.equal(down.ok, true, JSON.stringify(down));
  for (let i = 0; i < 80 && vivo(host.pid); i += 1) await dormi(25);
  assert.equal(vivo(host.pid), false, 'l\'host attestato e\' uscito per lo stop');
  assert.equal(righeStop(w).length, 1, 'un solo comando di stop');
  assert.equal(stopLegacy(w), 0, 'nessun vecchio comando');
  assert.equal(righeStop(w)[0],
    `stop internal host-stop --server-root ${ctx.serverRoot} --json --expected ${tupla}`,
    'il comando porta --expected con la tuple del contesto');

  // Il lancio e' chiuso: con un host nuovo attestato il up e' riammesso.
  const host2 = avviaHostHelper();
  t.after(() => { try { host2.kill('SIGKILL'); } catch {} });
  await attendiVivo(host2);
  fs.writeFileSync(w.hostpid, `${host2.pid}\n`);
  const up2 = await fleet.up('CellaExp');
  assert.equal(up2.ok, true, 'nuovo up ammesso dopo lo stop protetto pulito');
});

// 2/3/4. I rifiuti protetti: il comando gira (CLI), l'host NON viene toccato,
//    zero Shutdown, NESSUN ripiego sul vecchio stop, il contesto resta con la
//    tuple registrata e la sessione resta in piedi: il lancio non si chiude.
const RIFIUTI = [
  ['peer_mismatch', 'HOST_PEER_MISMATCH'],
  ['peer_unknown', 'HOST_PEER_UNKNOWN'],
  ['expected_invalid', 'HOST_EXPECTED_INVALID'],
];
for (const [modo, codice] of RIFIUTI) {
  test(`rifiuto protetto ${modo}: ${codice}, zero stop, nessun ripiego, record trattenuto`, async (t) => {
    const w = mondo(t);
    const fleet = await w.fleet();
    const host = avviaHostHelper();
    t.after(() => { try { host.kill('SIGKILL'); } catch {} });
    await attendiVivo(host);
    fs.writeFileSync(w.hostpid, `${host.pid}\n`);
    await fleet.up('CellaExp');

    fs.writeFileSync(w.modef, `${modo}\n`);
    await assert.rejects(() => fleet.down('CellaExp'), (e) => e.status === 500
      && e.fleetCode === codice
      && e.data && e.data.reason === modo
      && e.data.outcome === 'host-stop-failed');
    assert.equal(vivo(host.pid), true, 'nessun Shutdown: l\'host e\' vivo');
    assert.equal(righeStop(w).length, 1, 'il CLI di stop e\' girato una volta');
    assert.equal(stopLegacy(w), 0, 'nessuna chiamata al vecchio stop');
    assert.equal(sessioniVive(w).length, 1, 'nessun teardown della sessione');
    const { ctx } = leggiCtx(w);
    assert.ok(ctx && !ctx.errore && ctx.hostIdentity.state === 'live',
      'il contesto resta con la tuple registrata');

    // Il lancio non si chiude su un rifiuto protetto: il up resta bloccato
    // (STOP_UNKNOWN, come ogni down incompleto) e nessun comando nuovo parte.
    await assert.rejects(() => fleet.up('CellaExp'), (e) => e.fleetCode === 'STOP_UNKNOWN',
      'il lancio incerto non si riapre da solo');
    assert.equal(righeStop(w).length, 1, 'nessun altro comando di stop');
    assert.equal(stopLegacy(w), 0, 'ancora nessun ripiego sul vecchio stop');
    assert.equal(vivo(host.pid), true, 'l\'host e\' ancora vivo');
  });
}

// 5. Un contesto v2 SENZA tuple registrata (pending) non si promuove al down:
//    rifiuto visibile, ZERO comandi di stop, l'host resta vivo.
test('record pending senza tuple: rifiuto visibile, zero comandi di stop', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);
  await fleet.up('CellaExp');

  // Fuori banda (il crash che perde la registrazione): il contesto v2 torna
  // pending. Il down non adotta il pending e non si inventa una tuple.
  const { dir, ctx } = leggiCtx(w);
  assert.ok(ctx && !ctx.errore && ctx.hostIdentity.state === 'live');
  fs.writeFileSync(path.join(dir, 'host-context.json'),
    JSON.stringify({ ...ctx, hostIdentity: { state: 'pending' } }));

  await assert.rejects(() => fleet.down('CellaExp'), (e) => e.status === 500
    && e.fleetCode === 'HOST_STOP_FAILED'
    && e.data && e.data.motivoIsolamento === 'identita');
  assert.equal(righeStop(w).length, 0, 'ZERO comandi di stop');
  assert.equal(stopLegacy(w), 0, 'nessun vecchio stop');
  assert.equal(vivo(host.pid), true, 'l\'host non e\' stato toccato');
  assert.equal(sessioniVive(w).length, 1, 'nessun teardown');
});
