'use strict';
// 0.9.80 strato 2b — record durevole dell'esito della consegna del prompt:
// schema chiuso, permessi, durabilita' (fsync file + rename + fsync dir),
// lettore legato all'autorita' del lancio, transizioni monotone per
// generazione, tabella canonica C3, retention. Nessun testo del prompt,
// argv, capture o errore grezzo nel record: solo scalari whitelisted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const activityFiles = require('../lib/files/activity.js');
const {
  validLaunchId, validPromptRecord, PROMPT_STATES, nomeRecordPrompt,
} = require('../lib/fleet/prompt-outcome.js');
const { fakeDurableFs } = require('./helpers/fake-durable-fs.js');

const LAUNCH = 'a1b2c3d4e5f60718';
const SECRET = 'SECRET-PROMPT-MARKER-xyz';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prompt-outcome-'));
}
function dirSessione(root, sessione = 'cloud-T') {
  return path.join(root, sessione);
}
function pending(over = {}) {
  return {
    version: 1, event: 'prompt-delivery', launchId: LAUNCH, generation: 0,
    state: 'pending', ts: 1700000000000, deadlineTs: 1700000020400, ...over,
  };
}
// Il terminale non porta deadlineTs (solo il pending lo ha): fixture senza.
function terminale(over = {}) {
  const { deadlineTs, ...resto } = pending(over);
  return resto;
}
function leggiGrezzo(dir, launchId = LAUNCH) {
  return JSON.parse(fs.readFileSync(path.join(dir, nomeRecordPrompt(launchId)), 'utf8'));
}
function chiaviEsatte(record) {
  return Object.keys(record).sort();
}

// --- 1. Round-trip per ognuno dei quattro stati; nessuna chiave extra -------
test('record: round-trip dei quattro stati, chiavi esatte, nessuna extra accettata', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    const casi = [
      [pending(), ['deadlineTs', 'event', 'generation', 'launchId', 'state', 'ts', 'version']],
      [terminale({ state: 'submitted' }), ['event', 'generation', 'launchId', 'state', 'ts', 'version']],
      [terminale({ state: 'skipped', reason: 'not-ready', notReady: 'not-ready-auth' }),
        ['event', 'generation', 'launchId', 'notReady', 'reason', 'state', 'ts', 'version']],
      [terminale({ state: 'unknown', reason: 'delivery-unknown' }),
        ['event', 'generation', 'launchId', 'reason', 'state', 'ts', 'version']],
    ];
    for (const [record, chiavi] of casi) {
      assert.equal(activityFiles.scriviRecordPrompt(dir, record), true, record.state);
      const suDisco = leggiGrezzo(dir);
      assert.deepEqual(chiaviEsatte(suDisco), chiavi);
      assert.equal(suDisco.state, record.state);
      // La ripubblicazione identica dello stesso pending non riscrive il file.
    }
    assert.equal(PROMPT_STATES.length, 4);
    // Chiave in piu' in qualunque stato: rifiuto, nessun effetto.
    const prima = fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mtimeMs;
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ extra: 1 })), false);
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ state: 'submitted', prompt: 'x' })), false);
    assert.equal(
      fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mtimeMs, prima,
      'rifiuto senza toccare il file',
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 2. Campi fuori catalogo rifiutati in scrittura -------------------------
test('record: state/reason/notReady/version/event fuori catalogo rifiutati', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'delivered' })), false);
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'submitted', reason: 'submitted' })), false,
      'submitted non porta reason');
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ reason: 'not-ready' })), false,
      'pending non porta reason');
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'skipped', reason: 'free-text' })), false);
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'skipped', reason: 'delivery-unknown' })), false,
      'reason unknown su skipped rifiutato');
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'unknown', reason: 'not-ready' })), false,
      'reason skipped su unknown rifiutato');
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'skipped', reason: 'not-ready', notReady: 'whatever' })), false);
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ notReady: 'not-ready-auth' })), false,
      'notReady solo con skipped');
    assert.equal(activityFiles.scriviRecordPrompt(dir, { ...terminale({ state: 'submitted' }), deadlineTs: 1 }), false,
      'deadlineTs solo con pending');
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ deadlineTs: 1699999999999 })), false,
      'deadlineTs precedente a ts rifiutato');
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ version: 2 })), false);
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ event: 'terminal-stop' })), false);
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ ts: 'x' })), false);
    assert.equal(validPromptRecord(terminale({ state: 'skipped', reason: 'deadline-exceeded' })), true,
      'deadline-exceeded ammesso su skipped (zero paste attestato)');
    assert.equal(validPromptRecord(terminale({ state: 'unknown', reason: 'deadline-exceeded' })), true);
    assert.equal(fs.existsSync(dir), false, 'nessun file né directory per un record rifiutato');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 3. launchId ostile ------------------------------------------------------
