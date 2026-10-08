'use strict';
// lib/notify/event-feed-client.js — the subscriber that runs in the CLIENT
// server, one subscription per paired owner with eventsReceive=true.
//
// Hard rules: the peer is chosen ONLY from the authorized node
// store — never a host/port/URL taken from an event; the Hydra route is opened
// with the server-side Bearer; the FIRST access (and every reset) is a
// SNAPSHOT, then the SSE stream resumes from the snapshot cursor; a frame
// attributed to another owner disconnects the stream; imported events are
// re-emitted locally ONLY — they can never re-enter a publisher, so A→B→A
// dies by construction. Transport failures back off with jitter 5→60 s; a
// stream silent for 60 s is aborted and resynced.

const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const IDLE_TIMEOUT_MS = 60000;
const ERROR_BODY_TIMEOUT_MS = 5000;
const MAX_CONSECUTIVE_RESETS = 3;
// `resync-exhausted` ferma il loop ma non deve parcheggiare la view
// per sempre. Al tappo la view prende un cooldown a gradini — 30 s → 2 min →
// 5 min, poi fisso — e alla scadenza paga UN tentativo di snapshot fresco.
// Iniettabile per i test (timer veri, passi piccoli).
const RESYNC_COOLDOWN_STEPS_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
// INVARIANTE: al massimo UNO snapshot per finestra, per owner, da qualunque
// causa di resync (409, frame malformato, oversize, seq discontinua, errore
// di trasporto). È la garanzia strutturale: le vie singole possono cambiare,
// il tetto delle richieste no. Di default 30 s, iniettabile per i test.
const MIN_SNAPSHOT_INTERVAL_MS = 30 * 1000;

// Ingress budgets: 120 frames/min and 1 MiB/min per owner, plus a separate
// federated global window of 480 frames/min and 4 MiB/min. The counters are
// FRAMES, not transport chunks: one read() carries a whole round, and 121
// frames inside a single chunk must not pass as one.
const INGRESS_WINDOW_MS = 60000;
const INGRESS_MAX_FRAMES = 120;
const INGRESS_MAX_BYTES = 1024 * 1024;
const INGRESS_GLOBAL_MAX_FRAMES = 480;
const INGRESS_GLOBAL_MAX_BYTES = 4 * 1024 * 1024;
const INGRESS_BLOCK_BACKOFF_MS = 5000;

// Snapshot caps, enforced by the CLIENT as a floor of its own: the owner
// publishes them too, but a rogue owner is not trusted to police itself. The
// element schema is the frame schema (bounded id, bounded element size).
const SNAPSHOT_MAX_ASKS = 100;
const SNAPSHOT_MAX_NOTIFY = 50;
const SNAPSHOT_MAX_CELLS = 1000;
const SNAPSHOT_ELEMENT_MAX_BYTES = 16 * 1024;
const SNAPSHOT_ID_MAX_CHARS = 64;

// Lo snapshot è JSON DICHIARATO: se la risposta dichiara un media type, questo
// dev'essere application/json (i parametri come charset sono ammessi). Un
// corpo che parsisce ma viaggia come text/plain non è la superficie dello
// snapshot — quale che sia il suo contenuto, non decide niente. La
// dichiarazione ASSENTE (proxy che spoglia gli header, trasporti degradati
// verso la view) resta tollerata: la regola colpisce chi dichiara un tipo
// sbagliato, non chi non dichiara.
function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

// Lettura difensiva dell'header: risposte senza headers (stub, trasporti
// degradati) valgono come dichiarazione ASSENTE, che il validatore tollera.
function contentTypeOf(r) {
  try {
    return r && r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-type') : null;
  } catch (_) {
    return null;
  }
}

function isNamedFeedReason(reason) {
  return ['shape', 'owner-mismatch', 'snapshot-oversize', 'snapshot-element-oversize',
    'snapshot-resync-required', 'snapshot-content-type'].includes(reason)
    || (typeof reason === 'string' && reason.startsWith('snapshot-schema:'));
}

