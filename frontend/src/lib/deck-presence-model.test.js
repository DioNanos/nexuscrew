import { describe, it, expect, beforeEach } from 'vitest';
import {
  PRESENCE_KEY, PRESENCE_TTL_MS, PRESENCE_HIDDEN_TTL_MS,
  DOT_WORKING, DOT_ON, DOT_NEUTRAL, DOT_WARN,
  normalizePresence, pruneStale, upsertPresence, removePresence, dotForDeck, dotStatesForPresence,
  loadPresence, savePresence,
} from './deck-presence-model.js';

const NOW = 1_700_000_000_000;
const DECK = 'local:main';
const DECK2 = 'local:work';

beforeEach(() => localStorage.clear());

describe('normalizePresence (input corrotto)', () => {
  it('rejects non-object inputs', () => {
    expect(normalizePresence(null)).toEqual({});
    expect(normalizePresence([])).toEqual({});
    expect(normalizePresence('w1:{}')).toEqual({});
  });
  it('drops malformed entries but keeps good ones', () => {
    const out = normalizePresence({
      w1: { deckId: DECK, ts: NOW, focus: true, visible: true },
      w2: { deckId: '', ts: NOW },                 // deckId vuoto -> scartato
      w3: { deckId: DECK, ts: 'x' },               // ts non numerico -> scartato
      w4: { deckId: DECK, ts: NOW, focus: 'yes' }, // focus non bool -> normalizzato a false
      '': { deckId: DECK, ts: NOW },               // windowId vuoto -> scartato
    });
    expect(Object.keys(out).sort()).toEqual(['w1', 'w4']);
    expect(out.w4.focus).toBe(false);
    expect(out.w4.visible).toBe(false);
  });
  it('requires owner-qualified deck ids and numeric timestamps', () => {
    const out = normalizePresence({
      good: { deckId: DECK, ts: NOW },
      malformedDeck: { deckId: 'main', ts: NOW },
      nullTs: { deckId: DECK, ts: null },
      stringTs: { deckId: DECK, ts: String(NOW) },
    });
    expect(out).toEqual({ good: { deckId: DECK, ts: NOW, focus: false, visible: false } });
  });
  it('rejects prototype-sensitive and unsafe window ids', () => {
    const input = JSON.parse(`{"__proto__":{"deckId":"${DECK}","ts":${NOW}},"constructor":{"deckId":"${DECK}","ts":${NOW}},"safe-id":{"deckId":"${DECK}","ts":${NOW}}}`);
    expect(normalizePresence(input)).toEqual({
      'safe-id': { deckId: DECK, ts: NOW, focus: false, visible: false },
    });
  });
  it('bounds to MAX_WINDOWS entries', () => {
    const big = {};
    for (let i = 0; i < 100; i++) big[`w${i}`] = { deckId: DECK, ts: NOW, focus: false, visible: false };
    expect(Object.keys(normalizePresence(big)).length).toBeLessThanOrEqual(32);
  });
});

describe('pruneStale (TTL / cleanup)', () => {
  it('removes heartbeats older than TTL, keeps fresh ones', () => {
    const map = {
      fresh: { deckId: DECK, ts: NOW, focus: false, visible: true },
      edge: { deckId: DECK, ts: NOW - PRESENCE_TTL_MS, focus: false, visible: true },
      stale: { deckId: DECK, ts: NOW - PRESENCE_TTL_MS - 1, focus: false, visible: true },
    };
    const out = pruneStale(map, NOW);
    expect(Object.keys(out).sort()).toEqual(['edge', 'fresh']);
  });
  it('keeps everything when now is invalid', () => {
    const map = { w1: { deckId: DECK, ts: NOW, focus: false, visible: false } };
    expect(pruneStale(map, 'bad')).toEqual(map);
  });
  it('drops a timestamp too far in the future', () => {
    const map = { future: { deckId: DECK, ts: NOW + PRESENCE_TTL_MS + 1, focus: true, visible: true } };
    expect(pruneStale(map, NOW)).toEqual({});
  });
  it('keeps hidden windows through a one-minute throttled heartbeat gap', () => {
    const map = {
      hidden: { deckId: DECK, ts: NOW - 60000, focus: false, visible: false },
      visible: { deckId: DECK2, ts: NOW - 60000, focus: false, visible: true },
    };
    const out = pruneStale(map, NOW);
    expect(out).toHaveProperty('hidden');
    expect(out).not.toHaveProperty('visible');
    expect(dotForDeck(map, DECK, NOW)).toBe(DOT_ON);
  });
  it('eventually expires a fully suspended hidden window at its bounded TTL', () => {
    const map = {
      edge: { deckId: DECK, ts: NOW - PRESENCE_HIDDEN_TTL_MS, focus: false, visible: false },
      stale: { deckId: DECK, ts: NOW - PRESENCE_HIDDEN_TTL_MS - 1, focus: false, visible: false },
    };
    expect(Object.keys(pruneStale(map, NOW))).toEqual(['edge']);
  });
});

