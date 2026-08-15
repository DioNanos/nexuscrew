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
import NotifyCenter from './components/NotifyCenter.jsx';
import CellSwitcher from './components/CellSwitcher.jsx';
import VlSessionView from './components/VlSessionView.jsx';
import CellPanel from './components/CellPanel.jsx';
import {
  apiFetch, fleetStatus, fleetUp, fleetDown, fleetBoot, killSession, getSettings, nodeAction, renameNodeLabel, setSessionTechnical,
  getLiveHost, designateHostCell, clearHostCell,
} from './lib/api.js';
import { isValidLabel } from './lib/settings-model.js';
import { upActionNotice } from './lib/fleet-action-notice.js';
import { emptyLayout, normalize, addTileSmart, removeTile, sessions, parseRef, remapTileRefs } from './lib/grid-model.js';
import { cellDisplayName } from './lib/cell-display.js';
import {
  MAIN_DECK, deckLocationFromPath, deckUrl, readLayoutRaw,
} from './lib/deck-model.js';
import { deckId, refWithOwner, resolveLayoutForViewer } from './lib/deck-federation.js';
import {t} from './lib/i18n.js';
import { useLang } from './hooks/useLang.js';
import { useNodes } from './hooks/useNodes.js';
import { useDecks } from './hooks/useDecks.js';
import { useInputPreferences } from './hooks/useInputPreferences.js';
import { reportServerVersions } from './lib/sw-update.js';
import { parseBootstrapHash } from './lib/fragment.js';
import './App.css';

const FONT_MIN = 9;
const FONT_MAX = 24;
const SIDE_W_KEY = 'nc_side_w';
const SIDE_MIN_KEY = 'nc_side_min';
const SIDE_W_DEF = 240;
const MQ_DESKTOP = '(min-width:1024px) and (pointer:fine)';

function loadSideW() {
  const v = Number(localStorage.getItem(SIDE_W_KEY));
  return v >= 180 && v <= 480 ? v : SIDE_W_DEF;
}

function initialFontSize() {
  const v = Number(localStorage.getItem('nc_fontsize'));
  return v >= FONT_MIN && v <= FONT_MAX ? v : 13;
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
    const { token, pair, nextUrl } = parseBootstrapHash({
      hash: location.hash, origin: location.origin, pathname: location.pathname, search: location.search,
    });
    if (token) {
      out.token = token;
      try { localStorage.setItem('nc_token', token); } catch (_) {}
    }
    if (pair) {
      out.pair = pair;
      try { sessionStorage.setItem('nc_pair', pair); } catch (_) {}
    }
    // rimuove il fragment sensibile (token e/o pair), preserva path + query.
    if (location.hash) { try { history.replaceState(null, '', nextUrl); } catch (_) {} }
  } catch (_) { /* best-effort: la UI resta usabile */ }
  if (!out.token) out.token = sessionStorage.getItem('nc_token') || localStorage.getItem('nc_token') || '';
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

