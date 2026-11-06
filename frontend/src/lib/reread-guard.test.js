import { describe, expect, it } from 'vitest';
import { puoRileggere } from './reread-guard.js';

// La lettura differita è legata al contesto che l'ha chiesta: se quel contesto
// non c'è più, leggere lo stato di un'altra vista è rumore, non informazione.
describe('guardia della lettura differita', () => {
  const atteso = { token: 't1', owner: 'owner-a' };
  const cell = 'TestCell';

  // Lo snapshot è quello del treno, nella forma che il produttore emette: le
  // celle stanno in `fs.cells` (fs è il risultato di fleetStatus), non alla
  // radice dell'oggetto.
  const snapshot = (celle) => ({ at: 1, sessionsJson: { sessions: [] }, sessionsError: null, fs: { available: true, cells: celle }, fleetError: null });

  it('lascia passare lo stesso contesto, senza stato terminale', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-a' }, snapshot: null, cell })).toBe(true);
    expect(puoRileggere({
      atteso, contesto: { token: 't1', owner: 'owner-a' },
      snapshot: snapshot([{ cell, tmux: true }]), cell,
    })).toBe(true);
  });

  it('rifiuta dopo un cambio di credenziale sulla stessa route', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't2', owner: 'owner-a' }, snapshot: null, cell })).toBe(false);
  });

  it('rifiuta quando l owner della route è un altro', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-b' }, snapshot: null, cell })).toBe(false);
  });

  it('rifiuta quando la generazione del contesto è cambiata', () => {
    // stessa credenziale e stesso owner non bastano: la generazione distingue
    // due azioni separate da un cambio di contesto
    expect(puoRileggere({
      atteso: { token: 't1', owner: 'owner-a', gen: 1 },
      contesto: { token: 't1', owner: 'owner-a', gen: 2 },
      snapshot: null, cell,
    })).toBe(false);
    expect(puoRileggere({
      atteso: { token: 't1', owner: 'owner-a', gen: 2 },
      contesto: { token: 't1', owner: 'owner-a', gen: 2 },
      snapshot: null, cell,
    })).toBe(true);
    // senza generazione da nessuna delle due parti non si inventa un conflitto
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-a' }, snapshot: null, cell })).toBe(true);
  });

  it('rifiuta quando l owner è comparso o sparito', () => {
    expect(puoRileggere({ atteso: { token: 't1', owner: null }, contesto: { token: 't1', owner: 'owner-a' }, snapshot: null, cell })).toBe(false);
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: null }, snapshot: null, cell })).toBe(false);
  });

  it('rifiuta quando la cella ha già una ragione terminale', () => {
    expect(puoRileggere({
      atteso, contesto: { token: 't1', owner: 'owner-a' },
      snapshot: snapshot([{ cell, terminal: { reason: 'lease-lost', ts: 1 } }]), cell,
    })).toBe(false);
  });

  it('non guarda il terminale di un altra cella', () => {
    expect(puoRileggere({
      atteso, contesto: { token: 't1', owner: 'owner-a' },
      snapshot: snapshot([{ cell: 'Altra', terminal: { reason: 'lease-lost', ts: 1 } }]), cell,
    })).toBe(true);
  });

  it('con lo snapshot assente o senza elenco non inventa un esito', () => {
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-a' }, snapshot: null, cell })).toBe(true);
    expect(puoRileggere({ atteso, contesto: { token: 't1', owner: 'owner-a' }, snapshot: snapshot(null), cell })).toBe(true);
  });

  it('rifiuta input incompleti, invece di indovinare', () => {
    expect(puoRileggere({})).toBe(false);
    expect(puoRileggere({ atteso, contesto: null, snapshot: null, cell })).toBe(false);
  });
});
