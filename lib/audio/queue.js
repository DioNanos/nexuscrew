'use strict';
// lib/audio/queue.js — coda degli enunciati di UN nodo.
//
// Un nodo ha una voce sola: gli enunciati si serializzano, non si sovrappongono.
// La coda e' bounded, deduplica per utteranceId, applica la prelazione di
// urgency alta e possiede il watchdog dell'ack di avvio.
//
// Transizioni di stato, tutte osservabili via `onStatus` e tutte oneste:
//   accepted -> spoken    l'adapter ha AVVIATO la sintesi (non "qualcuno ha sentito")
//   accepted -> refused   reason `adapter-error`   l'avvio non e' riuscito
//   accepted -> refused   reason `preempted`       prelazionato da un urgency alto
//   accepted -> refused   reason `stopped`         stop locale o remoto
//   accepted -> unknown   l'ack non e' arrivato entro il timeout: non si mente
//
// `unknown` non e' un fallimento nascosto: e' l'ammissione che il nodo non puo'
// dire cosa sia successo. Un fan-out o un failover devono poterlo distinguere da
// un rifiuto esplicito, altrimenti riprovano dove non serve o si fermano dove
// invece dovrebbero riprovare.
const ACK_TIMEOUT_MS = 5000;
const MAX_PENDING = 2;

