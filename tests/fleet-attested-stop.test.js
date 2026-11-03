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
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const gruppo = require('../lib/fleet/group-stop.js');

const SESSIONE = '$7';
const NOME = 'nc-att-prova';

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

function creaMondo(t) {
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
      // la sessione e' morta: il client attached esce senza rispondere
      if (fs.existsSync(MORTE)) process.exit(0);
      if (riga.startsWith('has-session') && fs.existsSync(MUORI_HAS)) process.exit(0);
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
    cells: [{ id: 'CellaAtt', tmuxSession: NOME, cwd, engine: 'eg', boot: false }],
  });
  let payloadLancio = null;
  const mgr = createLeaseManager({ home });
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
    try { mgr.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, filesRoot, mgr, runtime, paneChild,
    payloadLancio: () => payloadLancio,
    log: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean),
    sessioni: () => JSON.parse(fs.readFileSync(statoPath, 'utf8')),
    marker: { morte: markerMorte, muoriHas: markerMuoriHas, muoriKill: markerMuoriKill },
    pulisciMarker: () => {
      for (const p of [markerMorte, markerMuoriHas, markerMuoriKill]) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    },
  };
}

// Supervisore reale lato cella: lease client vero su un socket vero,
// coordinatore vero che esegue lo stop del gruppo. La morte programmata
// («la sessione muore col gruppo») e' a cura del test, dentro killGruppo.
function attaccaSupervisore(t, w, { uccidiSessione = true } = {}) {
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
              try { process.kill(w.paneChild.pid, 'SIGKILL'); } catch (_) {}
              if (uccidiSessione) {
                // la sessione muore col gruppo: il client -C attached esce
                fs.writeFileSync(path.join(w.root, 'sessions.json'), '[]');
                try { fs.writeFileSync(w.marker.morte, '1'); } catch (_) {}
              }
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

// --- (a) positivo: /proc affollato, canale morto con la sessione ------------

test('down su /proc affollato: uscita provata + canale morto con la sessione = attested-exit, e l up dopo riesce', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  assert.equal(gruppo.leggiPgrp(w.paneChild.pid), w.paneChild.pid, 'il supervisore finto deve stare in un gruppo proprio');
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  const esito = await w.runtime.down('CellaAtt');
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'attested-exit');
  assert.equal(esito.killed, true);
  assert.equal(esito.host, 'not-vl');
  assert.equal(w.sessioni().length, 0);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session:')).length, 0);
  // il lancio successivo non e' bloccato: nessun incerto residuo
  w.pulisciMarker();
  const secondo = await w.runtime.up('CellaAtt');
  assert.equal(secondo.ok, true);
  assert.equal(w.sessioni().length, 1);
});

// --- (b) negativo: risposta del teardown persa senza attestazione ----------

test('down con censimento pulito ma risposta persa: senza prova sulla sessione resta STOP_UNKNOWN e l up e rifiutato', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  fs.writeFileSync(w.marker.muoriKill, '1');
  await w.runtime.up('CellaAtt');
  // la sessione NON muore col gruppo (window rimasta): l'attestazione e'
  // falsa e solo il censimento pulito (qui: /proc svuotato) puo' chiudere
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: false });
  assert.ok(sup);
  svuotaProc(t);
  await assert.rejects(
    () => w.runtime.down('CellaAtt'),
    (e) => e.fleetCode === 'STOP_UNKNOWN' && /dopo il comando di teardown/.test(e.message),
  );
  const record = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(record.stato, 'presente');
  assert.equal(record.record.incerto, true);
  await assert.rejects(() => w.runtime.up('CellaAtt'), (e) => e.status === 409 && e.fleetCode === 'STOP_UNKNOWN');
  assert.ok(w.log().some((r) => r.startsWith('kill-session:')));
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

// --- (a) positivo, secondo ramo: canale morto ALLA verifica, gruppo vivo --

test('down con canale morto alla verifica ma gruppo attestabile: attested-exit e l up dopo riesce', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  fs.writeFileSync(w.marker.muoriHas, '1');
  await w.runtime.up('CellaAtt');
  const sup = await attaccaSupervisore(t, w, { uccidiSessione: true });
  assert.ok(sup);
  affollaProc(t);
  const esito = await w.runtime.down('CellaAtt');
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'attested-exit');
  assert.equal(esito.killed, false);
  assert.equal(w.sessioni().length, 0);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  w.pulisciMarker();
  const secondo = await w.runtime.up('CellaAtt');
  assert.equal(secondo.ok, true);
});
