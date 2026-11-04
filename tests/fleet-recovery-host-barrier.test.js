'use strict';
// Recupero di un lancio osservabilmente morto con la BARRIERA HOST:
// resolved-dead (canale assente) e attested-recovery (stessa down) non
// tolgono il record se l'host vl del lancio non e' fermo per la propria
// identita' attestata. La morte del supervisore e un lease non live non
// provano che un host SEPARATO sia fermo: host ignoto (contesto assente o
// corrotto), tuple mutata (host sostituito) o claim della root non
// rilasciato conservano record e guardia incerta. L'ordine e' barriera
// host -> rilascio root -> rimozione durevole del record, come nel ramo
// pulito: gli assert spiano la rimozione e verificano che l'host fosse
// gia' fermo PRIMA di togliere il record.
// L'host e' un processo VERO e separato (fixture del test, mai un host
// della flotta): nasce con la sessione, si spegne solo per pid esatto o
// con lo stop attestato del binario vl finto pinnato.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const gruppo = require('../lib/fleet/group-stop.js');
const { OWNER_INSTANCE_ID, scriptVlFintoConHost, preparaHostFinto } = require('./helpers/vl-attestato.js');

const SESSIONE = '$9';
const NOME = 'cloud-CellaVlBar';
const CELLA = 'CellaVlBar';

function hexId() { return crypto.randomBytes(8).toString('hex'); }

