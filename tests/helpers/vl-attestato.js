'use strict';
// Fixture condivisa del binario vl «attestato» per i test runtime del fleet.
// La registrazione all'up interroga il binario PINNATO con `host status`:
// perché il lancio sia dichiarato riuscito lo status deve portare un host
// LIVE con `peer_identity` verified (i sette fatti kernel del peer, schema
// 1) e le tre capacità peer/stop. Un finto che risponde `none` fisso fallisce
// l'up con VL_PEER_UNATTESTED: non è un difetto, è il gate. L'owner della
// tuple è l'instanceId hex32 del nodo (identityOwnerInstanceId): con owner
// `local` la tuple non è valida e l'up è rifiutato per contratto.

// hex32: la forma che validaHostIdentity richiede come instanceId.
const OWNER_INSTANCE_ID = 'ab'.repeat(16);

const BOOT_ID = '12345678-1234-1234-1234-123456789abc';

// `vl host status --json` di un host VIVO col peer attestato: le capacità
// peer/stop dichiarate in ogni stato (il preflight le chiede allo stesso
// binario, con lo stesso argv) e il blocco `peer_identity` verified.
const STATO_HOST_ATTESTATO = JSON.stringify({
  state: 'live',
  declared_pid: 4242,
  pid_number_in_use: true,
  capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
  peer_identity_support: 'supported',
  peer_identity: {
    schema_version: 1,
    state: 'verified',
    pid: 4242,
    uid: 1000,
    starttime: 1234,
    boot_id: BOOT_ID,
    pidns: 4026531836,
    pgid: 4242,
    sid: 4242,
  },
});

// La stessa tuple nella forma hostIdentity del contesto del launchId: i
// decimali kernel diventano stringhe e l'instanceId è l'owner del nodo.
const IDENTITA_ATTESTATA = {
  state: 'live',
  source: 'kernel-peer-v1',
  instanceId: OWNER_INSTANCE_ID,
  pid: 4242,
  uid: 1000,
  bootId: BOOT_ID,
  pidNamespaceInode: '4026531836',
  startTicks: '1234',
  pgid: 4242,
  sid: 4242,
};

// Host finto: processo REALE, leader del proprio gruppo e della propria
// sessione (spawn detached => setsid), osservabile in /proc, fermo solo quando
// il test (o lo stop del binario finto) lo uccide per pid esatto.
const { spawn } = require('node:child_process');

const CODICE_HOST_FINTO = [
  'process.on("SIGTERM", () => process.exit(0));',
  'process.on("SIGINT", () => process.exit(0));',
  'setInterval(() => {}, 1 << 30);',
].join(' ');

function spawnaHostFinto() {
  const figlio = spawn(process.execPath, ['-e', CODICE_HOST_FINTO],
    { detached: true, stdio: 'ignore' });
  figlio.unref();
  return figlio;
}

