import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import Icon from './Icon.jsx';
import './ComposerBar.css';

// Composer: testo multilinea + microfono. Il testo va nel PTY come input
// literal; l'Invio e' esplicito (bottone ➤). Voice: Web Speech se c'è,
// altrimenti registra e trascrive server-side (whisper locale, l'audio
// non lascia la VPS).
//
// NOTE: la rimozione dei newline finali e l'invio del CR usano charCode/
// String.fromCharCode invece di /[\r\n]+$/ e '\r' perche' il write-layer
// corrompe gli escape backslash (v. store.js): un line terminator letterale
// in un regex literal e' un SyntaxError. Semantica identica al piano.
const CR = String.fromCharCode(13); // \r — Invio

function stripTrailingNewlines(s) {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c === 10 || c === 13) end -= 1; // \n o \r
    else break;
  }
  return s.slice(0, end);
}

// node (opzionale): sessione remota — upload/voice passano dal proxy /node/<name>.
export default function ComposerBar({ send, token, session, node }) {
  useLang();
  const base = node ? `/node/${encodeURIComponent(node)}` : '';
  const [text, setText] = useState('');
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState('');
  const [serverStt, setServerStt] = useState(false);
  const recognitionRef = useRef(null);
  const mediaRef = useRef(null);
  // Tasto allegati (design 2026-07-10_attach_button_design.md): popover 3 voci
  // File/Fotocamera/Galleria; upload con paste=false, path appesi al testo.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, bottom: 0 });
  const [busy, setBusy] = useState(false);
  const attachBtnRef = useRef(null);
  const menuRef = useRef(null);
  const fileInputRef = useRef(null);
  const camInputRef = useRef(null);
  const galInputRef = useRef(null);
  // id univoco per aria-controls (un composer per tile nel grid)
  const menuIdRef = useRef(`nc-attach-${Math.random().toString(36).slice(2, 8)}`);

  // Voice split (M5): mic visibility = browser Web Speech OR server STT configured.
  // Se Web Speech e' supportato il mic resta visibile anche con server STT off;
  // se nessuno dei due -> mic nascosto.
  useEffect(() => {
    let cancelled = false;
    apiFetch(`${base}/api/voice/status`, token)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setServerStt(!!j.serverSttConfigured); })
      .catch(() => { if (!cancelled) setServerStt(false); });
    return () => { cancelled = true; };
  }, [token, base]);

  const wsAvailable = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const micVisible = !!(wsAvailable || serverStt);

  function submit() {
    const t = stripTrailingNewlines(text);
    if (!t) return;
    send(t);
    send(CR); // Invio esplicito, mai implicito nel testo incollato
    setText('');
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

  function pick(ref) {
    closeMenu(false);
    if (ref.current) ref.current.click();
  }

  // Upload sequenziale (l'API accetta 1 file per request) con paste=false:
  // il path NON va nel PTY — si appende al testo del composer, l'Invio è tuo.
  async function uploadFiles(files) {
    if (!files.length || !session) return;
    setBusy(true); setErr('');
    const paths = [];
    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append('session', session);
        fd.append('paste', 'false');
        fd.append('file', f, f.name);
        const r = await apiFetch(`${base}/api/files/upload`, token, { method: 'POST', body: fd });
        const j = await r.json();
        if (j.error) { setErr(j.error); break; }
        paths.push(j.path);
      } catch (e) { setErr(String(e)); break; }
    }
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
          const r = await apiFetch(`${base}/api/voice/transcribe`, token, {
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
        {/* input nascosti: File (tutto, multi) / Fotocamera (capture=hint best-effort,
            degrada a picker senza errore) / Galleria (media, multi) */}
        <input ref={fileInputRef} type="file" multiple hidden
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        <input ref={camInputRef} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        <input ref={galInputRef} type="file" accept="image/*,video/*" multiple hidden
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
        <textarea
          rows={2} value={text} placeholder={t('composer-placeholder')}
          onChange={(e) => setText(e.target.value)}
        />
        {micVisible && (
          <button className={rec ? 'mic on' : 'mic'} onClick={rec ? stopVoice : startVoice} title={t('voice')}><Icon name="mic" size={22} /></button>
        )}
        <button className="go" onClick={submit} title={t('send')}><Icon name="enter" size={22} /></button>
      </div>
    </div>
  );
}
