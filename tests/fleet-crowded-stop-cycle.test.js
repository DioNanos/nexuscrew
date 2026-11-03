'use strict';
// Ciclo operator-stop -> up su engine NON vl, lease REALE, /proc AFFOLLATO
// forzato dal seam procRoot (piu' di CAP_SCAN voci sintetiche, senza generare
// processi veri e senza monkey-patch dell'fs). Il censimento di produzione —
// lo stesso osservaProduzione del runtime, invocato dal wrapper del lease
// manager — non puo' mai dare «noti» in questo regime:
//   * negativo (canary in vitro): senza prova di uscita del supervisore
//     l'esito resta stop-unknown, il record resta incerto e l'up successivo
//     e' rifiutato;
//   * positivo: con l'attestazione (uscita provata + canale morto DOPO la
//     prova, la sessione muore col gruppo) il down chiude pulito e l'up
//     successivo riesce nonostante il /proc affollato.
// Il «supervisore» e' un processo vero staccato del test (ucciso SOLO per PID
// esatto); tmux e' finto e scriptato: la sessione «muore» col gruppo, come in
// produzione dove il client -C attached esce con la sessione che contiene.

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
const launchTarget = require('../lib/fleet/launch-target.js');
const gruppo = require('../lib/fleet/group-stop.js');

const SESSIONE = '$7';
const NOME = 'nc-s4-crowd';
const CELLA = 'CellaCrowd';
const CAP_SCAN = 256;

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

