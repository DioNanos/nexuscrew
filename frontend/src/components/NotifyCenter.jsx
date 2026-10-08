import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { getAsks, answerAsk, dismissAsk, relayAskAnswer, relayAskDismiss, relayAskDismissLocal, relayAskVerify, getFeedState, getAskRelayState, getAskReplyCapability, relayNoticeDismiss, relayNoticeDismissAll } from '../lib/api.js';
import { mergeRemoteNotices, toRemoteNotice, normalizeTs, boundedByTs, noticeKeyOf } from '../lib/remote-notices.js';
import { connectEvents } from '../lib/events.js';
import { useNotificationSpeech } from '../hooks/useNotificationSpeech.js';
import {
  NOTIFICATION_SPEECH_PREVIEW_EVENT, createNotificationSpeaker, notificationSpeechFrameLang,
} from '../lib/notification-speech.js';
import Icon from './Icon.jsx';
import './NotifyCenter.css';

// Centro notifiche del MCP bridge: toast non intrusivi per le
// notify delle celle + pannello degli ask aperti (textarea/bottoni opzioni →
// POST answer) con badge contatore. Presente in OGNI vista (mobile e desktop):
// App lo monta come overlay, lo stato arriva via SSE (/api/events) con un
// fetch iniziale degli ask aperti (sopravvissuti a un reload/restart).

const TOAST_MS = 6000;
const TOAST_HIGH_MS = 12000;

// Identita' CANONICA di una card: (ownerId, ownerAskId). La stessa domanda
// arriva per DUE strade — l'import diretto (che porta un id locale E
// l'ownerAskId) e il feed dell'owner (che porta l'id dell'owner) — e deve
// restare UNA card sola. La chiave usa l'id dell'owner quando c'e' e ricade
// sull'id locale solo per gli ask di casa, che un ownerAskId non ce l'hanno.
const askKeyOf = (id, ownerId, ownerAskId) => `${ownerId || ''}:${ownerAskId || id}`;

// Stato della view del feed di un owner, dalla stessa lettura che decide i
// grant: 'missing' (nessuna sottoscrizione — la card può essere arrivata via
// push), 'degraded' (sottoscritta ma stale o in errore) o 'live'. Distingue
// SOLO il messaggio della card in sola lettura: i permessi di risposta restano
// decisi dal grant (askReplyAccess), mai da qui.
const feedViewStateOf = (health, ownerId) => {
  const h = health && health[ownerId];
  if (!h) return 'missing';
  return (h.stale === true || h.error === true) ? 'degraded' : 'live';
};

// Le ask che QUESTA interfaccia ha scartato dopo un dismiss CONFERMATO
// dall'owner. Senza memoria, la rilettura del feed-state (reload, o il giro
// successivo) rimette la card: e' la notifica che ricompare.
// Il tombstone ha un TTL: un id riusato dopo un reset dell'owner non resta
// nascosto per sempre.
const DISMISSED_TTL_MS = 10 * 60 * 1000;
// Recupero senza SSE. Se la SSE non si apre (o resta giù senza
// riaprirsi), una rilettura periodica limitata di /api/asks e /api/feed-state
// recupera ASK e notice senza reload; si ferma appena la SSE apre (l'open
// già rilancia le letture) e il backoff riparte dal base alla riapertura.
const ASK_RECOVERY_POLL_MS = 30 * 1000;
const ASK_RECOVERY_POLL_MAX_MS = 5 * 60 * 1000;
const dismissedAsks = new Map(); // askKeyOf -> timestamp
// Le notifiche IMPORTATE che QUESTA interfaccia ha scartato (dismiss confermato
// dall'owner, oppure frame di chiusura). Speculare a dismissedAsks: senza
// memoria, la rilettura dell'arretrato — che funziona — rimette la card al giro
// successivo, e un frame live ripetuto la rimette subito. Il TTL e' quello dello
// store dell'owner (15 min): un id riusato dopo un reset non resta nascosto per
// sempre.
const DISMISSED_NOTICES_TTL_MS = 15 * 60 * 1000;
const dismissedNotices = new Map(); // noticeKey -> timestamp
function noteNoticeDismissed(key) {
  dismissedNotices.set(key, Date.now());
  if (dismissedNotices.size > 4096) dismissedNotices.delete(dismissedNotices.keys().next().value);
}
function noticeStillDismissed(key) {
  const at = dismissedNotices.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > DISMISSED_NOTICES_TTL_MS) { dismissedNotices.delete(key); return false; }
  return true;
}
// L'area dell'avviso e' una sola per gli ask e per le notifiche: qui si tiene la
// mappa stato -> chiave i18n, e una chiave gia' completa passa com'e'.
const DISMISSAL_NOTICE_KEYS = { pending: 'ask-dismiss-local-pending', blocked: 'ask-dismiss-local-blocked' };
const dismissalNoticeKey = v => DISMISSAL_NOTICE_KEYS[v] || v;
const generationTsOf = a => Object.hasOwn(a, 'ownerAskTs') ? a.ownerAskTs : a.ownerAskId || a.originNode ? null : a.ts;

function noteAskDismissed(key, localAsk) {
  dismissedAsks.set(key, localAsk ? { at: Date.now(), local: true,
    ts: generationTsOf(localAsk),
    fingerprint: localAsk.question === undefined ? null : JSON.stringify([localAsk.question, localAsk.options || [], localAsk.session]) } : { at: Date.now() });
}

