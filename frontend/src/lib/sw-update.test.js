import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reportServerVersions, getUpdateState, dismissUpdate,
  clearReloadAttemptInUrl,
} from './sw-update.js';

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

// The address bar as a browser would behave: replaceState rewrites the URL and
// the new search string is what the next load reads.
function fintaUrl(initial = '/') {
  const state = { href: initial };
  const split = () => {
    const [beforeHash, ...rest] = state.href.split('#');
    const [pathname, ...query] = beforeHash.split('?');
    return { pathname, search: query.length ? `?${query.join('?')}` : '', hash: rest.length ? `#${rest.join('#')}` : '' };
  };
  return {
    get search() { return split().search; },
    get pathname() { return split().pathname; },
    get hash() { return split().hash; },
    get href() { return state.href; },
    replaceCalls: [],
    replaceState(_state, _title, url) { this.replaceCalls.push(url); state.href = url; },
  };
}

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
  beforeEach(() => {
    store = memoriaFinta(); applyImpl = vi.fn();
    // Il marcatore vive nell'URL: senza pulirlo, un test eredita il
    // tentativo del precedente (in un browser il reload lo azzera).
    try { clearReloadAttemptInUrl(); } catch (_) { /* nessun URL in questo ambiente */ }
  });

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
    // E il banner resta disponibile come ripiego, ma DIAGNOSTICO: la 'reload'
    // annunciava la versione gia' in esecuzione (il difetto di 0.9.25).
    expect(getUpdateState().needed).toBe(true);
    expect(getUpdateState().kind).toBe('stale');
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

// ── The banner must never be perpetual, and must never announce the version
// the browser is already running.
//
// Measured case (0.9.25): the shipped bundle was pinned to 0.9.24 while
// version.json said 0.9.25, so uiVersion !== browserVersion. The automatic
// reload could not fix it (it reloaded the same bundle), and the fallback
// banner stayed on screen saying "new version 0.9.25 available" while the
// running interface WAS 0.9.25 on the server side — a permanent, false
// announcement. Two independent invariants replace that behaviour: a
// diagnostic banner that describes the real mismatch, and the property that
// no banner ever announces the running version.
describe('reportServerVersions — a stale interface is diagnosed, never announced', () => {
  let store; let applyImpl;
  beforeEach(() => { store = memoriaFinta(); applyImpl = vi.fn(); });

  // (a)
  it('(a) served UI newer than the running bundle: one silent anti-cache reload, then a diagnostic banner', () => {
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(1);
    // While the reload happens there is nothing to tell the user.
    expect(getUpdateState().needed).toBe(false);

    // Same session, same triple: the reload was already tried and did not help.
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: store, applyImpl });
    expect(applyImpl).toHaveBeenCalledTimes(1); // no reload loop
    const s = getUpdateState();
    expect(s.needed).toBe(true);
    expect(s.kind).toBe('stale'); // diagnostic copy, not "new version ... available"
    expect(s.version).not.toBe('0.9.24');
  });

  // (b)
  it('(b) newer package on disk with the node not restarted: install banner, no automatic reload', () => {
    reportServerVersions('0.9.27', '0.9.26', '0.9.26', { storage: store, applyImpl });
    const s = getUpdateState();
    expect(s.kind).toBe('install');
    expect(s.version).toBe('0.9.27');
    expect(s.needed).toBe(true);
    expect(applyImpl).not.toHaveBeenCalled();
  });

  // (c)
  it('(c) identical versions: no banner and the session marker is cleared', () => {
    reportServerVersions('0.8.53', '0.8.53', '0.8.52', { storage: store, applyImpl });
    expect(store.getItem('nc-auto-reload')).not.toBeNull();

    reportServerVersions('0.8.53', '0.8.53', '0.8.53', { storage: store, applyImpl });
    expect(getUpdateState().needed).toBe(false);
    expect(store.getItem('nc-auto-reload')).toBeNull();
  });

  // (e)
  it('(e) property: no banner ever announces the version the browser is already running', () => {
    const triples = [
      ['0.9.25', '0.9.25', '0.9.24'],
      ['0.9.27', '0.9.26', '0.9.26'],
      ['0.9.26', '0.9.25', '0.9.25'],
      ['0.10.0', '0.9.26', '0.9.26'],
      ['0.9.27', '0.9.26', '0.9.27'],
      ['0.9.26', '0.9.26', '0.9.26'],
    ];
    let banners = 0;
    for (const [sv, uv, bv] of triples) {
      const session = memoriaFinta();
      reportServerVersions(sv, uv, bv, { storage: session, applyImpl: vi.fn() });
      reportServerVersions(sv, uv, bv, { storage: session, applyImpl: vi.fn() });
      const s = getUpdateState();
      if (!s.needed) continue;
      banners += 1;
      if (s.version !== '') expect(s.version).not.toBe(bv);
    }
    expect(banners).toBeGreaterThan(0); // the property is not vacuously true
  });

  // (d)
  it('(d) a banner closed by the user stays closed for the same versions and returns when one changes', () => {
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: store, applyImpl }); // silent reload
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: store, applyImpl }); // banner
    expect(getUpdateState().needed).toBe(true);

    dismissUpdate({ storage: store });
    expect(getUpdateState().needed).toBe(false);

    // Same triple, same session: the user already said no.
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: store, applyImpl });
    expect(getUpdateState().needed).toBe(false);

    // A different triple is news again.
    reportServerVersions('0.9.26', '0.9.25', '0.9.24', { storage: store, applyImpl });
    expect(getUpdateState().needed).toBe(true);
  });
});

