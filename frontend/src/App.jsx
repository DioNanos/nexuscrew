import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SessionList from './components/SessionList.jsx';
import Terminal from './components/Terminal.jsx';
import KeyBar from './components/KeyBar.jsx';
import FilesPanel from './components/FilesPanel.jsx';
import ComposerBar from './components/ComposerBar.jsx';
import Icon from './components/Icon.jsx';
import Sidebar from './components/Sidebar.jsx';
import GridView from './components/GridView.jsx';
import PowerSheet from './components/PowerSheet.jsx';
import DeckBar from './components/DeckBar.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import Wizard from './components/Wizard.jsx';
import DeviceNameAsk from './components/DeviceNameAsk.jsx';
import NotifyCenter from './components/NotifyCenter.jsx';
import CellSwitcher from './components/CellSwitcher.jsx';
import { CellActionsPopover, CellActionsSheet } from './components/CellActions.jsx';
import { cellRuntime } from './lib/roster-view-model.js';
import { nextRendererPreference, readRendererPreference, writeRendererPreference } from './lib/terminal-renderer.js';
import { leggiFilesTasto, scriviFilesTasto, leggiTastieraTasto, leggiPannelloTasto } from './lib/bar-files-tasto.js';
import { readFontSize, writeFontSize } from './lib/terminal-fontsize.js';
import { liveHostDotClass, liveHostView } from './lib/live-host-view.js';
import { createPollGuard } from './lib/poll-guard.js';
import { subscribeFleetRoute, readFleetRoute } from './lib/fleet-poll.js';
import VlSessionView from './components/VlSessionView.jsx';
import CellPanel from './components/CellPanel.jsx';
import {
  apiFetch, fleetBoot, killSession, getSettings, nodeAction, renameNodeLabel, setSessionTechnical,
  getLiveHost, designateHostCell, clearHostCell,
} from './lib/api.js';
import { isValidLabel } from './lib/settings-model.js';
import { runFleetPowerAction } from './lib/fleet-action-notice.js';
import useActionNotice from './hooks/useActionNotice.js';
import { emptyLayout, normalize, addTileSmart, removeTile, sessions, parseRef, remapTileRefs } from './lib/grid-model.js';
import { cellDisplayName } from './lib/cell-display.js';
import { isSameRef, toggleSideRef, readSavedDual, writeSavedDual, clearSavedDual, clampWeight } from './lib/dual-view.js';
import { positionKey } from './lib/nodes-model.js';
import {
  MAIN_DECK, deckLocationFromPath, deckUrl, readLayoutRaw,
} from './lib/deck-model.js';
import { deckId, refWithOwner, resolveLayoutForViewer, tickOwnerAvailability } from './lib/deck-federation.js';
import { hostRouteKey, hostDesignationFailureMessage } from './lib/host-designation.js';
import { loadLastRoster, saveLastRoster } from './lib/last-roster.js';
import { adoptDeviceId } from './lib/prefs-sync.js';
import { usePrefsSync } from './hooks/usePrefsSync.js';
import { fleetReadOutcome } from './lib/fleet-read-policy.js';
import { panelPortForRoute } from './lib/panel-port.js';
import { AUTH_INVALID_EVENT, TOKEN_NOT_REMEMBERED_EVENT, loadToken, saveToken } from './lib/token-store.js';
import LoginScreen from './components/LoginScreen.jsx';
import {t} from './lib/i18n.js';
import { useLang } from './hooks/useLang.js';
import { setTerminalRuntimeConfig } from './lib/terminal-runtime-config.js';
import { useNodes } from './hooks/useNodes.js';
import { useDecks } from './hooks/useDecks.js';
import { useNodePreferences } from './hooks/useNodePreferences.js';
import { useInputPreferences } from './hooks/useInputPreferences.js';
import { reportServerVersions } from './lib/sw-update.js';
import { parseBootstrapHash } from './lib/fragment.js';
import { useDesktop } from './lib/desktop.js';
import './App.css';

const SIDE_W_KEY = 'nc_side_w';
const SIDE_MIN_KEY = 'nc_side_min';
const SIDE_W_DEF = 240;
const THREAD_STATUSES = new Set(['absent', 'present', 'active', 'unknown']);

function loadSideW() {
  const v = Number(localStorage.getItem(SIDE_W_KEY));
  return v >= 180 && v <= 480 ? v : SIDE_W_DEF;
}

// Bootstrap dal fragment: legge token (#token=) e pairing (#pair=) dalla hash
// IN UN SOLO PASSO, persiste (token in localStorage, pairing in sessionStorage per
// la sessione corrente) e rimuove il fragment sensibile dalla address bar con
// history.replaceState — senza toccare pathname/search (la condivisione esplicita
// del link non si rompe). Ritorna {token, pair} con fallback agli storage.
//
// #pair: deep-link di pairing generato da un altro NexusCrew (peering.js). Arriva
// in address bar; lo acquisiamo e lo offriamo al wizard/settings precompilato,
// poi lo scrubighiamo perche' l'invite e' one-time e sensibile.
function bootstrapFromFragment() {
  const out = { token: '', pair: '' };
  try {
    const { token, pair, device, nextUrl } = parseBootstrapHash({
      hash: location.hash, origin: location.origin, pathname: location.pathname, search: location.search,
    });
    if (token) {
      out.token = token;
      saveToken(token, { remember: true }); // un solo posto: toglie l'eventuale copia di sessione vecchia
    }
    if (device) adoptDeviceId(device); // solo se questo browser non ha gia' un profilo
    if (pair) {
      out.pair = pair;
      try { sessionStorage.setItem('nc_pair', pair); } catch (_) {}
    }
    // rimuove il fragment sensibile (token e/o pair), preserva path + query.
    if (location.hash) { try { history.replaceState(null, '', nextUrl); } catch (_) {} }
  } catch (_) { /* best-effort: la UI resta usabile */ }
  if (!out.token) out.token = loadToken();
  if (!out.pair) { const p = sessionStorage.getItem('nc_pair'); if (p) out.pair = p; }
  return out;
}

// Layout di un deck: legge la chiave per-deck (main = chiave storica nc_grid_v1)
// e ripara qualunque garbage col grid-model.
function loadLayout(deck) {
  try { return normalize(readLayoutRaw(deck)); }
  catch (_) { return emptyLayout(); }
}

