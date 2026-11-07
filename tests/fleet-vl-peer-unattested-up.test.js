'use strict';
// Punto 3 del pezzo 2: il rifiuto VL_PEER_UNATTESTED provato sul runtime
// REALE, end-to-end. Un finto QUALIFICATO peer/stop il cui `host status` dà
// host VIVO ma `peer_identity` `unverified` (e la variante con `null`) deve
// produrre: up FALLITO con fleetCode VL_PEER_UNATTESTED visibile nell'esito
// API; sessione fermata (nessun «isolato» dedotto da declared_pid, la tuple
// non nasce e il contesto resta pending); claim e lease nello stato atteso
// dal wiring runtime.js:1590-1609 — la claim della root RESTA DOV'È e il
// ticket del broker è revocato. Il rilancio dopo il rifiuto è MISURATO: il
// cleanup del lancio chiude il canale di controllo ma trattiene record e
// lease, quindi un secondo up è rifiutato («lancio non chiuso») e un
// restart è rifiutato (IDENTITY_UNVERIFIED, nessuna azione) ANCHE con l'host
// attestabile: lo sblocco resta la procedura esplicita fuori banda. File
// AUTOSUFFICIENTE (niente helpers/): il rosso sulla base misura il
// comportamento, non un import mancante. L'host finto muore con la sua
// sessione (kill per PID esatto nella kill-session del tmux finto).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const host = require('../lib/fleet/vl-host-stop.js');

const SESSIONE = 'cloud-CellaProva';
const PROMPT = 'Leggi CLAUDE.md e parti';

// hex32: la forma che validaHostIdentity richiede come instanceId owner.
const OWNER_INSTANCE_ID = 'ab'.repeat(16);

// Host finto standalone (come tests/helpers/vl-attestato.js): --respawn
// spegne per pid esatto il vecchio e fa nascere il nuovo detached; senza
// argv di servizio è l'host e vive finché non gli arriva un segnale.
function preparaHostFinto(dir) {
  const script = `${dir}/host-finto.cjs`;
  fs.writeFileSync(script, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const esiste = (p) => { try { process.kill(p, 0); return true; } catch (_) { return false; } };
if (process.argv[2] === '--respawn') {
  const pidfile = process.argv[3];
  let vecchio = 0;
  try { vecchio = Number(fs.readFileSync(pidfile, 'utf8').trim()) || 0; } catch (_) {}
  if (vecchio > 0 && esiste(vecchio)) {
    try { process.kill(vecchio, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 80 && esiste(vecchio); i += 1) attesa(25);
  }
  const figlio = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 30);'],
    { detached: true, stdio: 'ignore' });
  figlio.unref();
  fs.writeFileSync(pidfile, figlio.pid + '\\n');
  process.exit(0);
}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  fs.chmodSync(script, 0o755);
  return script;
}