// Desktop = schermo largo E puntatore fine (mouse). Risponde al cambio (resize/rotate).
function useDesktop() {
  const [d, setD] = useState(() => window.matchMedia(MQ_DESKTOP).matches);
  useEffect(() => {
    const mq = window.matchMedia(MQ_DESKTOP);
    const h = (e) => setD(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return d;
}

// Vista singola autosufficiente: usata dal flusso mobile e dall'overlay desktop.
// Comportamento intatto rispetto alla vista singola pre-griglia.
// node (opzionale, B2): sessione su nodo remoto via proxy /node/<name>.
// cellName (opzionale, Tranche D): titolo logico Fleet gia' risolto dal roster
// (desktop overlay). Se assente (mobile), la lookup fleetStatus esistente lo
// risolve al primo ciclo. Il titolo visibile deriva sempre da `cell.cell`.
export function SingleView({ session, node, ownerId, cellName, token, readonly = false, onBack, onCellSwitcher, cellSwitcherOpen = false }) {
  useLang(); // re-render allo switch lingua
  const [inputPreferences] = useInputPreferences();
  const [showFiles, setShowFiles] = useState(false);
  // Su touch il composer è aperto di default (l'IME Gboard corrompe l'input in xterm).
  const [showComposer, setShowComposer] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const [filesEvent, setFilesEvent] = useState(null);
  const [fontSize, setFontSize] = useState(initialFontSize);
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
  const zoom = (delta) => setFontSize((v) => {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, v + delta));
    localStorage.setItem('nc_fontsize', String(next));
    return next;
  });
  const sendRef = useRef(() => {});
  const composerRef = useRef(() => false);
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const toggleCtrl = () => { ctrlRef.current = !ctrlRef.current; setCtrlArmed(ctrlRef.current); };

  // SingleView may be reused at the same React position when the operator
  // switches cells. Synchronize immediately instead of showing the previous
  // title until the first fleetStatus poll completes.
  useEffect(() => { setTitle(cellName || session); setShowPanel(false); }, [cellName, session]);

  // Sottotitolo header: "engine·key" se la sessione è una cella, altrimenti
  // "attached · Nm" (o tempo relativo). Dati da /api/sessions + /api/fleet/status
  // del nodo che possiede la sessione (Locale o route remota via proxy). La Fleet
  // non e' piu' un concetto solo-locale: una sessione remota su un nodo che ha
  // capability fleet mostra comunque engine/model (parita' mobile/desktop).
  useEffect(() => {
    let alive = true;
    const route = node ? node.split('/') : [];
    const base = node ? `/api/route/${node.split('/').map(encodeURIComponent).join('/')}/_` : '/api';
    async function load() {
      let sess = null; let cell = null;
      try {
        const r = await apiFetch(`${base}/sessions`, token);
        const j = await r.json();
        if (Array.isArray(j.sessions)) sess = j.sessions.find((s) => s.name === session);
      } catch (_) { /* best-effort */ }
      try {
        const fs = await fleetStatus(token, route);
        if (fs.available && Array.isArray(fs.cells)) cell = fs.cells.find((c) => c.tmuxSession === session);
      } catch (_) { /* best-effort: nodo senza capability fleet */ }
      if (!alive) return;
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
      let txt = '';
      if (cell) txt = `${cell.engine}${cell.key ? `·${cell.key}` : ''}`;
      else if (sess) txt = sess.attached ? `attached · ${rel(sess.activity)}` : (sess.activity ? rel(sess.activity) : '');
      setSub(txt);
    }
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [session, node, token]);

  return (
    <div className="nc-app">
      <header className="nc-bar nc-bar-single">
        <button onClick={onBack} title={t('sessions')}><Icon name="chevronLeft" size={18} /><span className="nc-bar-label">{t('sessions')}</span></button>
        <span className="nc-bar-center">
          <b title={node ? `${title} · ${node}` : title}>{title}</b>
          {sub && <small className="nc-bar-sub">{sub}</small>}
        </span>
        <span className="nc-bar-right">
          <button onClick={() => zoom(-1)} title={t('zoom-out')}><Icon name="zoomOut" size={18} /></button>
          <button onClick={() => zoom(+1)} title={t('zoom-in')}><Icon name="zoomIn" size={18} /></button>
          <button onClick={() => setShowComposer((v) => !v)} title={t('composer')}><Icon name="keyboard" size={20} /></button>
          <button onClick={() => setShowFiles((v) => !v)} title={t('files')}><Icon name="folder" size={20} /></button>
          {panelUrl && (
            <button onClick={() => setShowPanel((v) => !v)} title={t('panel')} aria-pressed={showPanel}><Icon name="monitor" size={20} /></button>
          )}
        </span>
      </header>
      <div className="nc-termwrap">
        <Terminal session={session} node={node} token={token} readonly={readonly} takeSize sendRef={sendRef} composerRef={composerRef} actionRef={actionRef}
          ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} onFiles={setFilesEvent} fontSize={fontSize}
          selectionMode={selectionMode} onSelectionModeChange={setSelectionMode}
          keyboardGesture={inputPreferences.terminalKeyboardGesture} />
        {/* D8: pannello in alternativa al terminale, overlay assoluto — il
            terminale resta montato (PTY vivo, nessun reflow al toggle).
            L'ingresso passa dal ticket: la PWA lo chiede e l'iframe punta
            alla nostra route (locale o federata), mai al panelUrl grezzo. */}
        {showPanel && panelUrl && panelCellId && (
          <CellPanel
            cellId={panelCellId}
            panelUrl={panelUrl}
            route={node ? node.split('/') : []}
            token={token}
            title={title}
          />
        )}
      </div>
      <KeyBar onKeyboard={() => setShowComposer((v) => !v)} onCellSwitcher={onCellSwitcher} cellSwitcherOpen={cellSwitcherOpen}
        send={(seq) => sendRef.current(seq)} action={(name) => actionRef.current(name)}
        ctrlArmed={ctrlArmed} onCtrl={toggleCtrl} selectionMode={selectionMode} onSelectionMode={setSelectionMode}
        keepKeyboardClosed={inputPreferences.keybarKeepsKeyboardClosed} showEnter={inputPreferences.showKeybarEnter}
        keybarLayout={inputPreferences.keybarLayout} />
      {showComposer && (
        <ComposerBar submitText={(text) => composerRef.current(text)} token={token} session={session} node={node} ownerId={ownerId}
          keepKeyboardClosedOnVoice={inputPreferences.voiceKeepsKeyboardClosed} />
      )}
      {showFiles && (
        <FilesPanel session={session} node={node} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
      )}
    </div>
  );
}

export default function App() {
  useLang(); // re-render globale allo switch lingua
  const [boot] = useState(bootstrapFromFragment);
  const [token, setToken] = useState(boot.token);
  // pairing deep-link (#pair) acquisito dal fragment e tenuto in sessionStorage:
  // se presente, apre il wizard precompilato. Consumato una volta (one-time invite).
  const [pairPending, setPairPending] = useState(boot.pair || '');
  const consumePair = useCallback(() => {
    setPairPending('');
    try { sessionStorage.removeItem('nc_pair'); } catch (_) {}
  }, []);
  const [remember, setRemember] = useState(false);
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

  // desktop workspace state
  const [dSessions, setDSessions] = useState([]);
  const [cells, setCells] = useState([]);
  const [fleetCapabilities, setFleetCapabilities] = useState([]);
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
    instanceId: g.instanceId, route: g.route, label: g.label, status: g.status,
  })), [nodeGroups]);
  const deckStore = useDecks(token, deck, layout, setLayout, deckOwners);
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
    setLayout((current) => {
      const resolved = resolveLayoutForViewer(current, deckStore.localNodeId, deckOwners);
      return JSON.stringify(resolved) === JSON.stringify(current) ? current : resolved;
    });
  }, [deckOwners, deckStore.localNodeId]);
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
  const [pairDefaults, setPairDefaults] = useState({
    deviceDefault: '', localNodeId: '', localNameDefault: '',
  });
  // READONLY del server (da /api/config): l'attach dei terminali deve essere
  // read-only quando il server lo e' (coerenza col gate server §4b(6) + il
  // banner settings che lo dichiara). Default false finche' non arriva la config.
  const [roDefault, setRoDefault] = useState(false);

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
      });
      setRoDefault(!!c.readonlyDefault);
      if (s.firstRun === true && !c.readonlyDefault) setWizardOpen(true);
      else if (pairPending) setWizardOpen(true); // deep-link #pair: apri wizard sul pairing
    }).catch(() => { /* wizard best-effort: la UI resta usabile */ });
    return () => { cancelled = true; };
  }, [token, pairPending]);

  // Cella ospite Live: stato server-owned letto nel poll (best-effort, inerzia).
  const [hostCell, setHostCell] = useState(null);
  // Stato del lease dell'host designato (seam 2026-08-15). Distinto da hostCell:
  // quello dice CHI e' designato, questo se la designazione ha ancora una
  // supervisione viva dietro. Null quando il server non lo espone — mai un
  // valore inventato per riempire lo spazio.
  const [hostLease, setHostLease] = useState(null);
  const [hostRevision, setHostRevision] = useState(0);
  const poll = useCallback(async () => {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (!j.error) setDSessions(j.sessions || []);
    } catch (_) { /* best-effort */ }
    try {
      const fs = await fleetStatus(token);
      setCells(fs.available ? (fs.cells || []) : []);
      setFleetCapabilities(fs.available ? (fs.capabilities || []) : []);
    } catch (_) { setCells([]); setFleetCapabilities([]); }
  }, [token]);
  // hostCell e' server-owned e vale per DESKTOP e MOBILE: polling separato dal
  // poll sessions/fleet (desktop-only), best-effort, nessun retry (inerzia).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const h = await getLiveHost(token);
        if (cancelled) return;
        setHostCell(h && typeof h.hostCell === 'string' ? h.hostCell : null);
        setHostLease(h && h.host && typeof h.host.lease === 'string' ? h.host.lease : null);
        setHostRevision(Number.isInteger(h && h.revision) ? h.revision : 0);
      } catch (_) { /* best-effort: resta lo stato precedente */ }
    };
    load();
    const id = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [token]);

  // Polling sessions + flotta (solo desktop: su mobile pensa SessionList).
  useEffect(() => {
    if (!isDesktop) return;
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [isDesktop, poll]);
  // Designazione cella ospite: API-first. designate imposta hostCell riflettendo
  // la risposta del server (mai ottimismo pre-response); clear ritorna un boolean
  // cosi' la Sidebar rimuove il pin locale solo a riuscita del clear.
  const designateCellHost = useCallback(async (cellId) => {
    try {
      const r = await designateHostCell(token, cellId, hostRevision);
      setHostCell(r.hostCell || null);
      setHostRevision(Number.isInteger(r.revision) ? r.revision : hostRevision);
    } catch (_) { /* resta lo stato precedente */ }
  }, [token, hostRevision]);
  const clearCellHost = useCallback(async () => {
    try {
      const r = await clearHostCell(token, hostRevision);
      setHostCell(r.hostCell || null);
      setHostRevision(Number.isInteger(r.revision) ? r.revision : hostRevision);
      return true;
    } catch (_) { return false; }
  }, [token, hostRevision]);

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
    if (payload.action === 'up') {
      const res = await fleetUp(token, {
        cell, boot: !!payload.boot,
        ...(payload.engine ? { engine: payload.engine } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.permissionPolicy ? { permissionPolicy: payload.permissionPolicy } : {}),
      }, route);
      // 0.8.47: TUI in consenso/auth/onboarding -> sessione viva, prompt saltato,
      // recovery esplicita per l'operatore (catalogo server, bounded).
      const notice = upActionNotice(res);
      if (notice) deckStore.setError(notice.text);
    } else {
      await fleetDown(token, { cell, boot: !!payload.boot }, route);
    }
    const enabled = payload.action === 'up'
      ? !!payload.boot
      : (payload.boot ? false : !!powerCell.boot);
    setBootSettlement({ id: ++bootSettlementSeq.current, cell, route, enabled });
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
      setDeck(saved.id); setLayout(resolveLayoutForViewer(saved.layout, deckStore.localNodeId, deckOwners)); setGridFocus(null); setSingle(null);
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

  if (!token) {
    return (
      <div className="nc-auth">
        <p>{t('auth-prompt')}</p>
        <input onChange={(e) => setToken(e.target.value.trim())} placeholder="token" />
        <label>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {t('remember-device')}
        </label>
        <button onClick={() => { (remember ? localStorage : sessionStorage).setItem('nc_token', token); }}>ok</button>
      </div>
    );
  }

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
            hostCell={hostCell} hostLease={hostLease} onDesignateCell={designateCellHost} onClearHostCell={clearCellHost} />
          {settingsOverlays}
        </>
      );
    }
    return <>
      <SingleView session={session.session} node={session.node} ownerId={session.ownerId} cellName={session.cellName} token={token} readonly={roDefault}
        onBack={() => setSession(null)} onCellSwitcher={() => setCellSwitcherOpen(true)} cellSwitcherOpen={cellSwitcherOpen} />
      {cellSwitcherOpen && <CellSwitcher token={token} current={session}
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
          activeSessions={activeSessions}
          nodeGroups={nodeGroups}
          fleetCapabilities={fleetCapabilities}
          bootSettlement={bootSettlement}
          onBootSettlementApplied={onBootSettlementApplied}
          localNodeId={deckStore.localNodeId}
          hostCell={hostCell}
          hostLease={hostLease}
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
          sidebarVisible={sidebarVisible}
          onToggleSidebar={!isMainDeck ? () => setSideHidden((v) => !v) : null}
        />
        <GridView
          layout={layout}
          onLayoutChange={setLayout}
          token={token}
          readonly={roDefault}
          sessionsAlive={sessionsAlive}
          focusSession={gridFocus}
          onFocus={setGridFocus}
          onOpenSingle={openSingle}
          decks={decks}
          currentDeck={deck}
          onSendToDeck={onSendToDeck}
          cells={cells}
          nodeGroups={nodeGroups}
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
            token={token} readonly={roDefault} onBack={() => setSingle(null)}
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
