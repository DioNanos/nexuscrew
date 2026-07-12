import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import {
  fleetStatus, fleetDefinitions, fleetDefineEngine, fleetEditEngine, fleetRemoveEngine,
  fleetDefineCell, fleetEditCell, fleetRemoveCell, fleetRestart, fleetUp, fleetDown,
  fleetImportCell, killSession, getRouteSessions,
  fleetRestoreCells,
  listDirs, getRouteConfig,
} from '../lib/api.js';
import PowerSheet from './PowerSheet.jsx';
import { createFleetBackup, parseFleetBackup, restoreCellDefinition } from '../lib/fleet-backup.js';

const blankEngine = () => ({ kind: 'managed', id: 'claude.native', label: '', client: 'claude', provider: 'native', credentialProfile: '', managedModel: '', permissionPolicy: 'unsafe', displayName: '', protocol: 'anthropic_messages', baseUrl: '', envKey: '', providerId: 'nexuscrew-custom', command: '', argsText: '', rc: true, promptMode: 'send-keys', promptFlag: '', modelFlag: '', modelValue: '', envRows: [] });
const blankCell = (engine = '') => ({ id: '', cwd: '', engine, boot: false, model: '', prompt: '' });
const defaultPermission = (client) => client === 'claude' ? 'unsafe' : 'standard';
const catalogEntry = (catalog, form) => catalog.find((p) => p.client === form.client && p.provider === form.provider && (p.credentialProfile || '') === (form.credentialProfile || ''));
const managedLabel = (catalog, form) => catalogEntry(catalog, form)?.label || `${form.client} · ${form.provider}`;

function engineForm(e) {
  return {
    kind: e.managed ? 'managed' : 'custom',
    id: e.id, label: e.label || '', command: e.command || '', argsText: (e.args || []).join('\n'), rc: !!e.rc,
    client: e.managed?.client || 'claude', provider: e.managed?.provider || 'native', credentialProfile: e.managed?.credentialProfile || '', managedModel: e.managed?.model || '',
    permissionPolicy: e.managed?.permissionPolicy || defaultPermission(e.managed?.client), displayName: e.managed?.displayName || '', protocol: e.managed?.protocol || '', baseUrl: e.managed?.baseUrl || '', envKey: e.managed?.envKey || '', providerId: e.managed?.providerId || 'nexuscrew-custom', modelOptions: e.availableModels || e.managedInfo?.models || [],
    promptMode: e.promptMode || 'send-keys', promptFlag: e.promptFlag || '',
    modelFlag: e.model?.flag || '', modelValue: e.model?.value || '',
    envRows: (e.envKeys || []).map((key) => ({ key, value: '', configured: true, remove: false })),
  };
}

function buildEngine(form, creating, catalog = []) {
  if (form.kind === 'managed') {
    const managed = { client: form.client, provider: form.provider, model: form.managedModel || '', permissionPolicy: form.permissionPolicy || defaultPermission(form.client) };
    if (form.credentialProfile) managed.credentialProfile = form.credentialProfile;
    const profile = catalogEntry(catalog, form);
    if (profile?.credentialEnv) managed.envKey = form.envKey;
    if (form.provider === 'custom') Object.assign(managed, { displayName: form.displayName, protocol: form.protocol, baseUrl: form.baseUrl, envKey: form.envKey, providerId: form.providerId });
    return {
      ...(creating ? { id: form.id } : {}), label: form.label || managedLabel(catalog, form), rc: !!form.rc,
      managed,
    };
  }
  const out = {
    ...(creating ? { id: form.id } : {}), label: form.label || form.id, rc: !!form.rc,
    command: form.command, args: form.argsText.split('\n').filter((x) => x !== ''), promptMode: form.promptMode,
  };
  if (form.modelFlag) out.model = { flag: form.modelFlag, value: form.modelValue || '' };
  if (form.promptMode === 'flag') out.promptFlag = form.promptFlag;
  if (creating) out.env = Object.fromEntries(form.envRows.filter((r) => !r.remove && r.key).map((r) => [r.key, r.value]));
  return out;
}

function FleetModal({ children, onClose, label, error = '' }) {
  const dialogRef = useRef(null);
  const errorRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) || []).filter((element) => element.offsetParent !== null);
    const frame = requestAnimationFrame(() => (focusable()[0] || dialog)?.focus({ preventScroll: true }));
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey);
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!error) return;
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'nearest' }));
  }, [error]);
  return (
    <div className="nc-fleet-modal" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="nc-fleet-modal-dialog" role="dialog" aria-modal="true" aria-label={label || t('settings')} tabIndex={-1}>
        {children}
        {error && <div ref={errorRef} className="nc-err nc-fleet-modal-error" role="alert" aria-live="assertive">{error}</div>}
      </div>
    </div>
  );
}

