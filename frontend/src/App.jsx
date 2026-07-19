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
import {
  apiFetch, fleetStatus, fleetUp, fleetDown, fleetBoot, killSession, getSettings, nodeAction, renameNodeLabel, setSessionTechnical,
} from './lib/api.js';
import { isValidLabel } from './lib/settings-model.js';
import { emptyLayout, normalize, addTileSmart, removeTile, sessions, parseRef, remapTileRefs } from './lib/grid-model.js';
import {
  MAIN_DECK, deckLocationFromPath, deckUrl, readLayoutRaw,
} from './lib/deck-model.js';
import { deckId, refWithOwner, resolveLayoutForViewer } from './lib/deck-federation.js';
import {t} from './lib/i18n.js';
import { useLang } from './hooks/useLang.js';
import { useNodes } from './hooks/useNodes.js';
import { useDecks } from './hooks/useDecks.js';
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
function SingleView({ session, node, ownerId, token, readonly = false, onBack }) {
  useLang(); // re-render allo switch lingua
  const [showFiles, setShowFiles] = useState(false);
  // Su touch il composer è aperto di default (l'IME Gboard corrompe l'input in xterm).
  const [showComposer, setShowComposer] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const [filesEvent, setFilesEvent] = useState(null);
  const [fontSize, setFontSize] = useState(initialFontSize);
  const [sub, setSub] = useState('');           // sottotitolo stato dell'header
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
          <b>{node ? `${node}:${session}` : session}</b>
          {sub && <small className="nc-bar-sub">{sub}</small>}
        </span>
        <span className="nc-bar-right">
          <button onClick={() => zoom(-1)} title={t('zoom-out')}><Icon name="zoomOut" size={18} /></button>
          <button onClick={() => zoom(+1)} title={t('zoom-in')}><Icon name="zoomIn" size={18} /></button>
          <button onClick={() => setShowComposer((v) => !v)} title={t('composer')}><Icon name="keyboard" size={20} /></button>
          <button onClick={() => setShowFiles((v) => !v)} title={t('files')}><Icon name="folder" size={20} /></button>
        </span>
      </header>
      <div className="nc-termwrap">
        <Terminal session={session} node={node} token={token} readonly={readonly} takeSize sendRef={sendRef} composerRef={composerRef} actionRef={actionRef}
          ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} onFiles={setFilesEvent} fontSize={fontSize}
          selectionMode={selectionMode} onSelectionModeChange={setSelectionMode} />
      </div>
      <KeyBar onKeyboard={() => setShowComposer((v) => !v)} send={(seq) => sendRef.current(seq)} action={(name) => actionRef.current(name)}
        ctrlArmed={ctrlArmed} onCtrl={toggleCtrl} selectionMode={selectionMode} onSelectionMode={setSelectionMode} />
      {showComposer && (
        <ComposerBar submitText={(text) => composerRef.current(text)} token={token} session={session} node={node} ownerId={ownerId} />
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
  const pickSession = (ref) => setSession(parseRef(ref));

  // desktop workspace state
  const [dSessions, setDSessions] = useState([]);
  const [cells, setCells] = useState([]);
  const [fleetCapabilities, setFleetCapabilities] = useState([]);
  const [layout, setLayout] = useState(() => initialDeck.ownerId ? emptyLayout() : loadLayout(initialDeck.name));
  const [gridFocus, setGridFocus] = useState(null);   // refKey del tile focato
  const [single, setSingle] = useState(null);     // overlay vista singola desktop: ref {session, node?}
  const openSingle = (ref) => setSingle(parseRef(ref));
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

  // Polling sessions + flotta (solo desktop: su mobile pensa SessionList).
  useEffect(() => {
    if (!isDesktop) return;
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [isDesktop, poll]);

  // Coerenza versione UI/server (tutte le viste).
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config', token).then((r) => r.json()).then((j) => {
      if (!cancelled && typeof __NC_BUILD_VERSION__ !== 'undefined')
        reportServerVersions(j.version, j.uiVersion, __NC_BUILD_VERSION__);
    }).catch(() => {});
    return () => { cancelled = true; };
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
      await fleetUp(token, {
        cell, boot: !!payload.boot,
        ...(payload.engine ? { engine: payload.engine } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.permissionPolicy ? { permissionPolicy: payload.permissionPolicy } : {}),
      }, route);
    } else {
      await fleetDown(token, { cell, boot: !!payload.boot }, route);
    }
    const enabled = payload.action === 'up'
      ? !!payload.boot
      : (payload.boot ? false : !!powerCell.boot);
    setBootSettlement({ cell, route, enabled });
    poll();
  };
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
    if (!session) {
      return (
        <>
          <SessionList onPick={pickSession} token={token} onSettings={openSettings} />
          {settingsOverlays}
        </>
      );
    }
    return <><SingleView session={session.session} node={session.node} ownerId={session.ownerId} token={token} readonly={roDefault} onBack={() => setSession(null)} />{settingsOverlays}</>;
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
          localNodeId={deckStore.localNodeId}
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
        />
      </div>

      {single && (
        <div className="nc-single-overlay">
          <SingleView session={single.session} node={single.node} ownerId={single.ownerId} token={token} readonly={roDefault} onBack={() => setSingle(null)} />
        </div>
      )}
      {powerCell && (
        <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : []} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}
      {settingsOverlays}
    </div>
  );
}