// /proc sintetica nel regime affollato del nodo carico (studio: /proc=839 vs
// CAP_SCAN=256): tutti estranei al gruppo del bersaglio.
function montaProcAffollato(t, quanti = CAP_SCAN + 60) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s4-cp-'));
  for (let i = 0; i < quanti; i += 1) {
    const pid = 4194000 + i;
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'),
      `${pid} (syn) S 1 777777 777777 0 0 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  }
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

// Wrapper del lease manager REALE: aggiunge osservaGruppo, che il runtime
// interpella prima del censimento di produzione. Il censimento e' il VERO
// osservaProduzione con il seam procRoot: il regime affollato e' quello del
// nodo carico, non un valore costruito a mano. Il pgrp del supervisore si
// conosce solo dopo la creazione del mondo: l'holder si legge a chiamata.
// `senzaAttesaUscita` simula il mondo senza la prova di uscita (canary).
function mgrConCensimentoAffollato(mgrReale, procRoot, pgrpHolder, { senzaAttesaUscita = false } = {}) {
  return new Proxy(mgrReale, {
    get(target, prop) {
      if (prop === 'osservaGruppo') {
        return () => (pgrpHolder.v
          ? gruppo.osservaProduzione([], pgrpHolder.v, { procRoot })
          : null);
      }
      if (senzaAttesaUscita && (prop === 'attendiUscita' || prop === 'osservaUscita')) {
        return undefined;
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function creaMondo(t, { mgrWrapper = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s4c-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, CELLA); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json'); fs.writeFileSync(statoPath, '[]');
  const logPath = path.join(root, 'chiamate.log');
  const markerMorte = path.join(root, 'sessione-morta');
  const paneChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'],
    { detached: true, stdio: 'ignore' });
  paneChild.unref();
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
const STATO = ${JSON.stringify(statoPath)};
const LOG = ${JSON.stringify(logPath)};
const MORTE = ${JSON.stringify(markerMorte)};
const PANE_PID = ${paneChild.pid};
const leggi = () => { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (_) { return []; } };
const scrivi = (l) => fs.writeFileSync(STATO, JSON.stringify(l));
const nota = (c) => fs.appendFileSync(LOG, c + '\\n');
const sessioneViva = () => leggi().some((x) => x.id === ${JSON.stringify(SESSIONE)});
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
  const poll = setInterval(() => {
    if (fs.existsSync(MORTE) || !sessioneViva()) process.exit(0);
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
      if (fs.existsSync(MORTE)) process.exit(0);
      if (riga.startsWith('kill-session')) {
        nota('kill-session:' + riga.split(/\\s+/).pop());
        scrivi(leggi().filter((x) => x.id !== ${JSON.stringify(SESSIONE)}));
      }
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
  const nome = args[args.indexOf('-s') + 1];
  const s = { nome, id: ${JSON.stringify(SESSIONE)}, w: '@7', p: '%7' };
  scrivi(leggi().concat([s]));
  nota('new-session:' + nome);
  process.stdout.write(s.id + '\\t' + s.w + '\\t' + s.p + '\\n'); process.exit(0);
}
if (cmd(args) === 'kill-session') {
  const bersaglio = args[args.length - 1];
  nota('kill-session:' + bersaglio);
  scrivi(leggi().filter((x) => x.id !== bersaglio));
  process.exit(0);
}
if (cmd(args) === 'has-session') {
  const bersaglio = args[args.length - 1];
  nota('has-session:' + bersaglio);
  if (leggi().some((x) => x.id === bersaglio)) process.exit(0);
  process.stderr.write('can\\'t find session: ' + bersaglio + '\\n');
  process.exit(1);
}
if (cmd(args) === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('pane_pid')) { process.stdout.write('99999\\t' + PANE_PID + '\\n'); process.exit(0); }
  if (fmt.includes('pane_dead')) { process.stdout.write('0\\t0\\t%7\\n'); process.exit(0); }
  process.stdout.write('0\\t\\t%7\\n'); process.exit(0);
}
if (cmd(args) === 'capture-pane') { process.stdout.write(''); process.exit(0); }
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'eg', label: 'G', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: CELLA, tmuxSession: NOME, cwd, engine: 'eg', boot: false }],
  });
  let payloadLancio = null;
  const mgrReale = createLeaseManager({ home });
  const mgr = mgrWrapper ? mgrWrapper(mgrReale) : mgrReale;
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true, groupStopBudgetMs: 4000 },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async (req) => { payloadLancio = req; return { socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }; },
      revoke: async () => {}, close: async () => {},
    },
    leaseManager: mgr,
    boot: loadDefinitions(defsPath),
  });
  t.after(() => {
    try { runtime.shutdown(); } catch (_) {}
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { mgrReale.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, filesRoot, mgr, runtime, paneChild, markerMorte,
    payloadLancio: () => payloadLancio,
    log: () => { try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } },
  };
}

function attaccaSupervisore(t, w) {
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
              fs.writeFileSync(path.join(w.root, 'sessions.json'), '[]');
              try { fs.writeFileSync(w.markerMorte, '1'); } catch (_) {}
            },
            osserva: () => (morto
              ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
              : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
            invia: (frame) => leaseCtl.sendControl(frame),
            svuota: async () => {
              await leaseCtl.svuota();
              try { clientSide.end(); } catch (_) {}
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
            onControlFrame: (frame) => coord.onFrame(frame),
          });
          const spegni = () => {
            try { leaseCtl.stop(); } catch (_) {}
            try { clientSide.destroy(); } catch (_) {}
            try { serverSide.destroy(); } catch (_) {}
            srv.close();
          };
          t.after(() => { spegni(); });
          resolve({ coord, spegni });
        })().catch(reject);
      });
      clientSide.once('error', reject);
    });
  });
}

// --- negativo: /proc affollato, nessuna prova di uscita -> canary in vitro -

test('stop con /proc affollato e nessuna prova di uscita: stop-unknown, record incerto, up rifiutato', async (t) => {
  const procRoot = montaProcAffollato(t);
  const pgrpHolder = { v: null };
  const w = creaMondo(t, {
    mgrWrapper: (mgrReale) => mgrConCensimentoAffollato(mgrReale, procRoot, pgrpHolder, { senzaAttesaUscita: true }),
  });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  pgrpHolder.v = gruppo.leggiPgrp(w.paneChild.pid);
  assert.ok(pgrpHolder.v, 'il supervisore finto deve stare in un gruppo proprio');
  // sanity del regime: il censimento dal seam e' affollato, come sul nodo carico
  assert.equal(gruppo.osservaProduzione([], pgrpHolder.v, { procRoot }).qualita, 'almeno');
  await w.runtime.up(CELLA);
  const sup = await attaccaSupervisore(t, w);
  assert.ok(sup);
  // la sessione muore col gruppo (canale morto dopo l'uscita) MA la prova di
  // uscita non esiste: l'affollamento da solo non puo' chiudere nulla
  await assert.rejects(
    () => w.runtime.down(CELLA),
    (e) => e.fleetCode === 'STOP_UNKNOWN',
  );
  const record = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(record.stato, 'presente');
  assert.equal(record.record.incerto, true);
  await assert.rejects(() => w.runtime.up(CELLA), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0,
    'nessun comando di teardown senza esito dichiarabile');
});

// --- positivo: /proc affollato, recupero a tre prove -> chiuso, up ok -------

test('stop con /proc affollato: senza verdetto sul canale nessuna attestazione, il recupero a tre prove chiude e l up dopo riesce', async (t) => {
  const procRoot = montaProcAffollato(t);
  const pgrpHolder = { v: null };
  const w = creaMondo(t, {
    mgrWrapper: (mgrReale) => mgrConCensimentoAffollato(mgrReale, procRoot, pgrpHolder),
  });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  pgrpHolder.v = gruppo.leggiPgrp(w.paneChild.pid);
  assert.ok(pgrpHolder.v);
  await w.runtime.up(CELLA);
  const sup = await attaccaSupervisore(t, w);
  assert.ok(sup);
  // Primo down: il supervisore esce provato e la sessione muore con lui, ma
  // il client muore con la sessione e la sua morte da sola NON attesta
  // l'assenza (EOF, timeout e sostituzione sono indistinguibili); col
  // censimento affollato non dichiarabile l'esito resta STOP_UNKNOWN.
  await assert.rejects(
    () => w.runtime.down(CELLA),
    (e) => e.fleetCode === 'STOP_UNKNOWN',
  );
  const dopoRifiuto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(dopoRifiuto.stato, 'presente');
  assert.equal(dopoRifiuto.record.incerto, true);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0,
    'nessun comando di teardown senza esito dichiarabile');
  // Recupero onesto: il down ripetuto, senza canale, chiude sulle TRE prove
  // in lettura (sessione assente dal verdetto CLI, supervisore morto
  // accertato in /proc reale, lease non live): il censimento affollato del
  // nodo non serve.
  sup.spegni();
  const recupero = await w.runtime.down(CELLA);
  assert.equal(recupero.ok, true);
  assert.equal(recupero.outcome, 'resolved-dead');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  // il lancio successivo non e' bloccato: nessun incerto residuo. Il marker
  // della morte programmata va tolto: il client -C del NUOVO lancio uscirebbe
  // subito con il marker ancora li'.
  try { fs.unlinkSync(w.markerMorte); } catch (_) { /* gia' assente */ }
  const secondo = await w.runtime.up(CELLA);
  assert.equal(secondo.ok, true);
});
