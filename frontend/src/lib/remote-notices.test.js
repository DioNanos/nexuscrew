// Unit puri per l'arretrato notifiche importate: dedup per (ownerId,eventId)
// nei due ordini, cap sulle piu' recenti per ts, tipi ammessi, ts normalizzato.
import { describe, it, expect } from 'vitest';
import {
  MAX_REMOTE_NOTICES, normalizeTs, noticeKeyOf, toRemoteNotice,
  mergeRemoteNotices, boundedByTs,
} from './remote-notices.js';

const env = (eventId, ts, extra = {}) => ({ type: 'notify', eventId, title: 'T ' + eventId, urgency: 'normal', ts, ...extra });
const card = (ownerId, eventId, ts) => toRemoteNotice(env(eventId, ts), ownerId);

describe('normalizeTs e noticeKeyOf', () => {
  it('ts numerico resta, stringa ISO viene parsata, spazzatura -> 0', () => {
    expect(normalizeTs(1700000000000)).toBe(1700000000000);
    expect(normalizeTs('2026-09-22T18:46:09.220Z')).toBe(Date.parse('2026-09-22T18:46:09.220Z'));
    expect(normalizeTs(undefined)).toBe(0);
  });

  it('noticeKeyOf: la coppia (ownerId,eventId) e\' la chiave', () => {
    expect(noticeKeyOf('nodeX', 'e1')).toBe('nodeX|e1');
  });
});

describe('toRemoteNotice', () => {
  it('ammette solo type notify con eventId e testo; il resto -> null', () => {
    expect(toRemoteNotice({ type: 'notify', eventId: 'e1', title: 't' }, 'X')).not.toBeNull();
    expect(toRemoteNotice({ type: 'fleet-state', eventId: 'e2', title: 'x' }, 'X')).toBeNull();
    expect(toRemoteNotice({ type: 'notify', title: 'senza id' }, 'X')).toBeNull();
    expect(toRemoteNotice({ type: 'notify', eventId: 'e3' }, 'X')).toBeNull();
  });

  it('urgency non-high degrada a normal e il testo resta stringa', () => {
    const c = toRemoteNotice({ type: 'notify', eventId: 'e1', title: 't', urgency: 'high', body: 'b' }, 'X');
    expect(c.urgency).toBe('high');
    expect(c.title).toBe('t');
    expect(c.body).toBe('b');
  });
});

describe('mergeRemoteNotices: dedup nei due ordini (snapshot+SSE)', () => {
  it('snapshot prima, live dopo: una sola card per (ownerId,eventId)', () => {
    const current = [card('nodeX', 'e9', 5)];
    const incoming = [card('nodeX', 'e9', 7)];
    const merged = mergeRemoteNotices(current, incoming, null);
    expect(merged.length).toBe(1);
    expect(merged[0].ts).toBe(7);
  });

  it('live prima, snapshot dopo: una sola card per (ownerId,eventId)', () => {
    const incoming = [card('nodeX', 'e9', 7)];
    const current = [card('nodeX', 'e9', 5)];
    const merged = mergeRemoteNotices(current, incoming, null);
    expect(merged.length).toBe(1);
  });

  it('due eventi diversi dello stesso owner restano due card', () => {
    const merged = mergeRemoteNotices(
      [card('nodeX', 'a', 1)], [card('nodeX', 'b', 2)], null,
    );
    expect(merged.length).toBe(2);
  });
});

describe('cap e taglio per ts', () => {
  it('mergeRemoteNotices oltre il cap tiene le piu recenti per ts, non le ultime inserite', () => {
    const notices = [];
    for (let i = 0; i < 55; i += 1) notices.push(card('nodeX', 'e' + i, 1000 + i));
    notices.unshift(card('nodeX', 'ts-alto', 99999)); // inserita per prima, ts massimo
    const merged = boundedByTs(mergeRemoteNotices([], notices, null));
    expect(merged.length).toBe(MAX_REMOTE_NOTICES);
    expect(merged.some((c) => c.eventId === 'ts-alto')).toBe(true);
    expect(merged.some((c) => c.eventId === 'e0')).toBe(false);
    expect(merged.some((c) => c.eventId === 'e6')).toBe(true);
    expect(merged.some((c) => c.eventId === 'e5')).toBe(false);
  });

  it('boundedByTs su un elenco gia\' pronto rispetta il cap', () => {
    const list = Array.from({ length: 60 }, (_, i) => card('nodeX', 'x' + i, i));
    expect(boundedByTs(list).length).toBe(MAX_REMOTE_NOTICES);
    expect(boundedByTs(list)[0].ts).toBe(59);
  });
});
