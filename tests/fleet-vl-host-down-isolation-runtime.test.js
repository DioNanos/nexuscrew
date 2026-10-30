'use strict';
// D-558 FIX2b (F1, audit finale DevAuditor) — il RUNTIME calcola l'isolamento
// dell'host VL del lancio: probe dello stato sul binario pinnato, osservazione
// KERNEL del peer dichiarato, confronto con la tuple registrata nel contesto v2
// al primo sguardo, giudizio ternario (isolato / nel-gruppo / ignoto) passato a
// fermaHost. Questi test provano il cammino del runtime, NON il modulo con un
// parametro `isolato` costante: fermaHost qui è quello VERO e lo spawn pure.
//
// Fixture: fake tmux a stato vero (control-channel), fake `vl` che risponde per
// un processo host VERO (helper detached: pid==pgid==sid, osservabile in /proc),
// HOME isolata in /tmp. Nessun tmux/vl/cella veri, nessun ~/.nexuscrew reale.
// Il fake `vl` non consulta la --server-root: dichiara l'host del file hostpid,
// così il test governa la vitalità dell'host con processi reali.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = 'cloud-CellaIso';
const OWNER = 'a'.repeat(32);
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

// Un host VERO: leader del proprio gruppo e della propria sessione
// (spawn detached => setsid), vive finché il test non lo ferma. E' il peer
// che il runtime deve osservare in /proc.
function avviaHostHelper() {
  const figlio = spawn(process.execPath, ['-e',
    'process.on("SIGTERM", () => process.exit(0)); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1 << 30);'],
  { detached: true, stdio: 'ignore' });
  figlio.unref();
  return figlio;
}

const vivo = (p) => {
  try { process.kill(p, 0); return true; } catch (_) { return false; }
};

const attendiVivo = async (figlio) => {
  for (let i = 0; i < 100; i += 1) {
    if (vivo(figlio.pid)) return;
    await dormi(20);
  }
  throw new Error('helper host non partito');
};

