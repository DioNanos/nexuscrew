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

export default function ComposerBar({ send, token }) {
  useLang();
  const [text, setText] = useState('');
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState('');
  const [serverStt, setServerStt] = useState(false);
  const recognitionRef = useRef(null);
  const mediaRef = useRef(null);

  // Voice split (M5): mic visibility = browser Web Speech OR server STT configured.
  // Se Web Speech e' supportato il mic resta visibile anche con server STT off;
  // se nessuno dei due -> mic nascosto.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/voice/status', token)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setServerStt(!!j.serverSttConfigured); })
      .catch(() => { if (!cancelled) setServerStt(false); });
    return () => { cancelled = true; };
  }, [token]);

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
          const r = await apiFetch('/api/voice/transcribe', token, {
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
