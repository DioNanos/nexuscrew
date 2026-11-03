'use strict';
// Prova (1) dello sblocco del record incerto: l'assenza della sessione si
// PROVA solo con l'esito che tmux produce per una sessione inesistente (exit
// 1 + «can't find session», o «no server running»). Un has-session in
// timeout, o che esce con uno stderr qualunque (errore di connessione,
// esecuzione fallita), NON e' una prova: il down resta rifiutato con il 409
// di identita' e il record resta intatto. Vale per provaLancioMorto (record
// presente, canale perso) e per il ramo «assente» del teardown, che prima
// trattava qualunque errore come «cella gia' ferma».
// Il «supervisore» e' un processo vero staccato del test (ucciso SOLO per
// PID esatto); tmux e' finto e scriptato: i marker forzano la lettura lenta
// (timeout) e quella con stderr fuorviante.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomicWrite, loadDefinitions, leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const launchTarget = require('../lib/fleet/launch-target.js');

const SESSIONE = '$7';
const NOME = 'nc-s4-assenza';
const CELLA = 'CellaS4a';

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

function creaMondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s4a-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, CELLA); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);
  const statoPath = path.join(root, 'sessions.json'); fs.writeFileSync(statoPath, '[]');
  const markerLenta = path.join(root, 'has-session-lenta');
  const markerSbagliata = path.join(root, 'has-session-sbagliata');
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
const LENTA = ${JSON.stringify(markerLenta)};
const SBAGLIATA = ${JSON.stringify(markerSbagliata)};
const leggi = () => { try { return JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch (_) { return []; } };
if (args[0] === 'has-session') {
  const bersaglio = args[args.length - 1];
  const nome = bersaglio.startsWith('=') ? bersaglio.slice(1) : bersaglio;
  if (leggi().some((x) => x.id === bersaglio || x.nome === nome)) process.exit(0);
  // lettura LENTA: il chiamante scade prima (timeout), nessun esito
  if (fs.existsSync(LENTA)) { setTimeout(() => process.exit(1), 8000); return; }
  // uscita 1 con uno stderr che NON e' il verdetto di sessione inesistente:
  // un errore di connessione non prova l'assenza
  if (fs.existsSync(SBAGLIATA)) {
    process.stderr.write('error connecting to /tmp/altrove/default (Permission denied)\\n');
    process.exit(1);
  }
  process.stderr.write('can\\'t find session: ' + nome + '\\n');
  process.exit(1);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'eg', label: 'G', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: CELLA, tmuxSession: NOME, cwd, engine: 'eg', boot: false }],
  });
  const mgr = createLeaseManager({ home });
  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true, groupStopBudgetMs: 4000 },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
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
    root, filesRoot, runtime, paneChild,
    marker: { lenta: markerLenta, sbagliata: markerSbagliata },
  };
}

function seminaRecordIncerto(w, { pid, nascita }) {
  assert.equal(launchTarget.registra(w.filesRoot, NOME, {
    launchId: hexId(), sessionId: SESSIONE, paneId: '%7', tmuxSocket: '/tmp/tmux-1000/default',
    serverPid: 4242, panePid: pid, paneStarttime: nascita, family: 'other',
  }), true, 'semina del record fallita');
  assert.equal(launchTarget.marcaIncerto(w.filesRoot, NOME), true);
}

test('has-session in timeout non prova l\'assenza: 409, record incerto intatto', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const nascita = leggiStarttimeProc(w.paneChild.pid);
  process.kill(w.paneChild.pid, 'SIGKILL');
  await attendi(() => leggiStarttimeProc(w.paneChild.pid) === null);
  seminaRecordIncerto(w, { pid: w.paneChild.pid, nascita });
  fs.writeFileSync(w.marker.lenta, '1');
  // le prove (2) e (3) tornano; SOLO la (1) e' una lettura scaduta
  await assert.rejects(
    () => w.runtime.down(CELLA),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED'
      && /nessuna connessione di controllo posseduta dal lancio/.test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
});

test('has-session con stderr fuorviante non prova l\'assenza: 409, record incerto intatto', async (t) => {
  const w = creaMondo(t);
  await attendi(() => { try { process.kill(w.paneChild.pid, 0); return true; } catch (_) { return false; } });
  const nascita = leggiStarttimeProc(w.paneChild.pid);
  process.kill(w.paneChild.pid, 'SIGKILL');
  await attendi(() => leggiStarttimeProc(w.paneChild.pid) === null);
  seminaRecordIncerto(w, { pid: w.paneChild.pid, nascita });
  fs.writeFileSync(w.marker.sbagliata, '1');
  await assert.rejects(
    () => w.runtime.down(CELLA),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED'
      && /nessuna connessione di controllo posseduta dal lancio/.test(e.message),
  );
  const letto = launchTarget.leggi(w.filesRoot, NOME);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.record.incerto, true);
});

test('ramo assente: has-session in timeout non dichiara «cella gia ferma», resta 409', async (t) => {
  const w = creaMondo(t);
  // nessun record: il ramo «assente» del teardown. Con la lettura scaduta
  // l'esito non e' alreadyAbsent ma il rifiuto esplicito.
  fs.writeFileSync(w.marker.lenta, '1');
  await assert.rejects(
    () => w.runtime.down(CELLA),
    (e) => e.status === 409 && e.fleetCode === 'IDENTITY_UNVERIFIED'
      && /esito del has-session non dichiarabile/.test(e.message),
  );
  assert.equal(launchTarget.leggi(w.filesRoot, NOME).stato, 'assente');
});
