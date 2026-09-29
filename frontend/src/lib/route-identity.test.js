import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalPosition, positionView, registerRouteIdentities, resetRouteRegistry, ROUTE_ALIAS_KEY } from './route-identity.js';

const X = 'a'.repeat(32); const Y = 'b'.repeat(32);
const group = (name, id) => ({ name, route: [name], instanceId: id });
const store = (key) => JSON.parse(localStorage.getItem(key));

beforeEach(() => { localStorage.clear(); resetRouteRegistry(); });

describe('identita\' stabile delle posizioni (O3)', () => {
  it('prima visita: copia la posizione per nome sotto id:<instanceId> e lascia la vecchia', () => {
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ vecchio: ['vecchio:cloud-Dev', 'vecchio:cloud-Fork'] }));
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ vecchio: { open: false, filter: 'all' } }));
    registerRouteIdentities([group('vecchio', X)]);
    expect(store('nc_sidebar_order_v1')[`id:${X}`]).toEqual(['vecchio:cloud-Dev', 'vecchio:cloud-Fork']);
    expect(store('nc_sidebar_order_v1').vecchio).toEqual(['vecchio:cloud-Dev', 'vecchio:cloud-Fork']);
    expect(store('nc_sidebar_views_v1')[`id:${X}`]).toEqual({ open: false, filter: 'all' });
    expect(store(ROUTE_ALIAS_KEY)[X]).toBe('vecchio');
  });

  it('rinomina: pin, ordine e vista seguono il nodo, le chiavi vecchie restano', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['vecchio:cloud-Dev', 'altro:cloud-X']));
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ vecchio: ['vecchio:cloud-Fork', 'vecchio:cloud-Dev'] }));
    registerRouteIdentities([group('vecchio', X)]);
    resetRouteRegistry();
    registerRouteIdentities([group('nuovo', X)]);
    expect(store('nc_pins')).toEqual(['vecchio:cloud-Dev', 'altro:cloud-X', 'nuovo:cloud-Dev']);
    expect(store('nc_sidebar_order_v1')[`id:${X}`]).toEqual(['nuovo:cloud-Fork', 'nuovo:cloud-Dev']);
    expect(store('nc_sidebar_order_v1').vecchio).toEqual(['vecchio:cloud-Fork', 'vecchio:cloud-Dev']);
    expect(canonicalPosition('nuovo')).toBe(`id:${X}`);
    expect(positionView(store('nc_sidebar_order_v1')).nuovo).toEqual(['nuovo:cloud-Fork', 'nuovo:cloud-Dev']);
  });

  it('e\' idempotente: rieseguirla non cambia lo storage, e un pin tolto non ricompare', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['vecchio:cloud-Dev']));
    registerRouteIdentities([group('vecchio', X)]);
    resetRouteRegistry();
    registerRouteIdentities([group('nuovo', X)]);
    localStorage.setItem('nc_pins', JSON.stringify(['vecchio:cloud-Dev']));
    const snapshot = { ...localStorage };
    for (let i = 0; i < 3; i += 1) { resetRouteRegistry(); registerRouteIdentities([group('nuovo', X)]); }
    expect(store('nc_pins')).toEqual(['vecchio:cloud-Dev']);
    expect({ ...localStorage }).toEqual(snapshot);
  });

  it('due dispositivi: un dispositivo che non ha mai visto il vecchio nome non eredita nulla dall\'altro', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['vecchio:cloud-Dev']));
    registerRouteIdentities([group('vecchio', X)]);
    resetRouteRegistry();
    registerRouteIdentities([group('nuovo', X)]);
    const a = { ...localStorage };
    localStorage.clear(); resetRouteRegistry();
    localStorage.setItem('nc_pins', JSON.stringify(['nuovo:cloud-Fork']));
    registerRouteIdentities([group('nuovo', X)]);
    expect(store('nc_pins')).toEqual(['nuovo:cloud-Fork']);
    expect(a.nc_pins).toContain('nuovo:cloud-Dev');
  });

  it('un vecchio nome ora usato da un altro nodo non viene riscritto', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['vecchio:cloud-Dev']));
    registerRouteIdentities([group('vecchio', X)]);
    resetRouteRegistry();
    registerRouteIdentities([group('nuovo', X), group('vecchio', Y)]);
    expect(store('nc_pins')).toEqual(['vecchio:cloud-Dev']);
  });

  it('rinomina con il fantasma del vecchio nome ancora in lista (sticky): migra verso il nome VIVO', () => {
    localStorage.setItem('nc_pins', JSON.stringify(['vecchio:cloud-Dev']));
    registerRouteIdentities([{ ...group('vecchio', X), status: 'up' }]);
    resetRouteRegistry();
    registerRouteIdentities([{ ...group('vecchio', X), status: 'down' }, { ...group('nuovo', X), status: 'up' }]);
    expect(store('nc_pins')).toEqual(['vecchio:cloud-Dev', 'nuovo:cloud-Dev']);
    expect(store(ROUTE_ALIAS_KEY)[X]).toBe('nuovo');
  });

  it('senza instanceId valido non migra ne\' scrive', () => {
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ n: ['n:a'] }));
    expect(registerRouteIdentities([{ name: 'n', route: ['n'], instanceId: 'x' }])).toBe(false);
    expect(store('nc_sidebar_order_v1')).toEqual({ n: ['n:a'] });
    expect(canonicalPosition('n')).toBe('n');
  });
});
