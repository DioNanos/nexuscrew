import { describe, expect, it } from 'vitest';
import { connectionState, healthView } from './vl-node-view.js';

// Il pallino della salute: `running` è un'auto-dichiarazione del device, non la
// prova che l'host risponda. La tabella è quella scritta nel modulo, e qui se
// ne prova ogni riga.
describe('salute di un nodo VL', () => {
  const adesso = 1_000_000;

  it('running con il broker attestato è la sola forma sana', () => {
    const v = healthView({ state: 'running', brokerReachable: true }, { online: true, lastSeen: adesso - 1000, now: adesso });
    expect(v.status).toBe('healthy');
    expect(v.freshness).toBe('current');
  });

  it('running senza la prova del broker resta un avviso', () => {
    for (const h of [{ state: 'running' }, { state: 'running', brokerReachable: false }, { state: 'running', brokerReachable: 'true' }]) {
      const v = healthView(h, { online: true, lastSeen: adesso - 1000, now: adesso });
      expect(v.status, JSON.stringify(h)).toBe('warn');
      expect(v.detail).toBeTruthy();
    }
  });

  it('gli altri stati dichiarati sono avvisi con il loro motivo', () => {
    for (const stato of ['starting', 'degraded', 'error', 'stopped']) {
      const v = healthView({ state: stato, brokerReachable: true }, { online: true, lastSeen: adesso - 1000, now: adesso });
      expect(v.status, stato).toBe('warn');
      expect(v.detail, stato).toBeTruthy();
    }
  });

  it('una salute assente è assenza, un vocabolario ignoto è nessun indicatore', () => {
    // assente: nessun oggetto (un {status:null} sarebbe truthy per i consumer)
    for (const h of [null, undefined]) {
      expect(healthView(h, { online: true, lastSeen: adesso - 1000, now: adesso }), JSON.stringify(h)).toBeNull();
    }
    // dichiarato ma fuori vocabolario: nessun indicatore, dettaglio conservato
    for (const h of [{}, { state: 'boh' }]) {
      const v = healthView(h, { online: true, lastSeen: adesso - 1000, now: adesso });
      expect(v.status, JSON.stringify(h)).toBeNull();
      expect(v.detail, JSON.stringify(h)).toBeNull();
    }
    const conDettaglio = healthView({ state: 'boh', detail: 'lo dice lui' }, { online: true, lastSeen: adesso - 1000, now: adesso });
    expect(conDettaglio.status).toBeNull();
    expect(conDettaglio.detail).toBe('lo dice lui');
  });


  // La freschezza decide, non decora: un'osservazione vecchia non prova lo
  // stato di adesso, e il colore verde non si mostra.
  it('un dato vecchio non è verde, nemmeno con il broker attestato', () => {
    const vecchio = healthView({ state: 'running', brokerReachable: true }, { online: true, lastSeen: adesso - 10 * 60_000, now: adesso });
    expect(vecchio.freshness).toBe('stale');
    expect(vecchio.status).toBe('warn');
    expect(vecchio.detail).toBeTruthy();
    const offline = healthView({ state: 'running', brokerReachable: true }, { online: false, lastSeen: adesso - 1000, now: adesso });
    expect(offline.freshness).toBe('stale');
    expect(offline.status).toBe('warn');
  });

  it('un lastSeen nel futuro o assente non è fresco', () => {
    const futuro = healthView({ state: 'running', brokerReachable: true }, { online: true, lastSeen: adesso + 60_000, now: adesso });
    expect(futuro.freshness).toBe('stale');
    expect(futuro.status).toBe('warn');
    const senza = healthView({ state: 'running', brokerReachable: true }, { online: true, lastSeen: null, now: adesso });
    expect(senza.freshness).toBe('stale');
    expect(senza.status).toBe('warn');
  });

  it('un esito già derivato non resta verde se il dato è vecchio', () => {
    const v = healthView({ status: 'healthy', detail: 'ok' }, { online: true, lastSeen: adesso - 10 * 60_000, now: adesso });
    expect(v.status).toBe('warn');
    expect(v.freshness).toBe('stale');
  });
});

// «Mai collegato» non è «offline»: sono due azioni diverse per chi legge.
describe('stato del collegamento', () => {
  it('online vince sul resto', () => {
    expect(connectionState({ online: true, lastSeen: null })).toBe('online');
    expect(connectionState({ online: true, lastSeen: 5 })).toBe('online');
  });

  it('senza heartbeat è «mai collegato», con un heartbeat perso è offline', () => {
    expect(connectionState({ online: false, lastSeen: null })).toBe('never-connected');
    expect(connectionState({ online: false })).toBe('never-connected');
    expect(connectionState({ online: false, lastSeen: 12345 })).toBe('offline');
  });

  it('un input che non è un nodo non inventa uno stato', () => {
    expect(connectionState(null)).toBe('never-connected');
    expect(connectionState({})).toBe('never-connected');
  });
});

// Il contratto dice «salute assente = nessun indicatore». Un oggetto con
// `status: null` e' truthy, e un consumatore che guarda solo la presenza
// dell'oggetto lo trasforma in un avviso: l'assenza va rappresentata come
// assenza, non come un oggetto vuoto.
describe('assenza di salute: catena fino al consumatore', () => {
  it('senza salute la derivazione non produce un oggetto', () => {
    for (const h of [null, undefined]) {
      expect(healthView(h, { online: true, lastSeen: 1, now: 1 })).toBeNull();
    }
  });
});
