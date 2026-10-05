'use strict';
// Store of "asks" (cell->operator questions) — MCP bridge.
// Stato in-memory + persistenza <dir>/asks.json 0600 (sopravvive al restart:
// un ask aperto resta risponibile). Lo store e' PURO stato: il paste tmux e la
// notify li orchestra la route (lib/notify/routes.js), che qui fa il ciclo
// claim -> (paste) -> commit/release (da revisione: una sola answer puo' vincere).
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonStrict, atomicWriteJson } = require('./persist.js');

const ASKS_FILE = 'asks.json';
// da revisione: MAX_OPEN e' un cap DURO sugli ask aperti — al cap il nuovo ask viene
// RIFIUTATO (reason 'cap'), mai droppato uno aperto. MAX_KEEP pota solo gli
// answered piu' vecchi dal file.
const MAX_OPEN = 100;
// Cap degli ask IMPORTATI, separato da quello locale (stessa cifra): le domande
// che arrivano da un peer e quelle poste da questo nodo sono due classi
// distinte, e le prime non devono poter esaurire il budget delle seconde.
const MAX_OPEN_IMPORTED = 100;
const MAX_IMPORTED_DISMISSALS = 1000;
const SYNC_STATES = new Set(['pending', 'confirmed-dismissed', 'confirmed-answered', 'blocked']);
function askFingerprint(ask) {
  return crypto.createHash('sha256').update(JSON.stringify([String(ask.question || ''), Array.isArray(ask.options) ? ask.options : [], String(ask.session || '')])).digest('hex');
}
function validDismissals(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, r]) =>
    r && key === `${r.ownerId}|${r.ownerAskId}` && /^[a-f0-9]{32}$/.test(r.ownerId) && /^[a-f0-9]{8}$/.test(r.ownerAskId)
    && /^[a-f0-9]{64}$/.test(r.ownerAskFingerprint) && SYNC_STATES.has(r.syncState)
    && ['known', 'unknown'].includes(r.generation)
    && (r.generation === 'unknown' ? r.ownerAskTs === null : Number.isSafeInteger(r.ownerAskTs) && r.ownerAskTs > 0)
    && (r.cellId === undefined || (typeof r.cellId === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(r.cellId)))
    && r.dismissed === true && Number.isSafeInteger(r.attempts) && r.attempts >= 0
    && Number.isFinite(r.nextRetryAt) && r.nextRetryAt >= 0
    && r.dismissedReason === 'owner-unreachable' && Number.isFinite(r.dismissedTs));
}
const MAX_KEEP = 100;          // ask totali persistiti (i piu' vecchi answered si potano)
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 200;

