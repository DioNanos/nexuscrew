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

test('parser: superficie corrente non interpretabile MAI scavalcata da un vecchio prompt valido -> unknown', () => {
  const {
    CLAUDE_STALE_EMPTY_CURRENT_MALFORMED, CLAUDE_CURRENT_CLIPPED,
    CLAUDE_PARTIAL_ATTRS, CLAUDE_WRAPPED_MALFORMED_CONTINUATION,
  } = require('./helpers/composer-fixtures.js');
  // I pezzi da soli: il vecchio prompt qualificato e' empty, il composer
  // malformato da solo e' unknown. La COMBINAZIONE e' il caso del difetto:
  // la scansione all'indietro non puo' saltare la riga corrente malformata
  // per andare aleggere il prompt di prima.
  assert.equal(composerOccupied(CLAUDE_EMPTY, 'claude', SIM_CLAUDE_CONTRACT), 'empty');
  assert.equal(composerOccupied(CLAUDE_BROKEN_ESCAPE, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  // Vecchio prompt + riga vuota (chiude la sua regione) + composer corrente
  // con escape malformato: il glifo corrente c'e' ma l'attributo e' spezzato.
  // L'informazione persa NON autorizza «vuoto»: unknown.
  assert.equal(composerOccupied(CLAUDE_STALE_EMPTY_CURRENT_MALFORMED, 'claude', SIM_CLAUDE_CONTRACT), 'unknown',
    'un composer corrente illeggibile non puo' + ' diventare empty grazie a un prompt vecchio');
  // Clipping del composer corrente (capture che taglia a meta' escape).
  assert.equal(composerOccupied(CLAUDE_CURRENT_CLIPPED, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  // Attributi parziali: escape ben formato ma colore incompleto fuori contratto.
  assert.equal(composerOccupied(CLAUDE_PARTIAL_ATTRS, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
  // Wrapping non interpretabile: continuazione malformata sotto un composer valido.
  assert.equal(composerOccupied(CLAUDE_WRAPPED_MALFORMED_CONTINUATION, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
});

// ===========================================================================
// Cattura REALE del composer di Claude Code (2026-11-08) e contratto di
// produzione (lib/fleet/prompt-delivery.js). La fixture e' byte-identica
// alla cattura autorizzata; il contratto di produzione e' l'unico che
// qualifica il client reale.
// ===========================================================================
const { CLAUDE_CODE_COMPOSER_CONTRACT } = require('../lib/fleet/prompt-delivery.js');
const { createHash } = require('node:crypto');
const {
  CYAN, RESET, GRAY,
  REAL_CLAUDE_EMPTY_20261108, REAL_CLAUDE_TYPED_20261108,
} = require('./helpers/composer-fixtures.js');

// T10: la cattura reale con il contratto di produzione.
test('parser reale 2026-11-08: contratto di produzione esportato; vuoto (SGR39+glifo+NBSP, chiuso dal bordo) -> empty; testo digitato -> occupied', () => {
  // Il contratto di produzione del client claude deve esistere nel prodotto.
  assert.ok(CLAUDE_CODE_COMPOSER_CONTRACT, 'il contratto di produzione deve essere esportato');
  assert.equal(CLAUDE_CODE_COMPOSER_CONTRACT.client, 'claude');
  assert.equal(CLAUDE_CODE_COMPOSER_CONTRACT.emptyIsBlank, true, 'il rendering reale non mostra placeholder a vuoto');
  assert.deepEqual([...CLAUDE_CODE_COMPOSER_CONTRACT.placeholderAttrs], [], 'nessun placeholder dichiarato');
  // Fedelta' byte della fixture rispetto alla cattura dichiarata.
  assert.equal(
    createHash('md5').update(Buffer.from(REAL_CLAUDE_EMPTY_20261108, 'utf8')).digest('hex'),
    '8d90ceb873f8d0372f93db4ba83f2a48',
    'la fixture deve essere byte-identica alla cattura',
  );
  // Composer vuoto reale -> empty SOLO col contratto di produzione.
  assert.equal(composerOccupied(REAL_CLAUDE_EMPTY_20261108, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'empty');
  // Testo digitato dopo il separatore reale (NBSP, SGR 39 = default) -> occupied.
  assert.equal(composerOccupied(REAL_CLAUDE_TYPED_20261108('abc'), 'claude', CLAUDE_CODE_COMPOSER_CONTRACT), 'occupied');
});

// T11: contenuto digitato dopo il separatore NBSP -> occupied (verde prima
// e dopo l'introduzione del contratto reale).
test('parser: testo digitato dopo il separatore NBSP -> occupied (strip di UN solo separatore)', () => {
  // Rendering del simulatore (glifo ciano, run digitato a default): il
  // separatore NBSP non e' input, il contenuto dopo resta testo digitato.
  assert.equal(composerOccupied(`${CYAN}❯${RESET}\u00a0abc`, 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
  // Due separatori: il SECONDO NBSP e' contenuto digitato, non separatore.
  assert.equal(composerOccupied(`${CYAN}❯${RESET}\u00a0\u00a0abc`, 'claude', SIM_CLAUDE_CONTRACT), 'occupied');
});

// T12: suggerimento in attributi NON dichiarati -> unknown (guardia invariata).
test('parser: suggerimento in attributi non dichiarati dal contratto -> unknown', () => {
  // Contratto in forma di produzione (nessun placeholder dichiarato,
  // emptyIsBlank): il grigio del simulatore cade in attributi sconosciuti.
  const productionLike = Object.freeze({
    client: 'claude',
    provenance: 'synthetic test simulator, NC 0.9.80 s2a tests only — qualifies no real client',
    placeholderAttrs: Object.freeze([]),
    typedAttrs: Object.freeze(['']),
    emptyIsBlank: true,
  });
  assert.equal(
    composerOccupied(`${CYAN}❯${RESET} ${GRAY}Try "search the docs"${RESET}`, 'claude', productionLike),
    'unknown',
  );
  // Anche con il contratto di produzione, quando esistera'.
  if (CLAUDE_CODE_COMPOSER_CONTRACT) {
    assert.equal(
      composerOccupied(`${CYAN}❯${RESET} ${GRAY}Try "search the docs"${RESET}`, 'claude', CLAUDE_CODE_COMPOSER_CONTRACT),
      'unknown',
    );
  }
});

// T14: senza contratto resta unknown; senza emptyIsBlank resta unknown.
test('parser reale: senza contratto -> unknown; contratto senza emptyIsBlank -> unknown (guardia conservativa)', () => {
  assert.equal(composerOccupied(REAL_CLAUDE_EMPTY_20261108, 'claude', undefined), 'unknown');
  // Il contratto del simulatore non dichiara emptyIsBlank: il vuoto senza
  // placeholder resta rendering non qualificato.
  assert.equal(composerOccupied(REAL_CLAUDE_EMPTY_20261108, 'claude', SIM_CLAUDE_CONTRACT), 'unknown');
});