function attendi(check, ms = 4000, passo = 20) {
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

// --- mondo: vl vero di fixture + tmux finto + supervisore reale ------------

// respawnAllaMorte: il client -C, quando la sessione muore col gruppo, fa
// nascere un host NUOVO sulla root (come farebbe un altro lancio) prima di
// uscire: la barriera del recupero dovra' rigiudicarlo e la tuple in /proc
// non sara' quella registrata.
function creaMondo(t, { respawnAllaMorte = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vlbar-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, CELLA);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const logPath = path.join(root, 'vl.log');
  fs.writeFileSync(logPath, '');
  const hostScript = preparaHostFinto(root);
  const hostpid = path.join(root, 'hostpid');
  fs.writeFileSync(hostpid, '0\n');
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, scriptVlFintoConHost({ hostpid, vllog: logPath }), { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  const catalogo = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogo, { recursive: true });
  fs.writeFileSync(path.join(catalogo, 'config.toml'), '[profiles.work]\nmodel = "m"\n');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json');
  fs.writeFileSync(statoPath, '[]');
  const logTmux = path.join(root, 'chiamate.log');
  // Il «supervisore» e' un processo vero, staccato: la sua identita' in
  // /proc e' quella vera e la sua morte si provoca SOLO per pid esatto.
  const paneChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
    { detached: true, stdio: 'ignore' });
  paneChild.unref();
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const HOSTSCRIPT = ${JSON.stringify(hostScript)};
const HOSTPID = ${JSON.stringify(hostpid)};
const STATO = ${JSON.stringify(statoPath)};
const LOG = ${JSON.stringify(logTmux)};
const NOME = ${JSON.stringify(NOME)};
const RESPAWN_ALLA_MORTE = ${JSON.stringify(respawnAllaMorte)};
const PANE_PID = ${paneChild.pid};
const leggi = () => { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (_) { return []; } };
const scrivi = (l) => fs.writeFileSync(STATO, JSON.stringify(l));
const nota = (c) => fs.appendFileSync(LOG, c + '\\n');
const sessioneViva = () => leggi().some((x) => x.nome === NOME);
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpo = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : '');
    if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpo(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpo(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
    process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  // Il client -C e' attached alla sessione: esce con lei. Con il respawn
  // alla morte, prima di uscire fa nascere un host NUOVO sulla root.
  const muoriColCanale = () => {
    if (RESPAWN_ALLA_MORTE) {
      const { spawnSync: riavvia } = require('node:child_process');
      riavvia(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]);
    }
    process.exit(0);
  };
  const poll = setInterval(() => {
    if (!sessioneViva()) muoriColCanale();
  }, 10);
  let n = 0; let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      // un comando che arriva DOPO la morte della sessione non riceve
      // verdetto: il client attached esce con lei senza rispondere (il
      // caso del recupero nella stessa down — canale morto, niente prova)
      if (!sessioneViva()) muoriColCanale();
      n += 1;
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, [__filename, '-S', 'x'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => { clearInterval(poll); process.exit(0); });
  return;
}
const cmd = (a) => a[0] || '';
if (cmd(args) === 'new-session') {
  // l'host nasce con la sessione (il vecchio pid, se vivo, viene spento per
  // pid esatto): all'up la tuple registrata e' osservabile in /proc
  { const { spawnSync: riavviaHost } = require('node:child_process');
    riavviaHost(process.execPath, [HOSTSCRIPT, '--respawn', HOSTPID]); }
  const s = { nome: NOME, id: ${JSON.stringify(SESSIONE)}, w: '@9', p: '%9' };
  scrivi(leggi().concat([s]));
  nota('new-session:' + NOME);
  process.stdout.write(s.id + '\\t' + s.w + '\\t' + s.p + '\\n'); process.exit(0);
}
if (cmd(args) === 'kill-session') {
  const bersaglio = args[args.length - 1];
  nota('kill-session:' + bersaglio);
  scrivi(leggi().filter((x) => x.id !== bersaglio && x.nome !== bersaglio));
  process.exit(0);
}
if (cmd(args) === 'has-session') {
  const bersaglio = args[args.length - 1];
  nota('has-session:' + bersaglio);
  const nome = bersaglio.startsWith('=') ? bersaglio.slice(1) : bersaglio;
  if (leggi().some((x) => x.id === bersaglio || x.nome === nome)) process.exit(0);
  process.stderr.write('can\\'t find session: ' + nome + '\\n');
  process.exit(1);
}
if (cmd(args) === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('pane_pid')) { process.stdout.write('99999\\t' + PANE_PID + '\\n'); process.exit(0); }
  if (fmt.includes('pane_dead')) { process.stdout.write('0\\t0\\t%9\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%9\\n'); process.exit(0);
}
if (cmd(args) === 'list-sessions') {
  for (const s of leggi()) process.stdout.write(s.nome + '\\t1\\n');
  process.exit(0);
}
if (cmd(args) === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL',
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: CELLA, tmuxSession: NOME, cwd, engine: 'vl.native', boot: false }],
  });
  let payloadLancio = null;
  const mgr = createLeaseManager({ home });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true, vlLaunchCooldownMs: 0, groupStopBudgetMs: 4000, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    launchBroker: {
      issue: async (req) => { payloadLancio = req; return { socketPath: path.join(root, 'broker.sock'), nonce: 'b'.repeat(64) }; },
      revoke: async () => {}, close: async () => {},
    },
    leaseManager: mgr,
    boot: loadDefinitions(defsPath),
  });
  const hostPid = () => { try { return Number(fs.readFileSync(hostpid, 'utf8').trim()) || 0; } catch (_) { return 0; } };
  t.after(() => {
    // Zero orfani: l'host finto si spegne per pid esatto prima della pulizia.
    const p = hostPid();
    if (p > 0) { try { process.kill(p, 'SIGKILL'); } catch (_) {} }
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { runtime.shutdown(); } catch (_) {}
    try { mgr.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, home, filesRoot, mgr, runtime, paneChild, hostpid, hostScript, hostPid,
    payloadLancio: () => payloadLancio,
    logVl: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
    logTmux: () => { try { return fs.readFileSync(logTmux, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } },
    contestoPath: () => path.join(vlCellBaseDir(home, OWNER_INSTANCE_ID, CELLA), 'host-context.json'),
    claimsDir: () => path.join(home, '.nexuscrew', 'vl-root-claims'),
    sessioni: () => JSON.parse(fs.readFileSync(statoPath, 'utf8')),
    spegniSessione: () => fs.writeFileSync(statoPath, '[]'),
  };
}

// Spia dell'ordine: la rimozione durevole del record avviene SOLO dopo che
// l'host del lancio era gia' fermo. Il wrapper registra, al momento della
// rimozione, se il pid dell'host era ancora vivo: barriera PRIMA, record POI.
function spiaOrdineRimozione(t, hostPid) {
  const visto = { rimozioni: [] };
  const rimuoviOriginale = launchTarget.rimuovi;
  launchTarget.rimuovi = (...a) => {
    const p = hostPid();
    let vivo = false;
    if (p > 0) { try { process.kill(p, 0); vivo = true; } catch (_) { vivo = false; } }
    visto.rimozioni.push({ hostVivo: vivo });
    return rimuoviOriginale.apply(launchTarget, a);
  };
  t.after(() => { launchTarget.rimuovi = rimuoviOriginale; });
  return visto;
}

const uccidiSupervisore = async (w) => {
  const pid = w.paneChild.pid;
  process.kill(pid, 'SIGKILL');
  await attendi(() => { try { process.kill(pid, 0); return false; } catch (_) { return true; } });
};

// --- (1) positivo no-canale: barriera host ferma l'host, POI il record -----

test('resolved-dead vl: tre prove + barriera host attestata -> host fermo e root rilasciata PRIMA della rimozione del record', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  const hostPrima = w.hostPid();
  assert.ok(hostPrima > 0, 'lancio senza host di fixture');
  // il lancio muore col supervisore: sessione e supervisore via, NC «riavviato»
  w.spegniSessione();
  await uccidiSupervisore(w);
  w.runtime.shutdown();
  const spia = spiaOrdineRimozione(t, w.hostPid);
  const esito = await w.runtime.down(CELLA);
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'resolved-dead');
  assert.equal(esito.host, 'host-stopped-clean');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  // l'host di fixture e' stato fermato dallo stop attestato del binario
  await attendi(() => { try { process.kill(hostPrima, 0); return false; } catch (_) { return true; } });
  assert.ok(w.logVl().some((r) => r.startsWith('stop:internal')), 'lo stop attestato dell\'host e\' partito');
  // ORDINE: la rimozione e' avvenuta con l'host GIA' fermo, una volta sola
  assert.equal(spia.rimozioni.length, 1);
  assert.equal(spia.rimozioni[0].hostVivo, false, 'la barriera host precede la rimozione del record');
  // il lancio successivo non e' bloccato dal record residuo
  const dopo = await w.runtime.up(CELLA);
  assert.equal(dopo.ok, true);
});

