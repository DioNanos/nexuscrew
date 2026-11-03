'use strict';
// Sblocco del record di un lancio OSSERVABILMENTE MORTO nel down, quando il
// canale di controllo e' assente (NC riavviato, canale perso): la chiusura
// del record e' concessa SOLO alla congiunzione di tre prove in lettura —
// sessione assente per nome sul server condiviso, supervisore morto E
// provato con la lettura TERNARIA dell'identita' (assenza ACCERTATA via
// ENOENT, oppure pid riusato con nascita valida divergente da quella
// REGISTRATA nel record; EACCES/EIO/stat malformato sono «indeterminata» e
// NON sono prove), lease non live. Manca una prova qualsiasi: il 409 di
// oggi resta, record intatto, zero azioni. Nessun kill in nessun caso: la
// verifica e' tutta in lettura.
// Il «supervisore» e' un processo vero staccato del test (ucciso SOLO per
// PID esatto); tmux e' finto e scriptato con has-session per NOME; il lease
// e' reale dove serve e stubbato solo per la prova «lease live».

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite, loadDefinitions, leggiStarttimeProc, leggiIdentitaProc } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = '$7';
const NOME = 'nc-s3-prova';
const CELLA = 'CellaS3';

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

// --- unit: il campo paneStarttime del record e' additivo e validato -------

test('record: paneStarttime round-trip, assente nei record vecchi, preservato dal marker incerto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s3-rec-'));
  try {
    const launchId = hexId();
    assert.equal(launchTarget.registra(root, NOME, {
      launchId, sessionId: SESSIONE, paneId: '%7', tmuxSocket: '/tmp/tmux-1000/default',
      serverPid: 4242, panePid: 4243, paneStarttime: 1234567, family: 'other',
    }), true);
    let letto = launchTarget.leggi(root, NOME);
    assert.equal(letto.stato, 'presente');
    assert.equal(letto.record.paneStarttime, 1234567);
    // il marker incerto riscrive il record preservando il campo
    assert.equal(launchTarget.marcaIncerto(root, NOME), true);
    letto = launchTarget.leggi(root, NOME);
    assert.equal(letto.record.paneStarttime, 1234567);
    assert.equal(letto.record.incerto, true);
    // record «vecchio»: senza paneStarttime la lettura da' null, non un numero
    const raw = JSON.parse(fs.readFileSync(path.join(root, launchTarget.DIR, `${NOME}.json`), 'utf8'));
    delete raw.paneStarttime;
    fs.writeFileSync(path.join(root, launchTarget.DIR, `${NOME}.json`), `${JSON.stringify(raw)}\n`);
    letto = launchTarget.leggi(root, NOME);
    assert.equal(letto.record.paneStarttime, null);
    // un non-numero e' rifiutato dal validator: nessuna nascita fasulla
    assert.equal(launchTarget.registra(root, NOME, {
      launchId: hexId(), sessionId: SESSIONE, paneId: '%7',
      panePid: 4243, paneStarttime: '123', family: 'other',
    }), true);
    assert.equal(launchTarget.leggi(root, NOME).record.paneStarttime, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- mondo: runtime + tmux finto per nome + supervisore vero ---------------

function creaMondo(t, { leaseManager = null, omonima = false, faultStatSupervisore = null, cfgExtra = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s3-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, CELLA); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json');
  fs.writeFileSync(statoPath, omonima
    ? JSON.stringify([{ nome: NOME, id: SESSIONE, w: '@7', p: '%7' }])
    : '[]');
  const logPath = path.join(root, 'chiamate.log');
  // Il «supervisore» e' un processo vero, staccato: la sua nascita in /proc
  // e' quella vera, e la sua morte si provoca SOLO per PID esatto.
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
const NOME = ${JSON.stringify(NOME)};
const SESSIONE = ${JSON.stringify(SESSIONE)};
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
  const poll = setInterval(() => { if (!sessioneViva()) process.exit(0); }, 10);
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
  const s = { nome, id: SESSIONE, w: '@7', p: '%7' };
  scrivi(leggi().concat([s]));
  nota('new-session:' + nome);
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
if (cmd(args) === 'list-sessions') {
  for (const s of leggi()) process.stdout.write(s.nome + '\\t1\\n');
  process.exit(0);
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
  const mgr = leaseManager || createLeaseManager({ home });
  // faultStatSupervisore: seam che guasta la lettura dello stat SOLO per il
  // pid del supervisore (EACCES, EIO, stat malformato) — gli altri pid si
  // leggono per davvero. E' la controprova dell'audit: senza lettura ternaria
  // un qualunque errore di lettura veniva promosso a morte provata.
  const leggiIdentitaSeam = typeof faultStatSupervisore === 'function'
    ? (pid) => leggiIdentitaProc(pid, pid === paneChild.pid
      ? { leggiStat: faultStatSupervisore } : undefined)
    : undefined;
  const runtime = createBuiltinRuntime({
    cfg: {
      launchReadyMs: 0, filesRoot, activityHooks: true, groupStopBudgetMs: 4000,
      ...(cfgExtra || {}),
    },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {}, close: async () => {},
    },
    leaseManager: mgr,
    boot: loadDefinitions(defsPath),
    ...(leggiIdentitaSeam ? { leggiIdentitaProc: leggiIdentitaSeam } : {}),
  });
  t.after(() => {
    try { runtime.shutdown(); } catch (_) {}
    try { process.kill(paneChild.pid, 'SIGKILL'); } catch (_) {}
    if (!leaseManager) { try { mgr.close(); } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, filesRoot, mgr, runtime, paneChild,
    // Il log nasce alla prima chiamata notevole di tmux: se il down non ha
    // toccato tmux (rifiuto cieco), resta assente e si legge come vuoto.
    log: () => {
      try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; }
    },
    uccidiSupervisore: async () => {
      const pid = paneChild.pid;
      const nascita = leggiStarttimeProc(pid);
      process.kill(pid, 'SIGKILL');
      await attendi(() => leggiStarttimeProc(pid) === null);
      return { pid, nascita };
    },
  };
}

// Semina il record come lo avrebbe lasciato un NC precedente: launchId e
// nascita veri, marker incerto (lo scenario del recovery).
function seminaRecord(w, { pid, nascita, senzaNascita = false } = {}) {
  const launchId = hexId();
  assert.equal(launchTarget.registra(w.filesRoot, NOME, {
    launchId, sessionId: SESSIONE, paneId: '%7', tmuxSocket: '/tmp/tmux-1000/default',
    serverPid: 4242, panePid: pid, ...(senzaNascita ? {} : { paneStarttime: nascita }),
    family: 'other',
  }), true, 'semina del record fallita');
  assert.equal(launchTarget.marcaIncerto(w.filesRoot, NOME), true);
  return launchId;
}

const rifiutaIdentita = (e) => e.status === 409
  && e.fleetCode === 'IDENTITY_UNVERIFIED'
  && /nessuna connessione di controllo posseduta dal lancio/.test(e.message);

// --- (1) positivo: tre prove -> record chiuso, up successivo accettato ----

test('down senza canale con tre prove complete: resolved-dead, record chiuso e up dopo accettato', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const { pid, nascita } = await w.uccidiSupervisore();
  seminaRecord(w, { pid, nascita });
  // il canale non esiste in questo processo: e' lo scenario «NC riavviato»
  const esito = await w.runtime.down(CELLA);
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'resolved-dead');
  assert.equal(esito.killed, false);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
  // il lancio successivo non e' bloccato dal record residuo
  const dopo = await w.runtime.up(CELLA);
  assert.equal(dopo.ok, true);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'presente');
});

