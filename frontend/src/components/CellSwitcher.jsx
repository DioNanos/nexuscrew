import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, fleetStatus } from '../lib/api.js';
import { readCellSwitcherSnapshot, writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';
import { cellRuntime } from '../lib/roster-view-model.js';
import { t } from '../lib/i18n.js';
import './CellSwitcher.css';

function rowsFromSnapshot(snapshot) {
  const localSessions = new Map((snapshot.sessions || []).map((entry) => [entry.name, entry]));
  const rows = [];
  const addCells = (cells, sessions, route = [], nodeLabel = '') => {
    const byName = new Map((sessions || []).map((entry) => [entry.name, entry]));
    for (const cell of cells || []) {
      const session = byName.get(cell.tmuxSession) || {};
      const runtime = cellRuntime(cell, session);
      rows.push({
        key: `${route.join('/') || 'local'}:${cell.tmuxSession}`,
        session: cell.tmuxSession,
        cellName: cell.cell,
        node: route.length ? route.join('/') : '',
        nodeLabel,
        live: !!cell.tmux,
        working: runtime.working,
        degraded: !!cell.degraded,
        activity: session.activity || cell.activity || 0,
        subtitle: runtime.subtitle,
      });
    }
  };
  addCells(snapshot.cells, [...localSessions.values()]);
  for (const group of snapshot.nodeGroups || []) {
    addCells(group.cells, group.sessions, Array.isArray(group.route) ? group.route : [], group.label || group.name || '');
  }
  return rows.sort((a, b) => Number(b.live) - Number(a.live) || b.activity - a.activity || a.cellName.localeCompare(b.cellName));
}

export default function CellSwitcher({ token, current, onPick, onClose }) {
  const [snapshot, setSnapshot] = useState(readCellSwitcherSnapshot);
  const dialogRef = useRef(null);
  const rows = useMemo(() => rowsFromSnapshot(snapshot), [snapshot]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch('/api/sessions', token).then((response) => response.json()).catch(() => ({})),
      fleetStatus(token).catch(() => ({})),
    ]).then(([sessions, fleet]) => {
      if (!alive) return;
      const next = writeCellSwitcherSnapshot({
        ...readCellSwitcherSnapshot(),
        sessions: Array.isArray(sessions.sessions) ? sessions.sessions : snapshot.sessions,
        cells: fleet.available ? (fleet.cells || []) : snapshot.cells,
      });
      setSnapshot(next);
    });
    return () => { alive = false; };
  }, [token]);

  return (
    <div className="nc-cell-switcher-backdrop" onClick={onClose}>
      <aside ref={dialogRef} className="nc-cell-switcher" role="dialog" aria-modal="true"
        aria-label={t('fleet-cells')} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="nc-cell-switcher-head"><b>{t('fleet-cells')}</b><button type="button" onClick={onClose}>×</button></div>
        <div className="nc-cell-switcher-list">
          {rows.length === 0 && <div className="nc-empty">{t('fleet-inventory-empty')}</div>}
          {rows.map((row) => {
            const selected = current?.session === row.session && (current?.node || '') === row.node;
            const title = row.degraded ? t('cell-degraded') : (row.working ? t('cell-working') : (row.live ? t('cell-idle') : t('cell-off')));
            return (
              <button type="button" key={row.key} className={`nc-cell-switcher-row${selected ? ' on' : ''}${row.live ? '' : ' off'}`}
                disabled={!row.live} title={title}
                onClick={() => { onPick({ session: row.session, ...(row.node ? { node: row.node } : {}), cellName: row.cellName }); onClose(); }}>
                <span className={`nc-cell-switcher-dot${row.degraded ? ' warn' : row.live ? ` on${row.working ? ' working' : ''}` : ''}`} />
                <span className="nc-cell-switcher-copy"><b>{row.cellName}</b><small>{[row.nodeLabel, row.subtitle].filter(Boolean).join(' · ')}</small></span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