// --- (2) negativo: contesto host assente ------------------------------------

test('resolved-dead vl con contesto host assente: la barriera non e\' dimostrabile, record e guardia incerta restano, host vivo', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  const hostPrima = w.hostPid();
  assert.ok(hostPrima > 0);
  w.spegniSessione();
  await uccidiSupervisore(w);
  w.runtime.shutdown();
  fs.rmSync(path.dirname(w.contestoPath()), { recursive: true, force: true });
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.fleetCode === 'HOST_UNRESOLVABLE');
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  // l'host NON e' stato toccato: nessuno stop, processo ancora vivo
  assert.equal(w.logVl().filter((r) => r.startsWith('stop:')).length, 0);
  let vivo = false; try { process.kill(hostPrima, 0); vivo = true; } catch (_) { vivo = false; }
  assert.equal(vivo, true, 'l\'host separato resta vivo: la sua morte non e\' provata');
  await assert.rejects(() => w.runtime.up(CELLA), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
});

// --- (3) negativo: contesto host corrotto -----------------------------------

test('resolved-dead vl con contesto host corrotto: la barriera non e\' dimostrabile, record e guardia incerta restano', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  w.spegniSessione();
  await uccidiSupervisore(w);
  w.runtime.shutdown();
  fs.writeFileSync(w.contestoPath(), '{ questo non e\' json');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.fleetCode === 'HOST_UNRESOLVABLE');
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(w.logVl().filter((r) => r.startsWith('stop:')).length, 0);
});

