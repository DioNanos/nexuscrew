'use strict';
// Coda di RITENTATIVI della chiusura di un ask, lato OWNER.
//
// Il problema che risolve: la chiusura di una domanda segue la stessa strada
// dell'andata, ma il destinatario puo' essere spento in quel momento. Il suo
// alias locale resta allora aperto — e ricompare a ogni reload — perche' la
// transizione e' avvenuta altrove. Il ricevente NON puo' rimediare da solo:
// nella topologia in cui l'owner si e' collegato a lui (peer `inbound`) non ha
// ne' rotta ne' credenziale per raggiungerlo. L'unico lato che puo' riprovare
// e' chi ha emesso la transizione.
//
// La coda e' DELIBERATAMENTE piccola e limitata su tre assi indipendenti:
//   - numero di voci (tetto duro, si scarta la piu' vecchia);
//   - tentativi per voce (backoff esponenziale, tetto esplicito);
//   - eta' della voce (TTL: oltre, si rinuncia).
// Ogni timer e' `unref()`: una coda in attesa non tiene vivo il processo.
//
// Due modi per far ripartire un tentativo:
//   1) il timer di backoff (il caso normale, nessuno guarda);
//   2) una LETTURA locale dell'elenco degli ask: e' il momento in cui qualcuno
//      sta guardando lo stato, quindi e' il momento naturale per riconciliare
//      il recapito. Senza questa seconda via una coda con base di 1 s non
//      coprirebbe mai una finestra di riavvio del peer di pochi millisecondi,
//      e il backoff non deve essere accorciato fino a diventare un busy loop.

const BASE_MS = 1000;               // primo ritardo fra i tentativi
const FACTOR = 2;                   // crescita esponenziale
const MAX_ATTEMPTS = 6;             // tentativi oltre al primo dispatch
const TTL_MS = 5 * 60 * 1000;       // oltre questa eta' si rinuncia
const MAX_ENTRIES = 256;            // tetto duro sulle voci in coda
const NUDGE_FLOOR_MS = 500;         // distanza minima fra due risvegli da lettura

// Esiti che NON meritano un ritentativo: il peer ha risposto, la chiusura e'
// arrivata (una seconda consegna della stessa chiusura e' un no-op sul peer,
// che risponde `delivered` con `closed:false`), oppure ha rifiutato — e un
// rifiuto non cambia da solo col tempo.
const DONE_STATUSES = new Set(['delivered', 'no-delivery']);
const FINAL_STATUSES = new Set(['refused']);

