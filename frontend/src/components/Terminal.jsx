import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket } from '../lib/ws-client.js';
import { copyText } from '../lib/clipboard.js';
import { createComposerSubmitter } from '../lib/composer-input.js';
import { wantsLocalSelection, isCopyShortcut, LONG_PRESS_MS, movedBeyondLongPress } from '../lib/selection.js';
import { t } from '../lib/i18n.js';
import { filesFromTransfer, hasFilePayload, uploadSessionFiles } from '../lib/attachments.js';
import {
  setTerminalInputMode, showTerminalVirtualKeyboard, terminalTapDecision,
} from '../lib/virtual-keyboard.js';
import { chooseScrollMode, describeScrollActions, planTerminalScroll } from '../lib/terminal-scroll.js';
import './Terminal.css';

// node (opzionale): sessione su nodo remoto — il WS passa dal proxy
// /node/<name>/ws (B1); tutto il resto del protocollo e' identico.
export default function Terminal({ session, node, token, readonly, takeSize, focused, sendRef, composerRef, actionRef, ctrlRef, setCtrlArmed, onFiles, fontSize = 13, selectionMode = false, onSelectionModeChange, keyboardGesture = 'double-tap' }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);        // {term, fit, sock} per lo zoom senza riconnettere
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const selectionModeRef = useRef(selectionMode);
  selectionModeRef.current = selectionMode;
  const keyboardGestureRef = useRef(keyboardGesture);
  keyboardGestureRef.current = keyboardGesture;
  const [selection, setSelection] = useState('');
  const [copyState, setCopyState] = useState('');
  const [uploadState, setUploadState] = useState(null);
  // Maniglie di selezione touch (start/end): posizioni pixel relative all'host.
  // Sostituiscono il caret singolo: due maniglie draggable per affinare i bordi.
  const [touchHandles, setTouchHandles] = useState(null);
  const selBoundsRef = useRef(null);   // {start:{col,row}, end:{col,row}} bounds correnti
  const handleDragRef = useRef(null);  // 'start' | 'end' | null durante il drag di una maniglia
  // Lo snapshot puo' sopravvivere alla propria evidenziazione: xterm la butta
  // a ogni input verso l'applicazione e a ogni resize di righe (sul telefono
  // basta la tastiera virtuale). In quel caso il testo resta copiabile ma non
  // e' piu' mostrato, e chi guarda deve saperlo invece di dedurlo.
  const [selectionDetached, setSelectionDetached] = useState(false);

  const doCopy = async () => {
    const value = apiRef.current?.term?.getSelection() || selection;
    if (!value) { setCopyState(t('copy-empty')); setTimeout(() => setCopyState(''), 1500); return; }
    const ok = await copyText(value);
    setCopyState(ok ? t('copied') : t('copy-manual'));
    // Lo snapshot e' persistente per costruzione: solo copia e annulla lo
    // svuotano. Se una copia riuscita non lo facesse, la barra resterebbe su
    // per sempre offrendo di ricopiare un testo gia' preso.
    if (ok) { apiRef.current?.term?.clearSelection(); setSelection(''); setSelectionDetached(false); setTouchHandles(null); selBoundsRef.current = null; onSelectionModeChange?.(false); }
    setTimeout(() => setCopyState(''), 1800);
  };
  // doCopy cambia ad ogni render (closure su selection/lang): lo si tiene in un
  // ref cosi' i listener (keydown/mouse) registrati una volta nell'effect chiamano
  // sempre la versione fresca, senza dover re-iscrivere i listener.
  const doCopyRef = useRef(doCopy);
  doCopyRef.current = doCopy;

  // --- Maniglie di selezione touch (sostituiscono il caret) ------------------
  // cellAtClient: coord client -> {col, row} in coordinate buffer (lato componente,
  // per il drag delle maniglie che vivono fuori dal mount effect).
  const cellAtClient = (clientX, clientY) => {
    const api = apiRef.current; const host = hostRef.current; if (!api || !host) return null;
    const term = api.term;
    const screen = host.querySelector('.xterm-screen') || host;
    const r = screen.getBoundingClientRect();
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(((clientX - r.left) / Math.max(1, r.width)) * term.cols)));
    const visibleRow = Math.max(0, Math.min(term.rows - 1, Math.floor(((clientY - r.top) / Math.max(1, r.height)) * term.rows)));
    return { col, row: term.buffer.active.viewportY + visibleRow };
  };
  // Posiziona le due maniglie dai bounds correnti (selBoundsRef) + metriche cella.
  const positionHandles = () => {
    const api = apiRef.current; const host = hostRef.current; const b = selBoundsRef.current;
    if (!api || !host || !b) { setTouchHandles(null); return; }
    const term = api.term;
    const screen = host.querySelector('.xterm-screen') || host;
    const sr = screen.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const cellW = sr.width / Math.max(1, term.cols);
    const cellH = sr.height / Math.max(1, term.rows);
    const vpY = Number(term.buffer.active.viewportY) || 0;
    const px = (cell, atRight) => {
      const vr = Math.max(0, Math.min(term.rows - 1, cell.row - vpY));
      return {
        left: (sr.left - hostRect.left) + (atRight ? (cell.col + 1) : cell.col) * cellW,
        top: (sr.top - hostRect.top) + (vr + 1) * cellH,
      };
    };
    setTouchHandles({ start: px(b.start, false), end: px(b.end, true) });
  };
  const positionHandlesRef = useRef(positionHandles); positionHandlesRef.current = positionHandles;
  // Drag di una maniglia: sposta solo quel bordo, l'altro resta (touch-action:none
  // sullo handle basta a fermare lo scroll; i listener React sono passive).
  // --- Barra zoom (linea selezionata ingrandita, in alto) -------------------
  // Mostra la riga under selection a 2x con la porzione selezionata evidenziata,
  // cosi' l'operatore vede cosa sta selezionando senza lente sul dito. Aggiornata
  // a ogni cambio selezione (onSelectionChange copre tutti i path touch).
  const [zoomLine, setZoomLine] = useState(null);
  const zoomFocusRef = useRef('start');  // quale maniglia sta guidando la barra zoom
  const updateZoomLine = () => {
    const b = selBoundsRef.current; const api = apiRef.current;
    if (!b || !api || !selectionModeRef.current) { setZoomLine(null); return; }
    const term = api.term;
    const side = zoomFocusRef.current || 'start';
    const row = b[side].row;
    const line = term.buffer.active.getLine(row);
    const text = line ? line.translateToString(true) : '';
    // Porzione selezionata sulla riga della maniglia in focus.
    let s, e;
    if (b.start.row === b.end.row) { s = b.start.col; e = b.end.col; }
    else if (row === b.start.row) { s = b.start.col; e = text.length - 1; }
    else if (row === b.end.row) { s = 0; e = b.end.col; }
    else { s = 0; e = text.length - 1; }
    s = Math.max(0, Math.min(text.length - 1, s));
    e = Math.max(s, Math.min(text.length - 1, e));
    setZoomLine({ before: text.slice(0, s), sel: text.slice(s, e + 1), after: text.slice(e + 1) });
  };
  const updateZoomLineRef = useRef(updateZoomLine); updateZoomLineRef.current = updateZoomLine;
  // Drag di una maniglia: sposta solo quel bordo, l'altro resta (touch-action:none
  // sullo handle basta a fermare lo scroll; i listener React sono passive).
  const onHandleTouchStart = (side) => (e) => { e.stopPropagation(); handleDragRef.current = side; zoomFocusRef.current = side; };
  const onHandleTouchMove = (side) => (e) => {
    if (handleDragRef.current !== side) return;
    const api = apiRef.current; if (!api || e.touches.length !== 1) return;
    const term = api.term;
    const cell = cellAtClient(e.touches[0].clientX, e.touches[0].clientY); if (!cell) return;
    const b = selBoundsRef.current; if (!b) return;
    const other = side === 'start' ? b.end : b.start;
    const a = side === 'start' ? cell : other, c = side === 'start' ? other : cell;
    const ai = a.row * term.cols + a.col, ci = c.row * term.cols + c.col;
    const lo = ai <= ci ? a : c, hi = ai <= ci ? c : a;
    term.select(lo.col, lo.row, Math.abs(ci - ai) + 1);
    selBoundsRef.current = { start: lo, end: hi };
    positionHandles();
  };
  const onHandleTouchEnd = () => { handleDragRef.current = null; };

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

  // Cambiare la preferenza client non deve rimontare xterm né riconnettere il
  // websocket: aggiorna soltanto la policy della textarea interna già viva.
  useEffect(() => {
    apiRef.current?.setKeyboardGesture?.(keyboardGesture);
  }, [keyboardGesture]);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true, fontSize: fontSizeRef.current, scrollback: 1000,
      theme: { background: '#0a0e0a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    // xterm espone la modalita' di tracking del mouse ma NON la codifica, e
    // mandare un report SGR a un'app che ha negoziato la codifica legacy le
    // consegnerebbe byte che non sa decodificare. La 1006 si osserva quindi
    // sul filo: l'handler restituisce false, quindi il parser continua a
    // processare la sequenza normalmente e non le viene sottratto nulla.
    let sgrMouseEncoding = false;   // DECSET 1006: coordinate in celle
    let sgrPixelEncoding = false;   // DECSET 1016: coordinate in PIXEL
    const trackEncoding = (enabled) => (params) => {
      for (const param of params) {
        const code = Array.isArray(param) ? param[0] : param;
        if (code === 1006) sgrMouseEncoding = enabled;
        if (code === 1016) sgrPixelEncoding = enabled;
      }
      return false;
    };
    // Se il parser non fosse disponibile la rilevazione resta spenta e il
    // gesto continua a navigare la storia tmux: degrado sicuro, mai input PTY
    // basato su un'ipotesi.
    term.parser?.registerCsiHandler?.({ prefix: '?', final: 'h' }, trackEncoding(true));
    term.parser?.registerCsiHandler?.({ prefix: '?', final: 'l' }, trackEncoding(false));
    // RIS (ESC c) azzera il terminale, encoding incluso. Senza questo la
    // nostra copia dello stato resterebbe "SGR attivo" dopo un reset e
    // manderemmo report SGR a un'applicazione tornata alla codifica legacy.
    // Stessa ragione per 1016: le coordinate diventano pixel, e le nostre
    // sono celle — in quel caso si torna allo scorrimento server-side invece
    // di inviare numeri che significano un'altra cosa.
    term.parser?.registerEscHandler?.({ final: 'c' }, () => {
      sgrMouseEncoding = false;
      sgrPixelEncoding = false;
      return false;
    });
    // La precondizione di tutta la protezione della selezione, resa OSSERVABILE.
    // Vive nell'istanza xterm e dal DOM non si vede: senza questo, una prova nel
    // browser non puo' distinguere «la selezione e' sopravvissuta perche' la
    // proteggiamo» da «e' sopravvissuta perche' non c'era niente da cui
    // proteggerla» — cioe' un verde per la ragione sbagliata. Non e' uno stato
    // sensibile: e' una modalita' del terminale.
    const mouseTrackingActive = () => {
      const attivo = sgrMouseEncoding && !sgrPixelEncoding
        && ((term.modes && term.modes.mouseTrackingMode) || 'none') !== 'none';
      const host = hostRef.current;
      if (host) host.dataset.mouseTracking = attivo ? 'on' : 'off';
      return attivo;
    };
    const dec = new TextDecoder();

    let keyboardUnlocked = keyboardGestureRef.current === 'single-tap';
    let lastTerminalTap = null;
    const lockTerminalKeyboard = () => {
      keyboardUnlocked = keyboardGestureRef.current === 'single-tap';
      setTerminalInputMode(term, keyboardGestureRef.current, keyboardUnlocked);
    };
    const setKeyboardGesture = (next) => {
      keyboardGestureRef.current = next;
      lastTerminalTap = null;
      lockTerminalKeyboard();
    };
    const requestTerminalKeyboard = () => {
      if (keyboardGestureRef.current === 'never') return false;
      keyboardUnlocked = true;
      return showTerminalVirtualKeyboard(term);
    };
    lockTerminalKeyboard();
    const terminalTextarea = term.textarea;
    const onTerminalTextareaBlur = () => {
      if (keyboardGestureRef.current === 'double-tap') lockTerminalKeyboard();
    };
    terminalTextarea?.addEventListener('blur', onTerminalTextareaBlur);

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
    apiRef.current = { term, fit, sock, setKeyboardGesture };

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
    // xterm butta via la selezione a ogni input diretto all'applicazione
    // (`onUserInput`): un tasto qualsiasi, e con il mouse tracking attivo anche
    // un solo click, perche' diventa un report SGR verso la TUI. Sul percorso
    // desktop questo significa che dopo aver selezionato con Shift basta
    // rilasciare Shift e cliccare per restare senza nulla da copiare, prima
    // ancora che il pulsante venga premuto. Anche un resize di righe la
    // cancella, quindi sul telefono la fa sparire la tastiera virtuale.
    //
    // Lo snapshot locale sopravvive a tutto questo: si aggiorna solo quando c'e'
    // davvero qualcosa di nuovo selezionato, e si svuota soltanto quando
    // l'operatore agisce — copia o annulla. Il riquadro giallo puo' sparire
    // (e' di xterm, non nostro), il testo da copiare no.
    const onSelection = term.onSelectionChange(() => {
      const next = term.getSelection();
      if (next) { setSelection(next); setSelectionDetached(false); }
      else { setSelectionDetached(true); selBoundsRef.current = null; setTouchHandles(null); }
      updateZoomLineRef.current?.();
    });
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
    const STEP = 24; // px per tick di scroll (3 righe tmux)
    // Coordinata di cella 1-based RELATIVA AL VIEWPORT: e' quella che vuole un
    // report SGR, diversa da cellXY() che restituisce la riga assoluta nel
    // buffer (viewportY + riga visibile) per la selezione.
    const viewportCell = (clientX, clientY) => {
      const screen = host.querySelector('.xterm-screen') || host;
      const r = screen.getBoundingClientRect();
      const col = Math.floor(((clientX - r.left) / Math.max(1, r.width)) * term.cols) + 1;
      const row = Math.floor(((clientY - r.top) / Math.max(1, r.height)) * term.rows) + 1;
      return {
        col: Math.max(1, Math.min(term.cols, col)),
        row: Math.max(1, Math.min(term.rows, row)),
      };
    };
    const emitScroll = (delta, previous = { mode: null, remainder: 0 }, modeOverride = null, position = null) => {
      // Tre destinazioni possibili. Se l'applicazione ha abilitato il mouse
      // tracking con codifica SGR possiede il proprio scorrimento e il gesto
      // deve arrivare a lei; altrimenti una TUI alternate-screen scrivibile
      // riceve PageUp/PageDown, e in tutti gli altri casi si naviga la storia
      // tmux server-side.
      // Convention: accumulated > 0 = scroll up (older), < 0 = scroll down.
      const host = hostRef.current;
      const pageThreshold = host ? host.getBoundingClientRect().height : STEP;
      const base = chooseScrollMode({
        alternateScreen: term.buffer.active.type === 'alternate',
        readonly,
        mouseTracking: mouseTrackingActive(),
      });
      // L'override del percorso touch puo' scegliere solo fra le modalita'
      // server-side: quando l'app possiede la rotella, dito E rotella devono
      // raggiungerla entrambi, altrimenti il gesto sfoglia una scrollback che
      // quell'app non ha mai scritto come log (fotogrammi di ridisegno).
      const mode = base === 'mouse' ? 'mouse' : (modeOverride || base);
      // A page-sized remainder from the alternate buffer must never be
      // reinterpreted as many 24px line ticks after xterm returns to normal.
      const accumulated = previous.mode === mode ? previous.remainder + delta : delta;
      const plan = planTerminalScroll({ mode, accumulated, threshold: mode === 'page' ? pageThreshold : STEP });
      for (const act of describeScrollActions(plan, position)) {
        if (act.kind === 'input') sock.sendInput(act.seq);
        else sock.action(act.name);
      }
      return { mode, remainder: plan.remainder };
    };
    let touchY = null, touchX = null, tapX = null, tapY = null;
    let touchMoved = false, multiTouchActive = false;
    let touchScroll = { mode: null, remainder: 0 }, vertical = null, selectStart = null;
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
    // Selezione iniziale touch ~1cm orizzontale ESATTAMENTE sul punto premuto:
    // le due maniglie sono gia' distanziate di ~1cm, centrate sul dito. Niente
    // offset di riga: la selezione parte dove si preme.
    const beginTouchSelection = (clientX, clientY) => {
      const press = cellXY(clientX, clientY);
      const row = press.row;
      const screen = host.querySelector('.xterm-screen') || host;
      const sr = screen.getBoundingClientRect();
      const cellW = sr.width / Math.max(1, term.cols);
      const half = Math.max(1, Math.round(37.8 / cellW / 2)); // ~1cm (37.8px CSS)
      const startCol = Math.max(0, press.col - half);
      const endCol = Math.min(term.cols - 1, press.col + half);
      selectStart = { col: startCol, row };
      term.clearSelection();
      term.select(startCol, row, endCol - startCol + 1);
      selBoundsRef.current = { start: { col: startCol, row }, end: { col: endCol, row } };
      zoomFocusRef.current = 'start';
      positionHandlesRef.current();
    };
    const onTouchStart = (e) => {
      clearLongPress(); touchSelecting = false; touchMoved = false;
      if (multiTouchActive || e.touches.length !== 1) {
        // Multi-touch (pinch / due dita): invalida il candidato doppio tap e
        // sopprimi tutti i touchend finche' ogni dito non e' stato rilasciato.
        // Altrimenti il secondo rilascio potrebbe diventare un nuovo candidato.
        multiTouchActive = true; touchMoved = true; lastTerminalTap = null;
        // Se un secondo dito arriva durante una selezione long-press, le
        // maniglie non descrivono piu' un punto attivo del gesto: nascondile
        // subito, senza alterare la selezione gia' confermata.
        setTouchHandles(null); selBoundsRef.current = null;
        touchY = null; touchX = null; tapX = null; tapY = null;
        return;
      }
      if (selectionModeRef.current) {
        e.preventDefault(); e.stopPropagation();
        // Re-tocco con selezione attiva: ri-ancora una nuova selezione ~1cm
        // esattamente sul dito e mostra la lente di zoom.
        beginTouchSelection(e.touches[0].clientX, e.touches[0].clientY);
        return;
      }
      touchY = e.touches[0].clientY; touchX = e.touches[0].clientX;
      tapX = touchX; tapY = touchY; touchScroll = { mode: null, remainder: 0 }; vertical = null;
      const start = { x: touchX, y: touchY };
      longPressTimer = setTimeout(() => {
        longPressTimer = null; touchSelecting = true; touchMoved = true; lastTerminalTap = null;
        selectionModeRef.current = true;
        onSelectionModeChange?.(true);
        beginTouchSelection(start.x, start.y);
        try { navigator.vibrate?.(10); } catch (_) {}
        // Da questo momento il gesto e' selezione, non scroll.
        touchY = null; touchX = null; vertical = null; touchScroll = { mode: null, remainder: 0 };
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e) => {
      // Estende il bordo mobile (end) della selezione touch: l'ancora e'
      // selectStart, il dito trascina l'altro bordo al punto esatto del dito.
      const extendEnd = () => {
        const end = cellAt(e.touches[0]);
        const a = selectStart.row * term.cols + selectStart.col;
        const b = end.row * term.cols + end.col;
        const lo = a <= b ? selectStart : end, hi = a <= b ? end : selectStart;
        term.select(lo.col, lo.row, Math.abs(b - a) + 1);
        selBoundsRef.current = { start: lo, end: hi };
        zoomFocusRef.current = (a <= b) ? 'end' : 'start'; // la maniglia che segue il dito
        positionHandlesRef.current();
      };
      if (touchSelecting && selectStart && e.touches.length === 1) {
        e.preventDefault(); e.stopPropagation(); extendEnd(); return;
      }
      if (selectionModeRef.current && selectStart && e.touches.length === 1) {
        e.preventDefault(); e.stopPropagation(); extendEnd(); return;
      }
      if (touchY === null || e.touches.length !== 1) return;
      // preventDefault SUBITO, non dopo la soglia: al primo touchmove il
      // browser decide tra native scroll e JS — se non blocchi qui, parte il
      // pan nativo e i preventDefault successivi vengono ignorati.
      e.preventDefault(); e.stopPropagation();
      const t = e.touches[0];
      if (movedBeyondLongPress(tapX, tapY, t.clientX, t.clientY)) {
        touchMoved = true; lastTerminalTap = null;
        if (longPressTimer) clearLongPress();
      }
      if (vertical === null && (Math.abs(t.clientY - touchY) > 8 || Math.abs(t.clientX - touchX) > 8)) {
        vertical = Math.abs(t.clientY - touchY) > Math.abs(t.clientX - touchX);
      }
      if (!vertical) return;
      const delta = t.clientY - touchY; touchY = t.clientY;
      // Il dito naviga la storia tmux, anche quando l'app rende attraverso il
      // buffer alternato: dito verso il basso = piu' vecchio. L'unica
      // eccezione e' un'app che possiede la rotella (mouse tracking SGR): li'
      // il gesto deve arrivare all'app, che ha il proprio scorrimento.
      touchScroll = emitScroll(delta, touchScroll, 'scroll', viewportCell(t.clientX, t.clientY));
    };
    const resetTouch = () => {
      clearLongPress(); touchY = null; touchX = null; tapX = null; tapY = null;
      selectStart = null; touchSelecting = false; touchMoved = false; multiTouchActive = false;
      touchScroll = { mode: null, remainder: 0 };
    };
    const onTouchEnd = (e) => {
      if (multiTouchActive) {
        lastTerminalTap = null;
        clearLongPress();
        if (!e.touches || e.touches.length === 0) resetTouch();
        return;
      }
      const changed = e.changedTouches && e.changedTouches[0];
      if (!touchMoved && !touchSelecting && !selectionModeRef.current && changed) {
        const point = { at: Date.now(), x: changed.clientX, y: changed.clientY };
        const decision = terminalTapDecision(keyboardGestureRef.current, lastTerminalTap, point);
        lastTerminalTap = decision.next;
        if (decision.open) requestTerminalKeyboard();
      }
      resetTouch();
    };
    const onTouchCancel = () => { lastTerminalTap = null; resetTouch(); };
    let wheelScroll = { mode: null, remainder: 0 };
    const onWheel = (e) => {
      e.preventDefault(); e.stopPropagation();
      // wheel: deltaY > 0 = scroll down (newer) -> negative in the up-positive convention
      // Come il dito, la rotella naviga la storia tmux anche in una TUI
      // alternate-screen scrivibile e con Shift premuto — salvo quando l'app
      // ha abilitato il mouse tracking SGR, nel qual caso e' sua.
      wheelScroll = emitScroll(-e.deltaY, wheelScroll, 'scroll', viewportCell(e.clientX, e.clientY));
    };
    host.addEventListener('touchstart', onTouchStart, { passive: false });
    host.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('touchcancel', onTouchCancel, { passive: true });
    const onDoubleClick = () => {
      if (!selectionModeRef.current && keyboardGestureRef.current === 'double-tap') requestTerminalKeyboard();
    };
    host.addEventListener('dblclick', onDoubleClick);
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
      if (!mouseSelectStart) {
        // Finito il trascinamento smettevamo di proteggere il gesto proprio nel
        // momento in cui serve muoversi per copiare. Un'applicazione che accende
        // il tracking di OGNI movimento (Claude Code lo fa: DECSET 1003) riceve
        // lo spostamento del puntatore come input, e xterm butta la selezione a
        // ogni input. Risultato: la selezione moriva mentre il puntatore andava
        // verso il pulsante Copia, e restava copiabile solo senza muovere il
        // mouse, cioe' solo con la scorciatoia da tastiera.
        //
        // Finche' una selezione locale e' viva, il movimento non la raggiunge.
        // Non e' una modalita' nuova e non serve uscirne a mano: un click senza
        // Shift passa (onMouseDown esce subito), arriva all'applicazione e la
        // selezione se ne va da sola, che e' il modo naturale di annullarla.
        if (term.hasSelection?.() && mouseTrackingActive()) {
          e.preventDefault(); e.stopPropagation();
        }
        return;
      }
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

    const onResize = () => { fit.fit(); sock.resize(term.cols, term.rows); if (selectionModeRef.current) positionHandlesRef.current(); };
    window.addEventListener('resize', onResize);
    // the soft keyboard opening/closing changes the visible height without firing
    // window 'resize' on some mobile browsers — track the visualViewport too.
    const vv = window.visualViewport;
    let previousViewportHeight = vv && Number(vv.height);
    const onViewportResize = () => {
      const nextHeight = vv && Number(vv.height);
      // Fallback per browser senza geometrychange: quando il viewport torna
      // alto dopo la chiusura IME, il prossimo tap richiede di nuovo il doppio.
      if (keyboardUnlocked && keyboardGestureRef.current === 'double-tap'
        && Number.isFinite(previousViewportHeight) && Number.isFinite(nextHeight)
        && nextHeight > previousViewportHeight + 80) lockTerminalKeyboard();
      previousViewportHeight = nextHeight;
      onResize();
    };
    if (vv) { vv.addEventListener('resize', onViewportResize); vv.addEventListener('scroll', onResize); }
    const virtualKeyboard = typeof navigator !== 'undefined' ? navigator.virtualKeyboard : null;
    const onKeyboardGeometry = () => {
      if (keyboardUnlocked && keyboardGestureRef.current === 'double-tap'
        && Number(virtualKeyboard?.boundingRect?.height || 0) === 0) lockTerminalKeyboard();
    };
    virtualKeyboard?.addEventListener?.('geometrychange', onKeyboardGeometry);
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
      host.removeEventListener('touchcancel', onTouchCancel);
      host.removeEventListener('dblclick', onDoubleClick);
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
      if (vv) { vv.removeEventListener('resize', onViewportResize); vv.removeEventListener('scroll', onResize); }
      virtualKeyboard?.removeEventListener?.('geometrychange', onKeyboardGeometry);
      terminalTextarea?.removeEventListener('blur', onTerminalTextareaBlur);
      if (ro) ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      sock.close();
      term.dispose();
    };
  }, [session, node, token, readonly, takeSize, sendRef, composerRef, actionRef, ctrlRef, setCtrlArmed, onFiles]);

  return <div className={`nc-terminal${selectionMode ? ' selecting' : ''}`}>
    <div className="nc-terminal-host" ref={hostRef} />
    {touchHandles && <>
      <div className="nc-handle nc-handle-start" style={{ left: `${touchHandles.start.left}px`, top: `${touchHandles.start.top}px` }}
        onTouchStart={onHandleTouchStart('start')} onTouchMove={onHandleTouchMove('start')} onTouchEnd={onHandleTouchEnd} onTouchCancel={onHandleTouchEnd} aria-hidden="true" />
      <div className="nc-handle nc-handle-end" style={{ left: `${touchHandles.end.left}px`, top: `${touchHandles.end.top}px` }}
        onTouchStart={onHandleTouchStart('end')} onTouchMove={onHandleTouchMove('end')} onTouchEnd={onHandleTouchEnd} onTouchCancel={onHandleTouchEnd} aria-hidden="true" />
    </>}
    {selectionMode && zoomLine && <div className="nc-zoom-bar" aria-hidden="true">
      <pre className="nc-zoom-line"><span>{zoomLine.before}</span><span className="nc-zoom-sel">{zoomLine.sel}</span><span>{zoomLine.after}</span></pre>
    </div>}
    {uploadState && <div className={`nc-upload-state${uploadState.error ? ' error' : ''}`} role="status">
      {uploadState.error
        ? uploadState.error
        : uploadState.done
          ? t('attach-uploaded').replace('{n}', String(uploadState.total || 0))
          : t('attach-upload-progress').replace('{n}', String(uploadState.current || 0)).replace('{total}', String(uploadState.total || 0))}
    </div>}
    {(selection || selectionMode) && <div className="nc-selection-tools">
      {selection ? <button type="button" onClick={doCopy}>{copyState || t('copy')}</button> : <span>{t('select-drag')}</span>}
      {selection && selectionDetached && <span className="nc-selection-held">{t('selection-held')}</span>}
      <button type="button" onClick={() => { apiRef.current?.term?.clearSelection(); setSelection(''); setSelectionDetached(false); setTouchHandles(null); selBoundsRef.current = null; onSelectionModeChange?.(false); }}>{t('cancel')}</button>
      {copyState === t('copy-manual') && <textarea readOnly value={selection} onFocus={(e) => e.target.select()} />}
    </div>}
  </div>;
}
