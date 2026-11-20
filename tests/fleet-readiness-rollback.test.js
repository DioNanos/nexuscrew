'use strict';
// Rollback di una readiness VL fallita: nessun processo orfano. I contratti
// riusati sono quelli VERI: lease manager vero (socket vero, protocollo di
// controllo vero, attendiUscita vera su /proc), coordinatore vero di
// group-stop.js che esegue lo stop del gruppo, runtime vero via
// createBuiltinFleet. Finti SOLO tmux (a stato vero, con verdetto di assenza
// nel formato reale) e il binario vl (modale: peer_identity
// verified/unverified/null, host vivo nel pidfile, stop protetto con rifiuti
// programmati). Nessun processo Fleet vivo; ogni processo del test nasce nel
// test e muore per PID esatto. L'host vl NON e' figlio della sessione: la
// kill-session della sessione NON lo tocca (e' il modo in cui nasce l'orfano).
//
// Fallimenti di persistenza e di commit si iniettano sostituendo le funzioni
// di `fs` NEL PROCESSO (il modulo usa lo stesso oggetto): la stessa tecnica
// dei test di quarantena del repository, non un seam di prodotto.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicWrite, leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const gruppo = require('../lib/fleet/group-stop.js');
const vlHostStop = require('../lib/fleet/vl-host-stop.js');

const SESSIONE = '$5';
const NOME = 'cloud-CellaRollback';
const CELLA = 'CellaRollback';
const PROMPT = 'Leggi CLAUDE.md e parti';
const OWNER_INSTANCE_ID = 'ab'.repeat(16);
const MIN_RESIDUO_CHIUSURA_MS = 2000;

function hexId() { return crypto.randomBytes(8).toString('hex'); }

function attendi(check, ms = 5000, passo = 20) {
  const fine = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = check(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() > fine) { reject(new Error('attesa scaduta')); return; }
      setTimeout(tick, passo);
    };
    tick();
  });
}

