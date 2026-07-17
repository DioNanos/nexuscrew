import { useEffect, useRef, useState } from 'react';
import { t, LANGUAGES } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { pinRank, cmpRank } from '../lib/pins.js';
import { sidebarItems, sidebarOrder } from '../lib/sidebar-model.js';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import { useNodePreferences } from '../hooks/useNodePreferences.js';
import {
  rel, nodeStateLabel, healthDot, healthTitle, buildLocalRoster, buildRemoteRoster,
} from '../lib/roster-view-model.js';
import { OWNER_ID_RE } from '../lib/grid-model.js';
import Icon from './Icon.jsx';
import RosterHandle from './RosterHandle.jsx';
import './Sidebar.css';

// Iniziale compatta per la modalità mini (prima lettera significativa).
function initial(name) { return String(name || '?').replace(/^[^a-zA-Z0-9]+/, '').charAt(0).toUpperCase() || '?'; }

// Larghezza sidebar: clamp 180–480px.
const SIDE_MIN_W = 180;
const SIDE_MAX_W = 480;

// Sidebar presentazionale: mostra la flotta (celle) + le altre sessioni tmux
// + i gruppi per-nodo remoto (B2, design §5). Il polling e le azioni sono del
// genitore; qui solo render + callback.
// Collassabile (mini 48px, solo dot) e ridimensionabile (maniglia bordo destro).
export default function Sidebar({
  sessions = [], cells = [], activeSessions = [], nodeGroups = [], onPick, onAddTile, onPower, onNodePower, onKill, onVisibility, onNew,
  onNodeRename, onSettings, localNodeId, width = 240, collapsed = false, onResize, onToggleCollapse,
}) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  const {
    pins, orders, togglePin, viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  } = useRosterPreferences();
  const {
    groupsFor: preferredGroups, moveNode, stepNode, nodeKey,
  } = useNodePreferences();
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
  const localRawItems = buildLocalRoster(sortedCells, others, byName);
  const localItems = sidebarItems(localRawItems, pins, viewFor('local').filter, sidebarOrder(orders, 'local'));
  const preferredNodeGroups = preferredGroups(nodeGroups || []);
  const remoteRosters = preferredNodeGroups.map((g) => {
    const nodeRoute = (g.route || [g.name]).join('/');
    const groupView = viewFor(nodeRoute);
    const { rawItems } = buildRemoteRoster(g);
    const items = sidebarItems(rawItems, pins, groupView.filter, sidebarOrder(orders, nodeRoute));
    return { g, nodeRoute, groupView, rawItems, items };
  });
  const pickOwned = (session, node, ownerId) => onPick && onPick({
    session,
    ...(node ? { node } : {}),
    ...(OWNER_ID_RE.test(String(ownerId || '')) ? { ownerId } : {}),
  });
  const promptNodeRename = async (group) => {
    if (!group?.direct || !onNodeRename) return;
    const next = window.prompt(t('rename-node-prompt'), group.label || group.name);
    if (next === null) return;
    try {
      if (!await onNodeRename(group, next)) window.alert(t('rename-node-invalid'));
    } catch (error) { window.alert(String(error?.message || error)); }
  };
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
        <button className="nc-side-gear mini" onClick={() => onSettings && onSettings('nodes', false)} title={t('settings')}
          onMouseEnter={(e) => showTip(e, t('settings'))} onMouseLeave={hideTip}>
          <Icon name="gear" size={16} />
        </button>
        <div className="nc-side-scroll mini"><div className="nc-side-group mini">
          {viewFor('local').open && localItems.map((item) => item.type === 'cell' ? (() => {
            const c = item.value;
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const live = !!c.tmux;
            return (
              <button
                key={item.key}
                type="button"
                className={`nc-mini-dot${active.has(c.tmuxSession) ? ' active' : ''}`}
                onMouseEnter={(e) => showTip(e, `${c.cell}: ${item.subtitle}`)}
                onMouseLeave={hideTip}
                draggable={live}
                onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.tmuxSession) : undefined}
                onClick={live ? () => onAddTile && onAddTile(c.tmuxSession) : () => onPower && onPower(c)}
                onDoubleClick={live ? () => pickOwned(c.tmuxSession, '', localNodeId) : undefined}
              ><span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} /></button>
            );
          })() : (() => { const s = item.value; return (
            <button
              key={item.key}
              type="button"
              className={`nc-mini-init${active.has(s.name) ? ' active' : ''}`}
              onMouseEnter={(e) => showTip(e, s.name)}
              onMouseLeave={hideTip}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
              onClick={() => onAddTile && onAddTile(s.name)}
              onDoubleClick={() => pickOwned(s.name, '', localNodeId)}
            >{initial(s.name)}</button>
          ); })())}
          {/* Sessioni dei nodi remoti (B2): iniziali col tooltip "nodo:sessione";
              nodo degradato = dot warn statico (mai spinner, design §7). */}
          {remoteRosters.flatMap(({ g, nodeRoute, groupView, items }) => (g.status === 'up'
            ? (groupView.open ? items.map((item) => item.type === 'cell' ? (() => {
              const c = item.value; const live = !!c.tmux;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nc-mini-dot${active.has(item.key) ? ' active' : ''}`}
                  onMouseEnter={(e) => showTip(e, `${g.label || nodeRoute}: ${c.cell} · ${item.subtitle}`)}
                  onMouseLeave={hideTip}
                  draggable={live}
                  onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', item.key) : undefined}
                  onClick={live ? () => onAddTile && onAddTile(item.key) : () => onPower && onPower({ ...c, route: g.route, availableEngines: g.engines || [] })}
                  onDoubleClick={live ? () => pickOwned(c.tmuxSession, nodeRoute, g.instanceId) : undefined}
                ><span className={`nc-dot ${c.degraded ? 'warn' : live ? `on${item.working ? ' working' : ''}` : ''}`} /></button>
              );
            })() : (() => { const s = item.value; return (
              <button
                key={item.key}
                type="button"
                className={`nc-mini-init${active.has(item.key) ? ' active' : ''}`}
                onMouseEnter={(e) => showTip(e, `${g.label || nodeRoute}: ${s.name}`)}
                onMouseLeave={hideTip}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/nc-session', item.key)}
                onClick={() => onAddTile && onAddTile(item.key)}
                onDoubleClick={() => pickOwned(s.name, nodeRoute, g.instanceId)}
              >{initial(s.name)}</button>
            ); })()) : [])
            : [(
              <button
                key={`nodo-${(g.route || [g.name]).join('/')}`}
                type="button"
                className="nc-mini-dot"
                onMouseEnter={(e) => showTip(e, `${g.label || (g.route || [g.name]).join(' › ')}: ${nodeStateLabel(g)}`)}
                onMouseLeave={hideTip}
              ><span className={`nc-dot${g.status === 'passive' ? '' : ' warn'}`} /></button>
            )]))}
        </div></div>
        {tip && <div className="nc-mini-tip" style={{ top: tip.y }}>{tip.text}</div>}
      </aside>
    );
  }

  return (
    <aside className="nc-sidebar" style={style}>
      <div className="nc-side-head">
        <button className="nc-collapse-btn" onClick={onToggleCollapse} title={t('collapse')}>⟨</button>
        <span className="nc-side-title">{t('fleet')}</span>
        <button className="nc-new-btn" onClick={onNew} title={t('fleet-new-cell')}>+ {t('new')}</button>
      </div>

      <button className="nc-side-gear" onClick={() => onSettings && onSettings('nodes', false)} title={t('settings')}>
        <Icon name="gear" size={15} /> {t('settings')}
      </button>

      <div className="nc-side-scroll">
      <PositionHeader
        label={t('position-local')}
        count={localItems.length}
        state={viewFor('local')}
        onToggle={() => updateView('local', { open: !viewFor('local').open })}
        onFilter={(filter) => updateView('local', { filter })}
      />
      {viewFor('local').open && (
        <div className="nc-side-group">
          {localItems.map((item) => item.type === 'cell' ? (() => {
            const c = item.value;
            const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
            const title = c.degraded
              ? t('cell-degraded')
              : item.working ? item.subtitle : c.tmux ? t('cell-idle') : t('cell-off');
            // Cella con tmux vivo = sessione a tutti gli effetti: draggabile
            // nella griglia, click = tile, doppio click = vista singola.
            const live = !!c.tmux;
            return (
              <div
                key={item.key}
                data-roster-key={item.key}
                data-position="local"
                className={`nc-cell${live ? ' live' : ''}${active.has(c.tmuxSession) ? ' active' : ''}`}
                title={`${c.cell} · ${item.subtitle}${title === item.subtitle ? '' : ` · ${title}`}`}
                aria-label={`${c.cell}, ${item.subtitle}${title === item.subtitle ? '' : `, ${title}`}`}
                draggable={live}
                onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.tmuxSession) : undefined}
                onClick={live ? () => onAddTile && onAddTile(c.tmuxSession) : undefined}
                onDoubleClick={live ? () => pickOwned(c.tmuxSession, '', localNodeId) : undefined}
              >
                <RosterHandle position="local" itemKey={item.key} label={c.cell}
                  canMove={canMoveRoster}
                  onMove={(source, target) => moveRoster('local', source, target, localRawItems)}
                  onStep={(delta) => stepRoster('local', item.key, delta, localRawItems)} />
                <span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} />
                <span className="nc-cell-main">
                  <b title={c.cell}>{c.cell}</b>
                  <small title={item.subtitle}>{item.subtitle}</small>
                </span>
                <button
                  className={`nc-pin${pins.includes(item.key) ? ' on' : ''}`}
                  title={t('pin')}
                  onClick={(e) => { e.stopPropagation(); togglePin(item.key); }}
                >{pins.includes(item.key) ? '★' : '☆'}</button>
                <button
                  className={`nc-power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
                  onClick={(e) => { e.stopPropagation(); onPower && onPower(c); }}
                  title={c.active ? t('power-off') : t('power-on')}
                ><Icon name="power" size={14} /></button>
              </div>
            );
          })() : (() => {
            const s = item.value;
            return <div
              key={item.key}
              data-roster-key={item.key}
              data-position="local"
              className={`nc-side-card${active.has(s.name) ? ' active' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.name)}
              onClick={() => onAddTile && onAddTile(s.name)}
              onDoubleClick={() => pickOwned(s.name, '', localNodeId)}
            >
              <RosterHandle position="local" itemKey={item.key} label={s.name}
                canMove={canMoveRoster}
                onMove={(source, target) => moveRoster('local', source, target, localRawItems)}
                onStep={(delta) => stepRoster('local', item.key, delta, localRawItems)} />
              <span className={s.attached ? 'nc-dot on' : 'nc-dot'} />
              <span className="nc-card-main"><b>{s.name}</b><small>{s.preview || s.cmd || t('windows').replace('{n}', String(s.windows || 0))}{s.outbox?.count > 0 ? ` · 📦${s.outbox.count}` : ''}</small></span>
              {s.activity ? <span className="nc-rel">{rel(s.activity)}</span> : null}
              <button className={`nc-pin${pins.includes(item.key) ? ' on' : ''}`} title={t('pin')}
                onClick={(e) => { e.stopPropagation(); togglePin(item.key); }}>{pins.includes(item.key) ? '★' : '☆'}</button>
              <button className={`nc-technical${s.technical ? ' on' : ''}`}
                title={s.technical ? t('mark-normal') : t('mark-technical')}
                aria-label={`${s.technical ? t('mark-normal') : t('mark-technical')} ${s.name}`}
                onClick={(e) => { e.stopPropagation(); onVisibility && onVisibility(s.name, !s.technical, []); }}>T</button>
              <button className="nc-menu" title={t('terminate')} onClick={(e) => { e.stopPropagation(); if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill && onKill(s.name); }}>⋯</button>
            </div>;
          })())}
          {localItems.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
        </div>
      )}

      {/* Gruppi per-nodo remoto (Hydra): per ogni posizione celle Fleet (attive e
          inattive, draggabili se live) + tmux unmanaged. Salute dal probe federato
          (NO verde hardcoded): 401/degraded -> warn + diagnostica. Power del tunnel
          solo per nodi diretti gestibili; peer inbound non ha power fittizio. */}
      {remoteRosters.map(({ g, nodeRoute, groupView, rawItems, items: remoteItems }) => {
        const hd = healthDot(g.health);
        const dotClass = hd || (g.status === 'up' ? 'on' : g.status === 'passive' ? '' : 'warn');
        return (
        <div key={`nodo-${(g.route || [g.name]).join('/')}`} className="nc-node-order-wrap"
          data-node-order-key={nodeKey(g)}>
          <div className="nc-side-group-title nc-node-title" role="button" tabIndex={0}
            onContextMenu={g.direct && onNodeRename ? (e) => { e.preventDefault(); promptNodeRename(g); } : undefined}
            onClick={() => updateView(nodeRoute, { open: !groupView.open })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); updateView(nodeRoute, { open: !groupView.open }); } }}>
            <RosterHandle scope="node" position="nodes" itemKey={nodeKey(g)} label={g.label || g.name}
              onMove={(source, target) => moveNode(source, target, nodeGroups || [])}
              onStep={(delta) => stepNode(nodeKey(g), delta, nodeGroups || [])} />
            <span className="nc-node-chevron">{groupView.open ? '⌄' : '›'}</span>
            <span className={`nc-dot ${dotClass}`} title={g.health ? healthTitle(g.health) : ''} />
            <b>{g.label || g.name}</b>
            <small>
              {' · '}
              {g.status === 'up'
                ? t('node-sessions').replace('{n}', String(remoteItems.length))
                : (g.health ? healthTitle(g.health) || nodeStateLabel(g) : nodeStateLabel(g))}
            </small>
            <select className="nc-node-filter" value={groupView.filter} title={t(`view-${groupView.filter}`)}
              onClick={(e) => e.stopPropagation()} onChange={(e) => updateView(nodeRoute, { filter: e.target.value })}>
              <option value="all">{t('view-all')}</option><option value="pinned">{t('view-pinned')}</option>
              <option value="active">{t('view-active')}</option><option value="off">{t('view-off')}</option><option value="technical">{t('view-technical')}</option>
            </select>
            {g.direct && onNodeRename && <button type="button" className="nc-node-rename" title={t('rename-node')}
              aria-label={`${t('rename-node')} ${g.label || g.name}`}
              onClick={(e) => { e.stopPropagation(); promptNodeRename(g); }}>✎</button>}
            {g.direct && g.health && g.health.managed !== false && (
              <button type="button" className={`nc-power${g.tunnelStatus === 'up' ? ' on' : ''}`}
                title={g.tunnelStatus === 'up' ? t('power-off') : t('power-on')}
                onClick={(e) => { e.stopPropagation(); onNodePower && onNodePower(g); }}><Icon name="power" size={14} /></button>
            )}
          </div>
          {g.status === 'up' && groupView.open && (
            <div className="nc-side-group">
              {remoteItems.map((item) => item.type === 'cell' ? (() => {
                const c = item.value;
                const live = !!c.tmux;
                const dot = c.degraded ? 'warn' : c.tmux ? 'on' : '';
                return (
                  <div
                    key={item.key}
                    data-roster-key={item.key}
                    data-position={nodeRoute}
                    className={`nc-side-card nc-cell${live ? ' live' : ''}${active.has(c.key) ? ' active' : ''}`}
                    title={item.working ? item.subtitle : c.tmux ? t('cell-idle') : t('cell-off')}
                    draggable={live}
                    onDragStart={live ? (e) => e.dataTransfer.setData('text/nc-session', c.key) : undefined}
                    onClick={live ? () => onAddTile && onAddTile(c.key) : undefined}
                    onDoubleClick={live ? () => pickOwned(c.tmuxSession, nodeRoute, g.instanceId) : undefined}
                  >
                    <RosterHandle position={nodeRoute} itemKey={item.key} label={c.cell}
                      canMove={canMoveRoster}
                      onMove={(source, target) => moveRoster(nodeRoute, source, target, rawItems)}
                      onStep={(delta) => stepRoster(nodeRoute, item.key, delta, rawItems)} />
                    <span className={`nc-dot ${dot}${item.working ? ' working' : ''}`} />
                    <span className="nc-card-main">
                      <b>{c.cell}</b>
                      <small title={item.subtitle}>{item.subtitle}</small>
                    </span>
                    <button className={`nc-pin${pins.includes(item.key) ? ' on' : ''}`} title={t('pin')}
                      onClick={(e) => { e.stopPropagation(); togglePin(item.key); }}>{pins.includes(item.key) ? '★' : '☆'}</button>
                    {(g.capabilities || []).includes(c.active ? 'down' : 'up') && (
                      <button className={`nc-power${c.active ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
                        onClick={(e) => { e.stopPropagation(); onPower && onPower({ ...c, route: g.route, availableEngines: g.engines || [] }); }}
                        title={c.active ? t('power-off') : t('power-on')}><Icon name="power" size={14} /></button>
                    )}
                  </div>
                );
              })() : (() => { const s = item.value; return (
                <div
                  key={item.key}
                  data-roster-key={item.key}
                  data-position={nodeRoute}
                  className={`nc-side-card${active.has(s.key) ? ' active' : ''}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/nc-session', s.key)}
                  onClick={() => onAddTile && onAddTile(s.key)}
                  onDoubleClick={() => pickOwned(s.name, s.node || nodeRoute, g.instanceId)}
                >
                  <RosterHandle position={nodeRoute} itemKey={item.key} label={s.name}
                    canMove={canMoveRoster}
                    onMove={(source, target) => moveRoster(nodeRoute, source, target, rawItems)}
                    onStep={(delta) => stepRoster(nodeRoute, item.key, delta, rawItems)} />
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
                  <button className={`nc-pin${pins.includes(item.key) ? ' on' : ''}`} title={t('pin')}
                    onClick={(e) => { e.stopPropagation(); togglePin(item.key); }}>{pins.includes(item.key) ? '★' : '☆'}</button>
                  <button className={`nc-technical${s.technical ? ' on' : ''}`}
                    title={s.technical ? t('mark-normal') : t('mark-technical')}
                    aria-label={`${s.technical ? t('mark-normal') : t('mark-technical')} ${s.name}`}
                    onClick={(e) => { e.stopPropagation(); onVisibility && onVisibility(s.name, !s.technical, g.route || []); }}>T</button>
                  <button className="nc-menu" title={t('terminate')} onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill && onKill(s.name, g.route);
                  }}>⋯</button>
                </div>
              ); })())}
              {remoteItems.length === 0 && <div className="nc-empty">{t('no-sessions-short')}</div>}
            </div>
          )}
        </div>
        );
      })}

      </div>

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

function PositionHeader({ label, count, state, onToggle, onFilter }) {
  return <div className="nc-side-group-title nc-node-title" role="button" tabIndex={0}
    onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
    <span className="nc-node-chevron">{state.open ? '⌄' : '›'}</span>
    <span className="nc-dot on" /><b>{label}</b><small> · {t('node-sessions').replace('{n}', String(count))}</small>
    <select className="nc-node-filter" value={state.filter} title={t(`view-${state.filter}`)}
      onClick={(e) => e.stopPropagation()} onChange={(e) => onFilter(e.target.value)}>
      <option value="all">{t('view-all')}</option><option value="pinned">{t('view-pinned')}</option>
      <option value="active">{t('view-active')}</option><option value="off">{t('view-off')}</option><option value="technical">{t('view-technical')}</option>
    </select>
  </div>;
}
