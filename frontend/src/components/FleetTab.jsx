import { useCallback, useEffect, useState } from 'react';
import { t } from '../lib/i18n.js';
import {
  fleetStatus, fleetDefinitions, fleetDefineEngine, fleetEditEngine, fleetRemoveEngine,
  fleetDefineCell, fleetEditCell, fleetRemoveCell, fleetRestart,
  listDirs,
} from '../lib/api.js';

const blankEngine = () => ({ kind: 'managed', id: 'claude.native', label: '', client: 'claude', provider: 'native', credentialProfile: '', managedModel: '', permissionPolicy: 'standard', displayName: '', protocol: 'anthropic_messages', baseUrl: '', envKey: '', providerId: 'nexuscrew-custom', command: '', argsText: '', rc: true, promptMode: 'send-keys', promptFlag: '', modelFlag: '', modelValue: '', envRows: [] });
const blankCell = (engine = '') => ({ id: '', cwd: '', engine, boot: false, model: '', prompt: '' });
const catalogEntry = (catalog, form) => catalog.find((p) => p.client === form.client && p.provider === form.provider && (p.credentialProfile || '') === (form.credentialProfile || ''));
const managedLabel = (catalog, form) => catalogEntry(catalog, form)?.label || `${form.client} · ${form.provider}`;

function engineForm(e) {
  return {
    kind: e.managed ? 'managed' : 'custom',
    id: e.id, label: e.label || '', command: e.command || '', argsText: (e.args || []).join('\n'), rc: !!e.rc,
    client: e.managed?.client || 'claude', provider: e.managed?.provider || 'native', credentialProfile: e.managed?.credentialProfile || '', managedModel: e.managed?.model || '',
    permissionPolicy: e.managed?.permissionPolicy || 'standard', displayName: e.managed?.displayName || '', protocol: e.managed?.protocol || '', baseUrl: e.managed?.baseUrl || '', envKey: e.managed?.envKey || '', providerId: e.managed?.providerId || 'nexuscrew-custom', modelOptions: e.availableModels || e.managedInfo?.models || [],
    promptMode: e.promptMode || 'send-keys', promptFlag: e.promptFlag || '',
    modelFlag: e.model?.flag || '', modelValue: e.model?.value || '',
    envRows: (e.envKeys || []).map((key) => ({ key, value: '', configured: true, remove: false })),
  };
}

