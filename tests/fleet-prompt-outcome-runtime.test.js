'use strict';
// 0.9.80 strato 2b — supervisore: il pending del record del prompt si scrive
// ALL'AMMISSIONE della generazione (sincrono, prima dello spawn), il terminale
// accanto a ogni pubblicazione dell'esito volatile, la barriera in memoria
// rifiuta le scritture fuori ordine PRIMA di toccare il disco. Nessun tmux
// reale: il mondo e' tutto di seams.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const activityFiles = require('../lib/files/activity.js');
const { main: cellExecMain, startGenerationPrompt } = require('../lib/fleet/cell-exec.js');

const LAUNCH = 'a1b2c3d4e5f60718';
const SECRET = 'SECRET-PROMPT-MARKER-xyz';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prompt-sup-'));
}

// Harness del supervisore sullo stampo dei test di consegna esistenti: clock
// controllabili, spawn fake, stderr catturato, tmux che registra. Il canale
// del record viaggia nel payload come nel prodotto.
function harness({
  promptOutcome = null, restartPrompt = {}, supervise = {}, payload: payloadExtra = {},
  deliver = null, paste = null, onSpawn = null, manualExit = false, lifeMs = 60,
  unaGenerazione = false,
} = {}) {
  const errs = []; const marks = []; const deliveries = []; const pastes = [];
  let clock = 0; let launches = 0;
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    ...(promptOutcome ? { promptOutcome } : {}),
    ...payloadExtra,
    restartPrompt: {
      tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: `boot ${SECRET}`, readyMs: 0,
      client: 'kimi', readyWaitMs: 1000, ...restartPrompt,
    },
    supervise: {
      enabled: true, initialReadyMs: 5, restartDelayMs: 5,
      maxRestartDelayMs: 20, resetAfterMs: 100000, rapidWindowMs: 100000,
      maxRapidRestarts: 10, maxTotalRestarts: 2, ...supervise,
    },
  };
  const seams = {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1;
      const child = new EventEmitter();
      child.kill = () => child.emit('exit', 0, null);
      if (unaGenerazione && launches === 1) {
        child.once('exit', () => proc.emit('SIGTERM'));
      }
      if (onSpawn) onSpawn(launches, child, proc);
      // Exit su timer REALE (come i test di consegna esistenti): la consegna
      // del prompt gira a microtask puri e deve completare PRIMA dell'exit,
      // altrimenti ogni esito risulterebbe cancellato.
      if (!manualExit) setTimeout(() => { clock += lifeMs; child.emit('exit', 1, null); }, 25);
      return child;
    },
    now: () => 1700000000000 + clock,
    monoNow: () => clock,
    sleep: async () => {},
    process: proc,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout: () => {},
    writeError: (m) => errs.push(String(m)),
    tmuxExec: async (_bin, args) => {
      marks.push(args.join(' '));
      return { err: null, stdout: '', stderr: '', code: 0 };
    },
    ...(deliver ? { deliverBootstrapPrompt: async (opts) => { deliveries.push(opts); return deliver(opts, launches); } } : {}),
    ...(paste ? { securePaste: async (...a) => { pastes.push(a); return paste(...a, launches); } } : {}),
  };
  return {
    proc, errs, marks, deliveries, pastes,
    launches: () => launches,
    payload, seams,
    run: (extra = {}) => cellExecMain(['--socket', '/tmp/x', '--nonce', '1'.repeat(64)], { ...seams, ...extra }),
  };
}

function canale(root, launchId = LAUNCH) {
  return { dir: path.join(root, 'cloud-T'), launchId };
}

