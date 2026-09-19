import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { getAsks, answerAsk, dismissAsk, relayAskAnswer, relayAskDismiss, relayAskVerify, getFeedState } from '../lib/api.js';
import { connectEvents } from '../lib/events.js';
import { useNotificationSpeech } from '../hooks/useNotificationSpeech.js';
import {
  NOTIFICATION_SPEECH_PREVIEW_EVENT, createNotificationSpeaker, notificationSpeechFrameLang,
} from '../lib/notification-speech.js';
import Icon from './Icon.jsx';
import './NotifyCenter.css';

// Centro notifiche del MCP bridge (design §3): toast non intrusivi per le
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

// Compattazione, mai sostituzione: due liste della stessa natura possono
// completarsi in QUALUNQUE ordine (snapshot locale da /api/asks, ask importate
// dal feed-state). Una chiave gia' nota resta una volta sola.
function mergeAsks(cur, extra) {
  const seen = new Set(cur.map((a) => askKeyOf(a.id, a.ownerId, a.ownerAskId)));
  const add = (extra || []).filter((a) => a && a.id && !seen.has(askKeyOf(a.id, a.ownerId, a.ownerAskId)));
  return add.length ? [...cur, ...add] : cur;
}

// Lo snapshot locale e' autorevole SOLO sulle proprie card: sostituisce gli ask
// locali (una domanda risposta altrove sparisce dal reload) ma NON deve
// cancellare le ask importate, che appartengono a un altro proprietario e
// arrivano dal feed-state. Senza questo, una risposta locale tardiva e vuota
// cancella una domanda remota ancora aperta.
function applyLocalSnapshot(cur, incoming) {
  const imported = mergeAsks([], cur.filter((a) => a.imported));
  const seen = new Set(imported.map((a) => askKeyOf(a.id, a.ownerId, a.ownerAskId)));
  const locals = (incoming || []).filter((a) => a && a.id && !seen.has(askKeyOf(a.id, a.ownerId, a.ownerAskId)));
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

function AskCard({ ask, token, onAnswered, onDismiss, askReplyAccess = false }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dismissing, setDismissing] = useState(false);
  // Esito incerto (owner remoto): il requestId è ciò che permette di verificare
  // SENZA ripetere il paste. Finché non è risolto, nessun nuovo invio.
  const [uncertainRid, setUncertainRid] = useState(null);
  const [verifying, setVerifying] = useState(false);

  const send = async (value) => {
    const answer = String(value || '').trim();
    if (!answer || busy) return;
    setErr(null); setBusy(true);
    try {
      if (ask.ownerId) {
        // `ownerAskId` esiste sugli ask ARRIVATI dalla federazione: il nostro
        // `id` locale e' nostro, la risposta deve citare l'id con cui l'OWNER
        // conosce la domanda, altrimenti colpirebbe un id che li' non esiste.
        // Gli ask importati dal feed non hanno `ownerAskId`: il loro `id` E'
        // gia' quello dell'owner, quindi il fallback li copre entrambi.
        const ownerAskId = ask.ownerAskId || ask.id;
        const out = await relayAskAnswer(token, { ownerId: ask.ownerId, askId: ownerAskId, text: answer });
        // Esito incerto: la card resta con lo stato «verifica», mai un retry cieco.
        if (out && out.uncertain) { setUncertainRid(out.requestId); return; }
        onAnswered(ask.id, ask.ownerId);
      } else {
        await answerAsk(token, ask.id, answer);
        onAnswered(ask.id);
      }
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  // Scarta la domanda: DELETE (marca dismissed lato server, lo storico resta).
  // Lo scarto fallito NON rimuove la card: un errore di rete non deve far
  // sparire una domanda ancora aperta.
  const dismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      if (ask.ownerId) {
        if (uncertainRid) return; // prima la verifica, poi eventualmente dismiss
        await relayAskDismiss(token, { ownerId: ask.ownerId, askId: ask.ownerAskId || ask.id });
        onDismiss(ask.id, ask.ownerId);
      } else {
        await dismissAsk(token, ask.id);
        onDismiss(ask.id);
      }
    } catch (_) { setDismissing(false); }
  };

  return (
    <div className="nc-ask-card">
      <div className="nc-ask-head">
        <span className="nc-ntf-from">{ask.session}</span>
        {ask.ownerId && <span className="nc-ntf-from">{t('feed-owner')}</span>}
        <code className="nc-ask-id">#{ask.id}</code>
        <button type="button" className="nc-ask-dismiss" title={t('ask-dismiss')} aria-label={t('ask-dismiss')} disabled={dismissing || (!!ask.ownerId && askReplyAccess === false)} onClick={dismiss}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="nc-ask-q">{ask.question}</div>
      {ask.ownerId && askReplyAccess === false && (
        <small className="nc-set-hint">{t('ask-remote-readonly')}</small>
      )}
      {uncertainRid && <>
        <div className="nc-err">{t('ask-uncertain')}</div>
        <button type="button" className="nc-btn ghost" disabled={verifying}
          onClick={async () => {
            setVerifying(true);
            try {
              const out = await relayAskVerify(token, { ownerId: ask.ownerId, askId: ask.id, requestId: uncertainRid });
              if (out && (out.state === 'committed' || out.state === 'failed')) onDismiss(ask.id, ask.ownerId);
            } finally { setVerifying(false); }
          }}>{t('ask-verify')}</button>
      </>}
      {(!ask.ownerId || askReplyAccess === true) && <>
        {Array.isArray(ask.options) && ask.options.length > 0 && (
          <div className="nc-ask-opts">
            {ask.options.map((o) => (
              <button key={o} type="button" className="nc-btn ghost" disabled={busy} onClick={() => send(o)}>{o}</button>
            ))}
          </div>
        )}
        <div className="nc-ask-reply">
          <textarea rows={2} placeholder={t('ask-reply-ph')} value={text} disabled={busy}
            onChange={(e) => setText(e.target.value)} />
          <button type="button" className="nc-btn primary" disabled={busy || !text.trim()}
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
  // Deep-link push (#ask=<id>): il pannello parte aperto.
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return /(?:^|[#&])ask=/.test(location.hash); } catch (_) { return false; }
  });
  const seq = useRef(0);
  const speaker = useRef(null);
  if (!speaker.current) speaker.current = createNotificationSpeaker();
  const speechState = useRef({ enabled: speechEnabled, lang });
  speechState.current = { enabled: speechEnabled, lang };

  const dropToast = useCallback((key) => {
    setToasts((cur) => cur.filter((x) => x.key !== key));
  }, []);

  const pushToast = useCallback((frame) => {
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
  const removeAsk = (id, ownerId) => setAsks((cur) => cur.filter((a) => askKeyOf(a.id, a.ownerId) !== askKeyOf(id, ownerId)));

  // Fetch iniziale ask aperti + canale SSE. Entrambi best-effort: la UI resta
  // usabile anche senza il canale (gli ask ricompaiono al prossimo mount).
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    // Lo snapshot locale NON sostituisce tutto lo stato: compatta con le ask
    // importate gia' presenti (l'ordine delle due risposte non e' garantito).
    getAsks(token).then((j) => { if (!cancelled) setAsks((cur) => applyLocalSnapshot(cur, j.asks)); }).catch(() => {});
    const close = connectEvents(token, (frame) => {
      if (frame.type === 'notify') pushToast(frame);
      else if (frame.type === 'ask' && frame.ask && frame.ask.id) {
        // Two owners can legitimately use the same ask id: identity is the pair.
        const key = askKeyOf(frame.ask.id, frame.ask.ownerId);
        setAsks((cur) => (cur.some((a) => askKeyOf(a.id, a.ownerId) === key) ? cur : [...cur, frame.ask]));
      } else if (frame.type === 'ask-answered' && frame.id) {
        removeAsk(frame.id, frame.ownerId);
      } else if (frame.type === 'ask-dismissed' && frame.id) {
        // Un'altra UI ha scartato la domanda: la card sparisce qui senza DELETE.
        removeAsk(frame.id, frame.ownerId);
      }
    });
    return () => { cancelled = true; close(); };
  }, [token, pushToast]);

  // Grant di risposta PER OWNER, dallo snapshot che il client ha del feed
  // (/api/feed-state). Assente = nessuna risposta: la card resta in lettura.
  const [replyGrants, setReplyGrants] = useState({});
  useEffect(() => {
    let alive = true;
    getFeedState(token).then((j) => {
      if (!alive) return;
      const grants = {};
      const imported = [];
      for (const v of (j && j.views) || []) {
        grants[v.ownerId] = v.askReplyAccess === true;
        // The local endpoint only knows local asks: the federated ones live in
        // the owner's snapshot, so a reload rebuilds them from here.
        for (const a of v.asks || []) {
          if (a && a.id) imported.push({ ...a, ownerId: v.ownerId, imported: true });
        }
      }
      setReplyGrants(grants);
      if (imported.length) setAsks((cur) => mergeAsks(cur, imported));
    }).catch(() => {});
    return () => { alive = false; };
  }, [token]);

  return (
    <>
      {toasts.length > 0 && (
        <div className="nc-ntf-toasts">
          {toasts.map((n) => <Toast key={n.key} n={n} onClose={() => dropToast(n.key)} />)}
        </div>
      )}
      {asks.length > 0 && !panelOpen && (
        <button type="button" className="nc-ask-badge" onClick={() => setPanelOpen(true)}
          title={t('asks-title')}>
          ? <span className="nc-ask-count">{asks.length}</span>
        </button>
      )}
      {asks.length > 0 && panelOpen && (
        <div className="nc-ask-panel">
          <div className="nc-ask-panel-head">
            <b>{t('asks-title')}</b>
            <span className="nc-ask-count">{asks.length}</span>
            <button type="button" className="nc-ntf-x" onClick={() => setPanelOpen(false)} title={t('close')}>
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="nc-ask-panel-body">
            {asks.map((a) => <AskCard key={askKeyOf(a.id, a.ownerId)} ask={a} token={token}
              askReplyAccess={!a.ownerId || replyGrants[a.ownerId] === true}
              onAnswered={removeAsk} onDismiss={removeAsk} />)}
          </div>
        </div>
      )}
    </>
  );
}
