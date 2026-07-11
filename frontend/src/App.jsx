import { useCallback, useEffect, useRef, useState } from 'react';
import SessionList from './components/SessionList.jsx';
import Terminal from './components/Terminal.jsx';
import KeyBar from './components/KeyBar.jsx';
import FilesPanel from './components/FilesPanel.jsx';
import ComposerBar from './components/ComposerBar.jsx';
import Icon from './components/Icon.jsx';
import Sidebar from './components/Sidebar.jsx';
import GridView from './components/GridView.jsx';
import PowerSheet from './components/PowerSheet.jsx';
import NewSessionDialog from './components/NewSessionDialog.jsx';
import DeckBar from './components/DeckBar.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import Wizard from './components/Wizard.jsx';
import NotifyCenter from './components/NotifyCenter.jsx';
import {
  apiFetch, fleetStatus, fleetUp, fleetDown, createSession, killSession, getSettings,
} from './lib/api.js';
import { emptyLayout, normalize, addTileSmart, removeTile, sessions, parseRef } from './lib/grid-model.js';
import {
  MAIN_DECK, deckFromPath, deckUrl, readLayoutRaw,
} from './lib/deck-model.js';
import {t} from './lib/i18n.js';
import { useLang } from './hooks/useLang.js';
import { useNodes } from './hooks/useNodes.js';
import { useDecks } from './hooks/useDecks.js';
import { reportServerVersions } from './lib/sw-update.js';
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

