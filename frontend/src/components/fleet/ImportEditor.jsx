import { useEffect, useState } from 'react';
import { t } from '../../lib/i18n.js';
import { fleetDefinitions, listDirs } from '../../lib/api.js';

// Import esplicito di una sessione tmux unmanaged (cella Fleet legacy orfana, es
// "jarvis") in una cella GESTITA. Prefilla id/tmuxSession; l'engine è OBBLIGATORIO
// e deve essere già dichiarato (nessuna invenzione). La cwd di default è la home.
// Estratto invariato da FleetTab.jsx.
export default function ImportEditor({ token, route = [], state, setState, busy, onSave }) {
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
