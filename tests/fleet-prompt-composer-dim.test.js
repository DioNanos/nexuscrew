'use strict';
// 0.9.83 strato S6 — il composer vuoto di Claude Code 2.1.319 mostra un
// suggerimento in DIM (SGR 2) dopo `❯ NBSP`: il contratto del 2026-11-08
// (qualificato su 2.1.289, senza placeholder) lo classificava `unknown` e la
// consegna del prompt scadeva senza mai incollare. Le fixture sono i byte
// reali delle catture del 2026-11-09 (pane 90x29), ricostruiti dagli appunti
// con gli ESC: `ESC[39m ❯ NBSP ESC[2m Try "fix lint errors" ESC[0m` e la riga
// al lavoro `ESC[38;5;246m ❯ NBSP ESC[39m`. Nessun dato personale.
//
// Regola: DIM = suggerimento SOLO se e' tutto dim fino a fine regione e la
// riga chiude con un reset; qualunque carattere non-dim = non vuoto. Niente
// whitelist sul testo del suggerimento (il testo cambia).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  composerOccupied, CLAUDE_CODE_COMPOSER_CONTRACT,
} = require('../lib/fleet/prompt-delivery.js');
const {
  canonicalOutcome, validPromptRecord, nomeRecordPrompt,
} = require('../lib/fleet/prompt-outcome.js');
const {
  scriviRecordPrompt, leggiRecordPrompt,
} = require('../lib/files/activity.js');

