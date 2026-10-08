import { describe, expect, it } from 'vitest';
import { deckId } from './deck-federation.js';
import { orderDeckRecords } from './deck-model.js';

// l'ordine dei DECKS in alto segue la lista nodi/celle a sinistra.
// Le chiavi della lista sono nodePreferenceKey: 'local' (nodo locale) e
// 'id:<instanceId>' (owner federati) — mai l'etichetta.

const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);
const OWNER_C = 'c'.repeat(32);

const rec = (ownerId, name, local = false) => ({
  id: deckId(local ? 'local' : ownerId, name),
  name,
  ownerId,
  ownerLabel: local ? 'Local' : ownerId.slice(0, 4),
  local,
  available: true,
});

const records = [
  rec(null, 'main', true),
  rec(OWNER_A, 'main'),
  rec(OWNER_B, 'main'),
  rec(null, 'work', true),
  rec(OWNER_A, 'richerche'),
];

describe('orderDeckRecords — ordine dei gruppi', () => {
  it('senza lista: i gruppi restano in ordine di prima apparizione (comportamento precedente)', () => {
    const out = orderDeckRecords(records, {});
    expect(out.map((d) => d.ownerId)).toEqual([null, null, OWNER_A, OWNER_A, OWNER_B]);
  });

  it('il gruppo locale resta per primo anche con la lista', () => {
    const out = orderDeckRecords(records, {}, ['id:' + OWNER_B, 'id:' + OWNER_A]);
    expect(out[0].local).toBe(true);
    expect(out[0].name).toBe('main');
  });

  it('i gruppi owner seguono l\'ordine della lista nodi (per id, non per etichetta)', () => {
    const out = orderDeckRecords(records, {}, ['id:' + OWNER_B, 'id:' + OWNER_A]);
    expect(out.map((d) => d.id)).toEqual([
      'local:main', 'local:work',
      `${OWNER_B}:main`,
      `${OWNER_A}:main`, `${OWNER_A}:richerche`,
    ]);
  });

  it('un gruppo che non sta nella lista va in coda, stabile sull\'arrivo', () => {
    const out = orderDeckRecords(records, {}, ['id:' + OWNER_A]);
    const coda = out.filter((d) => d.ownerId === OWNER_B);
    expect(coda).toHaveLength(1);
    // local primo, poi OWNER_A (in lista), poi OWNER_B (coda)
    expect(out.map((d) => d.ownerId)).toEqual([null, null, OWNER_A, OWNER_A, OWNER_B]);
  });

  it('un riordino nella lista si riflette sui gruppi con gli stessi record', () => {
    const primo = orderDeckRecords(records, {}, ['id:' + OWNER_A, 'id:' + OWNER_B]);
    const secondo = orderDeckRecords(records, {}, ['id:' + OWNER_B, 'id:' + OWNER_A]);
    expect(primo.map((d) => d.ownerId).filter(Boolean)).toEqual([OWNER_A, OWNER_A, OWNER_B]);
    expect(secondo.map((d) => d.ownerId).filter(Boolean)).toEqual([OWNER_B, OWNER_A, OWNER_A]);
  });

  it('dentro il gruppo la preferenza di riordino dei tab resta valida (regressione)', () => {
    const orders = { [OWNER_A]: [deckId(OWNER_A, 'richerche'), deckId(OWNER_A, 'main')] };
    const out = orderDeckRecords(records, orders, ['id:' + OWNER_A]);
    const a = out.filter((d) => d.ownerId === OWNER_A);
    expect(a.map((d) => d.name)).toEqual(['richerche', 'main']);
  });

  it('una lista vuota di record resta vuota e non lancia', () => {
    expect(orderDeckRecords([], {}, ['id:' + OWNER_A])).toEqual([]);
    expect(orderDeckRecords(undefined, {}, ['id:' + OWNER_A])).toEqual([]);
  });

  it('niente salti: dati che arrivano in ordini diversi, lista fissa, gruppi identici', () => {
    const mescolati = [rec(OWNER_B, 'main'), rec(OWNER_A, 'richerche'), rec(null, 'work', true), rec(null, 'main', true), rec(OWNER_A, 'main')];
    const nodeOrder = ['id:' + OWNER_A, 'id:' + OWNER_B];
    const atteso = orderDeckRecords(records, {}, nodeOrder);
    const ottenuto = orderDeckRecords(mescolati, {}, nodeOrder);
    expect(ottenuto.map((d) => d.id).sort()).toEqual(atteso.map((d) => d.id).sort());
    // gruppi nello stesso ordine di lista (local, A, B) per entrambi
    const gruppi = (list) => [...new Set(list.map((d) => (d.local ? 'local' : d.ownerId)))];
    expect(gruppi(ottenuto)).toEqual(['local', OWNER_A, OWNER_B]);
  });

  it('un gruppo owner mai visto dalla lista (nodeOrder con voci sconosciute) non sposta i noti', () => {
    const out = orderDeckRecords(records, {}, ['id:' + OWNER_C, 'id:' + OWNER_B, 'id:' + OWNER_A]);
    // OWNER_C non esiste tra i record: ignorato; B prima di A come da lista
    expect(out.map((d) => d.ownerId).filter(Boolean)).toEqual([OWNER_B, OWNER_A, OWNER_A]);
  });
});