// --- (2) negativo: sessione omonima viva (prova 1 mancante) ---------------

test('down senza canale con sessione omonima viva: resta 409, record intatto, nessuna azione', async (t) => {
  const w = creaMondo(t, { omonima: true });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const { pid, nascita } = await w.uccidiSupervisore();
  seminaRecord(w, { pid, nascita });
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
});

// --- (3) negativo: supervisore vivo con la stessa nascita (prova 2) --------

test('down senza canale con supervisore vivo e nascita identica: resta 409, record intatto', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const pid = w.paneChild.pid;
  const nascita = leggiStarttimeProc(pid);
  assert.ok(Number.isFinite(nascita), 'nascita del supervisore vivo non leggibile');
  seminaRecord(w, { pid, nascita });
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
});

// --- (4) negativo: lease live (prova 3 mancante) ---------------------------

test('down senza canale con lease live: resta 409, record intatto', async (t) => {
  const w = creaMondo(t, { leaseManager: { status: () => ({ state: 'live' }) } });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const { pid, nascita } = await w.uccidiSupervisore();
  seminaRecord(w, { pid, nascita });
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
});

// --- (5) negativo: record vecchio senza paneStarttime ----------------------

test('down senza canale con record vecchio senza nascita: nessuno sblocco col solo pid', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const { pid, nascita } = await w.uccidiSupervisore();
  seminaRecord(w, { pid, nascita, senzaNascita: true });
  const letto0 = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto0.record.paneStarttime, null, 'il record seminato deve essere senza nascita');
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'presente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
});

// --- (6) negativo: pid riuso (nascita diversa) MA sessione presente --------

test('down senza canale con nascita divergente ma sessione presente: nessuno sblocco', async (t) => {
  const w = creaMondo(t, { omonima: true });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  // il numero di pid e' occupato da UN ALTRO processo (qui: il test stesso),
  // la nascita registrata diverge: il supervisore registrato e' provato
  // morto, MA la sessione omonima viva blocca comunque lo sblocco.
  const pid = process.pid;
  const nascitaAltro = leggiStarttimeProc(pid) + 1000;
  seminaRecord(w, { pid, nascita: nascitaAltro });
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
});