describe('upsertPresence / removePresence', () => {
  it('inserts a window and prunes stale in one step', () => {
    const stale = { old: { deckId: DECK, ts: NOW - PRESENCE_HIDDEN_TTL_MS - 5, focus: false, visible: false } };
    const out = upsertPresence(stale, 'me', { deckId: DECK, ts: NOW, focus: true, visible: true }, NOW);
    expect(Object.keys(out)).toEqual(['me']);
    expect(out.me).toMatchObject({ deckId: DECK, focus: true, visible: true });
  });
  it('updates an existing window in place', () => {
    let map = upsertPresence({}, 'me', { deckId: DECK, ts: NOW, focus: false, visible: false }, NOW);
    map = upsertPresence(map, 'me', { deckId: DECK2, ts: NOW + 1, focus: true, visible: true }, NOW + 1);
    expect(Object.keys(map)).toEqual(['me']);
    expect(map.me.deckId).toBe(DECK2);
  });
  it('rejects an invalid windowId', () => {
    expect(upsertPresence({}, '', { deckId: DECK, ts: NOW }, NOW)).toEqual({});
  });
  it('removes a window on cleanup', () => {
    const map = { me: { deckId: DECK, ts: NOW, focus: false, visible: false }, other: { deckId: DECK, ts: NOW, focus: false, visible: false } };
    expect(removePresence(map, 'me')).toEqual({ other: map.other });
  });
  it('evicts the oldest window so a new active window registers at capacity', () => {
    const full = {};
    for (let i = 0; i < 32; i++) {
      full[`w${i}`] = { deckId: DECK, ts: NOW + i, focus: false, visible: false };
    }
    const out = upsertPresence(full, 'new-window', { deckId: DECK2, focus: true, visible: true }, NOW + 100);
    expect(Object.keys(out)).toHaveLength(32);
    expect(out).not.toHaveProperty('w0');
    expect(out['new-window'].deckId).toBe(DECK2);
  });
});

describe('dotForDeck (dot state semantics)', () => {
  it('warn has priority when owner is offline, even if a window is focused', () => {
    const map = upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: true, visible: true }, NOW);
    expect(dotForDeck(map, DECK, NOW, true)).toBe(DOT_WARN);
  });
  it('neutral when no window holds the deck', () => {
    expect(dotForDeck({}, DECK, NOW, false)).toBe(DOT_NEUTRAL);
    const other = upsertPresence({}, 'w1', { deckId: DECK2, ts: NOW, focus: true, visible: true }, NOW);
    expect(dotForDeck(other, DECK, NOW, false)).toBe(DOT_NEUTRAL);
  });
  it('on when a window is focused but hidden', () => {
    const map = upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: true, visible: false }, NOW);
    expect(dotForDeck(map, DECK, NOW, false)).toBe(DOT_ON);
  });
  it('on when a window is visible but not focused', () => {
    const map = upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: false, visible: true }, NOW);
    expect(dotForDeck(map, DECK, NOW, false)).toBe(DOT_ON);
  });
  it('working only when a window is both focused and visible', () => {
    const map = upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: true, visible: true }, NOW);
    expect(dotForDeck(map, DECK, NOW, false)).toBe(DOT_WORKING);
  });
  it('on (steady) when open only in background', () => {
    const map = upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: false, visible: false }, NOW);
    expect(dotForDeck(map, DECK, NOW, false)).toBe(DOT_ON);
  });
  it('working wins over background across multiple windows of the same deck', () => {
    const map = {
      bg: { deckId: DECK, ts: NOW, focus: false, visible: false },
      fg: { deckId: DECK, ts: NOW, focus: true, visible: true },
    };
    expect(dotForDeck(map, DECK, NOW, false)).toBe(DOT_WORKING);
  });
  it('aggregates all deck states in one pass with working precedence', () => {
    const map = {
      bg: { deckId: DECK, ts: NOW, focus: false, visible: false },
      fg: { deckId: DECK, ts: NOW, focus: true, visible: true },
      other: { deckId: DECK2, ts: NOW, focus: false, visible: true },
    };
    expect(dotStatesForPresence(map, NOW)).toEqual({ [DECK]: DOT_WORKING, [DECK2]: DOT_ON });
  });
  it('stale entries do not count (becomes neutral if only stale)', () => {
    const map = { stale: { deckId: DECK, ts: NOW - PRESENCE_TTL_MS - 1, focus: true, visible: true } };
    expect(dotForDeck(map, DECK, NOW, false)).toBe(DOT_NEUTRAL);
  });
  it('neutral for an invalid deckId', () => {
    expect(dotForDeck({}, '', NOW, false)).toBe(DOT_NEUTRAL);
  });
});

describe('storage roundtrip', () => {
  it('save then load preserves entries', () => {
    savePresence(upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: true, visible: true }, NOW));
    const loaded = loadPresence();
    expect(loaded.w1).toMatchObject({ deckId: DECK, focus: true, visible: true });
  });
  it('survives corrupted storage', () => {
    localStorage.setItem(PRESENCE_KEY, '{not json');
    expect(loadPresence()).toEqual({});
  });
  it('works with an injectable storage', () => {
    const mem = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = v; } };
    savePresence(upsertPresence({}, 'w1', { deckId: DECK, ts: NOW, focus: false, visible: false }, NOW), mem);
    expect(loadPresence(mem).w1.deckId).toBe(DECK);
    expect(localStorage.getItem(PRESENCE_KEY)).toBeNull();
  });
});
