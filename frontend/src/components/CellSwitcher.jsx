import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, fleetStatus, getRouteSessions } from '../lib/api.js';
import { readCellSwitcherSnapshot, writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { cellRuntime } from '../lib/roster-view-model.js';
import { positionKey } from '../lib/nodes-model.js';
import { sidebarItems, sidebarOrder } from '../lib/sidebar-model.js';
import { useRosterPreferences } from '../hooks/useRosterPreferences.js';
import RosterHandle from './RosterHandle.jsx';
import { t } from '../lib/i18n.js';
import './CellSwitcher.css';

const POLL_MS = 4000;

async function localSessions(token) {
  const response = await apiFetch('/api/sessions', token);
  if (response?.ok === false) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.sessions)) throw new Error('invalid sessions payload');
  return payload.sessions;
}

async function readPosition(token, route = []) {
  const [sessionsResult, fleetResult] = await Promise.allSettled([
    route.length ? getRouteSessions(token, route) : localSessions(token),
    fleetStatus(token, route),
  ]);
  const sessions = sessionsResult.status === 'fulfilled' && Array.isArray(sessionsResult.value?.sessions)
    ? sessionsResult.value.sessions
    : (Array.isArray(sessionsResult.value) ? sessionsResult.value : null);
  const fleet = fleetResult.status === 'fulfilled' ? fleetResult.value : null;
  const cells = fleet?.available === true && Array.isArray(fleet.cells) ? fleet.cells : null;
  return { sessions, cells, fresh: Array.isArray(sessions) && Array.isArray(cells) };
}

function isActiveCell(cell, sessions, fresh) {
  return fresh === true && cell?.degraded !== true && cell?.active === true && cell.tmux !== false
    && !!cell.tmuxSession && (sessions || []).some((session) => session?.name === cell.tmuxSession);
}

function rowsFromSnapshot(snapshot) {
  const localSessions = new Map((snapshot.sessions || []).map((entry) => [entry.name, entry]));
  const rows = [];
  const addCells = (cells, sessions, fresh, route = [], nodeLabel = '') => {
    const byName = new Map((sessions || []).map((entry) => [entry.name, entry]));
    for (const cell of cells || []) {
      const session = byName.get(cell.tmuxSession) || {};
      const runtime = cellRuntime(cell, session);
      const selectable = isActiveCell(cell, sessions, fresh);
      rows.push({
        // Deve corrispondere a SessionList: il locale non ha prefisso, le
        // route remote restano qualificate. Cosi' pin e ordine sono condivisi.
        key: positionKey(route, cell.tmuxSession || cell.cell),
        session: cell.tmuxSession,
        route,
        cellName: cell.cell,
        label: cell.cell,
        node: route.length ? route.join('/') : '',
        nodeLabel,
        live: selectable,
        selectable,
        fresh: fresh === true,
        working: runtime.working,
        degraded: !!cell.degraded,
        activity: session.activity || cell.activity || 0,
        subtitle: runtime.subtitle,
      });
    }
  };
  addCells(snapshot.cells, [...localSessions.values()], snapshot.localFresh === true);
  for (const group of snapshot.nodeGroups || []) {
    addCells(group.cells, group.sessions, group.switcherFresh === true,
      Array.isArray(group.route) ? group.route : [], group.label || group.name || '');
  }
  return rows;
}

// La rail resta una superficie compatta, ma mantiene le stesse sezioni logiche
// della lista principale: Locale prima, poi ciascuna route nell'ordine ricevuto.
// Entro una posizione applica esattamente nc_pins/nc_sidebar_order_v1.
function orderRowsByPosition(rows, pins, orders) {
  const positions = [...new Set(rows.map((row) => row.node || 'local'))];
  return positions.flatMap((position) => sidebarItems(
    rows.filter((row) => (row.node || 'local') === position),
    pins,
    'all',
    sidebarOrder(orders, position),
  ));
}

