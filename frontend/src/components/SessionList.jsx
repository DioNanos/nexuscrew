import { useEffect, useMemo, useState } from 'react';
import {
  apiFetch, fleetStatus, fleetUp, fleetDown, fleetBoot, killSession, nodeAction, renameNodeLabel, setSessionTechnical,
} from '../lib/api.js';
import Icon from './Icon.jsx';
import { sidebarItems, sidebarOrder, sidebarSearchVisible } from '../lib/sidebar-model.js';
import PowerSheet from './PowerSheet.jsx';
import {t,  LANGUAGES} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useNodes } from '../hooks/useNodes.js';
import RosterHandle from './RosterHandle.jsx';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import { useNodePreferences } from '../hooks/useNodePreferences.js';
import {
  rel, nodeStateLabel, healthDot, healthTitle, buildLocalRoster, buildRemoteRoster,
} from '../lib/roster-view-model.js';
import { OWNER_ID_RE } from '../lib/grid-model.js';
import { isValidLabel } from '../lib/settings-model.js';
import './SessionList.css';

const bootCellKey = (cell, route = []) => `${route.length ? route.join('/') : 'local'}:${cell}`;

// Home mobile: lo stesso roster per-posizione della sidebar desktop. Stato di
// apertura, filtro, pin e ordine hanno quindi un solo contratto condiviso
// (hook useRosterPreferences + model roster-view-model).

