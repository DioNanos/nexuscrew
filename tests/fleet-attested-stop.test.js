'use strict';
// Attestazione dello stop (uscita provata + sessione assente osservata DOPO la
// prova sul canale posseduto): la chiusura pulita del lancio smette di
// dipendere dal censimento di /proc, che sui nodi carichi (>256 processi)
// non e' mai raggiungibile. Il lease e' REALE (manager vero, socket vero,
// protocollo di controllo vero); tmux e' finto e scriptato: la sessione
// «muore» quando muore il gruppo del supervisore, come in produzione, dove il
// client -C attached esce con la sessione che contiene.
// Il regime «/proc affollato» si forza senza processi veri: readdir di /proc
// vede piu' di 256 entry plausibili (lo stesso trucco del test del candidato
// illeggibile in fleet-down-group-stop), e i pid sintetici non stanno mai nel
// gruppo del supervisore. Nessun segnale ai processi della flotta: l'unico
// kill vero e' per PID esatto sul figlio staccato del test.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicWrite, loadDefinitions, leggiIdentitaProc, leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const gruppo = require('../lib/fleet/group-stop.js');

const SESSIONE = '$7';
const NOME = 'nc-att-prova';

// Il tempo passa: una lease in grace che il valutatore unico legge come SCADUTA.
// Le prove di morte del lancio accettano solo none o expired (grace e live
// bloccano): questi test vogliono la sola prova «scaduta» e la danno cosi'.
function graceScaduta(w) {
  const stato = w.mgr.status.bind(w.mgr);
  w.mgr.status = (id) => {
    const r = stato(id);
    return r && r.state === 'grace' ? { ...r, state: 'expired' } : r;
  };
}

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

// --- unit: la classifica riconosce l'attestazione, il resto non cambia ------

test('classifica: uscita provata + sessione assente = killed-clean attestato, anche col censimento non raggiungibile', () => {
  const pronto = { conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } };
  const affollato = { inGruppo: 0, fuoriGruppo: 0, qualita: 'almeno' };
  const esito = gruppo.classificaEsito({
    ready: pronto, uscito: true, sessioneAssente: true, dopo: affollato,
  });
  assert.equal(esito.outcome, 'killed-clean');
  assert.equal(esito.conti, null);
  assert.equal(esito.attestato, true);
  // senza attestazione il censimento affollato resta non dichiarabile
  const senza = gruppo.classificaEsito({ ready: pronto, uscito: true, dopo: affollato });
  assert.equal(senza.outcome, 'stop-unknown');
  assert.equal(senza.attestato, undefined);
  // l'attestazione senza prova di uscita non esiste
  assert.equal(gruppo.classificaEsito({ ready: pronto, sessioneAssente: true }).outcome, 'stop-unknown');
  // un rifiuto EPERM vince su tutto: mai pulito per attestazione
  assert.equal(gruppo.classificaEsito({
    report: { code: 'eperm' }, uscito: true, sessioneAssente: true,
  }).outcome, 'eperm');
});