function buildEngine(form, creating, catalog = []) {
  if (form.kind === 'managed') {
    const managed = { client: form.client, provider: form.provider, model: form.managedModel || '', permissionPolicy: form.permissionPolicy || 'standard' };
    if (form.credentialProfile) managed.credentialProfile = form.credentialProfile;
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

export default function FleetTab({ token, readonly }) {
  const [defs, setDefs] = useState({ engines: [], cells: [], managedCatalog: [] });
  const [status, setStatus] = useState({ available: false, capabilities: [] });
  const [engineEdit, setEngineEdit] = useState(null);
  const [cellEdit, setCellEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      const st = await fleetStatus(token); setStatus(st);
      if (st.provider === 'builtin' && (st.capabilities || []).includes('definitions')) {
        const next = await fleetDefinitions(token);
        const runtime = new Map((st.engines || []).map((engine) => [engine.id, engine]));
        next.engines = (next.engines || []).map((engine) => ({ ...engine, availableModels: runtime.get(engine.id)?.models || [] }));
        setDefs(next);
      }
    } catch (e) { setErr(String(e.message || e)); }
  }, [token]);
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id); }, [refresh]);

  const active = new Set((status.cells || []).filter((c) => c.active).map((c) => c.cell));
  const editable = status.provider === 'builtin' && (status.capabilities || []).includes('edit');
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
    if (creating) result = await fleetDefineEngine(token, def);
    else {
      const original = engineEdit.original;
      const currentKeys = new Set(engineEdit.form.envRows.filter((r) => !r.remove).map((r) => r.key));
      const remove = (original.envKeys || []).filter((k) => !currentKeys.has(k));
      const set = Object.fromEntries(engineEdit.form.envRows.filter((r) => !r.remove && r.key && (!r.configured || r.value !== '')).map((r) => [r.key, r.value]));
      result = await fleetEditEngine(token, original.id, def, engineEdit.form.kind === 'custom' ? { set, remove } : undefined);
    }
    setEngineEdit(null); setNote(t('fleet-saved'));
    const affected = result?.activeCells || [];
    if (affected.length && window.confirm(t('fleet-restart-confirm').replace('{cells}', affected.join(', ')))) {
      for (const id of affected) await fleetRestart(token, id);
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
    const result = creating ? await fleetDefineCell(token, def) : await fleetEditCell(token, cellEdit.original.id, def);
    const id = creating ? f.id : cellEdit.original.id;
    setCellEdit(null); setNote(t('fleet-saved'));
    if (!creating && result?.active && window.confirm(t('fleet-restart-confirm').replace('{cells}', id))) await fleetRestart(token, id);
  });

  if (!editable) return <div className="nc-set-info">{t('fleet-editor-unavailable')}</div>;
  return (
    <div className="nc-set-tab nc-fleet-editor">
      <div className="nc-fleet-section-head"><b>{t('fleet-engines')}</b><button className="nc-btn primary" disabled={readonly || busy} onClick={() => setEngineEdit({ mode: 'new', form: blankEngine() })}>+ {t('add')}</button></div>
      {defs.engines.map((e) => (
        <div className="nc-fleet-item" key={e.id}><span><b>{e.label}</b><small>{e.managed
          ? `${e.id} · ${e.managed.client} / ${e.managed.provider} · ${e.managedInfo?.configured ? t('fleet-ready') : e.managedInfo?.reason || t('fleet-not-ready')}`
          : `${e.id} · ${e.command}`}</small></span><span>
          <button className="nc-btn ghost" disabled={readonly || busy} onClick={() => setEngineEdit({ mode: 'edit', original: e, form: engineForm(e) })}>{t('edit')}</button>
          <button className="nc-btn danger" disabled={readonly || busy} onClick={() => run(async () => { if (window.confirm(t('fleet-remove-engine').replace('{id}', e.id))) await fleetRemoveEngine(token, e.id); })}>×</button>
        </span></div>
      ))}
      {engineEdit && <EngineEditor state={engineEdit} setState={setEngineEdit} busy={busy} onSave={saveEngine} catalog={defs.managedCatalog || []} />}

      <div className="nc-fleet-section-head"><b>{t('fleet-cells')}</b><button className="nc-btn primary" disabled={readonly || busy || !defs.engines.length} onClick={() => setCellEdit({ mode: 'new', form: blankCell(defs.engines[0]?.id) })}>+ {t('add')}</button></div>
      {defs.cells.map((c) => (
        <div className="nc-fleet-item" key={c.id}><span><b>{c.id}</b><small>{c.engine} · {c.cwd}{active.has(c.id) ? ` · ${t('service-active')}` : ''}</small></span><span>
          <button className="nc-btn ghost" disabled={readonly || busy} onClick={() => setCellEdit({ mode: 'edit', original: c, form: { ...c } })}>{t('edit')}</button>
          <button className="nc-btn danger" disabled={readonly || busy} onClick={() => run(async () => { if (window.confirm(t('fleet-remove-cell').replace('{id}', c.id))) await fleetRemoveCell(token, c.id, true); })}>×</button>
        </span></div>
      ))}
      {cellEdit && <CellEditor token={token} state={cellEdit} setState={setCellEdit} engines={defs.engines} busy={busy} onSave={saveCell} />}
      {note && <div className="nc-set-note">{note}</div>}{err && <div className="nc-err">{err}</div>}
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
    set({ client: entry.client, provider: entry.provider, credentialProfile: entry.credentialProfile || '', managedModel: entry.model || '', protocol: entry.protocol || '', permissionPolicy: 'standard', rc: !!entry.rc, displayName: entry.custom ? t('fleet-custom-provider-default') : '', baseUrl: entry.custom ? '' : entry.endpoint || '', envKey: '', providerId: 'nexuscrew-custom', ...(state.mode === 'new' ? { id: entry.id, label: '' } : {}) });
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
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || (f.kind === 'custom' && !f.command) || (f.kind === 'managed' && selectedProfile?.requiresModel && !f.managedModel) || (f.kind === 'managed' && f.provider === 'custom' && (!f.displayName || !f.baseUrl || !f.envKey || !f.providerId))} onClick={onSave}>{t('save')}</button></div>
  </div>;
}

function CellEditor({ token, state, setState, engines, busy, onSave }) {
  const [picker, setPicker] = useState(null);
  const [pickErr, setPickErr] = useState('');
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const selectedEngine = engines.find((engine) => engine.id === f.engine);
  const chooseEngine = (id) => {
    const engine = engines.find((e) => e.id === id);
    set({ engine: id, model: f.models?.[id] || engine?.managed?.model || engine?.model?.value || '' });
  };
  const browse = async (p) => {
    try { const x = await listDirs(token, p); setPicker(x); set({ cwd: x.path }); setPickErr(''); }
    catch (e) { setPickErr(String(e.message || e)); }
  };
  return <div className="nc-set-form nc-fleet-form">
    <b>{state.mode === 'new' ? t('fleet-new-cell') : `${t('edit')} ${f.id}`}</b>
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