function mondo(t, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558f1-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaIso');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  const modef = path.join(root, 'stopmode');
  const nopidf = path.join(root, 'live-no-pid');
  const vllog = path.join(root, 'vl.log');
  fs.writeFileSync(vllog, '');
  const muori = path.join(root, 'muori');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const LOG = ${JSON.stringify(vllog)};
const HOSTPID = ${JSON.stringify(hostpid)};
const MODE = ${JSON.stringify(modef)};
const NOPID = ${JSON.stringify(nopidf)};
const nota = (c) => fs.appendFileSync(LOG, c + '\\n');
const leggiPid = () => { try { return Number(fs.readFileSync(HOSTPID, 'utf8').trim()) || 0; } catch (_) { return 0; } };
const esiste = (p) => { try { process.kill(p, 0); return true; } catch (_) { return false; } };
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('vl 0.4.0\\n'); process.exit(0); }
if (argv[0] === 'host' && argv[1] === 'status') {
  nota('status');
  const p = leggiPid();
  if (p > 0 && esiste(p)) {
    process.stdout.write(JSON.stringify({ state: 'live', pid: p, capabilities: ['host_stop_v1'] }) + '\\n');
  } else if (fs.existsSync(NOPID)) {
    process.stdout.write(JSON.stringify({ state: 'live', capabilities: ['host_stop_v1'] }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ state: 'none' }) + '\\n');
  }
  process.exit(0);
}
if (argv[0] === 'internal' && argv[1] === 'host-stop') {
  nota('host-stop');
  const mode = fs.existsSync(MODE) ? fs.readFileSync(MODE, 'utf8').trim() : '';
  if (mode === 'hang') { attesa(30000); process.exit(9); }
  if (mode === 'reject') {
    process.stdout.write('{"ok":false,"reason":"shutdown_rejected"}\\n');
    process.exit(1);
  }
  const p = leggiPid();
  if (p > 0) {
    try { process.kill(p, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 80 && esiste(p); i += 1) attesa(25);
  }
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.exit(0);
}
if (argv[0] === 'shutdown') { nota('legacy-shutdown'); process.stdout.write('{"ok":true}\\n'); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
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
  const sparisco = () => { if (fs.existsSync(${JSON.stringify(muori)})) process.exit(0); };
  setInterval(sparisco, 25);
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
    cells: [{ id: 'CellaIso', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: 'Leggi CLAUDE.md e parti' }],
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
  const mondoCfg = cfgBase;
  return {
    root, home, filesRoot, hostpid, modef, nopidf, vllog, muori, statoPath, mondoCfg,
    async fleet() {
      const f = await createBuiltinFleet(mondoCfg);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

const conta = (file, cosa) => fs.readFileSync(file, 'utf8').split('\n').filter((r) => r === cosa).length;
const sessioniVive = (w) => fs.readFileSync(w.statoPath, 'utf8').split('\n').filter(Boolean);

// 1. Il ciclo promesso dal recupero D-558: host vivo e ISOLATO (kernel vero,
//    nessun seam) → down pulito → l'host esce davvero → nuovo up ammesso.
test('F1: host vivo isolato → down pulito, host uscito, up riammesso', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);

  const up1 = await fleet.up('CellaIso');
  assert.equal(up1.ok, true);

  const down = await fleet.down('CellaIso');
  assert.equal(down.ok, true, JSON.stringify(down));
  assert.equal(down.killed, true);
  // L'host vero e' uscito per lo stop del runtime (non per il teardown della sessione).
  for (let i = 0; i < 80 && vivo(host.pid); i += 1) await dormi(25);
  assert.equal(vivo(host.pid), false, "l'host isolato e' stato fermato");
  assert.equal(conta(w.vllog, 'host-stop'), 1, 'esattamente uno stop host');

  // Identita' registrata nel contesto v2 al primo sguardo del lancio.
  const ctx = JSON.parse(fs.readFileSync(path.join(vlCellBaseDir(w.home, OWNER, 'CellaIso'), 'host-context.json'), 'utf8'));
  assert.equal(ctx.version, 2);
  assert.equal(ctx.hostIdentity.state, 'live');
  assert.equal(ctx.hostIdentity.source, 'kernel-peer-v1');
  assert.equal(ctx.hostIdentity.pid, host.pid);

  const up2 = await fleet.up('CellaIso');
  assert.equal(up2.ok, true, 'nuovo up ammesso dopo il down pulito');
});

// 2. Host nel gruppo del coordinatore: rifiuto 409 HOST_IN_GROUP, nessuno stop.
//    Il peer resta osservato dal kernel (helper vero, leader del suo gruppo):
//    il seam dichiara soltanto il coordinatore, che nel runner reale sarebbe
//    /proc/self del runtime.
test('F1: host nel gruppo del coordinatore → HOST_IN_GROUP, host non toccato', async (t) => {
  const w = mondo(t);
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);
  // Coordinatore nel gruppo DELL'HOST (seam dichiarato: nel runner reale e'
  // /proc/self del runtime): il giudizio deve vederlo e rifiutare.
  w.mondoCfg.vlIsolationSeams = { identitaCoordinatore: () => ({ pgid: host.pid, sid: 1 }) };
  const fleet = await w.fleet();
  await fleet.up('CellaIso');
  await assert.rejects(() => fleet.down('CellaIso'), (e) => e.status === 409 && e.fleetCode === 'HOST_IN_GROUP');
  assert.equal(vivo(host.pid), true, "l'host nel gruppo non e' stato toccato");
  assert.equal(conta(w.vllog, 'host-stop'), 0, 'nessun comando di stop host');
  assert.equal(sessioniVive(w).length, 1, 'la sessione resta');
});

// 3a. Identita' mutata (host sostituito tra due down): il confronto con la
//     tuple registrata fallisce, il secondo down rifiuta SENZA segnali.
test('F1: identita mutata → IDENTITY_UNKNOWN con motivo, nessuno stop', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host1 = avviaHostHelper();
  t.after(() => { try { host1.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host1);
  fs.writeFileSync(w.hostpid, `${host1.pid}\n`);
  fs.writeFileSync(w.modef, 'reject\n');
  await fleet.up('CellaIso');
  // Primo down: rifiuto dell'host (shutdown_rejected). L'identita' resta
  // registrata nel contesto perche' la qualifica l'ha gia' scritta.
  await assert.rejects(() => fleet.down('CellaIso'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.equal(conta(w.vllog, 'host-stop'), 1);

  // Sostituzione: un ALTRO processo occupa la root e dichiara il suo pid.
  try { host1.kill('SIGKILL'); } catch (_) {}
  for (let i = 0; i < 80 && vivo(host1.pid); i += 1) await dormi(25);
  const host2 = avviaHostHelper();
  t.after(() => { try { host2.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host2);
  fs.writeFileSync(w.hostpid, `${host2.pid}\n`);
  fs.writeFileSync(w.modef, '');

  await assert.rejects(() => fleet.down('CellaIso'), (e) => e.fleetCode === 'HOST_STOP_FAILED'
    && e.data && e.data.motivoIsolamento === 'ignoto');
  assert.equal(conta(w.vllog, 'host-stop'), 1, 'nessun nuovo comando di stop host');
  assert.equal(vivo(host2.pid), true, "il sostituto non e' stato fermato");
  assert.equal(sessioniVive(w).length, 1, 'la sessione resta viva');
});

// 3b. Host dichiarato vivo SENZA attestazione del peer (status live, nessun
//     pid): rifiuto con motivo bounded, zero stop, zero teardown. Il file
//     hostpid resta a 0: e' la modalita' NOPID del fake a dichiarare l'host.
test('F1: status live senza pid → IDENTITY_UNKNOWN (pid-assente), nessuno stop', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host);
  fs.writeFileSync(w.nopidf, '1\n');
  await fleet.up('CellaIso');
  await assert.rejects(() => fleet.down('CellaIso'), (e) => e.fleetCode === 'HOST_STOP_FAILED'
    && e.data && e.data.motivoIsolamento === 'pid-assente');
  assert.equal(conta(w.vllog, 'host-stop'), 0, 'nessun comando di stop host');
  assert.equal(vivo(host.pid), true);
  assert.equal(sessioniVive(w).length, 1, 'nessun teardown');
});

// 4. Rifiuto dichiarato dall'host (shutdown_rejected): fallimento pulito con
//    la parola dell'host, lancio incerto, nessuna sessione fermata.
test('F1: rifiuto dello stop da parte dell\'host → HOST_STOP_FAILED, host vivo', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);
  fs.writeFileSync(w.modef, 'reject\n');
  await fleet.up('CellaIso');
  await assert.rejects(() => fleet.down('CellaIso'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.equal(conta(w.vllog, 'host-stop'), 1, 'il rifiuto e arrivato dall\'host');
  assert.equal(vivo(host.pid), true);
  assert.equal(sessioniVive(w).length, 1);
  const record = path.join(w.filesRoot, launchTarget.DIR, `${SESSIONE}.json`);
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).incerto, true, 'lancio incerto');
  await assert.rejects(() => fleet.up('CellaIso'), (e) => e.fleetCode === 'STOP_UNKNOWN', 'up bloccato');
});

// 5. Timeout del CLI di stop (budget corto): il comando muore, TIMEOUT, l'host
//    resta vivo, nessun teardown.
test('F1: timeout dello stop host → HOST_STOP_FAILED, host vivo, nessun kill', async (t) => {
  const w = mondo(t, { groupStopBudgetMs: 3000 });
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);
  fs.writeFileSync(w.modef, 'hang\n');
  await fleet.up('CellaIso');
  await assert.rejects(() => fleet.down('CellaIso'), (e) => e.fleetCode === 'HOST_STOP_FAILED');
  assert.equal(conta(w.vllog, 'host-stop'), 1);
  assert.equal(vivo(host.pid), true, 'il timeout uccide solo il CLI di controllo');
  assert.equal(sessioniVive(w).length, 1, 'nessun teardown');
});

// 6. Perdita del canale di controllo: il down rifiuta PRIMA di qualunque
//    azione sull'host — nessun probe, nessuno stop, host vivo.
test('F1: canale di controllo perso → IDENTITY_UNVERIFIED, host mai consultato', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const host = avviaHostHelper();
  t.after(() => { try { host.kill('SIGKILL'); } catch (_) {} });
  await attendiVivo(host);
  fs.writeFileSync(w.hostpid, `${host.pid}\n`);
  await fleet.up('CellaIso');
  fs.writeFileSync(w.muori, '1\n');
  await dormi(150); // il server di controllo sparisce: EOF sul canale
  await assert.rejects(() => fleet.down('CellaIso'),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED');
  assert.equal(fs.readFileSync(w.vllog, 'utf8').trim(), '', 'nessun comando vl dopo la perdita del canale');
  assert.equal(vivo(host.pid), true);
  assert.equal(sessioniVive(w).length, 1);
});