// --- (4) negativo: host sostituito (tuple mutata) ---------------------------

test('resolved-dead vl con host sostituito: tuple mutata, la barriera rifiuta senza toccare nessun pid, record e guardia restano', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  w.spegniSessione();
  await uccidiSupervisore(w);
  w.runtime.shutdown();
  // l'host registrato viene SOSTITUITO (helper --respawn: il vecchio pid
  // muore per pid esatto, il pidfile nomina un processo vivo nato DOPO): la
  // tuple osservata in /proc non e' piu' quella registrata
  const { spawnSync } = require('node:child_process');
  spawnSync(process.execPath, [w.hostScript, '--respawn', w.hostpid]);
  const nuovo = w.hostPid();
  assert.ok(nuovo > 0, 'respawn dell\'host fallito');
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.fleetCode === 'HOST_STOP_FAILED' || e.fleetCode === 'HOST_IDENTITY_CHANGED');
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  // l'host NUOVO non e' stato toccato: non e' quello del lancio
  let vivo = false; try { process.kill(nuovo, 0); vivo = true; } catch (_) { vivo = false; }
  assert.equal(vivo, true, 'l\'host sostituito resta vivo: la barriera non lo ferma');
});

// --- (5) negativo: root ancora occupata (claim non rilasciato) --------------

test('resolved-dead vl con claim della root non rilasciabile: record e guardia incerta restano', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  const hostPrima = w.hostPid();
  assert.ok(hostPrima > 0);
  w.spegniSessione();
  await uccidiSupervisore(w);
  w.runtime.shutdown();
  // il record lease della root viene corrotto: il rilascio torna uncertain e
  // il claim non risulta rilasciato — la chiusura non si dichiara
  const lease = fs.readdirSync(w.claimsDir()).find((f) => f.endsWith('lease'));
  assert.ok(lease, 'record lease della root non trovato');
  fs.writeFileSync(path.join(w.claimsDir(), lease), '{ corrotto');
  const spia = spiaOrdineRimozione(t, w.hostPid);
  let revoke = 0;
  const revoca = w.mgr.revokeControl.bind(w.mgr);
  w.mgr.revokeControl = (id) => { revoke += 1; return revoca(id); };
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.fleetCode === 'CLAIM_UNCERTAIN');
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(revoke, 0, 'la root rossa non revoca il controllo per far tornare i conti');
  assert.equal(spia.rimozioni.length, 0, 'un none valido con la root rossa non rimuove il record');
  // l'host e' stato fermato dalla barriera (l'ordine e' quello), ma il
  // lancio NON si dichiara chiuso: la root resta sotto osservazione
  await attendi(() => { try { process.kill(hostPrima, 0); return false; } catch (_) { return true; } });
});

// --- supervisore reale lato cella (lease vero + coordinatore vero) ----------

function attaccaSupervisore(t, w, { tieniLease = false } = {}) {
  const { control } = w.payloadLancio() || {};
  assert.ok(control && control.launchId && control.token, 'payload del lancio senza canale di controllo');
  const pairPath = path.join(w.root, `pair-${hexId()}.sock`);
  let serverSide = null;
  const srv = net.createServer((sock) => { serverSide = sock; });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(pairPath, () => {
      const clientSide = net.connect(pairPath, () => {
        (async () => {
          await attendi(() => serverSide);
          assert.equal(w.mgr.attachInitial(CELLA, serverSide, { generation: 0 }), true);
          let morto = false;
          const coord = gruppo.creaCoordinatore({
            token: control.token, launchId: control.launchId,
            monoNow: () => Number(process.hrtime.bigint() / 1000000n),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            killGruppo: (sig) => {
              if (sig !== 'SIGTERM' || morto) return;
              morto = true;
              try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
              // la sessione muore col gruppo: il client -C attached esce
              w.spegniSessione();
            },
            osserva: () => (morto
              ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
              : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
            invia: (frame) => leaseCtl.sendControl(frame),
            svuota: async () => {
              await leaseCtl.svuota();
              if (!tieniLease) { try { clientSide.end(); } catch (_) {} }
            },
            cancellaDelivery: async () => null,
            scriviLog: () => {},
            dichiaraStopping: () => {},
            disarmaLegacy: () => {},
            installaIgnoraTerm: () => {},
          });
          const conta = { stop: 0 };
          var leaseCtl = startLeaseClient(clientSide, {
            stablePath: path.join(w.root, 'no-lease.sock'),
            launchEpoch: hexId(),
            onControlFrame: (frame) => {
              if (frame && frame.op === 'stop') conta.stop += 1;
              coord.onFrame(frame);
            },
          });
          const spegni = () => {
            try { leaseCtl.stop(); } catch (_) {}
            try { clientSide.destroy(); } catch (_) {}
            try { serverSide.destroy(); } catch (_) {}
            srv.close();
          };
          t.after(() => { spegni(); });
          resolve({ coord, spegni, conta });
        })().catch(reject);
      });
      clientSide.once('error', reject);
    });
  });
}

