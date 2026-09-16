// Browser-local push choice, per device: one phone can keep two PWAs (the VPS3
// one and an owner's) and the user may want OS alerts from only one of them.
// Turning this off silences the SUBSCRIPTION of this browser only: the live UI,
// the toasts and the owner's own pushes are untouched, and nothing here is ever
// pushed to the server as a preference.
export const PUSH_LOCAL_KEY = 'nc_push_local_v1';
export const PUSH_LOCAL_EVENT = 'nc-push-local';

// Default: push stays exactly as it was — switching it off is an explicit,
// local choice, never something the app decides on its own.
export const DEFAULT_PUSH_LOCAL = Object.freeze({ enabled: true });

export function normalizePushLocal(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { enabled: input.enabled !== false };
}

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (_) { return null; }
}

export function loadPushLocal(storage = defaultStorage()) {
  if (!storage) return { ...DEFAULT_PUSH_LOCAL };
  try {
    return normalizePushLocal(JSON.parse(storage.getItem(PUSH_LOCAL_KEY) || 'null'));
  } catch (_) {
    return { ...DEFAULT_PUSH_LOCAL };
  }
}

export function savePushLocal(value, storage = defaultStorage()) {
  const next = normalizePushLocal(value);
  if (storage) {
    try { storage.setItem(PUSH_LOCAL_KEY, JSON.stringify(next)); }
    catch (_) { /* quota/privacy: the choice stays valid for this page only */ }
  }
  return next;
}

export function pushLocallyDisabled(storage = defaultStorage()) {
  return loadPushLocal(storage).enabled === false;
}