// Il generatore del binario vl finto QUALIFICATO peer/stop con host VERO.
// La tuple dichiarata NON è una costante: il blocco `peer_identity` viene
// letto da /proc del pid vivo nel pidfile, con lo stesso parsing di
// osservaPeerKernel, così coincide con quella che il runtime osserverà al
// down (giudizio «isolato», non «osservazione»).
// - `host status`: pid vivo -> live + declared_pid + peer_identity verified;
//   pid morto o assente -> none (le capacità restano dichiarate in ogni stato).
// - `internal host-stop` (e `shutdown` legacy): SIGTERM al pid esatto, attesa
//   della scomparsa, pidfile azzerato, `{"ok":true,"reason":"shutdown_ack"}`.
// - Qualsiasi altro argv è la TUI: come la TUI vera, che l'host lo fa nascere
//   all'avvio, prima spegne il vecchio pid (se ancora vivo, per pid esatto)
//   e poi scrive il pid del host nuovo.
function scriptVlFintoConHost({ version = 'vl 0.4.0', hostpid, vllog } = {}) {
  if (!hostpid) throw new Error('scriptVlFintoConHost: serve il path del pidfile');
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const HOSTPID = ${JSON.stringify(hostpid)};
const LOG = ${JSON.stringify(vllog || '/dev/null')};
const argv = process.argv.slice(2);
const nota = (c) => { try { fs.appendFileSync(LOG, c + '\\n'); } catch (_) {} };
const leggiPid = () => { try { return Number(fs.readFileSync(HOSTPID, 'utf8').trim()) || 0; } catch (_) { return 0; } };
const scriviPid = (p) => { try { fs.writeFileSync(HOSTPID, p + '\\n'); } catch (_) {} };
const esiste = (p) => { try { process.kill(p, 0); return true; } catch (_) { return false; } };
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// La tuple kernel del peer, letta da /proc con il parsing di osservaPeerKernel.
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
const comune = {
  schema_version: 1, explicit_root: true, profile: 'e2emock', profile_source: 'config',
  residual_lock: null, error: null,
  capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
  peer_identity_support: 'supported',
};
if (argv[0] === '--version') { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(0); }
if (argv[0] === 'host' && argv[1] === 'status') {
  nota('status ' + argv.join(' '));
  const iRoot = argv.lastIndexOf('--server-root');
  const radice = iRoot >= 0 ? String(argv[iRoot + 1] || '') : '';
  const base = { ...comune, server_root: radice };
  // La root usa e getta della sonda di capacita' non e' l'host del lancio.
  if (radice.indexOf('nc-vl-cap-') !== -1) {
    process.stdout.write(JSON.stringify({ ...base, state: 'none', declared_pid: null,
      pid_number_in_use: null, since: null }) + '\\n');
    process.exit(0);
  }
  const p = leggiPid();
  if (p > 0 && esiste(p)) {
    const id = identitaKernel(p);
    process.stdout.write(JSON.stringify({ ...base, state: 'live', declared_pid: p,
      pid_number_in_use: true, since: { source: 'declared', unix: 1 },
      peer_identity: id ? { schema_version: 1, state: 'verified', ...id } : null }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ ...base, state: 'none', declared_pid: null,
      pid_number_in_use: null, since: null }) + '\\n');
  }
  process.exit(0);
}
if ((argv[0] === 'internal' && argv[1] === 'host-stop') || argv[0] === 'shutdown') {
  nota('stop:' + (argv[0] === 'shutdown' ? 'legacy' : 'internal'));
  const p = leggiPid();
  if (p > 0) {
    try { process.kill(p, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 80 && esiste(p); i += 1) attesa(25);
    scriviPid(0);
  }
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.exit(0);
}
// La TUI: fa nascere un host nuovo (detached: pid==pgid==sid) dopo aver
// spento per pid esatto quello vecchio, se era ancora vivo.
{
  const vecchio = leggiPid();
  if (vecchio > 0 && esiste(vecchio)) {
    try { process.kill(vecchio, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 40 && esiste(vecchio); i += 1) attesa(25);
  }
  const figlio = spawn(process.execPath, ['-e', ${JSON.stringify(CODICE_HOST_FINTO)}],
    { detached: true, stdio: 'ignore' });
  figlio.unref();
  scriviPid(figlio.pid);
  process.exit(0);
}
`;
}

// Helper host finto STANDALONE: un piccolo script che sa fare due cose.
// - `host-finto.cjs --respawn <pidfile>`: spegne per pid esatto l'host che
//   il pidfile nomina (se ancora vivo), fa nascere un host nuovo detached
//   (pid==pgid==sid) e ne scrive il pid. È la nascita dell'host che nella
//   vita vera accompagna l'avvio della TUI: qui la fa nascere il tmux finto
//   a ogni new-session, così il pid cambia a ogni lancio come nel vero.
// - senza argv di servizio: È l'host (vive finché non gli arriva un segnale).
function preparaHostFinto(dir) {
  const script = `${dir}/host-finto.cjs`;
  require('node:fs').writeFileSync(script, `#!${process.execPath}
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
  const figlio = spawn(process.execPath, ['-e', ${JSON.stringify(CODICE_HOST_FINTO)}],
    { detached: true, stdio: 'ignore' });
  figlio.unref();
  fs.writeFileSync(pidfile, figlio.pid + '\\n');
  process.exit(0);
}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  require('node:fs').chmodSync(script, 0o755);
  return script;
}

module.exports = {
  OWNER_INSTANCE_ID,
  BOOT_ID,
  STATO_HOST_ATTESTATO,
  IDENTITA_ATTESTATA,
  spawnaHostFinto,
  scriptVlFintoConHost,
  preparaHostFinto,
};