function createClosureRetryQueue({
  run,                       // async ({askId, outcome, session}) -> [{target, status, reason}]
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  baseMs = BASE_MS,
  factor = FACTOR,
  maxAttempts = MAX_ATTEMPTS,
  ttlMs = TTL_MS,
  maxEntries = MAX_ENTRIES,
  nudgeFloorMs = NUDGE_FLOOR_MS,
  log = () => {},
} = {}) {
  if (typeof run !== 'function') throw new Error('createClosureRetryQueue: run richiesta');
  const entries = [];
  let stopped = false;
  let lastNudge = null;

  function clearEntry(entry) {
    if (entry.timer) { try { clearTimer(entry.timer); } catch (_) {} entry.timer = null; }
  }

  function remove(entry) {
    clearEntry(entry);
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
  }

  // Ritardo del prossimo tentativo: esponenziale, con tetto sul TTL.
  function schedule(entry) {
    if (stopped) return;
    const delay = baseMs * Math.pow(factor, entry.attempts);
    entry.nextAt = now() + delay;
    entry.timer = setTimer(() => { attempt(entry, 'backoff'); }, delay);
    // Non blocca la chiusura del processo: una coda in attesa e' solo una coda.
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  function expired(entry) {
    return entry.attempts >= maxAttempts || (now() - entry.createdAt) >= ttlMs;
  }

  async function attempt(entry, why = 'backoff') {
    if (stopped || entry.inFlight) return;
    clearEntry(entry);
    if (expired(entry)) {
      remove(entry);
      try { log(`chiusura ask ${entry.askId}: rinuncio dopo ${entry.attempts} tentativi (${why})`); } catch (_) {}
      return;
    }
    entry.inFlight = true;
    let results = [];
    // Si ritenta SOLO verso i target ancora pendenti: chi ha gia' risposto non
    // riceve una seconda consegna inutile.
    const targets = [...entry.targets];
    try {
      results = await run({ askId: entry.askId, outcome: entry.outcome, session: entry.session, targets });
    } catch (e) {
      results = targets.map((target) => ({ target, status: 'unknown', reason: 'dispatch-threw' }));
      try { log(`chiusura ask ${entry.askId}: tentativo fallito (${String(e && e.message || e)})`); } catch (_) {}
    } finally {
      entry.inFlight = false;
    }
    const list = Array.isArray(results) ? results : [];
    // IL SET SI AGGIORNA QUI, dal lato della coda: ogni target che ha risposto
    // esce. `delivered` e `no-delivery` sono consegne, `refused` e' un rifiuto —
    // in tutti e tre i casi riprovare non aggiunge nulla. Restano i pendenti, e
    // la voce si chiude quando non ne resta nessuno.
    for (const r of list) {
      if (!r || !r.target) continue;
      if (DONE_STATUSES.has(r.status) || FINAL_STATUSES.has(r.status)) entry.targets.delete(r.target);
    }
    const refused = list.filter((r) => r && FINAL_STATUSES.has(r.status));
    if (refused.length) {
      try { log(`chiusura ask ${entry.askId}: rifiutata (${refused.map((r) => r.reason || r.status).join(',')})`); } catch (_) {}
    }
    if (!entry.targets.size) { remove(entry); return; }
    entry.attempts += 1;
    if (expired(entry)) {
      remove(entry);
      try { log(`chiusura ask ${entry.askId}: tetto raggiunto, alias lasciato al peer`); } catch (_) {}
      return;
    }
    schedule(entry);
  }

  // Accoda i target NON raggiunti di una chiusura. La voce e' la COPPIA
  // (chiusura, insieme dei pendenti): un peer che risponde esce dall'insieme, e
  // la voce si chiude quando l'insieme e' vuoto. Una seconda `enqueue` per la
  // stessa chiusura UNISCE i target invece di essere buttata via: e' cio' che
  // impedisce a un peer spento di sparire dalla coda quando un ALTRO peer
  // risponde, o quando la stessa chiusura viene riprovata piu' tardi.
  function enqueue({ askId, outcome, session, targets } = {}) {
    if (stopped || !askId || !outcome) return { ok: false, reason: 'invalid' };
    const nuovi = [...new Set((Array.isArray(targets) ? targets : []).map((t) => String(t)).filter(Boolean))];
    if (!nuovi.length) return { ok: false, reason: 'no-targets' };
    const existing = entries.find((e) => e.askId === askId && e.outcome === outcome);
    if (existing) {
      const prima = existing.targets.size;
      for (const t of nuovi) existing.targets.add(t);
      // Se il tentativo precedente era in volo, il nuovo target non era nella
      // sua lista: la voce va risvegliata, o aspetterebbe il backoff per nulla.
      if (existing.targets.size !== prima && !existing.inFlight && !existing.timer) schedule(existing);
      return { ok: true, merged: true, added: existing.targets.size - prima, size: entries.length };
    }
    if (entries.length >= maxEntries) {
      const oldest = entries.shift();
      clearEntry(oldest);
      try { log(`coda chiusure piena (${maxEntries}): scartata la piu' vecchia (${oldest.askId})`); } catch (_) {}
    }
    const entry = {
      askId, outcome, session, targets: new Set(nuovi),
      attempts: 0, createdAt: now(), nextAt: 0, timer: null, inFlight: false,
    };
    entries.push(entry);
    schedule(entry);
    return { ok: true, size: entries.length };
  }

  // Risveglio su domanda: chi legge lo stato vuole lo stato VERO. Si ritentano
  // subito le voci in attesa, senza aspettare il backoff — ma non a ogni
  // lettura: c'e' una distanza minima fra due risvegli, altrimenti un refresh
  // ripetuto diventerebbe un martellamento del peer.
  async function drain(why = 'read') {
    if (stopped || !entries.length) return { attempted: 0 };
    const t = now();
    if (lastNudge !== null && (t - lastNudge) < nudgeFloorMs) return { attempted: 0, throttled: true };
    lastNudge = t;
    const snapshot = entries.slice();
    for (const entry of snapshot) await attempt(entry, why);
    return { attempted: snapshot.length, size: entries.length };
  }

  // Svuotamento alla chiusura del server: nessun timer sopravvive.
  function stop() {
    stopped = true;
    for (const entry of entries.slice()) remove(entry);
    return { cleared: true };
  }

  return {
    enqueue, drain, stop,
    pending: () => entries.map((e) => ({
      askId: e.askId, outcome: e.outcome, attempts: e.attempts, nextAt: e.nextAt,
      targets: [...e.targets],
    })),
    size: () => entries.length,
    limits: { baseMs, factor, maxAttempts, ttlMs, maxEntries, nudgeFloorMs },
  };
}

module.exports = {
  createClosureRetryQueue,
  CLOSURE_DONE_STATUSES: DONE_STATUSES,
  CLOSURE_FINAL_STATUSES: FINAL_STATUSES,
  CLOSURE_RETRY_BASE_MS: BASE_MS,
  CLOSURE_RETRY_FACTOR: FACTOR,
  CLOSURE_RETRY_MAX_ATTEMPTS: MAX_ATTEMPTS,
  CLOSURE_RETRY_TTL_MS: TTL_MS,
  CLOSURE_RETRY_MAX_ENTRIES: MAX_ENTRIES,
  CLOSURE_RETRY_NUDGE_FLOOR_MS: NUDGE_FLOOR_MS,
};
