'use strict';
// Riaggancio provato del canale di controllo dopo un riavvio del processo che
// possedeva il lancio, con tmux VERO su un socket privato di questo file
// (TMUX_TMPDIR in una mkdtemp dedicata, mai il server della flotta).
//
// Lo scenario e' quello del servizio fermato e ripartito con la cella accesa:
// il runtime A lancia (record v2 attested con identita' completa di server e
// supervisore), poi «muore» (shutdown: canali chiusi, lock di scrittore
// rilasciato); il runtime B nasce sulla STESSA root dei file, senza canali in
// memoria. Oggi B non puo' fermare la cella: senza connessione posseduta dalla
// creazione il down rifiuta per costruzione (409 IDENTITY_UNVERIFIED), anche
// quando server e supervisore del record sono perfettamente vivi e provabili.
//
// Contratti (identita' del record vs nodo, verifica e comando sulla STESSA
// connessione; una sola discrepanza lascia il rifiuto di oggi):
//  T4 down su B con record integro -> ok, sessione assente, record chiuso;
//  T5 serverStarttime alterato nel record -> nessun riaggancio, 409;
//  T6 paneId alterato -> nessun riaggancio, 409;
//  T7 panePid alterato (numero di un processo morto) -> nessun riaggancio, 409;
//  T8 tmuxSocket diverso -> nessun riaggancio, 409;
//  T9 restart su B -> down riuscito e poi rilancio con un record nuovo.
//
// Igiene: ogni test chiude il PROPRIO server con kill-server sul socket
// privato PRIMA di togliere le cartelle; il server di default della flotta e
// lo stato del nodo non vengono mai toccati.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { atomicWrite, loadDefinitions, leggiIdentitaProc } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { requireSharedTmuxProtection } = require('../lib/tmux/shared-server.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');

const TMUX = '/bin/tmux';
const CELLA = 'CellaPre';
const SESSIONE = 'cloud-CellaPre';
// Owner fittizio ma ben formato: il record del lancio lo porta e il riaggancio
// lo confronta con quello del nodo, come farebbe un nodo reale della flotta.
const OWNER = 'ab'.repeat(16);

function sh(args, env, timeoutMs = 8000) {
  return spawnSync(TMUX, args, { encoding: 'utf8', timeout: timeoutMs, env });
}

// Il mondo del test: HOME, root dei file, definizioni, broker VERO e server
// tmux VERO su socket privato, tutto sotto mkdtemp di questo file.
function creaMondo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-readopt-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, CELLA);
  fs.mkdirSync(cwd, { recursive: true });
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { recursive: true });
  // 0700: il broker di lancio vero rifiuta una run dir leggibile ad altri.
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

  // Il server DI TEST: TMUX_TMPDIR privato, HOME del client tmux propria cosi'
  // non viene letto nessun .tmux.conf del nodo, locale UTF-8 come fa il runtime
  // per ogni invocazione.
  const tmuxd = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-readopt-m-'));
  const tmuxHome = path.join(tmuxd, 'conf');
  fs.mkdirSync(tmuxHome, { mode: 0o700 });
  const prevTmuxTmpdir = process.env.TMUX_TMPDIR;
  const prevLcCtype = process.env.LC_CTYPE;
  process.env.TMUX_TMPDIR = tmuxd;
  process.env.LC_CTYPE = 'C.UTF-8';
  const socket = sharedTmuxSocketPath();
  // Env dei client tmux dell'harness: nessun selettore ereditato, tutto
  // agganciato ai valori catturati del mondo (indipendente dai restore).
  const tmuxEnv = () => ({
    PATH: '/usr/bin:/bin', HOME: tmuxHome, LC_CTYPE: 'C.UTF-8',
    TMUX_TMPDIR: tmuxd, TMUX: '', TMUX_PANE: '',
  });

  // Un solo engine custom di lunga vita: il processo del pane resta vivo per
  // tutta la prova (e' il «supervisore» del lancio).
  const defsPath = path.join(root, 'defs.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'cat', label: 'Cat', rc: false, command: '/bin/cat', args: [], env: {}, promptMode: 'flag', promptFlag: '--prompt' }],
    cells: [{ id: CELLA, engine: 'cat', tmuxSession: SESSIONE, cwd }],
  });
  const defs = loadDefinitions(defsPath);
  const broker = createLaunchBroker({ home });

  return {
    root, home, filesRoot, defsPath, defs, cwd, tmuxd, tmuxHome, socket, tmuxEnv,
    prevTmuxTmpdir, prevLcCtype, broker,
    runtimeAperti: [],
    apriRuntime() {
      const rt = createBuiltinRuntime({
        cfg: { activityHooks: false, launchReadyMs: 0, filesRoot, log: () => {}, vlLaunchCooldownMs: 0, env: {} },
        home,
        defsPath,
        tmuxBin: TMUX,
        readonly: () => false,
        identityOwnerInstanceId: OWNER,
        launchBroker: {
          issue: async (payload) => broker.issue(payload),
          revoke: async (nonce) => broker.revoke(nonce),
        },
        boot: defs,
        ensureProtection: () => requireSharedTmuxProtection(TMUX, { home: tmuxHome }),
      });
      this.runtimeAperti.push(rt);
      return rt;
    },
    hasSession() {
      return sh(['-S', socket, 'has-session', '-t', `=${SESSIONE}`], tmuxEnv(), 3000).status === 0;
    },
    leggiRecord() {
      return launchTarget.leggi(filesRoot, SESSIONE);
    },
    fileRecord() {
      return path.join(filesRoot, 'launch-targets', `${SESSIONE}.json`);
    },
    manometti(cambia) {
      const p = this.fileRecord();
      const dato = JSON.parse(fs.readFileSync(p, 'utf8'));
      cambia(dato);
      fs.writeFileSync(p, JSON.stringify(dato));
    },
  };
}

