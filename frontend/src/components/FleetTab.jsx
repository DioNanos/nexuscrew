import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import {
  fleetStatus, fleetDefinitions, fleetDefineEngine, fleetEditEngine, fleetRemoveEngine,
  fleetDefineCell, fleetEditCell, fleetRemoveCell, fleetRestart, fleetUp, fleetDown,
  fleetImportCell,
  fleetRestoreCells, fleetRestoreEngines,
  fleetCredentialStatus, fleetSetCredential, fleetRemoveCredential,
  getRouteConfig,
} from '../lib/api.js';
import PowerSheet from './PowerSheet.jsx';
import {
  portableEngineDefinition, restoreCellDefinition,
} from '../lib/fleet-backup.js';
import { blankEngine, blankCell, engineForm, buildEngine, catalogEntry } from '../lib/fleet-forms.js';
import FleetModal from './fleet/FleetModal.jsx';
import FleetInventory from './fleet/FleetInventory.jsx';
import FleetBackupDialog from './fleet/FleetBackupDialog.jsx';
import EngineEditor from './fleet/EngineEditor.jsx';
import CellEditor from './fleet/CellEditor.jsx';
import ImportEditor from './fleet/ImportEditor.jsx';
import CwdRepairDialog from './fleet/CwdRepairDialog.jsx';

