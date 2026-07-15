import { useEffect, useState } from 'react';
import { t } from '../../lib/i18n.js';
import {
  fleetStatus, getRouteConfig, getRouteSessions, fleetRestart, fleetRemoveCell, killSession,
} from '../../lib/api.js';

// Inventario globale (task Hydra): per OGNI posizione (Locale + ogni route Hydra)
// mostra celle Fleet attive e inattive (engine/stato) + sessioni tmux unmanaged,
// raggruppate e etichettate. Le azioni start/stop/restart/delete compaiono SOLO
// se la posizione le supporta (capability negotiation) e agiscono sulla ROUTE
// corretta. Il power-off di una cella remota e' ripristinato dove il nodo ne
// possiede il lifecycle; sulle posizioni non gestibili (peer inbound senza
// capability, READONLY) non si mostra alcun power fittizio.
// Estratto invariato da FleetTab.jsx; la ownership delle chiamate API resta qui.
export default function FleetInventory({ token, targets = [], readonly = false, onPower, onImport }) {
  const [data, setData] = useState([]);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let alive = true;
    async function poll() {
      const positions = [{ route: [], label: t('local') }].concat(
        (targets || []).map((x) => ({ route: Array.isArray(x.route) ? x.route : [], label: x.label || (x.route || []).join(' › ') })),
      );
      const results = await Promise.all(positions.map(async (pos) => {
        const out = { ...pos, available: false, readonly: false, capabilities: [], provider: null, cells: [], unmanaged: [], err: '' };
        try {
          const fs = await fleetStatus(token, pos.route);
          out.available = !!fs.available; out.capabilities = fs.capabilities || []; out.provider = fs.provider || null;
          out.cells = (fs.cells || []).map((c) => ({ ...c, route: pos.route }));
          try { out.readonly = !!(await getRouteConfig(token, pos.route)).readonlyDefault; } catch (_) { /* gate server resta autorità */ }
          try {
            const sj = await getRouteSessions(token, pos.route);
            const cellTmux = new Set(out.cells.map((c) => c.tmuxSession).filter(Boolean));
            out.unmanaged = (sj.sessions || []).filter((s) => s && !cellTmux.has(s.name));
          } catch (_) { /* posizione senza /sessions: resta solo cells */ }
        } catch (e) { out.err = String((e && e.message) || e); }
        return out;
      }));
      if (alive) setData(results);
    }
    poll();
    const id = setInterval(poll, 6000);
    return () => { alive = false; clearInterval(id); };
  }, [token, targets, bump]);

  const can = (pos, cap) => Array.isArray(pos.capabilities) && pos.capabilities.includes(cap) && !readonly && !pos.readonly;
  const after = () => setBump((b) => b + 1);
  // up/down passano dal launch editor condiviso (PowerSheet): niente fleetUp diretto.
  const cellUp = (c, route) => { if (onPower) onPower({ ...c, route }); };
  const cellDown = (c, route) => { if (onPower) onPower({ ...c, route }); };
  const cellRestart = async (c, route) => { try { await fleetRestart(token, c.cell, route); } catch (_) {} after(); };
  const cellRemove = async (c, route) => {
    if (!window.confirm(t('fleet-remove-cell').replace('{id}', c.cell))) return;
    try { await fleetRemoveCell(token, c.cell, true, route); } catch (_) {} after();
  };
  const killUnmanaged = async (s, route) => {
    if (!window.confirm(t('terminate-confirm').replace('{name}', s.name))) return;
    try { await killSession(token, s.name, route); } catch (_) {} after();
  };

  return (
    <div className="nc-fleet-inventory">
      <div className="nc-fleet-section-head"><b>{t('fleet-inventory')}</b><small>{t('fleet-inventory-help')}</small></div>
      {data.map((pos) => {
        const key = pos.route.length ? pos.route.join('/') : 'local';
        return (
          <div className="nc-fleet-pos" key={key}>
            <div className="nc-fleet-pos-title">
              <span className={`dot ${pos.available ? 'on' : 'warn'}`} />
              <b>{pos.label}</b>
              <small>{pos.available ? `${pos.cells.length} ${t('fleet-cells')} · ${pos.unmanaged.length} ${t('fleet-tmux')}` : (pos.err || t('fleet-not-available'))}</small>
            </div>
            {pos.cells.map((c) => (
              <div className="nc-fleet-item nc-fleet-cell" key={`${key}:${c.cell}`}>
                <span><b>{c.cell}</b><small>{`${c.engine || ''}${c.key ? `·${c.key}` : ''}${c.active ? '' : ` · ${t('cell-off')}`}`}</small></span>
                <span className="nc-fleet-cell-actions">
                  {c.active && can(pos, 'down') && <button className="nc-btn ghost" title={t('power-off')} onClick={() => cellDown(c, pos.route)}>{t('stop')}</button>}
                  {!c.active && can(pos, 'up') && <button className="nc-btn ghost" title={t('power-on')} onClick={() => cellUp(c, pos.route)}>{t('start')}</button>}
                  {can(pos, 'restart') && c.active && <button className="nc-btn ghost" title={t('restart')} onClick={() => cellRestart(c, pos.route)}>{t('restart')}</button>}
                  {can(pos, 'remove') && <button className="nc-btn danger" title={t('delete')} onClick={() => cellRemove(c, pos.route)}>×</button>}
                </span>
              </div>
            ))}
            {pos.unmanaged.map((s) => (
              <div className="nc-fleet-item nc-fleet-unmanaged" key={`${key}:u:${s.name}`}>
                <span><b>{s.name}</b><small>{t('fleet-tmux')}</small></span>
                <span className="nc-fleet-cell-actions">
                  {can(pos, 'import') && onImport && <button className="nc-btn ghost" title={t('import-as-cell')} onClick={() => onImport(s, pos.route)}>{t('import-as-cell')}</button>}
                  <button className="nc-btn danger" title={t('terminate')} onClick={() => killUnmanaged(s, pos.route)}>×</button>
                </span>
              </div>
            ))}
            {pos.available && pos.cells.length === 0 && pos.unmanaged.length === 0 && (
              <div className="nc-empty">{t('fleet-inventory-empty')}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