test('attendiFermataGruppo: il seam della sessione corre DOPO la prova di uscita e solo il vero attesta', async () => {
  const fabbrica = (sessioneAssente) => {
    const ordine = [];
    const ascoltatori = [];
    let chiusura = null;
    const mgr = {
      controlConnesso: () => true,
      controlLaunchId: () => null,
      ascoltaControl: (fn) => { ascoltatori.push(fn); return () => {}; },
      suChiusuraControl: (_id, cb) => { chiusura = cb; return () => { chiusura = null; }; },
      sendControl: (cellId, frame) => {
        assert.equal(frame.op, 'stop');
        setImmediate(() => {
          for (const fn of ascoltatori) fn(cellId, {
            op: 'ready-to-exit', requestId: hexId(), launchId: frame.launchId, epoch: 1,
            payload: { tokenHash: 'ab'.repeat(32), stopRequestId: frame.requestId, conti: { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' } },
          });
          if (chiusura) chiusura();
        });
        return true;
      },
    };
    return {
      mgr, ordine,
      attendiUscita: async () => { ordine.push('uscita'); return { provato: true }; },
      osserva: () => { ordine.push('osserva'); return { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' }; },
      verificaSessioneAssente: async () => { ordine.push('sessione'); return sessioneAssente; },
    };
  };
  const ora = () => Number(process.hrtime.bigint() / 1000000n);
  const base = (s) => ({
    leaseManager: s.mgr, cellId: 'c', launchId: hexId(),
    monoNow: ora, deadlineAt: ora() + 2000, graziaMs: 400,
    attendiUscita: s.attendiUscita, osserva: s.osserva,
    verificaSessioneAssente: s.verificaSessioneAssente,
  });

  const vero = fabbrica(true);
  const esitoVero = await gruppo.attendiFermataGruppo(base(vero));
  assert.equal(esitoVero.outcome, 'killed-clean');
  assert.equal(esitoVero.attestato, true);
  assert.ok(vero.ordine.indexOf('uscita') < vero.ordine.indexOf('sessione'));

  const falso = fabbrica(false);
  const esitoFalso = await gruppo.attendiFermataGruppo(base(falso));
  assert.equal(esitoFalso.outcome, 'stop-unknown');
  assert.equal(esitoFalso.attestato, undefined);
  assert.ok(falso.ordine.indexOf('sessione') >= 0);

  const cheEsplode = fabbrica(true);
  cheEsplode.verificaSessioneAssente = async () => { cheEsplode.ordine.push('sessione'); throw new Error('canale illeggibile'); };
  const esitoEsploso = await gruppo.attendiFermataGruppo(base(cheEsplode));
  assert.equal(esitoEsploso.outcome, 'stop-unknown');
  assert.equal(esitoEsploso.attestato, undefined);
});

// --- /proc sintetico: affollato (> CAP_SCAN) oppure svuotato ---------------

function affollaProc(t, quanti = 400) {
  const rd = fs.readFileSync;
  const ls = fs.readdirSync;
  const sintetici = [];
  for (let i = 0; i < quanti; i += 1) sintetici.push(String(4194000 + i));
  const insieme = new Set(sintetici);
  fs.readdirSync = (p, ...a) => (p === '/proc' ? ls(p, ...a).concat(sintetici) : ls(p, ...a));
  fs.readFileSync = (p, ...a) => {
    const m = /^\/proc\/([0-9]+)\/stat$/.exec(p);
    if (m && insieme.has(m[1])) return `${m[1]} (syn) S 1 ${m[1]} 1 0 0 -1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0\n`;
    return rd(p, ...a);
  };
  t.after(() => { fs.readFileSync = rd; fs.readdirSync = ls; });
}

function svuotaProc(t) {
  const ls = fs.readdirSync;
  fs.readdirSync = (p, ...a) => (p === '/proc' ? [] : ls(p, ...a));
  t.after(() => { fs.readdirSync = ls; });
}

// --- mondo: runtime + lease REALE + tmux finto scriptato -------------------

function creaMondo(t, { faultIdentita = null, cfgExtra = null, attestaNuova = null, leggiStarttime = null, leggiIdentita = null, serverPid = 99999 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-att-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'CellaAtt'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json'); fs.writeFileSync(statoPath, '[]');
  const logPath = path.join(root, 'chiamate.log');
  const markerMorte = path.join(root, 'sessione-morta');
  const markerMuoriHas = path.join(root, 'muori-al-primo-has');
  const markerMuoriKill = path.join(root, 'muori-su-kill');
  const markerBloccaHas = path.join(root, 'blocca-has');
  const markerBloccaHasCli = path.join(root, 'blocca-has-cli');
  const markerRitardaHasCli = path.join(root, 'ritarda-has-cli');
  // Il «supervisore» e' un processo vero, staccato: gruppo proprio, cosi' il
  // censimento post-uscita non conta mai il processo del test.
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
const MUORI_HAS = ${JSON.stringify(markerMuoriHas)};
const MUORI_KILL = ${JSON.stringify(markerMuoriKill)};
const BLOCCA_HAS = ${JSON.stringify(markerBloccaHas)};
const BLOCCA_HAS_CLI = ${JSON.stringify(markerBloccaHasCli)};
const RITARDA_HAS_CLI = ${JSON.stringify(markerRitardaHasCli)};
const PANE_PID = ${paneChild.pid};
const SERVER_PID = String(${serverPid});
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
  // Il client -C e' attached alla sessione: se la sessione muore, esce.
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
      // consegna del prompt nel pane: servono gli assert «zero replay»
      if (/^(set-buffer|load-buffer|paste-buffer|send-keys)\\b/.test(riga)) nota('paste:' + riga.split(/\\s+/)[0]);
      // la sessione e' morta: il client attached esce senza rispondere
      if (fs.existsSync(MORTE)) process.exit(0);
      if (riga.startsWith('has-session') && fs.existsSync(MUORI_HAS)) process.exit(0);
      // silenzio sul has-session: il client resta vivo e non risponde (timeout)
      if (riga.startsWith('has-session') && fs.existsSync(BLOCCA_HAS)) continue;
      if (riga.startsWith('kill-session')) {
        nota(riga.split(/\\s+/).pop() ? 'kill-session:' + riga.split(/\\s+/).pop() : 'kill-session');
        scrivi(leggi().filter((x) => x.id !== ${JSON.stringify(SESSIONE)}));
        if (fs.existsSync(MUORI_KILL)) process.exit(0);
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
  // CLI muta, SOLO per le chiamate dirette (senza -S): il comando non risponde
  // mai e il timeout del chiamante lo uccide. La delega del client -C (con
  // -S) resta libera, cosi' il down arriva fino alla prova del recupero.
  if (fs.existsSync(BLOCCA_HAS_CLI) && !argv.includes('-S')) { setInterval(() => {}, 1 << 30); return; }
  if (fs.existsSync(RITARDA_HAS_CLI) && !argv.includes('-S')) {
    const ms = Number(fs.readFileSync(RITARDA_HAS_CLI, 'utf8')) || 0;
    const nome = bersaglio.startsWith('=') ? bersaglio.slice(1) : bersaglio;
    setTimeout(() => {
      process.stderr.write('can\\'t find session: ' + nome + '\\n');
      process.exit(1);
    }, ms);
    return;
  }
  if (leggi().some((x) => x.id === bersaglio)) process.exit(0);
  process.stderr.write('can\\'t find session: ' + bersaglio + '\\n');
  process.exit(1);
}
if (cmd(args) === 'display-message') {
  const iF = args.indexOf('-F');
  const fmt = (iF >= 0 ? args[iF + 1] : args[args.length - 1]) || '';
  if (fmt.includes('socket_path')) { process.stdout.write('/tmp/nc-fake/socket\\t4242\\n'); process.exit(0); }
  if (fmt.includes('pane_pid')) { process.stdout.write(SERVER_PID + '\\t' + PANE_PID + '\\n'); process.exit(0); }
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
    cells: [{ id: 'CellaAtt', tmuxSession: NOME, cwd, engine: 'eg', boot: false }],
  });
  let payloadLancio = null;
  const mgr = createLeaseManager({ home });
  // faultIdentita: seam che guasta la lettura dell'identita' SOLO per il pid
  // del supervisore (EACCES): la lettura ternaria deve restare «indeterminata»
  // e il recupero nella stessa down NON si completa su quella prova.
  const seamIdentita = typeof faultIdentita === 'function'
    ? (pid) => leggiIdentitaProc(pid, pid === paneChild.pid
      ? { leggiStat: faultIdentita } : undefined)
    : null;
  const runtime = createBuiltinRuntime({
    cfg: {
      launchReadyMs: 0, filesRoot, activityHooks: true, groupStopBudgetMs: 4000,
      ...(cfgExtra || {}),
    },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async (req) => { payloadLancio = req; return { socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }; },
      revoke: async () => {}, close: async () => {},
    },
    leaseManager: mgr,
    boot: loadDefinitions(defsPath),
    ...(seamIdentita ? { leggiIdentitaProc: seamIdentita } : {}),
    ...(typeof attestaNuova === 'function' ? { attestaAssenzaNuovaConnessione: attestaNuova } : {}),
    ...(typeof leggiStarttime === 'function' ? { leggiStarttimeProc: leggiStarttime } : {}),
    ...(typeof leggiIdentita === 'function' ? { leggiIdentitaProc: leggiIdentita } : {}),
  });
  t.after(() => {
    try { runtime.shutdown(); } catch (_) {}
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    try { mgr.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, filesRoot, mgr, runtime, paneChild,
    payloadLancio: () => payloadLancio,
    log: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
    sessioni: () => JSON.parse(fs.readFileSync(statoPath, 'utf8')),
    marker: {
      morte: markerMorte, muoriHas: markerMuoriHas, muoriKill: markerMuoriKill,
      bloccaHas: markerBloccaHas, bloccaHasCli: markerBloccaHasCli,
      ritardaHasCli: markerRitardaHasCli,
    },
    pulisciMarker: () => {
      for (const p of [markerMorte, markerMuoriHas, markerMuoriKill, markerBloccaHas, markerBloccaHasCli, markerRitardaHasCli]) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    },
  };
}

// Supervisore reale lato cella: lease client vero su un socket vero,
// coordinatore vero che esegue lo stop del gruppo. La morte programmata
// («la sessione muore col gruppo») e' a cura del test, dentro killGruppo.
function attaccaSupervisore(t, w, { uccidiSessione = true, bloccaHasDopoUscita = false, tieniLease = false, ritardoUscitaMs = 0 } = {}) {
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
          assert.equal(w.mgr.attachInitial('CellaAtt', serverSide, { generation: 0 }), true);
          let morto = false;
          const coord = gruppo.creaCoordinatore({
            token: control.token, launchId: control.launchId,
            monoNow: () => Number(process.hrtime.bigint() / 1000000n),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            killGruppo: (sig) => {
              if (sig !== 'SIGTERM' || morto) return;
              morto = true;
              const chiudi = () => {
                try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
                if (bloccaHasDopoUscita) {
                  // il canale resta vivo ma smette di rispondere a has-session
                  // dopo l'uscita provata del supervisore: il comando va in
                  // timeout e la sua mancata risposta NON puo' valere assenza
                  try { fs.writeFileSync(w.marker.bloccaHas, '1'); } catch (_) {}
                }
                if (uccidiSessione) {
                  // la sessione muore col gruppo: il client -C attached esce
                  fs.writeFileSync(path.join(w.root, 'sessions.json'), '[]');
                  try { fs.writeFileSync(w.marker.morte, '1'); } catch (_) {}
                }
              };
              if (ritardoUscitaMs > 0) { setTimeout(chiudi, ritardoUscitaMs); return; }
              chiudi();
            },
            osserva: () => {
              if (!morto) return { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' };
              if (ritardoUscitaMs > 0) {
                try { process.kill(w.paneChild.pid, 0); return { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }; }
                catch (_) { return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }; }
              }
              return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };
            },
            invia: (frame) => leaseCtl.sendControl(frame),
            svuota: async () => {
              await leaseCtl.svuota();
              // tieniLease: il lease client NON si chiude alla fine dello stop,
              // cosi' il lease della cella resta live e la prova (3) del
              // recupero nella stessa down non si completa.
              if (!tieniLease) { try { clientSide.end(); } catch (_) {} }
            },
            cancellaDelivery: async () => null,
            scriviLog: () => {},
            dichiaraStopping: () => {},
            disarmaLegacy: () => {},
            installaIgnoraTerm: () => {},
          });
          // contatore dei comandi stop ricevuti dal supervisore: gli assert
          // «zero doppio stop» del recupero nella stessa down lo interrogano
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

// --- cablaggio del seam numerico verso l'attestazione ----------------------

test('cablaggio: l\'attestazione identifica il server in forma TERNARIA e si ferma al socket', async (t) => {
  // Si inietta SOLO il lettore ternario: la funzione di attestazione e' quella
  // vera. La morte dell'incarnazione si decide proprio su quella lettura, che
  // deve distinguere «assente» da «illeggibile».
  const chiamate = [];
  const w = creaMondo(t, {
    serverPid: process.pid,
    leggiIdentita: (pid) => { chiamate.push(pid); return leggiIdentitaProc(pid); },
  });
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  fs.writeFileSync(w.marker.bloccaHasCli, '1');
  const err = await w.runtime.down('CellaAtt').then(() => null, (e) => e);
  assert.ok(err, 'il down doveva rifiutare');
  assert.equal(err.fleetCode, 'STOP_UNKNOWN');
  assert.ok(chiamate.includes(process.pid),
    'il server del lancio deve essere identificato in forma ternaria');
  assert.equal(err.data.attestazione, 'socket',
    'server vivo e socket assente: ci si ferma al socket, non sull\'identita\'');
});

test('morte provata dell\'incarnazione del server: il down chiude nella stessa chiamata', async (t) => {
  // Il server registrato al lancio e' questo processo, che il seam dichiara
  // ASSENTE: incarnazione finita, quindi la sua sessione non esiste piu'.
  const w = creaMondo(t, {
    serverPid: process.pid,
    leggiIdentita: (pid) => (pid === process.pid
      ? { esito: 'assente', nascita: null }
      : leggiIdentitaProc(pid)),
  });
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  fs.writeFileSync(w.marker.bloccaHasCli, '1');
  const esito = await w.runtime.down('CellaAtt');
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'attested-exit');
  assert.equal(esito.killed, true, 'il teardown era partito');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
});

test('la morte del server non chiude un lancio cambiato durante l\'attesa', async (t) => {
  let w = null;
  const w2 = creaMondo(t, {
    attestaNuova: async () => {
      // Durante l'attesa il record viene sostituito da un lancio NUOVO: la
      // morte del server vecchio non autorizza a chiuderlo.
      const rec = launchTarget.leggi(w.filesRoot, NOME).record;
      launchTarget.registra(w.filesRoot, NOME, {
        launchId: 'abcdef0123456789',
        sessionId: rec.sessionId,
        paneId: rec.paneId,
        tmuxSocket: rec.tmuxSocket,
        serverPid: rec.serverPid,
        panePid: rec.panePid,
        paneStarttime: rec.paneStarttime,
        family: rec.family,
      });
      return { attestato: true, motivo: 'incarnazione-morta' };
    },
  });
  w = w2;
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  fs.writeFileSync(w.marker.bloccaHasCli, '1');
  const err = await w.runtime.down('CellaAtt').then(() => null, (e) => e);
  assert.ok(err, 'il down doveva rifiutare');
  assert.equal(err.fleetCode, 'IDENTITY_UNVERIFIED');
  assert.match(err.message, /identita' del lancio e' cambiata/);
  const dopo = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(dopo.stato, 'presente', 'il record del lancio nuovo non si tocca');
  assert.notEqual(dopo.record && dopo.record.incerto, true,
    'l\'incertezza del lancio vecchio non deve finire sul lancio nuovo');
});

// --- (a) /proc affollato: recupero NELLA STESSA down (uscita provata) -------

test('down su /proc affollato: uscita provata + client morto con la sessione NON attesta, ma le tre prove chiude NELLA STESSA down (attested-recovery) e l up dopo riesce', async (t) => {
  const w = creaMondo(t);
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  assert.equal(gruppo.leggiPgrp(w.paneChild.pid), w.paneChild.pid, 'il supervisore finto deve stare in un gruppo proprio');
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  // Primo down: il supervisore esce provato e la sessione muore con lui; il
  // client muore con la sessione e la sua morte da sola non attesta (EOF,
  // timeout e sostituzione sono indistinguibili) e il censimento affollato
  // non dichiara. L'uscita PROVATA apre il recupero a tre prove NELLA STESSA
  // down: sessione assente dal verdetto CLI, supervisore morto accertato
  // (ENOENT), lease non live — poi barriera host (not-vl qui), record via.
  const recupero = await w.runtime.down('CellaAtt');
  assert.equal(recupero.ok, true);
  assert.equal(recupero.outcome, 'attested-recovery');
  // Con l'osservazione post-uscita a sonda (kill(-pgrp, 0)) il censimento non
  // dipende piu' dal numero di voci estranee: il gruppo risulta vuoto, il down
  // arriva al teardown e il comando kill-session parte. La risposta si perde
  // con il client morto, quindi il recupero chiude nella stessa down e
  // `killed` resta true — il comando era partito.
  assert.equal(recupero.killed, true);
  assert.equal(recupero.host, 'not-vl');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(w.sessioni().length, 0);
  // zero teardown nuovi e zero doppio stop: nessun kill-session oltre a
  // quello che non e' mai partito, UN SOLO comando stop al supervisore
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1, 'il comando stop al supervisore e\' stato inviato una volta sola');
  // zero replay del prompt: nessuna consegna di buffer durante il down
  assert.equal(w.log().filter((r) => r.startsWith('paste:')).length, 0);
  // il lancio successivo non e' bloccato: nessun incerto residuo
  w.pulisciMarker();
  const secondo = await w.runtime.up('CellaAtt');
  assert.equal(secondo.ok, true);
  assert.equal(w.sessioni().length, 1);
});

// --- (b) risposta del teardown persa: uscita provata + tre prove chiudono ---

test('down con censimento pulito e risposta persa: uscita provata + kill partito, le tre prove chiudono NELLA STESSA down (attested-recovery, killed)', async (t) => {
  const w = creaMondo(t);
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  fs.writeFileSync(w.marker.muoriKill, '1');
  await w.runtime.up('CellaAtt');
  // la sessione NON muore col gruppo (window rimasta): il censimento pulito
  // (qui: /proc svuotato) NON attesta la sessione, il kill parte e la
  // risposta si perde con il canale. L'uscita del supervisore e' PROVATA e
  // le tre prove in lettura (sessione assente dal verdetto CLI dopo il kill,
  // supervisore morto, lease non live) chiudono il lancio nella stessa down:
  // killed resta true perche' il comando era gia' partito, senza comandi nuovi.
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: false });
  assert.ok(sup);
  svuotaProc(t);
  const esito = await w.runtime.down('CellaAtt');
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'attested-recovery');
  assert.equal(esito.killed, true);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(sup.conta.stop, 1, 'un solo comando stop al supervisore');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 1, 'un solo kill-session');
  assert.equal(w.log().filter((r) => r.startsWith('paste:')).length, 0, 'zero replay del prompt');
  // il lancio successivo non e' bloccato
  w.pulisciMarker();
  const secondo = await w.runtime.up('CellaAtt');
  assert.equal(secondo.ok, true);
});

// --- (b) negativo: canale morto alla verifica senza supervisore -----------

test('down con canale morto alla verifica e nessuna prova possibile: resta STOP_UNKNOWN, nessuno sblocco cieco', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  fs.writeFileSync(w.marker.muoriHas, '1');
  await w.runtime.up('CellaAtt');
  // il supervisore e' gia' andato (nessuna uscita provabile, canale morto)
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  sup.spegni();
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === 'STOP_UNKNOWN' && /durante la verifica/.test(e.message),
  );
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'presente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
});