// Binario vl finto QUALIFICATO con `peer_identity` MODALE: il blocco del
// peer in uno status LIVE dipende dal file MODE ('unverified' | 'null', ogni
// altro contenuto → verified). Le tre capacità e il support restano dichia-
// rati in OGNI stato (il preflight pezzo 1 passa: il rifiuto arriva proprio
// dalla registrazione, non dal probe di capacità). La tuple del blocco viene
// letta da /proc del pid vivo nel pidfile, come nel finto condiviso.
function scriptVlFintoModale({ hostpid, vllog, modeFile }) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const HOSTPID = ${JSON.stringify(hostpid)};
const MODE = ${JSON.stringify(modeFile)};
const LOG = ${JSON.stringify(vllog || '/dev/null')};
const argv = process.argv.slice(2);
const nota = (c) => { try { fs.appendFileSync(LOG, c + '\\n'); } catch (_) {} };
const leggiPid = () => { try { return Number(fs.readFileSync(HOSTPID, 'utf8').trim()) || 0; } catch (_) { return 0; } };
const scriviPid = (p) => { try { fs.writeFileSync(HOSTPID, p + '\\n'); } catch (_) {} };
const esiste = (p) => { try { process.kill(p, 0); return true; } catch (_) { return false; } };
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const identitaKernel = (p) => {
  let stat;
  try { stat = fs.readFileSync('/proc/' + p + '/stat', 'utf8'); } catch (_) { return null; }
  const fine = stat.lastIndexOf(')');
  if (fine < 0) return null;
  const campi = stat.slice(fine + 2).trim().split(/\\s+/);
  const pgid = Number(campi[2]);
  const sid = Number(campi[3]);
  const starttime = Number(campi[19]);
  let uid = null;
  try {
    const riga = fs.readFileSync('/proc/' + p + '/status', 'utf8')
      .split('\\n').find((r) => r.startsWith('Uid:'));
    uid = Number(riga.trim().split(/\\s+/)[2]);
  } catch (_) { return null; }
  let ino = null;
  try { ino = fs.statSync('/proc/' + p + '/ns/pid').ino; } catch (_) { return null; }
  let boot = null;
  try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) { return null; }
  if (![pgid, sid, starttime, uid, ino].every(Number.isSafeInteger)) return null;
  return { pid: p, uid, starttime, boot_id: boot, pidns: ino, pgid, sid };
};
const modo = () => { try { return fs.readFileSync(MODE, 'utf8').trim() || 'verified'; } catch (_) { return 'verified'; } };
const comune = {
  schema_version: 1, explicit_root: true, profile: 'e2emock', profile_source: 'config',
  residual_lock: null, error: null,
  capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
  peer_identity_support: 'supported',
};
if (argv[0] === '--version') { process.stdout.write('vl 0.4.0\\n'); process.exit(0); }
if (argv[0] === 'host' && argv[1] === 'status') {
  nota('status ' + argv.join(' '));
  const iRoot = argv.lastIndexOf('--server-root');
  const radice = iRoot >= 0 ? String(argv[iRoot + 1] || '') : '';
  const base = { ...comune, server_root: radice };
  const p = leggiPid();
  if (p > 0 && esiste(p)) {
    const id = identitaKernel(p);
    const m = modo();
    const peer = m === 'null' ? null : (id ? { schema_version: 1, state: m, ...id } : null);
    process.stdout.write(JSON.stringify({ ...base, state: 'live', declared_pid: p,
      pid_number_in_use: true, since: { source: 'declared', unix: 1 }, peer_identity: peer }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ ...base, state: 'none', declared_pid: null,
      pid_number_in_use: null, since: null }) + '\\n');
  }
  process.exit(0);
}
if ((argv[0] === 'internal' && argv[1] === 'host-stop') || argv[0] === 'shutdown') {
  const p = leggiPid();
  if (p > 0) {
    try { process.kill(p, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 80 && esiste(p); i += 1) attesa(25);
    scriviPid(0);
  }
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.exit(0);
}
{
  const vecchio = leggiPid();
  if (vecchio > 0 && esiste(vecchio)) {
    try { process.kill(vecchio, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 40 && esiste(vecchio); i += 1) attesa(25);
  }
  const figlio = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 30);'],
    { detached: true, stdio: 'ignore' });
  figlio.unref();
  scriviPid(figlio.pid);
  process.exit(0);
}
`;
}

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-unattested-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaProva');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  const hostScript = preparaHostFinto(root);
  const hostpid = path.join(root, 'hostpid');
  const vllog = path.join(root, 'vl.log');
  const modeFile = path.join(root, 'peer-mode');
  fs.writeFileSync(hostpid, '0\n');
  fs.writeFileSync(modeFile, 'verified\n');
  fs.writeFileSync(vlBin, scriptVlFintoModale({ hostpid, vllog, modeFile }), { mode: 0o755 });
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
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  // Fake tmux a stato vero (come fleet-vl-bootstrap-claim-runtime) con il
  // ciclo di vita dell'host: new-session fa nascere un host nuovo, e la
  // kill-session DELLA PROPRIA SESSIONE ferma l'host per PID ESATTO dal
  // pidfile — l'host di questo lancio muore con la sua sessione.
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const HOSTSCRIPT = ${JSON.stringify(hostScript)};
const HOSTPID = ${JSON.stringify(hostpid)};
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const esiste = (p) => { try { process.kill(p, 0); return true; } catch (_) { return false; } };
const fermaHost = () => {
  let p = 0;
  try { p = Number(fs.readFileSync(HOSTPID, 'utf8').trim()) || 0; } catch (_) {}
  if (p > 0 && esiste(p)) {
    try { process.kill(p, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 80 && esiste(p); i += 1) attesa(25);
  }
  try { fs.writeFileSync(HOSTPID, '0\\n'); } catch (_) {}
};
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
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  { const { spawnSync: riavviaHost } = require('node:child_process');
    riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
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
    fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(SESSIONE)}).map((n) => n + '\\n').join(''));
    fermaHost();
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
    cells: [{ id: 'CellaProva', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: PROMPT }],
  });

  const tickets = [];
  const revokes = [];
  const launchBroker = {
    issue: async (payload) => {
      tickets.push(payload);
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async () => { revokes.push(Date.now()); },
    close: async () => {},
  };
  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    now: () => 0, monotonicNow: () => 0,
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
  };
  const base = () => vlCellBaseDir(home, OWNER_INSTANCE_ID, 'CellaProva');
  const modo = (m) => fs.writeFileSync(modeFile, m + '\n');
  const sessioniVive = () => fs.readFileSync(statoPath, 'utf8').split('\n').filter(Boolean);
  const pidHost = () => { try { return Number(fs.readFileSync(hostpid, 'utf8').trim()) || 0; } catch (_) { return 0; } };
  const recordLease = () => {
    const dir = path.join(home, '.nexuscrew', 'vl-root-claims');
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (d && d.kind === 'lease') return d;
      } catch (_) { /* non-json */ }
    }
    return null;
  };
  t.after(() => {
    // Zero orfani: l'host finto si spegne per pid esatto prima della pulizia.
    try {
      const p = pidHost();
      if (p > 0) process.kill(p, 'SIGKILL');
    } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, home, tickets, revokes, cfgBase, base, modo, sessioniVive, pidHost, recordLease,
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

test('runtime reale: host vivo con peer UNVERIFIED — up rifiutato VL_PEER_UNATTESTED, sessione fermata, claim trattenuta', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  const fleet = await w.fleet();
  const err = await fleet.up('CellaProva').then(() => null, (e) => e);
  assert.ok(err, 'up rifiutato');
  assert.equal(err.fleetCode, 'VL_PEER_UNATTESTED', 'esito visibile nell\'API');
  assert.equal(err.status, 500);
  assert.equal(err.fleetPhase, 'readiness');
  assert.match(err.message, /non attestabile/);
  assert.ok(!err.message.toLowerCase().includes('isolat'), 'nessun «isolato» dedotto dal pid diagnostico');
  assert.equal(err.data && err.data.motivo, 'identita');
  // La sessione appena creata è FERMATA: niente resta vivo di questo lancio.
  assert.deepEqual(w.sessioniVive(), [], 'sessione fermata dal cleanup del lancio');
  assert.equal(w.pidHost(), 0, 'l\'host del lancio muore con la sessione');
  // Nessuna tuple registrata: il contesto resta PENDING (declared_pid non vale identita').
  const ctx = host.leggiContesto(w.base());
  assert.ok(ctx && !ctx.errore, 'contesto del launchId presente');
  assert.equal(ctx.hostIdentity.state, 'pending', 'la tuple non nasce da un rifiuto');
  // Claim e lease nello stato atteso dal wiring: la claim della root RESTA
  // DOV'È (record lease a disco) e il secondo up NUDO è rifiutato — il
  // record del lancio persiste senza continuità di controllo: l'host non
  // attestabile non si aggira con un secondo tentativo.
  const lease = w.recordLease();
  assert.ok(lease, 'record lease della root a disco');
  assert.equal(lease.kind, 'lease');
  assert.equal(lease.cellId, 'CellaProva');
  const err2 = await fleet.up('CellaProva').then(() => null, (e) => e);
  assert.ok(err2, 'secondo up nudo rifiutato');
  assert.equal(err2.fleetCode, 'SESSION_DUPLICATE', 'lancio non chiuso: la barriera regge');
  // Il ticket del broker del lancio fallito è revocato.
  assert.equal(w.revokes.length, 1, 'revoca del ticket di controllo');
});

test('runtime reale: variante peer NULL — stesso rifiuto, sessione fermata', async (t) => {
  const w = mondo(t);
  w.modo('null');
  const fleet = await w.fleet();
  const err = await fleet.up('CellaProva').then(() => null, (e) => e);
  assert.ok(err, 'up rifiutato');
  assert.equal(err.fleetCode, 'VL_PEER_UNATTESTED');
  assert.equal(err.data && err.data.motivo, 'identita');
  assert.deepEqual(w.sessioniVive(), [], 'sessione fermata');
  const ctx = host.leggiContesto(w.base());
  assert.ok(ctx && !ctx.errore);
  assert.equal(ctx.hostIdentity.state, 'pending', 'peer_identity null: nessuna tuple');
  assert.ok(w.recordLease(), 'la claim resta trattenuta');
});

test('runtime reale: blocco senza continuità e senza nuova sessione — la barriera del pending resta', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  const fleet = await w.fleet();
  const err = await fleet.up('CellaProva').then(() => null, (e) => e);
  assert.equal(err && err.fleetCode, 'VL_PEER_UNATTESTED');
  // Il file della modalità diventa «verified», ma qui NON nasce nessun host
  // attestato: il pid resta 0 e il cleanup del lancio rifiutato ha chiuso il
  // canale di controllo mantenendo record e lease. Questo prova il BLOCCO
  // senza continuità e senza nuova sessione (nessun client tmux nuovo,
  // nessuno stop); NON prova un host vivo attestato dopo il rifiuto — quello
  // richiede la procedura esplicita fuori banda dell'operatore.
  w.modo('verified');
  const errR = await fleet.restart('CellaProva').then(() => null, (e) => e);
  assert.ok(errR, 'restart rifiutato');
  assert.equal(errR.fleetCode, 'IDENTITY_UNVERIFIED', 'nessuna azione senza continuità dimostrata');
  assert.equal(errR.status, 409);
  assert.deepEqual(w.sessioniVive(), [], 'nessuna sessione creata dal restart rifiutato');
  assert.equal(w.pidHost(), 0, 'nessun host (ri)partito');
  assert.ok(w.recordLease(), 'la lease della root resta trattenuta');
  const ctx = host.leggiContesto(w.base());
  assert.ok(ctx && !ctx.errore);
  assert.equal(ctx.hostIdentity.state, 'pending', 'nessuna tuple senza un up riuscito');
});