function askStillDismissed(a) {
  const key = askKeyOf(a.id, a.ownerId, a.ownerAskId);
  const at = dismissedAsks.get(key);
  if (at === undefined) return false;
  if (at.local) {
    const ts = generationTsOf(a);
    // Local intent has no TTL. A different observed generation is a new card;
    // durable filtering on reload remains the receiving server's responsibility.
    return !(at.ts && ts && at.ts !== ts)
      && (at.fingerprint === null || at.fingerprint === JSON.stringify([a.question, a.options || [], a.session]));
  }
  if (Date.now() - at.at > DISMISSED_TTL_MS) { dismissedAsks.delete(key); return false; }
  return true;
}

// Compattazione, mai sostituzione: due liste della stessa natura possono
// completarsi in QUALUNQUE ordine (snapshot locale da /api/asks, ask importate
// dal feed-state). Una chiave gia' nota resta una volta sola, e una scartata
// non rientra.
function mergeAsks(cur, extra) {
  const cards = new Map(cur.map(a => [askKeyOf(a.id, a.ownerId, a.ownerAskId), a]));
  for (const a of extra || []) {
    if (!a || !a.id || askStillDismissed(a)) continue;
    const key = askKeyOf(a.id, a.ownerId, a.ownerAskId), previous = cards.get(key);
    const ts = generationTsOf(a), oldTs = previous && generationTsOf(previous);
    if (!previous || (Number.isSafeInteger(ts) && ts > 0 && Number.isSafeInteger(oldTs) && oldTs > 0 && ts > oldTs)) cards.set(key, a);
  }
  return [...cards.values()];
}

// Lo snapshot locale e' autorevole SOLO sulle proprie card: sostituisce gli ask
// locali (una domanda risposta altrove sparisce dal reload) ma NON deve
// cancellare le ask importate, che appartengono a un altro proprietario e
// arrivano dal feed-state. Senza questo, una risposta locale tardiva e vuota
// cancella una domanda remota ancora aperta.
function applyLocalSnapshot(cur, incoming) {
  const imported = mergeAsks([], cur.filter((a) => a.imported));
  const seen = new Set(imported.map((a) => askKeyOf(a.id, a.ownerId, a.ownerAskId)));
  const locals = (incoming || []).filter((a) => a && a.id
    && !seen.has(askKeyOf(a.id, a.ownerId, a.ownerAskId))
    && !askStillDismissed(a));
  return [...locals, ...imported];
}