// Tempo relativo numerico (nessuna localizzazione, come da piano C3).
function rel(epochSec) {
  if (!epochSec) return '';
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 0 || s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

// Vista singola autosufficiente: usata dal flusso mobile e dall'overlay desktop.
// Comportamento intatto rispetto alla vista singola pre-griglia.
// node (opzionale, B2): sessione su nodo remoto via proxy /node/<name>.
// cellName (opzionale, Tranche D): titolo logico Fleet gia' risolto dal roster
// (desktop overlay). Se assente (mobile), la lookup fleetStatus esistente lo
// risolve al primo ciclo. Il titolo visibile deriva sempre da `cell.cell`.
// le quattro azioni della barra alta, raccolte nel menu ⋯.
//
// Sono le STESSE azioni di prima, con lo stesso stato vero: qui si decide solo
// l'ordine e quali compaiono. Una voce che non ha il suo handler non c'e' — e'
// il contratto di CellActionsMenu, gli stessi item delle azioni cella.
// Decisione dell'operatore sulla PR #7: il menu ⋯ resta PER INTERO con tutti i suoi
// sottomenu; i tasti diretti (cartella, tastiera, AI Desktop) sono AGGIUNTI
// fuori dal menu, non una sostituzione.
export function barActionsItems({
  showComposer, showFiles, showPanel, hasPanel, rendererKind,
  // Su mobile la voce «files» è l'IMPOSTAZIONE del tasto in barra — accenderla
  // mostra il tasto, spegnerlo lo toglie: NON apre la lista. `filesSetting` è
  // il valore di quell'impostazione; null è la modalità desktop, dove la voce
  // resta lo switch che apre e chiude la lista com'era.
  filesSetting = null,
  handlers = {},
} = {}) {
  const items = [];
  if (typeof handlers.onToggleComposer === 'function') {
    items.push({
      id: 'keyboard', kind: 'switch', on: !!showComposer,
      labelKey: 'bar-menu-keyboard', descKey: 'bar-menu-keyboard-desc',
      run: handlers.onToggleComposer,
    });
  }
  if (typeof handlers.onToggleFiles === 'function') {
    items.push(filesSetting === null ? {
      id: 'files', kind: 'switch', on: !!showFiles,
      labelKey: 'bar-menu-files', descKey: 'bar-menu-files-desc',
      run: handlers.onToggleFiles,
    } : {
      id: 'files', kind: 'switch', on: !!filesSetting,
      labelKey: 'bar-menu-files', descKey: 'bar-menu-files-setting-desc',
      run: handlers.onToggleFiles,
    });
  }
  // Il pannello esiste solo se la cella ne pubblica uno: la voce SPARISCE, non
  // resta spenta.
  if (hasPanel && typeof handlers.onTogglePanel === 'function') {
    items.push({
      id: 'panel', kind: 'switch', on: !!showPanel,
      labelKey: 'bar-menu-panel', descKey: 'bar-menu-panel-desc',
      run: handlers.onTogglePanel,
    });
  }
  if (typeof handlers.onSwitchRenderer === 'function') {
    items.push({
      id: 'renderer', kind: 'switch', on: rendererKind === 'webgl',
      labelKey: 'bar-menu-renderer', descKey: 'bar-menu-renderer-desc',
      run: handlers.onSwitchRenderer,
    });
  }
  return items;
}

// La parola di stato del centro della barra. Esce dal contratto `stato` della
// cella (roster-view-model.js), non da una derivazione nuova, e «ferma» si dice
// «in attesa» — la stessa parola che usa la lista per la stessa cosa. Senza un
// canale affidabile non si afferma nulla: il centro resta il solo motore.
function parolaStatoCella(cell, session) {
  if (!cell || !cell.tmux) return '';
  const rt = cellRuntime(cell, session || {});
  if (rt.stato === 'lavora') return t('cell-working');
  if (rt.stato === 'attesa') return t('cell-permission');
  if (rt.stato === 'ferma') return t('cell-idle');
  return '';
}

export function SingleView({
  session, node, ownerId, cellName, token, readonly = false, panelPort = 0, onBack, onCellSwitcher, cellSwitcherOpen = false,
  // Live host della cella aperta (gia' risolto da App per la route giusta):
  // the phone header has room for a dot only; the sentence lives in the title.
  liveHost = null,
  // Doppia vista: `side` è il ref {session, node?, ownerId?} della seconda
  // cella affiancata (null = vista singola, identica a prima). onSideClose
  // arriva dal tasto ✕ del pannello affiancato; onSideGone dalle letture che
  // scoprono che la seconda cella non esiste più. Il desktop non passa mai
  // queste props: la sua vista singola resta intatta.
  side = null, onSideClose = null, onSideGone = null,
}) {
  useLang(); // re-render allo switch lingua
  const [inputPreferences] = useInputPreferences();
  const isDesktop = useDesktop();
  // Il menu ⋯ della barra: aperto/chiuso, piu' il rettangolo del trigger per il
  // popover desktop (il foglio mobile non ne ha bisogno).
  const [showBarMenu, setShowBarMenu] = useState(false);
  const [barMenuRect, setBarMenuRect] = useState(null);
  // Su touch il composer è aperto di default (l'IME Gboard corrompe l'input in
  // xterm): quello che cambia è dove si sceglie. Ora è una preferenza locale
  // persistita (Impostazioni → input) che vale come stato iniziale della vista.
  const [showComposer, setShowComposer] = useState(() => inputPreferences.showComposer);
  const [fontSize, setFontSize] = useState(readFontSize);
  // Renderer del terminale: quello che sta disegnando davvero (il GPU puo' non
  // essere disponibile, o perdere il contesto). La scelta A/B vive nella stessa
  // preferenza per browser e si cambia da due posti — la voce del menu ⋯ e
  // l'interruttore in Impostazioni → sistema — entrambi con ricaricamento,
  // perche' il renderer si aggancia alla creazione del terminale.
  const [rendererKind, setRendererKind] = useState(() => readRendererPreference());
  const switchRenderer = () => {
    writeRendererPreference(nextRendererPreference(readRendererPreference()));
    if (typeof window !== 'undefined') window.location.reload();
  };
  // Titolo visibile (Tranche D): nome logico Fleet o, in fallback, il nome
  // sessione tmux. Inizializza con cellName (desktop overlay) o session.
  const [title, setTitle] = useState(cellName || session);
  const [sub, setSub] = useState('');           // sottotitolo stato dell'header
  // D8: pannello grafico per-cella. `panelUrl` arriva dal fleetStatus (contratto
  // col backend: stringa per-cella, opzionale, già validata a monte http/https
  // loopback — qui si consuma, non si ri-valida). Opt-in totale: senza campo
  // né il bottone né il pannello esistono. L'iframe NON punta al panelUrl
  // grezzo (loopback della macchina remota): punta alla NOSTRA route con un
  // ticket di visione — via locale o federata a seconda del nodo della cella.
  const [panelUrl, setPanelUrl] = useState('');
  const [panelCellId, setPanelCellId] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  // Doppia vista: il focus decide a QUALE cella scrivono barra e tasti; il
  // tocco su un pannello lo sposta. I ref sono PER PANNELLO e non si
  // condividono mai: l'input di una cella non deve finire nell'altra.
  const [focusSide, setFocusSide] = useState(false);
  // Nel render in cui la seconda cella SPARISCE (✕ o onSideGone) lo stato
  // del focus sopravvive un ciclo: l'effetto che lo azzera gira DOPO. Ogni
  // scelta di bersaglio passa da qui — mai da focusSide da solo — così quel
  // render di transizione ricade sulla cella principale invece di leggere
  // side.* di un oggetto che non c'e' piu'.
  const focaLaSide = !!side && focusSide;
  const [sideOnTop, setSideOnTop] = useState(false);
  // Pesi SEPARATI per orientamento (design approvato della doppia vista orizzontale): in
  // orizzontale i pannelli si affiancano e il confine è verticale. Ogni
  // disposizione ricorda le sue proporzioni per la sessione, in memoria —
  // niente storage: tornando in verticale si ritrovano le altezze di prima.
  const [pesi, setPesi] = useState({ v: { main: 1, side: 1 }, h: { main: 1, side: 1 } });
  const [orizzontale, setOrizzontale] = useState(() => window.matchMedia('(orientation: landscape)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)');
    const ruota = (e) => setOrizzontale(e.matches);
    mq.addEventListener('change', ruota);
    return () => mq.removeEventListener('change', ruota);
  }, []);
  const weights = orizzontale ? pesi.h : pesi.v;
  const weightsRef = useRef(weights);
  weightsRef.current = weights;
  const [sideInfo, setSideInfo] = useState(null); // {title, present} dal nodo della side
  const [mainPresent, setMainPresent] = useState(true);
  const sideSendRef = useRef(() => {});
  const sideComposerRef = useRef(() => false);
  const sideActionRef = useRef(() => {});
  const sideCtrlRef = useRef(false);
  const sideAltRef = useRef(false);   // ALT del pannello affiancato
  const sideKeyboardRef = useRef(null); // requestTerminalKeyboard della side
  const dualBoxRef = useRef(null);
  // I file caduti/aperti riguardano il pannello di origine, non la vista.
  const [files, setFiles] = useState(null); // {source:'main'|'side', ev} | null
  // Stabili per contratto: onFiles sta nelle dipendenze dell'effetto del
  // terminale che crea e distrugge socket (stesso elenco di Terminal.jsx):
  // una funzione nuova a ogni render farebbe ripartire la connessione,
  // svuotando e ridisegnando il terminale a ogni ciclo di poll.
  const onFilesCella = useCallback((ev) => setFiles({ source: 'main', ev }), []);
  const onFilesSide = useCallback((ev) => setFiles({ source: 'side', ev }), []);
  // La lista file della side vale solo finché la side esiste: chiusura e
  // sparitura non devono lasciarla puntare a una sessione morta.
  const filesSide = !!side && files?.source === 'side';
  const foca = (secondario) => {
    setFocusSide(secondario);
    setCtrlArmed((secondario ? sideCtrlRef : ctrlRef).current);
    setAltArmed((secondario ? sideAltRef : altRef).current);   // ALT segue il focus
  };
  // Cambio della cella affiancata: focus, ordine, altezze e lista file
  // ripartono puliti (la chiave è la stringa, non l'oggetto: il ripristino
  // della stessa coppia non rimonta nulla).
  const sideKey = side ? `${side.node || ''}:${side.session}` : '';
  useEffect(() => {
    setFocusSide(false);
    setSideOnTop(false);
    setPesi({ v: { main: 1, side: 1 }, h: { main: 1, side: 1 } });
    setSideInfo(null);
    setFiles((cur) => (cur && cur.source === 'side' ? null : cur));
  }, [sideKey]);
  // Soglia del design della doppia vista orizzontale: in orizzontale, se la cella PIÙ
  // STRETTA scende sotto ~40 colonne al font corrente, si vede solo la cella
  // col focus. Larghezza colonna ≈ 0,6 em del font (stima del terminale:
  // non esiste una misura condivisa in Terminal.jsx). L'altra cella resta
  // MONTATA e nascosta: mai smontata, nessun terminale ricreato.
  // Larghezza REALE del carattere monospace alla dimensione corrente,
  // misurata sul DOM (span nascosto): la stima 0,6 em sbagliava le colonne
  // reali del terminale (il font monospace varia per piattaforma). Se il DOM
  // non misura (test/jsdom), fallback alla stima 0,6 em.
  const misuratoreColonne = useMemo(() => {
    const cache = new Map();
    return (fs) => {
      if (cache.has(fs)) return cache.get(fs);
      let px = fs * 0.6;
      try {
        const span = document.createElement('span');
        span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:courier-new,courier,monospace;';
        span.style.fontSize = `${fs}px`;
        span.textContent = '0'.repeat(20);
        document.body.appendChild(span);
        const w = span.getBoundingClientRect().width;
        document.body.removeChild(span);
        if (Number.isFinite(w) && w > 0) px = w / 20;
      } catch (_) { /* misura impossibile: stima */ }
      cache.set(fs, px);
      return px;
    };
  }, []);
  const sommaPesi = Math.max(0.01, weights.main + weights.side);
  const larghezzaBox = dualBoxRef.current?.clientWidth || window.innerWidth;
  // Larghezza UTILE della cella più stretta, quella in cui il terminale
  // conta davvero le colonne: il box meno la maniglia (12 px,
  // .nc-dual-handle) diviso per peso, meno bordi del pannello (2+2 px),
  // padding di .nc-terminal-host (4+4 px) e barra di scorrimento di xterm
  // (14 px). In orizzontale i pannelli hanno base 0 (sotto), quindi la loro
  // larghezza reale segue i pesi: soglia e terminale contano le stesse colonne.
  const larghezzaUtile = Math.max(0, larghezzaBox - 12) * (Math.min(weights.main, weights.side) / sommaPesi) - 26;
  // Si misura SOLO con due celle affiancate: la vista singola non tocca il
  // DOM durante il render (nessuno span di misura, nessun layout forzato).
  const stretto = !!side && orizzontale
    && larghezzaUtile / misuratoreColonne(Math.max(1, fontSize)) < 40;
  const zoom = (delta) => setFontSize((v) => writeFontSize(v + delta));
  // Lo zoom dell'anteprima del selettore scrive lo stesso nc_fontsize: quando
  // il foglio si chiude, il terminale principale rilegge il valore UNO che
  // adesso c'e'. Due superfici, un numero.
  useEffect(() => {
    if (!cellSwitcherOpen) setFontSize(readFontSize());
  }, [cellSwitcherOpen]);
  const sendRef = useRef(() => {});
  const composerRef = useRef(() => false);
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const altRef = useRef(false);
  const [altArmed, setAltArmed] = useState(false);
  const keyboardRef = useRef(null);   // requestTerminalKeyboard del terminale attivo
  const [selectionMode, setSelectionMode] = useState(false);
  // Il toggle arma la sticky del pannello (unito alla 0.9.51)
  // che ha il focus (main o side), come fa `foca` al cambio focus.
  const toggleCtrl = () => {
    const r = focaLaSide ? sideCtrlRef : ctrlRef;
    r.current = !r.current;
    setCtrlArmed(r.current);
  };
  const toggleAlt = () => {
    const r = focaLaSide ? sideAltRef : altRef;
    r.current = !r.current;
    setAltArmed(r.current);
  };

  // SingleView may be reused at the same React position when the operator
  // switches cells. Synchronize immediately instead of showing the previous
  // title until the first fleetStatus poll completes.
  useEffect(() => { setTitle(cellName || session); setShowPanel(false); }, [cellName, session]);

  // Sottotitolo header: "engine·key" se la sessione è una cella, altrimenti
  // "attached · Nm" (o tempo relativo). Dati da /api/sessions + /api/fleet/status
  // del nodo che possiede la sessione (Locale o route remota via proxy). La Fleet
  // non e' piu' un concetto solo-locale: una sessione remota su un nodo che ha
  // capability fleet mostra comunque engine/model (parita' mobile/desktop).
  // Le letture arrivano dal treno condiviso di lib/fleet-poll.js —
  // un solo giro per route per finestra, non uno per pannello. La policy
  // qui e' quella di sempre (best-effort, titolo dal campo Fleet o dal nome
  // sessione, mai fetch aggiuntive). La sottoscrizione dipende solo da
  // route e token: cambiare cella sulla stessa route NON rilancia letture,
  // riapplica la policy sullo snapshot corrente del treno (coalescing).
  const applyMainSnapshot = (snap) => {
    const j = !snap || snap.sessionsError ? null : snap.sessionsJson;
    let sess = null;
    if (j && Array.isArray(j.sessions)) sess = j.sessions.find((s) => s.name === session);
    const fs = !snap || snap.fleetError ? null : snap.fs;
    let cell = null;
    if (fs && fs.available && Array.isArray(fs.cells)) cell = fs.cells.find((c) => c.tmuxSession === session);
    // Titolo visibile dal campo Fleet `cell` (gestita) o dal nome sessione
    // (unmanaged). Riusa la lookup fleetStatus gia' fatta per il sottotitolo:
    // nessuna fetch aggiuntiva (Tranche D).
    setTitle(cellDisplayName({
      session,
      cell: cell || (cellName ? { cell: cellName } : null),
    }));
    // D8: campo opzionale; assente o vuoto (anche solo spazi) → nessun
    // pannello. Non è una ri-validazione: è la resa dello stato "nessun
    // pannello configurato". Serve anche l'ID della cella: è la chiave con
    // cui si chiede il ticket di visione sul nodo che la possiede.
    setPanelUrl(typeof cell?.panelUrl === 'string' ? cell.panelUrl.trim() : '');
    setPanelCellId(typeof cell?.cell === 'string' ? cell.cell : '');
    // il centro porta motore E stato, come il design. La parola esce
    // dal contratto `stato` della cella; senza canale resta il solo motore.
    let txt = '';
    if (cell) txt = [`${cell.engine}${cell.key ? `·${cell.key}` : ''}`, parolaStatoCella(cell, sess)].filter(Boolean).join(' · ');
    else if (sess) txt = sess.attached ? `attached · ${rel(sess.activity)}` : (sess.activity ? rel(sess.activity) : '');
    setSub(txt);
    // pallino di presenza nella striscia del pannello principale (doppia vista)
    setMainPresent(!!(sess || cell));
  };
  const applyMainRef = useRef(applyMainSnapshot);
  applyMainRef.current = applyMainSnapshot;
  useEffect(() => {
    const route = node ? node.split('/') : [];
    const onSnapshot = (snap) => applyMainRef.current(snap);
    onSnapshot(readFleetRoute(route));
    return subscribeFleetRoute(token, route, onSnapshot);
  }, [node, token]);
  // Cambio cella (o nome logico) sulla stessa route: nessuna lettura nuova,
  // la policy si riapplica subito sull'ultimo snapshot del treno.
  useEffect(() => {
    applyMainRef.current(readFleetRoute(node ? node.split('/') : []));
  }, [session, cellName]);

  // La cella affiancata: titolo e presenza dal SUO nodo, stessa forma della
  // lettura principale (sessioni + fleetStatus, best-effort). Se almeno una
  // fonte autorevole risponde e il nome non c'è in nessuna, la seconda è
  // sparita: la vista torna singola e l'ospite dimentica la coppia.
  const onSideGoneRef = useRef(onSideGone);
  onSideGoneRef.current = onSideGone;
  // Stessa lettura condivisa della striscia principale — la cella
  // affiancata consuma il treno della PROPRIA route (spesso la stessa della
  // principale) invece di aggiungere un poll parallelo. Anche qui la
  // sottoscrizione dipende solo da route e token: cambiare la cella
  // affiancata sulla stessa route riapplica la policy sullo snapshot.
  const applySideSnapshot = (snap) => {
    // La consegna del treno puo' arrivare quando side e' gia' null (ref
    // aggiornato dal render, subscription in chiusura): la policy non legge
    // nulla di una cella che non c'e' piu'.
    if (!side) return;
    const j = !snap || snap.sessionsError ? null : snap.sessionsJson;
    let sess = null; let sessLetta = false;
    if (j && Array.isArray(j.sessions)) { sessLetta = true; sess = j.sessions.find((s) => s.name === side.session); }
    const fs = !snap || snap.fleetError ? null : snap.fs;
    let cell = null; let cellLetta = false;
    if (fs && fs.available && Array.isArray(fs.cells)) { cellLetta = true; cell = fs.cells.find((c) => c.tmuxSession === side.session); }
    setSideInfo({
      title: cellDisplayName({ session: side.session, cell }),
      present: !!(sess || cell),
    });
    if ((sessLetta || cellLetta) && !sess && !cell) onSideGoneRef.current?.();
  };
  const applySideRef = useRef(applySideSnapshot);
  applySideRef.current = applySideSnapshot;
  useEffect(() => {
    if (!side) { setSideInfo(null); return undefined; }
    const route = side.node ? side.node.split('/') : [];
    const onSnapshot = (snap) => applySideRef.current(snap);
    onSnapshot(readFleetRoute(route));
    return subscribeFleetRoute(token, route, onSnapshot);
    // `side` in dipendenza (non solo la sua route): a side null la callback
    // LASCIA il treno anche quando la route non e' cambiata.
  }, [side, side?.node, token]);
  useEffect(() => {
    if (!side) return;
    applySideRef.current(readFleetRoute(side.node ? side.node.split('/') : []));
  }, [side?.session]);

  // le quattro azioni della barra, nello stesso contratto delle azioni
  // cella. Gli handler sono gli stessi setter di prima: cambia solo dove stanno.
  // Con la doppia vista, la lista file riguarda la cella col focus.
  // NC mobile — la voce «files» del menu è l'IMPOSTAZIONE del tasto in barra
  // (mostra/nasconde, per dispositivo in localStorage): non apre più la lista.
  // Il tasto, quando c'è, fa ciò che faceva la voce: apre/chiude la lista
  // della cella col focus. Il desktop resta com'era, voce = lista.
  const cellaFoca = focaLaSide ? 'side' : 'main';
  const apriChiudiFiles = () => setFiles((cur) => (cur && cur.source === cellaFoca ? null : { source: cellaFoca, ev: null }));
  // I tre tasti diretti fuori dal menu sono opzioni per dispositivo (vedi
  // lib/bar-files-tasto.js): cartella e tastiera ACCESI di default, AI Desktop
  // SPENTO. Un valore gia' salvato vince sul default nuovo.
  const [filesTasto, setFilesTasto] = useState(leggiFilesTasto);
  const [tastieraTasto] = useState(leggiTastieraTasto);
  const [pannelloTasto] = useState(leggiPannelloTasto);
  const barItems = barActionsItems({
    showComposer, showFiles: files?.source === cellaFoca, showPanel, hasPanel: !!panelUrl, rendererKind,
    filesSetting: isDesktop ? null : filesTasto,
    handlers: {
      onToggleComposer: () => setShowComposer((v) => !v),
      onToggleFiles: isDesktop ? apriChiudiFiles : () => setFilesTasto((on) => { scriviFilesTasto(!on); return !on; }),
      onTogglePanel: () => setShowPanel((v) => !v),
      onSwitchRenderer: switchRenderer,
    },
  });

  // Maniglia delle altezze/larghezze: stesso schema del drag della griglia
  // (pointermove fino a up/cancel/blur su window). Il confine SEGUE IL DITO
  // in entrambe le disposizioni: «su» restringe il pannello superiore e
  // «sinistra» quello a sinistra, quale cella stia in quella posizione; il
  // minimo 0.2 non lascia collassare nessuno. Ogni orientamento scrive i
  // SUOI pesi.
  const startDualResize = (startEvent) => {
    startEvent.preventDefault();
    const box = dualBoxRef.current;
    if (!box) return;
    const scrivi = (main, side) => setPesi((cur) => ({
      ...cur,
      [orizzontale ? 'h' : 'v']: { main, side },
    }));
    if (orizzontale) {
      const startX = startEvent.clientX;
      const partenza = weightsRef.current;
      const totale = box.clientWidth || 1;
      const verso = sideOnTop ? -1 : 1;
      const muovi = (ev) => {
        const somma = partenza.main + partenza.side;
        const dm = ((ev.clientX - startX) / totale) * somma * verso;
        const main = clampWeight(partenza.main + dm);
        scrivi(main, clampWeight(somma - main));
      };
      const su = () => {
        window.removeEventListener('pointermove', muovi);
        window.removeEventListener('pointerup', su);
        window.removeEventListener('pointercancel', su);
        window.removeEventListener('blur', su);
      };
      window.addEventListener('pointermove', muovi);
      window.addEventListener('pointerup', su);
      window.addEventListener('pointercancel', su);
      window.addEventListener('blur', su);
      return;
    }
    const startY = startEvent.clientY;
    const partenza = weightsRef.current;
    const totale = box.clientHeight || 1;
    const verso = sideOnTop ? -1 : 1;
    const muovi = (ev) => {
      const somma = partenza.main + partenza.side;
      const dm = ((ev.clientY - startY) / totale) * somma * verso;
      const main = clampWeight(partenza.main + dm);
      scrivi(main, clampWeight(somma - main));
    };
    const su = () => {
      window.removeEventListener('pointermove', muovi);
      window.removeEventListener('pointerup', su);
      window.removeEventListener('pointercancel', su);
      window.removeEventListener('blur', su);
    };
    window.addEventListener('pointermove', muovi);
    window.addEventListener('pointerup', su);
    window.addEventListener('pointercancel', su);
    window.addEventListener('blur', su);
  };

  // I pannelli si CREANO solo con la seconda presente: le espressioni JSX
  // (side.session nelle strisce) si valutano a ogni render anche senza dual.
  // In stretto il pannello SENZA focus si NASCONDE (display:none): resta
  // montato — mai un terminale ricreato — e nella striscia della cella
  // visibile sta il tasto-icona per passare all'altra (pallino = suo stato).
  const panePrincipale = side && (
    <div key="pane-main"
      className={`nc-dual-pane${focaLaSide ? '' : ' foco'}${stretto && focaLaSide ? ' nascosto' : ''}`}
      data-testid="pane-main"
      style={{ flexGrow: weights.main, flexBasis: orizzontale ? 0 : undefined }} onPointerDown={() => foca(false)}>
      <div className="nc-dual-strip">
        <span className={`nc-dual-dot${mainPresent ? ' on' : ''}`} aria-hidden="true" />
        <b>{title}</b>
        {!focaLaSide && <span className="nc-dual-matita" aria-hidden="true" title={t('dual-focus')}>✎</span>}
        {stretto && (
          <button type="button" className="nc-dual-alt"
            title={t('dual-go-to').replace('{cell}', sideInfo?.title || side.session)}
            aria-label={t('dual-go-to').replace('{cell}', sideInfo?.title || side.session)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); foca(!focaLaSide); }}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <rect x="3.5" y="6" width="17" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="3.5" y="6" width="8.5" height="12" fill="currentColor" />
            </svg>
            <span className={`nc-dual-dot${sideInfo?.present ? ' on' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="nc-dual-body">
        {/* readonly fisso: l'effetto di Terminal che crea terminale+socket lo
            ha nelle dipendenze — farlo dipendere dal focus ricostruirebbe i
            due terminali a ogni tocco. L'input diretto segue comunque il
            focus (focused → sock.focus) e i ref instradano barra e tasti. */}
        <Terminal session={session} node={node} token={token} readonly={readonly} takeSize focused={!focaLaSide}
          sendRef={sendRef} composerRef={composerRef} actionRef={actionRef}
          ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} altRef={altRef} setAltArmed={setAltArmed} keyboardRef={keyboardRef}
          onFiles={onFilesCella} fontSize={fontSize}
          selectionMode={selectionMode} onSelectionModeChange={setSelectionMode}
          keyboardGesture={inputPreferences.terminalKeyboardGesture} onRendererChange={setRendererKind} />
      </div>
    </div>
  );
  const paneSecondario = side && (
    <div key="pane-side"
      className={`nc-dual-pane${focaLaSide ? ' foco' : ''}${stretto && !focaLaSide ? ' nascosto' : ''}`}
      data-testid="pane-side"
      style={{ flexGrow: weights.side, flexBasis: orizzontale ? 0 : undefined }} onPointerDown={() => foca(true)}>
      <div className="nc-dual-strip">
        <span className={`nc-dual-dot${sideInfo?.present ? ' on' : ''}`} aria-hidden="true" />
        <b>{sideInfo ? sideInfo.title : side.session}</b>
        {focaLaSide && <span className="nc-dual-matita" aria-hidden="true" title={t('dual-focus')}>✎</span>}
        <span className="nc-dual-tasti">
          <button type="button" title={t('dual-swap')} aria-label={t('dual-swap')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSideOnTop((v) => !v); }}>{orizzontale ? '⇆' : '⇅'}</button>
          <button type="button" title={t('dual-close')} aria-label={t('dual-close')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onSideClose?.(); }}>✕</button>
        </span>
        {stretto && (
          <button type="button" className="nc-dual-alt"
            title={t('dual-go-to').replace('{cell}', title)}
            aria-label={t('dual-go-to').replace('{cell}', title)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); foca(!focaLaSide); }}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <rect x="3.5" y="6" width="17" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="12" y="6" width="8.5" height="12" fill="currentColor" />
            </svg>
            <span className={`nc-dual-dot${mainPresent ? ' on' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="nc-dual-body">
        {/* takeSize={false}: il size-lock resta alla cella aperta, come per i
            tile della griglia — la seconda non si contende le misure. */}
        <Terminal session={side.session} node={side.node} token={token} readonly={readonly} takeSize={false} focused={focaLaSide}
          sendRef={sideSendRef} composerRef={sideComposerRef} actionRef={sideActionRef}
          ctrlRef={sideCtrlRef} setCtrlArmed={setCtrlArmed} altRef={sideAltRef} setAltArmed={setAltArmed} keyboardRef={sideKeyboardRef}
          onFiles={onFilesSide} fontSize={fontSize}
          selectionMode={selectionMode} onSelectionModeChange={setSelectionMode}
          keyboardGesture={inputPreferences.terminalKeyboardGesture} />
      </div>
    </div>
  );
  const maniglia = (
    <div key="dual-handle" className="nc-dual-handle" data-testid="dual-handle" role="separator"
      aria-orientation={orizzontale ? 'vertical' : 'horizontal'}
      onPointerDown={startDualResize} />
  );

  return (
    <div className="nc-app">
      <header className="nc-bar nc-bar-single">
        <button onClick={onBack} title={t('sessions')}><Icon name="chevronLeft" size={18} /><span className="nc-bar-label">{t('sessions')}</span></button>
        <span className="nc-bar-center">
          <b title={node ? `${title} · ${node}` : title}>{title}</b>
          {liveHost && liveHost.cell && liveHost.cell === cellName ? (
            <span className={`nc-live-host-dot ${liveHostDotClass(liveHost)} nc-live-host-dot-header`}
              data-testid="live-host-header-dot"
              title={t('live-host-indicator').replace('{cell}', liveHost.cell)
                .replace('{mode}', t(liveHost.mode ? `live-host-mode-${liveHost.mode}` : 'live-host-mode-unknown'))
                .replace('{state}', t(`live-host-state-${liveHost.state}`))} />
          ) : null}
          {sub && <small className="nc-bar-sub">{sub}</small>}
        </span>
        <span className="nc-bar-right">
          <button onClick={() => zoom(-1)} title={t('zoom-out')} aria-label={t('zoom-out')}><Icon name="zoomOut" size={18} /></button>
          <button onClick={() => zoom(+1)} title={t('zoom-in')} aria-label={t('zoom-in')}><Icon name="zoomIn" size={18} /></button>
          {/* I tre tasti DIRETTI, fuori dal menu ⋯ (decisione dell'operatore sulla PR #7):
              cartella (icona disegnata della PR, non piu' il download) e
              tastiera ACCESI di default, AI Desktop SPENTO — ognuno con la sua
              opzione per dispositivo in Impostazioni → input, e un valore gia'
              salvato che vince sul default nuovo.
              Ordine del design: − + [cartella] [tastiera] [pannello] ⋯. */}
          {filesTasto && (
            <button type="button" onClick={apriChiudiFiles}
              title={t('bar-menu-files')} aria-label={t('bar-menu-files')}
              aria-pressed={files?.source === cellaFoca ? 'true' : 'false'}>
              <Icon name="folder" size={18} />
            </button>
          )}
          {tastieraTasto && (
            <button type="button" onClick={() => setShowComposer((v) => !v)}
              title={t('bar-menu-keyboard')} aria-label={t('bar-menu-keyboard')}
              aria-pressed={showComposer ? 'true' : 'false'}>
              <Icon name="keyboard" size={18} />
            </button>
          )}
          {/* AI Desktop: doppio opt-in — la cella deve pubblicare un panelUrl
              E l'opzione del tasto deve essere accesa (spenta di default). */}
          {panelUrl && pannelloTasto && (
            <button type="button" onClick={() => setShowPanel((v) => !v)}
              title={t('bar-menu-panel')} aria-label={t('bar-menu-panel')}
              aria-pressed={showPanel ? 'true' : 'false'}>
              <Icon name="monitor" size={18} />
            </button>
          )}
          {/* Le quattro azioni restano ANCHE nel menu ⋯, per intero e con gli
              stessi sottomenu di sempre: dalla barra non si toglie niente. */}
          <button type="button" className={`nc-bar-menu${showBarMenu ? ' on' : ''}`}
            title={t('bar-menu-open')} aria-label={t('bar-menu-open')}
            aria-haspopup="menu" aria-expanded={showBarMenu ? 'true' : 'false'}
            onClick={(event) => {
              if (!showBarMenu) setBarMenuRect(event.currentTarget.getBoundingClientRect());
              setShowBarMenu((v) => !v);
            }}>⋯</button>
        </span>
      </header>
      <div className="nc-termwrap">
        {side ? (
          <div className={`nc-dual${orizzontale ? ' row' : ''}`} ref={dualBoxRef}>
            {/* ENTRAMBI i pannelli restano sempre nel DOM (in stretto il non
                visibile è display:none: mai un terminale smontato); la
                maniglia sparisce solo in stretto, dove non serve. */}
            {stretto
              ? (sideOnTop ? [paneSecondario, panePrincipale] : [panePrincipale, paneSecondario])
              : (sideOnTop ? [paneSecondario, maniglia, panePrincipale] : [panePrincipale, maniglia, paneSecondario])}
          </div>
        ) : (
          <Terminal session={session} node={node} token={token} readonly={readonly} takeSize sendRef={sendRef} composerRef={composerRef} actionRef={actionRef}
            ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} altRef={altRef} setAltArmed={setAltArmed} keyboardRef={keyboardRef} onFiles={onFilesCella} fontSize={fontSize}
            selectionMode={selectionMode} onSelectionModeChange={setSelectionMode}
            keyboardGesture={inputPreferences.terminalKeyboardGesture} onRendererChange={setRendererKind} />
        )}
        {/* D8: pannello in alternativa al terminale, overlay assoluto — il
            terminale resta montato (PTY vivo, nessun reflow al toggle).
            L'ingresso passa dal ticket: la PWA lo chiede e l'iframe punta
            alla nostra route (locale o federata), mai al panelUrl grezzo. */}
        {showPanel && panelUrl && panelCellId && (
          <CellPanel
            cellId={panelCellId}
            panelUrl={panelUrl}
            route={node ? node.split('/') : []}
            panelPort={panelPort}
            token={token}
            title={title}
          />
        )}
      </div>
      <KeyBar onKeyboard={() => setShowComposer((v) => !v)} onCellSwitcher={onCellSwitcher} cellSwitcherOpen={cellSwitcherOpen}
        send={(seq) => (focaLaSide ? sideSendRef : sendRef).current(seq)}
        action={(name) => (focaLaSide ? sideActionRef : actionRef).current(name)}
        ctrlArmed={ctrlArmed} onCtrl={toggleCtrl} altArmed={altArmed} onAlt={toggleAlt}
        onAltConsume={() => { const r = focaLaSide ? sideAltRef : altRef; r.current = false; setAltArmed(false); }}
        onKeyboardKeep={() => (focaLaSide ? sideKeyboardRef : keyboardRef).current?.()}
        selectionMode={selectionMode} onSelectionMode={setSelectionMode}
        keepKeyboardClosed={inputPreferences.keybarKeepsKeyboardClosed} showEnter={inputPreferences.showKeybarEnter}
        keybarLayout={inputPreferences.keybarLayout} />
      {showComposer && (
        <ComposerBar submitText={(text) => (focaLaSide ? sideComposerRef : composerRef).current(text)}
          token={token} session={focaLaSide ? side.session : session} node={focaLaSide ? side.node : node}
          ownerId={focaLaSide ? side.ownerId : ownerId} readonly={readonly}
          keepKeyboardClosedOnVoice={inputPreferences.voiceKeepsKeyboardClosed} />
      )}
      {files && (filesSide ? (
        <FilesPanel session={side.session} node={side.node} token={token} filesEvent={files.ev} onClose={() => setFiles(null)} />
      ) : files.source === 'main' ? (
        <FilesPanel session={session} node={node} token={token} filesEvent={files.ev} onClose={() => setFiles(null)} />
      ) : null)}
      {/* le quattro azioni della barra. Su mobile un foglio dal basso, su
          desktop un popover ancorato al ⋯: gli stessi due gusci delle azioni
          cella, nessun menu nuovo. */}
      {showBarMenu && (isDesktop ? (
        <CellActionsPopover anchorRect={barMenuRect} items={barItems} onClose={() => setShowBarMenu(false)} />
      ) : (
        <CellActionsSheet cellName={title} items={barItems} onClose={() => setShowBarMenu(false)} />
      ))}
    </div>
  );
}

export default function App() {
  useLang(); // re-render globale allo switch lingua
  const [boot] = useState(bootstrapFromFragment);
  const [token, setToken] = useState(boot.token);
  // il nodo LOCALE ha risposto 401 al token in uso: si riapre il prompt, senza toccare le preferenze.
  const [authInvalid, setAuthInvalid] = useState(false);
  usePrefsSync(authInvalid ? '' : token); // copia delle preferenze sul nodo (recupero dopo un wipe dello storage)
  const tokenRef = useRef(boot.token);
  tokenRef.current = token;
  useEffect(() => {
    const onInvalid = (event) => { if (event && event.detail && event.detail.token === tokenRef.current) setAuthInvalid(true); };
    window.addEventListener(AUTH_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, onInvalid);
  }, []);
  const submitToken = useCallback((value, remember) => {
    const saved = saveToken(value, { remember });
    if (!saved.ok || (remember && saved.where !== 'local')) {
      try { window.dispatchEvent(new CustomEvent(TOKEN_NOT_REMEMBERED_EVENT)); } catch (_) { /* fuori dal browser */ }
    }
    setAuthInvalid(false);
    setToken(value);
  }, []);
  // pairing deep-link (#pair) acquisito dal fragment e tenuto in sessionStorage:
  // se presente, apre il wizard precompilato. Consumato una volta (one-time invite).
  const [pairPending, setPairPending] = useState(boot.pair || '');
  const consumePair = useCallback(() => {
    setPairPending('');
    try { sessionStorage.removeItem('nc_pair'); } catch (_) {}
  }, []);
  const isDesktop = useDesktop();

  // Deck corrente: il path sceglie quello iniziale (anche per una finestra
  // staccata), poi i click cambiano tab internamente senza reload della PWA.
  const [initialDeck] = useState(() => deckLocationFromPath(typeof location !== 'undefined' ? location.pathname : '/'));
  const [deck, setDeck] = useState(initialDeck.id);
  const isMainDeck = deck === deckId(null, MAIN_DECK);

  // mobile single-view session: ref {session, node?} (node = nodo remoto B2)
  const [session, setSession] = useState(null);
  const pickSession = (ref) => {
    const parsed = parseRef(ref);
    setSession(parsed ? {
      ...parsed,
      ...(typeof ref?.cellName === 'string' && ref.cellName ? { cellName: ref.cellName } : {}),
    } : null);
  };

  // Doppia vista mobile: la seconda cella è uno stato del DISPOSITIVO
  // (localStorage, coppia {main, side}); il deck è una superficie desktop e
  // resta intatto. Il ripristino vale riaprendo la STESSA cella; chiudere il
  // pannello dimentica la coppia; se la cella affiancata sparisce, la vista
  // torna singola (onSideGone dalla lettura della vista).
  const [side, setSide] = useState(null);
  useEffect(() => {
    const saved = readSavedDual();
    setSide(saved && session && isSameRef(saved.main, session) ? saved.side : null);
  }, [session]);
  const toggleSideRow = (row) => {
    const mainRef = session ? { session: session.session, node: session.node } : null;
    const next = toggleSideRef(mainRef, side, row);
    setSide(next);
    if (next) writeSavedDual(mainRef, next); else clearSavedDual();
  };
  const chiudiSide = () => { setSide(null); clearSavedDual(); };

  // desktop workspace state
  const [dSessions, setDSessions] = useState([]);
  // Autorevolezza e istante dell'ultima lettura LOCALE: il nodo locale non ha
  // un gruppo in nodeGroups, quindi porta con se' gli stessi due dati che i
  // gruppi remoti espongono come sessionsAvailable / verifiedAt.
  const [localVerified, setLocalVerified] = useState(true);
  const [localSessionsAt, setLocalSessionsAt] = useState(null);
  const [cells, setCells] = useState([]);
  const [fleetCapabilities, setFleetCapabilities] = useState([]);
  // R27: lettura fleet non riuscita → lista esposta = ultima nota (stale)
  const [fleetStale, setFleetStale] = useState(false);
  // R27 rev3: fleet SPENTO (available:false del server) → zero celle vera
  const [fleetOff, setFleetOff] = useState(null);
  const [layout, setLayout] = useState(() => initialDeck.ownerId ? emptyLayout() : loadLayout(initialDeck.name));
  const [gridFocus, setGridFocus] = useState(null);   // refKey del tile focato
  const [single, setSingle] = useState(null);     // overlay vista singola desktop: ref {session, node?}
  const openSingle = (ref) => setSingle(parseRef(ref));
  // Sessione di un nodo VL nella vista larga (VL_NODES_IN_SIDEBAR): il peer
  // arriva dalla sidebar (vlNodeToPeer), la vista riusa VlNodeEvents.
  const [vlSession, setVlSession] = useState(null);
  // Gruppi per-nodo remoto (B2, design §5): polling separato, best-effort;
  // zero nodi configurati -> [] e workspace identico a oggi.
  const nodeGroups = useNodes(token, isDesktop);
  const deckOwners = useMemo(() => (nodeGroups || []).filter((g) => g.instanceId).map((g) => ({
    instanceId: g.instanceId, route: g.route, label: g.label, status: g.status, stale: g.stale === true, checking: g.checking === true,
  })), [nodeGroups]);
  // l'ordine dei DECKS in alto segue l'ordine della lista nodi/celle a
  // sinistra (nc_node_order_v1, per identita' — id/instanceId — mai per etichetta).
  const { order: deckNodeOrder } = useNodePreferences();
  const deckStore = useDecks(token, deck, layout, setLayout, deckOwners, deckNodeOrder);
  // L'avviso delle azioni cella (avvio/riavvio/stop): notice a scadenza su una
  // riga SUA sotto la barra dei deck — stessa meccanica del roster mobile
  // (useActionNotice, auto-clear 10 s). NON passa da deckStore.setError: la
  // barra deck resta per gli errori di deck, e niente messaggi che non si
  // tolgono più.
  const { notice: deckActionNotice, showActionNotice: mostraAvvisoDeck } = useActionNotice();
  const decks = deckStore.decks;
  // 0.8.8 salvava le celle remote come route:<cell-id> anziché usare la vera
  // tmuxSession route:cloud-<id>. Ripara una volta i deck esistenti, ma solo se
  // sul peer non esiste davvero una sessione unmanaged con quel nome.
  useEffect(() => {
    const replacements = new Map();
    for (const group of nodeGroups || []) {
      const routeKey = (group.route || [group.name]).join('/');
      const actual = new Set((group.sessions || []).map((session) => session.name));
      for (const cell of group.cells || []) {
        if (!cell.cell || !cell.tmuxSession || cell.cell === cell.tmuxSession || actual.has(cell.cell)) continue;
        replacements.set(`${routeKey}:${cell.cell}`, `${routeKey}:${cell.tmuxSession}`);
      }
    }
    setLayout((current) => remapTileRefs(current, replacements));
  }, [nodeGroups]);
  useEffect(() => {
    if (!deckStore.localNodeId) return;
    // Self-owner deck URL: `/deck/<thisNodeId>/<name>` names a LOCAL deck under
    // its owner-qualified id, so its layout is the one this browser saved. The
    // local node id only arrives with the config call, hence here and not in the
    // initial state — without this the first frame is the empty grid.
    if (initialDeck.ownerId && initialDeck.ownerId === deckStore.localNodeId) {
      setLayout((current) => (current.columns.some((column) => column.tiles.length)
        ? current : loadLayout(initialDeck.name)));
    }
  }, [deckStore.localNodeId]);
  // Overlay di disponibilita' (effimero): un tick per ogni lista owners nuova,
  // poi la risoluzione passa da viewUpdate — un flip di disponibilita' cambia
  // solo la vista, non lo stato sporco: nessun autosave, nessun PUT.
  useEffect(() => {
    if (!deckStore.localNodeId) return;
    tickOwnerAvailability(deckOwners);
    deckStore.viewUpdate((current) => {
      const resolved = resolveLayoutForViewer(current, deckStore.localNodeId, deckOwners);
      return JSON.stringify(resolved) === JSON.stringify(current) ? current : resolved;
    });
  }, [deckOwners, deckStore.localNodeId, deckStore.viewUpdate]);
  const [powerCell, setPowerCell] = useState(null);
  const [bootSettlement, setBootSettlement] = useState(null);
  const bootSettlementSeq = useRef(0);
  const [nodePowerBusy, setNodePowerBusy] = useState(false);
  const [sideW, setSideW] = useState(loadSideW);
  // Finestre staccate: nei deck non-main la sidebar e' nascosta di default;
  // il toggle vive nella DeckBar (in flow, mai sopra la freccia della sidebar).
  const [sideHidden, setSideHidden] = useState(!isMainDeck);
  const [sideMin, setSideMin] = useState(() => (isMainDeck ? localStorage.getItem(SIDE_MIN_KEY) === '1' : true));
  // Settings + first-run wizard (B2-UI, design §5).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('nodes');
  const [settingsNewCell, setSettingsNewCell] = useState(false);
  const [settingsLocation, setSettingsLocation] = useState('');
  const [cellSwitcherOpen, setCellSwitcherOpen] = useState(false);
  const openSettings = (tab = 'nodes', newCell = false, location = '') => {
    setSettingsTab(tab); setSettingsNewCell(newCell); setSettingsLocation(location); setSettingsOpen(true);
  };
  const [wizardOpen, setWizardOpen] = useState(false);
  // Il nome del dispositivo manca (host muto, es. Termux) e il setup è già
  // stato fatto: al primo accesso la PWA lo chiede una volta con un foglio
  // semplice. «Più tardi» vale per la sessione; al prossimo avvio ritorna.
  const [deviceAsk, setDeviceAsk] = useState(null);
  const [pairDefaults, setPairDefaults] = useState({
    deviceDefault: '', localNodeId: '', localNameDefault: '',
    deviceNameNeeded: false, deviceNameSuggestion: '',
  });
  // Il nome del NOSTRO nodo (es. VPSCloud), per l'intestazione del gruppo
  // locale nella lista delle celle: il gruppo locale si chiama come il nodo,
  // non «locale».
  const [localNodeLabel, setLocalNodeLabel] = useState('');
  // READONLY del server (da /api/config): l'attach dei terminali deve essere
  // read-only quando il server lo e' (coerenza col gate server §4b(6) + il
  // banner settings che lo dichiara). Default false finche' non arriva la config.
  const [roDefault, setRoDefault] = useState(false);
  // Porta pannello (P0 sicurezza 2026-08-16, da /api/config): origin DIVERSA
  // dal control plane. La porta LOCALE serve le celle di QUESTO nodo; le celle
  // remote usano la porta INOLTRATA del loro nodo (mappa nodePanelPorts,
  // negoziata nel pairing) — v. lib/panel-port.js e CellPanel.jsx. 0/assente
  // = non disponibile (config in arrivo, o peer accoppiato senza negoziazione
  // pannello): via storica, mai un frame verso porta 0.
  const [panelPort, setPanelPort] = useState(0);
  const [nodePanelPorts, setNodePanelPorts] = useState({});

  useEffect(() => {
    try { localStorage.setItem(SIDE_W_KEY, String(sideW)); } catch (_) {}
  }, [sideW]);
  useEffect(() => {
    try { localStorage.setItem(SIDE_MIN_KEY, sideMin ? '1' : ''); } catch (_) {}
  }, [sideMin]);

  // First-run wizard: GET /api/settings → firstRun. In READONLY il wizard non
  // appare (i mutanti sarebbero tutti 403: si configura dai settings, che
  // spiegano il blocco); il flag readonly arriva da /api/config (env inclusa).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([
      getSettings(token),
      apiFetch('/api/config', token).then((r) => r.json()),
    ]).then(([s, c]) => {
      if (cancelled) return;
      setPairDefaults({
        deviceDefault: s.deviceName || '',
        localNodeId: s.nodeId || '',
        localNameDefault: s.localName || '',
        deviceNameNeeded: s.deviceNameNeeded === true,
        deviceNameSuggestion: s.deviceNameSuggestion || '',
      });
      setLocalNodeLabel(s.deviceName || '');
      setRoDefault(!!c.readonlyDefault);
      // I parametri del terminale vivono nella config del server: il client li
      // usa da qui (backoff, liveness, coda, ritardo dell'overlay).
      setTerminalRuntimeConfig(c.terminal);
      setPanelPort(Number.isInteger(c.panelPort) ? c.panelPort : 0);
      setNodePanelPorts(c.nodePanelPorts && typeof c.nodePanelPorts === 'object' && !Array.isArray(c.nodePanelPorts)
        ? c.nodePanelPorts : {});
      if (s.firstRun === true && !c.readonlyDefault) setWizardOpen(true);
      else if (pairPending) setWizardOpen(true); // deep-link #pair: apri wizard sul pairing
      else if (s.deviceNameNeeded === true && !c.readonlyDefault) {
        // setup già fatto ma nome mancante: chiedilo ora (salta se rimandato in sessione)
        let rimandato = false;
        try { rimandato = sessionStorage.getItem('nc_device_ask_later') === '1'; } catch (_) { /* private mode */ }
        if (!rimandato) setDeviceAsk({ suggestion: s.deviceNameSuggestion || '' });
      }
    }).catch(() => { /* wizard best-effort: la UI resta usabile */ });
    return () => { cancelled = true; };
  }, [token, pairPending]);

  // Cella ospite Live: stato server-owned letto nel poll (best-effort, inerzia).
  // PER NODO (0.9.1 seconda meta'): una hostCell/hostLease/hostRevision sola,
  // globale, faceva si' che designare/leggere lo stato di una cella REMOTA
  // colpisse sempre e solo il nodo locale — la stella comandava il nodo
  // sbagliato. hostByRoute e' una mappa {hostRouteKey(route) -> {hostCell,
  // hostLease, hostRevision}}, una voce per nodo — 'local' e' il nodo che serve
  // la pagina, tutte le altre sono le route di nodeGroups.
  const [hostByRoute, setHostByRoute] = useState({});
  // Vista del Live host per UNA route (il nodo che possiede le celle mostrate).
  // `ownerId` non-local per una route non vuota: quella lettura arriva da un
  // peer, quindi il host e' di un altro nodo e la UI lo dice.
  // Esito del comando esplicito: hostByRoute cambia SUBITO (indicatore, puntino
  // e stella), senza aspettare il poll. Una designazione appena fatta non ha
  // ancora un thread, quindi `threadStatus: 'absent'` e' la verita' di adesso.
  const applyLiveHostResult = useCallback(({ route, hostCell, revision }) => {
    const key = hostRouteKey(route);
    setHostByRoute((current) => ({
      ...current,
      [key]: {
        hostCell: hostCell || null,
        hostLease: null,
        hostRevision: Number.isInteger(revision) ? revision : ((current[key] || {}).hostRevision || 0),
        threadStatus: 'absent',
      },
    }));
  }, []);

  const liveHostViewFor = (route) => {
    const key = hostRouteKey(route);
    const routeCells = route.length
      ? ((nodeGroups || []).find((g) => hostRouteKey(Array.isArray(g.route) ? g.route : []) === key) || {}).cells || []
      : cells;
    return liveHostView({
      liveHost: hostByRoute[key] || null,
      cells: routeCells,
      localNodeId: deckStore.localNodeId,
      ownerId: route.length ? key : deckStore.localNodeId,
    });
  };
  // Rif. sempre fresco a nodeGroups per il polling qui sotto: leggerlo via ref
  // (non come dependency dell'effect) evita di ricreare l'intervallo ogni volta
  // che useNodes produce un nuovo array (~4s, anche a dati invariati).
  const nodeGroupsRef = useRef(nodeGroups);
  useEffect(() => { nodeGroupsRef.current = nodeGroups; }, [nodeGroups]);
  // Guardia di non-sovrapposizione sul poll host del desktop. Il periodo e' 4 s
  // e da qui in poi ogni giro ha un tetto di POLL_TIMEOUT_MS: il tetto limita
  // quanto DURA un giro, non impedisce che due coesistano — un tick parte
  // comunque ogni 4 s, e senza guardia la risposta piu' VECCHIA puo' atterrare
  // dopo la piu' nuova, riportando la lista a un esito superato. Stesso rimedio
  // di useNodes.js. (Il poll sessions+flotta e' passato al treno condiviso di
  // lib/fleet-poll.js, che porta la stessa guardia dentro il proprio ciclo.)
  const loadGuardRef = useRef(null);
  if (!loadGuardRef.current) loadGuardRef.current = createPollGuard();
  // Tetto di tempo per RICHIESTA, non per giro: e' il massimo che una singola
  // lettura del poll puo' restare appesa. Un giro ne fa DUE in sequenza
  // (sessioni, poi flotta), quindi puo' durare fino a circa il doppio di
  // questo valore e sforare il periodo di 4 s — ed e' esattamente il caso che
  // la guardia copre, saltando i tick che arrivano nel frattempo. Serve
  // perche' una connessione aperta che non risponde non produce mai un
  // errore: senza tetto il `finally` che libera la guardia non scatterebbe e
  // il poll resterebbe fermo fino al limite del browser (~300 s), senza che
  // nessun tick possa recuperare. Il treno condiviso usa lo stesso tetto
  // (FLEET_POLL_TIMEOUT_MS).
  const POLL_TIMEOUT_MS = 3500;
  // hostByRoute e' server-owned e vale per DESKTOP e MOBILE: polling separato dal
  // poll sessions/fleet (desktop-only), best-effort, nessun retry (inerzia). Una
  // route irraggiungibile o senza liveHostAccess non tocca le altre voci della
  // mappa: resta lo stato precedente per quella sola route (stesso principio
  // "best-effort per-owner" gia' usato per i nodi VL in useNodes.js).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const guard = loadGuardRef.current;
      const turno = guard.begin();
      // Un giro e' gia' in volo: il tick si SALTA. La lettura host passa dai
      // peer e puo' durare piu' del periodo di poll.
      if (turno === null) return;
      try {
      const routes = [[], ...(nodeGroupsRef.current || [])
        .filter((g) => g.kind !== 'vl' && g.status === 'up')
        .map((g) => (Array.isArray(g.route) && g.route.length ? g.route : [g.name]))];
      const entries = await Promise.all(routes.map(async (route) => {
        const key = hostRouteKey(route);
        try {
          const h = await getLiveHost(token, route, { timeoutMs: POLL_TIMEOUT_MS });
          return [key, {
            hostCell: h && typeof h.hostCell === 'string' ? h.hostCell : null,
            hostLease: h && h.host && typeof h.host.lease === 'string' ? h.host.lease : null,
            hostRevision: Number.isInteger(h && h.revision) ? h.revision : 0,
            threadStatus: h && THREAD_STATUSES.has(h.threadStatus) ? h.threadStatus : 'unknown',
          }];
        } catch (_) { return [key, { error: true }]; }
      }));
      if (cancelled) return;
      if (!guard.isCurrent(turno)) return;
      setHostByRoute((current) => {
        let changed = false; const next = { ...current };
        for (const entry of entries) {
          if (!entry) continue;
          const [key, value] = entry;
          next[key] = value.error
            ? { ...(current[key] || {}), threadStatus: 'unknown' }
            : value;
          changed = true;
        }
        return changed ? next : current;
      });
      } finally {
        guard.end(turno);
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
      // Il giro in volo non e' piu' quello corrente: se atterra, non scrive.
      // E la guardia e' libera, cosi' il prossimo effetto parte subito invece
      // di farsi saltare il primo tick.
      loadGuardRef.current.reset();
    };
  }, [token]);

  // Polling sessions + flotta (solo desktop: su mobile pensa SessionList).
  // Le letture passano dal treno condiviso di lib/fleet-poll.js — un
  // solo giro per route per finestra (striscia, cella affiancata e questo poll
  // condividono il treno locale), con dentro la stessa guardia di prima (tick
  // saltato se un giro e' in volo, esiti superati scartati) e lo stesso tetto
  // per richiesta. La policy che applica gli esiti resta quella di sempre,
  // parola per parola.
  useEffect(() => {
    if (!isDesktop) return undefined;
    const apply = (snap) => {
      if (!snap) return;
      const j = snap.sessionsError ? null : snap.sessionsJson;
      // La lettura LOCALE e' autorevole solo quando ha risposto davvero: un
      // errore non svuota la lista (l'ultima nota resta) e non la promuove
      // nemmeno a prova di assenza — la marca non verificata, come i peer.
      if (j && !j.error) {
        setDSessions(j.sessions || []);
        setLocalVerified(true);
        setLocalSessionsAt(snap.at);
      } else {
        setLocalVerified(false);
      }
      // R27: stessa policy pura della home mobile (lib/fleet-read-policy.js) —
      // un fallimento di lettura NON svuota la lista: non e' «zero celle»,
      // resta l'ultima nota con l'indicatore stale in sidebar.
      const fleet = fleetReadOutcome({ fs: snap.fs, error: snap.fleetError });
      if (fleet.kind === 'data') {
        saveLastRoster('local', fleet.cells);
        setCells(fleet.cells);
        setFleetCapabilities(fleet.capabilities);
        setFleetStale(false);
        setFleetOff(null);
      } else if (fleet.kind === 'stale') {
        // Cache in memoria vuota (PWA riaperta): riparte dall'ultimo roster buono salvato, marcato come non vivo.
        setCells((current) => (current.length ? current : loadLastRoster('local')));
        setFleetStale(true);
        setFleetOff(null);
      } else {
        setCells([]);
        saveLastRoster('local', []);
        setFleetCapabilities([]);
        setFleetStale(false);
        setFleetOff(fleet.reason || '');
      }
    };
    apply(readFleetRoute([]));
    return subscribeFleetRoute(token, [], apply);
  }, [isDesktop, token]);
  // Designazione cella ospite: API-first. designate imposta hostByRoute[route]
  // riflettendo la risposta del server (mai ottimismo pre-response); clear
  // ritorna un boolean cosi' la Sidebar rimuove il pin locale solo a riuscita
  // del clear. `route` e' quella del nodo che POSSIEDE la cella su cui si preme
  // la stella — locale ([]) o remota — mai quella (implicita) del nodo che
  // serve la pagina: e' esattamente il difetto che questa funzione chiude.
  // Il fallimento NOMINA la causa (window.alert, come promptNodeRename in
  // Sidebar): il difetto peggiore non era la route sbagliata, era il silenzio.
  // Una sola designazione, due modi di dire l'esito: la home continua a
  // mostrare l'avviso di sistema (comportamento invariato), il selettore
  // compatto riceve l'esito e lo mostra nella propria riga di stato — senza
  // alert, che su un telefono e' un blocco a tutto schermo.
  const designateCellHostOnce = useCallback(async (cellId, route = []) => {
    const key = hostRouteKey(route);
    const revision = (hostByRoute[key] && hostByRoute[key].hostRevision) || 0;
    try {
      const r = await designateHostCell(token, cellId, revision, route);
      setHostByRoute((current) => ({
        ...current,
        [key]: {
          hostCell: r.hostCell || null,
          hostLease: r.host && typeof r.host.lease === 'string' ? r.host.lease : null,
          hostRevision: Number.isInteger(r.revision) ? r.revision : revision,
          threadStatus: THREAD_STATUSES.has(r.threadStatus) ? r.threadStatus : 'unknown',
        },
      }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }, [token, hostByRoute]);
  const designateCellHost = useCallback(async (cellId, route = []) => {
    const outcome = await designateCellHostOnce(cellId, route);
    if (!outcome.ok) window.alert(t(hostDesignationFailureMessage(outcome.error)));
    return outcome.ok;
  }, [designateCellHostOnce]);
  const clearCellHostOnce = useCallback(async (route = []) => {
    const key = hostRouteKey(route);
    const revision = (hostByRoute[key] && hostByRoute[key].hostRevision) || 0;
    try {
      const r = await clearHostCell(token, revision, route);
      setHostByRoute((current) => ({
        ...current,
        [key]: { hostCell: r.hostCell || null, hostLease: null, hostRevision: Number.isInteger(r.revision) ? r.revision : revision, threadStatus: 'unknown' },
      }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }, [token, hostByRoute]);
  // Versione della home: esito booleano (il pin si toglie solo a clear riuscito)
  // e avviso di sistema che nomina la causa.
  const clearCellHost = useCallback(async (route = []) => {
    const outcome = await clearCellHostOnce(route);
    if (!outcome.ok) window.alert(t(hostDesignationFailureMessage(outcome.error)));
    return outcome.ok;
  }, [clearCellHostOnce]);

  // Coerenza versione UI/server (tutte le viste).
  //
  // PERIODICO, non solo al mount. Il controllo girava una volta sola
  // all'avvio: un'app LASCIATA APERTA non se ne accorgeva mai, e quella e'
  // esattamente la situazione da coprire — il nodo si aggiorna da solo e si
  // riavvia mentre l'app e' aperta davanti a qualcuno. Con un solo controllo
  // iniziale il ricaricamento automatico valeva soltanto riaprendo l'app, cioe'
  // il gesto che doveva togliere di mezzo. Rilievo dell'audit indipendente.
  //
  // Un minuto: e' una GET piccola verso il proprio hub, e il ritardo massimo
  // fra «il nodo e' ripartito nuovo» e «l'interfaccia se ne accorge» diventa
  // quello invece di essere indefinito.
  useEffect(() => {
    let cancelled = false;
    const controlla = () => {
      apiFetch('/api/config', token).then((r) => r.json()).then((j) => {
        if (!cancelled && typeof __NC_BUILD_VERSION__ !== 'undefined')
          reportServerVersions(j.version, j.uiVersion, __NC_BUILD_VERSION__);
      }).catch(() => {});
    };
    controlla();
    const timer = setInterval(controlla, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [token]);

  // Vivacita' per refKey: nomi locali + chiavi "nodo:sessione" dei nodi su.
  const sessionsAlive = new Set([
    ...dSessions.map((s) => s.name),
    ...nodeGroups.flatMap((g) => g.sessions.map((s) => s.key)),
  ]);
  // Identita' delle sessioni LOCALI (refKey -> `created` di tmux), per il
  // secondo trigger di generazione: un cambio di identita' fra due letture
  // autorevoli. Le sessioni remote portano `created` dentro il gruppo, quindi
  // non passano di qui.
  const localIdentities = useMemo(() => {
    const mappa = new Map();
    for (const s of dSessions) {
      if (s && typeof s.name === 'string' && Number.isFinite(s.created)) mappa.set(s.name, s.created);
    }
    return mappa;
  }, [dSessions]);
  const activeSessions = sessions(layout); // refKeys dei tile aperti

  // --- actions ---
  const onAddTile = (name) => setLayout((l) => {
    const owned = refWithOwner(name, deckStore.localNodeId, deckOwners) || name;
    const next = addTileSmart(l, owned);
    if (next === l && sessions(l).length >= 9) {
      deckStore.setError(t('grid-full'));
    }
    return next;
  });
  const onKill = async (name, route = []) => {
    try { await killSession(token, name, route); } catch (_) { return; }
    const key = route.length ? `${route.join('/')}:${name}` : name;
    setLayout((l) => removeTile(l, key));
    poll();
  };
  const onVisibility = async (name, technical, route = []) => {
    try { await setSessionTechnical(token, name, technical, route); } catch (_) { return; }
    poll();
  };
  // Il boot e' una preferenza di riavvio indipendente dal lifecycle corrente:
  // questo toggle non accende ne' spegne la cella. PowerSheet continua a poter
  // aggiornare la stessa proprieta' durante un'azione on/off.
  const onBoot = async (cell, enabled, route = []) => {
    await fleetBoot(token, { cell, enabled: !!enabled }, route);
    poll();
  };
  const onFleetConfirm = async (payload) => {
    if (!powerCell) return;
    const { cell } = powerCell;
    const route = Array.isArray(powerCell.route) ? powerCell.route : [];
    // Stesso percorso del roster mobile: esiti benigni (timeout client,
    // sessione già attiva) come notice a SCADENZA su una riga sua sotto la
    // barra — mai dentro la barra, dove il messaggio copriva i chip e non
    // si toglieva più. Gli errori veri vengono rilanciati: restano nel foglio,
    // che li mostra coi pulsanti riabilitati. La barra deck parla solo di
    // deck: il suo errore resta quello di caricamento/salvataggio/owner.
    const benign = await runFleetPowerAction({ token, powerCell, payload, onNotice: mostraAvvisoDeck });
    if (!benign) {
      const enabled = payload.action === 'up'
        ? !!payload.boot
        : (payload.boot ? false : !!powerCell.boot);
      setBootSettlement({ id: ++bootSettlementSeq.current, cell, route, enabled });
    }
    poll();
  };
  const onBootSettlementApplied = useCallback((id) => {
    setBootSettlement((current) => (current?.id === id ? null : current));
  }, []);
  const onNodePower = async (group) => {
    if (!group?.direct || nodePowerBusy) return;
    setNodePowerBusy(true);
    try { await nodeAction(token, group.name, group.tunnelStatus === 'up' ? 'down' : 'up'); }
    finally { setNodePowerBusy(false); }
  };
  const onNodeRename = async (group, value) => {
    const label = String(value || '').trim();
    if (!group?.direct || !isValidLabel(label)) return false;
    await renameNodeLabel(token, group.name, label);
    return true;
  };

  // --- deck actions (§5b) ---
  const openDeckWindow = (id) => {
    const target = decks.find((d) => d.id === id); if (!target) return false;
    try { const w = window.open(deckUrl(target, token), '_blank'); if (w) w.opener = null; return !!w; } catch (_) { return false; }
  };
  const selectDeck = async (id) => {
    if (!id || id === deck) return;
    const nextLayout = await deckStore.select(id);
    const target = deckStore.records.find((d) => d.id === id);
    setDeck(id); setLayout(nextLayout); setGridFocus(null); setSingle(null);
    try { history.replaceState(null, '', deckUrl(target || id, null)); } catch (_) {}
  };
  const onCreateDeck = async (name, ownerId) => {
    const created = await deckStore.add(name, ownerId);
    await selectDeck(created.id);
  };
  const onRenameDeck = async (from, to) => {
    const saved = await deckStore.rename(from, to);
    if (from === deck) {
      setDeck(saved.id);
      // Anche qui le flottanti del record rientrano materializzate —
      // installare solo il layout le cancellava al prossimo autosave.
      setLayout(deckStore.vistaMaterializzata(saved));
      setGridFocus(null); setSingle(null);
      try { history.replaceState(null, '', deckUrl(saved, null)); } catch (_) {}
    }
  };
  const onDeleteDeck = async (id) => {
    await deckStore.remove(id);
    if (id === deck) await selectDeck(deckStore.localMainId);
  };
  // "manda al deck X": aggiunge il tile al layout del deck bersaglio. Le altre
  // finestre convergono tramite il poll server-side di useDecks (massimo 5 s).
  const onSendToDeck = async (name, target) => {
    if (!target || target === deck) return;
    await deckStore.addTileTo(target, name);
    setLayout((l) => removeTile(l, name));
  };

  if (!token || authInvalid) return <LoginScreen onSubmit={submitToken} reason={authInvalid ? 'invalid' : ''} />;

  // Overlay condivisi mobile/desktop: settings panel + first-run wizard (B2-UI)
  // + centro notifiche/ask del MCP bridge (SSE /api/events, presente ovunque).
  const settingsOverlays = (
    <>
      {settingsOpen && <SettingsPanel token={token} initialTab={settingsTab} initialLocation={settingsLocation} startNewCell={settingsNewCell}
        onClose={() => { setSettingsOpen(false); setSettingsNewCell(false); setSettingsLocation(''); }} />}
      {wizardOpen && (
        <Wizard token={token} initialPair={pairPending} {...pairDefaults}
          onPairDone={consumePair} onDone={() => setWizardOpen(false)} />
      )}
      {deviceAsk && (
        <DeviceNameAsk token={token} suggestion={deviceAsk.suggestion}
          onSaved={(nome) => {
            setLocalNodeLabel(nome);
            setPairDefaults((d) => ({ ...d, deviceDefault: nome, deviceNameNeeded: false }));
            setDeviceAsk(null);
          }}
          onLater={() => {
            try { sessionStorage.setItem('nc_device_ask_later', '1'); } catch (_) { /* private mode */ }
            setDeviceAsk(null);
          }} />
      )}
      <NotifyCenter token={token} />
    </>
  );

  // Flusso mobile INTATTO (aggiunta B2: voce settings nell'header della home).
  if (!isDesktop) {
    if (vlSession) {
      // La sessione del nodo VL a schermo pieno anche su mobile: stessa
      // vista (VlSessionView) e stesso overlay del desktop — mai dentro una
      // scheda stretta.
      return (
        <>
          <div className="nc-single-overlay">
            <VlSessionView peer={vlSession} token={token} onBack={() => setVlSession(null)} />
          </div>
          {settingsOverlays}
        </>
      );
    }
    if (!session) {
      return (
        <>
          <SessionList onPick={pickSession} token={token} onSettings={openSettings} onOpenVlSession={setVlSession}
            panelPort={panelPort} nodePanelPorts={nodePanelPorts}
            hostByRoute={hostByRoute} onDesignateCell={designateCellHost} onClearHostCell={clearCellHost} />
          {settingsOverlays}
        </>
      );
    }
    return <>
      <SingleView session={session.session} node={session.node} ownerId={session.ownerId} cellName={session.cellName} token={token} readonly={roDefault}
          liveHost={liveHostViewFor(session.node ? session.node.split('/') : [])}
        panelPort={panelPortForRoute(session.node ? session.node.split('/') : [], nodePanelPorts, panelPort)}
        side={side} onSideClose={chiudiSide} onSideGone={chiudiSide}
        onBack={() => setSession(null)} onCellSwitcher={() => setCellSwitcherOpen(true)} cellSwitcherOpen={cellSwitcherOpen} />
      {cellSwitcherOpen && <CellSwitcher token={token} current={session} localNodeLabel={localNodeLabel}
        panelPort={panelPort} nodePanelPorts={nodePanelPorts}
        hostByRoute={hostByRoute} onDesignateCell={designateCellHostOnce} onClearHostCell={clearCellHostOnce}
        onLiveHostApplied={applyLiveHostResult}
        sideKey={side ? positionKey(side.node ? side.node.split('/') : [], side.session) : null}
        onToggleSide={toggleSideRow}
        onPick={(next) => { pickSession(next); setCellSwitcherOpen(false); }} onClose={() => setCellSwitcherOpen(false)} />}
      {settingsOverlays}
    </>;
  }

  // Workspace desktop: Sidebar + GridView + overlay vista singola + dialoghi.
  const sidebarVisible = isMainDeck || !sideHidden;
  return (
    <div className="nc-workspace">
      {sidebarVisible && (
        <Sidebar
          sessions={dSessions}
          cells={cells}
          // La rail dichiara il degrado come fa il roster mobile: senza questo
          // l'ultima lettura locale fallita resta presentata come autorevole.
          localVerified={localVerified}
          activeSessions={activeSessions}
          nodeGroups={nodeGroups}
          token={token}
          onPeekOpen={() => setCellSwitcherOpen(false)}
          overlayOpen={cellSwitcherOpen}
          fleetCapabilities={fleetCapabilities}
          fleetStale={fleetStale}
          fleetOff={fleetOff}
          bootSettlement={bootSettlement}
          onBootSettlementApplied={onBootSettlementApplied}
          localNodeId={deckStore.localNodeId}
          hostByRoute={hostByRoute}
          onDesignateCell={designateCellHost}
          onClearHostCell={clearCellHost}
          onPick={openSingle}
          onAddTile={onAddTile}
          onPower={setPowerCell}
          onBoot={onBoot}
          onBootError={(error) => deckStore.setError(String(error?.message || error))}
          onNodePower={onNodePower}
          onNodeRename={onNodeRename}
          onKill={onKill}
          onVisibility={onVisibility}
          onNew={() => openSettings('fleet', true)}
          onSettings={openSettings}
          onOpenVlSession={setVlSession}
          width={sideW}
          collapsed={sideMin}
          onResize={setSideW}
          onToggleCollapse={() => setSideMin((v) => !v)}
        />
      )}
      <div className="nc-workspace-main">
        <DeckBar
          decks={decks} currentDeck={deck}
          onCreate={onCreateDeck} onRename={onRenameDeck} onDelete={onDeleteDeck}
          onReorder={deckStore.reorder}
          onOpenWindow={openDeckWindow} onNavigate={selectDeck}
          saveState={deckStore.saveState} error={deckStore.error}
          conflict={deckStore.conflict} onReloadDeck={deckStore.reloadCurrent}
          sidebarVisible={sidebarVisible}
          onToggleSidebar={!isMainDeck ? () => setSideHidden((v) => !v) : null}
        />
        {/* L'avviso delle azioni cella: riga SUA sotto la barra — mai dentro
            .nc-deckbar, così non copre i chip. Il testo intero sta nel title
            se la riga lo tronca, e scade da solo (useActionNotice). */}
        {deckActionNotice && (
          <div className="nc-notice nc-deck-notice" role="status" title={deckActionNotice}>{deckActionNotice}</div>
        )}
        <GridView
          layout={layout}
          onLayoutChange={setLayout}
          onResizeEnd={() => { deckStore.saveNow(); }}
          token={token}
          readonly={roDefault}
          sessionsAlive={sessionsAlive}
          localVerified={localVerified}
          localIdentities={localIdentities}
          localVerifiedAt={localSessionsAt}
          focusSession={gridFocus}
          onFocus={setGridFocus}
          onOpenSingle={openSingle}
          decks={decks}
          currentDeck={deck}
          onSendToDeck={onSendToDeck}
          cells={cells}
          nodeGroups={nodeGroups}
          panelPort={panelPort}
          nodePanelPorts={nodePanelPorts}
        />
      </div>

      {vlSession && (
        <div className="nc-single-overlay">
          <VlSessionView peer={vlSession} token={token} onBack={() => setVlSession(null)} />
        </div>
      )}
      {single && (
        <div className="nc-single-overlay">
          <SingleView
            session={single.session} node={single.node} ownerId={single.ownerId}
            cellName={cellDisplayName({ session: single.session, node: single.node, ownerId: single.ownerId, cells, nodeGroups })}
            token={token} readonly={roDefault}
            liveHost={liveHostViewFor(single.node ? single.node.split('/') : [])}
            panelPort={panelPortForRoute(single.node ? single.node.split('/') : [], nodePanelPorts, panelPort)}
            onBack={() => setSingle(null)}
          />
        </div>
      )}
      {powerCell && (
        <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : []} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}
      {settingsOverlays}
    </div>
  );
}