// --- 13. Barriera: il pending e' su disco PRIMA dello spawn -------------------
test('supervisore: all\'ammissione il pending e\' gia\' su disco (generation 0, launchId del payload)', async () => {
  const root = tmpRoot();
  const esito = canale(root);
  let vistoDuranteLoSpawn = 'mai';
  try {
    const w = harness({
      promptOutcome: esito,
      onSpawn: (n) => { if (n === 1) vistoDuranteLoSpawn = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH); },
      deliver: () => ({ delivered: true, state: 'submitted', notReady: '' }),
    });
    await w.run();
    assert.notEqual(vistoDuranteLoSpawn, 'mai', 'lo spawn e\' partito');
    assert.equal(vistoDuranteLoSpawn.state, 'pending',
      'se il processo morisse subito dopo lo spawn, il pending ci sarebbe');
    assert.equal(vistoDuranteLoSpawn.generation, 0);
    assert.equal(vistoDuranteLoSpawn.launchId, LAUNCH);
    assert.equal(typeof vistoDuranteLoSpawn.deadlineTs, 'number');
    assert.ok(vistoDuranteLoSpawn.deadlineTs >= vistoDuranteLoSpawn.ts);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 14. Terminale accanto all'esito volatile ---------------------------------
test('supervisore: esito submitted -> UN record terminale submitted, generation 0', async () => {
  const root = tmpRoot(); const esito = canale(root);
  try {
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      deliver: () => ({ delivered: true, state: 'submitted', notReady: '' }),
    });
    const code = await w.run();
    assert.equal(code, 0, 'stop dell\'operatore alla prima uscita: una generazione');
    const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'submitted');
    assert.equal(record.generation, 0);
    assert.equal(record.reason, undefined);
    // Il file del prompt e' UNO per lancio: nessun pending residuo a parte.
    const filePrompt = fs.readdirSync(esito.dir).filter((n) => n.startsWith('prompt-'));
    assert.deepEqual(filePrompt, [`prompt-${LAUNCH}.json`]);
    // Nessun testo del prompt nel record.
    assert.ok(!fs.readFileSync(path.join(esito.dir, `prompt-${LAUNCH}.json`), 'utf8').includes(SECRET));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('supervisore: skipped-not-ready conserva il kind, failed-pre-paste la ragione', async () => {
  for (const [stato, atteso] of [
    [{ delivered: false, state: 'skipped-not-ready', notReady: 'not-ready-consent' },
      { state: 'skipped', reason: 'not-ready', notReady: 'not-ready-consent' }],
    [{ delivered: false, state: 'failed-pre-paste', notReady: '' },
      { state: 'skipped', reason: 'failed-pre-paste' }],
  ]) {
    const root = tmpRoot(); const esito = canale(root);
    try {
      const w = harness({ promptOutcome: esito, unaGenerazione: true, deliver: () => stato });
      await w.run();
      const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
      assert.equal(record.state, atteso.state, stato.state);
      assert.equal(record.reason, atteso.reason, stato.state);
      assert.equal(record.notReady, atteso.notReady, stato.state);
      assert.equal(record.generation, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('supervisore: reprompt:false con paste-failed:load -> skipped/failed-pre-paste-load', async () => {
  const root = tmpRoot(); const esito = canale(root);
  try {
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      restartPrompt: { client: '', reprompt: false },
      paste: () => ({ ok: false, stage: 'load' }),
    });
    await w.run();
    const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'skipped');
    assert.equal(record.reason, 'failed-pre-paste-load');
    assert.equal(w.pastes.length, 1, 'il paste e\' stato tentato una volta');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 16 (barriera in memoria): la generazione ammessa arbitraria ---------------
test('supervisore: la barriera in memoria rifiuta una scrittura fuori ordine senza toccare il disco', () => {
  const root = tmpRoot(); const esito = canale(root);
  const cfg = (gen) => ({
    tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 60000,
    client: 'kimi', readyWaitMs: 1000,
  });
  const seamsBase = {
    deliverBootstrapPrompt: async () => { throw new Error('non deve partire'); },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    setTimeout: () => 1, clearTimeout: () => {},
    writeError: () => {},
  };
  try {
    const gate = { ultimaGenerazioneAmmessa: -1 };
    // gen0 ammessa: pending su disco.
    startGenerationPrompt(cfg(0), 0, { exited: true }, { ...seamsBase, promptOutcome: esito, promptGate: gate });
    assert.equal(activityFiles.leggiRecordPrompt(esito.dir, LAUNCH).generation, 0);
    // gen1 ammessa: sostituisce il pending di gen0 nel medesimo file.
    startGenerationPrompt(cfg(1), 1, { exited: true }, { ...seamsBase, promptOutcome: esito, promptGate: gate });
    assert.equal(activityFiles.leggiRecordPrompt(esito.dir, LAUNCH).generation, 1);
    const prima = fs.readFileSync(path.join(esito.dir, `prompt-${LAUNCH}.json`), 'utf8');
    const mtime = fs.statSync(path.join(esito.dir, `prompt-${LAUNCH}.json`)).mtimeMs;
    // Scrittura tardiva di gen0 DOPO l'ammissione di gen1: la barriera rifiuta
    // PRIMA di toccare il disco.
    const errs = [];
    startGenerationPrompt(cfg(0), 0, { exited: true }, {
      ...seamsBase, promptOutcome: esito, promptGate: gate, writeError: (m) => errs.push(String(m)),
    });
    assert.equal(fs.readFileSync(path.join(esito.dir, `prompt-${LAUNCH}.json`), 'utf8'), prima);
    assert.equal(fs.statSync(path.join(esito.dir, `prompt-${LAUNCH}.json`)).mtimeMs, mtime);
    assert.ok(errs.some((m) => m.includes('prompt outcome')), 'rifiuto dichiarato su stderr');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 17. Crash prima/dopo l'effetto --------------------------------------------
// Orologio civile REALE in questi due test: il lettore deriva la scadenza del
// pending con Date.now, e un orologio di fixture congelato renderebbe il
// pending gia' scaduto (unknown derivato, non pending).
test('supervisore: crash prima dell\'effetto -> il lettore vede pending; il terminale manca', async () => {
  const root = tmpRoot(); const esito = canale(root);
  try {
    const w = harness({
      promptOutcome: esito, manualExit: true,
      // Orologio reale: budget largo, cosi' la lettura resta pending anche su
      // una macchina lenta (il limite e' solo osservabilita' del pending).
      restartPrompt: { readyWaitMs: 60000 },
      deliver: (opts) => new Promise((resolve) => {
        const t = setInterval(() => {
          if (opts.isCancelled()) { clearInterval(t); resolve({ delivered: false, state: 'cancelled', notReady: '' }); }
        }, 5);
        setTimeout(() => { clearInterval(t); resolve({ delivered: false, state: 'cancelled', notReady: '' }); }, 5000);
      }),
    });
    const inCorso = w.run({ now: () => Date.now() });
    await new Promise((r) => setImmediate(r));
    const letto = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.equal(letto.state, 'pending', 'crash subito dopo lo spawn: su disco c\'e\' il pending');
    // Nessun terminale: la generazione non e' mai finita.
    assert.equal(w.marks.filter((m) => m.includes('@nc_delivery submitted')).length, 0);
    try { w.proc.emit('SIGTERM'); } catch (_) {}
    await Promise.race([inCorso, new Promise((r) => setTimeout(r, 2000))]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('supervisore: crash dopo l\'effetto -> resta pending, MAI submitted dedotto dal marcatore volatile', async () => {
  const root = tmpRoot(); const esito = canale(root);
  try {
    // Il terminale NON si persiste: la directory diventa non scrivibile DOPO il
    // pending (dentro la consegna) e resta il solo marcatore volatile sul pane.
    const w = harness({
      promptOutcome: esito,
      // Budget largo (orologio reale): la lettura deve vedere pending, non un
      // deadline-exceeded d'ambiente.
      restartPrompt: { readyWaitMs: 60000 },
      deliver: () => {
        fs.chmodSync(esito.dir, 0o500);
        return { delivered: true, state: 'submitted', notReady: '' };
      },
    });
    const code = await w.run({ now: () => Date.now() });
    assert.ok(typeof code === 'number');
    assert.ok(w.marks.some((m) => m.includes('@nc_delivery submitted')),
      'il marcatore volatile e\' stato pubblicato');
    const letto = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.equal(letto.state, 'pending',
      'il record non attestato non promuove il marcatore volatile a submitted');
    assert.notEqual(letto.state, 'submitted');
    assert.ok(w.errs.some((m) => m.includes('prompt outcome record not persisted')),
      'il guasto di persistenza e\' dichiarato');
  } finally {
    try { fs.chmodSync(esito.dir, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
