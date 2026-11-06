import { describe, expect, it } from 'vitest';
import { MAX_SECONDS, MIN_SECONDS, parseSecondi, secondiDaMs } from './bootstrap-wait-input.js';

// Il campo dell'attesa si scrive in secondi, il contratto del server parla in
// millisecondi interi. Fra i due c'e' un solo parser: se ognuno arrotondasse per
// conto suo, 1,234 s diventerebbe 1234 da una parte e 1230 dall'altra.
describe('parser dell attesa in secondi', () => {
  it('accetta i valori del contratto senza toccarli', () => {
    expect(parseSecondi('1')).toEqual({ ok: true, ms: 1000 });
    expect(parseSecondi('15')).toEqual({ ok: true, ms: 15000 });
    expect(parseSecondi('60')).toEqual({ ok: true, ms: 60000 });
    expect(parseSecondi('120')).toEqual({ ok: true, ms: 120000 });
  });

  it('legge virgola e punto come separatore decimale, con lo stesso valore', () => {
    expect(parseSecondi('1,234')).toEqual({ ok: true, ms: 1234 });
    expect(parseSecondi('1.234')).toEqual({ ok: true, ms: 1234 });
    expect(parseSecondi('0,001')).toEqual({ ok: false, motivo: 'range' });
    expect(parseSecondi('2,5')).toEqual({ ok: true, ms: 2500 });
    expect(parseSecondi('2.5')).toEqual({ ok: true, ms: 2500 });
    expect(parseSecondi('120,000')).toEqual({ ok: true, ms: 120000 });
  });

  it('non arrotonda: la precisione oltre il millisecondo si rifiuta', () => {
    expect(parseSecondi('1,2345')).toEqual({ ok: false, motivo: 'precisione' });
    expect(parseSecondi('1.2345')).toEqual({ ok: false, motivo: 'precisione' });
    // tre decimali sono il massimo e valgono esattamente un millisecondo
    expect(parseSecondi('1,001')).toEqual({ ok: true, ms: 1001 });
    expect(parseSecondi('119,999')).toEqual({ ok: true, ms: 119999 });
  });

  it('rifiuta esponenti, testo, segni e spazi interni', () => {
    for (const v of ['1e3', '1E3', 'NaN', 'Infinity', 'dieci', '1s', 's1', '-1', '+1', '1 234', '1\t234', ''] ) {
      expect(parseSecondi(v).ok, `valore ${JSON.stringify(v)}`).toBe(false);
    }
    expect(parseSecondi('dieci').motivo).toBe('testo');
    expect(parseSecondi('').motivo).toBe('vuoto');
    expect(parseSecondi('   ').motivo).toBe('vuoto');
  });

  it('rifiuta due separatori, cioe la forma delle migliaia', () => {
    expect(parseSecondi('1.234,5')).toEqual({ ok: false, motivo: 'separatori' });
    expect(parseSecondi('1,234.5')).toEqual({ ok: false, motivo: 'separatori' });
    expect(parseSecondi('1.234.567')).toEqual({ ok: false, motivo: 'separatori' });
  });

  it('rifiuta le forme senza una delle due parti', () => {
    expect(parseSecondi(',5').ok).toBe(false);
    expect(parseSecondi('1,').ok).toBe(false);
    expect(parseSecondi('.').ok).toBe(false);
  });

  it('tiene il range del contratto: 1-120 secondi', () => {
    expect(MIN_SECONDS).toBe(1);
    expect(MAX_SECONDS).toBe(120);
    expect(parseSecondi('0,999')).toEqual({ ok: false, motivo: 'range' });
    expect(parseSecondi('0')).toEqual({ ok: false, motivo: 'range' });
    expect(parseSecondi('120,001')).toEqual({ ok: false, motivo: 'range' });
    expect(parseSecondi('121')).toEqual({ ok: false, motivo: 'range' });
  });

  it('accetta gli zeri iniziali: sono notazione, non correzione', () => {
    expect(parseSecondi('001')).toEqual({ ok: true, ms: 1000 });
    expect(parseSecondi('015,5')).toEqual({ ok: true, ms: 15500 });
  });

  it('rifiuta cio che non e una stringa', () => {
    for (const v of [undefined, null, 15, {}, [], true]) {
      expect(parseSecondi(v).ok, `valore ${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe('round-trip secondi verso millisecondi', () => {
  it('secondiDaMs produce un testo che il parser rilegge identico, su tutto il range', () => {
    for (let ms = MIN_SECONDS * 1000; ms <= MAX_SECONDS * 1000; ms += 1) {
      const testo = secondiDaMs(ms, ',');
      const esito = parseSecondi(testo);
      if (!esito.ok || esito.ms !== ms) {
        throw new Error(`round-trip rotto a ${ms}: "${testo}" -> ${JSON.stringify(esito)}`);
      }
    }
  });

  it('usa il separatore chiesto, senza perdere cifre', () => {
    expect(secondiDaMs(1000, ',')).toBe('1');
    expect(secondiDaMs(1234, ',')).toBe('1,234');
    expect(secondiDaMs(1234, '.')).toBe('1.234');
    expect(secondiDaMs(1500, '.')).toBe('1.5');
    expect(secondiDaMs(1001, ',')).toBe('1,001');
    expect(secondiDaMs(120000, ',')).toBe('120');
  });
});