// --- (b) client morto PRIMA della verifica: uscita provata, recupero qui ---

test('down con client morto alla verifica (uscita provata, censimento non dichiarabile): la morte del client non attesta, le tre prove chiudono NELLA STESSA down', async (t) => {
  const w = creaMondo(t);
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  fs.writeFileSync(w.marker.muoriHas, '1');
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  // Il client muore alla prima verifica della sessione; il gruppo esce
  // provato nel valutaGruppo, ma senza verdetto di has-session l'assenza non
  // e' attestabile e la morte del client non basta. L'uscita PROVATA apre il
  // recupero a tre prove nella stessa down: attested-recovery, zero kill.
  const recupero = await w.runtime.down('CellaAtt');
  assert.equal(recupero.ok, true);
  assert.equal(recupero.outcome, 'attested-recovery');
  assert.equal(recupero.killed, false);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(w.sessioni().length, 0);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1, 'un solo comando stop al supervisore');
  w.pulisciMarker();
  const secondo = await w.runtime.up('CellaAtt');
  assert.equal(secondo.ok, true);
});

// --- (b) negativo: timeout del has-session dopo l'uscita, sessione viva -----

test('down con has-session in timeout dopo l uscita provata e sessione ancora viva: nessun esito pulito, resta STOP_UNKNOWN', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  // il supervisore esce provato ma la sessione NON muore con lui, e il
  // canale smette di rispondere a has-session: il timeout non e' l'assenza
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: false, bloccaHasDopoUscita: true });
  assert.ok(sup);
  affollaProc(t);
  // Il has-session sul canale tace: il suo timeout consuma il budget e il
  // censimento di fallback NON dichiara la chiusura. Resta un rifiuto della
  // famiglia dello stop non dimostrato — mai un esito pulito senza prova.
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => (e.fleetCode === 'STOP_UNKNOWN' || e.fleetCode === 'STOP_INCOMPLETE')
      && /stop del gruppo stop-(unknown|incomplete)/.test(e.message),
  );
  const record = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(record.stato, 'presente');
  assert.equal(record.record.incerto, true);
  // la sessione e' ANCORA VIVA: nessuna chiusura, nessun kill
  assert.equal(w.sessioni().length, 1);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  // l'up resta bloccato dall'incertezza: nessuno sblocco cieco
  await assert.rejects(() => w.runtime.up('CellaAtt'), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
});

