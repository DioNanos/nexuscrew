import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket } from '../lib/ws-client.js';
import { copyText } from '../lib/clipboard.js';
import { createComposerSubmitter } from '../lib/composer-input.js';
import { wantsLocalSelection, isCopyShortcut, LONG_PRESS_MS, movedBeyondLongPress } from '../lib/selection.js';
import {
  clampDraggedCell, edgeScrollDirection, handlePositions, normalizeRange,
  rangeFromXterm, rangeToSelect,
} from '../lib/selection-handles.js';
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
  const [touchSelectionCaret, setTouchSelectionCaret] = useState(null);
  // Lo snapshot puo' sopravvivere alla propria evidenziazione: xterm la butta
  // a ogni input verso l'applicazione e a ogni resize di righe (sul telefono
  // basta la tastiera virtuale). In quel caso il testo resta copiabile ma non
  // e' piu' mostrato, e chi guarda deve saperlo invece di dedurlo.
  const [selectionDetached, setSelectionDetached] = useState(false);
  // R25 — due maniglie trascinabili SOPRA la selezione di xterm. La verita'
  // del range vive nel buffer di xterm; questi stati sono solo la vista:
  // selRange = l'ultimo range che xterm ha restituito, handleGeom le sue
  // coordinate px, geomTick forza il ricalcolo quando cambia il viewport o
  // arriva un redraw ma il range no.
  const [selRange, setSelRange] = useState(null);
  const [handleGeom, setHandleGeom] = useState(null);
  const [geomTick, setGeomTick] = useState(0);
  const [draggingHandle, setDraggingHandle] = useState(null);
  // Il testo SOTTO una selezione attiva puo' essere sovrascritto (una
  // progress bar che riscrive la riga, un redraw dell'app): la copia
  // consegnerebbe il testo nuovo mentre chi guarda ha in mente quello
  // vecchio. Snapshot PER RIGA all'ultimo cambiamento di selezione: il
  // confronto a ogni render legge SOLO le righe renderizzate che intersecano
  // la selezione (il range arriva dall'evento onRender), mai la selezione
  // intera — il costo non deve crescere con la lunghezza della selezione,
  // perche' il caso che morde e' proprio una selezione lunga mentre la cella
  // produce output.
  const selectionSnapshotRef = useRef(null);
  const [selectionChanged, setSelectionChanged] = useState(false);

  const doCopy = async () => {
    const value = apiRef.current?.term?.getSelection() || selection;
    if (!value) { setCopyState(t('copy-empty')); setTimeout(() => setCopyState(''), 1500); return; }
    const ok = await copyText(value);
    setCopyState(ok ? t('copied') : t('copy-manual'));
    // Lo snapshot e' persistente per costruzione: solo copia e annulla lo
    // svuotano. Se una copia riuscita non lo facesse, la barra resterebbe su
    // per sempre offrendo di ricopiare un testo gia' preso.
    if (ok) { apiRef.current?.term?.clearSelection(); setSelection(''); setSelectionDetached(false); onSelectionModeChange?.(false); }
    setTimeout(() => setCopyState(''), 1800);
  };
  // doCopy cambia ad ogni render (closure su selection/lang): lo si tiene in un
  // ref cosi' i listener (keydown/mouse) registrati una volta nell'effect chiamano
  // sempre la versione fresca, senza dover re-iscrivere i listener.
  const doCopyRef = useRef(doCopy);
  doCopyRef.current = doCopy;
  // R25: il drag delle maniglie vive nell'effect grande (dove stanno cellXY e
  // l'offset touch); il ponte espone startHandleDrag ai div renderizzati.
  const handleDragApiRef = useRef({ startHandleDrag: () => {} });
  const handleGeomRef = useRef(null);
  handleGeomRef.current = handleGeom;

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
      else setSelectionDetached(true);
      // R25: le maniglie seguono la selezione — il range si rilegge a ogni
      // cambiamento (gesto nostro o no); lo snapshot per riga e' la base del
      // confronto per il contenuto sovrascritto sotto il range.
      const range = rangeFromXterm(term.getSelectionPosition());
      setSelRange(range);
      let snap = null;
      if (range && typeof term.buffer.active.getLine === 'function') {
        const lines = [];
        for (let y = range.start.row; y <= range.end.row; y++) {
          const line = term.buffer.active.getLine(y);
          lines.push(line ? line.translateToString() : '');
        }
        snap = { startRow: range.start.row, endRow: range.end.row, lines };
      }
      selectionSnapshotRef.current = snap;
      setSelectionChanged(false);
    });
    // R25: le maniglie si ri-derivano a OGNI redraw e a OGNI scroll — i loro
    // pixel dipendono dal viewport, il range no. Nessuna posizione viene mai
    // ricordata: sempre ricalcolata dal range. E' cosi' che sopravvivono ai
    // ridisegni senza andare alla deriva. Allo stesso battito si confronta il
    // testo vivo con lo snapshot: se il contenuto sotto il range e' cambiato
    // senza un gesto, si segnala (la copia darebbe il testo nuovo).
    const onRender = term.onRender((rendered) => {
      if (term.hasSelection?.()) {
        // Il range dell'evento e' in righe VIEWPORT (0..rows-1, lo dice la
        // doc di xterm e lo conferma chi lo consuma dentro xterm indicizzando
        // il buffer con ydisp+riga): si converte in righe assolute e si
        // confrontano SOLO le righe renderizzate che intersecano la
        // selezione. L'output che passa altrove non tocca la selezione.
        const snap = selectionSnapshotRef.current;
        const start = rendered && rendered.start;
        const end = rendered && rendered.end;
        if (snap && Number.isInteger(start) && Number.isInteger(end)
          && typeof term.buffer.active.getLine === 'function') {
          const viewportY = Number(term.buffer.active.viewportY) || 0;
          const lo = Math.max(viewportY + start, snap.startRow);
          const hi = Math.min(viewportY + end, snap.endRow);
          for (let y = lo; y <= hi; y++) {
            const line = term.buffer.active.getLine(y);
            const now = line ? line.translateToString() : '';
            if (now !== snap.lines[y - snap.startRow]) { setSelectionChanged(true); break; }
          }
        }
        setGeomTick((v) => v + 1);
      }
    });
    const onScrollViewport = term.onScroll(() => {
      if (term.hasSelection?.()) setGeomTick((v) => v + 1);
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
    let longPressTimer = null; let touchSelecting = false; let touchSelectionOffsetRows = 0;
    const clearLongPress = () => { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = null; };
    const cellXY = (clientX, clientY) => {
      const screen = host.querySelector('.xterm-screen') || host;
      const r = screen.getBoundingClientRect();
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor(((clientX - r.left) / Math.max(1, r.width)) * term.cols)));
      const visibleRow = Math.max(0, Math.min(term.rows - 1, Math.floor(((clientY - r.top) / Math.max(1, r.height)) * term.rows)));
      return { col, row: term.buffer.active.viewportY + visibleRow };
    };
    const cellAt = (touch) => cellXY(touch.clientX, touch.clientY);
    const TOUCH_SELECTION_OFFSET_ROWS = 2;
    const touchSelectionOffsetFor = (clientY) => {
      const screen = host.querySelector('.xterm-screen') || host;
      const r = screen.getBoundingClientRect();
      const visibleRow = Math.max(0, Math.min(term.rows - 1,
        Math.floor(((clientY - r.top) / Math.max(1, r.height)) * term.rows)));
      return visibleRow < TOUCH_SELECTION_OFFSET_ROWS
        ? TOUCH_SELECTION_OFFSET_ROWS
        : -TOUCH_SELECTION_OFFSET_ROWS;
    };
    const touchSelectionCellAt = (touch, offsetRows) => {
      const screen = host.querySelector('.xterm-screen') || host;
      const r = screen.getBoundingClientRect();
      const rowHeight = r.height / Math.max(1, term.rows);
      return cellXY(touch.clientX, touch.clientY + offsetRows * rowHeight);
    };
    const showTouchSelectionCaret = (cell) => {
      const screen = host.querySelector('.xterm-screen') || host;
      const screenRect = screen.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const cellWidth = screenRect.width / Math.max(1, term.cols);
      const cellHeight = screenRect.height / Math.max(1, term.rows);
      const viewportY = Number(term.buffer.active.viewportY) || 0;
      const visibleRow = Math.max(0, Math.min(term.rows - 1, cell.row - viewportY));
      setTouchSelectionCaret({
        left: `${screenRect.left - hostRect.left + cell.col * cellWidth}px`,
        top: `${screenRect.top - hostRect.top + visibleRow * cellHeight}px`,
        width: `${cellWidth}px`,
        height: `${cellHeight}px`,
      });
    };
    const onTouchStart = (e) => {
      clearLongPress(); touchSelecting = false; touchMoved = false;
      if (multiTouchActive || e.touches.length !== 1) {
        // Multi-touch (pinch / due dita): invalida il candidato doppio tap e
        // sopprimi tutti i touchend finche' ogni dito non e' stato rilasciato.
        // Altrimenti il secondo rilascio potrebbe diventare un nuovo candidato.
        multiTouchActive = true; touchMoved = true; lastTerminalTap = null;
        // Se un secondo dito arriva durante una selezione long-press, il caret
        // non descrive piu' un punto attivo del gesto: nascondilo subito,
        // senza alterare la selezione gia' confermata.
        setTouchSelectionCaret(null); touchSelectionOffsetRows = 0;
        touchY = null; touchX = null; tapX = null; tapY = null;
        return;
      }
      if (selectionModeRef.current) {
        e.preventDefault(); e.stopPropagation();
        // Stesso trattamento del long-press: il punto di lavoro sta sopra il
        // dito, non sotto. Finora questo ramo — quello che si percorre col
        // tasto SELECT e a ogni tocco successivo — usava la cella coperta dal
        // polpastrello, cioe' l'unica che non si vede mentre la si sceglie.
        touchSelectionOffsetRows = touchSelectionOffsetFor(e.touches[0].clientY);
        selectStart = touchSelectionCellAt(e.touches[0], touchSelectionOffsetRows);
        term.clearSelection();
        showTouchSelectionCaret(selectStart);
        return;
      }
      touchY = e.touches[0].clientY; touchX = e.touches[0].clientX;
      tapX = touchX; tapY = touchY; touchScroll = { mode: null, remainder: 0 }; vertical = null;
      const start = { x: touchX, y: touchY };
      longPressTimer = setTimeout(() => {
        longPressTimer = null; touchSelecting = true; touchMoved = true; lastTerminalTap = null;
        selectionModeRef.current = true;
        onSelectionModeChange?.(true);
        selectStart = cellXY(start.x, start.y);
        touchSelectionOffsetRows = touchSelectionOffsetFor(start.y);
        const end = touchSelectionCellAt({ clientX: start.x, clientY: start.y }, touchSelectionOffsetRows);
        term.clearSelection();
        const a = selectStart.row * term.cols + selectStart.col;
        const b = end.row * term.cols + end.col;
        const first = a <= b ? selectStart : end;
        term.select(first.col, first.row, Math.abs(b - a) + 1);
        showTouchSelectionCaret(end);
        try { navigator.vibrate?.(10); } catch (_) {}
        // Da questo momento il gesto e' selezione, non scroll.
        touchY = null; touchX = null; vertical = null; touchScroll = { mode: null, remainder: 0 };
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e) => {
      if (touchSelecting && selectStart && e.touches.length === 1) {
        e.preventDefault(); e.stopPropagation();
        const end = touchSelectionCellAt(e.touches[0], touchSelectionOffsetRows);
        const a = selectStart.row * term.cols + selectStart.col;
        const b = end.row * term.cols + end.col;
        const first = a <= b ? selectStart : end;
        term.select(first.col, first.row, Math.abs(b - a) + 1);
        showTouchSelectionCaret(end);
        return;
      }
      if (selectionModeRef.current && selectStart && e.touches.length === 1) {
        e.preventDefault(); e.stopPropagation();
        const end = touchSelectionCellAt(e.touches[0], touchSelectionOffsetRows);
        const a = selectStart.row * term.cols + selectStart.col;
        const b = end.row * term.cols + end.col;
        const first = a <= b ? selectStart : end;
        term.select(first.col, first.row, Math.abs(b - a) + 1);
        showTouchSelectionCaret(end);
        return;
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
      touchSelectionOffsetRows = 0; setTouchSelectionCaret(null);
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

    // R25 — il drag delle DUE maniglie. Il gesto e' quello di Termux portato
    // nel browser: offset RELATIVO (al tocco si registra il delta fra dito e
    // maniglia, il movimento applica il delta: niente salto alla presa, il
    // dito non deve centrare l'ancora), le maniglie NON si incrociano, il
    // dito oltre il bordo fa scorrere il terminale. La selezione resta tutta
    // di xterm: qui si chiede solo un nuovo range a term.select().
    let handleDrag = null;         // { which, offsetX, offsetY }
    let handleEdgeTimer = null;
    let lastHandlePointer = { x: 0, y: 0, type: 'touch' };
    const stopHandleEdgeScroll = () => {
      if (handleEdgeTimer) { clearInterval(handleEdgeTimer); handleEdgeTimer = null; }
    };
    const applyHandlePoint = (px, py, pointerType) => {
      if (!handleDrag) return;
      const range = rangeFromXterm(term.getSelectionPosition());
      if (!range) return;
      const fixed = handleDrag.which === 'start' ? range.end : range.start;
      // Su touch il dito COPRE il punto: la cella di lavoro sta ±2 righe piu'
      // in la', lo stesso offset del long-press. Il mouse ha il cursore
      // preciso: niente offset.
      const cell = pointerType === 'mouse'
        ? cellXY(px, py)
        : touchSelectionCellAt({ clientX: px, clientY: py }, touchSelectionOffsetFor(py));
      const maxRow = Math.max(0, Number(term.buffer.active.baseY || 0) + term.rows - 1);
      const moved = clampDraggedCell({ moving: cell, fixed, which: handleDrag.which, cols: term.cols, maxRow });
      const sel = rangeToSelect(normalizeRange(moved, fixed, term.cols), term.cols);
      term.select(sel.col, sel.row, sel.length);
      // Bordo: la maniglia sulla prima/ultima riga visibile fa scorrere il
      // terminale; a ogni giro la STESSA posizione del dito mappa a una riga
      // diversa (coordinate assolute nel buffer), quindi la selezione si
      // estende finche' il buffer finisce o il dito rientra.
      const viewportY = Number(term.buffer.active.viewportY) || 0;
      const dir = edgeScrollDirection({ visibleRow: moved.row - viewportY, rows: term.rows });
      stopHandleEdgeScroll();
      // Sull'ALTERNATE buffer niente edge-scroll, dichiarato: li' lo scroll
      // e' dell'applicazione (stessa decisione di Termux); le maniglie
      // restano clampate al visibile.
      if (dir === 0 || term.buffer.active.type === 'alternate') return;
      handleEdgeTimer = setInterval(() => {
        const before = Number(term.buffer.active.viewportY) || 0;
        term.scrollLines(dir);
        const after = Number(term.buffer.active.viewportY) || 0;
        if (after === before) { stopHandleEdgeScroll(); return; } // fondo del buffer
        applyHandlePoint(lastHandlePointer.x - handleDrag.offsetX, lastHandlePointer.y - handleDrag.offsetY, lastHandlePointer.type);
      }, 130);
    };
    const onHandleDragMove = (e) => {
      if (!handleDrag) return;
      e.preventDefault();
      lastHandlePointer = { x: e.clientX, y: e.clientY, type: e.pointerType || lastHandlePointer.type };
      applyHandlePoint(e.clientX - handleDrag.offsetX, e.clientY - handleDrag.offsetY, lastHandlePointer.type);
    };
    const onHandleDragEnd = () => {
      handleDrag = null;
      stopHandleEdgeScroll();
      setDraggingHandle(null);
      window.removeEventListener('pointermove', onHandleDragMove);
      window.removeEventListener('pointerup', onHandleDragEnd);
      window.removeEventListener('pointercancel', onHandleDragEnd);
    };
    handleDragApiRef.current = {
      startHandleDrag: (which, e) => {
        if (!term.getSelectionPosition()) return;
        e.preventDefault(); e.stopPropagation();
        const g = handleGeomRef.current && handleGeomRef.current[which];
        handleDrag = {
          which,
          offsetX: g ? e.clientX - g.left : 0,
          offsetY: g ? e.clientY - g.top : 0,
        };
        lastHandlePointer = { x: e.clientX, y: e.clientY, type: e.pointerType || 'touch' };
        setDraggingHandle(which);
        window.addEventListener('pointermove', onHandleDragMove);
        window.addEventListener('pointerup', onHandleDragEnd);
        window.addEventListener('pointercancel', onHandleDragEnd);
      },
    };
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
      onRender.dispose();
      onScrollViewport.dispose();
      stopHandleEdgeScroll();
      window.removeEventListener('pointermove', onHandleDragMove);
      window.removeEventListener('pointerup', onHandleDragEnd);
      window.removeEventListener('pointercancel', onHandleDragEnd);
      handleDragApiRef.current = { startHandleDrag: () => {} };
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

  // R25: dal range (coordinate buffer) ai pixel delle maniglie. Gira a ogni
  // cambiamento del range e a ogni tick di viewport/redraw; misura lo schermo
  // reale e deriva la grandezza della cella — la stessa strada del caret del
  // long-press, cosi' le due viste non divergono.
  useEffect(() => {
    const host = hostRef.current;
    const term = apiRef.current ? apiRef.current.term : null;
    if (!host || !term || !selRange) { setHandleGeom(null); return; }
    const screen = host.querySelector('.xterm-screen') || host;
    const screenRect = screen.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setHandleGeom(handlePositions({
      range: selRange,
      viewportY: Number(term.buffer.active.viewportY) || 0,
      rows: term.rows,
      cellWidth: screenRect.width / Math.max(1, term.cols),
      cellHeight: screenRect.height / Math.max(1, term.rows),
      screenLeft: screenRect.left - hostRect.left,
      screenTop: screenRect.top - hostRect.top,
    }));
  }, [selRange, geomTick]);

  return <div className={`nc-terminal${selectionMode ? ' selecting' : ''}`}>
    <div className="nc-terminal-host" ref={hostRef} />
    {touchSelectionCaret && <div className="nc-touch-selection-caret" style={touchSelectionCaret} aria-hidden="true" />}
    {selRange && handleGeom && ['start', 'end'].map((which) => (handleGeom[which].visible && (
      <div
        key={`nc-sel-handle-${which}`}
        className={`nc-sel-handle ${which}${draggingHandle === which ? ' dragging' : ''}`}
        style={{ left: `${handleGeom[which].left}px`, top: `${handleGeom[which].top}px` }}
        onPointerDown={(e) => handleDragApiRef.current.startHandleDrag(which, e)}
        aria-hidden="true"
      />
    )))}
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
      {selection && !selectionDetached && selectionChanged && <span className="nc-selection-changed">{t('selection-changed')}</span>}
      <button type="button" onClick={() => { apiRef.current?.term?.clearSelection(); setSelection(''); setSelectionDetached(false); onSelectionModeChange?.(false); }}>{t('cancel')}</button>
      {copyState === t('copy-manual') && <textarea readOnly value={selection} onFocus={(e) => e.target.select()} />}
    </div>}
  </div>;
}
