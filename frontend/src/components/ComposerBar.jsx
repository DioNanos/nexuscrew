import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { stripTrailingNewlines } from '../lib/composer-input.js';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useComposerState } from '../hooks/useComposerState.js';
import Icon from './Icon.jsx';
import { uploadSessionFiles } from '../lib/attachments.js';
import './ComposerBar.css';

// Composer: testo multilinea + microfono. Il testo va nel PTY come input
// literal; l'Invio e' esplicito (bottone ➤). Voice: Web Speech se c'è,
// altrimenti registra e trascrive server-side (whisper locale, l'audio
// non lascia la VPS).
//
// node (opzionale): sessione remota — upload/voice passano dal proxy /node/<name>.
export default function ComposerBar({ submitText, token, session, node, ownerId }) {
  useLang();
  const base = node ? `/api/route/${String(node).split('/').map(encodeURIComponent).join('/')}/_` : '/api';
  const {
    cellKey, text, setText, expanded, toggleExpanded, history, historyCursor,
    recallPrevious, recallNext, selectHistory, confirmSubmitted,
    clearHistory, flush,
  } = useComposerState({ ownerId, node, session });
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState('');
  const [serverStt, setServerStt] = useState(false);
  const recognitionRef = useRef(null);
  const mediaRef = useRef(null);
  const textareaRef = useRef(null);
  // Tasto allegati (design 2026-07-10_attach_button_design.md): popover 3 voci
  // File/Fotocamera/Galleria; upload con paste=false, path appesi al testo.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, bottom: 0 });
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const attachBtnRef = useRef(null);
  const menuRef = useRef(null);
  const historyBtnRef = useRef(null);
  const historyMenuRef = useRef(null);
  const fileInputRef = useRef(null);
  const camInputRef = useRef(null);
  const galInputRef = useRef(null);
  const composingRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPos, setHistoryPos] = useState({ left: 0, bottom: 0, width: 320 });
  // id univoco per aria-controls (un composer per tile nel grid)
  const menuIdRef = useRef(`nc-attach-${Math.random().toString(36).slice(2, 8)}`);

  // Voice split (M5): mic visibility = browser Web Speech OR server STT configured.
  // Se Web Speech e' supportato il mic resta visibile anche con server STT off;
  // se nessuno dei due -> mic nascosto.
  useEffect(() => {
    let cancelled = false;
    if (node) { setServerStt(false); return undefined; }
    apiFetch(`${base}/voice/status`, token)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setServerStt(!!j.serverSttConfigured); })
      .catch(() => { if (!cancelled) setServerStt(false); });
    return () => { cancelled = true; };
  }, [token, base]);

  const wsAvailable = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const micVisible = !!(wsAvailable || serverStt);

  async function submit() {
    const draft = text;
    const value = stripTrailingNewlines(draft);
    if (!value || sending) return;
    setSending(true);
    setErr('');
    let ok = false;
    try { ok = !!(await submitText(value)); } catch (_) { ok = false; }
    if (ok) confirmSubmitted(cellKey, draft, value);
    else setErr(t('composer-send-failed'));
    setSending(false);
    // Il tap sul send non deve trasferire il focus al bottone: su mobile questo
    // chiuderebbe l'IME dopo ogni invio. Il focus viene riaffermato anche dopo il
    // render che svuota il testo, mantenendo la tastiera pronta per il messaggio
    // successivo.
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }

  // --- Allegati ---
  // Popover position:fixed calcolato dal rect del bottone (review Codex: i tile
  // del grid hanno overflow:hidden — un absolute dentro il composer verrebbe
  // clippato). Ancorato sopra il bottone, clampato al viewport.
  function openMenu() {
    const r = attachBtnRef.current && attachBtnRef.current.getBoundingClientRect();
    if (r) {
      setMenuPos({
        left: Math.max(6, Math.min(r.left, window.innerWidth - 186)),
        bottom: window.innerHeight - r.top + 6,
      });
    }
    setMenuOpen(true);
  }
  function closeMenu(restoreFocus) {
    setMenuOpen(false);
    if (restoreFocus && attachBtnRef.current) attachBtnRef.current.focus();
  }

  function openHistory() {
    const r = historyBtnRef.current && historyBtnRef.current.getBoundingClientRect();
    if (r) {
      const width = Math.max(220, Math.min(360, window.innerWidth - 12));
      setHistoryPos({
        left: Math.max(6, Math.min(r.right - width, window.innerWidth - width - 6)),
        bottom: window.innerHeight - r.top + 6,
        width,
      });
    }
    setHistoryOpen(true);
  }
  function closeHistory(restoreFocus) {
    setHistoryOpen(false);
    if (restoreFocus && historyBtnRef.current) historyBtnRef.current.focus();
  }

  // Esc + click fuori chiudono il popover (review Codex: niente focus-trap
  // completa per 3 voci, ma Esc/outside-click/ripristino focus servono).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(true); };
    const onDown = (e) => {
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      const inBtn = attachBtnRef.current && attachBtnRef.current.contains(e.target);
      if (!inMenu && !inBtn) closeMenu(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!historyOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeHistory(true); };
    const onDown = (e) => {
      const inMenu = historyMenuRef.current && historyMenuRef.current.contains(e.target);
      const inBtn = historyBtnRef.current && historyBtnRef.current.contains(e.target);
      if (!inMenu && !inBtn) closeHistory(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [historyOpen]);

  function onComposerKeyDown(e) {
    if (e.isComposing || composingRef.current || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowUp' && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      if (recallPrevious()) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' && historyCursor >= 0
      && e.currentTarget.selectionStart === text.length && e.currentTarget.selectionEnd === text.length) {
      if (recallNext()) e.preventDefault();
    }
  }

  function pick(ref) {
    closeMenu(false);
    if (ref.current) ref.current.click();
  }

  // Upload sequenziale (l'API accetta 1 file per request) con paste=false:
  // il path NON va nel PTY — si appende al testo del composer, l'Invio è tuo.
  async function uploadFiles(files) {
    if (!files.length || !session) return;
    setBusy(true); setErr('');
    const { paths, errors } = await uploadSessionFiles({ files, token, session, node, paste: false });
    if (errors.length) setErr(errors.map((item) => `${item.name}: ${item.message}`).join(' · '));
    if (paths.length) {
      setText((prev) => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + paths.join(' '));
    }
    setBusy(false);
  }

  function stopVoice() {
    if (recognitionRef.current) recognitionRef.current.stop();
    if (mediaRef.current) mediaRef.current.stop();
    setRec(false);
  }

  async function startVoice() {
    setErr('');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      const r = new SR();
      r.lang = 'it-IT'; r.continuous = false; r.interimResults = true;
      const base = text ? `${text} ` : '';
      r.onresult = (ev) => {
        const t = Array.from(ev.results).map((x) => x[0].transcript).join('');
        setText(base + t);
      };
      r.onend = () => setRec(false);
      r.onerror = (e) => { setErr(`voice: ${e.error || 'errore'}`); setRec(false); };
      recognitionRef.current = r;
      r.start();
      setRec(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRec(false);
        setErr('trascrivo…');
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          const r = await apiFetch(`${base}/voice/transcribe`, token, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: blob,
          });
          const j = await r.json();
          if (j.error) setErr(j.error);
          else { setErr(''); setText((prev) => prev + (prev ? ' ' : '') + (j.text || '')); }
        } catch (e) { setErr(String(e)); }
      };
      mediaRef.current = { stop: () => mr.state !== 'inactive' && mr.stop() };
      mr.start();
      setRec(true);
    } catch (_) {
      setErr('microfono non disponibile');
      setRec(false);
    }
  }

  return (
    <div className="nc-composer">
      {err && <div className="nc-composer-err">{err}</div>}
      <div className="nc-composer-row">
        {session && (
          <button
            ref={attachBtnRef} className={busy ? 'attach busy' : 'attach'} disabled={busy}
            onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
            title={busy ? t('attach-uploading') : t('attach')} aria-label={t('attach')}
            aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuIdRef.current}
          ><Icon name="attach" size={22} /></button>
        )}
        {menuOpen && (
          <div
            ref={menuRef} id={menuIdRef.current} role="menu" className="nc-attach-menu"
            style={{ left: menuPos.left, bottom: menuPos.bottom }}
          >
            <button role="menuitem" onClick={() => pick(fileInputRef)}><Icon name="file" size={18} /> {t('attach-file')}</button>
            <button role="menuitem" onClick={() => pick(camInputRef)}><Icon name="camera" size={18} /> {t('attach-camera')}</button>
            <button role="menuitem" onClick={() => pick(galInputRef)}><Icon name="image" size={18} /> {t('attach-gallery')}</button>
          </div>
        )}
        <button
          ref={historyBtnRef} type="button" className="history"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => (historyOpen ? closeHistory(false) : openHistory())}
          title={t('composer-history-tools')} aria-label={t('composer-history-tools')}
          aria-haspopup="menu" aria-expanded={historyOpen}
        ><Icon name="history" size={21} /></button>
        {historyOpen && (
          <div
            ref={historyMenuRef} role="menu" className="nc-composer-history-menu"
            style={{ left: historyPos.left, bottom: historyPos.bottom, width: historyPos.width }}
          >
            <button
              role="menuitem" className="nc-composer-history-action"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                toggleExpanded(); closeHistory(false);
                requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
              }}
            >
              <Icon name={expanded ? 'chevronDown' : 'chevronUp'} size={18} />
              {t(expanded ? 'composer-collapse' : 'composer-expand')}
            </button>
            <div className="nc-composer-history-title">{t('composer-history')}</div>
            {history.length === 0 && <div className="nc-composer-history-empty">{t('composer-history-empty')}</div>}
            {history.map((item, index) => (
              <button
                type="button" role="menuitem" className="nc-composer-history-entry"
                key={`${item.at}:${index}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  selectHistory(item.text); closeHistory(false);
                  requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
                }}
              >
                <span>{item.text.replace(/\s+/g, ' ').slice(0, 180)}</span>
                {item.at > 0 && <small>{new Date(item.at).toLocaleString()}</small>}
              </button>
            ))}
            {history.length > 0 && (
              <button
                type="button" role="menuitem" className="nc-composer-history-clear"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { clearHistory(); closeHistory(false); }}
              >{t('composer-history-clear')}</button>
            )}
          </div>
        )}
        {/* input nascosti: File (tutto, multi) / Fotocamera (capture=hint best-effort,
            degrada a picker senza errore) / Galleria (media, multi) */}
        <input ref={fileInputRef} type="file" multiple hidden
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        <input ref={camInputRef} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        <input ref={galInputRef} type="file" accept="image/*,video/*" multiple hidden
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        <textarea
          ref={textareaRef}
          className={expanded ? 'expanded' : ''}
          rows={expanded ? 8 : 2} value={text} placeholder={t('composer-placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onBlur={flush}
        />
        {micVisible && (
          <button className={rec ? 'mic on' : 'mic'} onClick={rec ? stopVoice : startVoice} title={t('voice')}><Icon name="mic" size={22} /></button>
        )}
        <button type="button" className="go" disabled={sending}
          onPointerDown={(e) => e.preventDefault()}
          onClick={submit} title={t('send')}><Icon name="enter" size={22} /></button>
      </div>
    </div>
  );
}