test('record: launchId ostile rifiutato, nessun file creato', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  const ostili = ['..', 'a/b', 'a\\b', '', 123, null, 'x\0y', 'a\rb', 'a\nb', 'x'.repeat(129), '.'];
  try {
    for (const id of ostili) {
      assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ launchId: id })), false, JSON.stringify(id));
      assert.equal(validLaunchId(id), false, JSON.stringify(id));
    }
    assert.equal(validLaunchId(LAUNCH), true);
    assert.equal(validLaunchId('a'.repeat(128)), true, '128 ammesso');
    assert.equal(fs.existsSync(dir), false, 'nessuna directory creata');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 4. generation -----------------------------------------------------------
test('record: generation negativa/frazionaria/non-safe-integer/stringa rifiutata', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    for (const generation of [-1, 1.5, '0', NaN, Infinity, 2 ** 53, null]) {
      assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ generation })), false, String(generation));
    }
    const senza = pending(); delete senza.generation;
    assert.equal(activityFiles.scriviRecordPrompt(dir, senza), false, 'generation obbligatoria');
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ generation: 0 })), true, 'zero ammesso');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- 5. Permessi: 0600 sul file, 0700 sulla directory (umask 022) -------------
test('record: file 0600 e directory 0700 anche quando la directory nasce dalla scrittura', () => {
  const vecchiaUmask = process.umask(0o022);
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending()), true);
    assert.equal((fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mode & 0o777), 0o600);
    assert.equal((fs.statSync(dir).mode & 0o777), 0o700, 'directory creata dalla scrittura: 0700');
    // Una directory ESISTENTE non cambia modo.
    const dir2 = path.join(root, 'esistente');
    fs.mkdirSync(dir2, { mode: 0o755 });
    assert.equal(activityFiles.scriviRecordPrompt(dir2, pending({ launchId: 'b'.repeat(16) })), true);
    assert.equal((fs.statSync(dir2).mode & 0o777), 0o755, 'il modo di una directory esistente non si tocca');
  } finally {
    process.umask(vecchiaUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- 6. Durabilità: ordine delle chiamate e failure injection -----------------
test('scriviDurabile: ordine tmp wx -> write -> fsync(file) -> close -> rename -> fsync(dir)', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const f = fakeDurableFs({ dir });
    assert.equal(activityFiles.scriviDurabile(dir, nomeRecordPrompt(LAUNCH), '{}\n', { fsImpl: f }), true);
    const seq = f.__calls.map((c) => c[0]).filter((k) => k !== 'stat' && k !== 'mkdir' && k !== 'unlink');
    assert.deepEqual(seq, ['open-wx', 'write', 'fsync-file', 'close', 'rename', 'open', 'fsync-dir', 'close'],
      'ordine esatto della sequenza durevole');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scriviDurabile: ogni fallimento iniettato -> false, nessun residuo', () => {
  for (const fail of ['open', 'write', 'fsync', 'rename', 'dirfsync']) {
    const root = tmpRoot(); const dir = dirSessione(root);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const f = fakeDurableFs({ dir, fail });
      assert.equal(activityFiles.scriviDurabile(dir, nomeRecordPrompt(LAUNCH), '{}\n', { fsImpl: f }), false, fail);
      const residui = fs.readdirSync(dir);
      assert.equal(residui.some((n) => n.endsWith('.tmp')), false, `${fail}: temporaneo pulito`);
      if (fail !== 'dirfsync') {
        assert.equal(residui.includes(nomeRecordPrompt(LAUNCH)), false,
          `${fail}: nessuna destinazione (rename non avvenuto)`);
      } else {
        // Emendamento trasversale 1: dopo un rename riuscito con fsync della
        // directory fallito la destinazione PUO' essere visibile. L'esito e'
        // false = durabilita' non attestata; il temporaneo e' pulito e la
        // destinazione NON si cancella alla cieca.
        assert.equal(residui.includes(nomeRecordPrompt(LAUNCH)), true, 'dirfsync: destinazione visibile, non cancellata');
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// --- 7. Nessun contenuto grezzo nel file --------------------------------------
test('record: nessun testo del prompt nel file, solo chiavi ammesse', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    // Il record si costruisce solo da scalari whitelisted: un oggetto di
    // ritorno della consegna non si spalma mai nel record.
    const resultConsegna = { delivered: true, state: 'skipped-not-ready', notReady: 'not-ready-auth', attempts: 2, reason: 'skipped-not-ready', prompt: SECRET };
    const record = {
      version: 1, event: 'prompt-delivery', launchId: LAUNCH, generation: 0,
      state: 'skipped', reason: 'not-ready', notReady: resultConsegna.notReady, ts: 1,
    };
    assert.equal(activityFiles.scriviRecordPrompt(dir, record), true);
    const raw = fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8');
    assert.ok(!raw.includes(SECRET), 'il marker del prompt non finisce nel file');
    assert.deepEqual(chiaviEsatte(leggiGrezzo(dir)),
      ['event', 'generation', 'launchId', 'notReady', 'reason', 'state', 'ts', 'version']);
    // Ogni valore extra del risultato della consegna e' rifiutato dallo schema.
    for (const k of ['delivered', 'attempts', 'prompt']) {
      assert.equal(activityFiles.scriviRecordPrompt(dir, { ...record, [k]: resultConsegna[k] }), false, k);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
