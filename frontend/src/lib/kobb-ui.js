// Client-only opt-in for the Kobb UI personalizations (Credits tab + reduced
// KeyBar). Persisted in localStorage, reactive via useSyncExternalStore (see
// hooks/useKobbUI.js) so toggling it in Settings re-renders the KeyBar/Credits
// live, with no reload and no backend. Default is false (original UI) — opt-in,
// so the upstream (DioNanos) default UI is unchanged for other users.
const KOBB_KEY = 'nc_kobb_ui';
const KOBB_EVENT = 'nexuscrew-kobb-ui';

function safeLocal() {
  return (typeof localStorage !== 'undefined') ? localStorage : null;
}

export function getKobbUI() {
  const ls = safeLocal();
  if (!ls) return false;
  return ls.getItem(KOBB_KEY) === '1';
}

export function setKobbUI(enabled) {
  const ls = safeLocal();
  if (ls) { try { ls.setItem(KOBB_KEY, enabled ? '1' : '0'); } catch (_) { /* quota/privacy */ } }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(KOBB_EVENT));
}

export function subscribeKobbUI(cb) {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e) => { if (e.key === KOBB_KEY) cb(); };
  window.addEventListener(KOBB_EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(KOBB_EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}