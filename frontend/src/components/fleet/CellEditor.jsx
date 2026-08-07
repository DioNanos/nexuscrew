import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { listDirs } from '../../lib/api.js';

// Editor di una cella. State-less rispetto alle API: la posizione di creazione
// è un campo obbligatorio DENTRO il form e riceve/solleva stato al parent.
// Estratto invariato da FleetTab.jsx.
export default function CellEditor({ token, route, targets = [], location, setLocation, state, setState, engines, mcpServers = [], busy, onSave }) {
  const [picker, setPicker] = useState(null);
  const [pickErr, setPickErr] = useState('');
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const selectedEngine = engines.find((engine) => engine.id === f.engine);
  const isShell = selectedEngine?.managed?.client === 'shell';
  const chooseEngine = (id) => {
    const engine = engines.find((e) => e.id === id);
    const commands = { ...(f.commands || {}) };
    if (selectedEngine?.managed?.client === 'shell') {
      if (f.command) commands[f.engine] = f.command; else delete commands[f.engine];
    }
    set({ engine: id, model: f.models?.[id] || engine?.managed?.model || engine?.model?.value || '', commands, command: commands[id] || '' });
  };
  const setCommand = (value) => {
    const commands = { ...(f.commands || {}) };
    if (value) commands[f.engine] = value; else delete commands[f.engine];
    set({ command: value, commands });
  };
  const hasShellMetachar = isShell && /[|&;<>()`$*?{}\[\]~]/.test(f.command || '');
  // Tre stati, non due: ASSENTE non e' come VUOTO. Assente = la cella eredita
  // tutti gli strumenti, che e' il comportamento di sempre; `[]` = nessuno.
  // Confonderli significherebbe che aprire e salvare una cella senza toccare
  // nulla le cambia i poteri.
  const mcpNoti = [...new Set([...(mcpServers || []), ...(Array.isArray(f.mcp) ? f.mcp : [])])].sort();
  const mcpModo = Array.isArray(f.mcp) ? (f.mcp.length ? 'some' : 'none') : 'all';
  // Passando a «scelti» si parte da TUTTI selezionati: cosi' il primo click non
  // toglie niente per sbaglio, e togliere e' un gesto deliberato.
  const setMcpModo = (modo) => set({
    mcp: modo === 'all' ? undefined : (modo === 'none' ? [] : (f.mcp?.length ? f.mcp : [...mcpNoti])),
  });
  const toggleMcp = (nome) => {
    const cur = Array.isArray(f.mcp) ? f.mcp : [];
    set({ mcp: cur.includes(nome) ? cur.filter((x) => x !== nome) : [...cur, nome].sort() });
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
    {/* Nome leggibile, distinto dall'id: l'id resta immutabile e indirizza,
        questo e' cio' che si legge — anche dagli altri nodi. */}
    <input value={f.label || ''} maxLength={64} placeholder={t('fleet-cell-label')} onChange={(e) => set({ label: e.target.value })} />
    <div className="nc-fleet-pair"><input value={f.cwd} placeholder={t('cwd')} onChange={(e) => set({ cwd: e.target.value })} /><button className="nc-btn ghost" onClick={() => picker ? setPicker(null) : browse(f.cwd)}>{t('browse')}</button></div>
    {picker && <div className="nc-fs"><div className="nc-fs-path">{picker.path}</div><div className="nc-fs-list">
      {picker.parent && <button className="nc-fs-item nc-fs-nav" onClick={() => browse(picker.parent)}>↑ {t('fs-parent')}</button>}
      {(picker.dirs || []).map((d) => <button className="nc-fs-item" key={d} onClick={() => browse(`${picker.path.replace(/\/$/, '')}/${d}`)}>📁 {d}</button>)}
    </div></div>}
    {pickErr && <div className="nc-err">{pickErr}</div>}
    <select value={f.engine} onChange={(e) => chooseEngine(e.target.value)}>{engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
    <label className="nc-check"><input type="checkbox" checked={!!f.boot} onChange={(e) => set({ boot: e.target.checked })} /> {t('fleet-boot')}</label>
    {isShell ? <>
      <input value={f.command || ''} maxLength={4096} placeholder={t('fleet-shell-command-placeholder')} onChange={(e) => setCommand(e.target.value)} />
      <small>{f.command ? t('fleet-shell-command-help') : t('fleet-shell-interactive')}</small>
      {hasShellMetachar && <small className="nc-note">{t('fleet-shell-command-metachar')}</small>}
    </> : <>
      <input value={f.model || ''} list="nc-cell-models" placeholder={t('fleet-model-override')} onChange={(e) => set({ model: e.target.value })} />
      <datalist id="nc-cell-models">{(selectedEngine?.availableModels || []).map((model) => <option key={model} value={model} />)}</datalist>
      {/* Non passava da t(): in inglese e in spagnolo mostrava «prompt» cosi'
          com'era. E soprattutto non diceva QUANDO quel testo viene usato — chi
          lo conosce gia' non ne aveva bisogno, chi apre l'editor per la prima
          volta si'. */}
      <textarea value={f.prompt || ''} placeholder={t('cell-prompt')} onChange={(e) => set({ prompt: e.target.value })} />
      <small>{t('cell-prompt-help')}</small>
      <label className="nc-field">{t('cell-mcp')}
        <select value={mcpModo} onChange={(e) => setMcpModo(e.target.value)}>
          <option value="all">{t('cell-mcp-all')}</option>
          <option value="none">{t('cell-mcp-none')}</option>
          <option value="some">{t('cell-mcp-some')}</option>
        </select>
      </label>
      {mcpModo === 'some' && <div className="nc-fleet-mcp-list">
        {mcpNoti.map((nome) => <label className="nc-check" key={nome}>
          <input type="checkbox" checked={(f.mcp || []).includes(nome)} onChange={() => toggleMcp(nome)} /> {nome}
        </label>)}
      </div>}
      <small>{t('cell-mcp-help')}</small>
    </>}
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || !f.cwd || !f.engine} onClick={onSave}>{t('save')}</button></div>
  </div>;
}