// --- (7..9) negativi: lettura /proc guasta -> indeterminata, non una prova --

const errConCodice = (code) => { const e = new Error(code); e.code = code; return e; };

// In questi tre negativi il supervisore e' DAVVERO morto (senza fault il
// recupero chiuderebbe con resolved-dead), e la lettura del suo stat e'
// guastata nel modo indicato: la congiunzione delle tre prove NON si
// completa e il record non si tocca. E' la controprova dell'audit: prima
// della lettura ternaria un errore di lettura qualsiasi valeva «morto
// provato» e il record veniva rimosso.
const letturaGuastaNonProva = async (t, faultStat, motivo) => {
  const w = creaMondo(t, { faultStatSupervisore: faultStat });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const { pid, nascita } = await w.uccidiSupervisore();
  seminaRecord(w, { pid, nascita });
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente', motivo);
  assert.equal(letto.record.incerto, true, motivo);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0, motivo);
};

test('down senza canale con /proc EACCES sul supervisore: indeterminata non e\' una prova, resta 409', (t) => letturaGuastaNonProva(
  t, () => { throw errConCodice('EACCES'); }, 'EACCES',
));

test('down senza canale con /proc EIO sul supervisore: indeterminata non e\' una prova, resta 409', (t) => letturaGuastaNonProva(
  t, () => { throw errConCodice('EIO'); }, 'EIO',
));

test('down senza canale con stat malformato del supervisore: indeterminata non e\' una prova, resta 409', (t) => letturaGuastaNonProva(
  t, () => 'stat rotto senza parentesi ne\' campi', 'stat malformato',
));

// I due payload del referto, sul processo ANCORA VIVO: uno stat di 28 zeri
// senza parentesi, e uno stat reale col token starttime svuotato. Nessuno dei
// due e' morte. Il record e la guardia restano, il processo resta quello
// stesso, il lease non si revoca.
const statVivoNonProva = async (t, faultStat, motivo) => {
  const w = creaMondo(t, { faultStatSupervisore: faultStat });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const pid = w.paneChild.pid;
  const nascita = leggiStarttimeProc(pid);
  assert.ok(Number.isFinite(nascita), motivo);
  seminaRecord(w, { pid, nascita });
  let revoke = 0;
  const revoca = w.mgr.revokeControl.bind(w.mgr);
  w.mgr.revokeControl = (id) => { revoke += 1; return revoca(id); };
  await assert.rejects(() => w.runtime.down(CELLA), rifiutaIdentita);
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente', motivo);
  assert.equal(letto.record.incerto, true, motivo);
  assert.equal(revoke, 0, motivo);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0, motivo);
  assert.doesNotThrow(() => { process.kill(pid, 0); }, motivo);
  assert.equal(leggiStarttimeProc(pid), nascita, motivo);
};

test('down senza canale con 28 zeri senza parentesi: processo vivo, record e guardia restano, nessun revoke', (t) => statVivoNonProva(
  t, () => Array(28).fill('0').join(' '), '28 zeri',
));

test('down senza canale con starttime svuotato: processo vivo, record e guardia restano, nessun revoke', (t) => statVivoNonProva(
  t, () => '4242 (nome con spazio) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0  0 0\n', 'starttime vuoto',
));

// --- (10) positivo: pid riusato con nascita valida divergente ---------------

test('down senza canale oltre la deadline: il record resta, nessun revoke', async (t) => {
  const tempo = { t: 0 };
  const w = creaMondo(t, {
    cfgExtra: { monotonicNow: () => tempo.t, groupStopBudgetMs: 4000 },
    faultStatSupervisore: () => {
      tempo.t = 4500;
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    },
  });
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const { pid, nascita } = await w.uccidiSupervisore();
  seminaRecord(w, { pid, nascita });
  let revoke = 0;
  const revoca = w.mgr.revokeControl.bind(w.mgr);
  w.mgr.revokeControl = (id) => { revoke += 1; return revoca(id); };
  await assert.rejects(
    () => w.runtime.down(CELLA),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED' && /budget scaduto/.test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
  assert.equal(revoke, 0);
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
  assert.equal(tempo.t, 4500);
});

test('down senza canale con pid riusato (nascita valida divergente): morte provata, resolved-dead', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  // il numero e' occupato da UN ALTRO processo vivo (il test stesso): la
  // lettura ternaria dice «presente» con nascita diversa da quella REGISTRATA
  // — il supervisore di quel record non esiste piu', e' morte provata.
  const pid = process.pid;
  const nascitaAltro = leggiStarttimeProc(pid) + 1000;
  seminaRecord(w, { pid, nascita: nascitaAltro });
  const esito = await w.runtime.down(CELLA);
  assert.equal(esito.ok, true);
  assert.equal(esito.outcome, 'resolved-dead');
  assert.equal(esito.killed, false);
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
  assert.equal(w.log().filter((r) => r.startsWith('kill-session')).length, 0);
});
