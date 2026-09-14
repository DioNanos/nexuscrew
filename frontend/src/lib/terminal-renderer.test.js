import { describe, expect, it, vi } from 'vitest';
import {
  RENDERER_DOM, RENDERER_STORAGE_KEY, RENDERER_WEBGL, attachRenderer,
  nextRendererPreference, readRendererPreference, writeRendererPreference,
} from './terminal-renderer.js';

function memoriaFinta(initial) {
  const dati = new Map(initial ? [[RENDERER_STORAGE_KEY, initial]] : []);
  return {
    getItem: (k) => (dati.has(k) ? dati.get(k) : null),
    setItem: (k, v) => dati.set(k, String(v)),
    removeItem: (k) => dati.delete(k),
  };
}

function terminalFinto() {
  const loaded = [];
  return { loadAddon: (a) => loaded.push(a), loaded };
}

describe('renderer preference', () => {
  it('defaults to the GPU renderer and stays there for anything unknown', () => {
    expect(readRendererPreference(memoriaFinta())).toBe(RENDERER_WEBGL);
    expect(readRendererPreference(memoriaFinta('boh'))).toBe(RENDERER_WEBGL);
  });

  it('remembers an explicit DOM choice and toggles back', () => {
    const store = memoriaFinta();
    expect(writeRendererPreference(RENDERER_DOM, store)).toBe(RENDERER_DOM);
    expect(readRendererPreference(store)).toBe(RENDERER_DOM);
    expect(nextRendererPreference(RENDERER_DOM)).toBe(RENDERER_WEBGL);
    expect(nextRendererPreference(RENDERER_WEBGL)).toBe(RENDERER_DOM);
  });

  it('never throws when storage is denied (private mode, iframe)', () => {
    const negato = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readRendererPreference(negato)).toBe(RENDERER_WEBGL);
    expect(writeRendererPreference(RENDERER_DOM, negato)).toBe(RENDERER_DOM);
  });
});

describe('attachRenderer', () => {
  it('loads no addon at all when the DOM renderer was chosen', () => {
    const term = terminalFinto();
    const createAddon = vi.fn();
    const out = attachRenderer(term, { preference: RENDERER_DOM, createAddon });
    expect(out.kind).toBe(RENDERER_DOM);
    expect(createAddon).not.toHaveBeenCalled();
    expect(term.loaded).toHaveLength(0);
  });

  it('loads the GPU addon when it is available', () => {
    const term = terminalFinto();
    const addon = { dispose: vi.fn(), onContextLoss: vi.fn() };
    const out = attachRenderer(term, { preference: RENDERER_WEBGL, createAddon: () => addon });
    expect(out.kind).toBe(RENDERER_WEBGL);
    expect(term.loaded).toEqual([addon]);
    out.dispose();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the DOM renderer, without failing, when WebGL is unavailable', () => {
    const term = terminalFinto();
    const onFallback = vi.fn();
    const out = attachRenderer(term, {
      preference: RENDERER_WEBGL,
      createAddon: () => { throw new Error('WebGL not supported'); },
      onFallback,
    });
    expect(out.kind).toBe(RENDERER_DOM);
    expect(onFallback).toHaveBeenCalledWith('unavailable');
    expect(term.loaded).toHaveLength(0);
    expect(() => out.dispose()).not.toThrow();
  });

  it('drops the addon and reports the fallback when the context is lost', () => {
    const term = terminalFinto();
    let lose = null;
    const addon = { dispose: vi.fn(), onContextLoss: (cb) => { lose = cb; } };
    const onFallback = vi.fn();
    attachRenderer(term, { preference: RENDERER_WEBGL, createAddon: () => addon, onFallback });
    expect(typeof lose).toBe('function');
    lose();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('context-loss');
  });
});
