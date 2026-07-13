import { useEffect, useMemo, useState } from 'react';
import {
  apiFetch, seenKey, fleetStatus, fleetUp, fleetDown, killSession, nodeAction,
} from '../lib/api.js';
import Icon from './Icon.jsx';
import { loadPins, togglePinIn } from '../lib/pins.js';
import { positionKey } from '../lib/nodes-model.js';
import {
  loadSidebarViews, saveSidebarViews, sidebarItems, sidebarSearchVisible, sidebarView,
} from '../lib/sidebar-model.js';
import PowerSheet from './PowerSheet.jsx';
import {t,  LANGUAGES} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useNodes } from '../hooks/useNodes.js';
import './SessionList.css';

// Home mobile: lo stesso roster per-posizione della sidebar desktop. Stato di
// apertura, filtro, pin e ordine hanno quindi un solo contratto condiviso.

// Tempo relativo numerico (nessuna localizzazione, come da piano C3).
function rel(epochSec) {
  if (!epochSec) return '';
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 0 || s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

// Etichetta di stato di un gruppo nodo degradato (design §7: mai spinner).
function nodeStateLabel(g) {
  if (g.status === 'passive') return t('node-passive');
  if (g.status === 'down') {
    return g.downSince ? t('tunnel-down-since').replace('{t}', rel(g.downSince)) : t('tunnel-down');
  }
  if (g.status === 'unreachable') return t('node-unreachable');
  if (g.status === 'offline') return g.lastSeen ? t('node-offline-seen').replace('{t}', rel(g.lastSeen)) : t('node-offline');
  if (g.status === 'needs-repair') return t('node-needs-repair');
  return '';
}

// Dot di salute dal model health a 3 dimensioni (NO verde hardcoded): healthy
// solo se il probe federation e' 200; 401/degraded/down/unknown -> warn + titolo
// diagnostico. h = node.health da /api/nodes (assente sui nodi senza probe).
function healthDot(h) {
  if (!h) return null;
  if (h.status === 'healthy') return 'on';
  return 'warn'; // degraded | down | unknown
}
function healthTitle(h) {
  if (!h) return '';
  return h.detail || h.status || '';
}

export default function SessionList({ onPick, token, onSettings }) {
  const [lang, setLang] = useLang(); // re-render allo switch lingua
  // Gruppi per-nodo remoto (B2): zero nodi configurati -> [] e home identica.
  const nodeGroups = useNodes(token);
  const [sessions, setSessions] = useState(null); // null = primo load
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [version, setVersion] = useState('');
  const [endpoint, setEndpoint] = useState({ bind: '127.0.0.1', port: '' });
  const [cells, setCells] = useState([]);
  const [powerCell, setPowerCell] = useState(null);
  const [nodeBusy, setNodeBusy] = useState(null);
  const [pins, setPins] = useState(loadPins);
  const [views, setViews] = useState(loadSidebarViews);

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

  async function onNodePower(group) {
    if (!group?.direct || nodeBusy) return;
    setNodeBusy(group.name);
    try { await nodeAction(token, group.name, group.tunnelStatus === 'up' ? 'down' : 'up'); }
    catch (_) {}
    setNodeBusy(null);
  }

  const togglePin = (key) => setPins((before) => togglePinIn(before, key));
  const viewFor = (key) => sidebarView(views, key);
  const updateView = (key, patch) => setViews((before) => {
    const next = { ...before, [key]: { ...sidebarView(before, key), ...patch } };
    return saveSidebarViews(next);
  });

  const sessionRows = useMemo(() => (sessions || []).map((s) => {
    const seen = Number(localStorage.getItem(seenKey(s.name)) || 0);
    const fresh = !!(s.outbox && s.outbox.count > 0 && s.outbox.latest > seen);
    return { ...s, fresh };
  }), [sessions]);
  // lookup sessione per tmuxSession (activity/preview/outbox/fresh delle celle)
  const byName = useMemo(() => new Map(sessionRows.map((s) => [s.name, s])), [sessionRows]);
  const cellSessions = useMemo(() => new Set(cells.map((c) => c.tmuxSession)), [cells]);
  const unmanaged = useMemo(
    () => sessionRows.filter((s) => !cellSessions.has(s.name)),
    [sessionRows, cellSessions],
  );
  const localRawItems = useMemo(() => [
    ...cells.map((c) => {
      const s = byName.get(c.tmuxSession) || {};
      return {
        type: 'cell', value: c, key: positionKey([], c.tmuxSession), label: c.cell,
        live: !!c.tmux, fresh: !!s.fresh, activity: s.activity || 0,
        searchText: `${c.engine || ''} ${c.key || ''} ${s.preview || ''}`,
      };
    }),
    ...unmanaged.map((s) => ({
      type: 'session', value: s, key: positionKey([], s.name), label: s.name,
      live: true, fresh: !!s.fresh, activity: s.activity || 0,
      searchText: `${s.preview || ''} ${s.cmd || ''}`,
    })),
  ], [cells, unmanaged, byName]);

  const localView = viewFor('local');
  const localItems = useMemo(
    () => sidebarItems(localRawItems, pins, localView.filter)
      .filter((item) => sidebarSearchVisible(item, q)),
    [localRawItems, pins, localView.filter, q],
  );
  const remoteCount = nodeGroups.reduce(
    (sum, g) => sum + (g.cells || []).length + (g.unmanaged || []).length, 0,
  );
  const rosterTotal = localRawItems.length + remoteCount;

  const total = sessions ? sessions.length : 0;
  const attached = (sessions || []).filter((s) => s.attached).length;
  const endpointLabel = endpoint.port ? `${endpoint.bind}:${endpoint.port}` : endpoint.bind;

  function renderRosterItem(item, group = null) {
    const route = Array.isArray(group?.route) ? group.route : [];
    const routeKey = route.join('/');
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
        <div key={item.key} className="nc-mcard" data-roster-key={item.key}>
          <button className="nc-mcard-main"
            onClick={() => c.tmux && onPick(route.length ? { session: c.tmuxSession, node: routeKey } : c.tmuxSession)}
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
      <div key={item.key} className="nc-mcard" data-roster-key={item.key}>
        <button className="nc-mcard-main" onClick={() => onPick(route.length ? { session: s.name, node: routeKey } : s.name)}>
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
        <MobilePositionHeader label={t('position-local')} count={localRawItems.length} state={localView}
          dotClass="on" onToggle={() => updateView('local', { open: !localView.open })}
          onFilter={(filter) => updateView('local', { filter })} />
        {localView.open && localItems.map((item) => renderRosterItem(item))}
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
        const hd = healthDot(g.health);
        const dotClass = hd || (g.status === 'up' ? 'on' : g.status === 'passive' ? '' : 'warn');
        const dotTitle = g.health ? healthTitle(g.health) : (g.status === 'up' ? '' : nodeStateLabel(g));
        const route = g.route || [g.name];
        const routeKey = route.join('/');
        const groupView = viewFor(routeKey);
        const remoteSessions = new Map((g.sessions || []).map((s) => [s.name, s]));
        const remoteFresh = (s) => {
          const seen = Number(localStorage.getItem(seenKey(positionKey(route, s.name))) || 0);
          return !!(s.outbox && s.outbox.count > 0 && s.outbox.latest > seen);
        };
        const rawItems = [
          ...(g.cells || []).map((c) => {
            const session = remoteSessions.get(c.tmuxSession) || {};
            return {
              type: 'cell', value: c, key: positionKey(route, c.tmuxSession || c.cell), label: c.cell,
              live: !!c.tmux, fresh: remoteFresh({ ...session, name: c.tmuxSession || c.cell }),
              activity: session.activity || c.activity || 0,
              searchText: `${c.engine || ''} ${c.key || ''} ${session.preview || c.preview || ''}`,
            };
          }),
          ...(g.unmanaged || []).map((s) => ({
            type: 'session', value: s, key: positionKey(route, s.name), label: s.name,
            live: true, fresh: remoteFresh(s), activity: s.activity || 0,
            searchText: `${s.preview || ''} ${s.cmd || ''}`,
          })),
        ];
        const items = sidebarItems(rawItems, pins, groupView.filter)
          .filter((item) => sidebarSearchVisible(item, q));
        const nodePower = g.direct && g.health && g.health.managed !== false ? (
          <button type="button" className={`nc-act power${g.tunnelStatus === 'up' ? ' on' : ''}`}
            disabled={nodeBusy === g.name} title={g.tunnelStatus === 'up' ? t('power-off') : t('power-on')}
            aria-label={`${g.tunnelStatus === 'up' ? t('power-off') : t('power-on')} ${g.label || g.name}`}
            onClick={() => onNodePower(g)}><Icon name="power" size={15} /></button>
        ) : null;
        return (
        <section key={`nodo-${routeKey}`} className="nc-group" data-position={routeKey}>
          <MobilePositionHeader label={g.label || g.name} count={rawItems.length} state={groupView}
            dotClass={dotClass} dotTitle={dotTitle}
            detail={g.status === 'up' ? '' : (g.health ? healthTitle(g.health) || nodeStateLabel(g) : nodeStateLabel(g))}
            onToggle={() => updateView(routeKey, { open: !groupView.open })}
            onFilter={(filter) => updateView(routeKey, { filter })} action={nodePower} />
          {g.status === 'up' && groupView.open && items.map((item) => renderRosterItem(item, g))}
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
      </select>
      {action}
    </div>
  );
}
