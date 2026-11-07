'use strict';
// Pezzo 4, prima parte: i primi negativi del disegno F1 §4 con il binario
// VL VERO (non un finto). Tre prove:
//  1. capacità peer/stop ASSENTE (binario vero più vecchio, che dichiara
//     solo host_stop_v1) — up RIFIUTATO prima dello spawn, zero effetti;
//  2. il diagnostico punta a un ALTRO processo vivo: la diagonale del lock
//     («displayed, never trusted») nomina un processo-decoy; la tuple
//     registrata all'up resta quella del VERO host e il down ferma il vero
//     host, il decoy mai;
//  3. host SOSTITUITO prima della prima qualifica: A vive e muore, B prende
//     la stessa root, l'up qualifica B (tuple di B, non di A) e il down
//     ferma B.
//
// Pezzo 4, seconda parte (P4b), stesso file e stesso isolamento:
//  4. sostituzione FRA osservazione e stop: la qualifica vede A vivo, poi B
//     prende la root; lo stop protetto col CLI VERO rifiuta peer_mismatch
//     (zero stop su B) e il down NC è fail-closed con record e lease trattenuti;
//  5. PID riusato / nascita diversa: tuple registrata manomessa (stesso pid,
//     starttime diverso) — down rifiutato e CLI VERO che risponde peer_mismatch;
//  6. positivo up/down/up: una consegna del prompt per up, respawn zero, e al
//     secondo up si registra la tuple del NUOVO host.
//
// L'host VL vero nasce nel test: `vl server --foreground` con HOME, XDG_* e
// TMPDIR tutti sotto la cartella del test in /tmp, --server-root esplicito
// (niente discovery XDG/HOME) e profilo uguale a quello del catalogo. Il
// binario VL non passa da systemd --user: socket e lock vivono sotto la
// root del server (server/.vl/control.sock, server/.vl/lock), verificato
// nel sorgente VL in qualifica. Ogni processo del test (host, decoy) nasce
// nel test e muore per PID esatto: i pid non si cercano per nome.
//
// Il binario non è di questo repo: NC_VL_REAL_BIN (pinnato al commit VL in
// qualifica, sha256 opzionale in NC_VL_REAL_BIN_SHA256) e, per la prima
// prova, NC_VL_OLD_REAL_BIN (un binario vero che precede le capacità
// peer/stop). Senza env il test si salta e DICE perché.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const { radiceServer } = require('../lib/fleet/vl-roots.js');
const { tuplaAttesaDaRecord, qualificaIsolamentoHost, fermaHost } = require('../lib/fleet/vl-host-stop.js');
const { OWNER_INSTANCE_ID } = require('./helpers/vl-attestato.js');

const REALE = process.env.NC_VL_REAL_BIN || '';
const SHA_ATTESO = process.env.NC_VL_REAL_BIN_SHA256 || '';
const VECCHIO = process.env.NC_VL_OLD_REAL_BIN || '';
const SALTA = REALE ? false : 'NC_VL_REAL_BIN non impostato: nessun VL vero con cui provare i negativi';
const SALTA_VECCHIO = VECCHIO ? false : 'NC_VL_OLD_REAL_BIN non impostato: nessun VL vero senza capacità peer/stop';

const SESSIONE = 'cloud-CellaPre';
const PROMPT = 'Leggi CLAUDE.md e parti';
const PROFILO = 'work'; // l'unico profilo del catalogo: è il -p che NC passa

const CODICE_DECOY = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 30);';

