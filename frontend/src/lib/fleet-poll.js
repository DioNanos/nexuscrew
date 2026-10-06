// Un solo treno di letture per route, per finestra.
//
// Prima di questo modulo ogni superficie faceva polling per conto suo: la
// striscia della vista aperta, la cella affiancata, il poll del desktop e la
// lista mobile interrogavano GLI STESSI endpoint con intervalli propri. Una
// finestra desktop con la doppia vista partiva tre serie di richieste ogni
// 4 s: il costo del polling e' quasi tutto in quel moltiplicatore, non nella
// singola lettura.
//
// Il treno raggruppa i consumatori per route: il primo sottoscrittore avvia
// il ciclo (una lettura sessions seguita da una lettura flotta, sequenziali
// come nel poll del desktop), i successivi ricevono gli stessi esiti. L'uno
// o il centesimo consumatore, la rete vede sempre un giro per tick.
//
// Gli esiti restano GREZZI ({sessionsJson, sessionsError, fs, fleetError}):
// ogni consumatore applica la PROPRIA policy (R27, roster, titolo della
// striscia). Il treno non decide cosa significa un errore: consegna quello
// che ha letto, una volta per finestra.
//
// La non-sovrapposizione dei giri e' la guardia condivisa di poll-guard.js:
// un tick che arriva mentre un giro e' ancora in volo si salta, e un esito
// superato non viene consegnato. Il tetto per richiesta e' lo stesso del
// poll desktop: senza tetto una connessione appesa terrebbe il treno fermo
// fino al limite del browser.
import { apiFetch, fleetStatus } from './api.js';
import { createPollGuard } from './poll-guard.js';

export const FLEET_POLL_MS = 4000;
export const FLEET_POLL_TIMEOUT_MS = 3500;

// Treni vivi per (token, route). La chiave include il token: un cambio di
// credenziali deve partire da letture nuove, non cavalcare il treno vecchio.
const trains = new Map();

// Cadenza adattiva: una finestra in secondo piano non genera traffico. Il
// documento nascosto sospende l'interval di TUTTI i treni (il ciclo in volo
// completa e consegna, i tick successivi no) e un treno che NASCE nascosto
// non lo arma affatto: resta la sola lettura iniziale una tantum. Alla
// riapparsa ogni treno riparte con un giro immediato — chi torna deve
// trovare dati freschi, non l'ultima fotografia di prima della sospensione.
const documentoNascosto = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
let visibilityHooked = false;
function ensureVisibilityHook() {
  if (visibilityHooked || typeof document === 'undefined' || !document.addEventListener) return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    const nascosto = documentoNascosto();
    for (const state of trains.values()) {
      if (nascosto) {
        if (state.timer !== null) { clearInterval(state.timer); state.timer = null; }
      } else if (state.timer === null) {
        state.timer = setInterval(state.cycle, FLEET_POLL_MS);
        state.cycle();
      }
    }
  });
}

const trainKey = (token, route) => `${token}|${JSON.stringify(route || [])}`;

function basePathFor(route) {
  return (route && route.length)
    ? `/api/route/${route.map(encodeURIComponent).join('/')}/_`
    : '/api';
}

function startTrain(token, route) {
  const guard = createPollGuard();
  const state = { token, route, consumers: new Set(), snapshot: null, timer: null };
  const cycle = async () => {
    const turno = guard.begin();
    if (turno === null) return;
    try {
      let sessionsJson = null;
      let sessionsError = null;
      try {
        const r = await apiFetch(`${basePathFor(route)}/sessions`, token, { timeoutMs: FLEET_POLL_TIMEOUT_MS });
        sessionsJson = await r.json();
      } catch (e) { sessionsError = e; }
      let fs = null;
      let fleetError = null;
      try { fs = await fleetStatus(token, route, { timeoutMs: FLEET_POLL_TIMEOUT_MS }); } catch (e) { fleetError = e; }
      // Esito superato (cleanup, giro nuovo partito): non si consegna.
      if (!guard.isCurrent(turno)) return;
      state.snapshot = { at: Date.now(), sessionsJson, sessionsError, fs, fleetError };
      for (const consumer of state.consumers) consumer(state.snapshot);
    } finally {
      guard.end(turno);
    }
  };
  state.cycle = cycle;
  ensureVisibilityHook();
  // Nascere nascosti non significa non leggere nulla: la lettura iniziale
  // una tantum resta (una richiesta, non una cadenza), l'interval no.
  if (!documentoNascosto()) state.timer = setInterval(cycle, FLEET_POLL_MS);
  cycle();
  return state;
}

/**
 * Sottoscrive le letture di una route. Ritorna la funzione di uscita.
 *
 * Il primo sottoscrittore avvia il treno (ciclo immediato + interval); se un
 * treno esiste gia', il nuovo consumatore riceve SUBITO lo snapshot corrente
 * senza aggiungere letture: e' il coalescing voluto, la stessa semantica per
 * cui il server cache-a la risposta sessions. Quando l'ultimo consumatore
 * esce, il treno si ferma e viene dimenticato: una route senza osservatori
 * non genera traffico.
 */
export function subscribeFleetRoute(token, route, onSnapshot) {
  const k = trainKey(token, route);
  let state = trains.get(k);
  if (!state) {
    state = startTrain(token, route);
    trains.set(k, state);
  }
  state.consumers.add(onSnapshot);
  if (state.snapshot) onSnapshot(state.snapshot);
  return () => {
    const s = trains.get(k);
    if (!s) return;
    s.consumers.delete(onSnapshot);
    if (s.consumers.size === 0) {
      if (s.timer !== null) clearInterval(s.timer);
      trains.delete(k);
    }
  };
}

/** L'ultimo snapshot noto di una route (null se il treno non e' mai partito). */
export function readFleetRoute(route, token = null) {
  if (token !== null) {
    const s = trains.get(trainKey(token, route));
    return s ? s.snapshot : null;
  }
  // Senza token si cerca l'unico treno di quella route (uso interno ai
  // componenti che conoscono solo la route): il primo che risponde.
  const prefix = `|${JSON.stringify(route || [])}`;
  for (const [k, s] of trains) if (k.endsWith(prefix)) return s.snapshot;
  return null;
}

/**
 * Chiede un ciclo subito (dopo un'azione che cambia lo stato: kill, power,
 * technical). Rispetta la guardia: se un giro e' in volo, la richiesta si
 * perde nel prossimo esito — mai due giri sovrapposti.
 */
export function refreshFleetRoute(route, token = null) {
  const prefix = `|${JSON.stringify(route || [])}`;
  for (const [k, s] of trains) {
    if (token !== null ? k === trainKey(token, route) : k.endsWith(prefix)) s.cycle();
  }
}
