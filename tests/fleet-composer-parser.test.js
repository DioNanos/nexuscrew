'use strict';
// 0.9.80 strato 2a — parser del composer (C6): enum chiuso empty | occupied |
// unknown. Regole non negoziabili: lo stripping degli attributi non puo'
// trasformare un testo perso in empty; colore/tema sconosciuto, attributi
// assenti o caso indistinguibile -> unknown; perdita di informazione ->
// unknown; NESSUNA whitelist di frasi «Try ...»; il testo resta in memoria
// (mai in stato, log o risposta). Il riconoscimento del suggerimento grigio
// richiede un CONTRATTO QUALIFICATO con provenienza verificabile: le fixture
// sintetiche qualificano solo il simulatore dei test, MAI un client reale —
// senza contratto l'uscita e' unknown (guardia conservativa di 2a).
const { test } = require('node:test');
const assert = require('node:assert');

const { composerOccupied } = require('../lib/fleet/prompt-delivery.js');
const {
  SIM_CLAUDE_CONTRACT,
  CLAUDE_EMPTY, CLAUDE_EMPTY_WRAPPED, CLAUDE_PLACEHOLDER_PLUS_TYPED,
  CLAUDE_MULTILINE, CLAUDE_SPACES, CLAUDE_CURSOR_MOVED,
  CLAUDE_UNKNOWN_THEME, CLAUDE_NO_ATTRS, CLAUDE_BROKEN_ESCAPE,
  CLAUDE_BARE_PROMPT, CLAUDE_EMPTY_REGION, KIMI_BOX_EMPTY,
} = require('./helpers/composer-fixtures.js');

// Il contratto del simulatore porta la provenienza dichiarata: senza di essa
// non e' un contratto qualificato.
test('parser: il contratto del simulatore dichiara la provenienza (fixture sintetiche, non qualificano il cliente reale)', () => {
  assert.ok(typeof SIM_CLAUDE_CONTRACT.provenance === 'string' && SIM_CLAUDE_CONTRACT.provenance.length > 0,
    'provenienza obbligatoria');
  assert.match(SIM_CLAUDE_CONTRACT.provenance, /qualif(y|ies) no real client/i);
  assert.equal(SIM_CLAUDE_CONTRACT.client, 'claude');
});

test('parser: vuoto + suggerimento grigio (SGR) -> empty (solo con contratto qualificato)', () => {
  assert.equal(composerOccupied(CLAUDE_EMPTY, 'claude', SIM_CLAUDE_CONTRACT), 'empty');
  // regione completa con chrome sotto la riga vuota: il composer e' l'ultima riga ❯
  assert.equal(composerOccupied(CLAUDE_EMPTY_REGION, 'claude', SIM_CLAUDE_CONTRACT), 'empty');
  // placeholder che wrappa su due righe, tutto in grigio qualificato
  assert.equal(composerOccupied(CLAUDE_EMPTY_WRAPPED, 'claude', SIM_CLAUDE_CONTRACT), 'empty');
});

test('parser: testo digitato -> occupied; mai empty per deduzione', () => {
  assert.equal(composerOccupied(require('./helpers/composer-fixtures.js').CLAUDE_TYPED('build the logging module'), 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
  // piu' righe di input digitato
  assert.equal(composerOccupied(CLAUDE_MULTILINE, 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
  // spazi significativi digitati (nessun placeholder)
  assert.equal(composerOccupied(CLAUDE_SPACES, 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
  // cursore spostato dentro testo digitato
  assert.equal(composerOccupied(CLAUDE_CURSOR_MOVED, 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
  // suggerimento PIU' testo digitato: l'input umano vince
  assert.equal(composerOccupied(CLAUDE_PLACEHOLDER_PLUS_TYPED, 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
});

test('parser: senza contratto qualificato -> SEMPRE unknown (guardia conservativa 2a)', () => {
  // anche la fixture «vuota con suggerimento»: senza qualifica non si puo'
  // distinguere il placeholder dal testo digitato
  assert.equal(composerOccupied(CLAUDE_EMPTY, 'claude', undefined), 'unknown');
  assert.equal(composerOccupied(CLAUDE_EMPTY_REGION, 'claude', undefined), 'unknown');
  assert.equal(composerOccupied(require('./helpers/composer-fixtures.js').CLAUDE_TYPED('x'), 'claude', undefined), 'unknown');
  // contratto di un altro client
  assert.equal(composerOccupied(CLAUDE_EMPTY, 'claude', { ...SIM_CLAUDE_CONTRACT, client: 'kimi' }), 'unknown');
  // Kimi: nessun parser qualificato in 2a -> unknown, mai un parser Claude
  // travestito da Kimi (decisione 3)
  assert.equal(composerOccupied(KIMI_BOX_EMPTY, 'kimi', undefined), 'unknown');
  assert.equal(composerOccupied(KIMI_BOX_EMPTY, 'kimi', SIM_CLAUDE_CONTRACT), 'unknown');
  // client senza composer
  assert.equal(composerOccupied(CLAUDE_EMPTY, 'codex', SIM_CLAUDE_CONTRACT), 'unknown');
});

test('parser: escape mancanti / attributi persi o parziali -> unknown, mai empty', () => {
  // capture senza attributi (testo presente): perdita di informazione
  assert.equal(composerOccupied(CLAUDE_NO_ATTRS, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  // sequenza di escape troncata/malformata
  assert.equal(composerOccupied(CLAUDE_BROKEN_ESCAPE, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  // ANSI rimosso che lascerebbe «vuoto» un testo presente: NON empty
  const stripped = CLAUDE_EMPTY.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(stripped.includes('Try "create a util logging.py that..."'), true, 'fixture: il testo c era');
  assert.notEqual(composerOccupied(stripped, 'claude', SIM_CLAUDE_CONTRACT), 'empty');
});

test('parser: tema/colore sconosciuto -> unknown', () => {
  assert.equal(composerOccupied(CLAUDE_UNKNOWN_THEME, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
});

test('parser: composer vuoto SENZA placeholder -> unknown (rendering non qualificato)', () => {
  assert.equal(composerOccupied(CLAUDE_BARE_PROMPT, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
});

test('parser: input degradati (vuoto, non-stringa, nessun composer) -> unknown', () => {
  assert.equal(composerOccupied('', 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  assert.equal(composerOccupied(null, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  assert.equal(composerOccupied('nessun composer qui', 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
});

test('parser: nessun confronto fra due capture e nessuna whitelist di frasi', () => {
  // Il parser e' PURA su UNA capture: cambia il testo del placeholder grigio
  // (frase mai vista) e resta empty — non esiste whitelist «Try ...».
  const neverSeen = require('./helpers/composer-fixtures.js').CLAUDE_EMPTY
    .replace('Try "create a util logging.py that..."', 'una frase qualsiasi mai censita');
  assert.equal(composerOccupied(neverSeen, 'claude', SIM_CLAUDE_CONTRACT), 'empty');
});