function createSpeakQueue(opts = {}) {
  const adapter = opts.adapter || null;
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const ackTimeoutMs = Number.isFinite(opts.ackTimeoutMs) ? opts.ackTimeoutMs : ACK_TIMEOUT_MS;
  const maxPending = Number.isInteger(opts.maxPending) && opts.maxPending > 0 ? opts.maxPending : MAX_PENDING;
  const setTimeoutImpl = opts.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = opts.clearTimeoutImpl || clearTimeout;

  const pending = []; // enunciati in attesa, in ordine
  let current = null; // { utteranceId, handle, ackTimer }
  const known = new Set(); // utteranceId gia' visti: dedup finche' sono vivi

  // `spoken` e' un ACK, non una conclusione: l'enunciato e' partito e puo'
  // ancora essere fermato o prelazionato. Confondere le due cose renderebbe
  // impossibile registrare uno stop dopo l'avvio, che e' proprio il caso d'uso.
  function ack(entry) {
    if (entry.finished) return;
    entry.acked = true;
    if (entry.ackTimer) { clearTimeoutImpl(entry.ackTimer); entry.ackTimer = null; }
    onStatus(entry.utteranceId, 'spoken');
  }

  // Stato terminale: emette la transizione finale e libera il dedup.
  function settle(entry, status, reason) {
    if (entry.finished) return;
    entry.finished = true;
    if (entry.ackTimer) { clearTimeoutImpl(entry.ackTimer); entry.ackTimer = null; }
    known.delete(entry.utteranceId);
    onStatus(entry.utteranceId, status, reason);
  }

  // Fine naturale dopo un ack: nessuna nuova transizione da annunciare, `spoken`
  // resta lo stato finale. Si libera solo il dedup.
  function complete(entry) {
    if (entry.finished) return;
    entry.finished = true;
    if (entry.ackTimer) { clearTimeoutImpl(entry.ackTimer); entry.ackTimer = null; }
    known.delete(entry.utteranceId);
  }

  function startNext() {
    if (current || !pending.length) return;
    const entry = pending.shift();
    if (entry.finished) return startNext();
    current = entry;
    if (!adapter || typeof adapter.speak !== 'function') {
      current = null;
      settle(entry, 'refused', 'no-adapter');
      return startNext();
    }
    let handle;
    try {
      handle = adapter.speak({ text: entry.text, lang: entry.lang, voice: entry.voice });
    } catch (_) {
      current = null;
      settle(entry, 'refused', 'adapter-error');
      return startNext();
    }
    if (!handle || handle.started !== true) {
      current = null;
      settle(entry, 'refused', handle && handle.reason ? handle.reason : 'adapter-error');
      return startNext();
    }
    entry.handle = handle;
    // Ack di AVVIO: l'adapter ha accettato il testo e il processo e' partito.
    ack(entry);
    const finish = () => {
      complete(entry);
      if (current === entry) { current = null; startNext(); }
    };
    if (handle.done && typeof handle.done.then === 'function') handle.done.then(finish, finish);
    else finish();
    return undefined;
  }

  // enqueue(): l'ammissione e' sincrona e bounded. Ritorna sempre uno stato per
  // endpoint, mai un booleano aggregato.
  function enqueue({ utteranceId, text, lang = '', voice = '', urgency = 'normal' } = {}) {
    if (typeof utteranceId !== 'string' || !utteranceId) return { status: 'refused', reason: 'invalid-utterance' };
    if (typeof text !== 'string' || !text) return { status: 'refused', reason: 'invalid-text' };
    // Dedup: lo stesso utteranceId non viene mai pronunciato due volte mentre e'
    // ancora vivo. Un retry idempotente non produce una seconda voce.
    if (known.has(utteranceId)) return { status: 'accepted', reason: 'duplicate' };
    if (!adapter || typeof adapter.speak !== 'function') return { status: 'refused', reason: 'no-adapter' };

    const entry = { utteranceId, text, lang, voice, urgency, finished: false, acked: false, handle: null, ackTimer: null };

    if (urgency === 'high' && current) {
      // Prelazione: l'enunciato corrente non diventa mai `spoken` a posteriori,
      // transita a `refused/preempted`. La coda in attesa NON viene svuotata:
      // urgency cambia l'ordine, non cancella il consenso altrui a essere letto.
      const victim = current;
      current = null;
      try { if (victim.handle && typeof victim.handle.kill === 'function') victim.handle.kill(); } catch (_) {}
      settle(victim, 'refused', 'preempted');
      pending.unshift(entry);
    } else if (pending.length >= maxPending) {
      return { status: 'refused', reason: 'queue-full' };
    } else if (urgency === 'high') {
      pending.unshift(entry);
    } else {
      pending.push(entry);
    }

    known.add(utteranceId);
    entry.ackTimer = setTimeoutImpl(() => {
      // Timeout dell'ack: non si e' potuto confermare l'avvio. `unknown` e'
      // l'unica risposta corretta; promuoverlo a spoken sarebbe una bugia.
      const idx = pending.indexOf(entry);
      if (idx >= 0) pending.splice(idx, 1);
      if (current === entry) current = null;
      settle(entry, 'unknown', 'ack-timeout');
      startNext();
    }, ackTimeoutMs);
    if (entry.ackTimer && typeof entry.ackTimer.unref === 'function') entry.ackTimer.unref();

    startNext();
    return { status: 'accepted' };
  }

  // stop(): stop LOCALE sovrano. Non richiede rete, non richiede l'hub, non
  // richiede che l'origine sia raggiungibile. Un endpoint deve poter tacere.
  function stop(utteranceId) {
    let acted = false;
    if (current && (!utteranceId || current.utteranceId === utteranceId)) {
      const victim = current;
      current = null;
      try { if (victim.handle && typeof victim.handle.kill === 'function') victim.handle.kill(); } catch (_) {}
      settle(victim, 'refused', 'stopped');
      acted = true;
    }
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (!utteranceId || pending[i].utteranceId === utteranceId) {
        const [entry] = pending.splice(i, 1);
        settle(entry, 'refused', 'stopped');
        acted = true;
      }
    }
    startNext();
    return acted;
  }

  return {
    enqueue,
    stop,
    stopAll: () => stop(null),
    pendingSize: () => pending.length,
    isBusy: () => current !== null,
    currentId: () => (current ? current.utteranceId : null),
  };
}

module.exports = { createSpeakQueue, ACK_TIMEOUT_MS, MAX_PENDING };
