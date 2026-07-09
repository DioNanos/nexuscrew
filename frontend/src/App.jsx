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
import {
  apiFetch, fleetStatus, fleetUp, fleetDown, createSession, killSession,
} from './lib/api.js';
import { emptyLayout, normalize, addTileSmart, removeTile, sessions } from './lib/grid-model.js';
import {t} from './lib/i18n.js';
import { useLang } from './hooks/useLang.js';
import './App.css';

const FONT_MIN = 9;
const FONT_MAX = 24;
const GRID_KEY = 'nc_grid_v1';
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

function loadLayout() {
  try { return normalize(JSON.parse(localStorage.getItem(GRID_KEY) || 'null')); }
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
function SingleView({ session, token, onBack }) {
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
  const toggleCtrl = () => { ctrlRef.current = !ctrlRef.current; setCtrlArmed(ctrlRef.current); };

  // Sottotitolo header: "engine·key" se la sessione è una cella, altrimenti
  // "attached · Nm" (o tempo relativo). Dati da /api/sessions + /api/fleet/status.
  useEffect(() => {
    let alive = true;
    async function load() {
      let sess = null; let cell = null;
      try {
        const r = await apiFetch('/api/sessions', token);
        const j = await r.json();
        if (Array.isArray(j.sessions)) sess = j.sessions.find((s) => s.name === session);
      } catch (_) { /* best-effort */ }
      try {
        const fs = await fleetStatus(token);
        if (fs.available && Array.isArray(fs.cells)) cell = fs.cells.find((c) => c.tmuxSession === session);
      } catch (_) { /* best-effort */ }
      if (!alive) return;
      let txt = '';
      if (cell) txt = `${cell.engine}${cell.key ? `·${cell.key}` : ''}`;
      else if (sess) txt = sess.attached ? `attached · ${rel(sess.activity)}` : (sess.activity ? rel(sess.activity) : '');
      setSub(txt);
    }
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [session, token]);

  return (
    <div className="nc-app">
      <header className="nc-bar nc-bar-single">
        <button onClick={onBack} title={t('sessions')}><Icon name="chevronLeft" size={18} /><span className="nc-bar-label">{t('sessions')}</span></button>
        <span className="nc-bar-center">
          <b>{session}</b>
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
        <Terminal session={session} token={token} readonly={false} sendRef={sendRef} actionRef={actionRef}
          ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} onFiles={setFilesEvent} fontSize={fontSize} />
      </div>
      <KeyBar onKeyboard={() => setShowComposer((v) => !v)} send={(seq) => sendRef.current(seq)} action={(name) => actionRef.current(name)}
        ctrlArmed={ctrlArmed} onCtrl={toggleCtrl} />
      {showComposer && (
        <ComposerBar send={(seq) => sendRef.current(seq)} token={token} />
      )}
      {showFiles && (
        <FilesPanel session={session} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
      )}
    </div>
  );
}

export default function App() {
  useLang(); // re-render globale allo switch lingua
  const [token, setToken] = useState(readToken());
  const [remember, setRemember] = useState(false);
  const isDesktop = useDesktop();

  // mobile single-view session
  const [session, setSession] = useState(null);

  // desktop workspace state
  const [dSessions, setDSessions] = useState([]);
  const [cells, setCells] = useState([]);
  const [layout, setLayout] = useState(loadLayout);
  const [gridFocus, setGridFocus] = useState(null);
  const [single, setSingle] = useState(null);     // overlay vista singola desktop
  const [powerCell, setPowerCell] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  // bundle stantio: la tab tiene il JS vecchio anche se il server e' nuovo.
  const [staleVersion, setStaleVersion] = useState(false);
  const [presets, setPresets] = useState(['shell', 'claude', 'codex-vl', 'pi']);
  const [sideW, setSideW] = useState(loadSideW);
  const [sideMin, setSideMin] = useState(() => localStorage.getItem(SIDE_MIN_KEY) === '1');

  // persisti il layout (debounce leggero via microtask: scrive solo quando cambia)
  useEffect(() => {
    try { localStorage.setItem(GRID_KEY, JSON.stringify(layout)); } catch (_) {}
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem(SIDE_W_KEY, String(sideW)); } catch (_) {}
  }, [sideW]);
  useEffect(() => {
    try { localStorage.setItem(SIDE_MIN_KEY, sideMin ? '1' : ''); } catch (_) {}
  }, [sideMin]);

  const poll = useCallback(async () => {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (!j.error) setDSessions(j.sessions || []);
    } catch (_) { /* best-effort */ }
    try {
      const fs = await fleetStatus(token);
      setCells(fs.available ? (fs.cells || []) : []);
    } catch (_) { setCells([]); }
  }, [token]);

  // Polling sessions + flotta (solo desktop: su mobile pensa SessionList).
  useEffect(() => {
    if (!isDesktop) return;
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [isDesktop, poll]);

  // Preset da /api/config (desktop).
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    apiFetch('/api/config', token).then((r) => r.json()).then((j) => {
      if (!cancelled && Array.isArray(j.presets) && j.presets.length) setPresets(j.presets);
      if (!cancelled && j.version && typeof __NC_BUILD_VERSION__ !== 'undefined'
        && j.version !== __NC_BUILD_VERSION__) setStaleVersion(j.version);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isDesktop, token]);

  const sessionsAlive = new Set(dSessions.map((s) => s.name));
  const activeSessions = sessions(layout);

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
      await fleetUp(token, { cell, engine: payload.engine, boot: !!payload.boot });
    } else {
      await fleetDown(token, { cell, boot: !!payload.boot });
    }
    poll();
  };
  const onCreateSession = async (body) => {
    await createSession(token, body);
    poll();
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

  // Banner bundle stantio: visibile in OGNI vista (definito PRIMA dei rami).
  const staleBanner = staleVersion ? (
    <div className="nc-stale" onClick={() => location.reload()}>
      {t('update-available').replace('{v}', staleVersion)} — {t('reload')}
    </div>
  ) : null;

  // Flusso mobile INTATTO.
  if (!isDesktop) {
    if (!session) return <>{staleBanner}<SessionList onPick={setSession} token={token} /></>;
    return <>{staleBanner}<SingleView session={session} token={token} onBack={() => setSession(null)} /></>;
  }

  // Workspace desktop: Sidebar + GridView + overlay vista singola + dialoghi.
  return (
    <div className="nc-workspace">
      {staleBanner}
      <Sidebar
        sessions={dSessions}
        cells={cells}
        activeSessions={activeSessions}
        onPick={setSingle}
        onAddTile={onAddTile}
        onPower={setPowerCell}
        onKill={onKill}
        onNew={() => setNewOpen(true)}
        width={sideW}
        collapsed={sideMin}
        onResize={setSideW}
        onToggleCollapse={() => setSideMin((v) => !v)}
      />
      <div className="nc-workspace-main">
        <GridView
          layout={layout}
          onLayoutChange={setLayout}
          token={token}
          sessionsAlive={sessionsAlive}
          focusSession={gridFocus}
          onFocus={setGridFocus}
          onOpenSingle={setSingle}
        />
      </div>

      {single && (
        <div className="nc-single-overlay">
          <SingleView session={single} token={token} onBack={() => setSingle(null)} />
        </div>
      )}
      {powerCell && (
        <PowerSheet cell={powerCell} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}
      {newOpen && (
        <NewSessionDialog presets={presets} onCreate={onCreateSession} onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}