export default function FleetTab({ token, readonly, targets = [], startNewCell = false, initialLocation = '' }) {
  const [defs, setDefs] = useState({ engines: [], cells: [], managedCatalog: [] });
  const [status, setStatus] = useState({ available: false, capabilities: [] });
  const [engineEdit, setEngineEdit] = useState(null);
  const [cellEdit, setCellEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [location, setLocation] = useState(initialLocation);
  const [remoteReadonly, setRemoteReadonly] = useState(false);
  const [powerCell, setPowerCell] = useState(null);
  const [importEdit, setImportEdit] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const autoCreateDone = useRef(false);
  const route = location ? location.split('/') : [];

  const refresh = useCallback(async () => {
    try {
      const st = await fleetStatus(token, route); setStatus(st);
      try { const cfg = await getRouteConfig(token, route); setRemoteReadonly(!!cfg.readonlyDefault); } catch (_) { setRemoteReadonly(false); }
      if (st.provider === 'builtin' && (st.capabilities || []).includes('definitions')) {
        const next = await fleetDefinitions(token, route);
        const runtime = new Map((st.engines || []).map((engine) => [engine.id, engine]));
        next.engines = (next.engines || []).map((engine) => ({ ...engine, availableModels: runtime.get(engine.id)?.models || [] }));
        setDefs(next);
      }
    } catch (e) { setErr(String(e.message || e)); }
  }, [token, location]);
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id); }, [refresh]);

  const active = new Set((status.cells || []).filter((c) => c.active).map((c) => c.cell));
  const editable = status.provider === 'builtin' && (status.capabilities || []).includes('edit');
  const canRestoreBackup = (status.capabilities || []).includes('restore');
  useEffect(() => {
    if (!startNewCell || autoCreateDone.current || !editable || !defs.engines.length) return;
    autoCreateDone.current = true;
    setCellEdit({ mode: 'new', form: blankCell(defs.engines[0].id) });
  }, [startNewCell, editable, defs.engines]);
  const run = async (fn) => {
    setBusy(true); setErr(''); setNote('');
    try { await fn(); await refresh(); } catch (e) { setErr(String(e.message || e)); }
    setBusy(false);
  };

  const saveEngine = () => run(async () => {
    const creating = engineEdit.mode === 'new';
    const def = buildEngine(engineEdit.form, creating, defs.managedCatalog || []);
    if (!creating && engineEdit.form.kind === 'custom' && !engineEdit.form.modelFlag) def.model = null;
    if (!creating && engineEdit.form.kind === 'custom' && engineEdit.form.promptMode !== 'flag') def.promptFlag = null;
    let result;
    if (creating) result = await fleetDefineEngine(token, def, route);
    else {
      const original = engineEdit.original;
      const currentKeys = new Set(engineEdit.form.envRows.filter((r) => !r.remove).map((r) => r.key));
      const remove = (original.envKeys || []).filter((k) => !currentKeys.has(k));
      const set = Object.fromEntries(engineEdit.form.envRows.filter((r) => !r.remove && r.key && (!r.configured || r.value !== '')).map((r) => [r.key, r.value]));
      result = await fleetEditEngine(token, original.id, def, engineEdit.form.kind === 'custom' ? { set, remove } : undefined, route);
    }
    setEngineEdit(null); setNote(t('fleet-saved'));
    const affected = result?.activeCells || [];
    if (affected.length && window.confirm(t('fleet-restart-confirm').replace('{cells}', affected.join(', ')))) {
      for (const id of affected) await fleetRestart(token, id, route);
    }
  });

  const saveCell = () => run(async () => {
    const creating = cellEdit.mode === 'new';
    const f = cellEdit.form;
    const def = { ...(creating ? { id: f.id } : {}), cwd: f.cwd, engine: f.engine, boot: !!f.boot };
    if (creating) {
      if (f.model) def.model = f.model;
      if (f.prompt) def.prompt = f.prompt;
    } else {
      def.model = f.model || null;
      def.prompt = f.prompt || null;
    }
    const result = creating ? await fleetDefineCell(token, def, route) : await fleetEditCell(token, cellEdit.original.id, def, route);
    const id = creating ? f.id : cellEdit.original.id;
    setCellEdit(null); setNote(t('fleet-saved'));
    if (!creating && result?.active && window.confirm(t('fleet-restart-confirm').replace('{cells}', id))) await fleetRestart(token, id, route);
  });

  const locked = readonly || remoteReadonly;

  // Launch editor condiviso (PowerSheet): Avvia dalla lista celle e dalla card
  // inventory aprono lo stesso sheet (non fleetUp diretto, niente UI duplicata).
  const onPower = (c) => setPowerCell({
    ...c,
    route: Array.isArray(c?.route) ? c.route : route,
  });
  const onFleetConfirm = async (payload) => {
    if (!powerCell) return;
    const id = powerCell.cell || powerCell.id;
    const actionRoute = Array.isArray(powerCell.route) ? powerCell.route : route;
    if (payload.action === 'up') {
      await fleetUp(token, {
        cell: id, boot: !!payload.boot,
        ...(payload.engine ? { engine: payload.engine } : {}),
        ...(payload.model !== undefined ? { model: payload.model } : {}),
        ...(payload.permissionPolicy ? { permissionPolicy: payload.permissionPolicy } : {}),
      }, actionRoute);
    } else {
      await fleetDown(token, { cell: id, boot: !!payload.boot }, actionRoute);
    }
  };

  const openImport = (session, targetRoute) => {
    setErr('');
    setImportEdit({
      mode: 'new',
      route: Array.isArray(targetRoute) ? targetRoute : route,
      form: { tmuxSession: session.name, id: '', engine: '', cwd: '', boot: false },
      err: '',
    });
  };

  // Import esplicito di una sessione tmux (cella Fleet legacy orfana, es jarvis)
  // in una cella GESTITA fleet.json. NESSUNA invenzione: engine obbligatorio e
  // già dichiarato; id/tmuxSession prefilled; cwd di default la home. Dopo l'import
  // la sessione sparisce da "unmanaged" e compare in Fleet con lifecycle gestito.
  const doImport = () => run(async () => {
    const f = importEdit.form;
    if (!f.engine) { setImportEdit({ ...importEdit, err: t('import-engine-required') }); return; }
    await fleetImportCell(token, {
      tmuxSession: f.tmuxSession, id: f.id || undefined, engine: f.engine,
      cwd: f.cwd || undefined, boot: !!f.boot,
    }, f.route || route);
    setImportEdit(null);
    setNote(t('fleet-saved'));
  });
  const restoreBackup = (rows) => run(async () => {
    const engineIds = defs.engines.map((engine) => engine.id);
    const restored = [];
    for (const row of rows) {
      const def = restoreCellDefinition(row.cell, row.engine, engineIds);
      if (!def) throw new Error(`${row.cell.id}: ${t('fleet-backup-engine-missing')}`);
      restored.push(def);
    }
    const overwrites = rows.filter((row) => row.exists).map((row) => row.cell.id);
    if (overwrites.length && !window.confirm(t('fleet-backup-confirm-overwrite').replace('{cells}', overwrites.join(', ')))) return;
    const result = await fleetRestoreCells(token, restored, route);
    const restart = result.needsRestart || [];
    setBackupOpen(false); setNote(`${t('fleet-backup-restored').replace('{n}', String(rows.length))}${restart.length ? ` · ${t('fleet-backup-needs-restart').replace('{cells}', restart.join(', '))}` : ''}`);
  });
  const locationPicker = <label className="nc-field">{t('location')}<select value={location} onChange={(e) => {
    setLocation(e.target.value); setEngineEdit(null); setCellEdit(null); setErr(''); setNote(''); setRemoteReadonly(false);
    setStatus({ available: false, capabilities: [] }); setDefs({ engines: [], cells: [], managedCatalog: [] });
  }}>
    <option value="">{t('local')}</option>{targets.map((x) => <option key={x.route.join('/')} value={x.route.join('/')} disabled={x.status && x.status !== 'up'}>{x.label}{x.status && x.status !== 'up' ? ` · ${t('node-offline')}` : ''}</option>)}
  </select></label>;
  if (!editable) return (
    <div className="nc-set-tab">
      {locationPicker}
      <FleetInventory token={token} targets={targets} readonly={readonly} onPower={onPower} onImport={openImport} />
      <div className="nc-set-info">{t('fleet-editor-unavailable')}</div>
      {err && <div className="nc-err">{err}</div>}
      {importEdit && <FleetModal onClose={() => setImportEdit(null)} label={t('import-as-cell')} error={err}><ImportEditor token={token} route={importEdit.route || route} state={importEdit} setState={setImportEdit} busy={busy} onSave={doImport} /></FleetModal>}
      {powerCell && <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : route} onConfirm={async (p) => { try { await onFleetConfirm(p); } finally { await refresh(); } }} onClose={() => setPowerCell(null)} />}
    </div>
  );
  return (
    <div className="nc-set-tab nc-fleet-editor">
      {locationPicker}
      <FleetInventory token={token} targets={targets} readonly={readonly} onPower={onPower} onImport={openImport} />
      <div className="nc-fleet-section-head"><b>{t('fleet-engines')}</b><button className="nc-btn primary" disabled={locked || busy} onClick={() => { setErr(''); setEngineEdit({ mode: 'new', form: blankEngine() }); }}>+ {t('add')}</button></div>
      {defs.engines.map((e) => (
        <div className="nc-fleet-item" key={e.id}><span><b>{e.label}</b><small>{e.managed
          ? `${e.id} · ${e.managed.client} / ${e.managed.provider} · ${e.managedInfo?.configured ? t('fleet-ready') : e.managedInfo?.reason || t('fleet-not-ready')}`
          : `${e.id} · ${e.command}`}</small></span><span>
          <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setEngineEdit({ mode: 'edit', original: e, form: engineForm(e) }); }}>{t('edit')}</button>
          <button className="nc-btn danger" disabled={locked || busy} onClick={() => run(async () => { if (window.confirm(t('fleet-remove-engine').replace('{id}', e.id))) await fleetRemoveEngine(token, e.id, route); })}>×</button>
        </span></div>
      ))}
      {engineEdit && <FleetModal onClose={() => setEngineEdit(null)} label={t('fleet-new-engine')} error={err}><EngineEditor state={engineEdit} setState={setEngineEdit} busy={busy} onSave={saveEngine} catalog={defs.managedCatalog || []} /></FleetModal>}

      <div className="nc-fleet-section-head"><b>{t('fleet-cells')}</b><span className="nc-fleet-head-actions">
        <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setBackupOpen(true); }}>{t('fleet-backup')}</button>
        <button className="nc-btn primary" disabled={locked || busy || !defs.engines.length} onClick={() => { setErr(''); setCellEdit({ mode: 'new', form: blankCell(defs.engines[0]?.id) }); }}>+ {t('add')}</button>
      </span></div>
      {defs.cells.map((c) => {
        const isOn = active.has(c.id);
        const caps = status.capabilities || [];
        return (
        <div className="nc-fleet-item" key={c.id}><span><b>{c.id}</b><small>{c.engine} · {c.cwd}{isOn ? ` · ${t('service-active')}` : ` · ${t('cell-off')}`}</small></span><span>
          {isOn && caps.includes('down') && <button className="nc-btn ghost" disabled={locked || busy}
            onClick={() => run(() => fleetDown(token, { cell: c.id }, route))}>{t('stop')}</button>}
          {!isOn && caps.includes('up') && <button className="nc-btn primary" disabled={locked || busy}
            onClick={() => onPower({ cell: c.id, id: c.id, engine: c.engine, model: c.model, models: c.models, permissionPolicies: c.permissionPolicies, active: false, boot: c.boot })}>{t('start')}</button>}
          {isOn && caps.includes('restart') && <button className="nc-btn ghost" disabled={locked || busy}
            onClick={() => run(() => fleetRestart(token, c.id, route))}>{t('restart')}</button>}
          <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setCellEdit({ mode: 'edit', original: c, form: { ...c } }); }}>{t('edit')}</button>
          <button className="nc-btn danger" disabled={locked || busy} onClick={() => run(async () => { if (window.confirm(t('fleet-remove-cell').replace('{id}', c.id))) await fleetRemoveCell(token, c.id, true, route); })}>×</button>
        </span></div>
      );})}
      {cellEdit && <FleetModal onClose={() => setCellEdit(null)} label={t('fleet-new-cell')} error={err}><CellEditor token={token} route={route} targets={targets} location={location} setLocation={setLocation} state={cellEdit} setState={setCellEdit} engines={defs.engines} busy={busy} onSave={saveCell} /></FleetModal>}
      {note && <div className="nc-set-note">{note}</div>}{err && <div className="nc-err">{err}</div>}
      {backupOpen && <FleetModal onClose={() => setBackupOpen(false)} label={t('fleet-backup')} error={err}><FleetBackupDialog cells={defs.cells} engines={defs.engines} busy={busy} canRestore={canRestoreBackup} onRestore={restoreBackup} onClose={() => setBackupOpen(false)} /></FleetModal>}
      {importEdit && <FleetModal onClose={() => setImportEdit(null)} label={t('import-as-cell')} error={err}><ImportEditor token={token} route={importEdit.route || route} state={importEdit} setState={setImportEdit} busy={busy} onSave={doImport} /></FleetModal>}
      {powerCell && <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : route} onConfirm={async (p) => { try { await onFleetConfirm(p); } finally { await refresh(); } }} onClose={() => setPowerCell(null)} />}
    </div>
  );
}