export default function FleetTab({ token, readonly, targets = [], startNewCell = false, initialLocation = '' }) {
  const [defs, setDefs] = useState({ engines: [], cells: [], managedCatalog: [] });
  const [status, setStatus] = useState({ available: false, capabilities: [] });
  const [loaded, setLoaded] = useState(false);
  const [engineEdit, setEngineEdit] = useState(null);
  const [cellEdit, setCellEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [location, setLocation] = useState(initialLocation);
  const [remoteReadonly, setRemoteReadonly] = useState(false);
  const [powerCell, setPowerCell] = useState(null);
  const [importEdit, setImportEdit] = useState(null);
  const [repairCell, setRepairCell] = useState(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [credentials, setCredentials] = useState([]);
  const [credentialEdit, setCredentialEdit] = useState(null);
  const [fleetView, setFleetView] = useState('manage');
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
        if ((st.capabilities || []).includes('credentials')) {
          try { setCredentials((await fleetCredentialStatus(token, route)).credentials || []); }
          catch (_) { setCredentials([]); }
        } else setCredentials([]);
      }
      setErr('');
    } catch (e) { setErr(String(e.message || e)); }
    finally { setLoaded(true); }
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
    const form = engineEdit.form;
    const catalog = defs.managedCatalog || [];
    const profile = form.kind === 'managed' ? catalogEntry(catalog, form) : null;
    const credentialEnv = typeof profile?.credentialEnv === 'string' ? profile.credentialEnv : '';
    const credentialValue = credentialEnv ? (form.credentialValue || '') : '';
    const def = buildEngine(form, creating, catalog);
    if (!creating && engineEdit.form.kind === 'custom' && !engineEdit.form.modelFlag) def.model = null;
    if (!creating && engineEdit.form.kind === 'custom' && engineEdit.form.promptMode !== 'flag') def.promptFlag = null;
    let definitionResult;
    if (creating) definitionResult = await fleetDefineEngine(token, def, route);
    else {
      const original = engineEdit.original;
      const currentKeys = new Set(engineEdit.form.envRows.filter((r) => !r.remove).map((r) => r.key));
      const remove = (original.envKeys || []).filter((k) => !currentKeys.has(k));
      const set = Object.fromEntries(engineEdit.form.envRows.filter((r) => !r.remove && r.key && (!r.configured || r.value !== '')).map((r) => [r.key, r.value]));
      definitionResult = await fleetEditEngine(token, original.id, def, engineEdit.form.kind === 'custom' ? { set, remove } : undefined, route);
    }
    let credentialResult = null;
    if (credentialEnv && credentialValue) {
      try {
        credentialResult = await fleetSetCredential(token, credentialEnv, credentialValue, route);
        setCredentials(credentialResult.credentials || []);
      } catch (_) {
        await refresh();
        if (creating) {
          setEngineEdit({
            mode: 'edit', original: { ...def, id: form.id },
            form: { ...form, credentialReveal: false },
          });
        }
        throw new Error(t(creating ? 'fleet-key-partial-create' : 'fleet-key-partial-edit'));
      }
    }
    await refresh();
    setEngineEdit(null); setNote(t('fleet-saved'));
    const credentialAffected = (credentialResult?.credentials || [])
      .find((entry) => entry.envKey === credentialEnv)?.activeCells || [];
    const affected = [...new Set([...(definitionResult?.activeCells || []), ...credentialAffected])];
    if (affected.length && window.confirm(t('fleet-restart-confirm').replace('{cells}', affected.join(', ')))) {
      for (const id of affected) await fleetRestart(token, id, route);
    }
  });

  const saveCell = () => run(async () => {
    const creating = cellEdit.mode === 'new';
    const f = cellEdit.form;
    const def = { ...(creating ? { id: f.id } : {}), cwd: f.cwd, engine: f.engine, boot: !!f.boot };
    const commands = { ...(f.commands || {}) };
    const selectedEngine = defs.engines.find((engine) => engine.id === f.engine);
    if (selectedEngine?.managed?.client === 'shell' && typeof f.command === 'string' && f.command.length) commands[f.engine] = f.command;
    else if (selectedEngine?.managed?.client === 'shell') delete commands[f.engine];
    if (Object.keys(commands).length || !creating) def.commands = commands;
    if (creating) {
      if (selectedEngine?.managed?.client !== 'shell' && f.model) def.model = f.model;
      if (selectedEngine?.managed?.client !== 'shell' && f.prompt) def.prompt = f.prompt;
    } else {
      def.model = selectedEngine?.managed?.client === 'shell' ? null : (f.model || null);
      // Shell ignora il prompt al lancio, ma non cancella un prompt ricordato
      // se l'operatore cambia temporaneamente engine.
      if (selectedEngine?.managed?.client !== 'shell') def.prompt = f.prompt || null;
    }
    const result = creating ? await fleetDefineCell(token, def, route) : await fleetEditCell(token, cellEdit.original.id, def, route);
    const id = creating ? f.id : cellEdit.original.id;
    setCellEdit(null); setNote(t('fleet-saved'));
    if (!creating && result?.active && window.confirm(t('fleet-restart-confirm').replace('{cells}', id))) await fleetRestart(token, id, route);
  });

  const locked = readonly || remoteReadonly;
  const credentialFor = (engine) => credentials.find((entry) => entry.engines?.includes(engine.id)) || null;
  const saveCredential = () => run(async () => {
    const result = await fleetSetCredential(token, credentialEdit.envKey, credentialEdit.value, route);
    setCredentials(result.credentials || []); setCredentialEdit(null); setNote(t('fleet-credential-saved'));
    const affected = (result.credentials || []).find((entry) => entry.envKey === credentialEdit.envKey)?.activeCells || [];
    if (affected.length && window.confirm(t('fleet-restart-confirm').replace('{cells}', affected.join(', ')))) {
      for (const id of affected) await fleetRestart(token, id, route);
    }
  });
  const forgetCredential = (entry) => run(async () => {
    if (!window.confirm(t('fleet-credential-remove-confirm').replace('{key}', entry.envKey))) return;
    const result = await fleetRemoveCredential(token, entry.envKey, route);
    setCredentials(result.credentials || []); setNote(t('fleet-credential-removed'));
  });

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
  const restoreBackup = ({ engineRows = [], cellRows = [] }) => run(async () => {
    const selectedEngines = engineRows.filter((row) => row.selected);
    const engineDefs = selectedEngines.map((row) => portableEngineDefinition(row.engine));
    if (engineDefs.some((engine) => !engine)) throw new Error(t('fleet-backup-invalid-engine'));
    const engineOverwrites = selectedEngines.filter((row) => row.exists).map((row) => row.engine.id);
    if (engineOverwrites.length && !window.confirm(t('fleet-backup-confirm-engine-overwrite').replace('{engines}', engineOverwrites.join(', ')))) return;
    const engineIds = [...new Set([...defs.engines.map((engine) => engine.id), ...engineDefs.map((engine) => engine.id)])];
    const restored = [];
    for (const row of cellRows.filter((item) => item.selected)) {
      const def = restoreCellDefinition(row.cell, row.engine, engineIds);
      if (!def) throw new Error(`${row.cell.id}: ${t('fleet-backup-engine-missing')}`);
      restored.push(def);
    }
    const overwrites = cellRows.filter((row) => row.selected && row.exists).map((row) => row.cell.id);
    if (overwrites.length && !window.confirm(t('fleet-backup-confirm-overwrite').replace('{cells}', overwrites.join(', ')))) return;
    // Finish every confirmation before the first mutation. Engine definitions
    // must exist before cells can reference them, so the two authenticated
    // restores remain ordered but a cancelled dialog leaves no partial change.
    const engineResult = engineDefs.length
      ? await fleetRestoreEngines(token, engineDefs, engineOverwrites.length > 0, route)
      : { needsRestart: [] };
    const cellResult = restored.length ? await fleetRestoreCells(token, restored, route) : { needsRestart: [] };
    const restart = [...new Set([...(engineResult.needsRestart || []), ...(cellResult.needsRestart || [])])];
    setBackupOpen(false); setNote(`${t('fleet-backup-restored').replace('{n}', String(restored.length))}${engineDefs.length ? ` · ${engineDefs.length} ${t('fleet-engines').toLowerCase()}` : ''}${restart.length ? ` · ${t('fleet-backup-needs-restart').replace('{cells}', restart.join(', '))}` : ''}`);
  });
  const locationPicker = <label className="nc-field">{t('location')}<select value={location} onChange={(e) => {
    setLocation(e.target.value); setEngineEdit(null); setCellEdit(null); setErr(''); setNote(''); setRemoteReadonly(false);
    setLoaded(false); setStatus({ available: false, capabilities: [] }); setDefs({ engines: [], cells: [], managedCatalog: [] }); setCredentials([]); setCredentialEdit(null);
  }}>
    <option value="">{t('local')}</option>{targets.map((x) => <option key={x.route.join('/')} value={x.route.join('/')} disabled={x.status && x.status !== 'up'}>{x.label}{x.status && x.status !== 'up' ? ` · ${t('node-offline')}` : ''}</option>)}
  </select></label>;
  const viewPicker = <div className="nc-fleet-view-tabs" role="tablist" aria-label={t('tab-fleet')}>
    <button type="button" role="tab" aria-selected={fleetView === 'manage'} className={`nc-set-tabbtn${fleetView === 'manage' ? ' on' : ''}`}
      onClick={() => setFleetView('manage')}>{t('fleet-manage-location')}</button>
    <button type="button" role="tab" aria-selected={fleetView === 'overview'} className={`nc-set-tabbtn${fleetView === 'overview' ? ' on' : ''}`}
      onClick={() => setFleetView('overview')}>{t('fleet-network-overview')}</button>
  </div>;
  if (!loaded) return (
    <div className="nc-set-tab">
      {viewPicker}
      {fleetView === 'overview'
        ? <><div className="nc-set-info">{t('fleet-overview-help')}</div><FleetInventory token={token} targets={targets} readonly={readonly} onPower={onPower} onImport={openImport} /></>
        : <>{locationPicker}<div className="nc-set-info">{t('fleet-editor-loading')}</div></>}
    </div>
  );
  if (!editable) return (
    <div className="nc-set-tab">
      {viewPicker}
      {fleetView === 'overview'
        ? <><div className="nc-set-info">{t('fleet-overview-help')}</div><FleetInventory token={token} targets={targets} readonly={readonly} onPower={onPower} onImport={openImport} /></>
        : <>{locationPicker}<div className="nc-set-info">{err ? t('fleet-editor-load-error') : t('fleet-editor-unavailable')}{!err && status.reason ? ` ${status.reason}` : ''}</div></>}
      {err && <div className="nc-err">{err}</div>}
      {importEdit && <FleetModal onClose={() => setImportEdit(null)} label={t('import-as-cell')} error={err}><ImportEditor token={token} route={importEdit.route || route} state={importEdit} setState={setImportEdit} busy={busy} onSave={doImport} /></FleetModal>}
      {powerCell && <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : route} onConfirm={async (p) => { try { await onFleetConfirm(p); } finally { await refresh(); } }} onClose={() => setPowerCell(null)} />}
    </div>
  );
  return (
    <div className="nc-set-tab nc-fleet-editor">
      {viewPicker}
      {fleetView === 'overview' ? <>
        <div className="nc-set-info">{t('fleet-overview-help')}</div>
        <FleetInventory token={token} targets={targets} readonly={readonly} onPower={onPower} onImport={openImport} />
      </> : <>
        <div className="nc-set-info">{t('fleet-manage-help')}</div>
        {locationPicker}
        <div className="nc-set-row nc-fleet-backup-actions">
          <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setBackupOpen(true); }}>{t('fleet-backup')}</button>
          <small>{t('fleet-backup-help')}</small>
        </div>
        <div className="nc-fleet-section-head"><b>{t('fleet-cells')}</b><span className="nc-fleet-head-actions">
          <button className="nc-btn primary" disabled={locked || busy || !defs.engines.length} onClick={() => { setErr(''); setCellEdit({ mode: 'new', form: blankCell(defs.engines[0]?.id) }); }}>+ {t('add')}</button>
        </span></div>
        {defs.cells.map((c) => {
        const isOn = active.has(c.id);
        const caps = status.capabilities || [];
        // needsRepair: cwd non portabile. La UI NON mostra la cwd assoluta del
        // device sorgente (c.cwd e' foreign): espone un badge e il solo flusso
        // repair (che invia cwdRel-only). Una cella needsRepair non e' editabile
        // finche' la cwd non viene riparata (Edit sostituito da Repair).
        const needsRepair = c.needsRepair === true;
        return (
        <div className="nc-fleet-item" key={c.id}><span><b>{c.id}</b><small>{c.engine} · {needsRepair ? <span className="nc-fleet-tag nc-fleet-tag-warn">{t('fleet-cwd-needs-repair')}</span> : c.cwd}{isOn ? ` · ${t('service-active')}` : ` · ${t('cell-off')}`}</small></span><span>
          {isOn && caps.includes('down') && <button className="nc-btn ghost" disabled={locked || busy}
            onClick={() => run(() => fleetDown(token, { cell: c.id }, route))}>{t('stop')}</button>}
          {!isOn && caps.includes('up') && <button className="nc-btn primary" disabled={locked || busy}
            onClick={() => onPower({ cell: c.id, id: c.id, engine: c.engine, model: c.model, models: c.models, permissionPolicies: c.permissionPolicies, active: false, boot: c.boot })}>{t('start')}</button>}
          {isOn && caps.includes('restart') && <button className="nc-btn ghost" disabled={locked || busy}
            onClick={() => run(() => fleetRestart(token, c.id, route))}>{t('restart')}</button>}
          {needsRepair
            ? <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setRepairCell(c); }}>{t('fleet-cwd-repair')}</button>
            : <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setCellEdit({ mode: 'edit', original: c, form: { ...c, commands: { ...(c.commands || {}) }, command: c.commands?.[c.engine] || '' } }); }}>{t('edit')}</button>}
          <button className="nc-btn danger" disabled={locked || busy} onClick={() => run(async () => { if (window.confirm(t('fleet-remove-cell').replace('{id}', c.id))) await fleetRemoveCell(token, c.id, true, route); })}>×</button>
        </span></div>
        );})}
        <div className="nc-fleet-section-head"><b>{t('fleet-engines')}</b><button className="nc-btn primary" disabled={locked || busy} onClick={() => { setErr(''); setEngineEdit({ mode: 'new', form: blankEngine() }); }}>+ {t('add')}</button></div>
        {defs.engines.map((e) => {
          const cred = credentialFor(e);
          return (
          <div className="nc-fleet-item" key={e.id}><span><b>{e.label}</b><small>{e.managed
            ? `${e.id} · ${e.managed.client} / ${e.managed.provider} · ${e.managedInfo?.configured ? t('fleet-ready') : e.managedInfo?.reason || t('fleet-not-ready')}`
            : `${e.id} · ${e.command}`}</small>{cred && <small>{cred.envKey} · {t(`fleet-credential-source-${cred.source || 'missing'}`)}</small>}</span><span>
            {cred && <button className="nc-btn ghost" disabled={locked || busy}
              onClick={() => { setErr(''); setCredentialEdit({ envKey: cred.envKey, value: '' }); }}>{cred.configured ? t('fleet-credential-change') : t('fleet-credential-set')}</button>}
            {cred?.source === 'local' && <button className="nc-btn danger" disabled={locked || busy} onClick={() => forgetCredential(cred)}>{t('fleet-credential-forget')}</button>}
            <button className="nc-btn ghost" disabled={locked || busy} onClick={() => { setErr(''); setEngineEdit({ mode: 'edit', original: e, form: engineForm(e) }); }}>{t('edit')}</button>
            <button className="nc-btn danger" disabled={locked || busy} onClick={() => run(async () => { if (window.confirm(t('fleet-remove-engine').replace('{id}', e.id))) await fleetRemoveEngine(token, e.id, route); })}>×</button>
          </span></div>
        );})}
      </>}
      {engineEdit && <FleetModal onClose={() => setEngineEdit(null)} label={t('fleet-new-engine')} error={err}><EngineEditor state={engineEdit} setState={setEngineEdit} busy={busy} onSave={saveEngine} catalog={defs.managedCatalog || []} /></FleetModal>}
      {cellEdit && <FleetModal onClose={() => setCellEdit(null)} label={t('fleet-new-cell')} error={err}><CellEditor token={token} route={route} targets={targets} location={location} setLocation={setLocation} state={cellEdit} setState={setCellEdit} engines={defs.engines} busy={busy} onSave={saveCell} /></FleetModal>}
      {repairCell && <FleetModal onClose={() => setRepairCell(null)} label={t('fleet-cwd-repair-title').replace('{id}', repairCell.id)} error=""><CwdRepairDialog token={token} route={route} cell={repairCell} busy={busy} onSaved={async () => { setRepairCell(null); setNote(t('fleet-cwd-repaired')); await refresh(); }} onClose={() => setRepairCell(null)} /></FleetModal>}
      {note && <div className="nc-set-note">{note}</div>}{err && <div className="nc-err">{err}</div>}
      {backupOpen && <FleetModal onClose={() => setBackupOpen(false)} label={t('fleet-backup')} error={err}><FleetBackupDialog cells={defs.cells} engines={defs.engines} busy={busy} canRestore={canRestoreBackup} onRestore={restoreBackup} onClose={() => setBackupOpen(false)} /></FleetModal>}
      {credentialEdit && <FleetModal onClose={() => setCredentialEdit(null)} label={t('fleet-credential-title')} error={err}>
        <div className="nc-fleet-form nc-credential-form">
          <b>{t('fleet-credential-title')}</b>
          <small>{t('fleet-credential-help')}</small>
          <label className="nc-field">{credentialEdit.envKey}<input type="password" autoComplete="off" spellCheck="false" autoCapitalize="none"
            value={credentialEdit.value} onChange={(event) => setCredentialEdit({ ...credentialEdit, value: event.target.value })} /></label>
          <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setCredentialEdit(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !credentialEdit.value} onClick={saveCredential}>{t('save')}</button></div>
        </div>
      </FleetModal>}
      {importEdit && <FleetModal onClose={() => setImportEdit(null)} label={t('import-as-cell')} error={err}><ImportEditor token={token} route={importEdit.route || route} state={importEdit} setState={setImportEdit} busy={busy} onSave={doImport} /></FleetModal>}
      {powerCell && <PowerSheet cell={powerCell} token={token} route={Array.isArray(powerCell.route) ? powerCell.route : route} onConfirm={async (p) => { try { await onFleetConfirm(p); } finally { await refresh(); } }} onClose={() => setPowerCell(null)} />}
    </div>
  );
}