// Chiude il server DI TEST con kill-server sul socket privato. Prima toglie
// l'alias che la protezione ha armato su questo server (solo il nostro), poi
// kill-server, poi la sonda: nessun client deve piu' rispondere sul socket.
function chiudiServerDiTest(w) {
  sh(['-S', w.socket, 'set-option', '-s', '-u', 'command-alias[100]'], w.tmuxEnv(), 3000);
  sh(['-S', w.socket, 'kill-server'], w.tmuxEnv(), 5000);
  const sonda = sh(['-S', w.socket, 'display-message', '-p', '#{pid}'], w.tmuxEnv(), 3000);
  if (sonda.status === 0 || /^[0-9]+$/.test(String(sonda.stdout || '').trim())) {
    throw new Error(`server di test superstite sul socket privato: ${w.socket}`);
  }
}

function ripristinaEnv(w) {
  if (w.prevTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = w.prevTmuxTmpdir;
  if (w.prevLcCtype === undefined) delete process.env.LC_CTYPE;
  else process.env.LC_CTYPE = w.prevLcCtype;
}

// Un intero test nel mondo: alla fine chiude i runtime aperti, il server di
// test e le cartelle, qualunque sia l'esito del corpo.
async function nelMondo(t, corpo) {
  const w = creaMondo();
  try {
    await corpo(w);
  } finally {
    for (const rt of w.runtimeAperti) {
      try { rt.shutdown(); } catch (_) { /* best-effort: canali gia' chiusi */ }
    }
    try { w.broker.close(); } catch (_) { /* best-effort */ }
    chiudiServerDiTest(w);
    ripristinaEnv(w);
    try { fs.rmSync(w.root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    try { fs.rmSync(w.tmuxd, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

// Un numero di processo sicuramente morto, nato nel test: la firma di un pid
// riusato o di un lancio che non e' piu' quello del record. L'attesa dell'exit
// serve anche a farlo raccogliere (un figlio non raccolto resterebbe zombie e
// il numero continuerebbe a rispondere a kill(pid, 0)).
async function pidMorto() {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'],
    { stdio: 'ignore' });
  const uscito = new Promise((resolve) => f.once('exit', () => resolve()));
  f.kill('SIGKILL');
  await uscito;
  const id = leggiIdentitaProc(f.pid);
  assert.ok(id && id.esito === 'assente',
    `il numero ${f.pid} deve essere assente subito dopo l'uscita (${id && id.esito})`);
  return f.pid;
}

// Il lancio del runtime A e la «morte» del processo che lo possedeva: shutdown
// chiude i canali e rilascia il lock di scrittore. Ritorna il record letto
// subito prima della morte (identita' completa, gia' verificata viva).
async function lanciaEPoiMuori(w) {
  const a = w.apriRuntime();
  const up = await a.up(CELLA);
  assert.equal(up.ok, true, `up del runtime A: ${JSON.stringify(up)}`);
  const letto = w.leggiRecord();
  assert.equal(letto.stato, 'presente', 'il lancio di A deve lasciare il record');
  assert.equal(letto.record.phase, 'attested', `fase del record: ${letto.record.phase}`);
  assert.ok(Number.isFinite(letto.record.serverStarttime), 'nascita del server nel record');
  assert.ok(Number.isFinite(letto.record.paneStarttime), 'nascita del supervisore nel record');
  const idSupervisore = leggiIdentitaProc(letto.record.panePid);
  assert.ok(idSupervisore && idSupervisore.esito === 'presente',
    'il supervisore del lancio e` vivo prima del riavvio');
  a.shutdown();
  return letto;
}

// Il rifiuto atteso quando il riaggancio NON deve avvenire: 409 di teardown,
// nessuna azione, sessione e record al loro posto.
async function rifiutaDownSenzaRiaggancio(w, b) {
  await assert.rejects(() => b.down(CELLA), (e) => {
    assert.equal(e.status, 409, 'il rifiuto resta un 409');
    assert.equal(e.fleetCode, 'IDENTITY_UNVERIFIED', `codice: ${e.fleetCode}`);
    return true;
  }, 'il down senza riaggancio provato deve rifiutare come oggi');
  assert.equal(w.hasSession(), true, 'la sessione resta viva: nessuna azione');
  const dopo = w.leggiRecord();
  assert.equal(dopo.stato, 'presente', 'il record non va toccato');
  assert.equal(dopo.record.launchId, w.leggiRecord().record.launchId, 'stesso lancio');
}

test('T4: down sul runtime senza canali dopo il riavvio — riaggancio provato, ok, sessione assente, record chiuso', async (t) => {
  if (sh(['-V'], { ...process.env, TMUX: '' }).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  await nelMondo(t, async (w) => {
    await lanciaEPoiMuori(w);
    // Il runtime B: stessa root dei file, nessun canale in memoria (il
    // riavvio del servizio). Il down deve riagganciare il canale provato e
    // fermare la cella.
    const b = w.apriRuntime();
    const down = await b.down(CELLA);
    assert.equal(down.ok, true, `down del runtime B: ${JSON.stringify(down)}`);
    assert.equal(w.hasSession(), false, 'la sessione deve essere assente dopo il down');
    const dopo = w.leggiRecord();
    assert.equal(dopo.stato, 'assente', 'il record del lancio deve essere chiuso');
  });
});

test('T5: serverStarttime alterato nel record — nessun riaggancio, 409', async (t) => {
  if (sh(['-V'], { ...process.env, TMUX: '' }).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  await nelMondo(t, async (w) => {
    await lanciaEPoiMuori(w);
    w.manometti((d) => { d.serverStarttime = d.serverStarttime + 1; });
    const b = w.apriRuntime();
    await rifiutaDownSenzaRiaggancio(w, b);
  });
});

test('T6: paneId alterato nel record — nessun riaggancio, 409', async (t) => {
  if (sh(['-V'], { ...process.env, TMUX: '' }).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  await nelMondo(t, async (w) => {
    await lanciaEPoiMuori(w);
    w.manometti((d) => { d.paneId = '%999'; });
    const b = w.apriRuntime();
    await rifiutaDownSenzaRiaggancio(w, b);
  });
});

test('T7: panePid alterato nel record con un numero morto — nessun riaggancio, 409', async (t) => {
  if (sh(['-V'], { ...process.env, TMUX: '' }).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  await nelMondo(t, async (w) => {
    const prima = await lanciaEPoiMuori(w);
    const morto = await pidMorto();
    assert.notEqual(morto, prima.record.panePid, 'il numero morto deve essere diverso dal supervisore');
    w.manometti((d) => { d.panePid = morto; });
    const b = w.apriRuntime();
    await rifiutaDownSenzaRiaggancio(w, b);
  });
});

test('T8: tmuxSocket diverso nel record — nessun riaggancio, 409', async (t) => {
  if (sh(['-V'], { ...process.env, TMUX: '' }).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  await nelMondo(t, async (w) => {
    await lanciaEPoiMuori(w);
    w.manometti((d) => { d.tmuxSocket = path.join(w.root, 'altro-socket'); });
    const b = w.apriRuntime();
    await rifiutaDownSenzaRiaggancio(w, b);
  });
});

test('T9: restart sul runtime senza canali — down riuscito e poi rilancio con record nuovo', async (t) => {
  if (sh(['-V'], { ...process.env, TMUX: '' }).status !== 0) { t.skip('tmux di sistema non disponibile'); return; }
  await nelMondo(t, async (w) => {
    const prima = await lanciaEPoiMuori(w);
    const b = w.apriRuntime();
    const restart = await b.restart(CELLA);
    assert.equal(restart.ok, true, `restart del runtime B: ${JSON.stringify(restart)}`);
    assert.equal(w.hasSession(), true, 'la sessione del rilancio deve essere presente');
    const dopo = w.leggiRecord();
    assert.equal(dopo.stato, 'presente', 'il rilancio scrive il suo record');
    assert.notEqual(dopo.record.launchId, prima.record.launchId,
      'il record dopo il restart e` del lancio NUOVO');
  });
});