export default function CellSwitcher({ token, current, onPick, onClose }) {
  const [snapshot, setSnapshot] = useState(readCellSwitcherSnapshot);
  const [showAll, setShowAll] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [picking, setPicking] = useState('');
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const rows = useMemo(() => rowsFromSnapshot(snapshot), [snapshot]);
  const { pins, orders, canMoveRoster, moveRoster, stepRoster } = useRosterPreferences();
  const orderedRows = useMemo(() => orderRowsByPosition(rows, pins, orders), [rows, pins, orders]);
  const visibleRows = useMemo(
    () => (showAll ? orderedRows : orderedRows.filter((row) => row.selectable || row.degraded)),
    [orderedRows, showAll],
  );
  const selectedRow = useMemo(() => rows.find((row) => row.key === selectedKey && row.selectable), [rows, selectedKey]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const base = readCellSwitcherSnapshot();
      const groups = Array.isArray(base.nodeGroups) ? base.nodeGroups : [];
      const localRequest = readPosition(token);
      const remote = await Promise.all(groups.map(async (group) => {
        const route = Array.isArray(group.route) ? group.route : [];
        if (!route.length) return { group, result: { fresh: false, sessions: null, cells: null } };
        return { group, result: await readPosition(token, route) };
      }));
      const local = await localRequest;
      if (!alive) return;
      const byRoute = new Map(remote.map(({ group, result }) => [JSON.stringify(group.route || []), result]));
      const nodeGroups = groups.map((group) => {
        const result = byRoute.get(JSON.stringify(group.route || []));
        if (!result) return { ...group, switcherFresh: false };
        return {
          ...group,
          sessions: result.sessions || group.sessions || [],
          cells: result.cells || group.cells || [],
          switcherFresh: result.fresh,
        };
      });
      const next = writeCellSwitcherSnapshot({
        ...base,
        sessions: local.sessions || base.sessions || [],
        cells: local.cells || base.cells || [],
        localFresh: local.fresh,
        nodeGroups,
        refreshedAt: Date.now(),
      });
      setSnapshot(next);
      setReady(true);
      inFlight = false;
    };
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token]);

  const statusFor = (row) => {
    if (row.degraded) return t('cell-degraded');
    if (!row.fresh) return t('cell-switcher-not-confirmed');
    if (!row.selectable) return t('cell-off');
    return row.working ? t('cell-working') : t('cell-idle');
  };

  const select = (row) => {
    setNotice('');
    if (!row.selectable) {
      setNotice(t('cell-switcher-not-active'));
      return;
    }
    setSelectedKey(row.key);
  };

  const pick = async () => {
    const row = selectedRow;
    if (!row) {
      setNotice(t('cell-switcher-select'));
      return;
    }
    setNotice('');
    setPicking(row.key);
    try {
      // Una cella puo' morire tra il poll e il tocco: ricontrolla la posizione
      // prima di cambiare vista, cosi' non si tenta mai un attach stantio.
      const latest = await readPosition(token, row.route);
      const cell = (latest.cells || []).find((entry) => entry?.cell === row.cellName
        && entry?.tmuxSession === row.session);
      if (!isActiveCell(cell, latest.sessions, latest.fresh)) {
        setNotice(t('cell-switcher-not-active'));
        return;
      }
      onPick({ session: row.session, ...(row.node ? { node: row.node } : {}), cellName: row.cellName });
      onClose();
    } catch (_) {
      setNotice(t('cell-switcher-not-active'));
    } finally {
      setPicking('');
    }
  };

  return (
    <div className="nc-cell-switcher-backdrop" onClick={onClose}>
      <aside ref={dialogRef} className="nc-cell-switcher" role="dialog"
        aria-label={t('fleet-cells')} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="nc-cell-switcher-list">
          {!ready && <div className="nc-empty" role="status">{t('cell-switcher-refreshing')}</div>}
          {ready && visibleRows.length === 0 && <div className="nc-empty" role="status">{t('cell-switcher-empty-active')}</div>}
          {visibleRows.map((row) => {
            const currentRow = current?.session === row.session && (current?.node || '') === row.node;
            const selected = selectedKey === row.key;
            const status = statusFor(row);
            const position = row.node || 'local';
            const rawItems = rows.filter((candidate) => (candidate.node || 'local') === position);
            return (
              <div key={row.key} className={`nc-cell-switcher-row${currentRow ? ' current' : ''}${selected ? ' selected' : ''}${row.selectable ? '' : ' off'}`}
                data-roster-key={row.key} data-position={position}>
                <RosterHandle position={position} itemKey={row.key} label={row.cellName}
                  canMove={canMoveRoster}
                  onMove={(source, target) => moveRoster(position, source, target, rawItems)}
                  onStep={(delta) => stepRoster(position, row.key, delta, rawItems)} />
                <button type="button" className="nc-cell-switcher-row-select"
                  aria-current={currentRow ? 'true' : undefined} aria-pressed={selected} aria-disabled={!row.selectable}
                  disabled={picking === row.key} onClick={() => select(row)}>
                  <span className={`nc-cell-switcher-dot${row.degraded ? ' warn' : row.live ? ` on${row.working ? ' working' : ''}` : ''}`} />
                  <span className="nc-cell-switcher-copy"><b>{row.cellName}</b><small className="nc-cell-switcher-state">{status}</small><small>{[row.nodeLabel, row.subtitle].filter(Boolean).join(' · ')}</small></span>
                </button>
              </div>
            );
          })}
        </div>
        {notice && <div className="nc-cell-switcher-notice" role="status">{notice}</div>}
        <div className="nc-cell-switcher-actions">
          <button type="button" className="nc-cell-switcher-open" disabled={!selectedRow || !!picking} onClick={pick}>
            {selectedRow ? `${t('cell-switcher-open')}: ${selectedRow.cellName}` : t('cell-switcher-select')}
          </button>
        </div>
        <div className="nc-cell-switcher-controls">
          <b>{t('fleet-cells')}</b>
          <button type="button" className="nc-cell-switcher-filter" aria-pressed={showAll}
            onClick={() => { setNotice(''); setShowAll((value) => !value); }}>
            {showAll ? t('cell-switcher-show-active') : t('cell-switcher-show-all')}
          </button>
          <button ref={closeRef} type="button" className="nc-cell-switcher-close" aria-label={t('cell-switcher-close')}
            title={t('cell-switcher-close')} onClick={onClose}>×</button>
        </div>
      </aside>
    </div>
  );
}
