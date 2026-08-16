import { describe, it, expect } from 'vitest';
import { panelPortForRoute } from './panel-port.js';

// P0 sicurezza, meta' remota: quale porta pannello usa il frame di UNA cella.
// La porta pannello e' per-CELLA attraverso la sua route: quella del nodo
// LOCALE per le celle locali, quella INOLTRATA (tunnel -L) del primo nodo
// della route per le celle remote. La guardia che conta: una cella remota il
// cui nodo non ha porta pannello negoziata NON prende mai in prestito la
// porta del nodo locale — sarebbe l'origin del pannello sbagliato, non un
// fallback.
describe('panelPortForRoute — porta pannello per cella', () => {
  const mappa = { vps: 43101, relay: 43102 };

  it('cella locale (route vuota): la porta pannello del nodo che serve la pagina', () => {
    expect(panelPortForRoute([], mappa, 41821)).toBe(41821);
    expect(panelPortForRoute(undefined, mappa, 41821)).toBe(41821);
  });

  it('cella remota: la porta inoltrata del primo nodo della route', () => {
    expect(panelPortForRoute(['vps'], mappa, 41821)).toBe(43101);
    expect(panelPortForRoute(['vps', 'relay'], mappa, 41821)).toBe(43101, 'la route appartiene al nodo che possiede la cella');
  });

  it('nodo remoto senza porta negoziata (peer vecchio): 0, MAI la porta locale', () => {
    expect(panelPortForRoute(['sconosciuto'], mappa, 41821)).toBe(0);
    expect(panelPortForRoute(['vps'], {}, 41821)).toBe(0);
  });

  it('valori malati non attraversano: porta 0 o non intero viene rifiutata, non aggiustata', () => {
    expect(panelPortForRoute([], mappa, 0)).toBe(0, 'config non ancora arrivata: 0, mai un frame verso porta 0');
    expect(panelPortForRoute([], mappa, undefined)).toBe(0);
    expect(panelPortForRoute(['vps'], { vps: '43101' }, 41821)).toBe(0, 'stringa non e\' una porta');
    expect(panelPortForRoute(['vps'], { vps: 0 }, 41821)).toBe(0);
    expect(panelPortForRoute(['vps'], { vps: 70000 }, 41821)).toBe(0);
    expect(panelPortForRoute('non-un-array', mappa, 41821)).toBe(0, 'garbage in, zero out');
  });
});
