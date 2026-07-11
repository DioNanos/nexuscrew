import { useCallback, useEffect, useState } from 'react';
import { t } from '../lib/i18n.js';
import {
  fleetStatus, fleetDefinitions, fleetDefineEngine, fleetEditEngine, fleetRemoveEngine,
  fleetDefineCell, fleetEditCell, fleetRemoveCell, fleetRestart,
  listDirs,
} from '../lib/api.js';

const blankEngine = () => ({ kind: 'managed', id: 'claude.ollama-cloud', label: '', client: 'claude', provider: 'ollama-cloud', managedModel: 'glm-5.2', command: '', argsText: '', rc: false, promptMode: 'send-keys', promptFlag: '', modelFlag: '', modelValue: '', envRows: [] });
const blankCell = (engine = '') => ({ id: '', cwd: '', engine, boot: false, model: '', prompt: '' });
const managedLabel = (client, provider) => `${client === 'claude' ? 'Claude' : 'Codex-VL'} · ${provider === 'native' ? 'Native' : provider === 'ollama-cloud' ? 'Ollama Cloud Direct' : provider === 'zai-a' ? 'Z.AI A' : 'Z.AI P'}`;

function engineForm(e) {
  return {
    kind: e.managed ? 'managed' : 'custom',
    id: e.id, label: e.label || '', command: e.command || '', argsText: (e.args || []).join('\n'), rc: !!e.rc,
    client: e.managed?.client || 'claude', provider: e.managed?.provider || 'native', managedModel: e.managed?.model || '',
    promptMode: e.promptMode || 'send-keys', promptFlag: e.promptFlag || '',
    modelFlag: e.model?.flag || '', modelValue: e.model?.value || '',
    envRows: (e.envKeys || []).map((key) => ({ key, value: '', configured: true, remove: false })),
  };
}

function buildEngine(form, creating) {
  if (form.kind === 'managed') {
    return {
      ...(creating ? { id: form.id } : {}), label: form.label || managedLabel(form.client, form.provider), rc: !!form.rc,
      managed: { client: form.client, provider: form.provider, model: form.managedModel || '' },
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
  const [defs, setDefs] = useState({ engines: [], cells: [] });
  const [status, setStatus] = useState({ available: false, capabilities: [] });
  const [engineEdit, setEngineEdit] = useState(null);
  const [cellEdit, setCellEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    try {
      const st = await fleetStatus(token); setStatus(st);
      if (st.provider === 'builtin' && (st.capabilities || []).includes('definitions')) setDefs(await fleetDefinitions(token));
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
    const def = buildEngine(engineEdit.form, creating);
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
      {engineEdit && <EngineEditor state={engineEdit} setState={setEngineEdit} busy={busy} onSave={saveEngine} />}

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

function EngineEditor({ state, setState, busy, onSave }) {
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const rows = f.envRows || [];
  const providers = f.client === 'claude' ? ['native', 'ollama-cloud', 'zai-a', 'zai-p'] : ['native', 'ollama-cloud'];
  const setManagedPair = (client, provider) => {
    const allowed = client === 'claude' ? ['native', 'ollama-cloud', 'zai-a', 'zai-p'] : ['native', 'ollama-cloud'];
    const nextProvider = allowed.includes(provider) ? provider : 'native';
    const model = nextProvider === 'ollama-cloud' ? 'glm-5.2' : nextProvider.startsWith('zai-') ? 'glm-5.2[1m]' : '';
    set({ client, provider: nextProvider, managedModel: model, rc: client === 'claude' && nextProvider === 'native', ...(state.mode === 'new' ? { id: `${client}.${nextProvider}`, label: '' } : {}) });
  };
  return <div className="nc-set-form nc-fleet-form">
    <b>{state.mode === 'new' ? t('fleet-new-engine') : `${t('edit')} ${f.id}`}</b>
    <input value={f.id} disabled={state.mode !== 'new'} placeholder="id" onChange={(e) => set({ id: e.target.value })} />
    <input value={f.label} placeholder={t('label')} onChange={(e) => set({ label: e.target.value })} />
    <select value={f.kind} disabled={state.mode !== 'new'} onChange={(e) => set({ kind: e.target.value })}><option value="managed">{t('fleet-managed')}</option><option value="custom">{t('fleet-custom')}</option></select>
    {f.kind === 'managed' ? <>
      <div className="nc-fleet-pair">
        <select value={f.client} disabled={state.mode !== 'new'} onChange={(e) => setManagedPair(e.target.value, f.provider)}><option value="claude">Claude</option><option value="codex-vl">Codex-VL</option></select>
        <select value={f.provider} disabled={state.mode !== 'new'} onChange={(e) => setManagedPair(f.client, e.target.value)}>{providers.map((p) => <option key={p} value={p}>{p}</option>)}</select>
      </div>
      <input value={f.managedModel} placeholder={t('fleet-model-default')} onChange={(e) => set({ managedModel: e.target.value })} />
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
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || (f.kind === 'custom' && !f.command)} onClick={onSave}>{t('save')}</button></div>
  </div>;
}

function CellEditor({ token, state, setState, engines, busy, onSave }) {
  const [picker, setPicker] = useState(null);
  const [pickErr, setPickErr] = useState('');
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
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
    <input value={f.model || ''} placeholder="model override" onChange={(e) => set({ model: e.target.value })} />
    <textarea value={f.prompt || ''} placeholder="prompt" onChange={(e) => set({ prompt: e.target.value })} />
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || !f.cwd || !f.engine} onClick={onSave}>{t('save')}</button></div>
  </div>;
}