// Il mondo del runtime: fake tmux a stato vero + fleet.json + broker, come
// fleet-vl-preflight-peer-stop, ma con il binario VL VERO al posto del finto.
function mondo(t, { binario } = {}) {
  // La base del mondo è CORTA e sotto /tmp: la control socket dell'host VL
  // vive a <root>/server/.vl/control.sock e il kernel limita un pathname di
  // socket Unix a SUN_PATH_MAX (108): con una base lunga l'host rifiuta la
  // root (UnsafePath). Privata (mkdtemp 0700), una per test, rimossa alla fine.
  const root = fs.mkdtempSync('/tmp/p4a-');
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaPre');
  fs.mkdirSync(cwd, { recursive: true });
  // La catena fino alla root del server dev'essere PRIVATA: l'host VL rifiuta
  // un albero non privato (unsafe_layout) e non crea da solo i livelli che
  // mancano (li prepara il test, 0700, come fa il runtime vero con le sue dir).
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.copyFileSync(binario || REALE, vlBin);
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  // Catalogo: UN profilo, morto per natura (nessun provider reale qui).
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'),
    `[profiles.${PROFILO}]\nprovider = "openai-compat"\nbase_url = "http://127.0.0.1:9"\nmodel = "m"\n`);

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  // Contatore di respawn: quante volte il fake tmux ha davvero creato la
  // sessione. Un respawn del runtime (kill + nuova sessione + nuova consegna)
  // si vede qui come una riga in più.
  const nsLog = path.join(root, 'new-sessions.log');
  fs.writeFileSync(nsLog, '');
  // Il pid del processo che il fake fa nascere al respawn (il supervisore).
  // E' un processo VERO: la sua nascita si legge da /proc, come per un pane
  // tmux, e col kill-session muore con la sessione.
  const supPid = path.join(root, 'supervisor.pid');
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
const NSLOG = ${JSON.stringify(nsLog)};
const SUP = ${JSON.stringify(supPid)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  try { fs.appendFileSync(NSLOG, '1\\n'); } catch (_) {}
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('@nc_delivery')) { process.stdout.write('submitted\\n'); process.exit(0); }
  if (fmt.includes('#{pane_pid}')) {
    // Identita' del supervisore. Prima del respawn il pane e' il placeholder e
    // non ha un pid proprio (campo vuoto, come prima); dopo il respawn il pane
    // e' il processo che il fake ha fatto nascere, e quel pid esiste davvero.
    let pane = '';
    try { const p = Number(fs.readFileSync(SUP, 'utf8')); if (p > 0) pane = String(p); } catch (_) {}
    process.stdout.write('0\\t' + pane + '\\n'); process.exit(0);
  }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd === 'respawn-pane') {
  // respawn-pane e' cio' che da' la vita al processo del pane. Il fake lo
  // sostituisce con un processo VERO e vivo: la identita' che il runtime legge
  // subito dopo il respawn deve essere un pid di cui /proc attesta nascita e
  // gruppo, non un numero che nessuno risponde.
  try {
    if (!fs.existsSync(SUP)) {
      const { spawn: nasci } = require('node:child_process');
      const figlio = nasci(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'],
        { detached: true, stdio: 'ignore' });
      figlio.unref();
      fs.writeFileSync(SUP, String(figlio.pid));
    }
  } catch (_) { /* nessun pid: il runtime rifiutera' il lancio, come deve */ }
  process.exit(0);
}
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  const mia = bersaglio === ${JSON.stringify(SESSIONE)} || bersaglio === '$5';
  if (mia) {
    fs.writeFileSync(STATO, vive().filter((n) => n !== ${JSON.stringify(SESSIONE)}).map((n) => n + '\\n').join(''));
    // Con la sessione muore il suo pane: il supervisore del fake si ferma per
    // PID esatto, come farebbe tmux col processo del pane.
    try { const p = Number(fs.readFileSync(SUP, 'utf8')); if (p > 0) process.kill(p, 'SIGKILL'); } catch (_) {}
    try { fs.rmSync(SUP, { force: true }); } catch (_) {}
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
      // vlProfile esplicito: NC passa `-p work` al client vl e la sonda di
      // registrazione interroga `host status --profile work` — l'host del
      // test nasce con lo stesso profilo del catalogo, come in flotta.
      managed: {
        client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard',
        vlProfile: PROFILO,
      },
    }],
    cells: [{ id: 'CellaPre', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false, prompt: PROMPT }],
  });

  const tickets = [];
  const launchBroker = {
    issue: async (payload) => {
      tickets.push(payload);
      return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
    revoke: async () => {},
    close: async () => {},
  };
  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0, vlLaunchCooldownMs: 0,
    now: () => 0, monotonicNow: () => Date.now(),
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
  };
  t.after(() => {
    // Se un test esce prima del down, il processo nato dal respawn e' ancora
    // nostro: si ferma per PID esatto prima di rimuovere la cartella.
    try {
      const p = Number(fs.readFileSync(supPid, 'utf8'));
      if (p > 0) process.kill(p, 'SIGKILL');
    } catch (_) { /* nessun pid, o gia' uscito col kill-session */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hostRoot = radiceServer(home, OWNER_INSTANCE_ID, 'CellaPre');
  return {
    root, home, tickets, cfgBase, statoPath, hostRoot, vlBin, nsLog,
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
  };
}

// L'ambiente dell'host VL vero: TUTTO sotto la cartella del test.
function envHost(w) {
  return {
    HOME: w.home,
    XDG_CONFIG_HOME: path.join(w.home, '.config'),
    XDG_STATE_HOME: path.join(w.root, 'host-state'),
    XDG_DATA_HOME: path.join(w.root, 'host-data'),
    XDG_RUNTIME_DIR: path.join(w.root, 'host-rt'),
    TMPDIR: path.join(w.root, 'host-rt'),
    PATH: '/usr/bin:/bin',
  };
}

function statoVero(w) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(w.vlBin,
    ['host', 'status', '--json', '--server-root', w.hostRoot, '--profile', PROFILO],
    { env: envHost(w), encoding: 'utf8', timeout: 10000 });
  try { return JSON.parse(r.stdout); } catch (_) { return null; }
}

// L'host VL vero: `vl server --foreground`, vivo quando lo status dice live.
async function avviaHostReale(w, t) {
  for (const d of ['host-state', 'host-data', 'host-rt']) {
    fs.mkdirSync(path.join(w.root, d), { recursive: true, mode: 0o700 });
  }
  // La root del server la crea l'host VL stesso (una root GIA' esistente e
  // vuota viene rifiutata): chi lancia prepara solo la catena del PARENT,
  // privata 0700 fino a home.
  fs.mkdirSync(path.dirname(w.hostRoot), { recursive: true, mode: 0o700 });
  const stderrFile = path.join(w.root, 'host-stderr.log');
  // detached => setsid: l'host nasce leader del proprio gruppo e della
  // propria sessione, come il processo che tmux fa nascere in flotta. Solo
  // così il giudizio di isolamento del down può dare «isolato».
  const figlio = spawn(w.vlBin,
    ['server', '--foreground', '--server-root', w.hostRoot, '--profile', PROFILO],
    { env: envHost(w), detached: true, stdio: ['ignore', 'ignore', fs.openSync(stderrFile, 'w')], cwd: w.root });
  figlio.unref();
  const uscito = new Promise((resolve) => figlio.once('exit', (code, sig) => resolve({ code, sig })));
  t.after(() => { try { figlio.kill('SIGKILL'); } catch (_) { /* già uscito */ } });
  const limite = Date.now() + 15000;
  for (;;) {
    if (figlio.exitCode !== null || figlio.signalCode !== null) {
      let detto = '';
      try { detto = fs.readFileSync(stderrFile, 'utf8').slice(0, 400); } catch (_) {}
      throw new Error(`l'host vero è uscito prima di essere vivo (${figlio.exitCode}/${figlio.signalCode}): ${detto}`);
    }
    if (Date.now() > limite) throw new Error("l'host vero non è diventato vivo");
    const s = statoVero(w);
    if (s && s.state === 'live' && s.peer_identity && s.peer_identity.state === 'verified') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { figlio, uscito };
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Il contesto del lancio: la tuple registrata all'up (host-context.json).
function leggiContesto(w) {
  const base = vlCellBaseDir(w.home, OWNER_INSTANCE_ID, 'CellaPre');
  const pila = [base];
  while (pila.length) {
    const dir = pila.pop();
    let nomi;
    try { nomi = fs.readdirSync(dir); } catch (_) { continue; }
    for (const nome of nomi) {
      const p = path.join(dir, nome);
      let st = null;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) pila.push(p);
      else if (nome === 'host-context.json') return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return null;
}

// Un processo-decoy VIVO, nato nel test: quello che il diagnostico nomina.
function spawnaDecoy(w, t) {
  const figlio = spawn(process.execPath, ['-e', CODICE_DECOY],
    { env: { ...envHost(w) }, stdio: 'ignore', cwd: w.root, detached: true });
  figlio.unref();
  t.after(() => { try { figlio.kill('SIGKILL'); } catch (_) { /* già uscito */ } });
  return figlio;
}

// Il PERCORSO del contesto del lancio (host-context.json): serve al test per
// manometterlo in place (leggiContesto restituisce solo il contenuto).
function percorsoContesto(w) {
  const base = vlCellBaseDir(w.home, OWNER_INSTANCE_ID, 'CellaPre');
  const pila = [base];
  while (pila.length) {
    const dir = pila.pop();
    let nomi;
    try { nomi = fs.readdirSync(dir); } catch (_) { continue; }
    for (const nome of nomi) {
      const p = path.join(dir, nome);
      let st = null;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) pila.push(p);
      else if (nome === 'host-context.json') return p;
    }
  }
  return null;
}

// Quante volte il fake tmux ha creato davvero la sessione (respawn incluso).
function conteggioNewSession(w) {
  try { return fs.readFileSync(w.nsLog, 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; }
}

// Il CLI VERO dello stop protetto, invocato direttamente con una tuple data:
// quello che NC spedirebbe se la sua qualifica fosse passata.
function stopAttesoDiretto(w, tupla) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(w.vlBin,
    ['internal', 'host-stop', '--server-root', w.hostRoot, '--json', '--expected', tupla],
    { env: envHost(w), encoding: 'utf8', timeout: 25000 });
}

test('VL vero: il binario è quello dichiarato e dichiara le capacità peer/stop', { skip: SALTA }, () => {
  if (SHA_ATTESO) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('sha256sum', [REALE], { encoding: 'utf8' });
    assert.equal(r.stdout.split(/\s+/)[0], SHA_ATTESO, 'il binario non è quello dichiarato');
  }
});

test('VL vero vecchio senza capacità peer/stop — up RIFIUTATO prima dello spawn, zero effetti', { skip: SALTA_VECCHIO }, async (t) => {
  const w = mondo(t, { binario: VECCHIO });
  // Il vecchio binario vero dichiara solo host_stop_v1: il fatto è del
  // binario, lo si chiede a host assente, prima di ogni effetto.
  const fleet = await w.fleet();
  await assert.rejects(() => fleet.up('CellaPre'), (e) => e.status === 500
    && e.fleetCode === 'VL_PEER_STOP_UNSUPPORTED', 'il rifiuto deve essere il gate di capacità');
  assert.equal(fs.readFileSync(w.statoPath, 'utf8').trim(), '', 'zero sessioni: nessuno spawn');
  assert.equal(w.tickets.length, 0, 'zero payload broker');
});

test('VL vero: il diagnostico punta a un ALTRO processo vivo — tuple del vero host, decoy mai toccato', { skip: SALTA }, async (t) => {
  const w = mondo(t, {});
  const decoy = spawnaDecoy(w, t);
  const host = await avviaHostReale(w, t);
  // La diagonale del lock («displayed, never trusted»): il pid dichiarato
  // diventa quello del decoy, che è vivo. La peer_identity resta provata
  // sulla connessione: è la tuple del VERO host.
  const lock = path.join(w.hostRoot, 'server', '.vl', 'lock');
  assert.ok(fs.existsSync(lock), 'lock dell\'host presente');
  fs.writeFileSync(lock, `pid=${decoy.pid}\nstarted=1\n`);
  const s = statoVero(w);
  assert.equal(s.state, 'live');
  assert.equal(s.declared_pid, decoy.pid, 'il diagnostico nomina il decoy');
  assert.equal(s.peer_identity.state, 'verified');
  assert.equal(s.peer_identity.pid, host.figlio.pid, 'il peer provato è il vero host');

  const fleet = await w.fleet();
  const up = await fleet.up('CellaPre');
  assert.equal(up.ok, true, `up riuscito: ${JSON.stringify(up)}`);
  const ctx = leggiContesto(w);
  assert.ok(ctx && ctx.hostIdentity, 'contesto con hostIdentity');
  assert.equal(ctx.hostIdentity.pid, host.figlio.pid, 'la tuple registrata è quella del VERO host');
  assert.notEqual(ctx.hostIdentity.pid, decoy.pid, 'il pid del decoy non è identità');

  // Il down OBSERVA il pid diagnostico (l'unico puntatore che il contratto
  // dà) e trova il DECOY, un processo vivo con un'altra nascita: la tuple
  // osservata non è quella registrata → isolamento «ignoto» → RIFIUTO
  // fail-closed. Zero stop: né il decoy, né — per non poter provare quale
  // processo fermare — il vero host. È il nucleo del negativo: un pid
  // diagnostico che punta altrove non autorizza NESSUNO stop.
  await assert.rejects(() => fleet.down('CellaPre'), (e) => e.status === 500
    && e.fleetCode === 'HOST_STOP_FAILED'
    && e.data && e.data.outcome === 'host-stop-failed'
    && e.data.motivoIsolamento === 'ignoto',
  'il rifiuto deve essere fail-closed sull\'isolamento ignoto');
  assert.equal(vivo(decoy.pid), true, 'il processo-decoy è VIVO: zero stop su di lui');
  assert.equal(vivo(host.figlio.pid), true, 'il vero host è VIVO: senza prova, nessuno stop');
  // Il lancio incerto non si riapre da solo e non genera nuovi comandi.
  await assert.rejects(() => fleet.up('CellaPre'), (e) => e.fleetCode === 'STOP_UNKNOWN',
    'il lancio bloccato dal down incompleto non si riapre da solo');
  assert.equal(vivo(decoy.pid), true, 'il decoy è ancora vivo');
  assert.equal(vivo(host.figlio.pid), true, 'il vero host è ancora vivo');
});

test('VL vero: host SOSTITUITO prima della prima qualifica — si registra B, non A', { skip: SALTA }, async (t) => {
  const w = mondo(t, {});
  const a = await avviaHostReale(w, t);
  // A muore per PID esatto, B prende la stessa root: la sostituzione avviene
  // PRIMA che l'up qualifichi chicchessia.
  a.figlio.kill('SIGTERM');
  await a.uscito;
  assert.equal(vivo(a.figlio.pid), false, 'A è davvero uscito');
  const b = await avviaHostReale(w, t);
  assert.notEqual(b.figlio.pid, a.figlio.pid);

  const fleet = await w.fleet();
  const up = await fleet.up('CellaPre');
  assert.equal(up.ok, true, `up riuscito: ${JSON.stringify(up)}`);
  const ctx = leggiContesto(w);
  assert.ok(ctx && ctx.hostIdentity, 'contesto con hostIdentity');
  assert.equal(ctx.hostIdentity.pid, b.figlio.pid, 'la tuple registrata è di B, il peer VIVO alla qualifica');
  assert.notEqual(ctx.hostIdentity.pid, a.figlio.pid, 'la tuple di A non è mai un\'identità');

  const down = await fleet.down('CellaPre');
  assert.equal(down.ok, true, `down pulito: ${JSON.stringify(down)}`);
  const uscita = await Promise.race([b.uscito, new Promise((r) => setTimeout(() => r(null), 10000))]);
  assert.ok(uscita, 'B è uscito');
  assert.equal(statoVero(w).state, 'none', 'lo status vero dice none');
});

// Pezzo 4, seconda parte (P4b): la corsa «fra osservazione e stop» e il giro
// positivo completo, sempre col binario VL VERO. La sostituzione si colloca
// DOPO la qualifica d'isolamento (l'osservazione del runtime) e PRIMA del
// comando di stop: è la finestra che --expected esiste per chiudere. Il test
// congela esattamente quello stato — qualifica fatta su A vivo, stop lanciato
// contro B — usando le funzioni VERE del runtime (qualificaIsolamentoHost e
// fermaHost, quelle che il down chiama nello stesso ordine).

test('VL vero: host SOSTITUITO fra osservazione e stop — il CLI rifiuta peer_mismatch, zero stop su B', { skip: SALTA }, async (t) => {
  const w = mondo(t, {});
  const a = await avviaHostReale(w, t);
  const fleet = await w.fleet();
  const up = await fleet.up('CellaPre');
  assert.equal(up.ok, true, `up riuscito: ${JSON.stringify(up)}`);
  const ctx = leggiContesto(w);
  assert.ok(ctx && ctx.hostIdentity, 'contesto con hostIdentity');
  assert.equal(ctx.hostIdentity.pid, a.figlio.pid, 'la tuple registrata all\'up è quella di A');

  // L'OSSERVAZIONE: la qualifica che il runtime fa prima dello stop, con A
  // vivo. Deve dare «isolato»: stesso processo, stessa nascita, stesso gruppo.
  const quali = await qualificaIsolamentoHost({
    stateDir: w.root, record: ctx, bin: w.vlBin,
    instanceId: OWNER_INSTANCE_ID, budgetMs: 30000, monoNow: () => Date.now(),
  });
  assert.equal(quali.isolamento, 'isolato', `A vivo e isolato prima della sostituzione (motivo ${quali.motivo})`);

  // La SOSTITUZIONE: A muore per PID esatto, B prende la stessa root.
  a.figlio.kill('SIGTERM');
  await a.uscito;
  assert.equal(vivo(a.figlio.pid), false, 'A è davvero uscito');
  const b = await avviaHostReale(w, t);
  assert.notEqual(b.figlio.pid, a.figlio.pid);
  const sB = statoVero(w);
  assert.equal(sB.state, 'live', 'la root ora è di B');
  assert.equal(sB.peer_identity.pid, b.figlio.pid, 'il peer provato dalla root è B');

  // Lo STOP arriva DOPO: la tuple attesa è ancora quella di A (registrata
  // all'up). fermaHost è la funzione VERA del down, con la qualifica fatta su
  // A e il probe di A: il CLI VERO prova il peer sulla connessione (B), lo
  // confronta con --expected (A) e rifiuta peer_mismatch. Nessun Shutdown,
  // nessun ripiego, codice dedicato.
  const esito = await fermaHost({
    record: ctx, bin: w.vlBin, budgetMs: 30000, monoNow: () => Date.now(),
    isolamento: quali.isolamento, probeIniziale: quali.probe,
  });
  assert.equal(esito.outcome, 'host-stop-failed', `outcome: ${JSON.stringify(esito)}`);
  assert.equal(esito.code, 'HOST_PEER_MISMATCH', `codice dedicato: ${JSON.stringify(esito)}`);
  assert.equal(esito.reason, 'peer_mismatch');
  assert.equal(esito.via, 'internal', 'nessun ripiego sul vecchio comando');
  assert.equal(vivo(b.figlio.pid), true, 'B VIVO: zero stop su di lui');
  assert.equal(statoVero(w).state, 'live', 'B serve ancora: nessuno Shutdown è partito');

  // E il runtime intero resta fail-closed: il down NC osserva B, non coincide
  // con la tuple registrata (A) e rifiuta senza nemmeno un comando di stop;
  // record e lease restano trattenuti (nessun riavvio automatico).
  await assert.rejects(() => fleet.down('CellaPre'), (e) => e.status === 500
    && e.fleetCode === 'HOST_STOP_FAILED'
    && e.data && e.data.outcome === 'host-stop-failed'
    && e.data.motivoIsolamento === 'ignoto',
  'il down rifiuta fail-closed: la tuple osservata (B) non è quella registrata (A)');
  assert.equal(vivo(b.figlio.pid), true, 'B ancora vivo dopo il down rifiutato');
  await assert.rejects(() => fleet.up('CellaPre'), (e) => e.fleetCode === 'STOP_UNKNOWN',
    'record e lease trattenuti: il lancio bloccato non si riapre da solo');
  assert.equal(vivo(b.figlio.pid), true, 'B sempre vivo');
});

test('VL vero: PID riusato o nascita diversa — expected con starttime diverso, il CLI rifiuta e l\'host vive', { skip: SALTA }, async (t) => {
  const w = mondo(t, {});
  const host = await avviaHostReale(w, t);
  const fleet = await w.fleet();
  const up = await fleet.up('CellaPre');
  assert.equal(up.ok, true, `up riuscito: ${JSON.stringify(up)}`);
  const ctx = leggiContesto(w);
  assert.ok(ctx && ctx.hostIdentity, 'contesto con hostIdentity');
  assert.equal(ctx.hostIdentity.pid, host.figlio.pid, 'la tuple registrata è quella dell\'host vivo');

  // Manometto la tuple REGISTRATA nel contesto del test: stesso pid, nascita
  // (starttime) diversa. È la firma di un pid riusato: il numero coincide, il
  // processo non è quello fermato all'up.
  const manipolato = JSON.parse(JSON.stringify(ctx));
  manipolato.hostIdentity.startTicks = String(Number(manipolato.hostIdentity.startTicks) + 1);
  const fileContesto = percorsoContesto(w);
  assert.ok(fileContesto, 'file del contesto trovato');
  fs.writeFileSync(fileContesto, JSON.stringify(manipolato));
  const tupla = tuplaAttesaDaRecord(manipolato);
  assert.ok(tupla, 'la tuple manomessa è ancora ben formata: stesso pid, starttime diverso');

  // Il runtime è fail-closed PRIMA: il confronto kernel vs tuple registrata
  // dà «ignoto» e il down rifiuta senza inviare alcuno stop.
  await assert.rejects(() => fleet.down('CellaPre'), (e) => e.status === 500
    && e.fleetCode === 'HOST_STOP_FAILED'
    && e.data && e.data.outcome === 'host-stop-failed'
    && e.data.motivoIsolamento === 'ignoto',
  'il down rifiuta: la nascita osservata non è quella registrata');
  assert.equal(vivo(host.figlio.pid), true, 'host VIVO: zero stop');

  // E anche dove il runtime non guarda, il CLI VERO confronta l'intera tuple
  // col peer provato sulla connessione: starttime diverso è peer_mismatch.
  const r = stopAttesoDiretto(w, tupla);
  assert.notEqual(r.status, 0, `rifiuto con exit ${r.status}`);
  const esito = JSON.parse(r.stdout.trim());
  assert.equal(esito.ok, false, `esito CLI: ${r.stdout.trim()}`);
  assert.equal(esito.reason, 'peer_mismatch', `reason dal CLI vero: ${r.stdout.trim()}`);
  assert.equal(vivo(host.figlio.pid), true, 'host ancora VIVO dopo il rifiuto');
  assert.equal(statoVero(w).state, 'live', 'l\'host serve ancora: nessuno Shutdown');
});

test('VL vero: positivo up/down/up — una consegna del prompt per up, respawn zero, seconda tuple registrata', { skip: SALTA }, async (t) => {
  const w = mondo(t, {});
  const fleet = await w.fleet();

  // Primo giro: host vero, up che lo registra, down protetto pulito.
  const h1 = await avviaHostReale(w, t);
  const up1 = await fleet.up('CellaPre');
  assert.equal(up1.ok, true, `primo up: ${JSON.stringify(up1)}`);
  const ctx1 = leggiContesto(w);
  assert.ok(ctx1 && ctx1.hostIdentity, 'contesto con hostIdentity');
  assert.equal(ctx1.hostIdentity.pid, h1.figlio.pid, 'prima tuple: l\'host del primo up');
  assert.equal(w.tickets.length, 1, 'UNA consegna del prompt per il primo up');
  assert.equal(conteggioNewSession(w), 1, 'UNA new-session: nessun respawn');

  const down1 = await fleet.down('CellaPre');
  assert.equal(down1.ok, true, `primo down pulito: ${JSON.stringify(down1)}`);
  const uscita1 = await Promise.race([h1.uscito, new Promise((r) => setTimeout(() => r(null), 10000))]);
  assert.ok(uscita1, 'il primo host è uscito');
  assert.equal(statoVero(w).state, 'none', 'status none dopo il primo down');
  assert.equal(fs.readFileSync(w.statoPath, 'utf8').trim(), '', 'sessione chiusa dal down');
  assert.equal(conteggioNewSession(w), 1, 'nessun respawn dopo il down');

  // Secondo giro: un host NUOVO sulla stessa root. Il secondo up registra la
  // SUA tuple (nascita diversa), con una sola consegna del prompt in più.
  const h2 = await avviaHostReale(w, t);
  assert.notEqual(h2.figlio.pid, h1.figlio.pid);
  const up2 = await fleet.up('CellaPre');
  assert.equal(up2.ok, true, `secondo up: ${JSON.stringify(up2)}`);
  const ctx2 = leggiContesto(w);
  assert.ok(ctx2 && ctx2.hostIdentity, 'contesto con hostIdentity');
  assert.equal(ctx2.hostIdentity.pid, h2.figlio.pid, 'secondo up: si registra la tuple del NUOVO host');
  assert.notEqual(ctx2.hostIdentity.startTicks, ctx1.hostIdentity.startTicks, 'nascita del nuovo host diversa');
  assert.equal(w.tickets.length, 2, 'una consegna per il secondo up: DUE in tutto');
  assert.equal(conteggioNewSession(w), 2, 'DUE new-session in tutto: respawn zero');

  const down2 = await fleet.down('CellaPre');
  assert.equal(down2.ok, true, `secondo down pulito: ${JSON.stringify(down2)}`);
  const uscita2 = await Promise.race([h2.uscito, new Promise((r) => setTimeout(() => r(null), 10000))]);
  assert.ok(uscita2, 'il secondo host è uscito');
  assert.equal(statoVero(w).state, 'none', 'status none alla fine');
  assert.equal(fs.readFileSync(w.statoPath, 'utf8').trim(), '', 'sessione chiusa alla fine');
});
