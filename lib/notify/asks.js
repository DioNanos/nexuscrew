'use strict';
// Store of "asks" (cell->operator questions) — MCP bridge.
// Stato in-memory + persistenza <dir>/asks.json 0600 (sopravvive al restart:
// un ask aperto resta risponibile). Lo store e' PURO stato: il paste tmux e la
// notify li orchestra la route (lib/notify/routes.js), che qui fa il ciclo
// claim -> (paste) -> commit/release (da revisione: una sola answer puo' vincere).
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonSafe, atomicWriteJson } = require('./persist.js');

const ASKS_FILE = 'asks.json';
// da revisione: MAX_OPEN e' un cap DURO sugli ask aperti — al cap il nuovo ask viene
// RIFIUTATO (reason 'cap'), mai droppato uno aperto. MAX_KEEP pota solo gli
// answered piu' vecchi dal file.
const MAX_OPEN = 100;
// Cap degli ask IMPORTATI, separato da quello locale (stessa cifra): le domande
// che arrivano da un peer e quelle poste da questo nodo sono due classi
// distinte, e le prime non devono poter esaurire il budget delle seconde.
const MAX_OPEN_IMPORTED = 100;
const MAX_KEEP = 100;          // ask totali persistiti (i piu' vecchi answered si potano)
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 200;