function createEventFeedClient(opts = {}) {
  // deps: { nodesPath, token(), eventsHub, now, fetchImpl, log }
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const cooldownSteps = Array.isArray(opts.resyncCooldownStepsMs) && opts.resyncCooldownStepsMs.length > 0
    ? opts.resyncCooldownStepsMs
    : RESYNC_COOLDOWN_STEPS_MS;
  const minSnapshotIntervalMs = typeof opts.minSnapshotIntervalMs === 'number' && opts.minSnapshotIntervalMs >= 0
    ? opts.minSnapshotIntervalMs
    : MIN_SNAPSHOT_INTERVAL_MS;
  // ownerId -> view state {cursor, generation, asks, notifications, fleetState,
  //   stale, lastError}; generation guards against obsolete fetches.
  const isAskDismissed = typeof opts.isAskDismissed === 'function' ? opts.isAskDismissed : () => false;
  const visibleAsks = (ownerId, asks) => asks.filter(ask => !isAskDismissed(ownerId, ask));
  // Notices THIS node has already cleared locally while the owner has not taken
  // the dismissal yet (queued, or refused for good): the local intent is what the
  // operator acted on, so the notice must not come back to a node that reloads or
  // restarts and rebuilds this view from the owner's snapshot. Applied at IMPORT,
  // where every notice enters the view — a dismissal drops the one already held —
  // so nothing else has to filter on read.
  const isNoticeDismissed = typeof opts.isNoticeDismissed === 'function' ? opts.isNoticeDismissed : () => false;
  const views = new Map();
  const running = new Map(); // nodeId -> {abort}
  let stopped = false;
  let generation = 0;

  const retries = new Map(); // ownerId -> persistent retry state
  const configurations = new Map();
  function retryFor(ownerId) {
    if (!retries.has(ownerId)) retries.set(ownerId, { fails: 0, nextRetryAt: 0, timer: null });
    return retries.get(ownerId);
  }
  function clearRetry(ownerId, reset = false) {
    const retry = retries.get(ownerId);
    if (!retry) return;
    if (retry.timer) clearTimeout(retry.timer);
    retry.timer = null;
    if (reset) { retry.fails = 0; retry.nextRetryAt = 0; }
  }
  function active(ownerId, slot) {
    return !stopped && running.get(ownerId) === slot && !slot.controller.signal.aborted;
  }
  async function withDeadline(slot, milliseconds, operation) {
    const controller = slot ? slot.controller : new AbortController();
    const signal = controller.signal;
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = () => reject(new Error('acquisition aborted')); });
    signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), milliseconds);
    try {
      if (signal.aborted) throw new Error('acquisition aborted');
      return await Promise.race([operation(signal), aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAbort);
    }
  }
  function backoffMs(ownerId) {
    const retry = retryFor(ownerId);
    const fails = ++retry.fails;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, fails - 1));
    return Math.floor(base / 2 + Math.random() * (base / 2));
  }

  function viewFor(ownerId) {
    if (!views.has(ownerId)) {
      views.set(ownerId, { ownerId, cursor: null, asks: [], notifications: [], fleetState: null, stale: true, generation: 0 });
    }
    return views.get(ownerId);
  }

  // Asks this node knows are CLOSED on the owner. The owner's snapshot can still
  // carry one for a moment (its closing frame and our re-snapshot race), and the
  // UI would re-import it — the card that comes back after the X.
  // The tombstone carries a TTL and the view epoch it was made in: an id reused
  // after an owner reset must NOT stay suppressed forever.
  const ASK_TOMBSTONE_TTL_MS = 10 * 60 * 1000;
  const askTombstones = new Map(); // `${ownerId}|${askId}` -> {at, epoch}

  function askTombstoneKey(ownerId, askId) { return `${ownerId}|${askId}`; }

  function noteAskClosed(ownerId, askId, epoch, ownerAskTs, ask) {
    if (!ownerId || !askId) return;
    askTombstones.set(askTombstoneKey(ownerId, askId), { at: now(), epoch, ownerAskTs,
      fingerprint: ask && ask.question !== undefined ? JSON.stringify([ask.question, ask.options || [], ask.session]) : null });
    if (askTombstones.size > 4096) askTombstones.delete(askTombstones.keys().next().value);
  }

  function askIsClosed(ownerId, askId, epoch, ask) {
    const key = askTombstoneKey(ownerId, askId);
    const hit = askTombstones.get(key);
    if (!hit) return false;
    if (now() - hit.at > ASK_TOMBSTONE_TTL_MS) { askTombstones.delete(key); return false; }
    if (typeof hit.epoch === 'number' && typeof epoch === 'number' && hit.epoch !== epoch) return false;
    const ts = ask && (Object.hasOwn(ask, 'ownerAskTs') ? ask.ownerAskTs : ask.ts);
    if (Number.isSafeInteger(hit.ownerAskTs) && hit.ownerAskTs > 0 && Number.isSafeInteger(ts) && ts > 0 && hit.ownerAskTs !== ts) return false;
    if (!hit.ownerAskTs && hit.fingerprint !== null && ask && hit.fingerprint !== JSON.stringify([ask.question, ask.options || [], ask.session])) return false;
    return true;
  }

  // Notices the owner said are CLEARED. Same shape and same reasoning as the
  // ask tombstones above, with the TTL of the store that produced them (15
  // minutes, the life of the notice itself) and the view epoch, so an event id
  // reused after an owner reset is not suppressed forever.
  const NOTICE_TOMBSTONE_TTL_MS = 15 * 60 * 1000;
  const noticeTombstones = new Map(); // `${ownerId}|${eventId}` -> {at, epoch}

  function noticeTombstoneKey(ownerId, eventId) { return `${ownerId}|${eventId}`; }

  function noteNoticeClosed(ownerId, eventId, epoch) {
    if (!ownerId || !eventId) return;
    noticeTombstones.set(noticeTombstoneKey(ownerId, eventId), { at: now(), epoch });
    if (noticeTombstones.size > 4096) noticeTombstones.delete(noticeTombstones.keys().next().value);
  }

  function noticeIsClosed(ownerId, eventId, epoch) {
    const key = noticeTombstoneKey(ownerId, eventId);
    const hit = noticeTombstones.get(key);
    if (!hit) return false;
    if (now() - hit.at > NOTICE_TOMBSTONE_TTL_MS) { noticeTombstones.delete(key); return false; }
    if (typeof hit.epoch === 'number' && typeof epoch === 'number' && hit.epoch !== epoch) return false;
    return true;
  }

  function dropNoticeFromView(ownerId, eventId) {
    const view = viewFor(ownerId);
    view.notifications = view.notifications.filter((n) => (n && n.eventId) !== eventId);
    return view;
  }

  function dropAskFromView(ownerId, askId) {
    const view = viewFor(ownerId);
    view.asks = view.asks.filter((a) => (a.ownerAskId || a.id) !== askId);
    if (view.alertAsks) view.alertAsks.delete(askId);
    return view;
  }

  // One resync round that ended WITHOUT a usable frame counts as a reset: a
  // peer that keeps asking to resync (409 reset-required / cursor-future, or a
  // frame from an unknown epoch) would otherwise be re-snapshotted forever.
  // Past the cap the view goes to the error state and the poll gate stops it;
  // a single healthy frame clears the streak.
  // Arma (o riarma) il cooldown della view al gradino successivo della
  // scala. Vale sia per l'esaurimento del tappo (noteReset) sia per un
  // tentativo di recupero fallito (poll): in entrambi i casi la view torna a
  // chiedere SOLO alla scadenza, un tentativo per scadenza.
  function armResyncCooldown(view, why) {
    view.resyncExhaustions = (view.resyncExhaustions || 0) + 1;
    const step = cooldownSteps[Math.min(view.resyncExhaustions - 1, cooldownSteps.length - 1)];
    view.resyncBlockedUntil = now() + step;
    log(`event-feed-client: ${String(view.ownerId || '').slice(0, 8)}… ${why}: cooldown ${Math.round(step / 1000)} s (exhaustions ${view.resyncExhaustions})`);
  }

  function noteReset(view) {
    view.consecutiveResets = (view.consecutiveResets || 0) + 1;
    if (view.consecutiveResets >= MAX_CONSECUTIVE_RESETS) {
      // Il tappo ferma il loop, ma la view non resta parcheggiata: il
      // cooldown cresce a ogni riesaurimento SENZA un frame sano in mezzo (una
      // connessione che funziona riporta la scala al primo gradino, vedi
      // streamOnce) e alla scadenza paga uno snapshot fresco (vedi poll).
      armResyncCooldown(view, 'resync exhausted');
      view.stale = true;
      view.lastError = 'resync-exhausted';
    }
  }

  function routeUrl(peer, resource, query = '') {
    // Peer identity comes from the STORE record (name + localPort + token):
    // nothing here ever reads a target from an event frame.
    return `http://127.0.0.1:${peer.localPort}/federation/route/_/${resource.startsWith('/') ? resource.slice(1) : resource}${query}`;
  }

  function dedupKey(envelope) { return `${envelope.ownerId}:${envelope.eventId}`; }
  const seen = new Map(); // dedupKey -> at, bounded to the replay horizon

  function markSeen(key) {
    seen.set(key, now());
    if (seen.size > 2000) {
      const cutoff = now() - 16 * 60 * 1000;
      for (const [k, at] of seen) if (at < cutoff) seen.delete(k);
    }
  }

  // Apply a fetched snapshot ONLY if it belongs to the current generation:
  // an obsolete fetch must never overwrite a newer view (the snapshot
  // WINS over the previous view of the same owner).
  function applySnapshot(ownerId, snap, gen) {
    const view = viewFor(ownerId);
    if (gen !== generation) return false;
    view.cursor = snap.cursor || null;
    // A snapshot taken before the owner processed a dismiss still carries the
    // ask: the tombstone is what keeps it from coming back.
    view.asks = Array.isArray(snap.asks)
      ? snap.asks
        .filter((a) => a && !askIsClosed(ownerId, a.ownerAskId || a.id, snap.viewEpoch, a) && !isAskDismissed(ownerId, a))
        .map((a) => ({ ...a, ownerId }))
      : [];
    view.alertAsks = new Map(); // fresh snapshot replaces all live-only alert sources
    // A snapshot taken before the owner processed the dismissal still carries
    // the notice: the tombstone is what keeps it from coming back, exactly like
    // the ask above.
    view.notifications = Array.isArray(snap.notifications)
      ? snap.notifications
        .filter((e) => e && !noticeIsClosed(ownerId, e.eventId, snap.viewEpoch)
          && !isNoticeDismissed(ownerId, e.eventId))
        .map((e) => ({ ...e, ownerId }))
      : [];
    view.fleetState = snap.fleetState || null;
    view.askReplyAccess = snap.askReplyAccess === true;
    view.viewEpoch = snap.viewEpoch;
    view.stale = false;
    if (typeof opts.onAuthoritativeAsks === 'function') opts.onAuthoritativeAsks(ownerId, view.asks);
    // Lo snapshot fresco è la guarigione visibile: stale torna falso e
    // l'ultimo errore cessa di essere mostrato. Lo streak NON si tocca qui:
    // il conto dei reset misura i round SENZA frame sano, e ogni round di
    // ricognizione inizia con uno snapshot — azzerarlo qui annullerebbe il
    // tappo anti-reset. Lo sblocco dello streak sta alla scadenza del cooldown.
    view.lastError = null;
    view.generation = gen;
    if (typeof opts.onViewChanged === 'function') {
      try { opts.onViewChanged(ownerId); } catch (_) { /* UI refresh cannot invalidate the applied view. */ }
    }
    return true;
  }

  // Both authenticated ingress paths must update the same exported owner
  // collection. Recording a fan-out ASK neither publishes nor fabricates a
  // feed cursor; the next genuinely new owner snapshot can replace it.
  function rememberLiveAsk(ownerId, source) {
    const askId = source.ownerAskId || source.id;
    const ask = { ...source, id: askId, ownerId,
      ownerAskTs: Object.hasOwn(source, 'ownerAskTs') ? source.ownerAskTs : source.ts };
    const view = viewFor(ownerId);
    if (isAskDismissed(ownerId, ask)
      || askIsClosed(ownerId, askId, view.viewEpoch, ask)) return null;
    // The exported collection must follow both ingress paths, even when the
    // feed cursor has not yet advanced, or a cache falsely certifies absence.
    const currentIndex = view.asks.findIndex(a => (a.ownerAskId || a.id) === askId);
    const current = currentIndex >= 0 ? view.asks[currentIndex] : null;
    const currentTs = current && (Object.hasOwn(current, 'ownerAskTs') ? current.ownerAskTs : current.ts);
    if (current && Number.isSafeInteger(currentTs) && currentTs > 0
      && (!ask.ownerAskTs || ask.ownerAskTs < currentTs)) return null;
    if (currentIndex >= 0) view.asks[currentIndex] = ask;
    else if (view.asks.length < SNAPSHOT_MAX_ASKS) view.asks.push(ask);
    else {
      // Never certify an incomplete collection or silently evict a card.
      view.stale = true; view.lastError = 'snapshot-asks-cap';
    }
    if (!view.stale) {
      if (!view.alertAsks) view.alertAsks = new Map();
      view.alertAsks.delete(askId); view.alertAsks.set(askId, ask);
      while (view.alertAsks.size > SNAPSHOT_MAX_ASKS) view.alertAsks.delete(view.alertAsks.keys().next().value);
    }
    view.liveAskRevision = (view.liveAskRevision || 0) + 1;
    return ask;
  }

  // An authenticated owner closure (fan-out frame or feed envelope) lands on
  // the SAME exported view the live ask entered — whether or not the store
  // alias changed. The key is canonical (ownerId, ownerAskId); a closure of a
  // different generation closes nothing. The tombstone blocks the CLOSED
  // generation for both outcomes, and the revision bump rejects a snapshot
  // acquisition that started before the closure: an anterior read must never
  // certify the card back.
  function applyOwnerClosure(ownerId, ownerAskId, { ownerAskTs, outcome, ask } = {}) {
    if (!ownerId || !ownerAskId) return { applied: false };
    const view = viewFor(ownerId);
    const current = view.asks.find((a) => (a.ownerAskId || a.id) === ownerAskId)
      || (view.alertAsks && view.alertAsks.get(ownerAskId)) || null;
    const currentTs = current && (Object.hasOwn(current, 'ownerAskTs') ? current.ownerAskTs : current.ts);
    const closureTs = Number.isSafeInteger(ownerAskTs) && ownerAskTs > 0 ? ownerAskTs : null;
    if (closureTs && Number.isSafeInteger(currentTs) && currentTs > 0 && currentTs !== closureTs) {
      return { applied: false, mismatch: true };
    }
    dropAskFromView(ownerId, ownerAskId);
    noteAskClosed(ownerId, ownerAskId, view.viewEpoch, closureTs || undefined, current || ask);
    view.liveAskRevision = (view.liveAskRevision || 0) + 1;
    if (typeof opts.onViewChanged === 'function') {
      try { opts.onViewChanged(ownerId); } catch (_) { /* UI refresh cannot invalidate the closure. */ }
    }
    return { applied: true };
  }

  // Local re-emission of ONE imported envelope: attributed to the owner, into
  // the local SSE hub only. The hub is the browser-facing surface — this call
  // deliberately bypasses the notifier so the imported event can never be
  // recorded into a feed history or re-published to other peers.
  function reemit(envelope) {
    const key = dedupKey(envelope);
    if (seen.has(key)) return false;
    markSeen(key);
    if (!envelope.frame || envelope.hop !== 1) return false;
    const f = envelope.frame;
    if (f.type === 'notify') {
      const { canonicalAskAlert, alertFields } = require('./ask-alert-identity.js');
      let alertFrame = { ...f, ownerId: envelope.ownerId };
      let historicalAsk = null;
      if (f.askId && !canonicalAskAlert(alertFrame)) {
        const view = views.get(envelope.ownerId);
        // A legacy notification has no generation. Only a fresh full owner
        // ASK can supply its fingerprint; emission time never supplies a ts.
        const source = view && !view.stale && ((view.alertAsks && view.alertAsks.get(f.askId)) || view.asks.find(a => a.id === f.askId));
        historicalAsk = source && source.question === f.body ? source : null;
        if (historicalAsk) {
          const ownerAskTs = historicalAsk.ownerAskTs === undefined ? historicalAsk.ts : historicalAsk.ownerAskTs;
          alertFrame = { ...alertFrame, ownerAskFingerprint: require('./asks.js').askFingerprint(historicalAsk),
            ...(Number.isSafeInteger(ownerAskTs) && ownerAskTs > 0 ? { ownerAskTs } : {}) };
          if (typeof opts.onAuthoritativeAsks === 'function') opts.onAuthoritativeAsks(envelope.ownerId, [historicalAsk]);
        }
      }
      opts.eventsHub.broadcast({
        type: 'notify', title: f.title, ...(f.body ? { body: f.body } : {}),
        urgency: f.urgency === 'high' ? 'high' : 'normal',
        ...(f.lang ? { lang: f.lang } : {}),
        ...(f.askId ? { askId: String(f.askId) } : {}),
        ...alertFields(alertFrame),
        originNode: envelope.ownerId, ownerId: envelope.ownerId,
        ...(envelope.scope === 'cell' && envelope.cellId ? { originCell: envelope.cellId } : {}),
        eventId: envelope.eventId,
        // Origin time, not rebroadcast time: toast and card must tell the
        // same truth as the owner's emission (emittedAt), falling back only
        // when an envelope somehow carries none.
        ts: Number.isFinite(envelope.emittedAt) ? envelope.emittedAt : Date.now(),
      });
      // The first legacy alert may have created an unknown admission during
      // broadcast. Bind that admission before any following known replay.
      if (historicalAsk && typeof opts.onAuthoritativeAsks === 'function') opts.onAuthoritativeAsks(envelope.ownerId, [historicalAsk]);
    } else if (f.type === 'ask') {
      const ask = { id: f.askId, question: f.question, options: f.options, session: f.session, ts: f.ts,
        ownerAskTs: Number.isSafeInteger(f.askTs) && f.askTs > 0 ? f.askTs : null, ownerId: envelope.ownerId };
      if (!rememberLiveAsk(envelope.ownerId, ask)) return false;
      if (typeof opts.onAuthoritativeAsks === 'function') opts.onAuthoritativeAsks(envelope.ownerId, [ask]);
      opts.eventsHub.broadcast({ type: 'ask', ownerId: envelope.ownerId, eventId: envelope.eventId,
        ask });
    } else if (f.type === 'ask-closed') {
      const ownerAskTs = Number.isSafeInteger(f.askTs) && f.askTs > 0 ? f.askTs : null;
      const view = viewFor(envelope.ownerId);
      const current = view.asks.find(a => (a.ownerAskId || a.id) === f.askId) || (view.alertAsks && view.alertAsks.get(f.askId));
      const currentTs = current && (Object.hasOwn(current, 'ownerAskTs') ? current.ownerAskTs : current.ts);
      if (ownerAskTs && Number.isSafeInteger(currentTs) && currentTs > 0 && currentTs !== ownerAskTs) return false;
      if (typeof opts.onAskClosed === 'function') {
        const closed = opts.onAskClosed(envelope.ownerId, f.askId, f.outcome, ownerAskTs);
        if (closed && closed.generationMismatch === true) return false;
      }
      // The owner says the ask is closed: the VIEW drops it too, not only the
      // UI, or the next state read hands the card back. Same function as the
      // fan-out path: one closure semantics, one exported collection.
      applyOwnerClosure(envelope.ownerId, f.askId, { ownerAskTs, outcome: f.outcome });
      opts.eventsHub.broadcast({ type: f.outcome === 'dismissed' ? 'ask-dismissed' : 'ask-answered',
        id: f.askId, ownerAskId: f.askId, ownerId: envelope.ownerId, eventId: envelope.eventId,
        ...(ownerAskTs ? { ownerAskTs } : {}) });
    } else if (f.type === 'notify-closed' || f.type === 'notify-closed-node') {
      // The owner cleared a notice. The card leaves the exported view of every
      // device that reads this feed, live, and the tombstone keeps an anterior
      // snapshot from handing it back. The frame carries the id of the notice it
      // closes, not its own: the envelope id only moves the cursor.
      const eventId = typeof f.eventId === 'string' ? f.eventId : '';
      if (!eventId) return false;
      dismissNoticeConfirmed(envelope.ownerId, eventId);
      opts.eventsHub.broadcast({ type: 'notify-dismissed', ownerId: envelope.ownerId, eventId,
        ...(envelope.scope === 'cell' && envelope.cellId ? { originCell: envelope.cellId } : {}) });
    } else if (f.type === 'file-notice') {
      // Stessa forma della consegna locale (lib/files/routes.js): il nome del
      // file e' SEMPRE nel corpo, con la caption quando c'e'. Prima l'importato
      // senza caption arrivava all'operatore senza corpo, mentre il locale
      // portava il nome: due classi diverse per lo stesso avviso.
      opts.eventsHub.broadcast({ type: 'notify', title: `file: ${f.name}`, body: f.caption ? `${f.name} — ${f.caption}` : f.name,
        originNode: envelope.ownerId, ownerId: envelope.ownerId,
        // Stessa attribuzione di cella del ramo notify: un file e' un avviso
        // DELLA CELLA, e senza questo campo il relay lo contava come scope nodo
        // (budget diverso: 7 avvisi invece di 6).
        ...(envelope.scope === 'cell' && envelope.cellId ? { originCell: envelope.cellId } : {}),
        eventId: envelope.eventId,
        ts: Number.isFinite(envelope.emittedAt) ? envelope.emittedAt : Date.now() });
    } else if (f.type === 'fleet-state' || f.type === 'node-state') {
      opts.eventsHub.broadcast({ type: 'feed-state', ownerId: envelope.ownerId, eventId: envelope.eventId, state: f });
    }
    return true;
  }

  // One streaming session against one owner. Resolves when the stream ends.
  // First-hop identity headers: the visited chain starts with THIS node (the
  // owner's gate re-binds it to the token-authenticated peer, so a client can
  // only ever claim itself) and the hop proof is minted on the owner side.
  function identityHeaders(peer, store) {
    return {
      authorization: `Bearer ${peer.token}`,
      'x-nexuscrew-visited': store.nodeId,
    };
  }

  const ingress = { frames: [], bytes: [], globalFrames: [], globalBytes: [] };

  // Admits ONE frame and returns the window that tripped, or null. The record is
  // always written: a refused frame still happened on the wire.
  function ingressTrip(t, bytes, ownerId) {
    const cutoff = t - INGRESS_WINDOW_MS;
    const slide = (list) => { while (list.length && list[0].t <= cutoff) list.shift(); };
    slide(ingress.frames); slide(ingress.bytes); slide(ingress.globalFrames); slide(ingress.globalBytes);
    ingress.frames.push({ t, ownerId }); ingress.bytes.push({ t, bytes, ownerId });
    ingress.globalFrames.push({ t }); ingress.globalBytes.push({ t, bytes });
    const ownBytes = ingress.bytes.filter((x) => x.ownerId === ownerId).reduce((a, x) => a + x.bytes, 0);
    const globalBytes = ingress.globalBytes.reduce((a, x) => a + x.bytes, 0);
    const ownFrames = ingress.frames.filter((x) => x.ownerId === ownerId).length;
    if (ownFrames > INGRESS_MAX_FRAMES) return 'owner-frames';
    if (ownBytes > INGRESS_MAX_BYTES) return 'owner-bytes';
    if (ingress.globalFrames.length > INGRESS_GLOBAL_MAX_FRAMES) return 'global-frames';
    if (globalBytes > INGRESS_GLOBAL_MAX_BYTES) return 'global-bytes';
    return null;
  }

  // The block lasts until the window that tripped frees capacity — its oldest
  // record ages out — plus a bounded backoff: the next poll must not restart
  // while that counter is still full.
  function ingressBlockUntil(reason, t, ownerId) {
    const own = (list) => list.filter((x) => x.ownerId === ownerId);
    const list = reason === 'global-frames' ? ingress.globalFrames
      : reason === 'global-bytes' ? ingress.globalBytes
        : reason === 'owner-bytes' ? own(ingress.bytes) : own(ingress.frames);
    const oldest = list.length ? list[0].t : t;
    return Math.max(oldest + INGRESS_WINDOW_MS, t) + INGRESS_BLOCK_BACKOFF_MS;
  }

  async function streamOnce(peer, ownerId, store, slot) {
    const view = viewFor(ownerId);
    // The deadline expired: the peer is admitted again and the block is closed
    // by the transition that reopens the stream, not by a silent timeout.
    if (view.ingressBlockedUntil && view.ingressBlockedUntil <= Date.now()) {
      view.ingressBlockedUntil = null;
      view.ingressBlockReason = null;
    }
    const after = view.cursor ? `?after=${encodeURIComponent(view.cursor)}` : '';
    const ctrl = slot.controller;
    try {
      const r = await withDeadline(slot, IDLE_TIMEOUT_MS, (signal) => fetchImpl(routeUrl(peer, '/event-feed', after), {
        headers: identityHeaders(peer, store), signal,
      }));
      if (!active(ownerId, slot)) return;
      if (r.status === 403) {
        const body = await withDeadline(slot, ERROR_BODY_TIMEOUT_MS, () => r.json().catch(() => ({})));
        if (!active(ownerId, slot)) return;
        if (body.reason === 'events-disabled') { view.stale = true; return; }
      }
      if (r.status === 409) { // reset-required / cursor-future: resync from a fresh snapshot
        view.cursor = null;
        noteReset(view);
        return;
      }
      if (!r.ok) { view.stale = true; throw new Error(`event-feed HTTP ${r.status}`); }
      if (!active(ownerId, slot)) return;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await withDeadline(slot, IDLE_TIMEOUT_MS, () => reader.read());
        if (!active(ownerId, slot)) return;
        if (done) throw new Error('event-feed EOF');
        // Each read owns one deadline; no previous timeout survives the chunk.
        const chunk = dec.decode(value, { stream: true });
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          if (block.startsWith(':')) continue; // heartbeat
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          // Frame cap BEFORE JSON.parse.
          if (dataLine.length > 16 * 1024) { log('event-feed-client: oversized frame, resync'); view.cursor = null; noteReset(view); return; }
          // Ingress budget, counted per FRAME on the wire BEFORE it is parsed or
          // applied: over the cap this peer is disconnected by name and blocked
          // for the rest of its window, while the other owners keep streaming.
          const at = Date.now();
          const trip = ingressTrip(at, Buffer.byteLength(block, 'utf8'), ownerId);
          if (trip) {
            view.lastError = 'ingress-budget';
            view.ingressBlockReason = trip;
            view.ingressBlockedUntil = ingressBlockUntil(trip, at, ownerId);
            view.stale = true;
            log(`event-feed-client: ${ownerId.slice(0, 8)}… ingress-budget (${trip}), blocked for ${Math.round((view.ingressBlockedUntil - at) / 1000)} s`);
            // The transport is closed explicitly: an abandoned response would
            // keep the socket (and the owner's writer) alive until the GC.
            try { await reader.cancel(); } catch (_) { /* already closing */ }
            ctrl.abort();
            return;
          }
          let envelope;
          try { envelope = JSON.parse(dataLine.slice(6)); } catch (_) { view.cursor = null; noteReset(view); return; }
          // Owner mismatch on a frame: disconnect, never apply.
          if (envelope.ownerId !== ownerId) { log('event-feed-client: owner mismatch, disconnect'); return; }
          // Sequence continuity within the same epoch; anything else resyncs.
          const [, seqStr] = (block.split('\n').find((l) => l.startsWith('id: ')) || '').split(': ');
          const [epochStr, sStr] = String(seqStr || '').split(':');
          if (Number(epochStr) !== view.viewEpoch) {
            view.cursor = null;
            noteReset(view);
            return;
          }
          if (view.lastSeq !== undefined && Number(sStr) !== view.lastSeq + 1) { view.cursor = null; noteReset(view); return; }
          view.lastSeq = Number(sStr);
          view.consecutiveResets = 0; // a usable frame: the streak is over
          view.resyncExhaustions = 0; // and a working stream: the cooldown ladder back to the first step
          view.cursor = `${epochStr}:${sStr}`;
          clearRetry(ownerId, true);
          reemit(envelope);
        }
      }
    } finally {
      // The acquisition slot owns the connection throughout its lifecycle.
      ctrl.abort();
    }
  }

  // Capability BEFORE subscribing: an owner without the feed capability makes
  // the view unsupported — no fallback, no infinite backoff.
  async function checkCapability(peer, ownerId, slot) {
    const view = viewFor(ownerId);
    if (view.capabilityChecked) return true;
    // The health endpoint of the OWNER is probed directly (same pattern as
    // the tunnel health probe): /federation/health with the peer's token.
    const body = await withDeadline(slot, 5000, async (signal) => {
      const r = await fetchImpl(`http://127.0.0.1:${peer.localPort}/federation/health`, {
        headers: { authorization: `Bearer ${peer.token}` }, signal,
      });
      if (!r.ok) throw new Error(`health HTTP ${r.status}`);
      return r.json();
    });
    if (!active(ownerId, slot)) throw new Error('obsolete acquisition');
    if (body.eventFeedV1 !== true || body.instanceId !== ownerId) {
      view.unsupported = true;
      view.lastError = 'event-feed-unsupported';
      view.capabilityRecheckAt = now() + BACKOFF_MAX_MS;
      // One transition log, not one per tick: the poll gate keeps this
      // owner out from here on.
      log(`event-feed-client: ${ownerId.slice(0, 8)}… no feed capability, subscription refused`);
      return false;
    }
    view.unsupported = false;
    view.capabilityRecheckAt = null;
    view.capabilityChecked = true;
    return true;
  }

  // Il VALIDATORE unico dello snapshot: entrambe le vie (sottoscritta e non
  // sottoscritta) passano da qui. Niente logica duplicata: una regola nuova
  // vale per tutte le porte. Il pre-check della dimensione prima del parse
  // resta nei chiamanti come scorciatoia (non si paga il parse di un corpo
  // rifiutato): la regola vive qui.
  //
  // Due PROFILI dello stesso contratto, non due validatori:
  //   - 'decision' è ciò che rende l'elenco asks AUTOREVOLE per la chiusura
  //     degli alias importati (ownerId atteso, resyncRequired ben formato e
  //     non dichiarante, content-type dichiarato corretto, asks elenco di
  //     oggetti con id stringa 1..64, cap di pagina e per-elemento, cap del
  //     corpo). È il profilo della PORTA: la decisione di chiusura legge SOLO
  //     questi campi, e un campo che la decisione non legge non può tener
  //     aperta una card che l'owner ha chiuso (la vista che non si può
  //     applicare per colpa di cursor o notifications è un problema della
  //     vista, non una prova che l'ask sia ancora viva).
  //   - 'view' (default) aggiunge lo SCHEMA COMPLETO dei campi che la vista
  //     applica (cursor, viewEpoch, askReplyAccess, notifications, fleetState,
  //     i campi interni di ogni ask): qui un tipo sbagliato in QUALUNQUE
  //     punto non è mai 'ok' (reason 'snapshot-schema:<campo>') — lo snapshot
  //     non si applica, niente applicazione parziale.
  // Produttore di riferimento: lib/notify/event-feed-routes.js buildSnapshot
  // (emette sempre i campi della view e marca resyncRequired solo quando la
  // fonte aveva più voci del cap, non a pagina piena).
  function validateSnapshot(ownerId, snap, bytes, contentType, profile = 'view') {
    if (!snap || typeof snap !== 'object') return { ok: false, reason: 'shape' };
    if (bytes > 3 * 1024 * 1024) return { ok: false, reason: 'snapshot-oversize' };
    // ownerId: stringa E uguale all'atteso — un valore di altro tipo non può
    // coincidere con l'id atteso, quindi owner-mismatch copre anche la forma.
    if (snap.ownerId !== ownerId) return { ok: false, reason: 'owner-mismatch' };
    // Uno snapshot incompleto è un floor, non un tutto: mai autorevole.
    if (snap.resyncRequired === true) return { ok: false, reason: 'snapshot-resync-required' };
    // Il trasporto dichiara il tipo: dichiarato ma non application/json non è
    // la superficie dello snapshot. L'ASSENZA di dichiarazione è tollerata.
    if (contentType != null && !isJsonContentType(contentType)) return { ok: false, reason: 'snapshot-content-type' };
    const schema = (field) => ({ ok: false, reason: `snapshot-schema:${field}` });
    // resyncRequired, quando c'è, è un booleano del produttore: 1, "true" o
    // un oggetto sono un'altra versione del contratto, non un caso limite.
    if (snap.resyncRequired !== undefined && typeof snap.resyncRequired !== 'boolean') return schema('resyncRequired');
    // asks È l'elenco che decide la chiusura degli alias: OBBLIGATORIO, array.
    // Senza questa richiesta uno snapshot senza asks passava come 'ok' e la
    // riconciliazione chiudeva alias ancora aperti su un elenco che non c'era.
    if (!Array.isArray(snap.asks)) return schema('asks');
    const boundedId = (id) => typeof id === 'string' && id.length > 0 && id.length <= SNAPSHOT_ID_MAX_CHARS;
    const boundedElement = (e) => !!e && typeof e === 'object'
      && Buffer.byteLength(JSON.stringify(e), 'utf8') <= SNAPSHOT_ELEMENT_MAX_BYTES;
    // Cap di pagina e per-elemento: identità e misura. Id non stringa o vuoto,
    // elemento non oggetto o fuori budget → 'snapshot-element-oversize'
    // (mapping storico invariato, il cap resta un cap). SOPRA il cap (>): il
    // produttore marca resyncRequired solo quando la FONTe superava la pagina,
    // quindi una pagina ESATTAMENTE al cap senza marcatore è una forma
    // legittima dell'owner — la pagina al cap È il suo elenco aperto — mentre
    // OLTRE il cap la lista non prova l'assenza di nessuna domanda.
    if (snap.asks.length > SNAPSHOT_MAX_ASKS
      || !snap.asks.every((a) => boundedElement(a) && boundedId(a && a.id))) {
      return { ok: false, reason: 'snapshot-element-oversize' };
    }
    if (profile !== 'view') return { ok: true };
    // — da qui in poi solo lo schema della VISTA —
    // Flag e scalari col tipo esatto con cui la vista li applica (il
    // produttore li emette sempre: un tipo diverso è un'altra versione, non
    // un caso limite da tollerare). Assenti restano ammessi dove applySnapshot
    // ha un default; sbagliati mai.
    if (snap.cursor !== undefined && snap.cursor !== null && typeof snap.cursor !== 'string') return schema('cursor');
    if (snap.viewEpoch !== undefined && snap.viewEpoch !== null && typeof snap.viewEpoch !== 'number') return schema('viewEpoch');
    if (snap.askReplyAccess !== undefined && typeof snap.askReplyAccess !== 'boolean') return schema('askReplyAccess');
    if (snap.notifications !== undefined && snap.notifications !== null
      && !Array.isArray(snap.notifications)) return schema('notifications');
    if (snap.fleetState !== undefined && snap.fleetState !== null
      && (typeof snap.fleetState !== 'object' || Array.isArray(snap.fleetState))) return schema('fleetState');
    if (snap.fleetState && typeof snap.fleetState === 'object') {
      if (snap.fleetState.available !== undefined && typeof snap.fleetState.available !== 'boolean') return schema('fleetState');
      if (snap.fleetState.cells !== undefined && !Array.isArray(snap.fleetState.cells)) return schema('fleetState');
    }
    if (Array.isArray(snap.notifications)
      && (snap.notifications.length > SNAPSHOT_MAX_NOTIFY
        || !snap.notifications.every((e) => boundedElement(e) && boundedId(e && e.eventId)))) {
      return { ok: false, reason: 'snapshot-element-oversize' };
    }
    if (snap.fleetState && typeof snap.fleetState === 'object') {
      const cells = Array.isArray(snap.fleetState.cells) ? snap.fleetState.cells : [];
      if (cells.length > SNAPSHOT_MAX_CELLS || !boundedElement(snap.fleetState)
        || !cells.every((c) => boundedElement(c) && boundedId(c && c.cell))) {
        return { ok: false, reason: 'snapshot-element-oversize' };
      }
    }
    // Ogni ask: i campi che la card e la risposta usano davvero, col tipo del
    // produttore. Assente è ammesso dove il produttore omette (options, ts);
    // sbagliato mai — un numero al posto dell'id owner non deve diventare una
    // chiave di risposta.
    const askFieldsOk = (a) => (a.ownerAskId === undefined || (typeof a.ownerAskId === 'string' && a.ownerAskId.length > 0))
      && (a.question === undefined || typeof a.question === 'string')
      && (a.options === undefined || Array.isArray(a.options))
      && (a.session === undefined || typeof a.session === 'string')
      && (a.ts === undefined || typeof a.ts === 'number');
    if (!snap.asks.every(askFieldsOk)) return schema('asks');
    return { ok: true };
  }

  // Uno snapshot per finestra, per owner, da qualunque chiamante (poll della
  // view o porta). ESITO strutturato: { state: 'applied' | 'failed' |
  // 'skipped', asks?, appliedToView? }.
  //   - profilo 'view' (default, il poll): lo schema completo decide; solo un
  //     snapshot pienamente valido entra nella view ('applied' qui significa
  //     applicato davvero);
  //   - profilo 'decision' (la porta): decide il contratto della CHIUSURA. Se
  //     lo snapshot è autorevole per la decisione ma NON applicabile alla
  //     vista (cursor malformato, notifications di tipo sbagliato, …) la
  //     vista resta ferma e STALE con la sua causa — ma l'elenco asks torna
  //     comunque alla porta, che è autorizzata a decidere: un campo che la
  //     chiusura non legge non può tenere aperta una card chiusa dall'owner.
  async function snapshotOnce(peer, ownerId, store, { profile = 'view', slot = null } = {}) {
    const view = viewFor(ownerId);
    // INVARIANTE (punto d'ingresso, per owner): al massimo uno snapshot per
    // finestra, da qualunque causa di resync. Se la finestra non è trascorsa
    // non parte nessuna richiesta e NON si tocca nulla: né la scala, né il
    // cooldown di recupero — il campo della finestra è separato
    // (nextSnapshotAllowedAt) proprio perché i due meccanismi non si
    // mangino a vicenda. Lo stato resta stale e la visura in state() mostra
    // quando il prossimo tentativo è lecito.
    const since = view.lastSnapshotAt === undefined
      ? Number.POSITIVE_INFINITY
      : now() - view.lastSnapshotAt;
    if (since < minSnapshotIntervalMs) {
      view.stale = true;
      view.nextSnapshotAllowedAt = view.lastSnapshotAt + minSnapshotIntervalMs;
      return { state: 'skipped' };
    }
    view.lastSnapshotAt = now();
    view.nextSnapshotAllowedAt = null;
    const gen = generation;
    const acquisitionCursor = view.cursor;
    const acquisitionAskRevision = view.liveAskRevision || 0;
    const { r, text } = await withDeadline(slot, 8000, async (signal) => {
      const r = await fetchImpl(routeUrl(peer, '/event-feed/snapshot'), {
        headers: identityHeaders(peer, store), signal,
      });
      if (!r.ok) {
        const error = new Error(`snapshot HTTP ${r.status}`);
        error.snapshotReason = r.status === 503 ? 'asks-unreadable' : `http-${r.status}`;
        throw error;
      }
      return { r, text: await r.text() };
    });
    if ((slot && !active(ownerId, slot)) || gen !== generation) throw new Error('obsolete acquisition');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > 3 * 1024 * 1024) {
      view.stale = true; view.lastError = 'snapshot-oversize';
      return { state: 'failed' };
    }
    const snap = JSON.parse(text);
    // Il contratto della decisione decide l'ESITO dello snapshot; lo schema
    // della vista decide l'APPLICAZIONE. Due giudizi, una sola funzione di
    // regole.
    const decision = profile === 'view'
      ? null
      : validateSnapshot(ownerId, snap, bytes, contentTypeOf(r), 'decision');
    const forView = validateSnapshot(ownerId, snap, bytes, contentTypeOf(r), 'view');
    if (profile !== 'view' && !decision.ok) {
      // La causa resta in lastError: è ciò che l'operatore (e il cooldown
      // riarmato) mostrano finché l'owner non torna sanitario.
      view.stale = true; view.lastError = decision.reason;
      return { state: 'failed' };
    }
    // An event consumed during this acquisition is later than the start of
    // the read. Neither the view nor imported alias decisions may use that
    // older response to certify an ASK's absence.
    if (view.cursor !== acquisitionCursor || (view.liveAskRevision || 0) !== acquisitionAskRevision) {
      view.stale = true; view.lastError = 'snapshot-superseded';
      return { state: 'failed' };
    }
    if (!forView.ok) {
      if (profile !== 'view') {
        // Autorevole per la chiusura, non applicabile alla vista: la vista
        // resta com'è (stale, con la causa sua), la decisione va avanti.
        view.stale = true; view.lastError = forView.reason;
        return { state: 'applied', asks: snap.asks, appliedToView: false };
      }
      view.stale = true; view.lastError = forView.reason;
      return { state: 'failed' };
    }
    applySnapshot(ownerId, snap, gen);
    clearRetry(ownerId, true);
    return { state: 'applied', asks: snap.asks, appliedToView: true };
  }

  // One reconciliation round across every enabled peer. Never throws.
  async function poll() {
    if (stopped) return;
    const store = opts.loadStore();
    if (!store) return;
    const peers = (store.nodes || []).filter((n) => n && n.direction === 'outbound'
      && n.eventsReceive === true && n.token && n.localPort && n.nodeId);
    const eligible = new Map(peers.map((peer) => [peer.nodeId, peer]));
    const fingerprint = (peer) => JSON.stringify([peer.token, peer.localPort, peer.nodeId, peer.accessGrants, peer.accessPreset]);
    for (const [ownerId, config] of configurations) {
      const peer = eligible.get(ownerId);
      if (!peer || fingerprint(peer) !== config) {
        const slot = running.get(ownerId);
        if (slot) { running.delete(ownerId); slot.abort(); }
        clearRetry(ownerId, true);
        configurations.delete(ownerId);
        const view = views.get(ownerId);
        if (view) { view.cursor = null; view.stale = true; view.capabilityChecked = false; view.unsupported = false; }
      }
    }
    await Promise.all(peers.map(async (peer) => {
      const ownerId = peer.nodeId;
      configurations.set(ownerId, fingerprint(peer));
      if (now() < retryFor(ownerId).nextRetryAt) return;
      if (running.has(ownerId)) return; // one loop per pair
      // Il guard vale per TUTTO il round, non solo per lo stream: due poll
      // sovrapposti (tick + backoff, o macchina carica) facevano due snapshot
      // nella stessa finestra e il secondo, senza il flag di recupero,
      // saltava il riarma del cooldown. Lo stesso controller resta attivo
      // dalla prima acquisizione fino alla chiusura dello stream.
      const controller = new AbortController();
      const slot = { controller, abort: () => controller.abort() };
      running.set(ownerId, slot);
      const view = viewFor(ownerId);
      try {
        // L'invariante PRIMA del consumo del cooldown: se la finestra non è
        // trascorsa il tick non fa nulla — non consuma la scadenza del
        // cooldown di recupero (il tentativo vero avverrà a finestra passata,
        // col suo flag di recupero intatto) e non tocca il conto dei reset.
        if (!view.cursor && view.lastSnapshotAt !== undefined
          && now() - view.lastSnapshotAt < minSnapshotIntervalMs) {
          view.stale = true;
          return;
        }
        // Il cooldown scaduto paga UN tentativo e azzera lo streak: se il
        // tentativo fallisce, una nuova sequenza di reset deve poter
        // ri-esaurire e ri-armare il cooldown al gradino successivo. Finché il
        // cooldown è in piedi nessuna richiesta parte (il tappo resta in piedi).
        let recovery = false;
        if (view.resyncBlockedUntil) {
          if (now() < view.resyncBlockedUntil) return;
          view.resyncBlockedUntil = null;
          view.consecutiveResets = 0;
          recovery = true;
          log(`event-feed-client: ${ownerId.slice(0, 8)}… resync cooldown expired: one fresh snapshot attempt`);
        }
        if (view.unsupported) {
          if (now() < view.capabilityRecheckAt) return;
          view.capabilityChecked = false;
        }
        if ((view.ingressBlockedUntil || 0) > Date.now()) return;
        // La fase di ACQUISIZIONE del tentativo (capability + snapshot) ha UN
        // SOLO punto di uscita per gli esiti non riusciti: throw, timeout,
        // abort e 'failed' convergono tutti lì — non un ramo per tipo di
        // errore, così il prossimo modo di fallire non sfugge. Un fallimento
        // in questa fase con il cooldown scaduto RIARMA il gradino successivo
        // (un tentativo per scadenza, la causa resta in lastError); l'errore
        // lanciato si risolleva per il catch esterno (stale, lastError,
        // backoff). Lo stream resta fuori dalla fase: un suo errore dopo uno
        // snapshot riuscito è regime di trasporto (backoff), non di resync.
        // 'skipped' non è un fallimento: l'invariante della finestra ha solo
        // posticipato la richiesta, la scala non si tocca.
        let attemptError = null;
        let snapState = null; // null = tentativo non fatto (cursor già valido)
        try {
          if (!view.capabilityChecked) {
            const capOk = await checkCapability(peer, ownerId, slot);
            if (!capOk) return; // senza la capability il gate blocca: nessun tentativo fatto
          }
          if (!view.cursor) {
            snapState = await snapshotOnce(peer, ownerId, store, { slot }); // profilo view
          }
        } catch (e) {
          attemptError = e;
        }
        if (stopped || running.get(ownerId) !== slot) return;
        if (attemptError || (snapState && snapState.state === 'failed')) {
          if (recovery) armResyncCooldown(view, attemptError ? 'recovery attempt failed' : 'recovery snapshot failed');
        }
        if (attemptError) throw attemptError;
        // Un tentativo fallito o posticipato ferma il round; NESSUN tentativo
        // (cursor già valido) va dritto allo stream.
        if (snapState && snapState.state !== 'applied') return;
        await streamOnce(peer, ownerId, store, slot);
      } catch (e) {
        if (stopped || running.get(ownerId) !== slot) return;
        view.cursor = null;
        view.stale = true;
        // A named feed reason (e.g. owner-mismatch) survives a later transport
        // error: it is the reason the operator needs to see.
        if (!isNamedFeedReason(view.lastError)) {
          view.lastError = String((e && e.message) || e);
        }
        const delay = backoffMs(ownerId);
        const retry = retryFor(ownerId);
        clearRetry(ownerId);
        retry.nextRetryAt = now() + delay;
        log(`event-feed-client: ${ownerId.slice(0, 8)}… retry in ${delay} ms (${view.lastError})`);
        retry.timer = setTimeout(() => { retry.timer = null; void poll(); }, delay);
        if (typeof retry.timer.unref === 'function') retry.timer.unref();
      } finally {
        // Un round obsoleto non libera mai lo slot della nuova generazione.
        if (running.get(ownerId) === slot) running.delete(ownerId);
        slot.abort();
      }
    }));
  }

  let pollTimer = null;
  function start() {
    stopped = false; generation += 1;
    void poll();
    // The store is written AFTER boot in real life (pairing happens later):
    // keep scanning for newly enabled peers. Streams are long-lived, so this
    // tick only ever picks up peers that are not running yet.
    if (!pollTimer) {
      pollTimer = setInterval(() => { void poll(); }, opts.pollMs || 4000);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
    }
  }
  function stop() {
    stopped = true; generation += 1;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    for (const ownerId of retries.keys()) clearRetry(ownerId, true);
    for (const [, h] of running) { try { h.abort(); } catch (_) {} }
    running.clear();
  }

  // Local aggregated read: connected views only, with the watermark the UI
  // needs to initialize without racing the live stream.
  function state() {
    return {
      views: [...views.entries()].map(([ownerId, v]) => ({
        ownerId, cursor: v.cursor, viewEpoch: v.viewEpoch, stale: v.stale,
        // Diagnostica (doctor / feed-state): dove la view è e quanto le
        // manca — il cooldown residuo si legge con un confronto col clock.
        resyncBlockedUntil: v.resyncBlockedUntil || null,
        resyncExhaustions: v.resyncExhaustions || 0,
        // L'attesa dell'invariante finestra, separata dal cooldown.
        nextSnapshotAllowedAt: v.lastSnapshotAt === undefined ? null : v.lastSnapshotAt + minSnapshotIntervalMs,
        // Both sides of the merge matter to the UI: the answer/dismiss gate
        // (askReplyAccess) and the ingress/error state of the view.
        askReplyAccess: v.askReplyAccess === true,
        lastError: v.lastError || null,
        ingressBlockedUntil: v.ingressBlockedUntil || null,
        ingressBlockReason: v.ingressBlockReason || null,
        asks: visibleAsks(ownerId, v.asks), notifications: v.notifications, fleetState: v.fleetState,
      })),
    };
  }

  // A dismiss this node has CONFIRMED with the owner (the relay returned 2xx, or
  // the owner said so in a frame): only then does the view forget the ask, and
  // only then is it tombstoned. An uncertain or failed dismiss hides nothing.
  function dismissConfirmed(ownerId, askId) {
    const view = dropAskFromView(ownerId, askId);
    noteAskClosed(ownerId, askId, view.viewEpoch);
    return true;
  }

  // A notice dismissal this node has CONFIRMED (the owner's closure frame, or a
  // relay that returned 2xx/404): only then does the view forget the notice, and
  // only then is it tombstoned. Until then the card stays where it is.
  function dismissNoticeConfirmed(ownerId, eventId) {
    if (!ownerId || !eventId) return false;
    const view = dropNoticeFromView(ownerId, eventId);
    noteNoticeClosed(ownerId, eventId, view.viewEpoch);
    if (typeof opts.onViewChanged === 'function') {
      try { opts.onViewChanged(ownerId); } catch (_) { /* UI refresh cannot invalidate the closure. */ }
    }
    return true;
  }

  // Esito TIPIZZATO: {status:'ok', asks} | {status:'skipped'|'pending'|'error',
  // reason, retryAt}. SOLO 'ok' è autorevole (snapshot fresco, col contratto
  // della decisione soddisfatto, acquisito in questa chiamata): uno skip, un
  // pending, una finestra chiusa, un errore o un timeout non decidono MAI la
  // chiusura di un alias.
  const doorWindowAt = new Map(); // ownerId -> ultimo tentativo (owner non sottoscritti)
  const doorInFlight = new Set(); // ownerId -> tentativo in volo (owner sottoscritti)
  const DOOR_TIMEOUT_MS = 3000;
  function doorTimeoutPromise() {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), DOOR_TIMEOUT_MS);
      if (typeof t.unref === 'function') t.unref();
    });
  }
  async function ownerSnapshotAsks(ownerId) {
    const store = opts.loadStore();
    if (!store) return { status: 'error', reason: 'no-store' };
    const id = String(ownerId);
    const peer = (store.nodes || []).find((n) => n && n.nodeId === id && n.token && n.localPort);
    if (!peer) return { status: 'error', reason: 'peer-unknown' };
    if (peer.eventsReceive === true) {
      if (doorInFlight.has(id)) {
        const view = views.get(id);
        const retryAt = (view && typeof view.lastSnapshotAt === 'number' ? view.lastSnapshotAt : now()) + minSnapshotIntervalMs;
        return { status: 'pending', reason: 'attempt-in-flight', retryAt };
      }
      doorInFlight.add(id);
      let state = null;
      try {
        // Profilo DECISION: la porta decide la chiusura degli alias, legge
        // l'elenco che la decisione usa — e solo quello. La vista, nello
        // stesso snapshotOnce, applica il suo schema completo o resta ferma.
        state = await Promise.race([snapshotOnce(peer, id, store, { profile: 'decision' }), doorTimeoutPromise()]);
      } catch (error) {
        const reason = error && error.snapshotReason || 'transport';
        const view = viewFor(id);
        view.stale = true; view.lastError = reason;
        if (typeof opts.onViewChanged === 'function') {
          try { opts.onViewChanged(id); } catch (_) { /* Diagnostics cannot replace the acquisition failure. */ }
        }
        return { status: 'error', reason };
      } finally {
        doorInFlight.delete(id);
      }
      const view = views.get(id);
      const retryAt = (view && typeof view.lastSnapshotAt === 'number' ? view.lastSnapshotAt : now()) + minSnapshotIntervalMs;
      if (state === null) {
        const pendingView = viewFor(id);
        pendingView.stale = true; pendingView.lastError = 'snapshot-timeout';
        if (typeof opts.onViewChanged === 'function') {
          try { opts.onViewChanged(id); } catch (_) { /* A pending owner acquisition remains non-authoritative. */ }
        }
        return { status: 'pending', reason: 'door-timeout', retryAt };
      }
      if (state.state === 'skipped') return { status: 'skipped', reason: 'window', retryAt };
      if (state.state === 'applied') {
        // L'elenco autorevole è quello dello snapshot: anche quando la vista
        // non ha potuto applicarlo (appliedToView false) la decisione ha il
        // suo contratto soddisfatto.
        return Array.isArray(state.asks)
          ? { status: 'ok', asks: state.asks }
          : { status: 'error', reason: 'applied-without-view' };
      }
      return { status: 'error', reason: 'snapshot-failed' };
    }
    const last = doorWindowAt.get(id);
    if (last !== undefined && now() - last < minSnapshotIntervalMs) {
      return { status: 'skipped', reason: 'window', retryAt: last + minSnapshotIntervalMs };
    }
    doorWindowAt.set(id, now());
    // UN AbortController per fetch E corpo: un owner che manda gli header e
    // non chiude il corpo non può appendere chi ha chiesto lo snapshot.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOOR_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const r = await fetchImpl(routeUrl(peer, '/event-feed/snapshot'), {
        headers: identityHeaders(peer, store), signal: ctrl.signal,
      });
      if (!r.ok) return { status: 'error', reason: `http-${r.status}` };
      const text = await r.text();
      const bytes = Buffer.byteLength(text, 'utf8');
      let snap;
      try { snap = JSON.parse(text); } catch (_) { return { status: 'error', reason: 'shape' }; }
      // STESSO validatore della via sottoscritta, allo STESSO profilo
      // decisionale: ownerId atteso, content-type, resyncRequired e i cap
      // dell'elenco decidono qui esattamente come decidono là.
      const verdict = validateSnapshot(id, snap, bytes, contentTypeOf(r), 'decision');
      if (!verdict.ok) return { status: 'error', reason: verdict.reason };
      return { status: 'ok', asks: snap.asks };
    } catch (_) {
      return { status: 'error', reason: 'transport' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { start, stop, poll, state, reemit, viewFor, dismissConfirmed, dismissNoticeConfirmed, ownerSnapshotAsks, rememberLiveAsk, applyOwnerClosure };
}

module.exports = { createEventFeedClient };