// --- (c) negativi del recupero NELLA STESSA down: una prova che manca ------

test('recupero nella stessa down con /proc EACCES sul supervisore: indeterminata non e\' una prova, resta un esito non pulito e il record resta', async (t) => {
  const errEaces = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  const w = creaMondo(t, { faultIdentita: errEaces });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  // il supervisore esce provato e la sessione muore con lui, ma la lettura
  // dell'identita' e' guastata in EACCES: la prova (2) del recupero NON si
  // completa (indeterminata), l'esito resta non pulito e il record resta.
  // Il censimento puo' vedere 0 o 1 residui: solo questi due esiti.
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => (e.fleetCode === 'STOP_UNKNOWN' || e.fleetCode === 'STOP_INCOMPLETE')
      && /stop del gruppo stop-(unknown|incomplete)/.test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1, 'il comando stop era partito una volta sola: nessun doppio stop');
  await assert.rejects(() => w.runtime.up('CellaAtt'), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
});

// Censimento forzato, stessa lettura EACCES: 0 residui e' STOP_UNKNOWN, 1 e'
// STOP_INCOMPLETE. Nient'altro e' ammesso, e in entrambi il record resta.
const eaccesConCensimento = async (t, inGruppo, codice) => {
  const errEaces = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  const w = creaMondo(t, { faultIdentita: errEaces });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  w.mgr.osservaGruppo = () => ({ inGruppo, fuoriGruppo: 0, qualita: 'almeno' });
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === codice && new RegExp(`stop del gruppo ${codice === 'STOP_INCOMPLETE' ? 'stop-incomplete' : 'stop-unknown'}`).test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1);
  await assert.rejects(() => w.runtime.up('CellaAtt'), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
};