function Toast({ n, onClose }) {
  return (
    <div className={`nc-ntf-toast${n.urgency === 'high' ? ' high' : ''}`} role="status" aria-live="polite">
      <div className="nc-ntf-toast-txt">
        <b>{n.title}</b>
        {n.body && <small>{n.body}</small>}
        {n.session && <span className="nc-ntf-from">{n.session}</span>}
        {/* Evento importato da un owner federato: il badge dice CHI lo emette
            (verificato dal canale) e la card resta in sola lettura — nessun
            remote answer button (federated asks). */}
        {n.ownerId && <span className="nc-ntf-from">{t('feed-owner')}</span>}
      </div>
      <button type="button" className="nc-ntf-x" onClick={onClose} title={t('close')}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function AskCard({ ask, token, onAnswered, onDismiss, askReplyAccess = false, feedViewState = 'live', initialUncertainRid = null, canDismissLocal = false, canDismissRemote = false, capabilityStatus = 'loading', onRefused = () => {} }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dismissing, setDismissing] = useState(false);
  // Esito incerto (owner remoto): il requestId è ciò che permette di verificare
  // SENZA ripetere il paste. Finché non è risolto, nessun nuovo invio.
  const [uncertainRid, setUncertainRid] = useState(initialUncertainRid);
  const [verifying, setVerifying] = useState(false);
  // Blocco precedente: il nuovo requestId non ha ricevuta. Senza ID originale
  // resta solo la riconciliazione con l'owner: nessun reinvio cieco.
  const [blockedOriginal, setBlockedOriginal] = useState(false);
  const requestIdRef = useRef(null);
  useEffect(() => { if (initialUncertainRid) setUncertainRid(initialUncertainRid); }, [initialUncertainRid]);
  // La X di una card federata è sempre usabile sul nodo che la visualizza:
  // togliere la card è un intento locale, non una risposta, e non dipende dai
  // permessi dell'owner. Con il grant remoto la X chiude anche sull'owner,
  // altrimenti scarta solo qui. Solo il caricamento della capability e una
  // risposta in volo incerta restano blocchi.
  const dismissBlocked = dismissing || busy || !!uncertainRid || blockedOriginal
    || (!!ask.ownerId && capabilityStatus === 'loading');
  const dismissLocally = !!ask.ownerId && !canDismissRemote;

  const send = async (value) => {
    const answer = String(value || '').trim();
    if (!answer || busy || dismissing || uncertainRid || blockedOriginal) return;
    setErr(null); setBusy(true);
    try {
      if (ask.ownerId) {
        // `ownerAskId` esiste sugli ask ARRIVATI dalla federazione: il nostro
        // `id` locale e' nostro, la risposta deve citare l'id con cui l'OWNER
        // conosce la domanda, altrimenti colpirebbe un id che li' non esiste.
        // Gli ask importati dal feed non hanno `ownerAskId`: il loro `id` E'
        // gia' quello dell'owner, quindi il fallback li copre entrambi.
        const ownerAskId = ask.ownerAskId || ask.id;
        const out = await relayAskAnswer(token, { ownerId: ask.ownerId, askId: ownerAskId, text: answer, requestId: requestIdRef.current || (requestIdRef.current = crypto.randomUUID()) });
        // Esito incerto: la card resta con lo stato «verifica», mai un retry cieco.
        if (out && out.uncertain) {
          // Blocco precedente: il nuovo requestId non ha ricevuta — la verifica
          // possibile è solo sull'ID originale autorizzato, se noto.
          const missingOriginal = out.reason === 'delivery-unknown-block' && !out.originalRequestId;
          setUncertainRid(missingOriginal ? null : out.originalRequestId || out.requestId || requestIdRef.current);
          setBlockedOriginal(missingOriginal);
          return;
        }
        if (!out || out.status !== 'committed') { requestIdRef.current = null; onRefused(); setErr(t('ask-reconcile')); return; }
        onAnswered(ask.id, ask.ownerId, ask.ownerAskId);
      } else {
        await answerAsk(token, ask.id, answer);
        onAnswered(ask.id);
      }
    } catch (e) {
      setErr(String(e.message || e));
      if (ask.ownerId && !e.status) setUncertainRid(requestIdRef.current);
      else requestIdRef.current = null;
      onRefused();
    } finally { setBusy(false); }
  };

  // Hide only after an acknowledged durable mutation, never on a network error.
  const dismiss = async () => {
    if (dismissBlocked) return;
    setErr(null); setDismissing(true);
    try {
      let out;
      if (dismissLocally) {
        out = await relayAskDismissLocal(token, { ownerId: ask.ownerId, askId: ask.ownerAskId || ask.id });
        if (out?.dismissed !== true || out.scope !== 'local' || !['pending', 'blocked'].includes(out.ownerSync)) {
          throw new Error(t('ask-dismiss-unconfirmed'));
        }
      } else if (ask.ownerId) {
        await relayAskDismiss(token, { ownerId: ask.ownerId, askId: ask.ownerAskId || ask.id });
      } else {
        await dismissAsk(token, ask.id);
      }
      noteAskDismissed(askKeyOf(ask.id, ask.ownerId, ask.ownerAskId), dismissLocally ? ask : null);
      onDismiss(ask.id, ask.ownerId, ask.ownerAskId, out);
    } catch (e) {
      setErr(String((e && e.message) || e)); onRefused();
    } finally { setDismissing(false); }
  };
  const dismissTitle = uncertainRid || blockedOriginal ? t('ask-uncertain')
    : dismissLocally ? t('ask-dismiss-local')
    : (feedViewState === 'degraded' ? t('ask-dismiss-stale') : t('ask-dismiss'));

  return (
    <div className="nc-ask-card">
      <div className="nc-ask-head">
        <span className="nc-ntf-from">{ask.session}</span>
        {ask.ownerId && <span className="nc-ntf-from">{t('feed-owner')}</span>}
        <code className="nc-ask-id">#{ask.id}</code>
        {/* La X dice SEMPRE perché: con esito incerto il motivo è quello, con
            la view stale/degraded il messaggio avvisa che i dati della card
            non sono vivi (lo scarto parte comunque via relay diretto). */}
        <button type="button" className="nc-ask-dismiss"
          title={dismissTitle} aria-label={dismissTitle}
          disabled={dismissBlocked} onClick={dismiss}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="nc-ask-q">{ask.question}</div>
      {ask.ownerId && askReplyAccess === false && (
        <small className="nc-set-hint">
          {/* Due cause, stesso divieto: view assente o in errore → la risposta
              non parte perché questo nodo non importa il feed dell'owner (da
              attivare); view viva → è l'owner a non concederla. Il testo dice
              quale delle due è; i permessi non cambiano in nessun caso. */}
          {t(capabilityStatus === 'loading' ? 'ask-capability-loading' : capabilityStatus === 'unsupported' ? 'ask-capability-unsupported' : capabilityStatus === 'unreachable' ? 'ask-capability-unreachable' : 'ask-remote-readonly')}
        </small>
      )}
      {/* Con il permesso di risposta la card resta viva, ma se la view è
          stale/degraded l'operatore deve vederlo: è la card che ricompare
          quando il feed è fermo. */}
      {ask.ownerId && askReplyAccess !== false && feedViewState === 'degraded' && (
        <small className="nc-set-hint">{t('ask-feed-stale')}</small>
      )}
      {(uncertainRid || blockedOriginal) && <>
        <div className="nc-err">{t('ask-uncertain')}</div>
        {blockedOriginal && !uncertainRid && <div className="nc-err">{t('ask-reconcile')}</div>}
        {uncertainRid && <button type="button" className="nc-btn ghost" disabled={verifying}
          onClick={async () => {
            setVerifying(true);
            try {
              const out = await relayAskVerify(token, { ownerId: ask.ownerId, askId: ask.ownerAskId || ask.id, requestId: uncertainRid });
              if (out?.state === 'committed') onAnswered(ask.id, ask.ownerId, ask.ownerAskId);
              else if (out?.state === 'failed') {
                setUncertainRid(null); requestIdRef.current = null; onRefused();
              }
            } catch (e) { setErr(String(e.message || e)); onRefused(); }
            finally { setVerifying(false); }
          }}>{t('ask-verify')}</button>}
      </>}
      {(!ask.ownerId || askReplyAccess === true) && !uncertainRid && !blockedOriginal && <>
        {Array.isArray(ask.options) && ask.options.length > 0 && (
          <div className="nc-ask-opts">
            {ask.options.map((o) => (
              <button key={o} type="button" className="nc-btn ghost" disabled={busy || dismissing} onClick={() => send(o)}>{o}</button>
            ))}
          </div>
        )}
        <div className="nc-ask-reply">
          <textarea rows={2} placeholder={t('ask-reply-ph')} value={text} disabled={busy || dismissing}
            onChange={(e) => setText(e.target.value)} />
          <button type="button" className="nc-btn primary" disabled={busy || dismissing || !text.trim()}
            onClick={() => send(text)}>{t('send')}</button>
        </div>
      </>}
      {err && <div className="nc-err">{err}</div>}
    </div>
  );
}

export default function NotifyCenter({ token }) {
  const [lang] = useLang(); // re-render allo switch lingua
  const [speechEnabled] = useNotificationSpeech();
  const [toasts, setToasts] = useState([]);
  const [asks, setAsks] = useState([]);
  const [dismissalNotice, setDismissalNotice] = useState(null);
  // Arretrato di notifiche IMPORTATE dai feed remoti: lista consultabile e
  // SILENZIOSA (mai toast/TTS/push per queste card; il live resta com'era).
  // Dedup unica snapshot+SSE per (ownerId,eventId); bounded; una view revocata
  // fa sparire le sue card al prossimo feed-state.
  const [remoteNotices, setRemoteNotices] = useState([]);
  // Deep-link push (#ask=<id>): il pannello parte aperto.
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return /(?:^|[#&])ask=/.test(location.hash); } catch (_) { return false; }
  });
  const [replyCapabilities, setReplyCapabilities] = useState({});
  const capabilityRequests = useRef(new Map());
  const capabilityGeneration = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const closedAsks = useRef(new Map());
  const liveRevision = useRef(0);
  // Ordine MONOTONO di arrivo delle card notifiche: un timestamp non distingue
  // due operazioni nello stesso millisecondo, questo si. Crescente a ogni
  // frame live; la lettura cattura il valore corrente come soglia.
  const noticeArrivalSeq = useRef(0);
  const liveAsks = useRef(new Map());
  const ownerSnapshots = useRef(new Map());
  const alertAdmissions = useRef(new Map());
  const filterClosed = list => (list || []).filter(a => {
    const closed = closedAsks.current.get(askKeyOf(a.id, a.ownerId, a.ownerAskId));
    if (!closed) return true;
    if (Date.now() - closed.at > DISMISSED_TTL_MS) { closedAsks.current.delete(askKeyOf(a.id, a.ownerId, a.ownerAskId)); return true; }
    const ts = generationTsOf(a);
    if (Number.isSafeInteger(ts) && ts > 0 && Number.isSafeInteger(closed.ts) && closed.ts > 0) return ts !== closed.ts;
    return closed.fingerprint !== null && closed.fingerprint !== undefined && closed.fingerprint !== JSON.stringify([a.question, a.options || [], a.session]);
  });
  const asksRef = useRef(asks);
  asksRef.current = asks;
  const refreshCapabilities = useCallback((force = false) => {
    if (!token) return;
    const known = new Set();
    for (const ask of asksRef.current) {
      if (!ask.ownerId) continue;
      const askId = ask.ownerAskId || ask.id;
      const key = `${ask.ownerId}|${askId}`;
      known.add(key);
      const previous = capabilityRequests.current.get(key);
      if (previous && (!force || previous.pending)) continue;
      const controller = new AbortController();
      const generation = capabilityGeneration.current;
      const slot = { controller, pending: true };
      capabilityRequests.current.set(key, slot);
      setReplyCapabilities(cur => ({ ...cur, [key]: { canReply: false, status: 'loading' } }));
      getAskReplyCapability(token, { ownerId: ask.ownerId, askId }, { signal: controller.signal }).then(out => {
        if (generation !== capabilityGeneration.current || controller.signal.aborted || capabilityRequests.current.get(key) !== slot) return;
        const valid = out && out.ownerId === ask.ownerId && out.askId === askId && typeof out.canReply === 'boolean'
          && (!out.canReply || out.status === 'open');
        setReplyCapabilities(cur => ({ ...cur, [key]: valid ? out : { canReply: false, status: 'unreachable' } }));
      }).catch(() => {
        if (generation === capabilityGeneration.current && !controller.signal.aborted && capabilityRequests.current.get(key) === slot) {
          setReplyCapabilities(cur => ({ ...cur, [key]: { canReply: false, status: 'unreachable' } }));
        }
      }).finally(() => { slot.pending = false; });
    }
    for (const [key, slot] of capabilityRequests.current) if (!known.has(key)) {
      slot.controller.abort(); capabilityRequests.current.delete(key);
    }
  }, [token]);
  useEffect(() => {
    capabilityGeneration.current++;
    for (const slot of capabilityRequests.current.values()) slot.controller.abort();
    capabilityRequests.current.clear(); setReplyCapabilities({});
    return () => {
      capabilityGeneration.current++;
      for (const slot of capabilityRequests.current.values()) slot.controller.abort();
      capabilityRequests.current.clear();
    };
  }, [token]);
  useEffect(() => { refreshCapabilities(); }, [asks, refreshCapabilities]);
  const panelOpened = useRef(false);
  useEffect(() => {
    if (!panelOpen) return;
    if (panelOpened.current) refreshCapabilities(true);
    panelOpened.current = true;
  }, [panelOpen, refreshCapabilities]);
  const seq = useRef(0);
  const speaker = useRef(null);
  if (!speaker.current) speaker.current = createNotificationSpeaker();
  const speechState = useRef({ enabled: speechEnabled, lang });
  speechState.current = { enabled: speechEnabled, lang };

  const dropToast = useCallback((key) => {
    setToasts((cur) => cur.filter((x) => x.key !== key));
  }, []);

  const pushToast = useCallback((frame) => {
    if (frame.askId && frame.ownerId) {
      const generation = Number.isSafeInteger(frame.ownerAskTs) && frame.ownerAskTs > 0 ? frame.ownerAskTs : frame.ownerAskFingerprint;
      if (generation) {
        const identity = JSON.stringify([frame.ownerId, frame.ownerAskId || frame.askId, generation]);
        const now = Date.now();
        for (const [k, at] of alertAdmissions.current) if (now - at > 24 * 60 * 60 * 1000) alertAdmissions.current.delete(k);
        if (alertAdmissions.current.has(identity)) return;
        alertAdmissions.current.set(identity, now);
        if (alertAdmissions.current.size > 4096) alertAdmissions.current.delete(alertAdmissions.current.keys().next().value);
      }
    }
    const key = `t${seq.current += 1}`;
    setToasts((cur) => [...cur.slice(-3), { ...frame, key }]); // max 4 a schermo
    setTimeout(() => dropToast(key), frame.urgency === 'high' ? TOAST_HIGH_MS : TOAST_MS);
    const speech = speechState.current;
    if (speech.enabled) {
      try { speaker.current.enqueue(frame, notificationSpeechFrameLang(frame, speech.lang)); }
      catch (_) { /* il TTS opzionale non puo' rompere toast o canale SSE */ }
    }
  }, [dropToast]);

  // Nessun parlato arretrato o da una PWA non piu' attiva: blur, background,
  // opt-out e unmount interrompono e svuotano la coda locale. Le Web Push/OS
  // restano il canale corretto quando il documento non e' in primo piano.
  useEffect(() => {
    if (!speechEnabled) speaker.current.stop();
  }, [speechEnabled]);

  useEffect(() => {
    const stopIfInactive = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) speaker.current.stop();
    };
    const stopForPreview = () => speaker.current.stop();
    document.addEventListener('visibilitychange', stopIfInactive);
    window.addEventListener('blur', stopIfInactive);
    window.addEventListener(NOTIFICATION_SPEECH_PREVIEW_EVENT, stopForPreview);
    return () => {
      document.removeEventListener('visibilitychange', stopIfInactive);
      window.removeEventListener('blur', stopIfInactive);
      window.removeEventListener(NOTIFICATION_SPEECH_PREVIEW_EVENT, stopForPreview);
      if (typeof speaker.current.dispose === 'function') speaker.current.dispose();
      else speaker.current.stop();
    };
  }, []);

  // La chiave di una card è (ownerId, askId): gli ask importati hanno chiavi
  // di due parti, quelli locali una. Rimuovere per solo id toglierebbe la card
  // sbagliata quando due proprietari hanno lo stesso id di ask.
  // Older receivers emit the local alias id. Resolve it only within its owner,
  // and refuse a collision rather than removing an unrelated canonical card.
  const closureIdentity = frame => {
    if (frame.ownerAskId || !frame.ownerId) return frame;
    const matches = asksRef.current.filter(a => a.ownerId === frame.ownerId && (a.id === frame.id || a.ownerAskId === frame.id));
    const ids = new Set(matches.map(a => a.ownerAskId || a.id));
    return ids.size > 1 ? null : { ...frame, ownerAskId: ids.size === 1 ? [...ids][0] : frame.id };
  };
  const closureGenerationMismatch = (key, frame) => {
    const current = asksRef.current.find(a => askKeyOf(a.id, a.ownerId, a.ownerAskId) === key);
    const currentTs = current && generationTsOf(current);
    return Number.isSafeInteger(frame?.ownerAskTs) && frame.ownerAskTs > 0 && Number.isSafeInteger(currentTs) && currentTs > 0 && frame.ownerAskTs !== currentTs;
  };
  const removeAsk = (id, ownerId, ownerAskId, out) => {
    const key = askKeyOf(id, ownerId, ownerAskId);
    if (out?.scope === 'local' && ['pending', 'blocked'].includes(out.ownerSync)) setDismissalNotice(out.ownerSync);
    const current = asksRef.current.find(a => askKeyOf(a.id, a.ownerId, a.ownerAskId) === key);
    const currentTs = current && generationTsOf(current);
    if (closureGenerationMismatch(key, out)) return;
    const content = current || out?.askGeneration;
    closedAsks.current.set(key, { at: Date.now(), ts: current ? currentTs : out?.ownerAskTs,
      fingerprint: content && content.question !== undefined ? JSON.stringify([content.question, content.options || [], content.session]) : null });
    liveAsks.current.delete(key);
    if (closedAsks.current.size > 4096) closedAsks.current.delete(closedAsks.current.keys().next().value);
    setAsks((cur) => cur.filter((a) => askKeyOf(a.id, a.ownerId, a.ownerAskId) !== key));
  };

  // X di una card remota: l'intento e' locale e viene onorato subito; la
  // consegna all'owner puo' restare in coda (`pending`) o non essere autorizzata
  // (`blocked`) — in entrambi i casi la card esce e l'avviso lo dice. Solo un
  // rifiuto o un errore vero la lasciano al suo posto.
  const dismissRemoteNotice = async (n) => {
    setDismissalNotice(null);
    try {
      const out = await relayNoticeDismiss(token, { ownerId: n.ownerId, eventId: n.eventId });
      if (!out || out.dismissed !== true) throw new Error(t('remote-notices-dismiss-failed'));
      if (out.ownerSync === 'pending' || out.ownerSync === 'blocked') setDismissalNotice(out.ownerSync);
      noteNoticeDismissed(n.key);
      setRemoteNotices((cur) => cur.filter((x) => x.key !== n.key));
    } catch (_) {
      setDismissalNotice('remote-notices-dismiss-failed');
    }
  };

  // «Pulisci»: UN dismiss-all per gli owner DISTINTI delle card visibili (e' la
  // richiesta che sta dentro il budget dell'owner). Gli esiti sono per-owner e
  // possono essere parziali: chi e' stato raggiunto perde le sue card, chi ha
  // rifiutato le tiene, e la differenza si dichiara invece di sparire.
  const clearRemoteNotices = async () => {
    const visible = remoteNotices;
    const owners = [...new Set(visible.map((n) => n.ownerId))];
    if (owners.length === 0) return;
    setDismissalNotice(null);
    try {
      const out = await relayNoticeDismissAll(token, { owners });
      const results = (out && out.results) || {};
      const cleared = new Set();
      let outcome = null;
      for (const ownerId of owners) {
        const r = results[ownerId];
        if (!r || r.failed) { if (outcome !== 'blocked') outcome = 'failed'; continue; }
        if (r.blocked) outcome = 'blocked';
        else if (r.pending && outcome !== 'blocked' && outcome !== 'failed') outcome = 'pending';
        cleared.add(ownerId);
      }
      for (const n of visible) if (cleared.has(n.ownerId)) noteNoticeDismissed(n.key);
      setRemoteNotices((cur) => cur.filter((n) => !cleared.has(n.ownerId)));
      if (outcome === 'blocked') setDismissalNotice('blocked');
      else if (outcome === 'failed') setDismissalNotice('remote-notices-clear-failed');
      else if (outcome === 'pending') setDismissalNotice('pending');
    } catch (_) {
      setDismissalNotice('remote-notices-clear-failed');
    }
  };

  // Fetch iniziale ask aperti + canale SSE. Entrambi best-effort: la UI resta
  // usabile anche senza il canale (gli ask ricompaiono al prossimo mount).
  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    let streamOpen = false;
    let recoveryTimer = null;
    let recoveryDelay = ASK_RECOVERY_POLL_MS;
    const stopRecovery = () => {
      if (recoveryTimer !== null) clearTimeout(recoveryTimer);
      recoveryTimer = null;
    };
    const scheduleRecovery = () => {
      if (!alive || streamOpen || recoveryTimer !== null) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (!alive || streamOpen) return;
        setRefreshVersion(v => v + 1);
        recoveryDelay = Math.min(recoveryDelay * 2, ASK_RECOVERY_POLL_MAX_MS);
        scheduleRecovery();
      }, recoveryDelay);
    };
    const close = connectEvents(token, (frame) => {
      if (!alive) return;
      if (frame.type === 'feed-state-changed') { setRefreshVersion(v => v + 1); return; }
      if (frame.type === 'notify' && frame.ownerId && frame.eventId) {
        // Importato live: entra nella lista consultabile (dedup con l'arretrato
        // per (ownerId,eventId)); nessun toast/speaker aggiuntivo per la card.
        // Una card scartata non rientra, nemmeno se il frame si ripete.
        const card = toRemoteNotice(frame, frame.ownerId);
        if (card) card.arrivalSeq = ++noticeArrivalSeq.current;
        if (card && !noticeStillDismissed(card.key)) setRemoteNotices((cur) => boundedByTs(mergeRemoteNotices(cur, [card], null)));
      }
      if (frame.type === 'notify-dismissed') {
        // Chiusura decisa altrove (owner o altro dispositivo): la card di QUELL'owner
        // sparisce qui e resta nascosta all'arretrato che la contenesse ancora.
        const ownerId = String(frame.ownerId || ''), eventId = String(frame.eventId || '');
        if (ownerId && eventId) {
          const key = noticeKeyOf(ownerId, eventId);
          noteNoticeDismissed(key);
          setRemoteNotices((cur) => cur.filter((n) => n.key !== key));
        }
        return;
      }
      if (frame.type === 'notify') pushToast(frame);
      else if (frame.type === 'ask' && frame.ask && frame.ask.id) {
        // Two owners can legitimately use the same ask id: identity is the pair.
        const liveKey = askKeyOf(frame.ask.id, frame.ask.ownerId, frame.ask.ownerAskId);
        liveAsks.current.set(liveKey, ++liveRevision.current);
        if (liveAsks.current.size > 4096) liveAsks.current.delete(liveAsks.current.keys().next().value);
        setAsks((cur) => mergeAsks(cur, filterClosed([frame.ask])));
      } else if (frame.type === 'ask-answered' && frame.id) {
        const identity = closureIdentity(frame);
        if (identity) removeAsk(identity.id, identity.ownerId, identity.ownerAskId, frame);
      } else if (frame.type === 'ask-dismissed' && (frame.id || frame.ownerAskId)) {
        const identity = closureIdentity(frame);
        if (!identity) return;
        const key = askKeyOf(identity.id, identity.ownerId, identity.ownerAskId);
        if (closureGenerationMismatch(key, frame)) return;
        const localAsk = frame.scope === 'local' && asksRef.current.find(a => askKeyOf(a.id, a.ownerId, a.ownerAskId) === key);
        noteAskDismissed(key, frame.scope === 'local' ? localAsk || { ...frame.askGeneration, ownerAskTs: frame.ownerAskTs } : null);
        removeAsk(identity.id, identity.ownerId, identity.ownerAskId, frame);
      }
    }, () => {
      if (!alive) return;
      // SSE aperta: — il recupero si ferma e il backoff riparte.
      streamOpen = true;
      recoveryDelay = ASK_RECOVERY_POLL_MS;
      stopRecovery();
      refreshCapabilities(true);
      setRefreshVersion(v => v + 1);
    }, () => {
      if (!alive) return;
      streamOpen = false;
      scheduleRecovery();
    });
    scheduleRecovery();
    return () => { alive = false; stopRecovery(); close(); };
  }, [token, pushToast, refreshCapabilities]);

  useEffect(() => {
    let alive = true;
    const started = liveRevision.current;
    if (token) getAsks(token).then(j => { if (alive) setAsks(cur => mergeAsks(applyLocalSnapshot(cur, filterClosed((j.asks || []).filter(a => !a.ownerId || (ownerSnapshots.current.get(a.ownerId) || 0) <= started))), filterClosed(cur.filter(a => (liveAsks.current.get(askKeyOf(a.id, a.ownerId, a.ownerAskId)) || 0) > started)))); }).catch(() => {});
    return () => { alive = false; };
  }, [token, refreshVersion]);

  // Riconciliazione dopo refresh: gli esiti incerti noti al relay locale
  // ricostruiscono lo stato «verifica» delle card importate, senza reinvii.
  const [uncertainByOwnerAsk, setUncertainByOwnerAsk] = useState({});
  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    getAskRelayState(token).then((j) => {
      if (!alive) return;
      const map = {};
      for (const a of (j && j.attempts) || []) {
        if (a && a.state === 'uncertain' && a.ownerId && a.askId && a.requestId) {
          map[a.ownerId + '|' + a.askId] = a.requestId;
        }
      }
      setUncertainByOwnerAsk(map);
    }).catch(() => {});
    return () => { alive = false; };
  }, [token]);

  // Grant di risposta PER OWNER, dallo snapshot che il client ha del feed
  // (/api/feed-state). Assente = nessuna risposta: la card resta in lettura.
  // Accanto ai grant si conserva lo STATO di ogni view (stale/errore): serve a
  // distinguere «feed dell'owner non importato» da «grant negato» nel testo.
  const [viewHealth, setViewHealth] = useState({});
  useEffect(() => {
    let alive = true;
    const started = liveRevision.current;
    // Soglia monotona di avvio lettura: le card con ordine d'arrivo successivo
    // sono piu' nuove della pagina e sopravvivono alla riconciliazione
    // (vedi mergeRemoteNotices) — indipendentemente dal wall clock.
    const readArrivalSeq = noticeArrivalSeq.current;
    getFeedState(token).then((j) => {
      if (!alive) return;
      const health = {};
      const imported = [];
      const notices = new Map();
      const keepOwners = new Set();
      for (const v of (j && j.views) || []) {
        health[v.ownerId] = { stale: v.stale === true, error: !!v.lastError };
        keepOwners.add(v.ownerId);
        // The local endpoint only knows local asks: the federated ones live in
        // the owner's snapshot, so a reload rebuilds them from here.
        for (const a of v.asks || []) {
          if (a && a.id) imported.push({ ...a, ownerId: v.ownerId, imported: true });
        }
        // Arretrato notifiche importate: solo il tipo notificatorio, dedup su
        // (ownerId,eventId), testo come stringa (React fa l'escaping).
        for (const n of v.notifications || []) {
          const card = toRemoteNotice(n, v.ownerId);
          if (card) notices.set(card.key, card);
        }
      }
      setViewHealth(health);
      const authoritative = new Set(((j && j.views) || []).filter(v => {
        const cursor = typeof v.cursor === 'string' && /^([1-9]\d*):(\d+)$/.exec(v.cursor);
        return v.stale === false && Number.isSafeInteger(v.viewEpoch) && v.viewEpoch > 0
          && cursor && Number(cursor[1]) === v.viewEpoch && Number.isSafeInteger(Number(cursor[2]))
          && !v.lastError && !v.error && v.resyncRequired !== true && Array.isArray(v.asks) && v.asks.length <= 100;
      }).map(v => v.ownerId));
      for (const ownerId of authoritative) {
        ownerSnapshots.current.delete(ownerId); ownerSnapshots.current.set(ownerId, ++liveRevision.current);
        if (ownerSnapshots.current.size > 4096) ownerSnapshots.current.delete(ownerSnapshots.current.keys().next().value);
      }
      setAsks(cur => mergeAsks(cur.filter(a => !authoritative.has(a.ownerId) || (liveAsks.current.get(askKeyOf(a.id, a.ownerId, a.ownerAskId)) || 0) > started), filterClosed(imported)));
      // Rebuild dall'arretrato: le card di una view revocata cadono qui; le
      // card arrivate via SSE di un owner ancora attivo restano (dedup per key).
      // Le scartate non rientrano: il loro tombstone vive in dismissedNotices.
      setRemoteNotices((cur) => boundedByTs(mergeRemoteNotices(
        cur.filter((n) => !noticeStillDismissed(n.key)),
        [...notices.values()].filter((n) => !noticeStillDismissed(n.key)),
        keepOwners,
        // Una view AUTOREVOLE e fresca e' l'elenco: una card che non elenca e'
        // una chiusura di cui questo browser ha perso il frame live, e va via
        // anche se il pannello restava aperto. Le view stale/incomplete/marcate
        // non riconciliano, e una card arrivata dopo l'avvio della lettura resta.
        { owners: authoritative, arrivedAfter: (n) => (n.arrivalSeq || 0) > readArrivalSeq })));
    }).catch(() => {});
    return () => { alive = false; };
  }, [token, refreshVersion]);

  return (
    <>
      {dismissalNotice && <div className="nc-ntf-toasts"><div className="nc-ntf-toast" role="status">
        <div className="nc-ntf-toast-txt">{t(dismissalNoticeKey(dismissalNotice))}</div>
        <button type="button" className="nc-ntf-x" title={t('close')} onClick={() => setDismissalNotice(null)}><Icon name="x" size={14} /></button>
      </div></div>}
      {toasts.length > 0 && (
        <div className="nc-ntf-toasts">
          {toasts.map((n) => <Toast key={n.key} n={n} onClose={() => dropToast(n.key)} />)}
        </div>
      )}
      {(asks.length > 0 || remoteNotices.length > 0) && !panelOpen && (
        <button type="button" className="nc-ask-badge" onClick={() => setPanelOpen(true)}
          title={t('asks-title')}>
          ? <span className="nc-ask-count">{asks.length + remoteNotices.length}</span>
        </button>
      )}
      {(asks.length > 0 || remoteNotices.length > 0) && panelOpen && (
        <div className="nc-ask-panel">
          <div className="nc-ask-panel-head">
            <b>{t('asks-title')}</b>
            <span className="nc-ask-count">{asks.length}</span>
            <button type="button" className="nc-ntf-x" onClick={() => setPanelOpen(false)} title={t('close')}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="nc-ask-panel-body">
            {asks.map((a) => <AskCard key={askKeyOf(a.id, a.ownerId, a.ownerAskId)} ask={a} token={token}
              askReplyAccess={!a.ownerId || replyCapabilities[a.ownerId + '|' + (a.ownerAskId || a.id)]?.canReply === true}
              canDismissLocal={replyCapabilities[a.ownerId + '|' + (a.ownerAskId || a.id)]?.canDismissLocal === true}
              canDismissRemote={replyCapabilities[a.ownerId + '|' + (a.ownerAskId || a.id)]?.canDismissRemote === true
                || (replyCapabilities[a.ownerId + '|' + (a.ownerAskId || a.id)]?.canDismissRemote === undefined
                  && replyCapabilities[a.ownerId + '|' + (a.ownerAskId || a.id)]?.canReply === true)}
              capabilityStatus={replyCapabilities[a.ownerId + '|' + (a.ownerAskId || a.id)]?.status || 'loading'}
              onRefused={() => refreshCapabilities(true)}
              feedViewState={a.ownerId ? feedViewStateOf(viewHealth, a.ownerId) : 'live'}
              initialUncertainRid={a.ownerId ? (uncertainByOwnerAsk[a.ownerId + '|' + (a.ownerAskId || a.id)] || null) : null}
              onAnswered={removeAsk} onDismiss={removeAsk} />)}
            {remoteNotices.length > 0 && (
              <div className="nc-remote-notices">
                <div className="nc-remote-notices-head"><b>{t('remote-notices-title')}</b>
                  <button type="button" className="nc-remote-notices-clear" onClick={clearRemoteNotices}>
                    {t('remote-notices-clear')}
                  </button>
                </div>
                {remoteNotices.map((n) => (
                  <div key={n.key} className={'nc-remote-notice' + (n.urgency === 'high' ? ' nc-remote-notice-high' : '')}>
                    <div className="nc-remote-notice-head">
                      {n.title ? <b>{n.title}</b> : null}
                      <button type="button" className="nc-ntf-x" title={t('remote-notices-dismiss')}
                        aria-label={t('remote-notices-dismiss')} onClick={() => dismissRemoteNotice(n)}>
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                    {n.body ? <div>{n.body}</div> : null}
                    <div className="nc-remote-notice-meta">
                      {n.ownerId.slice(0, 8)} · {new Date(n.ts || Date.now()).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