function createAsksStore(opts = {}) {
  if (!opts.dir) throw new Error('createAsksStore: dir richiesta');
  const filePath = path.join(opts.dir, ASKS_FILE);
  const now = opts.now || (() => Date.now());

  // Carica lazy al primo accesso (niente I/O in createServer per i path reali).
  let asks = null;
  function load() {
    if (asks) return asks;
    const cur = readJsonSafe(filePath);
    asks = Array.isArray(cur.asks)
      ? cur.asks.filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
      : [];
    return asks;
  }

  function save() {
    // prune: mai piu' di MAX_KEEP; si scartano prima gli answered piu' vecchi.
    const list = load();
    if (list.length > MAX_KEEP) {
      const answered = list.filter((a) => a.answered).sort((a, b) => a.ts - b.ts);
      const excess = list.length - MAX_KEEP;
      const drop = new Set(answered.slice(0, excess).map((a) => a.id));
      asks = list.filter((a) => !drop.has(a.id));
    }
    atomicWriteJson(filePath, { asks: load() });
  }

  // Validazione input fail-closed. Ritorna {ok:false,error} o {ok:true,value}.
  function validate({ question, options }) {
    if (typeof question !== 'string' || !question.trim()) {
      return { ok: false, error: 'question deve essere una stringa non vuota' };
    }
    if (question.length > MAX_QUESTION) {
      return { ok: false, error: `question troppo lunga (max ${MAX_QUESTION})` };
    }
    let opts2;
    if (options !== undefined) {
      if (!Array.isArray(options) || options.length > MAX_OPTIONS
        || options.some((o) => typeof o !== 'string' || !o.trim() || o.length > MAX_OPTION_LEN)) {
        return { ok: false, error: `options deve essere un array di stringhe non vuote (max ${MAX_OPTIONS} x ${MAX_OPTION_LEN} char)` };
      }
      opts2 = options.map((o) => o.trim());
    }
    return { ok: true, value: { question: question.trim(), options: opts2 } };
  }

  // Un ask IMPORTATO appartiene a un altro nodo: lo marca `originNode`, che e'
  // anche il marcatore che ne impedisce la ri-esportazione.
  function isImported(a) { return !!(a && a.originNode); }

  function openCount(kind = 'local') {
    return load().filter((a) => !a.answered && !a.dismissed
      && (kind === 'imported' ? isImported(a) : !isImported(a))).length;
  }

  // Identita' CANONICA di un ask importato: la coppia (ownerId, ownerAskId).
  // L'`id` locale e' nostro e all'owner non dice nulla; e' la coppia che nomina
  // lo STESSO oggetto sui due nodi, quindi e' la chiave con cui si riconcilia.
  function findImported(ownerId, ownerAskId) {
    return load().find((a) => isImported(a) && a.ownerId === String(ownerId)
      && a.ownerAskId === String(ownerAskId)) || null;
  }

  // Chiusura dell'alias locale quando l'OWNER chiude la domanda. Durevole: la
  // riga resta nello storico marcata, quindi non ricompare a un reload e non
  // torna risponibile.
  function closeImported({ ownerId, ownerAskId, outcome }) {
    const ask = findImported(ownerId, ownerAskId);
    if (!ask) return { ok: true, changed: false, ask: null };
    if (ask.answered || ask.dismissed) return { ok: true, changed: false, ask };
    if (outcome === 'answered') { ask.answered = true; ask.answeredReconciled = true; }
    else ask.dismissed = true;
    ask.revision = (ask.revision || 0) + 1;
    save();
    return { ok: true, changed: true, ask };
  }

  function create({ question, options, session, ownerId, ownerAskId, originNode, originCell }) {
    const v = validate({ question, options });
    if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
    // DEDUP: la stessa domanda puo' arrivare due volte allo stesso nodo (import
    // diretto del fan-out e feed dell'owner). L'identita' canonica e' la coppia
    // (ownerId, ownerAskId): se l'alias esiste gia', si restituisce quello, non
    // se ne crea un secondo.
    if (originNode && ownerId && ownerAskId) {
      const existing = findImported(ownerId, ownerAskId);
      if (existing) return { ok: true, ask: existing, deduped: true };
    }
    // Cap duro sugli aperti, SEPARATO PER CLASSE: gli importati non consumano il
    // budget dei locali. Con un cap unico, cento domande ricevute da un peer
    // lasciavano questo nodo senza poter porre la prima domanda propria.
    const imported = !!originNode;
    const cap = imported ? MAX_OPEN_IMPORTED : MAX_OPEN;
    if (openCount(imported ? 'imported' : 'local') >= cap) {
      return {
        ok: false,
        reason: 'cap',
        error: `cap ask aperti raggiunto (${cap}): rispondi o attendi prima di crearne altri`,
      };
    }
    const ask = {
      id: crypto.randomBytes(4).toString('hex'),
      question: v.value.question,
      ...(v.value.options ? { options: v.value.options } : {}),
      session: String(session),
      // Identita' QUALIFICATA dell'ask. `ownerId` e' il nodo che possiede la
      // domanda: la UI identifica una card con la coppia (ownerId, id) — due
      // proprietari possono usare lo stesso id locale — e instrada la risposta
      // al proprietario via ask-relay invece di incollarla qui. Assente = ask
      // di questo nodo (il caso locale storico).
      ...(ownerId ? { ownerId: String(ownerId) } : {}),
      // L'id con cui l'OWNER conosce questa domanda. Su un ask importato l'`id`
      // locale e' nostro e serve solo a noi; la risposta deve invece citare
      // l'id dell'owner, perche' e' lui che risolve l'ask nel proprio store.
      // Senza questo campo una risposta a un ask importato colpirebbe un id
      // inesistente (o, peggio, un ask locale nostro con lo stesso id).
      ...(ownerAskId ? { ownerAskId: String(ownerAskId) } : {}),
      // Provenienza di un ask ARRIVATO dalla federazione. E' il marcatore che
      // rende esplicito l'invariante: un ask con `originNode` non viene mai
      // ri-esportato (nessun loop A->B->A). Un ask locale non ha questo campo.
      ...(originNode ? { originNode: String(originNode) } : {}),
      ...(originCell ? { originCell: String(originCell) } : {}),
      ts: now(),
      revision: 0,
      answered: false,
      dismissed: false,
    };
    load().push(ask);
    save();
    return { ok: true, ask };
  }

  function get(id) {
    return load().find((a) => a.id === id) || null;
  }

  function list({ open = false } = {}) {
    const all = load();
    return (open ? all.filter((a) => !a.answered && !a.dismissed) : all.slice())
      .map((a) => ({ ...a, ...(a.options ? { options: a.options.slice() } : {}) }));
  }

  // --- ciclo answer (da revisione): claim atomico open -> answering ---------------
  // Node e' single-threaded ma il paste e' un await: due answer concorrenti
  // superavano entrambe il check `answered` prima che una marcasse. Il claim
  // sincrono (nessun await tra check e set) fa vincere UNA sola richiesta; le
  // altre vedono 'answering'/'answered'. Il Set e' SOLO in-memory di proposito:
  // un crash a meta' paste riporta l'ask a open al riavvio (ri-risponibile).
  const answering = new Set();

  function claim(id) {
    const ask = get(id);
    if (!ask) return { ok: false, reason: 'unknown' };
    // Un ask dismissato non e' piu' risponibile: senza questa guardia la
    // sequenza dismiss -> claim -> commit lascia lo stato ibrido
    // `dismissed && answered` state.
    if (ask.dismissed) return { ok: false, reason: 'dismissed' };
    if (ask.answered) return { ok: false, reason: 'answered' };
    if (answering.has(id)) return { ok: false, reason: 'answering' };
    answering.add(id);
    return { ok: true, ask: { ...ask } };
  }

  // Read-only: a claim is being held right now. Reconciliation uses this to
  // refuse WITHOUT touching the claim of a paste that is still in flight.
  function isAnswering(id) { return answering.has(id); }

  // Rollback: il paste e' fallito, l'ask torna contendibile.
  function release(id) {
    answering.delete(id);
  }

  // Commit: paste riuscito -> answered persistito, claim rilasciato.
  function commit(id, text) {
    const ask = get(id);
    answering.delete(id);
    if (!ask || ask.answered) return false;
    ask.answered = true;
    ask.answer = String(text);
    ask.answeredTs = now();
    ask.revision = (ask.revision || 0) + 1;
    save();
    return true;
  }

  // Dismiss (scarta la domanda): NON cancella la riga — la marca `dismissed`,
  // perche' lo storico serve (come `answered`). Non compete con una answer in
  // corso: 409 se c'e' un claim attivo (answering). Idempotente: scartare due
  // volte non e' un errore. Un ask dismissato non e' piu' open (non appare in
  // list({open:true})/openCount) ma resta nello storico (list({open:false})).
  function dismiss(id) {
    const ask = get(id);
    if (!ask) return { ok: false, reason: 'unknown' };
    if (answering.has(id)) return { ok: false, reason: 'answering' };
    if (ask.dismissed) return { ok: true, ask: { ...ask }, idempotent: true };
    ask.dismissed = true;
    ask.dismissedTs = now();
    ask.revision = (ask.revision || 0) + 1;
    save();
    return { ok: true, ask: { ...ask } };
  }

  // Operator reconciliation of a federated attempt: `mark-delivered` closes the
  // ask (the paste happened on the peer's side, there is no local answer text),
  // `allow-new-attempt` leaves it open. Both advance the revision, so the token
  // the operator reconciled with can never be reused on the same generation.
  function markReconciled(id, decision) {
    const ask = get(id);
    if (!ask) return { ok: false, reason: 'unknown' };
    answering.delete(id);
    if (decision === 'mark-delivered' && !ask.answered) {
      ask.answered = true;
      ask.answeredTs = now();
      ask.answeredReconciled = true;
    }
    ask.revision = (ask.revision || 0) + 1;
    save();
    return { ok: true, ask: { ...ask } };
  }

  // Retrocompat (usata nei test di store): claim+commit in un colpo.
  function markAnswered(id, text) {
    const c = claim(id);
    if (!c.ok) return false;
    return commit(id, text);
  }

  return { create, get, list, openCount, isImported, findImported, closeImported, claim, release, commit, markAnswered, markReconciled, isAnswering, dismiss, validate, filePath, MAX_OPEN, MAX_OPEN_IMPORTED };
}

module.exports = { createAsksStore };