// token from the fragment (#token=...), so it never lands in the server logs.
// Un token arrivato via fragment viene RICORDATO sul device (localStorage):
// setup una volta sola per device, mai più la schermata di auth.
function readToken() {
  const hash = location.hash.replace(/^#/, '');
  const m = hash.match(/(?:^|&)token=([^&]+)/);
  if (m) {
    const t = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
    try { localStorage.setItem('nc_token', t); } catch (_) {}
    return t;
  }
  return sessionStorage.getItem('nc_token') || localStorage.getItem('nc_token') || '';
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
function SingleView({ session, node, token, readonly = false, onBack }) {
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
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const toggleCtrl = () => { ctrlRef.current = !ctrlRef.current; setCtrlArmed(ctrlRef.current); };

  // Sottotitolo header: "engine·key" se la sessione è una cella, altrimenti
  // "attached · Nm" (o tempo relativo). Dati da /api/sessions + /api/fleet/status.
  // Sessione remota: /api/sessions del nodo via proxy; la flotta e' un concetto
  // locale (si salta il fleetStatus).
  useEffect(() => {
    let alive = true;
    const base = node ? `/node/${encodeURIComponent(node)}` : '';
    async function load() {
      let sess = null; let cell = null;
      try {
        const r = await apiFetch(`${base}/api/sessions`, token);
        const j = await r.json();
        if (Array.isArray(j.sessions)) sess = j.sessions.find((s) => s.name === session);
      } catch (_) { /* best-effort */ }
      if (!node) {
        try {
          const fs = await fleetStatus(token);
          if (fs.available && Array.isArray(fs.cells)) cell = fs.cells.find((c) => c.tmuxSession === session);
        } catch (_) { /* best-effort */ }
      }
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
        <Terminal session={session} node={node} token={token} readonly={readonly} takeSize sendRef={sendRef} actionRef={actionRef}
          ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} onFiles={setFilesEvent} fontSize={fontSize}
          selectionMode={selectionMode} onSelectionModeChange={setSelectionMode} />
      </div>
      <KeyBar onKeyboard={() => setShowComposer((v) => !v)} send={(seq) => sendRef.current(seq)} action={(name) => actionRef.current(name)}
        ctrlArmed={ctrlArmed} onCtrl={toggleCtrl} selectionMode={selectionMode} onSelectionMode={setSelectionMode} />
      {showComposer && (
        <ComposerBar send={(seq) => sendRef.current(seq)} token={token} session={session} node={node} />
      )}
      {showFiles && (
        <FilesPanel session={session} node={node} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
      )}
    </div>
  );
}

export default function App() {
  useLang(); // re-render globale allo switch lingua
  const [token, setToken] = useState(readToken());
  const [remember, setRemember] = useState(false);
  const isDesktop = useDesktop();

  // Deck corrente (§5b): dal path /deck/<name>, costante per questa finestra.
  // Ogni deck e' un workspace nominato con il PROPRIO layout persistito.
  const [deck] = useState(() => deckFromPath(typeof location !== 'undefined' ? location.pathname : '/'));
  const isMainDeck = deck === MAIN_DECK;

  // mobile single-view session: ref {session, node?} (node = nodo remoto B2)
  const [session, setSession] = useState(null);
  const pickSession = (ref) => setSession(parseRef(ref));

  // desktop workspace state
  const [dSessions, setDSessions] = useState([]);
  const [cells, setCells] = useState([]);
  const [engines, setEngines] = useState([]);       // dal contratto fleet ({id,label,rc})
  const [layout, setLayout] = useState(() => loadLayout(deck));
  const deckStore = useDecks(token, deck, layout, setLayout);
  const decks = deckStore.decks.length ? deckStore.decks : [MAIN_DECK];
  const [gridFocus, setGridFocus] = useState(null);   // refKey del tile focato
  const [single, setSingle] = useState(null);     // overlay vista singola desktop: ref {session, node?}
  const openSingle = (ref) => setSingle(parseRef(ref));
  // Gruppi per-nodo remoto (B2, design §5): polling separato, best-effort;
  // zero nodi configurati -> [] e workspace identico a oggi.
  const nodeGroups = useNodes(token, isDesktop);
  const [powerCell, setPowerCell] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [presets, setPresets] = useState(['shell', 'claude', 'codex-vl', 'pi']);
  const [sideW, setSideW] = useState(loadSideW);
  // Finestre deck minimali: nei deck non-main la sidebar e' nascosta di default
  // (toggle flottante); quando riaperta parte in mini = session-picker compatto.
  const [sideHidden, setSideHidden] = useState(!isMainDeck);
  const [sideMin, setSideMin] = useState(() => (isMainDeck ? localStorage.getItem(SIDE_MIN_KEY) === '1' : true));
  // Settings + first-run wizard (B2-UI, design §5).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
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
      setRoDefault(!!c.readonlyDefault);
      if (s.firstRun === true && !c.readonlyDefault) setWizardOpen(true);
    }).catch(() => { /* wizard best-effort: la UI resta usabile */ });
    return () => { cancelled = true; };
  }, [token]);

  const poll = useCallback(async () => {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (!j.error) setDSessions(j.sessions || []);
    } catch (_) { /* best-effort */ }
    try {
      const fs = await fleetStatus(token);
      setCells(fs.available ? (fs.cells || []) : []);
      setEngines(fs.available ? (fs.engines || []) : []);
    } catch (_) { setCells([]); setEngines([]); }
  }, [token]);

  // Polling sessions + flotta (solo desktop: su mobile pensa SessionList).
  useEffect(() => {
    if (!isDesktop) return;
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [isDesktop, poll]);

  // Preset + coerenza versione UI/server (tutte le viste).
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/config', token).then((r) => r.json()).then((j) => {
      if (!cancelled && Array.isArray(j.presets) && j.presets.length) setPresets(j.presets);
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
  const onAddTile = (name) => setLayout((l) => addTileSmart(l, name));
    const onKill = async (name) => {
    try { await killSession(token, name); } catch (_) { return; }
    setLayout((l) => removeTile(l, name));
    poll();
  };
  const onFleetConfirm = async (payload) => {
    if (!powerCell) return;
    const { cell } = powerCell;
    if (payload.action === 'up') {
      await fleetUp(token, { cell, engine: payload.engine, model: payload.model || '', boot: !!payload.boot });
    } else {
      await fleetDown(token, { cell, boot: !!payload.boot });
    }
    poll();
  };
  const onCreateSession = async (body) => {
    await createSession(token, body);
    poll();
  };

  // --- deck actions (§5b) ---
  const openDeckWindow = (name) => {
    try { const w = window.open(deckUrl(name, token), '_blank'); if (w) w.opener = null; return !!w; } catch (_) { return false; }
  };
  const openDeckHere = (name) => location.assign(deckUrl(name, token));
  const onCreateDeck = async (name) => {
    await deckStore.add(name);
    openDeckHere(name);
  };
  const onRenameDeck = async (from, to) => {
    await deckStore.rename(from, to);
    if (from === deck) location.assign(deckUrl(to, token));
  };
  const onDeleteDeck = async (name) => {
    await deckStore.remove(name);
    if (name === deck) location.assign(deckUrl(MAIN_DECK, token));
  };
  // "manda al deck X": aggiunge il tile al layout del deck bersaglio (l'altra
  // finestra lo raccoglie via evento 'storage') e lo toglie da questo deck.
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
      {settingsOpen && <SettingsPanel token={token} onClose={() => setSettingsOpen(false)} />}
      {wizardOpen && <Wizard token={token} onDone={() => setWizardOpen(false)} />}
      <NotifyCenter token={token} />
    </>
  );

  // Flusso mobile INTATTO (aggiunta B2: voce settings nell'header della home).
  if (!isDesktop) {
    if (!session) {
      return (
        <>
          <SessionList onPick={pickSession} token={token} onSettings={() => setSettingsOpen(true)} />
          {settingsOverlays}
        </>
      );
    }
    return <><SingleView session={session.session} node={session.node} token={token} readonly={roDefault} onBack={() => setSession(null)} />{settingsOverlays}</>;
  }

  // Workspace desktop: Sidebar + GridView + overlay vista singola + dialoghi.
  const sidebarVisible = isMainDeck || !sideHidden;
  return (
    <div className="nc-workspace">
      {/* Finestre deck minimali: toggle flottante per mostrare/nascondere la sidebar. */}
      {!isMainDeck && (
        <button className="nc-side-show" title={t('toggle-sidebar')} onClick={() => setSideHidden((v) => !v)}>☰</button>
      )}
      {sidebarVisible && (
        <Sidebar
          sessions={dSessions}
          cells={cells}
          activeSessions={activeSessions}
          nodeGroups={nodeGroups}
          onPick={openSingle}
          onAddTile={onAddTile}
          onPower={setPowerCell}
          onKill={onKill}
          onNew={() => setNewOpen(true)}
          onSettings={() => setSettingsOpen(true)}
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
          onOpenWindow={openDeckWindow} onNavigate={openDeckHere}
          saveState={deckStore.saveState} error={deckStore.error}
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
          <SingleView session={single.session} node={single.node} token={token} readonly={roDefault} onBack={() => setSingle(null)} />
        </div>
      )}
      {powerCell && (
        <PowerSheet cell={powerCell} engines={engines} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}
      {newOpen && (
        <NewSessionDialog presets={presets} token={token} onCreate={onCreateSession} onClose={() => setNewOpen(false)} />
      )}
      {settingsOverlays}
    </div>
  );
}
