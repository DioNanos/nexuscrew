import { useEffect, useMemo, useState } from 'react';
import {
  apiFetch, fleetStatus, fleetUp, fleetDown, killSession, nodeAction, setSessionTechnical,
} from '../lib/api.js';
import Icon from './Icon.jsx';
import { sidebarItems, sidebarOrder, sidebarSearchVisible } from '../lib/sidebar-model.js';
import PowerSheet from './PowerSheet.jsx';
import {t,  LANGUAGES} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useNodes } from '../hooks/useNodes.js';
import RosterHandle from './RosterHandle.jsx';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import {
  rel, nodeStateLabel, healthDot, healthTitle, buildLocalRoster, buildRemoteRoster,
} from '../lib/roster-view-model.js';
import { OWNER_ID_RE } from '../lib/grid-model.js';
import './SessionList.css';

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
  const [powerCell, setPowerCell] = useState(null);
  const [nodeBusy, setNodeBusy] = useState(null);
  const {
    pins, orders, togglePin, viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  } = useRosterPreferences();

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
    } catch (_) { setCells([]); }
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
    } else {
      await fleetDown(token, { cell, boot: !!payload.boot }, route);
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
  const remoteCount = nodeGroups.reduce(
    (sum, g) => sum + (g.cells || []).length + (g.unmanaged || []).filter((s) => !s.technical).length, 0,
  );
  const rosterTotal = sidebarItems(localRawItems, pins, 'all', sidebarOrder(orders, 'local')).length + remoteCount;

  const total = sessions ? sessions.length : 0;
  const attached = (sessions || []).filter((s) => s.attached).length;
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
      const preview = session?.preview || c.preview || '';
      const sub = [`${c.engine}${c.key ? `·${c.key}` : ''}`, preview, c.active ? '' : t('cell-off')]
        .filter(Boolean).join(' · ');
      const canPower = route.length === 0 || (group?.capabilities || []).includes(c.active ? 'down' : 'up');
      return (
        <div key={item.key} className="nc-mcard" data-roster-key={item.key} data-position={position}>
          <RosterHandle position={position} itemKey={item.key} label={c.cell}
            canMove={canMove}
            onMove={(source, target) => moveRoster(position, source, target, rawItems)}
            onStep={(delta) => stepRoster(position, item.key, delta, rawItems)} />
          <button className="nc-mcard-main"
            onClick={() => c.tmux && pickOwned(c.tmuxSession)}
            title={c.degraded ? t('cell-degraded') : c.tmux ? t('cell-on') : t('cell-off')}>
            <span className={`dot ${c.degraded ? 'warn' : c.tmux ? 'on' : ''}`} />
            <span className="nc-mcard-text"><b>{c.cell}</b><small>{sub}</small></span>
          </button>
          {item.activity ? <span className="nc-rel">{rel(item.activity)}</span> : null}
          {item.fresh && session?.outbox?.count > 0 && <span className="nc-badge" title={t('new-files-outbox')}>{session.outbox.count}</span>}
          <button className={`nc-act pin${pins.includes(item.key) ? ' on' : ''}`}
            aria-label={`${t('pin')} ${c.cell}`} title={t('pin')} onClick={() => togglePin(item.key)}>
            {pins.includes(item.key) ? '\u2605' : '\u2606'}
          </button>
          {canPower && <button className={`nc-act power${c.tmux ? ' on' : ''}${c.degraded ? ' warn' : ''}`}
            onClick={() => setPowerCell(route.length ? { ...c, route, availableEngines: group?.engines || [] } : c)}
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
      {nodeGroups.map((g) => {
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
        return (
        <section key={`nodo-${routeKey}`} className="nc-group" data-position={routeKey}>
          <MobilePositionHeader label={g.label || g.name} count={items.length} state={groupView}
            dotClass={dotClass} dotTitle={dotTitle}
            detail={g.status === 'up' ? '' : (g.health ? healthTitle(g.health) || nodeStateLabel(g) : nodeStateLabel(g))}
            onToggle={() => updateView(routeKey, { open: !groupView.open })}
            onFilter={(filter) => updateView(routeKey, { filter })} action={nodePower} />
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
  label, count, state, dotClass = '', dotTitle = '', detail = '', onToggle, onFilter, action = null,
}) {
  return (
    <div className="nc-mobile-position-head">
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
