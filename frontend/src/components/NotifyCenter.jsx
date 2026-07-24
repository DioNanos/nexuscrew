import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { getAsks, answerAsk } from '../lib/api.js';
import { connectEvents } from '../lib/events.js';
import { useNotificationSpeech } from '../hooks/useNotificationSpeech.js';
import {
  NOTIFICATION_SPEECH_PREVIEW_EVENT, createNotificationSpeaker,
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

function Toast({ n, onClose }) {
  return (
    <div className={`nc-ntf-toast${n.urgency === 'high' ? ' high' : ''}`} role="status" aria-live="polite">
      <div className="nc-ntf-toast-txt">
        <b>{n.title}</b>
        {n.body && <small>{n.body}</small>}
        {n.session && <span className="nc-ntf-from">{n.session}</span>}
      </div>
      <button type="button" className="nc-ntf-x" onClick={onClose} title={t('close')}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function AskCard({ ask, token, onAnswered }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const send = async (value) => {
    const answer = String(value || '').trim();
    if (!answer || busy) return;
    setErr(null); setBusy(true);
    try {
      await answerAsk(token, ask.id, answer);
      onAnswered(ask.id);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  return (
    <div className="nc-ask-card">
      <div className="nc-ask-head">
        <span className="nc-ntf-from">{ask.session}</span>
        <code className="nc-ask-id">#{ask.id}</code>
      </div>
      <div className="nc-ask-q">{ask.question}</div>
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
      try { speaker.current.enqueue(frame, speech.lang); }
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
      speaker.current.stop();
    };
  }, []);

  // Fetch iniziale ask aperti + canale SSE. Entrambi best-effort: la UI resta
  // usabile anche senza il canale (gli ask ricompaiono al prossimo mount).
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    getAsks(token).then((j) => { if (!cancelled) setAsks(j.asks || []); }).catch(() => {});
    const close = connectEvents(token, (frame) => {
      if (frame.type === 'notify') pushToast(frame);
      else if (frame.type === 'ask' && frame.ask && frame.ask.id) {
        setAsks((cur) => (cur.some((a) => a.id === frame.ask.id) ? cur : [...cur, frame.ask]));
      } else if (frame.type === 'ask-answered' && frame.id) {
        setAsks((cur) => cur.filter((a) => a.id !== frame.id));
      }
    });
    return () => { cancelled = true; close(); };
  }, [token, pushToast]);

  const onAnswered = (id) => setAsks((cur) => cur.filter((a) => a.id !== id));

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
            {asks.map((a) => <AskCard key={a.id} ask={a} token={token} onAnswered={onAnswered} />)}
          </div>
        </div>
      )}
    </>
  );
}
