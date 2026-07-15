import { OWNER_ID_RE } from './grid-model.js';

// Browser-local composer persistence. The stable coordinate is the tmux
// session inside its owner node; a mutable Hydra route is only a legacy
// fallback while ownerId is unavailable.
export const COMPOSER_STORAGE_KEY = 'nc_composer_v1';
export const COMPOSER_RESET_EVENT = 'nc-composer-reset';
export const COMPOSER_MAX_HISTORY = 50;
export const COMPOSER_MAX_ENTRY_CHARS = 256 * 1024;
export const COMPOSER_MAX_DRAFT_CHARS = 512 * 1024;
export const COMPOSER_MAX_CELL_CHARS = 768 * 1024;
export const COMPOSER_MAX_TOTAL_CHARS = 2 * 1024 * 1024;
export const COMPOSER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const VERSION = 1;

function timestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function availableStorage(storage) {
  if (storage !== undefined) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (_) { return null; }
}

function blankState() { return { version: VERSION, cells: {} }; }

function cleanHistory(input) {
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    const text = typeof item === 'string' ? item : item && item.text;
    const at = timestamp(typeof item === 'string' ? 0 : item && item.at);
    if (typeof text !== 'string' || !text || text.length > COMPOSER_MAX_ENTRY_CHARS) continue;
    if (out.length && out[out.length - 1].text === text) continue;
    out.push({ text, at });
    if (out.length >= COMPOSER_MAX_HISTORY) break;
  }
  let chars = 0;
  return out.filter((item) => {
    if (chars + item.text.length > COMPOSER_MAX_CELL_CHARS) return false;
    chars += item.text.length;
    return true;
  });
}

function cleanCell(input) {
  if (!input || typeof input !== 'object') return null;
  const draft = typeof input.draft === 'string' && input.draft.length <= COMPOSER_MAX_DRAFT_CHARS
    ? input.draft : '';
  const history = cleanHistory(input.history);
  const updatedAt = timestamp(input.updatedAt);
  const expanded = input.expanded === true;
  if (!draft && !history.length && !expanded) return null;
  return { draft, history, expanded, updatedAt };
}

