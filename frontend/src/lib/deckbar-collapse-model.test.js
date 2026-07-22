import { describe, it, expect, beforeEach } from 'vitest';
import {
  COLLAPSE_KEY, validOwnerKey, normalizeCollapsed, isCollapsedOf,
  toggleCollapsedIn, setCollapsedIn, loadCollapsed, saveCollapsed,
} from './deckbar-collapse-model.js';

const NODE = 'a'.repeat(16);
const NODE2 = 'b'.repeat(16);

beforeEach(() => localStorage.clear());

describe('validOwnerKey', () => {
  it('accepts local and hex node ids, rejects everything else', () => {
    expect(validOwnerKey('local')).toBe(true);
    expect(validOwnerKey(NODE)).toBe(true);
    expect(validOwnerKey('not-a-node')).toBe(false);
    expect(validOwnerKey('')).toBe(false);
    expect(validOwnerKey(null)).toBe(false);
    expect(validOwnerKey(123)).toBe(false);
  });
});

describe('default collapsed (nuovi owner partono compressi)', () => {
  it('an absent owner is collapsed', () => {
    expect(isCollapsedOf({}, 'local')).toBe(true);
    expect(isCollapsedOf({}, NODE)).toBe(true);
  });
  it('an explicitly expanded owner is not collapsed', () => {
    expect(isCollapsedOf({ local: false }, 'local')).toBe(false);
    expect(isCollapsedOf({ [NODE]: false }, NODE)).toBe(false);
  });
  it('an explicitly collapsed owner stays collapsed', () => {
    expect(isCollapsedOf({ [NODE]: true }, NODE)).toBe(true);
  });
  it('an invalid ownerKey is always collapsed (safe default)', () => {
    expect(isCollapsedOf({}, 'garbage')).toBe(true);
    expect(isCollapsedOf({ garbage: false }, 'garbage')).toBe(true);
  });
});

describe('toggleCollapsedIn', () => {
  it('expands an absent owner (default collapsed -> expanded)', () => {
    expect(toggleCollapsedIn({}, 'local').local).toBe(false);
  });
  it('flips an explicit preference both ways', () => {
    expect(toggleCollapsedIn({ local: false }, 'local').local).toBe(true);
    expect(toggleCollapsedIn({ local: true }, 'local').local).toBe(false);
  });
  it('does not touch other owners', () => {
    const next = toggleCollapsedIn({ local: false, [NODE]: true }, NODE);
    expect(next.local).toBe(false);
    expect(next[NODE]).toBe(false);
  });
  it('ignores an invalid ownerKey', () => {
    expect(toggleCollapsedIn({}, 'garbage')).toEqual({});
  });
});

describe('input corrotto / normalizzazione bounded', () => {
  it('rejects non-object inputs', () => {
    expect(normalizeCollapsed(null)).toEqual({});
    expect(normalizeCollapsed([])).toEqual({});
    expect(normalizeCollapsed('local:false')).toEqual({});
    expect(normalizeCollapsed(undefined)).toEqual({});
  });
  it('drops non-boolean values and non-owner keys', () => {
    const out = normalizeCollapsed({
      local: 'true',        // string -> scartato
      [NODE]: 1,            // number -> scartato
      [NODE2]: false,       // ok
      'garbage': true,      // key non valida -> scartato
      null: true,           // valore null -> scartato (chiave 'null' non owner)
    });
    expect(out).toEqual({ [NODE2]: false });
  });
  it('bounds the map to MAX_OWNERS entries with distinct owner keys', () => {
    const big = {};
    for (let i = 0; i < 200; i++) {
      const id = i.toString(16).padStart(16, '0');
      big[id] = true;
    }
    expect(Object.keys(normalizeCollapsed(big)).length).toBe(64);
  });
  it('evicts the oldest preference so a new owner remains clickable at capacity', () => {
    const full = {};
    for (let i = 0; i < 64; i++) full[i.toString(16).padStart(16, '0')] = true;
    const oldest = '0'.repeat(16);
    const newcomer = 'f'.repeat(16);
    const next = toggleCollapsedIn(full, newcomer);
    expect(Object.keys(next)).toHaveLength(64);
    expect(next).not.toHaveProperty(oldest);
    expect(next[newcomer]).toBe(false);
  });
});

describe('persistenza owner-qualified (storage roundtrip)', () => {
  it('save then load preserves explicit preferences', () => {
    saveCollapsed({ local: false, [NODE]: true });
    expect(loadCollapsed()).toEqual({ local: false, [NODE]: true });
  });
  it('an absent key still loads as empty (default applies downstream)', () => {
    expect(loadCollapsed()).toEqual({});
  });
  it('survives corrupted storage by returning empty', () => {
    localStorage.setItem(COLLAPSE_KEY, '{not json');
    expect(loadCollapsed()).toEqual({});
  });
  it('cleans corrupted entries on save', () => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ local: 'x', garbage: true, [NODE]: false }));
    const loaded = loadCollapsed();
    expect(loaded).toEqual({ [NODE]: false }); // solo valido sopravvive
  });
  it('does not leak topology: stored shape is only {ownerKey: bool}', () => {
    saveCollapsed({ local: false, [NODE]: true });
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY));
    const sample = Object.entries(raw)[0];
    expect(typeof sample[0]).toBe('string'); // chiave opaca
    expect(typeof sample[1]).toBe('boolean');
  });
  it('uses an injectable storage (no global side effect when omitted)', () => {
    const mem = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; } };
    saveCollapsed({ local: false }, mem);
    expect(loadCollapsed(mem)).toEqual({ local: false });
    expect(localStorage.getItem(COLLAPSE_KEY)).toBeNull();
  });
});

describe('setCollapsedIn', () => {
  it('sets an explicit value', () => {
    expect(setCollapsedIn({}, 'local', false).local).toBe(false);
    expect(setCollapsedIn({ local: false }, 'local', true).local).toBe(true);
  });
});
