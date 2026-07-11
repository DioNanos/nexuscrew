import { useEffect, useRef, useState } from 'react';
import { t, LANGUAGES } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { loadPins, togglePinIn, pinRank, cmpRank } from '../lib/pins.js';
import Icon from './Icon.jsx';
import './Sidebar.css';

// Tempo relativo compatto da epoch sec: 'ora' | 'Nm' | 'Nh' | 'Ng'.
function rel(epochSec) {
  if (!epochSec) return '';
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 0 || s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

// Iniziale compatta per la modalità mini (prima lettera significativa).
function initial(name) { return String(name || '?').replace(/^[^a-zA-Z0-9]+/, '').charAt(0).toUpperCase() || '?'; }

// Larghezza sidebar: clamp 180–480px.
const SIDE_MIN_W = 180;
const SIDE_MAX_W = 480;

// Etichetta di stato di un gruppo nodo degradato (design §7: mai spinner).
function nodeStateLabel(g) {
  if (g.status === 'down') {
    return g.downSince ? t('tunnel-down-since').replace('{t}', rel(g.downSince)) : t('tunnel-down');
  }
  if (g.status === 'unreachable') return t('node-unreachable');
  return '';
}

// Sidebar presentazionale: mostra la flotta (celle) + le altre sessioni tmux
// + i gruppi per-nodo remoto (B2, design §5). Il polling e le azioni sono del
// genitore; qui solo render + callback.
// Collassabile (mini 48px, solo dot) e ridimensionabile (maniglia bordo destro).
export default function Sidebar({
  sessions = [], cells = [], activeSessions = [], nodeGroups = [], onPick, onAddTile, onPower, onKill, onNew,
  onSettings, width = 240, collapsed = false, onResize, onToggleCollapse,
}) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  const [pins, setPins] = useState(loadPins);
  const togglePin = (name) => setPins((p) => togglePinIn(p, name));
  const cellSessions = new Set((cells || []).map((c) => c.tmuxSession));
  const byName = new Map((sessions || []).map((s) => [s.name, s]));
  // Ordinamento: pinnate in cima (ordine di pin), poi attivita' recente,
  // poi ordine naturale/alfabetico. Vale per ENTRAMBI i gruppi, celle incluse.
  const rank = (key, activity) => pinRank(pins, key, activity);
  const cmp = cmpRank;
  const sortedCells = [...(cells || [])].sort((a, b) =>
    cmp(rank(a.tmuxSession, (byName.get(a.tmuxSession) || {}).activity),
        rank(b.tmuxSession, (byName.get(b.tmuxSession) || {}).activity)));
  const others = (sessions || []).filter((s) => !cellSessions.has(s.name)).sort((a, b) => {
    const d = cmp(rank(a.name, a.activity), rank(b.name, b.activity));
    return d || a.name.localeCompare(b.name);
  });
  const active = new Set(activeSessions || []);
  // Tooltip mini via JS (position:fixed): il ::after CSS veniva CLIPPATO
  // dall'overflow della sidebar da 48px.
  const [tip, setTip] = useState(null); // {text, y}
  const showTip = (e, text) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ text, y: r.top + r.height / 2 }); };
  const hideTip = () => setTip(null);
  // Cleanup listener resize su unmount (audit: come GridView).
  const resizeCleanupRef = useRef(null);
  useEffect(() => () => { if (resizeCleanupRef.current) resizeCleanupRef.current(); }, []);

  // Maniglia di resize sul bordo destro (pointer, come i divisori griglia).
  function startResize(e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const move = (ev) => {
      const w = Math.max(SIDE_MIN_W, Math.min(SIDE_MAX_W, startW + (ev.clientX - startX)));
      onResize && onResize(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      resizeCleanupRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    resizeCleanupRef.current = up;
  }

  const style = collapsed
    ? { width: 48, flex: '0 0 48px' }
    : { width, flex: `0 0 ${width}px` };

  // --- modalità mini: solo dot celle + iniziali sessioni; click/drag attivi. ---
  if (collapsed) {
    return (
      <aside className="nc-sidebar mini" style={style}>
        <div className="nc-side-head mini">
          <button className="nc-collapse-btn" onClick={onToggleCollapse} title={t('expand')}>⟩</button>
        </div>
        <div className="nc-side-group mini">
          {sortedCells.map((c) => {
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const live = !!c.tmux;
            return (
              <button
                key={c.cell}
                type="button"
                className={`nc-mini-dot${active.has(c.tmuxSession) ? ' active' : ''}`}
                onMouseEnter={(e) => showTip(e, c.cell)}
                onMouseLeave={hideTip}
                draggable={live}
                onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.tmuxSession) : undefined}
                onClick={live ? () => onAddTile && onAddTile(c.tmuxSession) : () => onPower && onPower(c)}
                onDoubleClick={live ? () => onPick && onPick(c.tmuxSession) : undefined}
              ><span className={`nc-dot ${dot}`} /></button>
            );
          })}
          {others.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`nc-mini-init${active.has(s.name) ? ' active' : ''}`}
              onMouseEnter={(e) => showTip(e, s.name)}
              onMouseLeave={hideTip}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
              onClick={() => onAddTile && onAddTile(s.name)}
              onDoubleClick={() => onPick && onPick(s.name)}
            >{initial(s.name)}</button>
          ))}
          {/* Sessioni dei nodi remoti (B2): iniziali col tooltip "nodo:sessione";
              nodo degradato = dot warn statico (mai spinner, design §7). */}
          {(nodeGroups || []).flatMap((g) => (g.status === 'up'
            ? g.sessions.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`nc-mini-init${active.has(s.key) ? ' active' : ''}`}
                onMouseEnter={(e) => showTip(e, s.key)}
                onMouseLeave={hideTip}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.key)}
                onClick={() => onAddTile && onAddTile(s.key)}
                onDoubleClick={() => onPick && onPick({ session: s.name, node: s.node })}
              >{initial(s.name)}</button>
            ))
            : [(
              <button
                key={`nodo-${g.name}`}
                type="button"
                className="nc-mini-dot"
                onMouseEnter={(e) => showTip(e, `${g.name}: ${nodeStateLabel(g)}`)}
                onMouseLeave={hideTip}
              ><span className="nc-dot warn" /></button>
            )]))}
        </div>
        <button className="nc-side-gear mini" onClick={onSettings} title={t('settings')}
          onMouseEnter={(e) => showTip(e, t('settings'))} onMouseLeave={hideTip}>
          <Icon name="gear" size={16} />
        </button>
        {tip && <div className="nc-mini-tip" style={{ top: tip.y }}>{tip.text}</div>}
      </aside>
    );
  }

  return (
    <aside className="nc-sidebar" style={style}>
      <div className="nc-side-head">
        <button className="nc-collapse-btn" onClick={onToggleCollapse} title={t('collapse')}>⟨</button>
        <span className="nc-side-title">{t('fleet')}</span>
        <button className="nc-new-btn" onClick={onNew} title={t('new-session')}>+ {t('new')}</button>
      </div>

      {(cells || []).length > 0 && (
        <div className="nc-side-group">
          {sortedCells.map((c) => {
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const title = c.degraded ? t('cell-degraded') : c.tmux ? t('cell-on') : t('cell-off');
            // Cella con tmux vivo = sessione a tutti gli effetti: draggabile
            // nella griglia, click = tile, doppio click = vista singola.
            const live = !!c.tmux;
            return (
              <div
                key={c.cell}
                className={`nc-cell${live ? ' live' : ''}${active.has(c.tmuxSession) ? ' active' : ''}`}
                title={title}
                draggable={live}
                onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.tmuxSession) : undefined}
                onClick={live ? () => onAddTile && onAddTile(c.tmuxSession) : undefined}
                onDoubleClick={live ? () => onPick && onPick(c.tmuxSession) : undefined}
              >
                <span className={`nc-dot ${dot}`} />
                <span className="nc-cell-main">
                  <b>{c.cell}</b>
                  <small>{c.engine}{c.key ? `·${c.key}` : ''}</small>
                </span>
                <button
                  className={`nc-pin${pins.includes(c.tmuxSession) ? ' on' : ''}`}
                  title={t('pin')}
                  onClick={(e) => { e.stopPropagation(); togglePin(c.tmuxSession); }}
                >{pins.includes(c.tmuxSession) ? '★' : '☆'}</button>
                <button
                  className={`nc-power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onPower && onPower(c); }}
                  title={c.active ? t('power-off') : t('power-on')}
                ><Icon name="power" size={14} /></button>
              </div>
            );
          })}
        </div>
      )}

      {/* Voce settings sotto il pannello FLEET (design §5, B2-UI). */}
      <button className="nc-side-gear" onClick={onSettings} title={t('settings')}>
        <Icon name="gear" size={15} /> {t('settings')}
      </button>

      <div className="nc-side-group-title">{t('other-sessions')}</div>
      <div className="nc-side-group">
        {others.map((s) => (
          <div
            key={s.name}
            className={`nc-side-card${active.has(s.name) ? ' active' : ''}`}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
            onClick={() => onAddTile && onAddTile(s.name)}
            onDoubleClick={() => onPick && onPick(s.name)}
          >
            <span className={s.attached ? 'nc-dot on' : 'nc-dot'} />
            <span className="nc-card-main">
              <b>{s.name}</b>
              <small>
                {s.preview
                  ? s.preview
                  : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}
                {s.outbox && s.outbox.count > 0 ? ` · 📦${s.outbox.count}` : ''}
              </small>
            </span>
            {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
            <button
              className={`nc-pin${pins.includes(s.name) ? ' on' : ''}`}
              title={t('pin')}
              onClick={(e) => { e.stopPropagation(); togglePin(s.name); }}
            >{pins.includes(s.name) ? '\u2605' : '\u2606'}</button>
            <button
              className="nc-menu"
              title={t('terminate')}
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill && onKill(s.name);
              }}
            >⋯</button>
          </div>
        ))}
        {others.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
      </div>

      {/* Gruppi per-nodo remoto (B2, design §5): "phone · 2 sessioni" accanto
          alle sessioni locali; tunnel giu' = gruppo degradato statico (§7). */}
      {(nodeGroups || []).map((g) => (
        <div key={`nodo-${g.name}`}>
          <div className="nc-side-group-title nc-node-title">
            <span className={`nc-dot ${g.status === 'up' ? 'on' : 'warn'}`} />
            <b>{g.name}</b>
            <small>
              {' · '}
              {g.status === 'up'
                ? t('node-sessions').replace('{n}', String(g.sessions.length))
                : nodeStateLabel(g)}
            </small>
          </div>
          {g.status === 'up' && (
            <div className="nc-side-group">
              {g.sessions.map((s) => (
                <div
                  key={s.key}
                  className={`nc-side-card${active.has(s.key) ? ' active' : ''}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.key)}
                  onClick={() => onAddTile && onAddTile(s.key)}
                  onDoubleClick={() => onPick && onPick({ session: s.name, node: s.node })}
                >
                  <span className={s.attached ? 'nc-dot on' : 'nc-dot'} />
                  <span className="nc-card-main">
                    <b>{s.name}</b>
                    <small>
                      {s.preview
                        ? s.preview
                        : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}
                    </small>
                  </span>
                  {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
                </div>
              ))}
              {g.sessions.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
            </div>
          )}
        </div>
      ))}

      <div className="nc-side-lang">
        {LANGUAGES.map((lg, i) => (
          <span key={lg}>
            {i > 0 && ' · '}
            <button className={`nc-lang-btn${lang === lg ? ' on' : ''}`} onClick={() => setLang(lg)} title={lg}>{lg.toUpperCase()}</button>
          </span>
        ))}
      </div>

      <div className="nc-side-resize" onPointerDown={startResize} title="" />
    </aside>
  );
}
