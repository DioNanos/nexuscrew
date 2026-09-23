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
    const token = guard.begin();
    guard.end(token);
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
      guard.end(token);
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
    guard.end(vecchio);
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

  // --- il ciclo di vita dell'effetto --------------------------------------
  //
  // Il cleanup di un effetto cancellava solo l'intervallo: la guardia restava
  // com'era, quindi il giro vecchio era ancora «corrente» e il nuovo effetto
  // si faceva saltare il primo tick. `reset()` chiude quella finestra.

  it('reset invalida il giro in corso e libera la guardia', () => {
    const guard = createPollGuard();
    const vecchio = guard.begin();
    guard.reset();
    expect(guard.isCurrent(vecchio)).toBe(false);
    expect(guard.begin()).not.toBeNull();
  });

  it('end di un giro superato non libera la guardia del giro nuovo', () => {
    const guard = createPollGuard();
    const vecchio = guard.begin();
    guard.reset();
    const nuovo = guard.begin();
    // Il giro vecchio atterra DOPO che il nuovo e' partito: la bandierina
    // `inFlight` appartiene al nuovo, e azzerarla qui farebbe partire un terzo
    // giro in parallelo al secondo.
    guard.end(vecchio);
    expect(guard.begin()).toBeNull();
    guard.end(nuovo);
    expect(guard.begin()).not.toBeNull();
  });

  it('risposta differita del giro vecchio dopo il cleanup: non scrive, e il nuovo giro parte', async () => {
    const guard = createPollGuard();
    const scritte = [];
    let atterraVecchia;
    const rispostaVecchia = new Promise((resolve) => { atterraVecchia = resolve; });

    // Effetto 1: giro in volo, esito applicato solo se ancora corrente.
    const t1 = guard.begin();
    const giroVecchio = rispostaVecchia.then(() => {
      if (!guard.isCurrent(t1)) return;
      scritte.push('vecchia');
    });

    // Cleanup dell'effetto (cambio token, StrictMode) e nuovo effetto.
    guard.reset();
    const t2 = guard.begin();
    expect(t2).not.toBeNull();

    // Effetto 2: risponde subito.
    await Promise.resolve().then(() => {
      if (!guard.isCurrent(t2)) return;
      scritte.push('nuova');
    });

    // Solo ORA atterra la risposta vecchia.
    atterraVecchia();
    await giroVecchio;

    expect(scritte).toEqual(['nuova']);
    // E il giro vecchio, atterrando, non ha liberato la guardia del nuovo.
    expect(guard.begin()).toBeNull();
  });

  it('un giro che scade (fetch che non risponde) libera la guardia: il tick successivo parte', async () => {
    const guard = createPollGuard();
    const token = guard.begin();
    try {
      await Promise.reject(new Error('timeout'));
    } catch (_) {
      // come il catch di App.jsx
    } finally {
      guard.end(token);
    }
    expect(guard.begin()).not.toBeNull();
  });
});
