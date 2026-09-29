// Token di accesso del dispositivo: un solo posto per volta, letto in modo prevedibile.
// Nasce da due difetti: il login manuale non scriveva mai nulla (la schermata spariva al primo
// carattere) e sessionStorage era letto PRIMA di localStorage, quindi una copia di sessione vecchia
// oscurava il token nuovo. Qui: il salvataggio aggiorna lo store scelto e RIMUOVE l'altro; la lettura
// preferisce localStorage (scelta esplicita «ricorda») e poi sessionStorage.
export const TOKEN_KEY = 'nc_token';
// Evento emesso quando il nodo LOCALE risponde 401 al token in uso (mai per i peer: vedi isLocalApiPath).
export const AUTH_INVALID_EVENT = 'nc:auth-invalid';
// Emesso quando il browser non ha permesso di ricordare il token (l'app funziona, ma non alla riapertura).
export const TOKEN_NOT_REMEMBERED_EVENT = 'nc:token-not-remembered';

// Percorso servito dal nodo locale: /api/... ma non /api/route/... (federazione) né /node/... (proxy):
// un 401 su quelli e' il peer che ci rifiuta, non il nostro token.
export function isLocalApiPath(path) {
  return typeof path === 'string' && path.startsWith('/api/') && !path.startsWith('/api/route/');
}

const safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
function stores(o = {}) {
  return {
    local: o.local !== undefined ? o.local : safe(() => globalThis.localStorage, null),
    session: o.session !== undefined ? o.session : safe(() => globalThis.sessionStorage, null),
  };
}
const read = (store) => safe(() => (store ? String(store.getItem(TOKEN_KEY) || '').trim() : ''), '');

export function loadToken(o) {
  const { local, session } = stores(o);
  return read(local) || read(session) || '';
}

// -> { ok, where }: where = 'local' | 'session' | null. Se lo store scelto rifiuta la scrittura (quota,
// modalita' privata) si prova l'altro, cosi' l'app funziona almeno nella sessione; il chiamante vede
// `where` e puo' avvisare che il token non sara' ricordato.
export function saveToken(token, { remember = true, local, session } = {}) {
  const value = String(token || '').trim();
  if (!value) return { ok: false, where: null };
  const s = stores({ local, session });
  const order = remember ? [['local', s.local, s.session], ['session', s.session, s.local]]
    : [['session', s.session, s.local], ['local', s.local, s.session]];
  for (const [where, target, other] of order) {
    if (!target) continue;
    if (safe(() => { target.setItem(TOKEN_KEY, value); return true; }, false)) {
      safe(() => { if (other) other.removeItem(TOKEN_KEY); }, null);
      return { ok: true, where };
    }
  }
  return { ok: false, where: null };
}