export default function SessionList({ onPick, token, onSettings }) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  // Gruppi per-nodo remoto (B2): zero nodi configurati -> [] e home identica.
  const nodeGroups = useNodes(token);
  const [sessions, setSessions] = useState(null); // null = primo load
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [version, setVersion] = useState('');
  const [endpoint, setEndpoint] = useState({ bind: '127.0.0.1', port: '' });
  const [localNodeId, setLocalNodeId] = useState('');
  const [cells, setCells] = useState([]);
  const [fleetCapabilities, setFleetCapabilities] = useState([]);
  const [bootOverrides, setBootOverrides] = useState({});
  const [bootBusy, setBootBusy] = useState(new Set());
  const [powerCell, setPowerCell] = useState(null);
  const [nodeBusy, setNodeBusy] = useState(null);
  const {
    pins, orders, togglePin, viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  } = useRosterPreferences();
  const {
    groupsFor: preferredGroups, moveNode, stepNode, nodeKey,
  } = useNodePreferences();
  const preferredNodeGroups = preferredGroups(nodeGroups);

  // Converge l'override ottimistico sulla source of truth restituita dai poll
  // locali/Hydra. PowerSheet e toggle diretto scrivono la stessa proprieta'.
  useEffect(() => {
    const actual = new Map();
    for (const c of cells) actual.set(bootCellKey(c.cell), !!c.boot);
    for (const g of nodeGroups) {
      const route = g.route || [g.name];
      for (const c of g.cells || []) actual.set(bootCellKey(c.cell, route), !!c.boot);
    }
    setBootOverrides((current) => {
      let changed = false; const next = { ...current };
      for (const [key, value] of Object.entries(current)) {
        if (actual.has(key) && actual.get(key) === value) { delete next[key]; changed = true; }
      }
      return changed ? next : current;
    });
  }, [cells, nodeGroups]);

  async function refresh() {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (j.error) { setErr(j.error); setSessions([]); }
      else { setErr(null); setSessions(j.sessions || []); }
    } catch (e) { setErr(String(e)); setSessions([]); }
    // flotta nello stesso interval del polling sessioni (4s)
    try {
      const fs = await fleetStatus(token);
      setCells(fs.available ? (fs.cells || []) : []);
      setFleetCapabilities(fs.available ? (fs.capabilities || []) : []);
    } catch (_) { setCells([]); setFleetCapabilities([]); }
  }

  useEffect(() => {
    refresh();
    apiFetch('/api/config', token).then((r) => r.json())
      .then((j) => {
        setVersion(j.version || '');
        setEndpoint({ bind: j.bind || '127.0.0.1', port: j.port || '' });
        setLocalNodeId(OWNER_ID_RE.test(String(j.instanceId || '')) ? j.instanceId : '');
      }).catch(() => {});
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  async function copyEndpointUrl() {
    if (!endpoint.port) return;
    const url = `http://${endpoint.bind}:${endpoint.port}/#token=${token}`;
    try { await navigator.clipboard.writeText(url); } catch (_) { /* clipboard non disponibile */ }
  }

  function setBootChoice(cell, route, enabled) {
    const key = bootCellKey(cell, route);
    setBootOverrides((current) => ({ ...current, [key]: !!enabled }));
  }

  function bootEnabled(c, route = []) {
    const key = bootCellKey(c.cell, route);
    return Object.prototype.hasOwnProperty.call(bootOverrides, key) ? bootOverrides[key] : !!c.boot;
  }

  async function onBootToggle(event, c, route = []) {
    event.stopPropagation();
    const key = bootCellKey(c.cell, route); const enabled = !bootEnabled(c, route);
    setBootChoice(c.cell, route, enabled);
    setBootBusy((current) => new Set(current).add(key));
    try {
      // Cambia soltanto la preferenza per il prossimo boot: lifecycle invariato.
      await fleetBoot(token, { cell: c.cell, enabled }, route);
      if (!route.length) setCells((current) => current.map((entry) => (
        entry.cell === c.cell ? { ...entry, boot: enabled } : entry
      )));
    } catch (error) {
      setBootOverrides((current) => { const next = { ...current }; delete next[key]; return next; });
      setErr(String(error?.message || error));
    } finally {
      setBootBusy((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  }

  async function onFleetConfirm(payload) {
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
      setBootChoice(cell, route, !!payload.boot);
    } else {
      await fleetDown(token, { cell, boot: !!payload.boot }, route);
      if (payload.boot) setBootChoice(cell, route, false);
    }
    refresh();
  }

  async function onKill(name, route = []) {
    try { await killSession(token, name, route); } catch (_) { return; }
    refresh();
  }

  async function onTechnical(name, technical, route = []) {
    try { await setSessionTechnical(token, name, technical, route); } catch (_) { return; }
    refresh();
  }

  async function onNodePower(group) {
    if (!group?.direct || nodeBusy) return;
    setNodeBusy(group.name);
    try { await nodeAction(token, group.name, group.tunnelStatus === 'up' ? 'down' : 'up'); }
    catch (_) {}
    setNodeBusy(null);
  }

  async function promptNodeRename(group) {
    if (!group?.direct) return;
    const next = window.prompt(t('rename-node-prompt'), group.label || group.name);
    if (next === null) return;
    const label = String(next).trim();
    if (!isValidLabel(label)) { window.alert(t('rename-node-invalid')); return; }
    try { await renameNodeLabel(token, group.name, label); }
    catch (error) { window.alert(String(error?.message || error)); }
  }

  // lookup sessione per tmuxSession (activity/preview/outbox delle celle)
  const byName = useMemo(() => new Map((sessions || []).map((s) => [s.name, s])), [sessions]);
  const cellSessions = useMemo(() => new Set(cells.map((c) => c.tmuxSession)), [cells]);
  const unmanaged = useMemo(
    () => (sessions || []).filter((s) => !cellSessions.has(s.name)),
    [sessions, cellSessions],
  );
  const localRawItems = useMemo(
    () => buildLocalRoster(cells, unmanaged, byName),
    [cells, unmanaged, byName],
  );

  const localView = viewFor('local');
  const localItems = useMemo(
    () => sidebarItems(localRawItems, pins, localView.filter, sidebarOrder(orders, 'local'))
      .filter((item) => sidebarSearchVisible(item, q)),
    [localRawItems, pins, localView.filter, q, orders],
  );
  const remoteCount = preferredNodeGroups.reduce(
    (sum, g) => sum + (g.cells || []).length + (g.unmanaged || []).filter((s) => !s.technical).length, 0,
  );
  const rosterTotal = sidebarItems(localRawItems, pins, 'all', sidebarOrder(orders, 'local')).length + remoteCount;

  // Il vecchio header contava solo /api/sessions locale: con celle Fleet vive
  // ricavate dall'inventario (o route Hydra) poteva quindi mostrare 0. Conta
  // l'unione normalizzata celle-live + tmux unmanaged, senza duplicare la
  // sessione sottostante di una cella.
  const total = localRawItems.filter((item) => item.live).length
    + preferredNodeGroups.reduce((sum, group) => (
      sum + buildRemoteRoster(group).rawItems.filter((item) => item.live).length
    ), 0);
  const attachedRaw = (sessions || []).filter((s) => s.attached).length
    + preferredNodeGroups.reduce(
      (sum, group) => sum + (group.sessions || []).filter((s) => s.attached).length, 0,
    );
  // Durante la cache status una sessione tmux puo' risultare ancora attached
  // mentre la cella Fleet e' gia' off. Il sottoconteggio non deve mai superare
  // l'inventario live normalizzato mostrato nello stesso header.
  const attached = Math.min(attachedRaw, total);
  const endpointLabel = endpoint.port ? `${endpoint.bind}:${endpoint.port}` : endpoint.bind;

  function renderRosterItem(item, group = null, rawItems = localRawItems) {
    const route = Array.isArray(group?.route) ? group.route : [];
    const routeKey = route.join('/'); const position = routeKey || 'local';
    const ownerId = route.length ? group?.instanceId : localNodeId;
    const pickOwned = (name) => onPick({
      session: name,
      ...(routeKey ? { node: routeKey } : {}),
      ...(OWNER_ID_RE.test(String(ownerId || '')) ? { ownerId } : {}),
    });
    const canMove = canMoveRoster;
    if (item.type === 'cell') {
      const c = item.value;
      const session = route.length
        ? (group?.sessions || []).find((candidate) => candidate.name === c.tmuxSession)
        : byName.get(c.tmuxSession);
      const stateTitle = c.degraded
        ? t('cell-degraded')
        : item.working ? item.subtitle : c.tmux ? t('cell-idle') : t('cell-off');
      const canPower = route.length === 0 || (group?.capabilities || []).includes(c.active ? 'down' : 'up');
      const canBoot = route.length === 0
        ? fleetCapabilities.includes('boot')
        : (group?.capabilities || []).includes('boot');
      const boot = bootEnabled(c, route); const bootKey = bootCellKey(c.cell, route);
      const bootLabel = `${t(boot ? 'boot-disable' : 'boot-enable')} ${c.cell}`;
      return (
        <div key={item.key} className="nc-mcard" data-roster-key={item.key} data-position={position}>
          <RosterHandle position={position} itemKey={item.key} label={c.cell}
            canMove={canMove}
            onMove={(source, target) => moveRoster(position, source, target, rawItems)}
            onStep={(delta) => stepRoster(position, item.key, delta, rawItems)} />
          <button className="nc-mcard-main"
            onClick={() => c.tmux && pickOwned(c.tmuxSession)}
            title={stateTitle} aria-label={`${c.cell}, ${stateTitle}`}>
            <span className={`dot ${c.degraded ? 'warn' : c.tmux ? `on${item.working ? ' working' : ''}` : ''}`} />
            <span className="nc-mcard-text"><b>{c.cell}</b><small title={item.subtitle}>{item.subtitle}</small></span>
          </button>
          {item.activity ? <span className="nc-rel">{rel(item.activity)}</span> : null}
          {item.fresh && session?.outbox?.count > 0 && <span className="nc-badge" title={t('new-files-outbox')}>{session.outbox.count}</span>}
          <button className={`nc-act pin${pins.includes(item.key) ? ' on' : ''}`}
            aria-label={`${t('pin')} ${c.cell}`} title={t('pin')} onClick={() => togglePin(item.key)}>
            {pins.includes(item.key) ? '\u2605' : '\u2606'}
          </button>
          {canBoot && <button className={`nc-act boot${boot ? ' on' : ''}`} disabled={bootBusy.has(bootKey)}
            onClick={(event) => onBootToggle(event, c, route)} title={bootLabel} aria-label={bootLabel}>
            <Icon name="boot" size={16} />
          </button>}
          {canPower && <button className={`nc-act power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
            onClick={() => setPowerCell(route.length
              ? { ...c, boot, route, availableEngines: group?.engines || [] }
              : { ...c, boot })}
            title={c.active ? t('power-off') : t('power-on')} aria-label={`${c.active ? t('power-off') : t('power-on')} ${c.cell}`}>
            <Icon name="power" size={16} />
          </button>}
        </div>
      );
    }

    const s = item.value;
    return (
      <div key={item.key} className="nc-mcard" data-roster-key={item.key} data-position={position}>
        <RosterHandle position={position} itemKey={item.key} label={s.name}
          canMove={canMove}
          onMove={(source, target) => moveRoster(position, source, target, rawItems)}
          onStep={(delta) => stepRoster(position, item.key, delta, rawItems)} />
        <button className="nc-mcard-main" onClick={() => pickOwned(s.name)}>
          <span className={s.attached ? 'dot on' : 'dot'} />
          <span className="nc-mcard-text">
            <b>{s.name}</b>
            <small>{s.preview ? s.preview : (s.cmd ? s.cmd : t('windows').replace('{n}', String(s.windows || 0)))}</small>
          </span>
        </button>
        {item.activity ? <span className="nc-rel">{rel(item.activity)}</span> : null}
        {item.fresh && s.outbox?.count > 0 && <span className="nc-badge" title={t('new-files-outbox')}>{s.outbox.count}</span>}
        <button className={`nc-act pin${pins.includes(item.key) ? ' on' : ''}`}
          aria-label={`${t('pin')} ${s.name}`} title={t('pin')} onClick={() => togglePin(item.key)}>
          {pins.includes(item.key) ? '\u2605' : '\u2606'}
        </button>
        <button className={`nc-act technical${s.technical ? ' on' : ''}`}
          title={s.technical ? t('mark-normal') : t('mark-technical')}
          aria-label={`${s.technical ? t('mark-normal') : t('mark-technical')} ${s.name}`}
          onClick={() => onTechnical(s.name, !s.technical, route)}>T</button>
        <button className="nc-menu" title={t('terminate')} aria-label={`${t('terminate')} ${s.name}`}
          onClick={() => { if (window.confirm(t('terminate-confirm').replace('{name}', s.name))) onKill(s.name, route); }}>⋯</button>
      </div>
    );
  }

  return (
    <div className="nc-home">
      <header className="nc-home-head">
        <div className="nc-wordmark">NexusCrew<span className="nc-cursor" /></div>
        <div className="nc-home-sub">
          {t('fleet-tmux')} · {total} {t('sessions')}{attached > 0 && ` · ${attached} attached`}
        </div>
        <span className="nc-head-actions">
          <button className="nc-refresh" onClick={() => onSettings('nodes', false)} title={t('settings')}><Icon name="gear" size={18} /></button>
          <button className="nc-refresh" onClick={refresh} title={t('refresh')}><Icon name="refresh" size={18} /></button>
        </span>
      </header>

      <main className="nc-home-scroll">
      {rosterTotal > 8 && (
        <input
          className="nc-filter" type="search" placeholder={t('filter-placeholder')} aria-label={t('filter-placeholder')}
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      )}

      {err && <div className="nc-err">{err}</div>}

      <section className="nc-group" data-position="local">
        <MobilePositionHeader label={t('position-local')} count={localItems.length} state={localView}
          dotClass="on" onToggle={() => updateView('local', { open: !localView.open })}
          onFilter={(filter) => updateView('local', { filter })} />
        {localView.open && localItems.map((item) => renderRosterItem(item, null, localRawItems))}
        {localView.open && sessions === null && <div className="nc-empty">{t('loading-fleet')}</div>}
        {localView.open && sessions !== null && localItems.length === 0 && !err && (
          <div className="nc-empty">{q ? t('no-match').replace('{q}', q) : t('no-sessions-short')}</div>
        )}
      </section>

      {/* Gruppi per-nodo remoto (Hydra): per ogni posizione mostriamo celle Fleet
          (attive e inattive, con engine/active) + tmux unmanaged. La salute e'
          quella del probe federato (NO verde hardcoded): 401/degraded -> warn con
          diagnostica. Tunnel del nodo diretto controllabile (power); peer inbound
          non gestito da qui -> niente power finto. */}
      {preferredNodeGroups.map((g) => {
        const hd = healthDot(g.health, { passive: 'warn' });
        const dotClass = hd || (g.status === 'up' ? 'on' : g.status === 'passive' ? '' : 'warn');
        const dotTitle = g.health ? healthTitle(g.health) : (g.status === 'up' ? '' : nodeStateLabel(g));
        const route = g.route || [g.name];
        const routeKey = route.join('/');
        const groupView = viewFor(routeKey);
        const { rawItems } = buildRemoteRoster(g);
        const items = sidebarItems(rawItems, pins, groupView.filter, sidebarOrder(orders, routeKey))
          .filter((item) => sidebarSearchVisible(item, q));
        const nodePower = g.direct && g.health && g.health.managed !== false ? (
          <button type="button" className={`nc-act power${g.tunnelStatus === 'up' ? ' on' : ''}`}
            disabled={nodeBusy === g.name} title={g.tunnelStatus === 'up' ? t('power-off') : t('power-on')}
            aria-label={`${g.tunnelStatus === 'up' ? t('power-off') : t('power-on')} ${g.label || g.name}`}
            onClick={() => onNodePower(g)}><Icon name="power" size={15} /></button>
        ) : null;
        const nodeActions = (
          <span className="nc-node-actions">
            <RosterHandle scope="node" position="nodes" itemKey={nodeKey(g)} label={g.label || g.name}
              onMove={(source, target) => moveNode(source, target, nodeGroups)}
              onStep={(delta) => stepNode(nodeKey(g), delta, nodeGroups)} />
            {g.direct && <button type="button" className="nc-node-rename" title={t('rename-node')}
              aria-label={`${t('rename-node')} ${g.label || g.name}`}
              onClick={() => promptNodeRename(g)}>✎</button>}
            {nodePower}
          </span>
        );
        return (
        <section key={`nodo-${routeKey}`} className="nc-group nc-node-order-wrap" data-position={routeKey}
          data-node-order-key={nodeKey(g)}>
          <MobilePositionHeader label={g.label || g.name} count={items.length} state={groupView}
            dotClass={dotClass} dotTitle={dotTitle}
            detail={g.status === 'up' ? '' : (g.health ? healthTitle(g.health) || nodeStateLabel(g) : nodeStateLabel(g))}
            onToggle={() => updateView(routeKey, { open: !groupView.open })}
            onFilter={(filter) => updateView(routeKey, { filter })}
            onRename={g.direct ? () => promptNodeRename(g) : null} action={nodeActions} />
          {g.status === 'up' && groupView.open && items.map((item) => renderRosterItem(item, g, rawItems))}
          {g.status === 'up' && groupView.open && items.length === 0 && (
            <div className="nc-empty">{q ? t('no-match').replace('{q}', q) : t('no-sessions-short')}</div>
          )}
        </section>
        );
      })}

      <footer className="nc-home-foot" onClick={copyEndpointUrl} title={t('copy-url')}>
        <span className="nc-home-meta">
          {version && <span className="nc-home-version">v{version}</span>}
          <span className="nc-home-endpoint">{endpointLabel} · {t('ssh-only')}</span>
        </span>
        <span className="nc-lang" onClick={(e) => e.stopPropagation()}>
          {LANGUAGES.map((lg, i) => (
            <span key={lg}>
              {i > 0 && ' · '}
              <button className={`nc-lang-btn${lang === lg ? ' on' : ''}`} onClick={() => setLang(lg)} title={lg}>{lg.toUpperCase()}</button>
            </span>
          ))}
        </span>
      </footer>
      </main>

      <button className="nc-fab" onClick={() => onSettings('fleet', true)} title={t('fleet-new-cell')} aria-label={t('fleet-new-cell')}>+</button>

      {powerCell && (
        <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : []} onConfirm={onFleetConfirm} onClose={() => setPowerCell(null)} />
      )}
    </div>
  );
}

function MobilePositionHeader({
  label, count, state, dotClass = '', dotTitle = '', detail = '', onToggle, onFilter, onRename = null, action = null,
}) {
  return (
    <div className="nc-mobile-position-head"
      onContextMenu={onRename ? (event) => { event.preventDefault(); onRename(); } : undefined}>
      <button type="button" className="nc-mobile-position-toggle" onClick={onToggle}
        aria-expanded={state.open} aria-label={`${label} · ${t('node-sessions').replace('{n}', String(count))}`}>
        <span className="nc-mobile-chevron" aria-hidden="true">{state.open ? '⌄' : '›'}</span>
        <span className={`dot ${dotClass}`} title={dotTitle} />
        <span className="nc-mobile-position-copy">
          <b>{label}</b>
          <small>{detail || t('node-sessions').replace('{n}', String(count))}</small>
        </span>
      </button>
      <select className="nc-mobile-position-filter" value={state.filter}
        aria-label={`${label} · ${t('filter-placeholder')}`} title={t(`view-${state.filter}`)}
        onChange={(event) => onFilter(event.target.value)}>
        <option value="all">{t('view-all')}</option>
        <option value="pinned">{t('view-pinned')}</option>
        <option value="active">{t('view-active')}</option>
        <option value="off">{t('view-off')}</option>
        <option value="technical">{t('view-technical')}</option>
      </select>
      {action}
    </div>
  );
}
