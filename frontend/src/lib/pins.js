// Pin condivisi (desktop sidebar + home mobile): array di nomi in localStorage.
const KEY = 'nc_pins';

export function loadPins() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

// Persiste l'array; ritorna null se ok, l'errore altrimenti. L'esito NON e'
// mai ingoiato qui: il chiamante (toggle/remove) lo riporta in {next, error}
// cosi' la UI puo' segnalarlo e ritentarlo (un fallimento di localStorage non
// deve essere silenzioso, specialmente dopo un clear server riuscito).
function persist(next) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); return null; }
  catch (e) { return e instanceof Error ? e : new Error(String(e)); }
}

// Toggle (addPin/removePin a seconda dello stato). Ritorna { next, error }.
export function togglePinIn(pins, name) {
  const next = pins.includes(name) ? pins.filter((n) => n !== name) : [...pins, name];
  return { next, error: persist(next) };
}

// Rimozione IDEMPOTENTE, distinta dal toggle. Su uno stato server-owned senza
// pin locale (caso ammesso dal contratto), un toggle aggiungerebbe il pin e
// produrrebbe "favorite" invece di "none". removePinIn rimuove solo se presente.
export function removePinIn(pins, name) {
  if (!Array.isArray(pins) || !pins.includes(name)) {
    return { next: Array.isArray(pins) ? pins : [], error: null };
  }
  const next = pins.filter((n) => n !== name);
  return { next, error: persist(next) };
}

export function movePinIn(pins, source, target) {
  if (!pins.includes(source) || !pins.includes(target) || source === target) return pins;
  const next = [...pins]; const from = next.indexOf(source); const to = next.indexOf(target);
  next.splice(from, 1);
  const targetAfterRemoval = next.indexOf(target);
  next.splice(from < to ? targetAfterRemoval + 1 : targetAfterRemoval, 0, source);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) { /* best-effort: riordino locale */ }
  return next;
}

// Comparatore: pinnati prima (ordine di pin), poi attività recente.
export function pinRank(pins, key, activity) {
  const pi = pins.indexOf(key);
  return [pi === -1 ? 1e9 : pi, -(activity || 0)];
}

export function cmpRank(a, b) { return a[0] - b[0] || a[1] - b[1]; }