function createAsksStore(opts = {}) {
  if (!opts.dir) throw new Error('createAsksStore: dir richiesta');
  const filePath = path.join(opts.dir, ASKS_FILE);
  const now = opts.now || (() => Date.now());

  // Carica lazy al primo accesso (niente I/O in createServer per i path reali).
  // Tre esiti:
  //  - leggibile (assente => [], oppure oggetto con `asks` array => filtrato per
  //    id stringa): si CACHEA come oggi, perche' e' uno stato legittimo e stabile.
  //  - illeggibile (JSON malformato, oppure oggetto senza `asks` o con `asks`
  //    non array): NON si cachea. Ogni accesso rilegge il file, cosicche' se
  //    l'operatore ripara asks.json lo store torna sano senza riavvio. I reader
  //    (list/get/openCount/findImported) vedono [] — le superfici LOCALI non
  //    cambiano comportamento — mentre le MUTAZIONI rifiutano (v. unreadableGuard)
  //    per non sovrascrivere il file malformato con un defaults vuoto, che
  //    cancellerebbe le domande aperte.
  let asks = null;
  let importedDismissals = null;
  const dismissalCap = opts.maxImportedDismissals || MAX_IMPORTED_DISMISSALS;
  function load() {
    if (asks) return asks;
    const r = readJsonStrict(filePath);
    if (r.state === 'absent') { asks = []; importedDismissals = {}; return asks; }
    if (r.state === 'ok' && Array.isArray(r.value.asks) && (r.value.importedDismissals === undefined || validDismissals(r.value.importedDismissals))) {
      importedDismissals = r.value.importedDismissals || {};
      asks = r.value.asks.filter((a) => a && typeof a === 'object' && typeof a.id === 'string');
      return asks;
    }
    // illeggibile: NON cacheare (reload al prossimo accesso se il file viene riparato).
    return [];
  }

  // Health leggibile dal produttore dello snapshot: distingue un vuoto
  // LEGITTIMO (store leggibile, nessuna domanda aperta) da un vuoto NON
  // autorevole (store illeggibile). Non muta stato.
  function health() {
    if (asks) return { readable: true };
    const r = readJsonStrict(filePath);
    if (r.state === 'absent') return { readable: true };
    if (r.state === 'ok' && Array.isArray(r.value.asks) && (r.value.importedDismissals === undefined || validDismissals(r.value.importedDismissals))) return { readable: true };
    if (r.state === 'ok' && r.value.importedDismissals !== undefined && !validDismissals(r.value.importedDismissals)) return { readable: false, reason: 'malformed imported dismissals' };
    const reason = r.state === 'malformed'
      ? r.reason
      : `forma invalida: 'asks' non e' un array (${r.value && r.value.asks !== undefined ? typeof r.value.asks : 'assente'})`;
    return { readable: false, reason };
  }

  // Null se lo store e' leggibile (e le mutazioni possono procedere), altrimenti
  // la reason. Si usa all'inizio di ogni mutazione: uno store illeggibile non
  // viene MAI scritto, cosi' il file malformato non viene sovrascritto.
  function unreadableGuard() {
    if (asks) return null;
    const h = health();
    return h.readable ? null : (h.reason || 'store-unreadable');
  }

  function save() {
    // Difensivo: mai sovrascrivere uno store illeggibile. Le mutazioni hanno
    // gia' il guard, ma questo impedisce un overwrite se una via lo saltasse.
    if (unreadableGuard()) return;
    // prune: mai piu' di MAX_KEEP; si scartano prima gli answered piu' vecchi.
    const list = load();
    if (list.length > MAX_KEEP) {
      const answered = list.filter((a) => a.answered).sort((a, b) => a.ts - b.ts);
      const excess = list.length - MAX_KEEP;
      const drop = new Set(answered.slice(0, excess).map((a) => a.id));
      asks = list.filter((a) => !drop.has(a.id));
    }
    atomicWriteJson(filePath, { asks: load(), importedDismissals: importedDismissals || {} });
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
    return load().slice().reverse().find((a) => isImported(a) && a.ownerId === String(ownerId)
      && a.ownerAskId === String(ownerAskId)) || null;
  }

  // Chiusura dell'alias locale quando l'OWNER chiude la domanda. Durevole: la
  // riga resta nello storico marcata, quindi non ricompare a un reload e non
  // torna risponibile.
  function closeImported({ ownerId, ownerAskId, outcome }) {
    const ur = unreadableGuard();
    if (ur) return { ok: false, reason: 'store-unreadable', changed: false, ask: null };
    const ask = findImported(ownerId, ownerAskId);
    const record = getImportedDismissal(ownerId, ownerAskId);
    if (record) {
      const synced = updateImportedDismissal(ownerId, ownerAskId, { syncState: outcome === 'answered' ? 'confirmed-answered' : 'confirmed-dismissed', ownerOutcome: outcome });
      if (!synced.ok) return { ...synced, changed: false, ask: null };
    }
    if (!ask) return { ok: true, changed: false, ask: null };
    if (ask.answered || ask.dismissed) return { ok: true, changed: false, ask };
    if (outcome === 'answered') { ask.answered = true; ask.answeredReconciled = true; }
    else ask.dismissed = true;
    ask.revision = (ask.revision || 0) + 1;
    save();
    return { ok: true, changed: true, ask };
  }

  function create({ question, options, session, ownerId, ownerAskId, originNode, originCell, ownerAskTs }) {
    const ur = unreadableGuard();
    if (ur) return { ok: false, reason: 'store-unreadable', error: `store illeggibile (${ur}): creazione rifiutata` };
    const v = validate({ question, options });
    if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
    // DEDUP: la stessa domanda puo' arrivare due volte allo stesso nodo (import
    // diretto del fan-out e feed dell'owner). L'identita' canonica e' la coppia
    // (ownerId, ownerAskId): se l'alias esiste gia', si restituisce quello, non
    // se ne crea un secondo.
    if (originNode && ownerId && ownerAskId) {
      const existing = findImported(ownerId, ownerAskId);
      const incoming = { id: ownerAskId, question: v.value.question, options: v.value.options, session: String(session || ''), originNode, ownerAskTs };
      if (isImportedDismissed(ownerId, incoming)) return { ok: true, ask: existing, suppressed: true, deduped: !!existing };
      if (existing && askFingerprint(existing) === askFingerprint(incoming)
        && (generationTs(existing) === null || generationTs(incoming) === null || generationTs(existing) === generationTs(incoming))) {
        return { ok: true, ask: existing, deduped: true };
      }
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
      ...(Number.isSafeInteger(ownerAskTs) && ownerAskTs > 0 ? { ownerAskTs } : {}),
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

  function getImportedDismissal(ownerId, askId) {
    load();
    const record = importedDismissals && importedDismissals[`${ownerId}|${askId}`];
    return record ? { ...record } : null;
  }
  function listImportedDismissals() {
    load();
    return Object.values(importedDismissals || {}).map(r => ({ ...r }));
  }
  function generationTs(ask) {
    const ts = Object.hasOwn(ask, 'ownerAskTs') ? ask.ownerAskTs : ask.originNode ? null : ask.ts;
    return Number.isSafeInteger(ts) && ts > 0 ? ts : null;
  }
  function sameImportedGeneration(a, b) {
    const at = generationTs(a), bt = generationTs(b);
    return askFingerprint(a) === askFingerprint(b) && (at === null || bt === null || at === bt);
  }
  function isImportedDismissed(ownerId, ask) {
    const record = getImportedDismissal(ownerId, ask.ownerAskId || ask.id);
    if (!record || record.ownerAskFingerprint !== askFingerprint(ask)) return false;
    // Historical imports have no original owner timestamp. Reusing an id with
    // identical content remains suppressed; this is not proof of historical identity.
    const ts = generationTs(ask);
    return record.generation === 'unknown' || ts === null || record.ownerAskTs === ts;
  }
  function dismissalTransaction(change) {
    const ur = unreadableGuard();
    if (ur) return { ok: false, reason: 'store-unreadable' };
    load();
    const beforeAsks = asks.map(a => ({ ...a }));
    const beforeRecords = Object.fromEntries(Object.entries(importedDismissals).map(([k, r]) => [k, { ...r }]));
    try { const result = change(); if (!result.ok) return result; save(); return result; }
    catch (_) { asks = beforeAsks; importedDismissals = beforeRecords; return { ok: false, reason: 'persist-failed' }; }
  }
  function dismissImported({ ownerId, ownerAskId, ask, cellId, retryBinding, syncState = 'pending' } = {}) {
    return dismissalTransaction(() => {
      if (!/^[a-f0-9]{32}$/.test(ownerId) || !/^[a-f0-9]{8}$/.test(ownerAskId) || !ask || (ask.ownerAskId || ask.id) !== ownerAskId) return { ok: false, reason: 'unknown' };
      const candidate = findImported(ownerId, ownerAskId);
      const alias = candidate && sameImportedGeneration(candidate, ask) ? candidate : null;
      if (alias && answering.has(alias.id)) return { ok: false, reason: 'answering' };
      if (ask.answered || (alias && alias.answered)) return { ok: false, reason: 'answered' };
      const key = `${ownerId}|${ownerAskId}`;
      const existing = importedDismissals[key];
      if (existing && isImportedDismissed(ownerId, ask)) return { ok: true, record: { ...existing }, idempotent: true };
      if (!existing && Object.keys(importedDismissals).length >= dismissalCap) return { ok: false, reason: 'dismissal-cap' };
      const ts = generationTs(ask);
      const record = { ownerId, ownerAskId, ...(cellId ? { cellId } : {}), ...(alias ? { localAliasId: alias.id } : {}),
        dismissed: true, dismissedReason: 'owner-unreachable', dismissedTs: now(),
        generation: ts === null ? 'unknown' : 'known', ownerAskTs: ts,
        ownerAskFingerprint: askFingerprint(ask), syncState, attempts: 0, nextRetryAt: 0,
        ...(syncState === 'blocked' ? { lastReason: 'permission-denied', ...(retryBinding ? { retryBinding } : {}) } : {}) };
      importedDismissals[key] = record;
      if (alias) {
        if (!alias.dismissed) { alias.dismissed = true; alias.dismissedTs = now(); alias.revision = (alias.revision || 0) + 1; }
        alias.dismissedReason = 'owner-unreachable';
      }
      return { ok: true, record: { ...record } };
    });
  }
  function updateImportedDismissal(ownerId, askId, patch) {
    return dismissalTransaction(() => {
      const record = importedDismissals[`${ownerId}|${askId}`];
      if (!record) return { ok: false, reason: 'unknown' };
      const next = { ...record, ...patch };
      if (!validDismissals({ [`${ownerId}|${askId}`]: next })) return { ok: false, reason: 'invalid' };
      importedDismissals[`${ownerId}|${askId}`] = next;
      return { ok: true, record: { ...next } };
    });
  }
  function adoptImportedDismissal(ownerId, askId, ask) {
    const record = getImportedDismissal(ownerId, askId);
    const ts = generationTs(ask);
    if (!record || (ask.ownerAskId || ask.id) !== askId || ts === null || record.ownerAskFingerprint !== askFingerprint(ask)
      || (record.generation === 'known' && record.ownerAskTs !== ts)) return { ok: false, reason: 'generation-mismatch' };
    return updateImportedDismissal(ownerId, askId, { generation: 'known', ownerAskTs: ts });
  }

  // --- ciclo answer (da revisione): claim atomico open -> answering ---------------
  // Node e' single-threaded ma il paste e' un await: due answer concorrenti
  // superavano entrambe il check `answered` prima che una marcasse. Il claim
  // sincrono (nessun await tra check e set) fa vincere UNA sola richiesta; le
  // altre vedono 'answering'/'answered'. Il Set e' SOLO in-memory di proposito:
  // un crash a meta' paste riporta l'ask a open al riavvio (ri-risponibile).
  const answering = new Set();

  function claim(id) {
    const ur = unreadableGuard();
    if (ur) return { ok: false, reason: 'store-unreadable' };
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
    const ur = unreadableGuard();
    if (ur) return false;
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
    const ur = unreadableGuard();
    if (ur) return { ok: false, reason: 'store-unreadable' };
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
    const ur = unreadableGuard();
    if (ur) return { ok: false, reason: 'store-unreadable' };
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

  return { sameImportedGeneration, dismissImported, getImportedDismissal, listImportedDismissals, isImportedDismissed, updateImportedDismissal, adoptImportedDismissal, askFingerprint, create, get, list, openCount, isImported, findImported, closeImported, claim, release, commit, markAnswered, markReconciled, isAnswering, dismiss, validate, health, filePath, MAX_OPEN, MAX_OPEN_IMPORTED };
}

module.exports = { createAsksStore, askFingerprint };
