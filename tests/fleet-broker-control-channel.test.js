'use strict';
// S3c, primo mattone: il protocollo NDJSON a tipi chiusi del canale broker
// (V6-04). Il parser e' UNO per stream, l'accumulatore e' bounded fino al
// newline, il verificatore tiene solo l'HASH del token, le epoche rendono
// non autoritativi i messaggi di connessioni passate.
const { test } = require('node:test');
const assert = require('node:assert');
const proto = require('../lib/fleet/control-protocol.js');

const frameOk = (extra = {}) => JSON.stringify({
  op: 'stop', requestId: 'a'.repeat(16), launchId: 'f'.repeat(16), epoch: 1, ...extra,
});

test('un frame senza epoca o launchId non viene consegnato', () => {
  const visti = [];
  const p = proto.creaParser({ onFrame: (f) => visti.push(f) });
  p.spingi(JSON.stringify({
    op: 'ready-to-exit', requestId: 'a'.repeat(16), payload: {},
  }) + '\n');
  assert.equal(visti.length, 0);
});

test('framing: riga spezzata su piu\' chunk viene ricomposta in UN frame', () => {
  const visti = [];
  const p = proto.creaParser({ onFrame: (f) => visti.push(f) });
  const riga = frameOk({ payload: { note: 'spezzata' } });
  const meta = Math.floor(riga.length / 2);
  p.spingiBytes(Buffer.from(riga.slice(0, meta), 'utf8'));
  p.spingiBytes(Buffer.from(riga.slice(meta) + '\n', 'utf8'));
  assert.equal(visti.length, 1);
  assert.equal(visti[0].op, 'stop');
  assert.equal(visti[0].payload.note, 'spezzata');
});

test('framing: due frame nello stesso chunk, in ordine', () => {
  const visti = [];
  const p = proto.creaParser({ onFrame: (f) => visti.push(f.op) });
  p.spingi(Buffer.from(frameOk({ op: 'ready-to-exit' }) + '\n' + frameOk({ op: 'stop-ack', requestId: 'b'.repeat(16) }) + '\n', 'utf8').toString('utf8'));
  assert.deepEqual(visti, ['ready-to-exit', 'stop-ack']);
});

test('framing: UTF-8 frammentato a meta\' sequenza ricomposto senza perdite', () => {
  const visti = [];
  const p = proto.creaParser({ onFrame: (f) => visti.push(f) });
  const testo = 'fermo—del—gruppo ✓';
  const riga = Buffer.from(frameOk({ op: 'stop-report', requestId: 'c'.repeat(16), payload: { note: testo } }) + '\n', 'utf8');
  const meta = riga.length - 3; // spezza DENTRO l'ultimo codepoint multibyte
  p.spingiBytes(riga.subarray(0, meta));
  p.spingiBytes(riga.subarray(meta));
  assert.equal(visti.length, 1);
  assert.equal(visti[0].payload.note, testo);
});

test('framing: EOF con accumulatore non vuoto = rotto (frame troncato, nessun frame emesso)', () => {
  const rotture = [];
  const visti = [];
  const p = proto.creaParser({ onFrame: (f) => visti.push(f), onRotto: (motivo) => rotture.push(motivo) });
  p.spingi(frameOk().slice(0, 10)); // nessun newline
  p.fine();
  assert.equal(visti.length, 0, 'un frame troncato non e\' un frame');
  assert.ok(rotture.some((m) => m === 'eof-frame-troncato'));
});

test('framing: accumulatore oltre il cap senza newline = rotto subito', () => {
  const rotture = [];
  const p = proto.creaParser({ capRiga: 128, onRotto: (m) => rotture.push(m) });
  p.spingi('x'.repeat(200));
  assert.ok(p.rotto);
  assert.ok(rotture.includes('riga-oltre-cap'));
});

test('tipi chiusi: op sconosciuta, requestId fuori forma, payload sproporzionato = protocollo rotto', () => {
  const casi = [
    JSON.stringify({ op: 'comando-inventato', requestId: 'a'.repeat(16), epoch: 1 }),
    JSON.stringify({ op: 'stop', requestId: 'id-libero', epoch: 1 }),
    JSON.stringify({ op: 'stop', requestId: 'a'.repeat(16), epoch: 1, payload: { enorme: 'x'.repeat(5000) } }),
  ];
  for (const riga of casi) {
    const p = proto.creaParser({ onFrame: () => assert.fail('frame invalido consegnato') });
    p.spingi(riga + '\n');
    assert.ok(p.rotto, `deve rompersi: ${riga.slice(0, 40)}`);
  }
});

test('dedup per requestId: la seconda copia dello stesso messaggio e\' un doppione', () => {
  const dedup = proto.creaDedup();
  assert.equal(dedup.nuovo('a'.repeat(16)), true);
  assert.equal(dedup.nuovo('a'.repeat(16)), false, 'idempotenza: gia\' visto');
  assert.equal(dedup.nuovo('b'.repeat(16)), true);
});

test('verificatore: tiene l\'HASH del token, mai il token; revoca e confronto a tempo costante', () => {
  const token = 'segreto-controllo-64-hex'.repeat(2).slice(0, 64);
  const v = proto.creaVerificatore();
  const hash = v.arma(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(v.verifica(hash), true);
  assert.equal(v.verifica(token), false, 'il token NON e\' la prova');
  assert.equal(v.verifica('f'.repeat(64)), false);
  // nessun riflesso del token nell'oggetto (stringifica del verificatore)
  assert.ok(!JSON.stringify(v).includes(token));
  v.revoca();
  assert.equal(v.verifica(hash), false, 'revocato: fine lancio');
});

test('epoche: ogni (ri)connessione apre un\'epoca nuova; i messaggi vecchi non sono autoritativi', () => {
  const epoche = proto.creaEpoche();
  const e1 = epoche.nuova();
  assert.equal(epoche.autoritativo(e1), true);
  const e2 = epoche.nuova(); // riconnessione: la connessione precedente e' storia
  assert.equal(e2 > e1, true);
  assert.equal(epoche.autoritativo(e1), false, 'epoca precedente: no-op, non esito');
  assert.equal(epoche.autoritativo(e2), true);
  assert.equal(epoche.autoritativo(999), false);
});

test('codifica: un frame valido torna una riga NDJSON con newline; payload oltre il tetto rifiutato', () => {
  const riga = proto.codifica({
    op: 'stop', requestId: 'd'.repeat(16), launchId: 'f'.repeat(16), epoch: 3, payload: { deadlineMs: 5000 },
  });
  assert.ok(riga.endsWith('\n'));
  const visti = [];
  const p = proto.creaParser({ onFrame: (f) => visti.push(f) });
  p.spingi(riga);
  assert.equal(visti.length, 1);
  assert.equal(visti[0].epoch, 3);
  assert.throws(() => proto.codifica({ op: 'stop', requestId: 'e'.repeat(16), epoch: 1, payload: { x: 'y'.repeat(9000) } }));
});
