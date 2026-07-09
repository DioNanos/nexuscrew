// Pin condivisi (desktop sidebar + home mobile): array di nomi in localStorage.
const KEY = 'nc_pins';

export function loadPins() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

export function togglePinIn(pins, name) {
  const next = pins.includes(name) ? pins.filter((n) => n !== name) : [...pins, name];
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

// Comparatore: pinnati prima (ordine di pin), poi attività recente.
export function pinRank(pins, key, activity) {
  const pi = pins.indexOf(key);
  return [pi === -1 ? 1e9 : pi, -(activity || 0)];
}

export function cmpRank(a, b) { return a[0] - b[0] || a[1] - b[1]; }