test('recupero EACCES con censimento 0: esattamente STOP_UNKNOWN, record incerto, up rifiutato', (t) => eaccesConCensimento(t, 0, 'STOP_UNKNOWN'));

test('recupero EACCES con censimento 1: esattamente STOP_INCOMPLETE, record incerto, up rifiutato', (t) => eaccesConCensimento(t, 1, 'STOP_INCOMPLETE'));

test('recupero nella stessa down con has-session CLI in timeout: il timeout non e\' una prova, resta STOP_UNKNOWN; il down successivo senza canale chiude resolved-dead', async (t) => {
  const w = creaMondo(t);
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  // il CLI has-session per nome resta muto (solo chiamate dirette): lo stop
  // arriva al supervisore, l'uscita e' provata, il canale muore con la
  // sessione, ma la lettura CLI non risponde e la sua mancata risposta NON
  // vale assenza (prova 1 mancante): il recupero nella stessa down non
  // chiude e il rifiuto resta quello del giudizio del gruppo.
  fs.writeFileSync(w.marker.bloccaHasCli, '1');
  // Con la sonda il censimento del gruppo dichiara il vuoto anche con /proc
  // affollato: il rifiuto non nasce piu' dal giudizio del gruppo ma dal
  // teardown, il cui comando parte e la cui risposta si perde con il client
  // morto. Stesso codice (STOP_UNKNOWN), stesso record trattenuto, stessa
  // assenza di prove: cambia solo il punto in cui la catena si ferma.
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === 'STOP_UNKNOWN'
      && /down non dichiarabile.*connessione di controllo persa/.test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true, 'uscita provata ma prove incomplete: guardia incerta marcata');
  assert.equal(w.sessioni().length, 0);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  // esiti DISTINTI: senza il guasto, il down successivo (senza canale) chiude
  // col resolved-dead delle tre prove — non resta un secondo attested.
  sup.spegni();
  try { fs.unlinkSync(w.marker.bloccaHasCli); } catch (_) { /* gia' assente */ }
  const recupero = await w.runtime.down('CellaAtt');
  assert.equal(recupero.ok, true);
  assert.equal(recupero.outcome, 'resolved-dead');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
});

