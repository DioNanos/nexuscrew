// R27: la regola della lettura flotta e' ESATTA e vale per due siti
// (SessionList mobile e App desktop) — la si prova come policy pura, cosi'
// i due consumatori non possono divergere di nuovo.
import { describe, expect, it } from 'vitest';
import { fleetReadOutcome } from './fleet-read-policy.js';

describe('fleetReadOutcome — un fallimento di lettura non e\` mai «zero celle»', () => {
  it('lettura riuscita: la risposta e\' un dato (celle e capabilities, default lista vuota)', () => {
    expect(fleetReadOutcome({ fs: { available: true, cells: [{ cell: 'A' }], capabilities: ['boot'] } }))
      .toEqual({ kind: 'data', cells: [{ cell: 'A' }], capabilities: ['boot'] });
    expect(fleetReadOutcome({ fs: { available: true } }))
      .toEqual({ kind: 'data', cells: [], capabilities: [] });
  });
  it('zero celle con lettura riuscita resta un DATO: lista vuota vera, non guasto', () => {
    expect(fleetReadOutcome({ fs: { available: true, cells: [] } })).toEqual({ kind: 'data', cells: [], capabilities: [] });
  });
  it('available:false dice «non ho potuto leggere», non «zero celle» → stale (anche se porta cells)', () => {
    expect(fleetReadOutcome({ fs: { available: false } }).kind).toBe('stale');
    expect(fleetReadOutcome({ fs: { available: false, cells: [{ cell: 'A' }] } }).kind).toBe('stale');
  });
  it('reject (rete/401/5xx) → stale: resta l\'ultima lista nota', () => {
    expect(fleetReadOutcome({ error: new Error('fetch failed') }).kind).toBe('stale');
  });
  it('nessuna risposta → stale', () => {
    expect(fleetReadOutcome({}).kind).toBe('stale');
    expect(fleetReadOutcome().kind).toBe('stale');
  });
});