const BORDO = `\u001b[38;5;244m${'─'.repeat(90)}`;
const COMPOSER_VUOTO_211289 = `${BORDO}\n\u001b[39m❯ \n${BORDO}\n`;
const COMPOSER_VUOTO_21319 = `${BORDO}\n\u001b[39m❯ \u001b[2mTry "fix lint errors"\u001b[0m\n${BORDO}\n`;
const COMPOSER_AL_LAVORO_21319 = `${BORDO}\n\u001b[38;5;246m❯ \u001b[39m\n${BORDO}\n`;
const TESTO_DIGITATO = `${BORDO}\n\u001b[39m❯ abc\n${BORDO}\n`;
const DIM_POI_DIGITATO = `${BORDO}\n\u001b[39m❯ \u001b[2mTry "fix lint errors"\u001b[0mabc\n${BORDO}\n`;
const DIM_POI_COLORATO = `${BORDO}\n\u001b[39m❯ \u001b[2mTry "fix lint errors"\u001b[31mX\u001b[0m\n${BORDO}\n`;
const DIGITATO_POI_DIM = `${BORDO}\n\u001b[39m❯ abc\u001b[2mtail\u001b[0m\n${BORDO}\n`;
const SENZA_ATTRIBUTI = COMPOSER_VUOTO_21319.replace(/\u001b\[[0-9;]*m/g, '');

const LANCIO = '0123456789abcdef';
const T0 = 1794215000000;

function recordDi(generation, extra = {}) {
  return {
    version: 1, event: 'prompt-delivery', launchId: LANCIO, generation,
    state: 'skipped', reason: 'deadline-exceeded', ts: T0 + generation, ...extra,
  };
}

test('S6 T1: composer vuoto 2.1.319 con suggerimento DIM -> empty', () => {
  assert.equal(composerOccupied(COMPOSER_VUOTO_21319, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'empty');
  // la riga al lavoro (glifo grigio, nessun suggerimento) resta vuota
  assert.equal(composerOccupied(COMPOSER_AL_LAVORO_21319, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'empty');
});

test('S6 T2: testo digitato (attributi default) -> occupied, invariato', () => {
  assert.equal(composerOccupied(TESTO_DIGITATO, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'occupied');
});

test('S6 T3: DIM seguito da testo non-dim -> occupied o unknown, MAI empty', () => {
  for (const [nome, cattura] of [
    ['dim poi digitato', DIM_POI_DIGITATO],
    ['dim poi colorato', DIM_POI_COLORATO],
    ['digitato poi dim', DIGITATO_POI_DIM],
  ]) {
    const stato = composerOccupied(cattura, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT);
    assert.notEqual(stato, 'empty', `${nome}: mai empty con contenuto non-dim`);
    assert.ok(stato === 'occupied' || stato === 'unknown', `${nome}: ${stato}`);
  }
});

test('S6 T4: composer vuoto 2.1.289 (contratto 2026-11-08) -> empty invariato', () => {
  assert.equal(composerOccupied(COMPOSER_VUOTO_211289, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'empty');
});

test('S6 T5: attributi persi (cattura senza -e) -> unknown invariato', () => {
  assert.equal(composerOccupied(SENZA_ATTRIBUTI, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'unknown');
  assert.equal(composerOccupied(SENZA_ATTRIBUTI, 'claude', undefined), 'unknown');
});

test('S6 T6: alla scadenza il record porta notReady, deadlinePhase e deadlineTs', () => {
  const esito = canonicalOutcome({
    state: 'skipped-unknown', notReady: 'busy', deadlineExceeded: true, deadlinePhase: 'capture',
  });
  assert.equal(esito.state, 'skipped');
  assert.equal(esito.reason, 'deadline-exceeded');
  assert.equal(esito.notReady, 'busy');
  assert.equal(esito.deadlinePhase, 'capture');
  // senza kind qualificato il campo c'e' comunque: 'unknown', mai assente
  const senzaKind = canonicalOutcome({ state: 'skipped-unknown', deadlineExceeded: true });
  assert.equal(senzaKind.notReady, 'unknown');
  // e lo schema accetta il terminale con i campi della scadenza
  const record = recordDi(1, { notReady: 'busy', deadlinePhase: 'capture', deadlineTs: T0 + 1000 });
  assert.equal(validPromptRecord(record), true);
  assert.equal(validPromptRecord({ ...record, deadlinePhase: 'not a phase!' }), false);
  // Il terminale si scrive DOPO il limite che l'ha prodotto: ts > deadlineTs e'
  // la forma normale di un terminale scaduto, non un record guasto. Il vincolo
  // e' del solo pending, dove il limite e' ancora DAVANTI: li' deadlineTs >= ts,
  // e un pending con il limite gia' passato e' un record incoerente.
  assert.equal(validPromptRecord({ ...record, deadlineTs: T0 - 1 }), true,
    'terminale scritto dopo il proprio limite rifiutato');
  assert.equal(validPromptRecord({ ...record, deadlineTs: 'x' }), false,
    'deadlineTs non finito ammesso');
  assert.equal(validPromptRecord(recordDi(1, { notReady: 'unknown' })), true);
});

test('S6 T7: la storia conserva ogni generation; lo stato corrente resta l ultima', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s6-storia-'));
  try {
    const g0 = recordDi(0);
    const g1 = { ...recordDi(1), state: 'submitted', reason: undefined };
    delete g1.reason;
    assert.equal(scriviRecordPrompt(dir, g0), true, 'generation 0 scritta');
    assert.equal(scriviRecordPrompt(dir, g1), true, 'generation 1 scritta');
    const corrente = leggiRecordPrompt(dir, LANCIO);
    assert.equal(corrente.state, 'submitted', 'il lettore corrente vede l ultima');
    assert.equal(corrente.generation, 1);
    const storia = require('../lib/files/activity.js').leggiStoriaPrompt(dir, LANCIO);
    assert.ok(storia, 'storia leggibile');
    assert.deepEqual(storia.generations.map((r) => r.generation), [0, 1]);
    assert.equal(storia.generations[0].reason, 'deadline-exceeded', 'la generation 0 resta leggibile');
    assert.equal(fs.readFileSync(path.join(dir, nomeRecordPrompt(LANCIO)), 'utf8').includes('"generation":1'), true);
    // fuori ordine resta rifiutato
    assert.equal(scriviRecordPrompt(dir, recordDi(0)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