// --- B: risposta del teardown persa, verdetto di sola lettura ---------------

test('risposta del teardown persa + stessa istanza + sessione assente: il down chiude nella stessa chiamata', async (t) => {
  const visti = [];
  const w = creaMondo(t, {
    attestaNuova: async (opts) => { visti.push(opts); return { attestato: true, motivo: 'assente' }; },
  });
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  // Il verdetto CLI del recupero resta muto: senza la connessione nuova il
  // down non potrebbe chiudere. Con essa chiude NELLA STESSA chiamata.
  fs.writeFileSync(w.marker.bloccaHasCli, '1');
  const esito = await w.runtime.down('CellaAtt');
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'attested-exit');
  assert.equal(esito.killed, true, 'il comando di teardown era partito');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(visti.length, 1, 'una sola connessione di attestazione');
  // Binding: id esatto della sessione, incarnazione del server del lancio e
  // deadline della stessa down — nessuna risoluzione per nome.
  assert.equal(visti[0].sessionId, SESSIONE);
  assert.equal(visti[0].serverPid, 99999, 'il pid del server registrato al lancio');
  assert.ok(Number.isFinite(visti[0].deadlineAt));
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0,
    'nessun comando distruttivo sulla connessione nuova');
});

test('risposta del teardown persa + connessione nuova che NON attesta: resta STOP_UNKNOWN', async (t) => {
  const w = creaMondo(t, {
    attestaNuova: async () => ({ attestato: false, motivo: 'presente' }),
  });
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  fs.writeFileSync(w.marker.bloccaHasCli, '1');
  const err = await w.runtime.down('CellaAtt').then(() => null, (e) => e);
  assert.ok(err, 'il down doveva rifiutare');
  assert.equal(err.fleetCode, 'STOP_UNKNOWN');
  assert.match(err.message, /down non dichiarabile.*connessione di controllo persa/);
  // Il rifiuto deve dire PERCHE': esito del giudizio, conti e motivo
  // dell'attestazione di sola lettura. Senza, una E2E rossa non si legge.
  assert.ok(err.data, 'manca data nel rifiuto');
  assert.equal(err.data.outcome, 'killed-clean');
  assert.deepEqual(err.data.conti, { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' });
  assert.equal(err.data.attestazione, 'presente');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'presente');
});

test('recupero nella stessa down con lease ancora live: la prova (3) manca, resta STOP_UNKNOWN e il record resta', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  // tieniLease: il lease client NON si chiude con lo stop, il lease della
  // cella resta live anche a supervisore morto: la prova (3) del recupero
  // non si completa e il lancio non si dichiara chiuso nella stessa down.
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true, tieniLease: true });
  assert.ok(sup);
  affollaProc(t);
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === 'STOP_UNKNOWN' && /stop del gruppo stop-unknown/.test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(w.sessioni().length, 0);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  await assert.rejects(() => w.runtime.up('CellaAtt'), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
});

