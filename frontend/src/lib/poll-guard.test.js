import { describe, expect, it } from 'vitest';
import { createPollGuard } from './poll-guard.js';

describe('createPollGuard', () => {
  it('apre un giro quando non ce n e nessuno in volo', () => {
    const guard = createPollGuard();
    const token = guard.begin();
    expect(token).not.toBeNull();
  });

  it('salta il tick quando un giro e gia in volo', () => {
    const guard = createPollGuard();
    const primo = guard.begin();
    // Il tick successivo arriva mentre il primo giro e ancora in corso:
    // deve essere SALTATO, non accodato.
    const secondo = guard.begin();
    expect(primo).not.toBeNull();
    expect(secondo).toBeNull();
  });

  it('torna disponibile dopo la chiusura del giro', () => {
    const guard = createPollGuard();
    guard.begin();
    guard.end();
    expect(guard.begin()).not.toBeNull();
  });

  // Il percorso d errore non deve lasciare la guardia BLOCCATA: se `end()` non
  // arrivasse sul ramo d'errore, il primo fallimento spegnerebbe per sempre il
  // poll. Il token resta invece corrente: un giro chiuso senza successori e
  // ancora l'ultimo, quindi il suo esito e ancora applicabile.
  it('non resta bloccata quando il giro si chiude sul percorso d errore', () => {
    const guard = createPollGuard();
    const token = guard.begin();
    try {
      throw new Error('lettura fallita');
    } catch (_) {
      // il chiamante reale chiude in `finally`
    } finally {
      guard.end();
    }
    expect(guard.isCurrent(token)).toBe(true); // nessun successore: e l ultimo
    expect(guard.begin()).not.toBeNull();      // e la guardia non e bloccata
  });

  // Questo e il caso che il difetto produceva: una risposta VECCHIA applicata
  // dopo una piu nuova. Senza `isCurrent` l'esito superato scriverebbe,
  // riportando la lista a uno stato che non e piu quello corrente.
  it('scarta l esito di un giro superato da uno piu nuovo', () => {
    const guard = createPollGuard();
    const vecchio = guard.begin();
    guard.end();
    const nuovo = guard.begin();
    expect(guard.isCurrent(nuovo)).toBe(true);
    expect(guard.isCurrent(vecchio)).toBe(false);
  });

  it('non considera corrente un token mai aperto', () => {
    const guard = createPollGuard();
    guard.begin();
    expect(guard.isCurrent(null)).toBe(false);
    expect(guard.isCurrent(999)).toBe(false);
  });
});