// --- (6) positivo stessa down: attested-recovery con host gia' fermo --------

test('down vl con uscita provata e canale morto col gruppo: recupero NELLA STESSA down, barriera vede l\'host gia\' fermo, attested-recovery', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  const hostPrima = w.hostPid();
  assert.ok(hostPrima > 0);
  const sup = await attaccaSupervisore(t, w);
  assert.ok(sup);
  // la prima barriera (pre-gruppo) ferma l'host registrato; poi il gruppo
  // esce provato, la sessione muore con lui e il client -C muore con la
  // sessione: senza verdetto il recupero a tre prove chiude NELLA STESSA
  // down e la barriera del recupero trova l'host gia' fermo.
  const spia = spiaOrdineRimozione(t, w.hostPid);
  const esito = await w.runtime.down(CELLA);
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'attested-recovery');
  assert.equal(esito.host, 'host-already-stopped');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  await attendi(() => { try { process.kill(hostPrima, 0); return false; } catch (_) { return true; } });
  assert.equal(sup.conta.stop, 1, 'un solo comando stop al supervisore: nessun doppio stop');
  assert.equal(w.logTmux().filter((r) => r.startsWith('kill-session:')).length, 0,
    'zero teardown nuovi oltre a quelli del lancio');
  assert.equal(spia.rimozioni.length, 1);
  assert.equal(spia.rimozioni[0].hostVivo, false, 'la barriera host precede la rimozione del record');
  // il lancio successivo non e' bloccato
  const secondo = await w.runtime.up(CELLA);
  assert.equal(secondo.ok, true);
});

// --- (7) negativo stessa down: host mismatch alla barriera del recupero -----

test('down vl con host NUOVO nato con la morte del canale: la barriera del recupero rifiuta, record e guardia incerta restano', async (t) => {
  const w = creaMondo(t, { respawnAllaMorte: true });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up(CELLA);
  const sup = await attaccaSupervisore(t, w);
  assert.ok(sup);
  // la sessione muore col gruppo e il client -C, morendo, fa nascere un host
  // NUOVO sulla root: l'uscita del supervisore e' provata e le tre prove
  // reggono, ma la barriera host del recupero vede una tuple NON registrata
  // e rifiuta — il lancio non si dichiara chiuso con un host da giudicare.
  await assert.rejects(() => w.runtime.down(CELLA), (e) => e.fleetCode === 'HOST_STOP_FAILED' || e.fleetCode === 'HOST_IDENTITY_CHANGED');
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  // l'host nuovo (non di questo lancio) resta vivo: nessun pid toccato
  const nuovo = w.hostPid();
  assert.ok(nuovo > 0);
  let vivo = false; try { process.kill(nuovo, 0); vivo = true; } catch (_) { vivo = false; }
  assert.equal(vivo, true, 'l\'host nuovo resta vivo: la barriera non lo ferma');
  assert.equal(sup.conta.stop, 1, 'un solo comando stop: nessun doppio stop');
  await assert.rejects(() => w.runtime.up(CELLA), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
});
