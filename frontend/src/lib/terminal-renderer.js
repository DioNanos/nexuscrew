// Which renderer draws the terminal, and what happens when the fast one cannot.
//
// `@xterm/addon-webgl` paints the same xterm core on a GPU canvas instead of
// DOM rows: fewer repaints of the cells a wide character just invalidated, which
// is the second half of the stale-glyph defect. It is a performance choice, so
// every failure path here ends on the DOM renderer — nothing in this file may
// turn a terminal that draws into one that does not.
//
// The choice is per browser (localStorage), so it can be flipped on a phone for
// an A/B without a rebuild.
export const RENDERER_STORAGE_KEY = 'nc-terminal-renderer';
export const RENDERER_WEBGL = 'webgl';
export const RENDERER_DOM = 'dom';

function safeStorage(storage) {
  if (storage !== undefined) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}

export function readRendererPreference(storage) {
  const store = safeStorage(storage);
  try {
    return store && store.getItem(RENDERER_STORAGE_KEY) === RENDERER_DOM ? RENDERER_DOM : RENDERER_WEBGL;
  } catch (_) { return RENDERER_WEBGL; }
}

export function writeRendererPreference(value, storage) {
  const next = value === RENDERER_DOM ? RENDERER_DOM : RENDERER_WEBGL;
  const store = safeStorage(storage);
  try { if (store) store.setItem(RENDERER_STORAGE_KEY, next); } catch (_) { /* private mode: in-memory only */ }
  return next;
}

export function nextRendererPreference(current) {
  return current === RENDERER_DOM ? RENDERER_WEBGL : RENDERER_DOM;
}

// Attaches the GPU renderer on top of the DOM one the terminal already has.
// `createAddon` is injected so this stays testable without a WebGL context.
export function attachRenderer(term, { preference, createAddon, onFallback } = {}) {
  const wanted = preference || readRendererPreference();
  const domOnly = { kind: RENDERER_DOM, dispose: () => {} };
  if (wanted !== RENDERER_WEBGL) return domOnly;
  if (!term || typeof term.loadAddon !== 'function' || typeof createAddon !== 'function') return domOnly;

  let addon;
  try {
    addon = createAddon();
    if (!addon) return domOnly;
    term.loadAddon(addon);
  } catch (_) {
    // No WebGL context, a driver that refuses, an addon that cannot bind: the
    // terminal keeps drawing with the DOM renderer it already had.
    try { if (addon) addon.dispose(); } catch (__) { /* best effort */ }
    if (onFallback) onFallback('unavailable');
    return domOnly;
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { addon.dispose(); } catch (_) { /* best effort */ }
  };
  // The context can be lost later (background tab, driver reset). Dropping the
  // addon hands the terminal back to the DOM renderer; it must not stay on a
  // dead canvas.
  if (typeof addon.onContextLoss === 'function') {
    addon.onContextLoss(() => { dispose(); if (onFallback) onFallback('context-loss'); });
  }
  return { kind: RENDERER_WEBGL, dispose };
}
