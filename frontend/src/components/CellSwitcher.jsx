import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, fleetStatus, getRouteSessions } from '../lib/api.js';
import { readCellSwitcherSnapshot, writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { buildLocalRoster, buildRemoteRoster, cellRuntime } from '../lib/roster-view-model.js';
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
        // `verified` e' la conferma di questo poll. Non usare `fresh`: nel
        // roster condiviso significa invece output nuovo e ordina le righe.
        verified: fresh === true,
        working: runtime.working,
        degraded: !!cell.degraded,
        active: cell.active === true,
        activity: session.activity || cell.activity || 0,
        subtitle: runtime.subtitle,
      });
    }
  };
  addCells(snapshot.cells, [...localSessions.values()], snapshot.localFresh === true);
  for (const group of snapshot.nodeGroups || []) {
    const route = Array.isArray(group.route) ? group.route : [];
    // Un device VL non e' una posizione fleet e non ospita celle: la route
    // che porta e' quella del suo OWNER, quindi coincide con la posizione
    // fleet di quell'owner. Discriminare sulla route vuota funzionava solo
    // finche' il nodo VL era locale; da un client federato la sua route non
    // e' vuota e le celle dell'owner verrebbero contate due volte, la
    // seconda sotto l'etichetta del device. Il criterio e' il tipo del
    // gruppo — lo stesso che usano Sidebar e SessionList.
    if (group.kind === 'vl' || !route.length) continue;
    addCells(group.cells, group.sessions, group.switcherFresh === true,
      route, group.label || group.name || '');
  }
  return rows;
}

// Il drawer visualizza soltanto celle Fleet, ma quando salva un riordino deve
// conoscere l'intero roster della posizione. In particolare, le tmux unmanaged
// restano nella lista principale e non devono mai sparire da nc_sidebar_order.
function rosterItemsByPosition(snapshot) {
  const positions = new Map();
  const localSessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const localCells = Array.isArray(snapshot.cells) ? snapshot.cells : [];
  const localByName = new Map(localSessions.map((entry) => [entry.name, entry]));
  const localCellSessions = new Set(localCells.map((cell) => cell.tmuxSession).filter(Boolean));
  positions.set('local', buildLocalRoster(
    localCells,
    localSessions.filter((entry) => !localCellSessions.has(entry.name)),
    localByName,
  ));
  for (const group of snapshot.nodeGroups || []) {
    const route = Array.isArray(group.route) ? group.route : [];
    // Stesso criterio di rowsFromSnapshot: un device VL condivide la route
    // del suo owner, e sovrascriverebbe il roster di quella posizione.
    if (group.kind === 'vl' || !route.length) continue;
    const cells = Array.isArray(group.cells) ? group.cells : [];
    const sessions = Array.isArray(group.sessions) ? group.sessions : [];
    const cellSessions = new Set(cells.map((cell) => cell.tmuxSession).filter(Boolean));
    positions.set(route.join('/'), buildRemoteRoster({
      ...group,
      route,
      cells,
      sessions,
      unmanaged: sessions.filter((entry) => !cellSessions.has(entry.name)),
    }).rawItems);
  }
  return positions;
}

// La rail resta una superficie compatta, ma mantiene le stesse sezioni logiche
// della lista principale: Locale prima, poi ciascuna route nell'ordine ricevuto.
// Entro una posizione applica esattamente nc_pins/nc_sidebar_order_v1.
function orderRowsByPosition(rows, rosterItems, pins, orders) {
  const positions = [...new Set(rows.map((row) => row.node || 'local'))];
  return positions.flatMap((position) => {
    const displayRows = rows.filter((row) => (row.node || 'local') === position);
    const canonical = new Map((rosterItems.get(position) || []).map((item) => [item.key, item]));
    const byKey = new Map(displayRows.map((row) => [row.key, row]));
    // Per il confronto usa gli stessi live/fresh/activity della home, ma
    // restituisce la riga del drawer per non alterarne stato e affordance.
    const sortable = displayRows.map((row) => {
      const item = canonical.get(row.key);
      return {
        ...row,
        label: item?.label || row.label,
        live: item?.live ?? row.live,
        fresh: item?.fresh === true,
        activity: item?.activity ?? row.activity,
      };
    });
    return sidebarItems(sortable, pins, 'all', sidebarOrder(orders, position))
      .map((item) => byKey.get(item.key));
  });
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
  const rosterItems = useMemo(() => rosterItemsByPosition(snapshot), [snapshot]);
  const { pins, orders, canMoveRoster, moveRoster, stepRoster } = useRosterPreferences();
  const orderedRows = useMemo(
    () => orderRowsByPosition(rows, rosterItems, pins, orders),
    [rows, rosterItems, pins, orders],
  );
  const visibleRows = useMemo(
    () => (showAll ? orderedRows : orderedRows.filter((row) => row.selectable || (row.degraded && row.active))),
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
      // Un device VL non e' una posizione fleet: la route che porta e' quella
      // del suo OWNER, quindi coincide con la posizione di quell'owner.
      // Interrogarlo farebbe rispondere l'owner, e il gruppo si riempirebbe
      // delle celle altrui. Deve restare FUORI dalla mappa per route: e'
      // chiavata sulla route e l'ultimo scrittore vince, quindi anche un
      // risultato vuoto qui cancellerebbe quello buono dell'owner.
      const isFleetPosition = (group) => group.kind !== 'vl'
        && Array.isArray(group.route) && group.route.length > 0;
      const remote = await Promise.all(groups.filter(isFleetPosition).map(async (group) => (
        { group, result: await readPosition(token, group.route) }
      )));
      const local = await localRequest;
      if (!alive) return;
      const byRoute = new Map(remote.map(({ group, result }) => [JSON.stringify(group.route || []), result]));
      const nodeGroups = groups.map((group) => {
        if (!isFleetPosition(group)) return { ...group, switcherFresh: false };
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
    if (!row.verified) return t('cell-switcher-not-confirmed');
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
            const rawItems = rosterItems.get(position)
              || rows.filter((candidate) => (candidate.node || 'local') === position);
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