// Inventario globale (task Hydra): per OGNI posizione (Locale + ogni route Hydra)
// mostra celle Fleet attive e inattive (engine/stato) + sessioni tmux unmanaged,
// raggruppate e etichettate. Le azioni start/stop/restart/delete compaiono SOLO
// se la posizione le supporta (capability negotiation) e agiscono sulla ROUTE
// corretta. Il power-off di una cella remota e' ripristinato dove il nodo ne
// possiede il lifecycle; sulle posizioni non gestibili (peer inbound senza
// capability, READONLY) non si mostra alcun power fittizio.
function FleetInventory({ token, targets = [], readonly = false, onPower, onImport }) {
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

function FleetBackupDialog({ cells = [], engines = [], busy, canRestore = false, onRestore, onClose }) {
  const [tab, setTab] = useState('export');
  const [selectedOut, setSelectedOut] = useState(() => new Set(cells.map((cell) => cell.id)));
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const engineIds = engines.map((engine) => engine.id);
  const existing = new Set(cells.map((cell) => cell.id));

  const toggleOut = (id) => setSelectedOut((before) => {
    const next = new Set(before); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const exportSelected = () => {
    const backup = createFleetBackup(cells, selectedOut);
    if (!backup.cells.length) { setError(t('fleet-backup-select-one')); return; }
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `nexuscrew-cells-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0); setError('');
  };
  const readFile = async (file) => {
    setError(''); setRows([]);
    if (!file) return;
    if (file.size > 1024 * 1024) { setError(t('fleet-backup-too-large')); return; }
    try {
      const parsed = parseFleetBackup(await file.text());
      if (!parsed.ok) { setError(t(`fleet-backup-${parsed.error}`)); return; }
      setRows(parsed.cells.map((cell) => {
        const engineOk = engineIds.includes(cell.engine);
        const exists = existing.has(cell.id);
        return { cell, engine: engineOk ? cell.engine : '', selected: engineOk && !exists, exists };
      }));
    } catch (e) { setError(String(e.message || e)); }
  };
  const updateRow = (index, patch) => setRows((before) => before.map((row, i) => i === index ? { ...row, ...patch } : row));
  const selectedRows = rows.filter((row) => row.selected && row.engine);

  return (
    <div className="nc-set-form nc-fleet-form nc-backup-dialog">
      <b>{t('fleet-backup')}</b>
      <small>{t('fleet-backup-help')}</small>
      <div className="nc-set-tabs nc-backup-tabs">
        <button type="button" className={`nc-set-tabbtn${tab === 'export' ? ' on' : ''}`} onClick={() => { setTab('export'); setError(''); }}>{t('fleet-backup-export')}</button>
        <button type="button" className={`nc-set-tabbtn${tab === 'import' ? ' on' : ''}`} disabled={!canRestore}
          title={canRestore ? '' : t('fleet-backup-restore-unavailable')}
          onClick={() => { setTab('import'); setError(''); }}>{t('fleet-backup-import')}</button>
      </div>
      {tab === 'export' ? <>
        <div className="nc-set-row">
          <button type="button" className="nc-btn ghost" onClick={() => setSelectedOut(new Set(cells.map((cell) => cell.id)))}>{t('select-all')}</button>
          <button type="button" className="nc-btn ghost" onClick={() => setSelectedOut(new Set())}>{t('select-none')}</button>
        </div>
        <div className="nc-backup-list">
          {cells.map((cell) => <label className="nc-check nc-backup-row" key={cell.id}>
            <input type="checkbox" checked={selectedOut.has(cell.id)} onChange={() => toggleOut(cell.id)} />
            <span><b>{cell.id}</b><small>{cell.engine} · {t('fleet-system-prompt')} {(cell.prompt || '').length} {t('characters')}</small></span>
          </label>)}
          {!cells.length && <div className="nc-empty">{t('fleet-backup-empty')}</div>}
        </div>
        <div className="nc-sheet-actions"><button type="button" className="nc-btn ghost" onClick={onClose}>{t('cancel')}</button><button type="button" className="nc-btn primary" disabled={!selectedOut.size} onClick={exportSelected}>{t('fleet-backup-download')}</button></div>
      </> : <>
        <input type="file" accept="application/json,.json" disabled={busy} onChange={(e) => readFile(e.target.files && e.target.files[0])} />
        <small>{t('fleet-backup-import-help')}</small>
        {!!rows.length && <div className="nc-set-row">
          <button type="button" className="nc-btn ghost" onClick={() => setRows((all) => all.map((row) => ({ ...row, selected: !!row.engine })))}>{t('select-all')}</button>
          <button type="button" className="nc-btn ghost" onClick={() => setRows((all) => all.map((row) => ({ ...row, selected: false })))}>{t('select-none')}</button>
        </div>}
        <div className="nc-backup-list">
          {rows.map((row, index) => <div className="nc-backup-import-row" key={row.cell.id}>
            <label className="nc-check">
              <input type="checkbox" checked={row.selected} disabled={!row.engine} onChange={(e) => updateRow(index, { selected: e.target.checked })} />
              <span><b>{row.cell.id}</b><small>{row.exists ? t('fleet-backup-overwrite') : t('fleet-backup-new')} · {t('fleet-system-prompt')} {row.cell.systemPrompt.length} {t('characters')}</small></span>
            </label>
            <select value={row.engine} onChange={(e) => updateRow(index, { engine: e.target.value, selected: !!e.target.value })}>
              <option value="">{t('fleet-backup-engine-missing')}</option>
              {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.label || engine.id}</option>)}
            </select>
          </div>)}
        </div>
        <div className="nc-sheet-actions"><button type="button" className="nc-btn ghost" onClick={onClose}>{t('cancel')}</button><button type="button" className="nc-btn primary" disabled={busy || !selectedRows.length} onClick={() => onRestore(selectedRows)}>{t('fleet-backup-restore')}</button></div>
      </>}
      {error && <div className="nc-err">{error}</div>}
    </div>
  );
}

function EngineEditor({ state, setState, busy, onSave, catalog }) {
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const rows = f.envRows || [];
  const clients = [...new Map(catalog.map((p) => [p.client, p.clientLabel || p.client])).entries()];
  const profiles = catalog.filter((p) => p.client === f.client);
  const selectedProfile = catalogEntry(catalog, f);
  const setManagedProfile = (entry) => {
    if (!entry) return;
    set({ client: entry.client, provider: entry.provider, credentialProfile: entry.credentialProfile || '', managedModel: entry.model || '', protocol: entry.protocol || '', permissionPolicy: entry.permissionPolicyDefault || 'standard', rc: !!entry.rc, displayName: entry.custom ? t('fleet-custom-provider-default') : '', baseUrl: entry.custom ? '' : entry.endpoint || '', envKey: entry.defaultEnvKey || '', providerId: 'nexuscrew-custom', ...(state.mode === 'new' ? { id: entry.id, label: '' } : {}) });
  };
  return <div className="nc-set-form nc-fleet-form">
    <b>{state.mode === 'new' ? t('fleet-new-engine') : `${t('edit')} ${f.id}`}</b>
    <input value={f.id} disabled={state.mode !== 'new'} placeholder="id" onChange={(e) => set({ id: e.target.value })} />
    <input value={f.label} placeholder={t('label')} onChange={(e) => set({ label: e.target.value })} />
    <select value={f.kind} disabled={state.mode !== 'new'} onChange={(e) => set({ kind: e.target.value })}><option value="managed">{t('fleet-managed')}</option><option value="custom">{t('fleet-custom')}</option></select>
    {f.kind === 'managed' ? <>
      <div className="nc-fleet-pair">
        <select value={f.client} disabled={state.mode !== 'new'} onChange={(e) => setManagedProfile(catalog.find((p) => p.client === e.target.value && p.default) || catalog.find((p) => p.client === e.target.value))}>{clients.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select value={catalogEntry(catalog, f)?.id || ''} disabled={state.mode !== 'new'} onChange={(e) => setManagedProfile(catalog.find((p) => p.id === e.target.value))}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      </div>
      <input value={f.managedModel} list="nc-managed-models" placeholder={t(selectedProfile?.requiresModel ? 'fleet-model-required' : 'fleet-model-default')} onChange={(e) => set({ managedModel: e.target.value })} />
      <datalist id="nc-managed-models">{[...(selectedProfile?.models || []), ...(f.modelOptions || [])].filter((value, index, all) => value && all.indexOf(value) === index).map((model) => <option key={model} value={model} />)}</datalist>
      {selectedProfile?.supportsUnsafe ? <select value={f.permissionPolicy} onChange={(e) => set({ permissionPolicy: e.target.value })}><option value="standard">{t('fleet-standard-permissions')}</option><option value="unsafe">{t('fleet-unsafe-permissions')}</option></select> : <small>{t('fleet-standard-permissions')}</small>}
      {selectedProfile?.supportsUnsafe && f.permissionPolicy === 'unsafe' && <small className="nc-err">{t('fleet-unsafe-warning')}</small>}
      {selectedProfile?.credentialEnv && <>
        <input value={f.envKey} placeholder={t('fleet-api-key-env')} onChange={(e) => set({ envKey: e.target.value })} />
        <small>{t('fleet-custom-secret-help')}</small>
      </>}
      {f.provider === 'custom' && <>
        <input value={f.displayName} placeholder={t('fleet-provider-display')} onChange={(e) => set({ displayName: e.target.value })} />
        <input value={f.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />
        {(selectedProfile?.protocols || []).length > 1 && <select value={f.protocol} onChange={(e) => set({ protocol: e.target.value })}>{selectedProfile.protocols.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select>}
        <div className="nc-fleet-pair"><input value={f.envKey} placeholder={t('fleet-api-key-env')} onChange={(e) => set({ envKey: e.target.value })} /><input value={f.providerId} placeholder={t('fleet-provider-id')} onChange={(e) => set({ providerId: e.target.value })} /></div>
        <small>{f.protocol} · {t('fleet-custom-secret-help')}</small>
      </>}
      <small>{t('fleet-managed-help')}</small>
    </> : <>
      <input value={f.command} placeholder={t('command-path')} onChange={(e) => set({ command: e.target.value })} />
      <textarea value={f.argsText} placeholder={t('args-lines')} onChange={(e) => set({ argsText: e.target.value })} />
      <label className="nc-check"><input type="checkbox" checked={f.rc} onChange={(e) => set({ rc: e.target.checked })} /> remote control</label>
      <select value={f.promptMode} onChange={(e) => set({ promptMode: e.target.value })}><option value="send-keys">send-keys</option><option value="flag">flag</option></select>
      {f.promptMode === 'flag' && <input value={f.promptFlag} placeholder="prompt flag" onChange={(e) => set({ promptFlag: e.target.value })} />}
      <div className="nc-fleet-pair"><input value={f.modelFlag} placeholder="model flag" onChange={(e) => set({ modelFlag: e.target.value })} /><input value={f.modelValue} placeholder="model default" onChange={(e) => set({ modelValue: e.target.value })} /></div>
      <small>{t('env-write-only')}</small>
      {rows.map((r, i) => <div className="nc-fleet-env" key={`${r.key}-${i}`}><input value={r.key} disabled={r.configured} placeholder="ENV_KEY" onChange={(e) => { const n = rows.slice(); n[i] = { ...r, key: e.target.value }; set({ envRows: n }); }} /><input type="password" value={r.value} placeholder={r.configured ? '•••••• (unchanged)' : 'value'} onChange={(e) => { const n = rows.slice(); n[i] = { ...r, value: e.target.value }; set({ envRows: n }); }} /><button className="nc-btn danger" onClick={() => set({ envRows: rows.filter((_, x) => x !== i) })}>×</button></div>)}
      <button className="nc-btn ghost" onClick={() => set({ envRows: [...rows, { key: '', value: '', configured: false }] })}>+ env</button>
    </>}
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || (f.kind === 'custom' && !f.command) || (f.kind === 'managed' && selectedProfile?.requiresModel && !f.managedModel) || (f.kind === 'managed' && selectedProfile?.credentialEnv && !f.envKey) || (f.kind === 'managed' && f.provider === 'custom' && (!f.displayName || !f.baseUrl || !f.envKey || !f.providerId))} onClick={onSave}>{t('save')}</button></div>
  </div>;
}

function CellEditor({ token, route, targets = [], location, setLocation, state, setState, engines, busy, onSave }) {
  const [picker, setPicker] = useState(null);
  const [pickErr, setPickErr] = useState('');
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const selectedEngine = engines.find((engine) => engine.id === f.engine);
  const chooseEngine = (id) => {
    const engine = engines.find((e) => e.id === id);
    set({ engine: id, model: f.models?.[id] || engine?.managed?.model || engine?.model?.value || '' });
  };
  const browse = async (p) => {
    try { const x = await listDirs(token, p, route); setPicker(x); set({ cwd: x.path }); setPickErr(''); }
    catch (e) { setPickErr(String(e.message || e)); }
  };
  return <div className="nc-set-form nc-fleet-form">
    <b>{state.mode === 'new' ? t('fleet-new-cell') : `${t('edit')} ${f.id}`}</b>
    {/* Posizione di creazione come campo obbligatorio DENTRO il form (task Hydra):
        non dipende dal selettore fuori schermo. Cambiandola, l'editor si ri-arma
        sulla nuova route (engine disponibili si aggiornano). */}
    {state.mode === 'new' && (
      <label className="nc-field">{t('location')}<span className="nc-req"> *</span>
        <select value={location} onChange={(e) => { setLocation(e.target.value); set({ engine: '' }); }}>
          <option value="">{t('local')}</option>
          {targets.map((x) => <option key={x.route.join('/')} value={x.route.join('/')} disabled={x.status && x.status !== 'up'}>{x.label}{x.status && x.status !== 'up' ? ` · ${t('node-offline')}` : ''}</option>)}
        </select>
      </label>
    )}
    <input value={f.id} disabled={state.mode !== 'new'} placeholder="id" onChange={(e) => set({ id: e.target.value })} />
    <div className="nc-fleet-pair"><input value={f.cwd} placeholder={t('cwd')} onChange={(e) => set({ cwd: e.target.value })} /><button className="nc-btn ghost" onClick={() => picker ? setPicker(null) : browse(f.cwd)}>{t('browse')}</button></div>
    {picker && <div className="nc-fs"><div className="nc-fs-path">{picker.path}</div><div className="nc-fs-list">
      {picker.parent && <button className="nc-fs-item nc-fs-nav" onClick={() => browse(picker.parent)}>↑ {t('fs-parent')}</button>}
      {(picker.dirs || []).map((d) => <button className="nc-fs-item" key={d} onClick={() => browse(`${picker.path.replace(/\/$/, '')}/${d}`)}>📁 {d}</button>)}
    </div></div>}
    {pickErr && <div className="nc-err">{pickErr}</div>}
    <select value={f.engine} onChange={(e) => chooseEngine(e.target.value)}>{engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
    <label className="nc-check"><input type="checkbox" checked={!!f.boot} onChange={(e) => set({ boot: e.target.checked })} /> boot</label>
    <input value={f.model || ''} list="nc-cell-models" placeholder={t('fleet-model-override')} onChange={(e) => set({ model: e.target.value })} />
    <datalist id="nc-cell-models">{(selectedEngine?.availableModels || []).map((model) => <option key={model} value={model} />)}</datalist>
    <textarea value={f.prompt || ''} placeholder="prompt" onChange={(e) => set({ prompt: e.target.value })} />
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || !f.cwd || !f.engine} onClick={onSave}>{t('save')}</button></div>
  </div>;
}

// Import esplicito di una sessione tmux unmanaged (cella Fleet legacy orfana, es
// "jarvis") in una cella GESTITA. Prefilla id/tmuxSession; l'engine è OBBLIGATORIO
// e deve essere già dichiarato (nessuna invenzione). La cwd di default è la home.
function ImportEditor({ token, route = [], state, setState, busy, onSave }) {
  const [picker, setPicker] = useState(null);
  const [engines, setEngines] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const routeKey = Array.isArray(route) ? route.join('/') : '';
  useEffect(() => {
    let alive = true;
    fleetDefinitions(token, routeKey ? routeKey.split('/') : [])
      .then((d) => { if (alive) { setEngines(d.engines || []); setLoadErr(''); } })
      .catch((e) => { if (alive) { setEngines([]); setLoadErr(String(e.message || e)); } });
    return () => { alive = false; };
  }, [token, routeKey]);
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const browse = async (p) => {
    try { const x = await listDirs(token, p, route); setPicker(x); set({ cwd: x.path }); }
    catch (_) { /* best-effort */ }
  };
  const idSuggestion = !f.id && f.tmuxSession ? f.tmuxSession.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) : f.id;
  return <div className="nc-set-form nc-fleet-form">
    <b>{t('import-as-cell')} · {f.tmuxSession}</b>
    <small>{t('import-help')}</small>
    <input value={f.tmuxSession} disabled placeholder="tmux session" readOnly />
    <input value={f.id} placeholder={t('name')} onChange={(e) => set({ id: e.target.value })} />
    <div className="nc-fleet-pair"><input value={f.cwd} placeholder={t('cwd')} onChange={(e) => set({ cwd: e.target.value })} /><button className="nc-btn ghost" type="button" onClick={() => picker ? setPicker(null) : browse(f.cwd)}>{t('browse')}</button></div>
    {picker && <div className="nc-fs"><div className="nc-fs-path">{picker.path}</div><div className="nc-fs-list">
      {picker.parent && <button className="nc-fs-item nc-fs-nav" onClick={() => browse(picker.parent)}>↑ {t('fs-parent')}</button>}
      {(picker.dirs || []).map((d) => <button className="nc-fs-item" key={d} onClick={() => browse(`${picker.path.replace(/\/$/, '')}/${d}`)}>📁 {d}</button>)}
    </div></div>}
    <select value={f.engine} onChange={(e) => set({ engine: e.target.value })}>
      <option value="">{t('import-engine-required')}</option>
      {engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
    </select>
    <label className="nc-check"><input type="checkbox" checked={!!f.boot} onChange={(e) => set({ boot: e.target.checked })} /> boot</label>
    {(state.err || loadErr) && <div className="nc-err">{state.err || loadErr}</div>}
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.tmuxSession || !f.engine || !engines.length} onClick={onSave}>{idSuggestion ? t('import-as-cell') : t('save')}</button></div>
  </div>;
}