function parseState(raw) {
  let input;
  try { input = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (_) { return blankState(); }
  if (!input || typeof input !== 'object' || input.version !== VERSION || !input.cells || typeof input.cells !== 'object') {
    return blankState();
  }
  const cells = Object.create(null);
  for (const [key, value] of Object.entries(input.cells)) {
    if (!key || typeof key !== 'string' || key.length > 512
      || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const cell = cleanCell(value);
    if (cell) cells[key] = cell;
  }
  return { version: VERSION, cells };
}

function readState(storage) {
  const target = availableStorage(storage);
  if (!target) return blankState();
  try { return parseState(target.getItem(COMPOSER_STORAGE_KEY)); }
  catch (_) { return blankState(); }
}

function serializedLength(state) {
  try { return JSON.stringify(state).length; }
  catch (_) { return Infinity; }
}

function removeExpired(state, now, protectedKey) {
  for (const [key, cell] of Object.entries(state.cells)) {
    if (key !== protectedKey && cell.updatedAt > 0 && now - cell.updatedAt > COMPOSER_TTL_MS) delete state.cells[key];
  }
}

function oldestKeys(state, protectedKey) {
  return Object.entries(state.cells)
    .filter(([key]) => key !== protectedKey)
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .map(([key]) => key);
}

function pruneToBudget(state, protectedKey) {
  // First drop oldest history entries, preserving every live draft.
  while (serializedLength(state) > COMPOSER_MAX_TOTAL_CHARS) {
    const candidates = Object.entries(state.cells)
      .filter(([, cell]) => cell.history.length)
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    if (!candidates.length) break;
    candidates[0][1].history.pop();
  }
  // If drafts alone exceed the origin budget, evict old inactive cells but
  // never silently truncate the draft currently being edited.
  for (const key of oldestKeys(state, protectedKey)) {
    if (serializedLength(state) <= COMPOSER_MAX_TOTAL_CHARS) break;
    delete state.cells[key];
  }
}

function writeState(storage, state, protectedKey) {
  const target = availableStorage(storage);
  if (!target) return false;
  pruneToBudget(state, protectedKey);
  const tryWrite = () => {
    target.setItem(COMPOSER_STORAGE_KEY, JSON.stringify(state));
    return true;
  };
  try { return tryWrite(); }
  catch (_) {
    // Quota may be shared with deck/layout data. Retry by evicting only stale
    // composer cells; the active draft remains in React even if persistence
    // ultimately degrades to memory-only.
    for (const key of oldestKeys(state, protectedKey)) {
      delete state.cells[key];
      try { return tryWrite(); } catch (_) { /* keep pruning */ }
    }
    return false;
  }
}

function mutate(key, storage, now, update) {
  const state = readState(storage);
  removeExpired(state, now, key);
  const current = cleanCell(state.cells[key]) || { draft: '', history: [], expanded: false, updatedAt: 0 };
  const next = update({ ...current, history: [...current.history] });
  const cleaned = cleanCell(next);
  if (cleaned) state.cells[key] = { ...cleaned, updatedAt: now };
  else delete state.cells[key];
  return { ok: writeState(storage, state, key), cell: state.cells[key] || { draft: '', history: [], expanded: false, updatedAt: now } };
}

export function composerCellKey({ ownerId, node, session }) {
  const tmuxSession = String(session || '');
  if (!tmuxSession) return '';
  const owner = OWNER_ID_RE.test(String(ownerId || ''))
    ? String(ownerId)
    : node ? `route:${String(node)}` : 'local';
  return `${encodeURIComponent(owner)}:${encodeURIComponent(tmuxSession)}`;
}

export function loadComposerCell(key, storage, now = Date.now()) {
  if (!key) return { draft: '', history: [], expanded: false, updatedAt: 0 };
  const state = readState(storage);
  const cell = cleanCell(state.cells[key]);
  if (!cell || (cell.updatedAt > 0 && now - cell.updatedAt > COMPOSER_TTL_MS)) {
    if (state.cells[key]) { delete state.cells[key]; writeState(storage, state, ''); }
    return { draft: '', history: [], expanded: false, updatedAt: 0 };
  }
  return { ...cell, history: [...cell.history] };
}

export function saveComposerDraft(key, draft, storage, now = Date.now()) {
  const text = String(draft || '');
  if (!key || text.length > COMPOSER_MAX_DRAFT_CHARS) return false;
  return mutate(key, storage, now, (cell) => ({ ...cell, draft: text })).ok;
}

export function clearComposerDraft(key, storage, now = Date.now()) {
  if (!key) return false;
  return mutate(key, storage, now, (cell) => ({ ...cell, draft: '' })).ok;
}

export function saveComposerExpanded(key, expanded, storage, now = Date.now()) {
  if (!key) return false;
  return mutate(key, storage, now, (cell) => ({ ...cell, expanded: !!expanded })).ok;
}

export function pushComposerHistory(key, text, storage, now = Date.now()) {
  const value = String(text || '');
  if (!key || !value || value.length > COMPOSER_MAX_ENTRY_CHARS) return false;
  return mutate(key, storage, now, (cell) => {
    const history = cell.history.filter((item) => item.text !== value);
    history.unshift({ text: value, at: now });
    return { ...cell, history: cleanHistory(history) };
  }).ok;
}

export function clearComposerHistory(key, storage, now = Date.now()) {
  if (!key) return false;
  return mutate(key, storage, now, (cell) => ({ ...cell, history: [] })).ok;
}

export function clearAllComposerData(storage) {
  const target = availableStorage(storage);
  if (!target) return false;
  try { target.removeItem(COMPOSER_STORAGE_KEY); return true; }
  catch (_) { return false; }
}