// --- deadline unica: il recupero non chiude dopo la scadenza ---------------

test('recupero nella stessa down entro il budget con clock fermo: attested-recovery', async (t) => {
  const w = creaMondo(t, { cfgExtra: { monotonicNow: () => 0, groupStopBudgetMs: 4000 } });
  graceScaduta(w);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  const recupero = await w.runtime.down('CellaAtt');
  assert.equal(recupero.ok, true);
  assert.equal(recupero.outcome, 'attested-recovery');
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1);
});

test('recupero nella stessa down: il terzo riscontro a 4500 non chiude, record e guardia restano', async (t) => {
  const tempo = { t: 0, armato: false };
  const w = creaMondo(t, {
    cfgExtra: { monotonicNow: () => tempo.t, groupStopBudgetMs: 4000 },
    faultIdentita: () => {
      tempo.armato = true;
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    },
  });
  const stato = w.mgr.status.bind(w.mgr);
  w.mgr.status = (id) => {
    if (tempo.armato) tempo.t = 4500;
    return stato(id);
  };
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  let revoke = 0;
  const revoca = w.mgr.revokeControl.bind(w.mgr);
  w.mgr.revokeControl = (id) => { revoke += 1; return revoca(id); };
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === 'STOP_UNKNOWN',
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(revoke, 0);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1);
  assert.equal(tempo.t, 4500);
});

test('recupero nella stessa down: uscita a 1100 ms e lettura a 1500 ms oltre il budget 2000 non chiudono', async (t) => {
  const w = creaMondo(t, { cfgExtra: { groupStopBudgetMs: 2000 } });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  await w.runtime.up('CellaAtt');
  fs.writeFileSync(w.marker.ritardaHasCli, '1500');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true, ritardoUscitaMs: 1100 });
  assert.ok(sup);
  affollaProc(t);
  const t0 = Date.now();
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === 'STOP_UNKNOWN',
  );
  const dt = Date.now() - t0;
  assert.ok(dt >= 2000, `il down deve sforare il budget, misurato ${dt} ms`);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  assert.equal(sup.conta.stop, 1);
});
