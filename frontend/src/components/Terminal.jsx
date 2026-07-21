import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket } from '../lib/ws-client.js';
import { copyText } from '../lib/clipboard.js';
import { createComposerSubmitter } from '../lib/composer-input.js';
import { scrollPlan } from '../lib/terminal-scroll.js';
import { wantsLocalSelection, isCopyShortcut, LONG_PRESS_MS, movedBeyondLongPress } from '../lib/selection.js';
import { t } from '../lib/i18n.js';
import { filesFromTransfer, hasFilePayload, uploadSessionFiles } from '../lib/attachments.js';
import './Terminal.css';

// node (opzionale): sessione su nodo remoto — il WS passa dal proxy
// /node/<name>/ws (B1); tutto il resto del protocollo e' identico.
export default function Terminal({ session, node, token, readonly, takeSize, focused, sendRef, composerRef, actionRef, ctrlRef, setCtrlArmed, onFiles, fontSize = 13, selectionMode = false, onSelectionModeChange }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);        // {term, fit, sock} per lo zoom senza riconnettere
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const selectionModeRef = useRef(selectionMode);
  selectionModeRef.current = selectionMode;
  const [selection, setSelection] = useState('');
  const [copyState, setCopyState] = useState('');
  const [uploadState, setUploadState] = useState(null);

  const doCopy = async () => {
    const value = apiRef.current?.term?.getSelection() || selection;
    if (!value) { setCopyState(t('copy-empty')); setTimeout(() => setCopyState(''), 1500); return; }
    const ok = await copyText(value);
    setCopyState(ok ? t('copied') : t('copy-manual'));
    if (ok) { apiRef.current?.term?.clearSelection(); onSelectionModeChange?.(false); }
    setTimeout(() => setCopyState(''), 1800);
  };
  // doCopy cambia ad ogni render (closure su selection/lang): lo si tiene in un
  // ref cosi' i listener (keydown/mouse) registrati una volta nell'effect chiamano
  // sempre la versione fresca, senza dover re-iscrivere i listener.
  const doCopyRef = useRef(doCopy);
  doCopyRef.current = doCopy;

  // Focus → size-owner (§5b): quando il tile prende/perde il focus manda il
  // frame 'focus' cosi' il server promuove/demota il client (ignore-size).
  // Connessione viva: non riapre il socket.
  useEffect(() => {
    const api = apiRef.current;
    if (api && api.sock && api.sock.focus) api.sock.focus(!!focused);
  }, [focused]);

  // Zoom: cambia solo il font e rifitta — la connessione resta viva.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.term.options.fontSize = fontSize;
    api.fit.fit();
    api.sock.resize(api.term.cols, api.term.rows);
  }, [fontSize]);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true, fontSize: fontSizeRef.current, scrollback: 1000,
      theme: { background: '#0a0e0a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    const dec = new TextDecoder();

    let sock;
    try {
      sock = openTerminalSocket({
        session, node, token, readonly, takeSize, focused: focusedRef.current, onFiles,
        cols: term.cols, rows: term.rows,
        onData: (bytes) => term.write(dec.decode(bytes)),
        onExit: () => term.write('\r\n\x1b[33m[sessione finita]\x1b[0m\r\n'),
      });
    } catch (e) {
      term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
      return () => term.dispose();
    }
    apiRef.current = { term, fit, sock };

    // During a programmatic composer paste, collect the result of xterm's
    // synchronous onData emission. This lets the composer retain its draft if
    // the WebSocket is not OPEN instead of clearing text that never left.
    let composerPaste = null;
    const onData = term.onData((d) => {
      if (readonly) {
        if (composerPaste) composerPaste.ok = false;
        return;
      }
      // sticky Ctrl: fold the next single character into its control code (a-z/@-_).
      // A composer paste is literal and must never consume an armed Ctrl key.
      if (!composerPaste && ctrlRef && ctrlRef.current && d.length === 1) {
        const c = d.charCodeAt(0);
        let code = c;
        if (c >= 97 && c <= 122) code = c - 96;        // a-z -> ^A..^Z
        else if (c >= 64 && c <= 95) code = c - 64;    // @A-Z[\]^_ -> ^@..^_
        else if (c === 32) code = 0;                   // space -> ^@
        d = String.fromCharCode(code);
        ctrlRef.current = false;
        if (setCtrlArmed) setCtrlArmed(false);
      }
      const ok = sock.sendInput(d);
      if (composerPaste) {
        composerPaste.seen = true;
        composerPaste.ok = composerPaste.ok && ok;
      }
    });
    if (sendRef) sendRef.current = (seq) => sock.sendInput(seq);     // tasti grezzi (KeyBar)
    if (actionRef) actionRef.current = (name) => sock.action(name);  // nav window/pane (KeyBar)
    if (composerRef) {
      composerRef.current = createComposerSubmitter({
        isReady: () => !readonly && sock.isReady(),
        paste: (value) => {
          const state = { seen: false, ok: true };
          composerPaste = state;
          try { term.paste(value); } catch (_) { state.ok = false; }
          finally { composerPaste = null; }
          return state.seen && state.ok;
        },
        send: (seq) => sock.sendInput(seq),
      });
    }
    const onSelection = term.onSelectionChange(() => setSelection(term.getSelection()));
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.getSelection()) {
        if (e.type === 'keydown') copyText(term.getSelection());
        return false;
      }
      return true;
    });
    // Cronologia col gesto: drag verticale (dito) e rotella → copy-mode
    // server-side. Dito verso il basso = storia più vecchia (scroll-up).
    // Il drag col MOUSE resta selezione testo. Grazie a copy-mode -e, il
    // gesto opposto fino in fondo riporta al vivo.
    const host = hostRef.current;
    let uploading = false;
    const uploadAttachments = async (files) => {
      if (!files.length || uploading) return;
      if (readonly) { setUploadState({ error: t('settings-readonly') }); return; }
      uploading = true;
      setUploadState({ current: 0, total: files.length, name: '' });
      const result = await uploadSessionFiles({
        files, token, session, node, paste: true,
        onProgress: ({ index, total, name, state, error }) => setUploadState({
          current: index + 1, total, name, ...(state === 'error' ? { error } : {}),
        }),
      });
      uploading = false;
      if (result.errors.length) setUploadState({ error: result.errors.map((item) => `${item.name}: ${item.message}`).join(' · ') });
      else {
        setUploadState({ done: true, total: result.paths.length });
        setTimeout(() => setUploadState(null), 1600);
      }
    };
    const onPasteFiles = (event) => {
      const transfer = event.clipboardData;
      if (!hasFilePayload(transfer)) return; // text paste remains entirely xterm/browser-owned
      const files = filesFromTransfer(transfer);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      uploadAttachments(files);
    };
    const onDragFiles = (event) => {
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation();
    };
    const onDropFiles = (event) => {
      if (!hasFilePayload(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation();
      uploadAttachments(filesFromTransfer(event.dataTransfer));
    };
    host.addEventListener('paste', onPasteFiles, true);
    host.addEventListener('dragenter', onDragFiles, true);
    host.addEventListener('dragover', onDragFiles, true);
    host.addEventListener('drop', onDropFiles, true);
    // alt-screen (TUI full-screen tipo Claude Code): lo scrollback tmux e'
    // vuoto, copy-mode non mostra nulla -> mandiamo PageUp/PageDown al pty e
    // il TUI scrolla il suo transcript. Logica+test in lib/terminal-scroll.js.
    const planFor = () => scrollPlan({ bufferType: term.buffer.active.type, readonly });
    const scrollTerminal = (dir) => {
      const plan = planFor();
      const key = dir === 'up' ? plan.up : plan.down;
      if (plan.kind === 'send') sock.sendInput(key); else sock.action(key);
    };
    let touchY = null, touchX = null, acc = 0, vertical = null, selectStart = null;
    let longPressTimer = null; let touchSelecting = false;
    const clearLongPress = () => { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = null; };
    const cellXY = (clientX, clientY) => {
      const screen = host.querySelector('.xterm-screen') || host;
      const r = screen.getBoundingClientRect();
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor(((clientX - r.left) / Math.max(1, r.width)) * term.cols)));
      const visibleRow = Math.max(0, Math.min(term.rows - 1, Math.floor(((clientY - r.top) / Math.max(1, r.height)) * term.rows)));
      return { col, row: term.buffer.active.viewportY + visibleRow };
    };
    const cellAt = (touch) => cellXY(touch.clientX, touch.clientY);
    const onTouchStart = (e) => {
      clearLongPress(); touchSelecting = false;
      if (e.touches.length !== 1) { touchY = null; return; }
      if (selectionModeRef.current) {
        e.preventDefault(); e.stopPropagation();
        selectStart = cellAt(e.touches[0]); term.clearSelection(); return;
      }
      touchY = e.touches[0].clientY; touchX = e.touches[0].clientX; acc = 0; vertical = null;
      const start = { x: touchX, y: touchY };
      longPressTimer = setTimeout(() => {
        longPressTimer = null; touchSelecting = true;
        selectionModeRef.current = true;
        onSelectionModeChange?.(true);
        selectStart = cellXY(start.x, start.y);
        term.clearSelection();
        term.select(selectStart.col, selectStart.row, 1);
        // Da questo momento il gesto e' selezione, non scroll.
        touchY = null; touchX = null; vertical = null; acc = 0;
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e) => {
      if ((selectionModeRef.current || touchSelecting) && selectStart && e.touches.length === 1) {
        e.preventDefault(); e.stopPropagation();
        const end = cellAt(e.touches[0]);
        const a = selectStart.row * term.cols + selectStart.col;
        const b = end.row * term.cols + end.col;
        const first = a <= b ? selectStart : end;
        term.select(first.col, first.row, Math.abs(b - a) + 1);
        return;
      }
      if (touchY === null || e.touches.length !== 1) return;
      // preventDefault SUBITO, non dopo la soglia: al primo touchmove il
      // browser decide tra native scroll e JS — se non blocchi qui, parte il
      // pan nativo e i preventDefault successivi vengono ignorati.
      e.preventDefault(); e.stopPropagation();
      const t = e.touches[0];
      if (longPressTimer && movedBeyondLongPress(touchX, touchY, t.clientX, t.clientY)) clearLongPress();
      if (vertical === null && (Math.abs(t.clientY - touchY) > 8 || Math.abs(t.clientX - touchX) > 8)) {
        vertical = Math.abs(t.clientY - touchY) > Math.abs(t.clientX - touchX);
      }
      if (!vertical) return;
      acc += t.clientY - touchY; touchY = t.clientY;
      const step = planFor().step;
      while (acc >= step) { scrollTerminal('up'); acc -= step; }
      while (acc <= -step) { scrollTerminal('down'); acc += step; }
    };
    const onTouchEnd = () => { clearLongPress(); touchY = null; touchX = null; selectStart = null; touchSelecting = false; };
    let wheelAcc = 0;
    const onWheel = (e) => {
      e.preventDefault(); e.stopPropagation();
      wheelAcc += e.deltaY;
      const step = planFor().step;
      while (wheelAcc <= -step) { scrollTerminal('up'); wheelAcc += step; }
      while (wheelAcc >= step) { scrollTerminal('down'); wheelAcc -= step; }
    };
    host.addEventListener('touchstart', onTouchStart, { passive: false });
    host.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('touchcancel', onTouchEnd, { passive: true });
    const onContextMenu = (e) => {
      if (selectionModeRef.current || touchSelecting) { e.preventDefault(); e.stopPropagation(); }
    };
    host.addEventListener('contextmenu', onContextMenu, true);
    host.addEventListener('wheel', onWheel, { passive: false, capture: true });

    // Gesto desktop "forza selezione locale" (iTerm-like, fix copia Mac): una TUI
    // con mouse reporting (tmux/vim/htop) cattura i drag -> la selezione "gialla"
    // era server-side e Cmd+C non copiava. Con Shift (Shift+Control+drag gesto
    // esplicito, oppure Shift+drag standard xterm) intercettiamo i mouse event
    // nel capture phase PRIMA di xterm: preventDefault+stopPropagation li togono
    // alla TUI e selezioniamo noi localmente. Senza Shift, i mouse event vanno a
    // xterm/tmux come prima (comportamento touch invariato).
    let mouseSelectStart = null;
    const onMouseDown = (e) => {
      if (!wantsLocalSelection(e)) return;
      e.preventDefault(); e.stopPropagation();
      mouseSelectStart = cellXY(e.clientX, e.clientY);
      term.clearSelection();
    };
    const onMouseMove = (e) => {
      if (!mouseSelectStart) return;
      e.preventDefault(); e.stopPropagation();
      const end = cellXY(e.clientX, e.clientY);
      const a = mouseSelectStart.row * term.cols + mouseSelectStart.col;
      const b = end.row * term.cols + end.col;
      const first = a <= b ? mouseSelectStart : end;
      term.select(first.col, first.row, Math.abs(b - a) + 1);
    };
    const onMouseUp = (e) => { if (mouseSelectStart) { e.stopPropagation(); mouseSelectStart = null; } };
    host.addEventListener('mousedown', onMouseDown, true);
    host.addEventListener('mousemove', onMouseMove, true);
    host.addEventListener('mouseup', onMouseUp, true);
    // Copia con FEEDBACK (Cmd+C Mac / Ctrl+Shift+C X11): non ci si affida solo a
    // attachCustomKeyEventHandler (async, senza feedback). Se c'e' selezione
    // locale, doCopy() copia con stato visibile (copiato / manuale) e blocchiamo
    // la propagazione (nessun ^C alla TUI). Senza selezione, il tasto passa.
    const onKeyCopy = (e) => {
      if (!isCopyShortcut(e)) return;
      const sel = apiRef.current && apiRef.current.term && apiRef.current.term.getSelection();
      if (!sel) return;
      e.preventDefault(); e.stopPropagation();
      if (doCopyRef.current) doCopyRef.current();
    };
    host.addEventListener('keydown', onKeyCopy, true);

    const onResize = () => { fit.fit(); sock.resize(term.cols, term.rows); };
    window.addEventListener('resize', onResize);
    // the soft keyboard opening/closing changes the visible height without firing
    // window 'resize' on some mobile browsers — track the visualViewport too.
    const vv = window.visualViewport;
    if (vv) { vv.addEventListener('resize', onResize); vv.addEventListener('scroll', onResize); }
    // Il tile può cambiare dimensione senza resize della finestra (altri tile,
    // divisori, preset, sidebar) → osserva l'host e rifitta (rAF debounce per i drag).
    let ro = null, rafId = 0;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(onResize);
      });
      ro.observe(host);
    }

    return () => {
      apiRef.current = null;
      if (sendRef) sendRef.current = () => false;
      if (composerRef) composerRef.current = () => false;
      if (actionRef) actionRef.current = () => false;
      onData.dispose();
      onSelection.dispose();
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('touchcancel', onTouchEnd);
      host.removeEventListener('contextmenu', onContextMenu, true);
      clearLongPress();
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('mousedown', onMouseDown, true);
      host.removeEventListener('mousemove', onMouseMove, true);
      host.removeEventListener('mouseup', onMouseUp, true);
      host.removeEventListener('keydown', onKeyCopy, true);
      host.removeEventListener('paste', onPasteFiles, true);
      host.removeEventListener('dragenter', onDragFiles, true);
      host.removeEventListener('dragover', onDragFiles, true);
      host.removeEventListener('drop', onDropFiles, true);
      window.removeEventListener('resize', onResize);
      if (vv) { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); }
      if (ro) ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      sock.close();
      term.dispose();
    };
  }, [session, node, token, readonly, takeSize, sendRef, composerRef, actionRef, ctrlRef, setCtrlArmed, onFiles]);

  return <div className={`nc-terminal${selectionMode ? ' selecting' : ''}`}>
    <div className="nc-terminal-host" ref={hostRef} />
    {uploadState && <div className={`nc-upload-state${uploadState.error ? ' error' : ''}`} role="status">
      {uploadState.error
        ? uploadState.error
        : uploadState.done
          ? t('attach-uploaded').replace('{n}', String(uploadState.total || 0))
          : t('attach-upload-progress').replace('{n}', String(uploadState.current || 0)).replace('{total}', String(uploadState.total || 0))}
    </div>}
    {(selection || selectionMode) && <div className="nc-selection-tools">
      {selection ? <button type="button" onClick={doCopy}>{copyState || t('copy')}</button> : <span>{t('select-drag')}</span>}
      <button type="button" onClick={() => { apiRef.current?.term?.clearSelection(); setSelection(''); onSelectionModeChange?.(false); }}>{t('cancel')}</button>
      {copyState === t('copy-manual') && <textarea readOnly value={selection} onFocus={(e) => e.target.select()} />}
    </div>}
  </div>;
}