const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// --- binario vl finto, MODALE -----------------------------------------------
//
// peer_identity dipende dal file MODE: 'unverified' | 'null' | 'verified'.
// L'host vive nel PIDFILE (spawn detached, proprio gruppo). Ogni invocazione
// è notata nel LOG. I marker programmano i rifiuti:
//   HANG      — internal host-stop non risponde mai (il timeout del chiamante
//               lo uccide: nessun ripiego);
//   MISMATCH  — internal host-stop risponde {"ok":false,"reason":"peer_mismatch"}.
function scriptVlFinto({ hostpid, vllog, modeFile, root }) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const HOSTPID = ${JSON.stringify(hostpid)};
const MODE = ${JSON.stringify(modeFile)};
const LOG = ${JSON.stringify(vllog)};
const ROOT = ${JSON.stringify(root)};
const argv = process.argv.slice(2);
const nota = (c) => { try { fs.appendFileSync(LOG, c + '\\n'); } catch (_) {} };
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const leggiPid = () => { try { return Number(fs.readFileSync(HOSTPID, 'utf8').trim()) || 0; } catch (_) { return 0; } };
const esiste = (p) => { try { process.kill(p, 0); return true; } catch (_) { return false; } };
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
const hang = path.join(ROOT, 'vl-hang');
const mismatch = path.join(ROOT, 'vl-mismatch');
if (argv[0] === '--version') { process.stdout.write('vl 0.4.0\\n'); process.exit(0); }
if (argv[0] === 'status') {
  process.stdout.write(JSON.stringify({ version: 'vl 0.4.0', capabilities: { model_selector: 'profile' } }) + '\\n');
  process.exit(0);
}
if (argv[0] === 'models' && argv[1] === '--json') {
  process.stdout.write(JSON.stringify({
    schema_version: 1, inventory: 'config',
    active: { profile: 'work', source: 'config_default' }, active_error: null,
    preset_names_resolvable: true, excluded: { not_assembled: 0, invalid_identifier: 0 },
    profiles: [
      { id: 'work', provider: 'openai-compat', model: 'm-work', context_window: 1000,
        max_output_tokens: 100, supported_efforts: [], source: 'config', key: 'not_needed', auth_surface: null },
    ],
  }) + '\\n');
  process.exit(0);
}
if (argv[0] === 'host' && argv[1] === 'status') {
  nota('status ' + argv.join(' '));
  const iRoot = argv.lastIndexOf('--server-root');
  const radice = iRoot >= 0 ? String(argv[iRoot + 1] || '') : '';
  const base = { ...comune, server_root: radice };
  const p = leggiPid();
  if (p > 0 && esiste(p)) {
    const id = identitaKernel(p);
    const m = modo();
    let peer = null;
    if (m !== 'null' && id) peer = { schema_version: 1, state: m, ...id };
    process.stdout.write(JSON.stringify({ ...base, state: 'live', declared_pid: p,
      pid_number_in_use: true, since: { source: 'declared', unix: 1 }, peer_identity: peer }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ ...base, state: 'none', declared_pid: null,
      pid_number_in_use: null, since: null }) + '\\n');
  }
  process.exit(0);
}
if ((argv[0] === 'internal' && argv[1] === 'host-stop') || argv[0] === 'shutdown') {
  nota('stop ' + argv.join(' '));
  if (fs.existsSync(hang)) { setInterval(() => {}, 1 << 30); return; }
  if (fs.existsSync(mismatch)) {
    process.stdout.write('{"ok":false,"reason":"peer_mismatch"}\\n');
    process.exit(0);
  }
  const p = leggiPid();
  if (p > 0) {
    try { process.kill(p, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 80 && esiste(p); i += 1) attesa(25);
    try { fs.writeFileSync(HOSTPID, '0\\n'); } catch (_) {}
  }
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.exit(0);
}
process.exit(0);
`;
}

// Il «supervisore» è un processo vero, staccato e con gruppo proprio: la
// prova di uscita di attendiUscita legge /proc di QUESTO pid.
//
// Opzioni di mondo():
//   readinessRollbackMs — cfg del rollback (default non impostato);
//   orologioVirtuale    — il clock monotono del runtime parte a 0 e il test
//                         lo avanza (per i gate di budget);
//   seamPrimaTempo3     — hook chiamato dal rollback fra tempo 2 e tempo 3.
function mondo(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s2-'));
  const home = path.join(root, 'home');
  // Explicit home mode: keep the fixture umask-independent (the product
  // rejects group-writable ancestors of the vl root / broker runtime dir).
  fs.mkdirSync(home, { recursive: true, mode: 0o755 });
  fs.chmodSync(home, 0o755);
  const cwd = path.join(home, 'CellaRollback');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  const hostpid = path.join(root, 'hostpid');
  const vllog = path.join(root, 'vl.log');
  const modeFile = path.join(root, 'peer-mode');
  fs.writeFileSync(hostpid, '0\n');
  fs.writeFileSync(modeFile, 'verified\n');
  fs.writeFileSync(vllog, '');
  fs.writeFileSync(vlBin, scriptVlFinto({ hostpid, vllog, modeFile, root }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  // Il supervisore: processo vero staccato. La sessione tmux finta lo NOMINA
  // (pane_pid) e la sua morte è un fatto di /proc, come in produzione.
  const paneChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
    { detached: true, stdio: 'ignore' });
  paneChild.unref();

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const ctlLog = path.join(root, 'ctl.log');
  fs.writeFileSync(ctlLog, '');
  // tmux finto a stato vero: -C delega ogni riga a un'invocazione nuova; il
  // client di controllo resta vivo finché gli comandano (il canale production
  // è connesso al SERVER e sopravvive alla morte della sessione). Con il
  // marker MUORI_HAS il client esce sul primo has-session DOPO una
  // kill-session (canale morto dopo il kill posseduto: attestazione negativa).
  // La kill-session NON tocca l'host vl: l'host non è figlio della sessione.
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const HOSTPID = ${JSON.stringify(hostpid)};
const STATO = ${JSON.stringify(statoPath)};
const CTLLOG = ${JSON.stringify(ctlLog)};
const MUORI_HAS = ${JSON.stringify(path.join(root, 'muori-has'))};
const BLOCCA_HAS = ${JSON.stringify(path.join(root, 'blocca-has'))};
const ERRORE_HAS = ${JSON.stringify(path.join(root, 'errore-has'))};
const PANE_PID = ${paneChild.pid};
const SERVER_PID = ${process.pid};
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const rCrea = spawnSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpo = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : '');
    if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpo(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpo(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  let n = 0; let buf = ''; let vistoKill = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      try { fs.appendFileSync(CTLLOG, riga + '\\n'); } catch (_) {}
      if (riga.startsWith('kill-session')) vistoKill = true;
      if (riga.startsWith('has-session') && vistoKill && fs.existsSync(MUORI_HAS)) process.exit(0);
      // has-session DOPO il kill posseduto, sessione già morta, marker presente:
      // la riga non riceve MAI risposta (il client resta vivo e zitto). La scade
      // il timer del chiamante: il canale diventa rotto da solo, senza EOF —
      // il caso reale del timeout che rompe il canale.
      if (riga.startsWith('has-session') && vistoKill && fs.existsSync(BLOCCA_HAS)
        && fs.readFileSync(STATO, 'utf8').indexOf(${JSON.stringify(NOME)}) < 0) continue;
      n += 1;
      const r = spawnSync(process.execPath, [__filename, '-S', 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
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
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
const cmd = args[0] || '';
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(NOME)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(NOME)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(NOME)}]).join('\\n') + '\\n');
  { // l'host nasce con la sessione, detached e con gruppo proprio
    const figlio = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 30);'],
      { detached: true, stdio: 'ignore' });
    figlio.unref();
    fs.writeFileSync(HOSTPID, figlio.pid + '\\n');
  }
  process.stdout.write(${JSON.stringify(SESSIONE)} + '\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('@nc_delivery')) { process.stdout.write('submitted\\n'); process.exit(0); }
  if ((typeof fmt === 'string' ? fmt : process.argv.join(' ')).includes('pane_pid')) { process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n'); process.exit(0); }
  if (fmt.includes('pane_dead')) { process.stdout.write('0\\t0\\t%9\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(NOME)} || bersaglio === ${JSON.stringify(SESSIONE)};
  if (mia) {
    fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(NOME)}).map((n) => n + '\\n').join(''));
    // l'host vl NON è figlio della sessione: resta vivo (orfano dichiarato)
  }
  process.exit(0);
}
if (cmd === 'has-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(NOME)} || bersaglio === ${JSON.stringify(SESSIONE)};
  // Verdetto IGNOTO con client VIVO (one-shot): errore generico che NON è il
  // verdetto specifico di assenza — il canale resta aperto e serve le righe
  // successive (l'ignoto con canale vivo è un caso distinto).
  if (mia && vive().includes(${JSON.stringify(NOME)}) && fs.existsSync(ERRORE_HAS)) {
    try { fs.unlinkSync(ERRORE_HAS); } catch (_) {}
    try { fs.appendFileSync(CTLLOG, 'marker errore-has (sessione viva)\\n'); } catch (_) {}
    process.stderr.write('internal error: has-session non disponibile\\n');
    process.exit(1);
  }
  if (mia && vive().includes(${JSON.stringify(NOME)})) process.exit(0);
  process.stderr.write('can\\'t find session: ' + bersaglio + '\\n');
  process.exit(1);
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
    cells: [{ id: CELLA, tmuxSession: NOME, cwd, engine: 'vl.native', boot: false, prompt: PROMPT }],
  });

  // Fault di fs IN PROCESSO, per iniettare i fallimenti di persistenza e di
  // commit in punti esatti del flusso REALE (tecnica dichiarata dai test di
  // quarantena del repository: il modulo usa lo stesso oggetto fs).
  const fault = {
    renameLiveContesto: false,    // la scrittura del contesto COMPLETO (live) fallisce al rename
    readContestoStraniero: false, // la prima lettura bytes del contesto restituisce byte stranieri
    unlinkRecord: false,          // l'unlink del record al commit fallisce (una volta)
    unlinkJournal: false,         // l'unlink del journal al commit fallisce (una volta)
    risvegliaHost: false,         // alla fault del rename l'host A muore e ne nasce B (sostituzione)
  };
  const contestoFile = () => path.join(vlCellBaseDir(home, OWNER_INSTANCE_ID, CELLA), 'host-context.json');
  const recordFile = () => path.join(filesRoot, 'launch-targets', `${NOME}.json`);
  const journalFile = () => path.join(filesRoot, 'launch-targets', `.commit-${NOME}.json`);
  const realRename = fs.renameSync;
  const realRead = fs.readFileSync;
  const realUnlink = fs.unlinkSync;
  let consumatoRename = false;
  let consumatoRead = false;
  let consumatoUnlinkRecord = false;
  let consumatoUnlinkJournal = false;
  fs.renameSync = function renameFault(p, d) {
    if (fault.renameLiveContesto && !consumatoRename && d === contestoFile()) {
      let corpo = '';
      try { corpo = realRead(p, 'utf8'); } catch (_) { corpo = ''; }
      if (corpo.includes('"state":"live"')) {
        consumatoRename = true;
        if (fault.risvegliaHost) {
          // sostituzione dell'host fra probe e rollback: A muore per PID
          // esatto, B nasce detached sulla stessa root.
          let vecchio = 0;
          try { vecchio = Number(realRead(hostpid, 'utf8').trim()) || 0; } catch (_) { vecchio = 0; }
          if (vecchio > 0) { try { process.kill(vecchio, 'SIGTERM'); } catch (_) {} }
          const b = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 30);'],
            { detached: true, stdio: 'ignore' });
          b.unref();
          fs.writeFileSync(hostpid, b.pid + '\n');
        }
        throw Object.assign(new Error('fault persistenza (test)'), { code: 'EIO' });
      }
    }
    return realRename(p, d);
  };
  fs.readFileSync = function readFault(p, ...rest) {
    if (fault.readContestoStraniero && !consumatoRead && p === contestoFile()) {
      consumatoRead = true;
      return Buffer.from(JSON.stringify({ launchId: 'ff'.repeat(8), version: 2, hostIdentity: { state: 'live' } }), 'utf8');
    }
    return realRead(p, ...rest);
  };
  fs.unlinkSync = function unlinkFault(p) {
    if (fault.unlinkRecord && !consumatoUnlinkRecord && p === recordFile()) {
      consumatoUnlinkRecord = true;
      throw Object.assign(new Error('fault unlink record (test)'), { code: 'EIO' });
    }
    if (fault.unlinkJournal && !consumatoUnlinkJournal && p === journalFile()) {
      consumatoUnlinkJournal = true;
      throw Object.assign(new Error('fault unlink journal (test)'), { code: 'EIO' });
    }
    return realUnlink(p);
  };
  t.after(() => { fs.renameSync = realRename; fs.readFileSync = realRead; fs.unlinkSync = realUnlink; });

  // Orologio monotono iniettabile: di default REALE (hrtime); con
  // orologioVirtuale parte a 0 e il test lo avanza a piacere.
  const clock = { t: opts.orologioVirtuale ? 0 : null };
  const monoNow = () => (clock.t == null ? Number(process.hrtime.bigint() / 1000000n) : clock.t);

  const tickets = [];
  const revokes = [];
  let mgrRef = null;
  let supervisorFactory = null; // impostato dal test PRIMA dell'up
  let attached = null;

  const launchBroker = {
    issue: async (payload) => {
      tickets.push(payload);
      if (supervisorFactory && mgrRef && payload && payload.control) {
        attached = await supervisorFactory(payload.control);
      }
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async () => { revokes.push(Date.now()); },
    close: async () => {},
  };

  const cfgBase = {
    home, filesRoot, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    monotonicNow: monoNow,
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    cellLeaseEnabled: true,
    ...(opts.readinessRollbackMs != null ? { readinessRollbackMs: opts.readinessRollbackMs } : {}),
    ...(opts.seamPrimaTempo3 ? { readinessRollbackSeams: { primaDelTempo3: opts.seamPrimaTempo3 } } : {}),
  };

  const base = () => vlCellBaseDir(home, OWNER_INSTANCE_ID, CELLA);
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
  const comandiVl = () => fs.readFileSync(vllog, 'utf8').split('\n').filter(Boolean);
  const comandiCtl = () => fs.readFileSync(ctlLog, 'utf8').split('\n').filter(Boolean);
  const quarantena = () => {
    const dir = path.join(filesRoot, 'launch-targets', 'reconciled');
    try { return fs.readdirSync(dir); } catch (_) { return []; }
  };
  const leggiRecord = () => launchTarget.leggi(filesRoot, NOME);

  t.after(() => {
    // Zero orfani: ogni processo del test muore per PID esatto, prima della pulizia.
    const p = pidHost();
    if (p > 0) { try { process.kill(p, 'SIGKILL'); } catch (_) {} }
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    if (attached && typeof attached.spegni === 'function') { try { attached.spegni(); } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root, home, filesRoot, tickets, revokes, fault, clock, paneChild, base, modo,
    sessioniVive, pidHost, recordLease, comandiVl, comandiCtl, quarantena, leggiRecord,
    recordFile, journalFile, contestoFile, modeFile,
    setSupervisore: (f) => { supervisorFactory = f; },
    async fleet() {
      // Argomento letterale con filesRoot dentro la root temporanea del
      // mondo: la guardia dei test verifica che nessun record finisca nello
      // store vero.
      const f = await createBuiltinFleet({ ...cfgBase, filesRoot });
      mgrRef = f.lease;
      t.after(() => f.close().catch(() => {}));
      return f;
    },
    mgr: () => mgrRef,
  };
}

// Supervisore con lease REALE e coordinatore REALE (group-stop.js): riceve i
// frame di controllo, risponde col protocollo vero e lo stop del gruppo
// uccide il processo supervisore per PID esatto. Opzioni:
//   esce            — killGruppo uccide il paneChild (default true);
//   uccidiSessione  — la sessione muore col gruppo (default true); false =
//                     remain-on-exit: resta fino al kill posseduto;
//   ritardoMs       — l'uscita del supervisore arriva in ritardo;
//   onStopFrame     — hook invocato PRIMA di consegnare il frame stop al
//                     coordinatore (per avanzare clock / riar mare il control);
//   appendeCanale   — "hung" mode: the end of the stop phase does NOT close
//                     the lease channel (no flush, no early EOF), so the
//                     group stop can only conclude at its phase deadline.
//                     Explicit opt-in for the cases that need it; the forced
//                     channel close stays in the teardown (spegni).
// Restituisce { coord, spegni, conta, frameVisti }.
function attaccaSupervisore(t, w, { esce = true, uccidiSessione = true, ritardoMs = 0, onStopFrame = null, appendeCanale = false } = {}) {
  const { control } = w.tickets[w.tickets.length - 1] || {};
  if (!control || !control.launchId || !control.token) {
    throw new Error('payload del lancio senza canale di controllo');
  }
  const mgr = w.mgr();
  const pairPath = path.join(w.root, `pair-${hexId()}.sock`);
  let serverSide = null;
  const srv = net.createServer((sock) => { serverSide = sock; });
  const frameVisti = [];
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(pairPath, () => {
      const clientSide = net.connect(pairPath, () => {
        (async () => {
          await attendi(() => serverSide);
          assert.equal(mgr.attachInitial(CELLA, serverSide, { generation: 0 }), true);
          let morto = false;
          let timerRitardo = null;
          const coord = gruppo.creaCoordinatore({
            token: control.token, launchId: control.launchId,
            monoNow: () => Number(process.hrtime.bigint() / 1000000n),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            killGruppo: (sig) => {
              // esce:false — il supervisore «appeso»: ignora il segnale
              // del gruppo e resta vivo.
              if (!esce || sig !== 'SIGTERM' || morto) return;
              morto = true;
              const chiudi = () => {
                try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
                if (uccidiSessione) {
                  try { fs.writeFileSync(path.join(w.root, 'sessions.txt'), ''); } catch (_) {}
                }
              };
              if (ritardoMs > 0) { timerRitardo = setTimeout(chiudi, ritardoMs); return; }
              chiudi();
            },
            osserva: () => {
              if (!morto) return { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' };
              if (ritardoMs > 0) {
                try { process.kill(w.paneChild.pid, 0); return { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }; }
                catch (_) { return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }; }
              }
              return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };
            },
            invia: (frame) => leaseCtl.sendControl(frame),
            // Come in produzione, la fine della fase di stop CHIUDE la
            // connessione lease del supervisore: senza quell'EOF il chiamante
            // non distingue «stop concluso» da «supervisore appeso» e attende
            // l'intera deadline di fase.
            svuota: async () => {
              if (appendeCanale) {
                // Explicitly hung supervisor, this case only: it outlives its
                // own stop phase and offers no early completion — no flush,
                // no EOF. The teardown (spegni) closes everything forcibly.
                return true;
              }
              await leaseCtl.svuota();
              try { clientSide.end(); } catch (_) { /* already gone */ }
            },
            cancellaDelivery: async () => null,
            scriviLog: () => {},
            dichiaraStopping: () => {},
            disarmaLegacy: () => {},
            installaIgnoraTerm: () => {},
          });
          var leaseCtl = startLeaseClient(clientSide, {
            stablePath: path.join(w.root, 'no-lease.sock'),
            launchEpoch: hexId(),
            onControlFrame: (frame) => {
              if (frame && frame.op === 'stop') {
                frameVisti.push(frame);
                if (onStopFrame) { try { onStopFrame(frame); } catch (_) {} }
              }
              coord.onFrame(frame);
            },
          });
          const spegni = () => {
            if (timerRitardo) clearTimeout(timerRitardo);
            try { leaseCtl.stop(); } catch (_) {}
            try { clientSide.destroy(); } catch (_) {}
            try { serverSide.destroy(); } catch (_) {}
            srv.close();
          };
          t.after(() => { spegni(); });
          resolve({ coord, spegni, frameVisti });
        })().catch(reject);
      });
      clientSide.once('error', reject);
    });
  });
}

// Attacca il supervisore DENTRO l'issue del broker: così il canale di
// controllo è connesso PRIMA che la readiness fallisca, come in produzione.
function supervisoreInIssue(w, t, opzioni) {
  w.setSupervisore(async () => attaccaSupervisore(t, w, opzioni));
}

// --- caso end-to-end: supervisore che non esce (motivo identita) -------------

test('readiness di identita con supervisore che NON esce — rollback incompleto onesto, host mai toccato', async (t) => {
  const TOTALE = 1500;
  const SCADENZA_FASE = Math.floor(0.6 * TOTALE); // phase boundary for tempi 0/1/2
  const w = mondo(t, { readinessRollbackMs: TOTALE, orologioVirtuale: true });
  w.modo('unverified');
  // Explicitly HUNG supervisor, this case only: it never exits (esce:false)
  // and the end of its stop phase does NOT close the lease channel
  // (appendeCanale) — no early EOF, so the group stop cannot return before
  // the phase deadline with an unproven exit. The teardown closes the
  // channel forcibly (spegni).
  supervisoreInIssue(w, t, {
    esce: false, uccidiSessione: false, appendeCanale: true,
    // Phase boundary controlled through the injectable clock (monotonicNow
    // seam): at the stop frame the residual is declared exhausted. The total
    // budget is unchanged and the oracle never leans on the real 200ms grace
    // margin — by the time the rollback reads residuoFase() the boundary is
    // already past, by construction.
    onStopFrame: () => { w.clock.t = SCADENZA_FASE + 1; },
  });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.ok(err, 'up rifiutato');
  assert.equal(err.fleetCode, 'VL_PEER_UNATTESTED');
  const rb = err.data && err.data.rollback;
  assert.ok(rb, 'il body porta il rollback bounded');
  assert.equal(rb.incompleto, true);
  // il supervisore non esce: uscita NON provata, motivo bounded
  assert.equal(rb.supervisor, 'unproven');
  assert.ok(typeof rb.motivoUscita === 'string' && rb.motivoUscita.length > 0, 'motivoUscita bounded');
  // Unproven exit AND a phase truly exhausted — the boundary is attested by
  // the clock above before the rollback ever reads the residual: the owned
  // cleanup does NOT start past the deadline (no late effects) and the
  // outcome says so. The session stays alive: it is the declared residual,
  // not a hidden orphan.
  assert.equal(rb.session, 'not-killed');
  assert.notEqual(w.sessioniVive().length, 0, 'sessione fermata oltre il budget');
  // l'host NON è attestabile a questo lancio: NESSUN comando host-stop
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0, 'zero comandi host-stop');
  assert.ok(w.pidHost() > 0, 'l\'host resta vivo: nessun orfano nascosto, stato dichiarato');
  // pre-chiusura: claim conservata, record al suo posto
  assert.equal(rb.claim, 'held');
  assert.equal(rb.record, 'kept');
  assert.ok(w.recordLease(), 'claim della root trattenuta');
  assert.equal(w.leggiRecord().stato, 'presente');
  // redazione dei corpi: niente pid/uid/starttime/boot_id nel body
  const corpo = JSON.stringify(err.data);
  for (const parola of ['panePid', 'paneStarttime', 'bootId', 'startTicks', 'pidNamespaceInode', 'serverPid']) {
    assert.ok(!corpo.includes(parola), `il body non porta ${parola}`);
  }
  // il ticket del broker del lancio fallito è revocato
  assert.equal(w.revokes.length, 1);
});

// Distinct case (intended product behavior, kept covered on purpose):
// UNPROVEN return with a controlled POSITIVE phase residual — the stop phase
// completes early the production way (escalate + channel close, EOF) while
// the phase is NOT exhausted. The owned cleanup of the session alone is
// allowed within the residual and is declared killed-not-attested, NEVER
// promoted to absent-attested, with the host untouched.
test('unproven exit with POSITIVE phase residual: owned session cleanup runs → killed-not-attested, never promoted, host untouched', async (t) => {
  const TOTALE = 1500;
  const SCADENZA_FASE = Math.floor(0.6 * TOTALE); // phase boundary for tempi 0/1/2
  const RESIDUO_POSITIVO = 400; // controlled residual read at tempo 2
  const w = mondo(t, { readinessRollbackMs: TOTALE, orologioVirtuale: true });
  w.modo('unverified');
  // Supervisor that never exits (esce:false) but ENDS its stop phase the
  // normal way: escalate-commit then channel close (early EOF included, the
  // production-shaped completion the hung case above deliberately withholds).
  supervisoreInIssue(w, t, {
    esce: false, uccidiSessione: false,
    // Clock frozen INSIDE the phase: the group stop returns early through
    // the real completion (commit+EOF) and when the rollback reads the
    // residual at tempo 2 the value is positive and fixed by the clock, not
    // a race margin of real milliseconds.
    onStopFrame: () => { w.clock.t = SCADENZA_FASE - RESIDUO_POSITIVO; },
  });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.ok(err, 'up rejected');
  assert.equal(err.fleetCode, 'VL_PEER_UNATTESTED');
  const rb = err.data && err.data.rollback;
  assert.ok(rb, 'the body carries the bounded rollback');
  assert.equal(rb.incompleto, true);
  // unproven exit, bounded reason
  assert.equal(rb.supervisor, 'unproven');
  assert.ok(typeof rb.motivoUscita === 'string' && rb.motivoUscita.length > 0, 'motivoUscita bounded');
  // Positive residual: the owned cleanup of the session alone is allowed and
  // runs within the residual, but it does not count as a proof — the outcome
  // is killed-not-attested and unknown is never promoted.
  assert.equal(rb.session, 'killed-not-attested');
  assert.notEqual(rb.session, 'absent-attested', 'no promotion to attested absence');
  assert.deepEqual(w.sessioniVive(), [], 'the owned session was cleaned');
  // the host is not attestable at this launch: NO host-stop command
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0, 'zero host-stop commands');
  assert.ok(w.pidHost() > 0, 'the host stays alive');
  // pre-chiusura: claim conservata, record al suo posto
  assert.equal(rb.claim, 'held');
  assert.equal(rb.record, 'kept');
  assert.ok(w.recordLease(), 'claim della root trattenuta');
  assert.equal(w.leggiRecord().stato, 'presente');
  assert.equal(w.revokes.length, 1);
});

test('con supervisore che esce per il frame: uscita PROVATA e l\'esito resta incompleto (host non attestabile)', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: false });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.equal(err && err.fleetCode, 'VL_PEER_UNATTESTED');
  const rb = err.data.rollback;
  assert.equal(rb.supervisor, 'stopped', 'uscita provata dal frame coordinato');
  // remain-on-exit: la sessione sopravvive al supervisore e viene pulita per
  // ID sulla connessione posseduta, poi attestata
  assert.equal(rb.session, 'absent-attested');
  assert.deepEqual(w.sessioniVive(), []);
  // MA l'esito complessivo resta incompleto: l'host non è attestabile
  assert.equal(rb.incompleto, true);
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(rb.claim, 'held');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0);
  assert.ok(w.pidHost() > 0, 'host vivo, dichiarato');
});

// --- motivo end-to-end: il frame porta readiness-rollback --------------------

test('il frame stop del rollback porta payload.reason readiness-rollback (enum chiusa)', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 1500 });
  w.modo('unverified');
  const registro = { frames: [] };
  w.setSupervisore(async () => {
    const sup = await attaccaSupervisore(t, w, { esce: false, uccidiSessione: false });
    registro.frames = sup.frameVisti;
    return sup;
  });
  const fleet = await w.fleet();
  await fleet.up(CELLA).then(() => null, (e) => e);
  const stop = registro.frames.find((f) => f.op === 'stop');
  assert.ok(stop, 'frame stop inviato dal rollback');
  assert.equal(stop.payload && stop.payload.reason, 'readiness-rollback');
});

// --- PID riusato: contratto reale di attendiUscita ---------------------------

test('attendiUscita REALE: pid vivo con nascita diversa è uscita PROVATA del vecchio (riuso)', async (t) => {
  // Contratto alla cell-lease-server: il pid occupato da un processo vivo con
  // nascita diversa da quella attesa PROVA che il vecchio supervisore è
  // uscito. Il pid occupante è il processo del test stesso.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s2-lease-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mgr = createLeaseManager({ home });
  t.after(() => { try { mgr.close(); } catch (_) {} });
  await mgr.track(CELLA); // l'entry deve esistere, come nel lancio vero
  assert.ok(mgr.armControl(CELLA, { launchId: 'cd'.repeat(8), token: 't'.repeat(32) }));
  const nascitaAltro = leggiStarttimeProc(process.pid) + 1000;
  const esito = await mgr.attendiUscita(CELLA, {
    launchId: 'cd'.repeat(8), panePid: process.pid, starttime: nascitaAltro, timeoutMs: 300,
  });
  assert.equal(esito.provato, true, 'riuso = uscita provata del vecchio');
});

test('PID riusato intatto: uscita provata NON chiude host/claim/commit e il nuovo occupante non riceve nulla', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  // il supervisore esce (kill per PID esatto) e il suo numero viene occupato
  // da un processo vivo nuovo: attendiUscita reale dice provato (terminato o
  // riuso — entrambi provano il VECCHIO).
  const occupante = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 60000);'],
    { detached: true, stdio: 'ignore' });
  occupante.unref();
  t.after(() => { try { process.kill(occupante.pid, 'SIGKILL'); } catch (_) {} });
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: false });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.supervisor, 'stopped', 'uscita provata è un fatto vero');
  assert.equal(rb.incompleto, true, 'ma da sola non chiude niente');
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(rb.claim, 'held');
  assert.equal(rb.record, 'kept');
  assert.ok(w.recordLease(), 'claim conservata');
  // il nuovo occupante NON riceve alcun segnale: zero kill numerici nel modulo
  await attesa(150);
  assert.ok(process.kill(occupante.pid, 0) === true, 'l\'occupante del pid è vivo');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0);
});

// --- assenza FINALE dopo la pulizia posseduta (caso obbligatorio) ------------

test('uscita provata con sessione PRESENTE (remain-on-exit): kill posseduto e assenza FINALE attestata', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true; // persistenza: probe ok, scrittura fallita
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: false });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.equal(err && err.fleetCode, 'VL_PEER_UNATTESTED');
  assert.equal(err.data.motivo, 'persistenza');
  const rb = err.data.rollback;
  // caso B del tempo 2: attestazione diagnostica → presente → killSession per
  // ID sul canale posseduto → attestazione FINALE
  assert.equal(rb.supervisor, 'stopped');
  assert.equal(rb.session, 'absent-attested');
  assert.deepEqual(w.sessioniVive(), []);
  // il retry per bytes ha reso il contesto dichiarabile e la chiusura completa
  assert.equal(rb.incompleto, false, 'con host e commit riusciti può completare');
  assert.equal(rb.host, 'stopped-clean');
  assert.equal(rb.claim, 'released');
  assert.equal(rb.record, 'closed');
  assert.equal(w.leggiRecord().stato, 'assente');
  assert.ok(w.quarantena().length >= 1, 'record in quarantena reconciled');

  // Variante: la lettura DIAGNOSTICA risponde IGNOTO (errore
  // generico, non il verdetto di assenza) con il canale ANCORA VIVO. L'ignoto
  // non blocca la pulizia posseduta e non viene promosso ad assenza: il kill
  // per ID passa sullo STESSO canale e il verdetto FINALE reale chiude.
  const w2 = mondo(t, { readinessRollbackMs: 20000 });
  w2.modo('verified');
  w2.fault.renameLiveContesto = true;
  fs.writeFileSync(path.join(w2.root, 'errore-has'), '1');
  supervisoreInIssue(w2, t, { esce: true, uccidiSessione: false });
  const fleet2 = await w2.fleet();
  const err2 = await fleet2.up(CELLA).then(() => null, (e) => e);
  const rb2 = err2.data.rollback;
  const ctl = w2.comandiCtl();
  const iErr = ctl.indexOf('marker errore-has (sessione viva)');
  assert.ok(iErr > 0, 'il verdetto ignoto è arrivato su una has-session');
  assert.match(ctl[iErr - 1], /^has-session/, 'la lettura ignota è una has-session');
  // l'ignoto può colpire il seam del modulo (verificaSessioneAssente) o la
  // lettura diagnostica del rollback: in entrambi i casi il canale resta VIVO
  // e serve le righe successive — il kill posseduto passa sullo STESSO canale
  const dopo = ctl.slice(iErr + 1);
  const iKill = dopo.findIndex((l) => /^kill-session/.test(l));
  assert.ok(iKill >= 0, 'dopo l\'ignoto il kill posseduto passa sullo stesso canale vivo');
  assert.ok(dopo.slice(0, iKill).every((l) => /^has-session/.test(l)),
    'fra ignoto e kill il canale vivo ha continuato a rispondere');
  assert.equal(rb2.supervisor, 'stopped');
  assert.equal(rb2.session, 'absent-attested', 'ignoto mai promosso: chiude il verdetto FINALE');
  assert.deepEqual(w2.sessioniVive(), []);
});

test('assenza già attestata dal modulo (attestato:true): ZERO chiamate killSession', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true }); // la sessione muore col gruppo
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.session, 'absent-attested');
  assert.equal(w.comandiCtl().filter((l) => l.startsWith('kill-session')).length, 0,
    'nessun kill inutile: l\'assenza era già attestata');
  assert.equal(rb.incompleto, false);
});

test('attestazione finale con canale MORTO dopo il kill: killed-not-attested, unknown mai promosso', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: false });
  // il client -C muore sul primo has-session DOPO il kill posseduto: la
  // lettura finale non arriva e non si inventa (EOF non è un verdetto)
  fs.writeFileSync(path.join(w.root, 'muori-has'), '1');
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.session, 'killed-not-attested', 'EOF dopo il kill non è un verdetto');
  assert.equal(rb.incompleto, true);
  assert.equal(rb.host, 'identity-unknown');

  // Variante: TIMEOUT REALE che rompe il canale — il client -C
  // resta VIVO e non risponde mai alla has-session finale (nessun EOF): la
  // rompe il timer del chiamante (rotto). Mai riusare il canale dopo.
  const w2 = mondo(t, { readinessRollbackMs: 30000 });
  w2.modo('unverified');
  fs.writeFileSync(path.join(w2.root, 'blocca-has'), '1');
  supervisoreInIssue(w2, t, { esce: true, uccidiSessione: false });
  const fleet2 = await w2.fleet();
  const err2 = await fleet2.up(CELLA).then(() => null, (e) => e);
  const rb2 = err2.data.rollback;
  assert.equal(rb2.session, 'killed-not-attested', 'il timeout del canale non è un verdetto');
  assert.equal(rb2.incompleto, true);
  const ctl2 = w2.comandiCtl();
  assert.match(ctl2[ctl2.length - 1], /^has-session/,
    'la has-session finale è rimasta SENZA risposta: l\'ha scaduta il timer');
  assert.deepEqual(w2.sessioniVive(), [], 'la sessione era già stata uccisa sul canale posseduto');

  // Controprova D1 n.2 (mutante «promuovi l\'uscita a completo»): uscita
  // PROVATA ma assenza finale non attestabile con il contesto DICHIARABILE
  // (persistenza ritentata) — la sola uscita NON chiude host/claim/commit.
  const w3 = mondo(t, { readinessRollbackMs: 20000 });
  w3.modo('verified');
  w3.fault.renameLiveContesto = true;
  fs.writeFileSync(path.join(w3.root, 'muori-has'), '1');
  supervisoreInIssue(w3, t, { esce: true, uccidiSessione: false });
  const fleet3 = await w3.fleet();
  const err3 = await fleet3.up(CELLA).then(() => null, (e) => e);
  const rb3 = err3.data.rollback;
  assert.equal(rb3.session, 'killed-not-attested');
  assert.equal(rb3.incompleto, true, 'l\'assenza non attestata blocca la chiusura');
  assert.equal(w3.comandiVl().filter((l) => l.startsWith('stop ')).length, 0,
    'zero comandi host: l\'uscita provata da sola non autorizza lo stop');
  assert.equal(rb3.claim, 'held');
  assert.equal(rb3.record, 'kept');
  assert.ok(w3.pidHost() > 0, 'l\'host resta vivo, dichiarato');
});

// --- host preesistente o sostituito intatto ----------------------------------

test('identita: host vivo non registrato a questo lancio — zero comandi host-stop, tutto conservato', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.equal(err.data.motivo, 'identita');
  const rb = err.data.rollback;
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0, 'zero comandi host-stop');
  assert.equal(rb.record, 'kept');
  assert.equal(rb.claim, 'held');
  assert.equal(rb.incompleto, true);
  assert.ok(w.pidHost() > 0, 'host intatto');
  assert.ok(w.recordLease(), 'claim intatta');
});

test('persistenza con contesto SOSTITUITO da straniero fra probe e retry: fence per bytes, nessun comando', async (t) => {
  const w = mondo(t);
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  w.fault.readContestoStraniero = true;
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(err.data.motivo, 'persistenza');
  assert.equal(rb.host, 'identity-unknown', 'il contesto non è il nostro: intatto');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0, 'nessun comando host');
  assert.equal(rb.claim, 'held');
  assert.equal(rb.record, 'kept');
  assert.equal(rb.incompleto, true);
  // nessuna riscrittura: sul disco resta il PENDING del nostro lancio
  let corpo = '';
  try { corpo = fs.readFileSync(w.contestoFile(), 'utf8'); } catch (_) { corpo = ''; }
  assert.ok(corpo.includes('"state":"pending"'), 'il contesto pending non è stato toccato');
  // redazione dei corpi: la tuple grezza del peer non raggiunge mai il body
  const corpo7b = JSON.stringify(err.data);
  for (const parola of ['panePid', 'paneStarttime', 'bootId', 'startTicks', 'pidNamespaceInode', 'serverPid']) {
    assert.ok(!corpo7b.includes(parola), `il body non porta ${parola}`);
  }
});

test('persistenza con host SOSTITUITO fra probe e stop: nessun comando al sostituto', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  w.fault.risvegliaHost = true; // alla fault: A muore, B nasce (tuple diversa)
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  // il retry scrive il COMPLETO del NOSTRO probe (tuple di A), poi la
  // qualifica vede B: mismatch → IDENTITY_UNKNOWN, zero stop
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0, 'nessuno stop al sostituto');
  assert.ok(w.pidHost() > 0, 'il sostituto B è vivo');
  assert.equal(rb.claim, 'held');
  assert.equal(rb.incompleto, true);
});

// --- una chiamata sola, zero effetti tardivi, budget di fase ------------------

test('host-stop appeso: fallisce onesto, ZERO rilasci/commit/quarantene anche dopo l\'attesa tardiva', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 4000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true; // il retry rende il contesto dichiarabile
  fs.writeFileSync(path.join(w.root, 'vl-hang'), '1'); // l'host-stop non risponde
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.host, 'not-stopped');
  assert.equal(rb.claim, 'held');
  assert.equal(rb.record, 'kept');
  // UNA sola chiamata host-stop per tutto il rollback
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 1);
  // attesa del completamento tardivo: nessun effetto postumo
  await attesa(300);
  assert.ok(w.recordLease(), 'claim mai rilasciata');
  assert.equal(w.quarantena().length, 0, 'zero quarantene');
  assert.equal(w.leggiRecord().stato, 'presente', 'record mai committato');
  assert.equal(rb.incompleto, true);
});

test('residuo totale sotto MIN_RESIDUO_CHIUSURA_MS: NESSUN comando host, host deadline', async (t) => {
  const TOTALE = 30000;
  const w = mondo(t, {
    readinessRollbackMs: TOTALE,
    orologioVirtuale: true,
    seamPrimaTempo3: () => { w.clock.t = TOTALE - (MIN_RESIDUO_CHIUSURA_MS - 100); },
  });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.host, 'deadline', 'gate di non-partenza del tempo 3');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 0, 'nessun comando avviato');
  assert.equal(rb.claim, 'held');
  assert.equal(rb.record, 'kept');
  assert.equal(rb.incompleto, true);
});

test('commit non-ok DOPO host+claim riusciti: claim released e diagnosi REALE del record', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  w.fault.unlinkRecord = true; // l'unlink del record fallisce col journal a disco
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.host, 'stopped-clean');
  assert.equal(rb.claim, 'released', 'post-rilascio: il mondo non si annulla');
  assert.equal(rb.record, 'commit-incompleto', 'journal sul disco: mai un falso kept');
  assert.equal(rb.incompleto, true);
  // il record È ancora al suo posto (unlink fallito) e il journal pure
  assert.equal(w.leggiRecord().stato, 'presente');
  assert.ok(fs.existsSync(w.journalFile()), 'journal pendente');
  // la risposta resta 500 VL_PEER_UNATTESTED con rollback bounded
  assert.equal(err.fleetCode, 'VL_PEER_UNATTESTED');
  // ripresa SOLO con il completamento meccanico esistente: nessuna ricreazione
  const ripresa = launchTarget.completaCommit(w.filesRoot, NOME);
  assert.equal(ripresa.stato, 'completato');
  assert.equal(w.leggiRecord().stato, 'assente');
  assert.ok(w.quarantena().length >= 1);
});

test('commit con journalResiduo: ok vero ma record commit-incompleto, ripresa meccanica', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  w.fault.unlinkJournal = true;
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(rb.claim, 'released');
  assert.equal(rb.record, 'commit-incompleto', 'journal residuo dichiarato');
  assert.equal(w.leggiRecord().stato, 'assente', 'il record è stato rimosso');
  assert.ok(fs.existsSync(w.journalFile()));
  const ripresa = launchTarget.completaCommit(w.filesRoot, NOME);
  assert.equal(ripresa.stato, 'completato');
  assert.ok(!fs.existsSync(w.journalFile()));
});

// --- revoca correlata dopo sostituzione ---------------------------------------

test('record sostituito e control RIARMATO con altro launchId: la coda non spegne il control nuovo', async (t) => {
  const w = mondo(t);
  w.modo('unverified');
  // il writer non conforme rimpiazza il record e riarma il control con un
  // ALTRO launchId mentre il rollback ha già la fotografia in mano: la fence
  // salta e la revoca deve restare CORRELATA al nostro lancio
  const ALTRO = 'ef'.repeat(8);
  const sostituisciERiarma = () => {
    try {
      const rf = w.recordFile();
      const prima = JSON.parse(fs.readFileSync(rf, 'utf8'));
      fs.writeFileSync(rf, JSON.stringify({ ...prima, launchId: ALTRO }));
    } catch (_) { /* il record può non esserci: la fence lo vede */ }
    const mgr = w.mgr();
    if (mgr && typeof mgr.armControl === 'function') {
      mgr.armControl(CELLA, { launchId: ALTRO, token: 'x'.repeat(40) });
    }
  };
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true, onStopFrame: sostituisciERiarma });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  // fence violata: incompleto, nessun host/commit
  assert.equal(rb.incompleto, true);
  assert.equal(rb.host, 'identity-unknown');
  assert.equal(rb.claim, 'held');
  // il control NUOVO non è nostro: la revoca correlata non lo spegne
  const mgr = w.mgr();
  assert.equal(mgr.controlLaunchId(CELLA), ALTRO, 'il control riarmato resta armato');
  assert.equal(mgr.controlArmato(CELLA), true);
  // MA il ticket del broker del NOSTRO lancio è revocato e il canale nostro chiuso
  assert.equal(w.revokes.length, 1);
  assert.ok(w.recordLease(), 'claim conservata');

  // Secondo mondo (mutante «togli la fence»): come sopra ma col motivo
  // PERSISTENZA, dove il contesto È dichiarabile e il retry riuscirebbe —
  // è SOLO la fence del record che ferma host/commit sul record sostituito.
  const w2 = mondo(t, { readinessRollbackMs: 20000 });
  w2.modo('verified');
  w2.fault.renameLiveContesto = true;
  const ALTRO2 = 'ee'.repeat(8);
  supervisoreInIssue(w2, t, {
    esce: true, uccidiSessione: true,
    onStopFrame: () => {
      try {
        const rf = w2.recordFile();
        const prima = JSON.parse(fs.readFileSync(rf, 'utf8'));
        fs.writeFileSync(rf, JSON.stringify({ ...prima, launchId: ALTRO2 }));
      } catch (_) { /* il record può non esserci: la fence lo vede */ }
    },
  });
  const fleet2 = await w2.fleet();
  const err2 = await fleet2.up(CELLA).then(() => null, (e) => e);
  const rb2 = err2.data.rollback;
  assert.equal(rb2.host, 'identity-unknown', 'record cambiato in itinere: nessun comando');
  assert.equal(w2.comandiVl().filter((l) => l.startsWith('stop ')).length, 0,
    'zero comandi host-stop nonostante il contesto dichiarabile');
  assert.equal(rb2.claim, 'held');
  assert.equal(rb2.record, 'kept');
  // il record sostituito resta INTATTO al suo posto: nessun commit per conto suo
  assert.equal(JSON.parse(fs.readFileSync(w2.recordFile(), 'utf8')).launchId, ALTRO2);
  assert.equal(w2.quarantena().length, 0, 'nessuna quarantena del record altrui');
  assert.ok(w2.pidHost() > 0, 'host vivo: la fence vale più della dichiarabilità');
});

// --- rilascio claim incerto DOPO host pulito ---------------------------------

test('rilascio claim incerto dopo host pulito: claim unknown onesta, commit mai avviato, UN solo tentativo', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  // fault one-shot su preparaLock del rilascio (lstatSync del file .lock della
  // claim, armata al frame stop: la CLAIM del lancio è già avvenuta): il
  // rilascio rifiuta LOCK_UNAVAILABLE → CLAIM_UNCERTAIN. Il rollback NON
  // inventa held/released e NON ritenta: claim unknown, commit mai avviato.
  const realLstat = fs.lstatSync;
  let lockPath = null;
  let armato = false;
  let consumato = false;
  fs.lstatSync = function lstatFault(p, ...rest) {
    if (armato && !consumato && typeof p === 'string' && p === lockPath) {
      consumato = true;
      throw Object.assign(new Error('fault lock claim (test)'), { code: 'EIO' });
    }
    return realLstat(p, ...rest);
  };
  t.after(() => { fs.lstatSync = realLstat; });
  supervisoreInIssue(w, t, {
    esce: true, uccidiSessione: true,
    onStopFrame: () => {
      const dir = path.join(w.home, '.nexuscrew', 'vl-root-claims');
      try {
        const locks = fs.readdirSync(dir).filter((f) => f.endsWith('.lock'));
        if (locks.length > 0) { lockPath = path.join(dir, locks[0]); armato = true; }
      } catch (_) { /* niente claim: il test lo vedrà */ }
    },
  });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  const rb = err.data.rollback;
  assert.equal(err.fleetCode, 'VL_PEER_UNATTESTED');
  assert.ok(consumato, 'la fault ha colpito il rilascio (preparaLock)');
  // l'host È stato fermato pulito; il rilascio è INCERTO: unknown, mai inventata
  assert.equal(rb.host, 'stopped-clean');
  assert.equal(rb.claim, 'unknown');
  assert.equal(rb.incompleto, true);
  assert.equal(w.pidHost(), 0, 'l\'host è davvero fermo');
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 1,
    'UN solo comando host-stop: nessun secondo tentativo');
  // il commit non è MAI partito: record al suo posto, nessun journal
  assert.equal(rb.record, 'kept');
  assert.equal(w.leggiRecord().stato, 'presente');
  assert.ok(!fs.existsSync(w.journalFile()), 'nessun journal: il commit non è avviato');
  assert.equal(w.quarantena().length, 0);
  // la claim resta a nome del NOSTRO lancio: il rilascio non è avvenuto
  const lease = w.recordLease();
  assert.ok(lease && lease.launchId, 'claim ancora presente (esito incerto, non rilasciata)');
  // un down successivo del mondo può ancora chiuderla: la risposta resta 500
  assert.equal(err.data.rollback.deadlineMs, 20000);
});

// --- percorso felice dalla VERA readiness failure (persistenza) ---------------

test('persistenza: retry per bytes pending→completo, UNA chiamata host-stop, chiusura completa, up successivo', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  w.fault.renameLiveContesto = true;
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.equal(err && err.fleetCode, 'VL_PEER_UNATTESTED');
  assert.equal(err.data.motivo, 'persistenza');
  const rb = err.data.rollback;
  assert.equal(rb.incompleto, false);
  assert.equal(rb.host, 'stopped-clean');
  assert.equal(rb.claim, 'released');
  assert.equal(rb.record, 'closed');
  // spy: UNA sola chiamata host-stop e UN solo rilascio (la claim non c'è più)
  assert.equal(w.comandiVl().filter((l) => l.startsWith('stop ')).length, 1);
  assert.equal(w.pidHost(), 0, 'host fermato');
  const lease = w.recordLease();
  assert.ok(!lease || !lease.launchId, 'claim della root rilasciata');
  // redazione dei corpi: la tuple grezza del peer non raggiunge mai il body
  const corpo9 = JSON.stringify(err.data);
  for (const parola of ['panePid', 'paneStarttime', 'bootId', 'startTicks', 'pidNamespaceInode', 'serverPid']) {
    assert.ok(!corpo9.includes(parola), `il body non porta ${parola}`);
  }
  // /up successivo SENZA SESSION_DUPLICATE
  const seconda = await fleet.up(CELLA);
  assert.equal(seconda.ok, true, 'nessuna barriera residua');
});

// --- retry persistenza per bytes: durabilità piena ----------------------------

test('persistenza con fsyncDir fallito DOPO il rename: bypass di durabilità, ZERO riscritture del contesto', async (t) => {
  const w = mondo(t, { readinessRollbackMs: 20000 });
  w.modo('verified');
  // fault a stadio unico: il rename del COMPLETO riesce ma il fsync della
  // directory di stato fallisce (una volta, SOLO quando il file contesto è
  // già il completo — cioè DOPO il rename della registrazione); il bypass
  // poi riqualifica. La fault del rename NON serve.
  const contestoDir = path.dirname(w.contestoFile());
  const contesto = w.contestoFile();
  const realOpen = fs.openSync;
  const realReadF = fs.readFileSync;
  let consumatoFsync = false;
  fs.openSync = function openFault(p, ...rest) {
    if (!consumatoFsync && p === contestoDir) {
      let corpo = '';
      try { corpo = realReadF(contesto, 'utf8'); } catch (_) { corpo = ''; }
      if (corpo.includes('"state":"live"')) {
        consumatoFsync = true;
        throw Object.assign(new Error('fault fsync dir (test)'), { code: 'EIO' });
      }
    }
    return realOpen(p, ...rest);
  };
  t.after(() => { fs.openSync = realOpen; });
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: true });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.equal(err && err.fleetCode, 'VL_PEER_UNATTESTED');
  assert.equal(err.data.motivo, 'persistenza', 'il fsync fallito è ancora persistenza');
  const rb = err.data.rollback;
  assert.equal(rb.incompleto, false, 'bypass di durabilità: il completo già nostro si riqualifica');
  assert.equal(rb.host, 'stopped-clean');
  assert.equal(rb.record, 'closed');
  // il contesto su disco è il COMPLETO (zero riscritture: il file porta la tuple)
  const ctx = vlHostStop.leggiContesto(w.base());
  assert.ok(ctx && !ctx.errore);
  assert.equal(ctx.hostIdentity.state, 'live');
  // redazione dei corpi: la tuple grezza del peer non raggiunge mai il body
  const corpo7e = JSON.stringify(err.data);
  for (const parola of ['panePid', 'paneStarttime', 'bootId', 'startTicks', 'pidNamespaceInode', 'serverPid']) {
    assert.ok(!corpo7e.includes(parola), `il body non porta ${parola}`);
  }
});

// --- unità: vocabolario terminale e reason ----------------------------------

test('activity: readiness-rollback è una ragione terminale valida; operator-stop invariato', () => {
  const activity = require('../lib/files/activity.js');
  assert.equal(activity.RAGIONI_TERMINALI.includes('readiness-rollback'), true);
  assert.equal(activity.RAGIONI_TERMINALI.includes('operator-stop'), true);
});

test('coordinatore: motivoStop espone la reason del frame accettato e ignora valori fuori enum', () => {
  const fabbrica = () => gruppo.creaCoordinatore({
    token: 't'.repeat(32), launchId: 'ab'.repeat(8),
    monoNow: () => 1000, sleep: async () => {},
    killGruppo: () => {}, osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
    invia: () => {}, svuota: async () => {},
    cancellaDelivery: async () => null, scriviLog: () => {},
    dichiaraStopping: () => {}, disarmaLegacy: () => {}, installaIgnoraTerm: () => {},
  });
  const vergine = fabbrica();
  assert.equal(vergine.motivoStop(), undefined, 'nessuna reason prima del frame');
  // frame con reason fuori enum: frame valido, la reason NON si deposita
  // (requestId nel formato RE_REQUEST_ID: 16 hex, altrimenti il frame è
  // rifiutato al dedup e il test non proverebbe l'enum)
  const fuoriEnum = fabbrica();
  fuoriEnum.onFrame({ op: 'stop', launchId: 'ab'.repeat(8), epoch: 1, requestId: 'a1'.repeat(8),
    payload: { reason: 'motivo-inventato-che-non-esiste-proprio' } });
  assert.equal(fuoriEnum.motivoStop(), undefined, 'reason fuori enum ignorata');
  // frame con reason dell'enum ACCETTATO dal proprio coordinatore
  const correlato = fabbrica();
  correlato.onFrame({ op: 'stop', launchId: 'ab'.repeat(8), epoch: 1, requestId: 'b2'.repeat(8),
    payload: { reason: 'readiness-rollback' } });
  assert.equal(correlato.motivoStop(), 'readiness-rollback');
  // frame di un ALTRO lancio: rifiutato, nessuna reason depositata
  const estraneo = fabbrica();
  estraneo.onFrame({ op: 'stop', launchId: 'cd'.repeat(8), epoch: 1, requestId: 'c3'.repeat(8),
    payload: { reason: 'readiness-rollback' } });
  assert.equal(estraneo.motivoStop(), undefined, 'frame di un altro launchId ignorato');
});

test('attendiFermataGruppo: il payload stop porta reason solo dall\'enum chiusa', async () => {
  const visti = [];
  const ascoltatori = [];
  const mgr = {
    controlConnesso: () => true,
    controlLaunchId: () => null,
    ascoltaControl: (fn) => { ascoltatori.push(fn); return () => {}; },
    suChiusuraControl: () => () => {},
    sendControl: (cellId, frame) => {
      visti.push(frame);
      setImmediate(() => {
        for (const fn of ascoltatori) fn(cellId, {
          op: 'stop-report', requestId: frame.requestId, launchId: frame.launchId, epoch: 1,
          payload: { stopRequestId: frame.requestId, code: 'eperm', conti: { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' } },
        });
      });
      return true;
    },
  };
  const ora = () => Number(process.hrtime.bigint() / 1000000n);
  const esito = await gruppo.attendiFermataGruppo({
    leaseManager: mgr, cellId: 'c', launchId: 'ab'.repeat(8),
    monoNow: ora, deadlineAt: ora() + 500, graziaMs: 100,
    reason: 'readiness-rollback',
  });
  assert.equal(visti.length, 1);
  assert.equal(visti[0].payload.reason, 'readiness-rollback');
  // contratto dell'API: l'esito espone uscito/attestato/motivoUscita, MAI
  // il campo interno sessioneAssente — chi lo leggesse leggerebbe undefined.
  assert.equal('sessioneAssente' in esito, false, 'sessioneAssente non è nell\'API');
  // fuori enum: la reason NON viaggia
  await gruppo.attendiFermataGruppo({
    leaseManager: mgr, cellId: 'c', launchId: 'ab'.repeat(8),
    monoNow: ora, deadlineAt: ora() + 500, graziaMs: 100,
    reason: 'motivo-inventato-che-non-esiste',
  });
  assert.equal(visti.length, 2);
  assert.equal(visti[1].payload.reason, undefined);
});

// --- i18n: la chiave del terminale nelle tre lingue --------------------------

test('i18n: cell-terminal-readiness-rollback presente in it, en, es', async () => {
  const i18n = await import('../frontend/src/lib/i18n.js');
  const { setLang, t } = i18n;
  for (const lang of ['it', 'en', 'es']) {
    setLang(lang);
    const tradotta = t('cell-terminal-readiness-rollback');
    assert.notEqual(tradotta, 'cell-terminal-readiness-rollback',
      `la chiave è tradotta in ${lang} (t non restituisce la chiave nuda)`);
    assert.ok(typeof tradotta === 'string' && tradotta.length > 0);
  }
});

// R5 giro 2 — la CALLBACK di attestazione consegnata al modulo di stop deve
// portare il residuo della fase come le letture dirette: il taglio esterno
// (Promise.race) chiude l'attesa del chiamante, non la richiesta gia' partita
// col default di cinque secondi. Qui si osserva il timeout della richiesta vera
// sul canale posseduto del lancio.
test('R5/R5b: la callback di attestazione del rollback porta il residuo, mai il default', async (t) => {
  const tc = require('../lib/fleet/tmux-control.js');
  const creaVero = tc.creaSessionePosseduta;
  const letture = [];
  tc.creaSessionePosseduta = async (opzioni) => {
    const creato = await creaVero(opzioni);
    const canale = creato && creato.canale;
    if (canale && typeof canale.hasSession === 'function') {
      const hs = canale.hasSession.bind(canale);
      canale.hasSession = (id, timeoutMs) => { letture.push({ id, timeoutMs }); return hs(id, timeoutMs); };
    }
    return creato;
  };
  t.after(() => { tc.creaSessionePosseduta = creaVero; });
  const BUDGET = 1200;
  const w = mondo(t, { readinessRollbackMs: BUDGET });
  w.modo('unverified');
  supervisoreInIssue(w, t, { esce: true, uccidiSessione: false });
  const fleet = await w.fleet();
  const err = await fleet.up(CELLA).then(() => null, (e) => e);
  assert.equal(err && err.fleetCode, 'VL_PEER_UNATTESTED');
  assert.ok(letture.length > 0, 'nessuna lettura has-session sul canale posseduto');
  const fuoriBudget = letture.filter((l) => !(Number.isFinite(l.timeoutMs) && l.timeoutMs <= BUDGET));
  assert.deepEqual(fuoriBudget, [], `letture col default o fuori dal residuo: ${JSON.stringify(fuoriBudget)}`);
});
