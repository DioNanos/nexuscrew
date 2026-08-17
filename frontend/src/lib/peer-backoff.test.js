import { describe, expect, it } from 'vitest';
import {
  BACKOFF_DEFAULTS, CAUSE_PEER_ASENTE, CAUSE_PEER_NEGA, CAUSE_ROTTA_INESISTENTE,
  backoffDelayMs, classifyPeerFailure, recordPeerFailure, recordPeerSuccess, shouldPollPeer,
} from './peer-backoff.js';

// R21 — il backoff NON deve poter diventare una condanna: ogni guardia qui
// sotto ha il suo braccio opposto. «Non si interroga prima del ritardo» sta
// accanto a «si interroga di nuovo al raggiungimento del ritardo», e il
// successo riporta la cadenza normale IMMEDIATAMENTE.

describe('classifyPeerFailure — tre cause con nome, non una', () => {
  it('502: il peer non c\'è (il proxy risponde onestamente)', () => {
    expect(classifyPeerFailure({ status: 502 })).toBe(CAUSE_PEER_ASENTE);
  });
  it('403: il peer c\'è e nega — azione diversa: concedere il permesso', () => {
    expect(classifyPeerFailure({ status: 403 })).toBe(CAUSE_PEER_NEGA);
  });
  it('404: il peer c\'è ma la rotta non esiste — azione: aggiornare il nodo', () => {
    expect(classifyPeerFailure({ status: 404 })).toBe(CAUSE_ROTTA_INESISTENTE);
  });
  it('rete giu\' / Failed to fetch (nessuno status): stessa azione del 502 — aspetta', () => {
    expect(classifyPeerFailure(new TypeError('Failed to fetch'))).toBe(CAUSE_PEER_ASENTE);
    expect(classifyPeerFailure(null)).toBe(CAUSE_PEER_ASENTE);
  });
  it('le tre cause restano tre: nessuno status fuori lista produce una causa nuova', () => {
    expect(classifyPeerFailure({ status: 500 })).toBe(CAUSE_PEER_ASENTE);
    expect(classifyPeerFailure({ status: 401 })).toBe(CAUSE_PEER_ASENTE);
  });
});

describe('backoffDelayMs — sempre più di rado, con un tetto', () => {
  it('nessun fallimento: nessun ritardo', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(undefined)).toBe(0);
  });
  it('un solo fallimento non rallenta il recupero: il giro successivo prova comunque', () => {
    expect(backoffDelayMs(1)).toBe(BACKOFF_DEFAULTS.baseMs);
  });
  it('poi raddoppia a ogni fallimento consecutivo', () => {
    expect(backoffDelayMs(2)).toBe(8000);
    expect(backoffDelayMs(3)).toBe(16000);
    expect(backoffDelayMs(4)).toBe(32000);
  });
  it('il tetto esiste: senza, «sempre più di rado» diventerebbe «mai più»', () => {
    expect(backoffDelayMs(5)).toBe(BACKOFF_DEFAULTS.capMs);
    expect(backoffDelayMs(50)).toBe(BACKOFF_DEFAULTS.capMs);
  });
  it('scheduling iniettabile (i test non dipendono dai default)', () => {
    expect(backoffDelayMs(3, { baseMs: 10, capMs: 25 })).toBe(25);
  });
});

describe('shouldPollPeer + registrazione — la coppia discriminante', () => {
  const K = 'vps';
  it('peer mai fallito: si interroga sempre', () => {
    expect(shouldPollPeer({}, K, 0)).toBe(true);
    expect(shouldPollPeer(null, K, 0)).toBe(true);
  });
  it('fallito: NON si interroga prima del ritardo, SI\' al raggiungerlo', () => {
    let s = recordPeerFailure({}, K, CAUSE_PEER_ASENTE, 1000);
    // primo fallimento: ritardo = baseMs
    expect(s[K].failures).toBe(1);
    expect(s[K].nextAtMs).toBe(1000 + BACKOFF_DEFAULTS.baseMs);
    expect(shouldPollPeer(s, K, 1000 + BACKOFF_DEFAULTS.baseMs - 1)).toBe(false);
    expect(shouldPollPeer(s, K, 1000 + BACKOFF_DEFAULTS.baseMs)).toBe(true);
  });
  it('fallimenti consecutivi: il ritardo cresce, la causa resta quella dell\'ultimo esito', () => {
    let s = recordPeerFailure({}, K, CAUSE_PEER_ASENTE, 0);
    s = recordPeerFailure(s, K, CAUSE_PEER_NEGA, 4000);
    expect(s[K].failures).toBe(2);
    expect(s[K].cause).toBe(CAUSE_PEER_NEGA);
    expect(s[K].nextAtMs).toBe(4000 + 8000);
  });
  it('immutabile: la mappa di partenza non si tocca (chi chiama sostituisce la ref)', () => {
    const prima = {};
    recordPeerFailure(prima, K, CAUSE_PEER_ASENTE, 0);
    expect(prima).toEqual({});
  });
  it('il successo azzera il backoff IMMEDIATAMENTE: non è una condanna', () => {
    let s = recordPeerFailure({}, K, CAUSE_PEER_ASENTE, 0);
    s = recordPeerFailure(s, K, CAUSE_PEER_ASENTE, 4000);
    expect(shouldPollPeer(s, K, 4100)).toBe(false); // ancora in backoff
    s = recordPeerSuccess(s, K);                     // il peer torna
    expect(shouldPollPeer(s, K, 4100)).toBe(true);  // cadenza normale SUBITO
    expect(s[K]).toBeUndefined();
  });
  it('successo su peer mai tracciato: la mappa torna intatta, niente rumore', () => {
    const s = { altro: { failures: 1, cause: CAUSE_PEER_ASENTE, nextAtMs: 1 } };
    expect(recordPeerSuccess(s, K)).toBe(s);
  });
});
