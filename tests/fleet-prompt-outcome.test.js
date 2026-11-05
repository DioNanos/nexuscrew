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
    // Un lancio diverso per stato: la macchina delle transizioni (provata piu'
    // sotto) rende immutabile il terminale di uno stesso lancio.
    const casi = [
      [pending(), ['deadlineTs', 'event', 'generation', 'launchId', 'state', 'ts', 'version']],
      [terminale({ launchId: 'b'.repeat(16), state: 'submitted' }), ['event', 'generation', 'launchId', 'state', 'ts', 'version']],
      [terminale({ launchId: 'c'.repeat(16), state: 'skipped', reason: 'not-ready', notReady: 'not-ready-auth' }),
        ['event', 'generation', 'launchId', 'notReady', 'reason', 'state', 'ts', 'version']],
      [terminale({ launchId: 'd'.repeat(16), state: 'unknown', reason: 'delivery-unknown' }),
        ['event', 'generation', 'launchId', 'reason', 'state', 'ts', 'version']],
    ];
    for (const [record, chiavi] of casi) {
      assert.equal(activityFiles.scriviRecordPrompt(dir, record), true, record.state);
      const suDisco = leggiGrezzo(dir, record.launchId);
      assert.deepEqual(chiaviEsatte(suDisco), chiavi);
      assert.equal(suDisco.state, record.state);
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

// ===========================================================================
// Lettore legato all'autorita' del lancio corrente (per IDENTITA', mai
// attraverso il selettore, mai condizionato dal canale attivita').
// ===========================================================================
const VECCHIO = 'b'.repeat(16);
const CORRENTE = 'c'.repeat(16);

test('lettore: assente -> absent; rotto -> unknown/record-broken; mai un esito dal rotto', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    // Assenza VERIFICATA (ENOENT): absent, che non e' uno stato di consegna.
    assert.deepEqual(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: CORRENTE }),
      { state: 'absent', launchId: CORRENTE });
    // Rotto: JSON invalido, versione sbagliata, chiave in piu', launchId del
    // contenuto diverso dal nome. Mai submitted/skipped da un record rotto.
    for (const [nome, contenuto] of [
      ['json-invalido', '{'],
      ['versione-sbagliata', JSON.stringify({ ...pending(), version: 2 })],
      ['chiave-in-piu', JSON.stringify({ ...pending(), extra: 1 })],
      ['launchId-diverso', JSON.stringify(pending({ launchId: VECCHIO }))],
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, nomeRecordPrompt(CORRENTE)), contenuto);
      assert.deepEqual(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: CORRENTE }),
        { state: 'unknown', reason: 'record-broken', launchId: CORRENTE }, nome);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // leggiRecordPrompt: stessa validazione stretta, null per assente/rotto.
    assert.equal(activityFiles.leggiRecordPrompt(dir, CORRENTE), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettore: tuple del record per identita\', anche con canale attivita\' off', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ launchId: VECCHIO, state: 'submitted' })), true);
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ launchId: CORRENTE, state: 'skipped', reason: 'not-ready', notReady: 'not-ready-auth' })), true);
    // Il record del lancio corrente, PER IDENTITA': mai quello di un lancio
    // vecchio, mai attraverso il selettore launch-current.
    const letto = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: CORRENTE, canale: 'off' });
    assert.deepEqual(letto, {
      launchId: CORRENTE, generation: 0, state: 'skipped',
      reason: 'not-ready', notReady: 'not-ready-auth', ts: 1700000000000,
    });
    // Un terzo lancio non vede il record degli altri due.
    assert.deepEqual(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: 'd'.repeat(16) }),
      { state: 'absent', launchId: 'd'.repeat(16) });
    // leggiRecordPrompt: la stessa tupla.
    assert.deepEqual(activityFiles.leggiRecordPrompt(dir, CORRENTE), letto);
    // Input invalidi: null, mai un absent inventato.
    assert.equal(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', null), null);
    assert.equal(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', {}), null);
    assert.equal(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: '../x' }), null);
    assert.equal(activityFiles.leggiEsitoPromptCorrente(root, '../altro', { launchId: CORRENTE }), null);
    assert.equal(activityFiles.leggiEsitoPromptCorrente('', 'cloud-T', { launchId: CORRENTE }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettore: pending oltre deadlineTs+2000 -> unknown/deadline-exceeded, senza riscrittura', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    const adesso = Date.now();
    const scaduto = pending({ ts: adesso - 10000, deadlineTs: adesso - 4000 });
    assert.equal(activityFiles.scriviRecordPrompt(dir, scaduto), true);
    const prima = fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8');
    const mtimePrima = fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mtimeMs;
    assert.deepEqual(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH }), {
      state: 'unknown', reason: 'deadline-exceeded', launchId: LAUNCH,
      generation: 0, ts: scaduto.ts,
    });
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima,
      'il record non si riscrive in lettura');
    assert.equal(fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mtimeMs, mtimePrima);
    // Clock civile incoerente (ts nel futuro): unknown bounded, non pending eterno.
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ ts: adesso + 600000, deadlineTs: adesso + 604000 })), true);
    assert.deepEqual(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH }), {
      state: 'unknown', reason: 'deadline-exceeded', launchId: LAUNCH,
      generation: 0, ts: adesso + 600000,
    });
    // Un terminale realmente persistito DOPO resta leggibile.
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'submitted' })), true);
    assert.equal(activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH }).state, 'submitted');
    // Pending NON scaduto: resta pending in lettura.
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ launchId: VECCHIO, ts: adesso, deadlineTs: adesso + 60000 })), true);
    const vivo = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: VECCHIO });
    assert.equal(vivo.state, 'pending');
    assert.equal(vivo.deadlineTs, adesso + 60000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lettura: non crea, non modifica e non pota nulla', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'submitted' })), true);
    fs.writeFileSync(path.join(dir, 'file-altrui.json'), '{}\n');
    const prima = fs.readdirSync(dir).sort();
    const mtime = new Map(prima.map((n) => [n, fs.statSync(path.join(dir, n)).mtimeMs]));
    activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: 'zz'.repeat(8) });
    activityFiles.leggiEsitoPromptCorrente(root, 'sessione-che-non-esiste', { launchId: LAUNCH });
    activityFiles.leggiRecordPrompt(dir, LAUNCH);
    assert.deepEqual(fs.readdirSync(dir).sort(), prima);
    for (const n of prima) {
      assert.equal(fs.statSync(path.join(dir, n)).mtimeMs, mtime.get(n), `${n} non toccato`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ===========================================================================
// Tabella C3: UNA funzione pura mappa l'esito del proprietario della consegna
// nello stato canonico del record. Nessun secondo posto nel codice mappa.
// ===========================================================================
const { canonicalOutcome } = require('../lib/fleet/prompt-outcome.js');
const { DELIVERY_STATES } = require('../lib/fleet/prompt-delivery.js');

test('C3: tabella esaustiva, nessun submitted fuori da submitted', () => {
  const NA = 'not-applicable';
  const casi = [
    [{ state: 'submitted' }, { state: 'submitted' }, NA],
    [{ state: 'staged-not-submitted' }, { state: 'unknown', reason: 'staged-not-submitted' }, NA],
    [{ state: 'delivery-unknown' }, { state: 'unknown', reason: 'delivery-unknown' }, NA],
    [{ state: 'failed-pre-paste' }, { state: 'skipped', reason: 'failed-pre-paste' }, NA],
    [{ state: 'skipped-not-ready', notReady: 'not-ready-auth' }, { state: 'skipped', reason: 'not-ready', notReady: 'not-ready-auth' }, NA],
    [{ state: 'skipped-not-ready' }, { state: 'skipped', reason: 'not-ready' }, NA],
    [{ state: 'skipped-unknown', notReady: 'busy' }, { state: 'skipped', reason: 'not-ready', notReady: 'busy' }, NA],
    [{ state: 'skipped-unknown' }, { state: 'skipped', reason: 'not-ready' }, NA],
    // deadlineExceeded con zero paste attestato: reason deadline-exceeded, kind conservato.
    [{ state: 'skipped-unknown', notReady: 'busy', deadlineExceeded: true }, { state: 'skipped', reason: 'deadline-exceeded', notReady: 'busy' }, NA],
    [{ state: 'skipped-vl-bootstrap', notReady: 'claim-taken' }, { state: 'skipped', reason: 'vl-bootstrap-claim-taken' }, NA],
    [{ state: 'skipped-vl-bootstrap' }, { state: 'skipped', reason: 'vl-bootstrap-no-proof' }, NA],
    [{ state: 'prompt-rejected' }, { state: 'skipped', reason: 'prompt-rejected' }, NA],
    [{ state: 'cancelled' }, { state: 'skipped', reason: 'cancelled-pre-paste' }, NA],
    [{ state: 'report-timeout' }, { state: 'unknown', reason: 'report-timeout' }, NA],
    [{ state: 'transport-unsupported' }, { state: 'skipped', reason: 'transport-unsupported' }, NA],
    [{ state: 'paste-delivered' }, { state: 'unknown', reason: 'paste-only-no-enter' }, NA],
    [{ state: 'paste-failed', stage: 'validate' }, { state: 'skipped', reason: 'failed-pre-paste-validate' }, NA],
    [{ state: 'paste-failed', stage: 'resolve' }, { state: 'skipped', reason: 'failed-pre-paste-resolve' }, NA],
    [{ state: 'paste-failed', stage: 'load' }, { state: 'skipped', reason: 'failed-pre-paste-load' }, NA],
    [{ state: 'paste-failed' }, { state: 'skipped', reason: 'failed-pre-paste' }, NA],
    [{ state: 'paste-failed', stage: 'garbage' }, { state: 'skipped', reason: 'failed-pre-paste' }, NA],
    // Valore non riconosciuto: unknown, mai un successo per deduzione.
    [{ state: 'delivered' }, { state: 'unknown' }, NA],
    [{ state: '' }, { state: 'unknown' }, NA],
    [null, { state: 'unknown' }, NA],
    // claim: il terminale vl si compone DOPO il settle (un tentativo).
    [{ state: 'submitted' }, { state: 'submitted' }, 'settled'],
    [{ state: 'submitted' }, { state: 'unknown', reason: 'claim-settle-failed' }, 'failed'],
    // claim non aggiornata vince anche su un fallimento certo pre-paste.
    [{ state: 'failed-pre-paste' }, { state: 'unknown', reason: 'claim-settle-failed' }, 'failed'],
    [{ state: 'skipped-unknown' }, { state: 'unknown', reason: 'claim-settle-failed' }, 'failed'],
    // claim fuori catalogo: conservativo, mai un attestato.
    [{ state: 'submitted' }, { state: 'unknown', reason: 'claim-settle-failed' }, 'x'],
  ];
  for (const [sorgente, atteso, claim] of casi) {
    assert.deepEqual(canonicalOutcome(sorgente, claim), atteso, JSON.stringify(sorgente));
  }
  // Ogni valore dell'enum di consegna ha una riga: nessuno produce submitted
  // fuori da submitted, con qualunque claim ammesso.
  for (const state of DELIVERY_STATES) {
    for (const claim of [NA, 'settled', 'failed']) {
      const esito = canonicalOutcome({ state }, claim);
      if (state !== 'submitted' || claim === 'failed') {
        assert.notEqual(esito.state, 'submitted', `${state}/${claim} non e' mai submitted`);
      }
    }
  }
  // Il canonico entra nello schema del record senza ritocchi.
  for (const state of DELIVERY_STATES) {
    const c = canonicalOutcome({ state });
    assert.equal(validPromptRecord(terminale({
      ...c, launchId: 'e'.repeat(16),
    })), true, `${state} produce un record valido`);
  }
});

// ===========================================================================
// Macchina delle transizioni per generazione, sul disco (difesa per il
// riavvio): il file e' per lancio, la generazione arbitra.
// ===========================================================================
test('transizioni: pending->terminale ammesso, terminale immutabile e idempotente', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending()), true, 'pending gen0');
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'submitted' })), true,
      'pending -> terminale ammesso');
    const prima = fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8');
    const mtime = fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mtimeMs;
    // Ripubblicazione identica del terminale: true, file invariato.
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'submitted' })), true);
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima);
    assert.equal(fs.statSync(path.join(dir, nomeRecordPrompt(LAUNCH))).mtimeMs, mtime);
    // Terminale DIVERSO sulla stessa generazione: false, file invariato.
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ state: 'skipped', reason: 'not-ready' })), false);
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima);
    // pending dopo il terminale: false.
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending()), false);
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('transizioni: pending identico idempotente, pending diverso rifiutato', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending()), true);
    const prima = fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8');
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ ts: 1700000009999 })), true,
      'stesso pending (solo ts diverso): idempotente, file invariato');
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima);
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ deadlineTs: 1700000099999 })), false,
      'pending con deadline diversa sulla stessa generazione: rifiutato');
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('transizioni: generazione maggiore sostituisce, minore mai', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ generation: 0, state: 'submitted' })), true);
    // gen1 scrive il proprio pending nel MEDESIMO file: sostituisce.
    assert.equal(activityFiles.scriviRecordPrompt(dir, pending({ generation: 1 })), true);
    assert.equal(leggiGrezzo(dir).generation, 1);
    assert.equal(leggiGrezzo(dir).state, 'pending');
    // Scrittura tardiva di gen0 dopo l'ammissione di gen1: false, file invariato.
    const prima = fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8');
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ generation: 0, state: 'skipped', reason: 'not-ready' })), false);
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), 'utf8'), prima);
    // gen2 terminale: ammesso.
    assert.equal(activityFiles.scriviRecordPrompt(dir, terminale({ generation: 2, state: 'unknown', reason: 'delivery-unknown' })), true);
    assert.equal(leggiGrezzo(dir).state, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('record: pending senza deadlineTs rifiutato in scrittura e non leggibile come pending eterno', () => {
  const root = tmpRoot(); const dir = dirSessione(root);
  try {
    const senza = pending(); delete senza.deadlineTs;
    assert.equal(activityFiles.scriviRecordPrompt(dir, senza), false,
      'il pending richiede il suo limite di osservabilita\'');
    // Difesa in lettura: un file manomesso con pending senza deadline finito
    // non resta pending per sempre.
    fs.mkdirSync(dir, { recursive: true });
    const { deadlineTs, ...senzaDeadline } = pending();
    fs.writeFileSync(path.join(dir, nomeRecordPrompt(LAUNCH)), `${JSON.stringify(senzaDeadline)}\n`);
    const letto = activityFiles.leggiEsitoPromptCorrente(root, 'cloud-T', { launchId: LAUNCH });
    assert.equal(letto.state, 'unknown',
      'mai pending eterno: senza limite di osservabilita\' il record non e\' attestabile');
    assert.equal(letto.reason, 'record-broken',
      'via effettiva: lo schema rifiuta il pending senza deadline, la lettura lo dichiara rotto');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
