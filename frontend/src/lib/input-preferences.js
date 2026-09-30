export const INPUT_PREFERENCES_KEY = 'nc_input_preferences_v1';
export const INPUT_PREFERENCES_EVENT = 'nc-input-preferences';
export const TERMINAL_KEYBOARD_GESTURES = Object.freeze(['double-tap', 'single-tap', 'never']);
export const KEYBAR_LAYOUTS = Object.freeze(['full', 'compact']);

// Default della tastiera di scrittura: quello che l'app fa oggi senza
// preferenza scritta (touch = composer aperto, pointer fine = chiuso). Non e'
// una scelta nuova, e' il comportamento esistente reso persistibile.
function defaultShowComposer() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches : false;
  } catch (_) { return false; }
}

export const DEFAULT_INPUT_PREFERENCES = Object.freeze({
  terminalKeyboardGesture: 'double-tap',
  keybarKeepsKeyboardClosed: true,
  voiceKeepsKeyboardClosed: true,
  showKeybarEnter: true,
  keybarLayout: 'full',
  showComposer: defaultShowComposer(),
});

export function normalizeInputPreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    terminalKeyboardGesture: TERMINAL_KEYBOARD_GESTURES.includes(input.terminalKeyboardGesture)
      ? input.terminalKeyboardGesture : DEFAULT_INPUT_PREFERENCES.terminalKeyboardGesture,
    keybarKeepsKeyboardClosed: typeof input.keybarKeepsKeyboardClosed === 'boolean'
      ? input.keybarKeepsKeyboardClosed : DEFAULT_INPUT_PREFERENCES.keybarKeepsKeyboardClosed,
    voiceKeepsKeyboardClosed: typeof input.voiceKeepsKeyboardClosed === 'boolean'
      ? input.voiceKeepsKeyboardClosed : DEFAULT_INPUT_PREFERENCES.voiceKeepsKeyboardClosed,
    showKeybarEnter: typeof input.showKeybarEnter === 'boolean'
      ? input.showKeybarEnter : DEFAULT_INPUT_PREFERENCES.showKeybarEnter,
    keybarLayout: KEYBAR_LAYOUTS.includes(input.keybarLayout)
      ? input.keybarLayout : DEFAULT_INPUT_PREFERENCES.keybarLayout,
    showComposer: typeof input.showComposer === 'boolean'
      ? input.showComposer : DEFAULT_INPUT_PREFERENCES.showComposer,
  };
}

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (_) { return null; }
}

export function loadInputPreferences(storage = defaultStorage()) {
  if (!storage) return { ...DEFAULT_INPUT_PREFERENCES };
  try { return normalizeInputPreferences(JSON.parse(storage.getItem(INPUT_PREFERENCES_KEY) || 'null')); }
  catch (_) { return { ...DEFAULT_INPUT_PREFERENCES }; }
}

export function saveInputPreferences(value, storage = defaultStorage()) {
  const next = normalizeInputPreferences(value);
  if (storage) {
    try { storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify(next)); }
    catch (_) { /* quota/privacy: la preferenza resta valida in memoria */ }
  }
  return next;
}
