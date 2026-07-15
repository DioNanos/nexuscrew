import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { listDirs } from '../../lib/api.js';

// Editor di una cella. State-less rispetto alle API: la posizione di creazione
// è un campo obbligatorio DENTRO il form e riceve/solleva stato al parent.
// Estratto invariato da FleetTab.jsx.
export default function CellEditor({ token, route, targets = [], location, setLocation, state, setState, engines, busy, onSave }) {
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