// ── The storage is not the only thing that can remember an attempt.
//
// A store that accepts the write and loses it at the next load (sessionStorage
// in some Android WebViews and PWA shells, ephemeral storage, quota) made the
// guard blind: every load found no marker, so every load reloaded. "Never
// perpetual" has to hold for that store too, so the attempt is recorded in the
// address bar as well — the one piece of state a reload cannot lose.
describe('reportServerVersions — a forgetting store cannot loop', () => {
  let applyImpl;
  beforeEach(() => { applyImpl = vi.fn(); });

  it('(f) the same pair reloads once even when the store forgets it at reload', () => {
    const url = fintaUrl('/');
    // First load: empty store, no marker in the URL.
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: memoriaFinta(), applyImpl, location: url, history: url });
    expect(applyImpl).toHaveBeenCalledTimes(1);

    // The reload happens: a NEW store (nothing remembered) and the same address.
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: memoriaFinta(), applyImpl, location: url, history: url });
    expect(applyImpl).toHaveBeenCalledTimes(1); // no loop
    const s = getUpdateState();
    expect(s.needed).toBe(true);
    expect(s.kind).toBe('stale');
  });

  it('(g) the attempt lives in the URL, so the next load sees it without any store', () => {
    const url = fintaUrl('/?nc-reload=0.9.25%7C0.9.24');
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: memoriaFinta(), applyImpl, location: url, history: url });
    expect(applyImpl).not.toHaveBeenCalled();
    expect(getUpdateState().kind).toBe('stale');
  });

  it('(h) aligned versions clean the marker out of the URL, without reloading', () => {
    const url = fintaUrl('/?nc-reload=0.9.25%7C0.9.24');
    reportServerVersions('0.9.26', '0.9.26', '0.9.26', { storage: memoriaFinta(), applyImpl, location: url, history: url });
    expect(applyImpl).not.toHaveBeenCalled();
    expect(getUpdateState().needed).toBe(false);
    expect(url.search).toBe('');
    expect(url.replaceCalls.length).toBe(1);
  });

  it('(i) a different pair is not blocked by a previous attempt', () => {
    const url = fintaUrl('/?nc-reload=0.9.25%7C0.9.24');
    reportServerVersions('0.9.26', '0.9.26', '0.9.25', { storage: memoriaFinta(), applyImpl, location: url, history: url });
    expect(applyImpl).toHaveBeenCalledTimes(1);
  });
});
