import { t } from '../../lib/i18n.js';
import { catalogEntry } from '../../lib/fleet-forms.js';

// Editor di un engine (managed o custom). State-less rispetto alle API: riceve
// lo stato del form e lo risolleva al parent (FleetTab), che è l'unico a
// eseguire le mutazioni. Estratto invariato da FleetTab.jsx.
export default function EngineEditor({ state, setState, busy, onSave, catalog }) {
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
