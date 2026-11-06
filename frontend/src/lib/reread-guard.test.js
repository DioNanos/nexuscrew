import { describe, expect, it } from 'vitest';
import { puoRileggere } from './reread-guard.js';

// La lettura differita è legata al contesto che l'ha chiesta: se quel contesto
// non c'è più, leggere lo stato di un'altra vista è rumore, non informazione.
describe('guardia della lettura differita', () => {
  const atteso = { token: 't1', owner: 'owner-a' };
  const cell = 'TestCell';

  it('lascia passare lo stesso contesto, senza stato terminale', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-a' }, snapshot: null, cell })).toBe(true);
    expect(puoRileggere({
      atteso, contesto: { token: 't1', owner: 'owner-a' },
      snapshot: { cells: [{ cell, tmux: true }] }, cell,
    })).toBe(true);
  });

  it('rifiuta dopo un cambio di credenziale sulla stessa route', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't2', owner: 'owner-a' }, snapshot: null, cell })).toBe(false);
  });

  it('rifiuta quando l owner della route è un altro', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-b' }, snapshot: null, cell })).toBe(false);
  });

  it('rifiuta quando l owner è comparso o sparito', () => {
    expect(puoRileggere({ atteso: { token: 't1', owner: null }, contesto: { token: 't1', owner: 'owner-a' }, snapshot: null, cell })).toBe(false);
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: null }, snapshot: null, cell })).toBe(false);
  });

  it('rifiuta quando la cella ha già una ragione terminale', () => {
    expect(puoRileggere({
      atteso, contesto: { token: 't1', owner: 'owner-a' },
      snapshot: { cells: [{ cell, terminal: { reason: 'lease-lost', ts: 1 } }] }, cell,
    })).toBe(false);
  });

  it('non guarda il terminale di un altra cella', () => {
    expect(puoRileggere({
      atteso, contesto: { token: 't1', owner: 'owner-a' },
      snapshot: { cells: [{ cell: 'Altra', terminal: { reason: 'lease-lost', ts: 1 } }] }, cell,
    })).toBe(true);
  });

  it('rifiuta input incompleti, invece di indovinare', () => {
    expect(puoRileggere({})).toBe(false);
    expect(puoRileggere({ atteso, contesto: null, snapshot: null, cell })).toBe(false);
  });
});
