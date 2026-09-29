import { beforeEach, describe, expect, it } from 'vitest';
import { appendOrderJournal, clearOrderJournal, ORDER_JOURNAL_KEY, ORDER_JOURNAL_MAX, readOrderJournal } from './order-journal.js';
import { loadSidebarOrders, saveSidebarOrders } from './sidebar-model.js';
import { loadPins } from './pins.js';
import { loadNodeOrder } from './node-preferences.js';
import { CORRUPT_SUFFIX } from './pref-store.js';

beforeEach(() => { localStorage.clear(); });

describe('diario delle scritture dell\'ordine (ring buffer)', () => {
  it('registra ora, motivo e le chiavi prima/dopo/visibili', () => {
    appendOrderJournal({ reason: 'move', position: 'local', before: ['a', 'b'], after: ['b', 'a'], visible: ['a', 'b'] });
    const [e] = readOrderJournal();
    expect(e.reason).toBe('move'); expect(e.before).toEqual(['a', 'b']); expect(e.after).toEqual(['b', 'a']);
    expect(typeof e.t).toBe('number');
  });
  it('tiene solo le ultime 50 voci', () => {
    for (let i = 0; i < ORDER_JOURNAL_MAX + 20; i += 1) appendOrderJournal({ reason: 'move', note: String(i) });
    const j = readOrderJournal();
    expect(j).toHaveLength(ORDER_JOURNAL_MAX);
    expect(j[j.length - 1].note).toBe(String(ORDER_JOURNAL_MAX + 19));
    expect(j[0].note).toBe('20');
  });
  it('limita la dimensione di ogni voce (niente payload enormi) e non contiene token', () => {
    appendOrderJournal({ reason: 'move', before: Array.from({ length: 500 }, (_, i) => `chiave-${i}`) });
    const [e] = readOrderJournal();
    expect(e.before.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(readOrderJournal())).not.toMatch(/nc_token/);
  });
  it('un diario illeggibile non blocca: si riparte pulito e la copia grezza resta', () => {
    localStorage.setItem(ORDER_JOURNAL_KEY, '{rotto');
    expect(readOrderJournal()).toEqual([]);
    appendOrderJournal({ reason: 'move' });
    expect(readOrderJournal()).toHaveLength(1);
    expect(localStorage.getItem(ORDER_JOURNAL_KEY + CORRUPT_SUFFIX)).toBe('{rotto');
  });
  it('clearOrderJournal svuota', () => { appendOrderJournal({ reason: 'x' }); clearOrderJournal(); expect(readOrderJournal()).toEqual([]); });
});

// O4: parse fallito -> default, e poi il default veniva riscritto sopra: il valore grezzo andava perso.
describe('parse fallito: il valore grezzo si conserva (O4)', () => {
  it('ordine corrotto: default in memoria, grezzo copiato in __corrupt e nel diario', () => {
    localStorage.setItem('nc_sidebar_order_v1', '{"local":["a","b"');   // troncato
    expect(loadSidebarOrders()).toEqual({});
    expect(localStorage.getItem('nc_sidebar_order_v1' + CORRUPT_SUFFIX)).toBe('{"local":["a","b"');
    expect(readOrderJournal().some((e) => e.reason === 'corrupt-preserved' && e.key === 'nc_sidebar_order_v1')).toBe(true);
  });
  it('il primo riordino dopo un valore corrotto NON distrugge il grezzo', () => {
    localStorage.setItem('nc_sidebar_order_v1', '{"local":["a","b"');
    saveSidebarOrders({ local: ['b', 'a'] });
    expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1'))).toEqual({ local: ['b', 'a'] });
    expect(localStorage.getItem('nc_sidebar_order_v1' + CORRUPT_SUFFIX)).toBe('{"local":["a","b"');
  });
  it('pin e ordine dei nodi corrotti: stesso trattamento', () => {
    localStorage.setItem('nc_pins', '["a",'); localStorage.setItem('nc_node_order_v1', 'oops');
    expect(loadPins()).toEqual([]); expect(loadNodeOrder()).toEqual([]);
    expect(localStorage.getItem('nc_pins' + CORRUPT_SUFFIX)).toBe('["a",');
    expect(localStorage.getItem('nc_node_order_v1' + CORRUPT_SUFFIX)).toBe('oops');
  });
  it('un valore assente o valido non genera copie ne\' voci di diario', () => {
    localStorage.setItem('nc_pins', '["a"]');
    expect(loadPins()).toEqual(['a']); expect(loadSidebarOrders()).toEqual({});
    expect(Object.keys(localStorage).some((k) => k.endsWith(CORRUPT_SUFFIX))).toBe(false);
    expect(readOrderJournal()).toEqual([]);
  });
  it('una copia corrotta gia\' conservata non viene ripetuta a ogni lettura', () => {
    localStorage.setItem('nc_pins', '["a",');
    loadPins(); loadPins(); loadPins();
    expect(readOrderJournal().filter((e) => e.reason === 'corrupt-preserved')).toHaveLength(1);
  });
});
