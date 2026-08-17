'use strict';
// tests/peer-transitions.test.js — il registro delle transizioni di stato dei
// peer (lib/nodes/peer-transitions.js), scritto sul registro diagnostico GIA'
// esistente (lib/diagnostics/store.js): nessun nuovo store, nessun flusso
// nuovo, nessun polling in piu' — solo non scartare cio' che gia' arriva da
// lib/nodes/health.js a ogni richiesta della UI.
//
// Misurato il 2026-08-07: un nodo giu' per 25 minuti produceva ZERO record
// (nextSeq: 1, retained: 0). Non e' che il registro ne scriva pochi: non
// scrive affatto, perche' nessuno trattiene il risultato della sonda.
const test = require('node:test');
const assert = require('node:assert');
const { createDiagnostics } = require('../lib/diagnostics/store.js');
const { recordPeerTransition, clearPeerTransitions } = require('../lib/nodes/peer-transitions.js');

function health({ transport = 'up', auth = 'ok', reachability = 'ok' } = {}) {
  return { transport, auth, reachability, status: 'unknown', detail: '', at: 0 };
}

test.beforeEach(() => { clearPeerTransitions(); });

// IL CONTROLLO NEGATIVO CHE CONTA: se questo e' verde contro un'implementazione
// che scrive a ogni sonda, non sta misurando niente. Verificato apposta contro
// una bozza "ingenua" (un diagnostics.record per ogni chiamata) prima di
// scrivere l'implementazione vera: quella bozza fa fallire QUESTO test con 11
// record invece di 0 — la prova che il test morde.
test('CONTROLLO NEGATIVO: un peer che non cambia stato per N sonde consecutive produce ZERO record', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  // 'warn' (non 'info'/'debug'): il livello scelto non e' comunque soggetto
  // al gate verbose di lib/diagnostics/store.js — vedi il commento in
  // peer-transitions.js. Zero record qui e' zero per DAVVERO, non un
  // artefatto del gate.
  const h = health();
  recordPeerTransition('nodo-stabile', h, diagnostics); // primo probe: nessuna transizione da "nulla"
  for (let i = 0; i < 10; i += 1) recordPeerTransition('nodo-stabile', h, diagnostics);
  assert.equal(diagnostics.status().retained, 0,
    'un peer stabile su 11 sonde (1 iniziale + 10 identiche) non deve produrre NESSUN record');
});

test('la transizione del TUNNEL viene scritta', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  recordPeerTransition('nodo-a', health({ transport: 'up' }), diagnostics);
  recordPeerTransition('nodo-a', health({ transport: 'down', auth: 'unknown', reachability: 'unknown' }), diagnostics);
  const { records } = diagnostics.logs();
  assert.equal(records.length, 1);
  assert.equal(records[0].code, 'TUNNEL_TRANSITION');
  assert.equal(records[0].meta.node, 'nodo-a');
  assert.equal(records[0].meta.state, 'down');
});

test('la transizione del SERVIZIO viene scritta separatamente, col tunnel invariato', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  recordPeerTransition('nodo-b', health({ transport: 'up', auth: 'ok', reachability: 'ok' }), diagnostics);
  recordPeerTransition('nodo-b', health({ transport: 'up', auth: 'failed', reachability: 'ok' }), diagnostics);
  const { records } = diagnostics.logs();
  assert.equal(records.length, 1, 'solo il servizio e\' cambiato: un solo record, non due');
  assert.equal(records[0].code, 'SERVICE_TRANSITION');
  assert.equal(records[0].meta.state, 'auth-failed');
});

// Il caso che ha fatto perdere quattro ore: tunnel su, servizio giu'. Un
// booleano «online» avrebbe detto la stessa cosa per ECONNREFUSED (nessun
// listener) ed ECONNRESET (listener vivo, servizio morto) — due guasti con
// due rimedi diversi (rete vs dispositivo).
test('tunnel su e servizio giu\' sono due fatti distinti: mai un solo record booleano "online"', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  recordPeerTransition('nodo-c', health({ transport: 'up', auth: 'ok', reachability: 'ok' }), diagnostics);
  recordPeerTransition('nodo-c', health({ transport: 'up', auth: 'ok', reachability: 'failed' }), diagnostics);
  const { records } = diagnostics.logs();
  assert.equal(records.length, 1);
  assert.equal(records[0].code, 'SERVICE_TRANSITION');
  assert.equal(Object.prototype.hasOwnProperty.call(records[0].meta, 'online'), false,
    'nessun campo booleano "online": solo lo stato nominato');
});

