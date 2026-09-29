import { describe, expect, it } from 'vitest';
import { moveSidebarItem, sidebarOrder } from './sidebar-model.js';
import { moveNodeGroup } from './node-preferences.js';

// O1: lo spostamento riscriveva l'ordine salvato SENZA le chiavi non visibili in quel momento
// (nodo in errore, cella spenta non ancora letta): al ritorno quelle finivano in coda.
// Riprodotto sul bundle 0.9.52: 7 chiavi → 3 dopo un solo spostamento.
const ordine = ['alfa', 'beta', 'gamma', 'delta', 'shell1', 'epsilon', 'zeta'].map((k) => `nodo:${k}`);
const visibili = ['delta', 'gamma', 'shell1'].map((k) => `nodo:${k}`);

describe('moveSidebarItem non scarta le chiavi assenti (O1)', () => {
  it('un solo spostamento con la lista parziale conserva tutte le 7 chiavi', () => {
    const next = moveSidebarItem({ nodo: ordine }, 'nodo', 'nodo:shell1', 'nodo:delta', visibili);
    const dopo = sidebarOrder(next, 'nodo');
    expect([...dopo].sort()).toEqual([...ordine].sort());
  });

  it('le chiavi assenti restano dove erano rispetto alle altre (alfa e beta in cima)', () => {
    const dopo = sidebarOrder(moveSidebarItem({ nodo: ordine }, 'nodo', 'nodo:shell1', 'nodo:delta', visibili), 'nodo');
    expect(dopo.slice(0, 2)).toEqual(['nodo:alfa', 'nodo:beta']);
    expect(dopo.indexOf('nodo:shell1')).toBeLessThan(dopo.indexOf('nodo:delta'));
  });

  it('lo spostamento fra visibili funziona ancora nelle due direzioni', () => {
    const su = sidebarOrder(moveSidebarItem({ p: ['a', 'b', 'c'] }, 'p', 'c', 'a', ['a', 'b', 'c']), 'p');
    expect(su).toEqual(['c', 'a', 'b']);
    const giu = sidebarOrder(moveSidebarItem({ p: ['a', 'b', 'c'] }, 'p', 'a', 'c', ['a', 'b', 'c']), 'p');
    expect(giu).toEqual(['b', 'c', 'a']);
  });

  it('una chiave visibile mai salvata entra in coda senza perdere le altre', () => {
    const dopo = sidebarOrder(moveSidebarItem({ p: ['a', 'x'] }, 'p', 'n', 'a', ['a', 'n']), 'p');
    expect(dopo).toContain('x'); expect(dopo).toContain('n'); expect(dopo).toContain('a');
    expect(new Set(dopo).size).toBe(dopo.length);
  });

  it('proprieta\': per qualunque sequenza di mosse e di visibilita\' l\'insieme salvato non diminuisce mai', () => {
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const tutte = Array.from({ length: 12 }, (_, i) => `k${i}`);
    let orders = { p: [...tutte] };
    for (let i = 0; i < 400; i += 1) {
      const vis = tutte.filter(() => rnd() > 0.45);
      if (vis.length < 2) continue;
      const a = vis[Math.floor(rnd() * vis.length)]; const b = vis[Math.floor(rnd() * vis.length)];
      const prima = new Set(sidebarOrder(orders, 'p'));
      orders = moveSidebarItem(orders, 'p', a, b, vis);
      const dopo = sidebarOrder(orders, 'p');
      for (const k of prima) expect(dopo).toContain(k);
      expect(new Set(dopo).size).toBe(dopo.length);
    }
  });
});

describe('moveNodeGroup non scarta i nodi assenti (O1, stesso schema)', () => {
  const gruppo = (id) => ({ instanceId: id.repeat(32).slice(0, 32), route: [id], name: id });
  const key = (id) => `id:${id.repeat(32).slice(0, 32)}`;
  it('un nodo offline non sparisce dall\'ordine dei nodi al primo spostamento', () => {
    const order = [key('a'), key('b'), key('c'), key('d')];
    const visibili = [gruppo('a'), gruppo('c'), gruppo('d')];      // b e' offline
    const next = moveNodeGroup(order, key('d'), key('a'), visibili);
    expect([...next].sort()).toEqual([...order].sort());
    expect(next.indexOf(key('b'))).toBeGreaterThanOrEqual(0);
  });
  it('lo spostamento fra nodi visibili resta corretto', () => {
    const order = [key('a'), key('b'), key('c')];
    const next = moveNodeGroup(order, key('c'), key('a'), [gruppo('a'), gruppo('b'), gruppo('c')]);
    expect(next).toEqual([key('c'), key('a'), key('b')]);
  });
});
