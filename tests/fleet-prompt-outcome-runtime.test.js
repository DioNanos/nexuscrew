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
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const W = require('./helpers/launch-world.js');

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
      // UNA sola generazione: un riavvio ammetterebbe la gen1, e il lettore
      // dichiara (giustamente) unknown/generation-not-recorded.
      unaGenerazione: true,
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

// --- 19. Canale dedicato, indipendente dagli hook --------------------------------
test('runtime: activityHooks false -> il payload porta comunque il canale del prompt', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  let catturato = null;
  const { runtime } = W.apriRuntime(d, {
    issue: async (payload) => {
      catturato = payload;
      return { socketPath: path.join(d.root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.up(d.cella);
  assert.equal(r.ok, true);
  // Il canale ATTIVITA' non c'e' (hooks off), quello del prompt SI': la
  // durabilita' dell'esito non dipende dagli hook del client.
  assert.equal(catturato.activity, undefined, 'hooks off: nessun canale attivita\'');
  assert.ok(catturato.promptOutcome && typeof catturato.promptOutcome === 'object',
    'il canale del prompt viaggia comunque nel payload');
  assert.deepEqual(Object.keys(catturato.promptOutcome).sort(), ['dir', 'launchId'],
    'chiavi esatte del canale');
  assert.equal(catturato.promptOutcome.dir, path.join(d.filesRoot, d.sessione),
    'la directory e\' quella privata della sessione');
  assert.match(catturato.promptOutcome.launchId, /^[0-9a-f]{16}$/,
    'l\'identita\' del canale e\' il lancio (hex16)');
});

test('runtime: hooks attivi -> canale attivita\' E canale del prompt, distinti', async (t) => {
  const d = W.scriviMondo({ famiglia: 'other' });
  t.after(() => W.pulisci(d));
  let catturato = null;
  const { runtime } = W.apriRuntime(d, {
    cfg: { activityHooks: true },
    issue: async (payload) => {
      catturato = payload;
      return { socketPath: path.join(d.root, 'broker.sock'), nonce: 'a'.repeat(64) };
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const r = await runtime.up(d.cella);
  assert.equal(r.ok, true);
  assert.ok(catturato.activity, 'canale attivita\' presente');
  assert.ok(catturato.promptOutcome, 'canale del prompt presente');
  assert.equal(catturato.activity.dir, catturato.promptOutcome.dir,
    'stessa directory privata di sessione');
  assert.equal(catturato.activity.generation, catturato.promptOutcome.launchId,
    'l\'identita\' del lancio e\' UNA: generation del canale attivita\' = launchId del prompt');
  assert.notDeepEqual(Object.keys(catturato.activity).sort(), Object.keys(catturato.promptOutcome).sort(),
    'i due canali restano oggetti distinti con chiavi proprie');
});

test('supervisore: canale assente -> consegna trattenuta, zero paste, stderr fisso, nessun record', async () => {
  const root = tmpRoot();
  try {
    const w = harness({
      // NESSUN promptOutcome nel payload: chiamante vecchio.
      unaGenerazione: true,
      deliver: () => { throw new Error('la consegna non deve mai partire'); },
    });
    const code = await w.run();
    assert.equal(code, 0, 'la cella parte e non diventa fallita');
    assert.equal(w.deliveries.length, 0, 'zero consegna supervisionata senza canale');
    assert.equal(w.launches(), 1, 'la generazione e\' partita normalmente');
    assert.ok(w.errs.some((m) => m.includes('prompt outcome channel unavailable')),
      'stderr a testo fisso dichiara il canale non disponibile');
    assert.ok(w.marks.some((m) => m.includes('@nc_delivery skipped-unknown')),
      'marcatore volatile compatibile skipped-unknown');
    assert.equal(fs.existsSync(path.join(root, 'cloud-T')), false,
      'nessun record costruito in una directory indovinata');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('payload: canale del prompt malformato -> rifiutato dal validatore (broker vero)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prompt-chan-'));
  fs.chmodSync(home, 0o700);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 15000 });
  try {
    const LANCI0 = '0123456789abcdef';
    const cattivi = [
      { dir: '/tmp/privato', launchId: LANCI0, extra: 1 },        // chiave in piu'
      { dir: '/tmp/privato', launchId: '..' },                     // id ostile: componente
      { dir: '/tmp/privato', launchId: '.' },                      // id ostile: componente
      { dir: '/tmp/privato', launchId: 'a/b' },                    // id ostile: separatore
      { dir: '/tmp/privato', launchId: 'a\nb' },                   // id ostile: CR/LF
      { dir: '/tmp/privato', launchId: '' },                       // id vuoto
      { dir: 'riga\nnuova', launchId: LANCI0 },                    // dir con CR/LF
      { dir: '', launchId: LANCI0 },                               // dir vuota
      { dir: '/tmp/privato', launchId: 42 },                       // id non stringa
      'non-oggetto',
    ];
    for (const cattivo of cattivi) {
      const payload = {
        command: '/bin/true', args: [], env: {}, supervise: { enabled: false },
        promptOutcome: cattivo,
      };
      const ticket = await broker.issue(payload);
      const errors = [];
      const code = await cellExecMain(['--socket', ticket.socketPath, '--nonce', ticket.nonce], {
        spawn: () => { throw new Error('il payload rifiutato non deve mai spawnare'); },
        process: new EventEmitter(),
        writeError: (l) => errors.push(String(l)),
      }).catch((e) => { errors.push(String(e && e.message)); return 1; });
      assert.equal(code, 1);
      assert.ok(errors.some((m) => m.includes('invalid launch payload')),
        `payload rifiutato per ${JSON.stringify(cattivo)}`);
    }
    // Un canale BEN FORMATO non e' un payload rifiutato: la stessa corsa arriva
    // fino allo spawn (che qui e' il seam che registra) e il figlio esce.
    const buono = await broker.issue({
      command: '/bin/true', args: [], env: {}, supervise: { enabled: false },
      promptOutcome: { dir: '/tmp/privato', launchId: LANCI0 },
    });
    let spawnato = false;
    const code = await cellExecMain(['--socket', buono.socketPath, '--nonce', buono.nonce], {
      spawn: () => {
        spawnato = true;
        const c = new EventEmitter();
        c.kill = () => {};
        queueMicrotask(() => c.emit('exit', 0, null));
        return c;
      },
      process: new EventEmitter(),
      writeError: () => {},
    });
    assert.ok(spawnato, 'canale ben formato: il payload passa e la cella nasce');
    assert.equal(code, 0, 'uscita pulita del figlio');
  } finally { await broker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('supervisore: generazioni che non possono ricevere prompt -> terminale diretto, mai pending', () => {
  const root = tmpRoot(); const esito = canale(root);
  const seamsBase = {
    deliverBootstrapPrompt: async () => { throw new Error('non deve partire'); },
    securePaste: async () => { throw new Error('non deve partire'); },
    tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
    setTimeout: () => 1, clearTimeout: () => {},
    writeError: () => {},
  };
  const gate = { ultimaGenerazioneAmmessa: -1 };
  try {
    // gen>0 con reprompt:false: il prompt non si reinvia MAI.
    startGenerationPrompt(
      { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 60000, client: '', reprompt: false, readyWaitMs: 1000 },
      1, { exited: true }, { ...seamsBase, promptOutcome: esito, promptGate: gate },
    );
    let record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'skipped', 'reprompt:false gen>0');
    assert.equal(record.reason, 'reprompt-disabled');
    assert.equal(record.generation, 1);
    assert.equal(record.deadlineTs, undefined, 'nessun pending, nessun limite artificiale');

    // vl ineleggibile: skip con la ragione chiusa del launcher, zero paste.
    // (Generazione 2: sopra la precedente — un terminale DIVERSO sulla stessa
    // generazione e' immutabile, e' il contratto delle transizioni.)
    startGenerationPrompt(
      { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 60000, client: 'vl', readyWaitMs: 1000, vlBootstrap: { eligible: false, reason: 'claim-taken' } },
      2, { exited: true }, { ...seamsBase, promptOutcome: esito, promptGate: gate },
    );
    record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'skipped', 'vl ineleggibile');
    assert.equal(record.reason, 'vl-bootstrap-claim-taken');
    assert.equal(record.generation, 2, 'la generazione ammessa sostituisce, non indietro');

    // vl gen>0 (eleggibile): la claim e' della generazione 0, qui si skip.
    startGenerationPrompt(
      { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 60000, client: 'vl', readyWaitMs: 1000, vlBootstrap: { eligible: true, claimPath: '/tmp/claim' } },
      3, { exited: true }, { ...seamsBase, promptOutcome: esito, promptGate: gate },
    );
    record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'skipped', 'vl gen>0');
    assert.equal(record.reason, 'vl-bootstrap-generation');
    assert.equal(record.generation, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 18. Guasti di persistenza ----------------------------------------------------
test('supervisore: pending non persistibile -> zero paste, stderr fisso, skipped-unknown, cella viva', async () => {
  const root = tmpRoot();
  try {
    fs.chmodSync(root, 0o500);   // la directory privata NON puo' nascere
    const esito = canale(root);
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      deliver: () => { throw new Error('senza pending su disco nessuna consegna'); },
    });
    const code = await w.run();
    fs.chmodSync(root, 0o700);
    assert.equal(code, 0, 'la cella NON diventa fallita');
    assert.equal(w.deliveries.length, 0, 'zero consegna');
    assert.equal(w.launches(), 1, 'la generazione e\' partita');
    assert.ok(w.errs.some((m) => m.includes('prompt outcome record not persisted (delivery withheld)')),
      'riga fissa su stderr del pending trattenuto');
    assert.ok(w.marks.some((m) => m.includes('@nc_delivery skipped-unknown')),
      'marcatore volatile skipped-unknown (nessun timeout silenzioso)');
    // Zero digitazione: nessun load/paste/send-keys oltre al marcatore.
    const digitazione = w.marks.filter((m) => /load-buffer|paste-buffer|send-keys/.test(m));
    assert.deepEqual(digitazione, [], 'zero load/paste/Enter');
  } finally {
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supervisore: terminale non persistibile dopo il paste -> stderr, esito volatile invariato, record pending', async () => {
  const root = tmpRoot(); const esito = canale(root);
  try {
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      restartPrompt: { client: '', reprompt: false },
      paste: () => {
        // Il paste riuscito, POI la directory diventa non scrivibile: il
        // terminale non si persiste ma l'esito volatile resta quello vero.
        fs.chmodSync(esito.dir, 0o500);
        return { ok: true, stage: 'pasted', paneId: '%42' };
      },
    });
    const code = await w.run();
    try { fs.chmodSync(esito.dir, 0o700); } catch (_) {}
    assert.equal(code, 0);
    assert.equal(w.pastes.length, 1, 'il paste e\' avvenuto davvero');
    assert.ok(w.marks.some((m) => m.includes('@nc_delivery paste-delivered')),
      'il marcatore volatile NON viene soppresso dal guasto del record');
    assert.ok(w.errs.some((m) => m.includes('prompt outcome record not persisted')
      && !m.includes('withheld')), 'riga fissa su stderr del terminale non persistito');
    const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record && record.state, 'pending',
      'su disco resta il pending non promosso: mai submitted per deduzione');
  } finally {
    try { fs.chmodSync(esito.dir, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- 20. VL: prima il settle, POI un solo terminale --------------------------------
function claimPending(root, nome = 'claim.json', stato = 'pending') {
  const p = path.join(root, nome);
  fs.writeFileSync(p, JSON.stringify({ v: 1, state: stato, cell: 'cloud-T' }), { mode: 0o600 });
  return p;
}

test('supervisore vl: submitted con claim settle riuscito -> submitted, claim aggiornata', async () => {
  const root = tmpRoot(); const esito = canale(root);
  const claimPath = claimPending(root);
  try {
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      restartPrompt: { client: 'vl', vlBootstrap: { eligible: true, claimPath } },
      deliver: () => ({ delivered: true, state: 'submitted', notReady: '' }),
    });
    await w.run();
    const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'submitted', 'claim coerente: mapping C3 normale');
    assert.equal(record.reason, undefined);
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    assert.equal(claim.state, 'submitted', 'la claim porta l\'esito del trasporto');
    assert.equal(typeof claim.settledAt, 'number', 'settle DURATURO avvenuto una volta');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('supervisore vl: claim non aggiornata -> unknown/claim-settle-failed, claim intatta, nessun submitted', async () => {
  const root = tmpRoot();
  try {
  for (const [nome, prepara] of [
    ['gia\' settled', () => claimPending(root, 'claim.json', 'uncertain')],
    ['assente', () => path.join(root, 'manca.json')],
  ]) {
    const claimPath = prepara();
    const prima = fs.existsSync(claimPath) ? fs.readFileSync(claimPath, 'utf8') : null;
    const esito = canale(root);
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      restartPrompt: { client: 'vl', vlBootstrap: { eligible: true, claimPath } },
      deliver: () => ({ delivered: true, state: 'submitted', notReady: '' }),
    });
    await w.run();
    const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'unknown', `${nome}: mai submitted per deduzione`);
    assert.equal(record.reason, 'claim-settle-failed', `${nome}: il canonico non e' attestato`);
    if (prima !== null) {
      assert.equal(fs.readFileSync(claimPath, 'utf8'), prima,
        `${nome}: la claim non si rilascia, non si riscrive, non si ritenta`);
    }
    // Il marcatore volatile continua a riportare il trasporto nel suo formato.
    assert.ok(w.marks.some((m) => m.includes('@nc_delivery submitted')),
      `${nome}: il ramo volatile non e' la prova del record canonico`);
    fs.rmSync(esito.dir, { recursive: true, force: true });
  }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 21 (supervisore): il terminale scritto pota a 8, corrente dentro -------
test('supervisore: dopo il terminale la retention lascia 8 record TOTALI con il corrente', async () => {
  const root = tmpRoot(); const esito = canale(root);
  try {
    fs.mkdirSync(esito.dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 9; i += 1) {
      const id = `vecchio${String(i)}abcdef01`.slice(0, 16);
      fs.writeFileSync(path.join(esito.dir, `prompt-${id}.json`), JSON.stringify({
        version: 1, event: 'prompt-delivery', launchId: id, generation: 0,
        state: 'unknown', reason: 'delivery-unknown', ts: 1700000000000 + i,
      }));
    }
    const w = harness({
      promptOutcome: esito, unaGenerazione: true,
      deliver: () => ({ delivered: true, state: 'submitted', notReady: '' }),
    });
    await w.run();
    const record = activityFiles.leggiRecordPrompt(esito.dir, LAUNCH);
    assert.equal(record.state, 'submitted');
    const restanti = fs.readdirSync(esito.dir).filter((n) => n.startsWith('prompt-'));
    assert.equal(restanti.length, 8, 'otto TOTALI dopo il terminale, corrente compreso');
    assert.ok(restanti.includes(`prompt-${LAUNCH}.json`), 'il lancio corrente e\' dentro gli otto');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Fix R2: un pending incompleto trattiene l'effetto ---------------------------
// Il mondo e' quello di startGenerationPrompt con i seams; solo fs.writeSync e'
// sostituito, e SOLO durante l'ammissione sincrona (il pending si scrive li').
function ammissione(root, { config = {}, generation = 0, gate = { ultimaGenerazioneAmmessa: -1 }, deliver, over = {}, child = { exited: false } } = {}) {
  const errs = []; let timer = null; const consegne = [];
  const ctl = startGenerationPrompt(
    { tmuxBin: 'tmux', tmuxSession: 'cloud-T', prompt: 'p', readyMs: 0, client: 'kimi', readyWaitMs: 1000, ...config },
    generation, child,
    {
      promptOutcome: canale(root), promptGate: gate,
      setTimeout: (fn) => { timer = fn; return { unref() {} }; }, clearTimeout: () => {},
      writeError: (m) => errs.push(String(m)),
      tmuxExec: async () => ({ err: null, stdout: '', stderr: '', code: 0 }),
      deliverBootstrapPrompt: async (o) => { consegne.push(o); return deliver ? deliver(o) : { state: 'submitted' }; },
      ...over,
    },
  );
  return { ctl, errs, consegne, fire: () => timer() };
}

test('supervisore: una scrittura del pending che non progredisce trattiene la consegna e non lascia byte parziali', async () => {
  const root = tmpRoot(); const originale = fs.writeSync;
  try {
    let a;
    fs.writeSync = () => 0;     // nessun progresso: ne' 7 byte ne' altro
    try { a = ammissione(root); } finally { fs.writeSync = originale; }
    const dirPrompt = path.join(root, 'cloud-T');
    assert.deepEqual(fs.readdirSync(dirPrompt), [], 'nessun record parziale ne\' temporaneo');
    await a.fire(); await a.ctl.settled;
    assert.equal(a.consegne.length, 0, 'zero consegna con un pending non completo');
    assert.ok(a.errs.some((m) => m.includes('delivery withheld')));
  } finally { fs.writeSync = originale; fs.rmSync(root, { recursive: true, force: true }); }
});

test('supervisore: una scrittura corta del pending si completa e la consegna prosegue', async () => {
  const root = tmpRoot(); const originale = fs.writeSync;
  try {
    let a;
    fs.writeSync = (fd, buf, off, len, pos) => originale(fd, buf, off, Math.min(len, 7), pos);
    try { a = ammissione(root); } finally { fs.writeSync = originale; }
    const letto = activityFiles.leggiRecordPrompt(path.join(root, 'cloud-T'), LAUNCH);
    assert.equal(letto.state, 'pending', 'il pending e\' intero e leggibile');
    await a.fire(); await a.ctl.settled;
    assert.equal(a.consegne.length, 1);
  } finally { fs.writeSync = originale; fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Fix R2: ammissione fallita di una generazione nuova -------------------------
// Il lettore non restituisce MAI il successo della generazione precedente come
// esito corrente dopo che il proprietario ha ammesso la generazione successiva.
function rotturaApertura(dirPrefisso) {
  const originale = fs.openSync;
  fs.openSync = (p, flags, ...a) => {
    if (flags === 'wx' && String(p).startsWith(dirPrefisso + path.sep)) throw new Error('inject open');
    return originale(p, flags, ...a);
  };
  return () => { fs.openSync = originale; };
}
function terminaleGen(generation, over = {}) {
  return {
    version: 1, event: 'prompt-delivery', launchId: LAUNCH, generation,
    state: 'submitted', ts: Date.now(), ...over,
  };
}

test('lettore: gen0 submitted + ammissione gen1 con pending fallito -> unknown, mai il vecchio submitted', async () => {
  const root = tmpRoot(); const dir = path.join(root, 'cloud-T');
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminaleGen(0)), true);
    const gate = { ultimaGenerazioneAmmessa: 0 };
    const ripristina = rotturaApertura(dir);
    let a;
    try { a = ammissione(root, { generation: 1, gate }); } finally { ripristina(); }
    assert.equal(gate.ultimaGenerazioneAmmessa, 1, 'il fence e\' a 1');
    assert.ok(a.errs.some((m) => m.includes('delivery withheld')));
    const letto = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.deepEqual(letto, { state: 'unknown', reason: 'generation-not-recorded', launchId: LAUNCH, generation: 1 });
    await a.fire(); await a.ctl.settled;
    assert.equal(a.consegne.length, 0, 'zero paste');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettore: stesso caso per il terminale diretto di una generazione esclusa dalla policy', () => {
  const root = tmpRoot(); const dir = path.join(root, 'cloud-T');
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminaleGen(0)), true);
    const ripristina = rotturaApertura(dir);
    try {
      ammissione(root, { generation: 1, config: { reprompt: false, client: '' } });
    } finally { ripristina(); }
    const letto = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.equal(letto.state, 'unknown');
    assert.equal(letto.reason, 'generation-not-recorded');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettore: ammissione gen1 riuscita -> il record della gen1 e\' quello corrente (pending, poi terminale)', async () => {
  const root = tmpRoot(); const dir = path.join(root, 'cloud-T');
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminaleGen(0)), true);
    const a = ammissione(root, { generation: 1, gate: { ultimaGenerazioneAmmessa: 0 } });
    const pending = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.equal(pending.state, 'pending');
    assert.equal(pending.generation, 1);
    await a.fire(); await a.ctl.settled;
    const finale = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.equal(finale.state, 'submitted');
    assert.equal(finale.generation, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettore: l\'autorita\' puo\' arrivare anche dal chiamante (altro processo): lancio.generation', () => {
  const root = tmpRoot(); const dir = path.join(root, 'cloud-T');
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminaleGen(0)), true);
    const leggi = (lancio) => activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', lancio);
    assert.equal(leggi({ launchId: LAUNCH, generation: 0 }).state, 'submitted', 'generazione coincidente');
    assert.deepEqual(leggi({ launchId: LAUNCH, generation: 1 }),
      { state: 'unknown', reason: 'generation-not-recorded', launchId: LAUNCH, generation: 1 });
    // Un record PIU' NUOVO del contesto del chiamante non e' contraddetto da esso.
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminaleGen(2, { state: 'unknown', reason: 'delivery-unknown' })), true);
    assert.equal(leggi({ launchId: LAUNCH, generation: 1 }).generation, 2);
    // Una generazione dichiarata non valida e' un input invalido, non un'assenza.
    for (const generation of [-1, 1.5, '1', NaN]) {
      assert.equal(leggi({ launchId: LAUNCH, generation }), null, String(generation));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Fix R2: ogni conclusione del proprietario chiude il pending ammesso ----------
const letto = (root) => activityFiles.leggiRecordPrompt(path.join(root, 'cloud-T'), LAUNCH);
const CUSTOM = { client: '', submit: true };
function conConsegnaBloccata(root, { config, esito, cancellaDue = false }) {
  // Il proprietario e' DENTRO la consegna quando arriva il cancel; poi la
  // consegna ritorna `esito`.
  let entrato; let rilascia;
  const dentro = new Promise((r) => { entrato = r; });
  const finita = new Promise((r) => { rilascia = r; });
  const blocca = async () => { entrato(); return finita; };
  const a = ammissione(root, {
    config,
    over: config.submit
      ? { submitPromptWithEnter: blocca, attestBracketedPaste: () => ({ attested: true }) }
      : { deliverBootstrapPrompt: blocca },
  });
  return {
    a,
    async esegui() {
      const run = a.fire();
      await dentro;
      a.ctl.cancel();
      if (cancellaDue) a.ctl.cancel();
      rilascia(esito);
      await run; await a.ctl.settled;
    },
  };
}

test('cancel PRIMA del timer: il pending ammesso si chiude skipped/cancelled-pre-paste (e la doppia cancel e\' inerte)', async () => {
  const root = tmpRoot();
  try {
    const a = ammissione(root);
    assert.equal(letto(root).state, 'pending');
    a.ctl.cancel();
    await a.ctl.settled;
    const chiuso = letto(root);
    assert.equal(chiuso.state, 'skipped');
    assert.equal(chiuso.reason, 'cancelled-pre-paste');
    assert.equal(chiuso.generation, 0);
    const bytes = fs.readFileSync(path.join(root, 'cloud-T', `prompt-${LAUNCH}.json`), 'utf8');
    a.ctl.cancel();
    assert.equal(fs.readFileSync(path.join(root, 'cloud-T', `prompt-${LAUNCH}.json`), 'utf8'), bytes, 'seconda cancel: nulla di nuovo');
    assert.deepEqual(a.errs, [], 'nessuna riga di errore');
    assert.equal(a.consegne.length, 0, 'zero paste');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel prima del timer con pending NON persistito: nessuna scrittura tentata, nessun rumore', async () => {
  const root = tmpRoot(); const dir = path.join(root, 'cloud-T');
  try {
    const ripristina = rotturaApertura(dir);
    let a;
    try { a = ammissione(root); } finally { ripristina(); }
    const prima = a.errs.length;
    a.ctl.cancel(); await a.ctl.settled;
    assert.equal(a.errs.length, prima, 'nessuna seconda riga «not persisted»');
    assert.equal(letto(root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancel di una generazione SUPERATA: non scrive sulla generazione nuova', async () => {
  const root = tmpRoot();
  try {
    const gate = { ultimaGenerazioneAmmessa: -1 };
    const vecchia = ammissione(root, { generation: 0, gate });
    const nuova = ammissione(root, { generation: 1, gate });
    assert.equal(letto(root).generation, 1);
    const bytes = fs.readFileSync(path.join(root, 'cloud-T', `prompt-${LAUNCH}.json`), 'utf8');
    vecchia.ctl.cancel(); await vecchia.ctl.settled;
    assert.equal(fs.readFileSync(path.join(root, 'cloud-T', `prompt-${LAUNCH}.json`), 'utf8'), bytes);
    assert.deepEqual(vecchia.errs, [], 'nessun rumore dalla vecchia');
    nuova.ctl.cancel(); await nuova.ctl.settled;
    assert.equal(letto(root).reason, 'cancelled-pre-paste');
    assert.equal(letto(root).generation, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('child uscito prima del timer: il pending si chiude cancelled-pre-paste, zero paste', async () => {
  const root = tmpRoot();
  try {
    const a = ammissione(root, { child: { exited: true } });
    await a.fire(); await a.ctl.settled;
    assert.equal(letto(root).state, 'skipped');
    assert.equal(letto(root).reason, 'cancelled-pre-paste');
    assert.equal(a.consegne.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('submit custom cancellato con esito certo pre-paste -> skipped/cancelled-pre-paste', async () => {
  const root = tmpRoot();
  try {
    const w = conConsegnaBloccata(root, { config: CUSTOM, esito: { state: 'cancelled' } });
    await w.esegui();
    assert.equal(letto(root).state, 'skipped');
    assert.equal(letto(root).reason, 'cancelled-pre-paste');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('submit custom cancellato due volte, esito certo pre-paste: un solo terminale', async () => {
  const root = tmpRoot();
  try {
    const w = conConsegnaBloccata(root, { config: CUSTOM, esito: { state: 'cancelled' }, cancellaDue: true });
    await w.esegui();
    assert.equal(letto(root).state, 'skipped');
    assert.equal(letto(root).reason, 'cancelled-pre-paste');
    assert.deepEqual(w.a.errs, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const stato of ['delivery-unknown', 'staged-not-submitted']) {
  test(`submit custom cancellato con effetti possibili (${stato}) -> unknown/${stato}`, async () => {
    const root = tmpRoot();
    try {
      const w = conConsegnaBloccata(root, { config: CUSTOM, esito: { state: stato } });
      await w.esegui();
      assert.equal(letto(root).state, 'unknown');
      assert.equal(letto(root).reason, stato);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('controllo positivo: il percorso classificato cancellato post-paste chiude unknown', async () => {
  const root = tmpRoot();
  try {
    const w = conConsegnaBloccata(root, { config: {}, esito: { state: 'delivery-unknown' } });
    await w.esegui();
    assert.equal(letto(root).state, 'unknown');
    assert.equal(letto(root).reason, 'delivery-unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// reprompt:false: lo stage del paste decide; uno stage ignoto non attesta nulla.
async function repromptFalse(root, res, { cancella = false } = {}) {
  let entrato; let rilascia;
  const dentro = new Promise((r) => { entrato = r; });
  const finita = new Promise((r) => { rilascia = r; });
  const a = ammissione(root, {
    config: { client: '', reprompt: false },
    over: { securePaste: async () => { entrato(); return finita; } },
  });
  const run = a.fire();
  await dentro;
  if (cancella) a.ctl.cancel();
  rilascia(res);
  await run; await a.ctl.settled;
  return a;
}

for (const [nome, res, atteso] of [
  ['stage ignoto', { ok: false, stage: 'strano' }, { state: 'unknown' }],
  ['stage assente', { ok: false }, { state: 'unknown' }],
  ['stage paste', { ok: false, stage: 'paste' }, { state: 'unknown', reason: 'delivery-unknown' }],
  ['stage pre-paste', { ok: false, stage: 'load' }, { state: 'skipped', reason: 'failed-pre-paste-load' }],
]) {
  test(`reprompt:false, ${nome} -> il terminale non resta pending`, async () => {
    const root = tmpRoot();
    try {
      await repromptFalse(root, res);
      const r = letto(root);
      assert.equal(r.state, atteso.state);
      assert.equal(r.reason, atteso.reason);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('reprompt:false cancellato con stage ignoto -> unknown, non pending', async () => {
  const root = tmpRoot();
  try {
    await repromptFalse(root, { ok: false, stage: 'strano' }, { cancella: true });
    assert.equal(letto(root).state, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