// Il verso opposto del test sopra: quando il tunnel CADE, il servizio smette
// di essere testabile per definizione (probeHealth non lo tocca nel ramo
// down) — segnalarlo come un secondo guasto indipendente sarebbe un fatto
// inventato, non misurato.
test('tunnel giu\' non inventa un secondo fallimento "servizio giu\'": un solo record', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  recordPeerTransition('nodo-d', health({ transport: 'up', auth: 'ok', reachability: 'ok' }), diagnostics);
  recordPeerTransition('nodo-d', health({ transport: 'down', auth: 'unknown', reachability: 'unknown' }), diagnostics);
  const { records } = diagnostics.logs();
  assert.equal(records.length, 1, `atteso 1 record (solo tunnel), trovati: ${JSON.stringify(records.map((r) => r.code))}`);
  assert.equal(records[0].code, 'TUNNEL_TRANSITION');
});

// Il verso SIMMETRICO del test sopra. Il tunnel torna su: il servizio, che
// durante il buio era 'unknown' per costruzione (mai misurato, non "caduto"),
// non "ritorna" — diventa di nuovo osservabile. Scrivere "unknown -> ok" qui
// sarebbe un fatto inventato quanto lo sarebbe stato "ok -> unknown" alla
// caduta: un solo record, quello del tunnel.
test('tunnel che TORNA su non inventa una "ripresa del servizio": un solo record', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  recordPeerTransition('nodo-h', health({ transport: 'up', auth: 'ok', reachability: 'ok' }), diagnostics);
  recordPeerTransition('nodo-h', health({ transport: 'down', auth: 'unknown', reachability: 'unknown' }), diagnostics);
  recordPeerTransition('nodo-h', health({ transport: 'up', auth: 'ok', reachability: 'ok' }), diagnostics);
  const { records } = diagnostics.logs();
  assert.equal(records.length, 2,
    `atteso 2 record (tunnel giu' + tunnel su, MAI il servizio), trovati: ${JSON.stringify(records.map((r) => r.code))}`);
  assert.deepEqual(records.map((r) => r.code), ['TUNNEL_TRANSITION', 'TUNNEL_TRANSITION']);
});

test('due peer distinti hanno storie indipendenti: la transizione di uno non tocca l\'altro', () => {
  const diagnostics = createDiagnostics({ now: () => 0 });
  recordPeerTransition('nodo-e1', health({ transport: 'up' }), diagnostics);
  recordPeerTransition('nodo-e2', health({ transport: 'up' }), diagnostics);
  recordPeerTransition('nodo-e1', health({ transport: 'down', auth: 'unknown', reachability: 'unknown' }), diagnostics);
  recordPeerTransition('nodo-e2', health({ transport: 'up' }), diagnostics); // e2 stabile
  const { records } = diagnostics.logs();
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.node, 'nodo-e1');
});

test('il registro resta LIMITATO: eredita il limite del registro diagnostico esistente, non ne crea uno nuovo', () => {
  const diagnostics = createDiagnostics({ now: () => 0, maxRecords: 5 });
  recordPeerTransition('nodo-f', health({ transport: 'down', auth: 'unknown', reachability: 'unknown' }), diagnostics);
  for (let i = 0; i < 20; i += 1) {
    recordPeerTransition('nodo-f', health({ transport: i % 2 === 0 ? 'up' : 'down', auth: 'ok', reachability: 'ok' }), diagnostics);
  }
  assert.ok(diagnostics.status().retained <= 5,
    `il buffer non deve crescere oltre il limite del registro esistente (retained=${diagnostics.status().retained})`);
});

test('senza diagnostics valido, non esplode e non fa nulla (best-effort)', () => {
  assert.doesNotThrow(() => recordPeerTransition('nodo-g', health(), null));
  assert.doesNotThrow(() => recordPeerTransition('', health(), createDiagnostics({ now: () => 0 })));
});
