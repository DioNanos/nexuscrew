import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reportServerVersions, getUpdateState } from './sw-update.js';

// Il ricaricamento automatico dopo un aggiornamento del nodo.
//
// PERCHE' ESISTE. Con l'auto-update acceso (default, ogni sei ore) un nodo si
// aggiorna e si riavvia da solo; la PWA aperta resta a eseguire il bundle
// vecchio. Finora l'unica uscita era CHIUDERE E RIAPRIRE l'app — il banner
// andava premuto, e per un difetto del service worker chiuso in 0.8.52 non
// funzionava nemmeno. L'operatore si trovava un'interfaccia che non
// corrispondeva al server senza sapere perche'.
//
// COSA NON SI PERDE: la bozza del composer e' gia' persistita in localStorage e
// ricaricata al mount. Verificato prima di rendere il ricaricamento
// automatico: senza quella persistenza questa scelta avrebbe portato via cio'
// che si stava scrivendo, ed e' un prezzo che nessun aggiornamento vale.

function memoriaFinta() {
  const dati = new Map();
  return {
    getItem: (k) => (dati.has(k) ? dati.get(k) : null),
    setItem: (k, v) => dati.set(k, String(v)),
    removeItem: (k) => dati.delete(k),
    _dati: dati,
  };
}

describe('reportServerVersions — ricaricamento automatico', () => {
  let store; let applyImpl;
  beforeEach(() => { store = memoriaFinta(); applyImpl = vi.fn(); });

  it('un bundle piu\' vecchio del servito si ricarica DA SOLO', () => {
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(1);
  });

  it('NON riprova se dopo il ricaricamento il disallineamento e\' identico', () => {
    // La guardia che rende accettabile l'automatismo: un ciclo di
    // ricaricamenti rende l'app inutilizzabile, che e' molto peggio di un
    // banner da premere.
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(1);
    // E il banner resta disponibile come ripiego.
    expect(getUpdateState().needed).toBe(true);
    expect(getUpdateState().kind).toBe('reload');
  });

  it('un disallineamento NUOVO si ricarica di nuovo', () => {
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    reportServerVersions('0.8.54', '0.8.54', '0.8.52', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(2);
  });

  it('`install` NON si ricarica: nessun reload cambia quel caso', () => {
    // Li' il pacchetto sul server e' piu' nuovo della UI che serve: ricaricare
    // girerebbe a vuoto, all'infinito se non fosse per la guardia.
    reportServerVersions('0.8.54', '0.8.53', '0.8.53', { storage: store, applyImpl });
    expect(applyImpl).not.toHaveBeenCalled();
    expect(getUpdateState().kind).toBe('install');
  });

  it('versioni allineate: nessun ricaricamento, e il tentativo si dimentica', () => {
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(1);
    // Torna tutto in pari...
    reportServerVersions('0.8.53', '0.8.53', '0.8.53', { storage: store, applyImpl });
    expect(getUpdateState().needed).toBe(false);
    // ...e un disallineamento successivo, anche identico al primo, riparte.
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(2);
  });

  it('senza memoria di sessione NON si ricarica: senza guardia niente automatismo', () => {
    // Storage negato (modalita' privata, iframe): non potendo ricordare il
    // tentativo, l'automatismo diventerebbe un ciclo. Si degrada al banner.
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: null, applyImpl });
    expect(applyImpl).not.toHaveBeenCalled();
    expect(getUpdateState().needed).toBe(true);
  });
});
