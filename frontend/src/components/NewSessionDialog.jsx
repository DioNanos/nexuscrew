import { useState } from 'react';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { listDirs, getRouteConfig } from '../lib/api.js';
import './NewSessionDialog.css';

// Validazione nome specchiata da lib/tmux/lifecycle.js validSessionName.
const NAME_RE = /^[\w.-]{1,64}$/;

// Dialog nuova sessione. presets arriva da /api/config (B3 Step 1).
//   onCreate({name, cwd, preset}): il genitore chiama createSession().
// Nota: cwd default '~' → inviamo '' così il server usa la home reale
// (resolveCwd non espande '~'; un path reale passa invariato).
// Il folder-picker (token) sfoglia le dir del server via /api/fs/dirs; senza
// token il campo resta un input testuale semplice (retro-compatibile).
export default function NewSessionDialog({ presets = ['shell'], targets = [], token, onCreate, onClose }) {
  useLang();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('~');
  const [preset, setPreset] = useState(presets[0] || 'shell');
  const [availablePresets, setAvailablePresets] = useState(presets);
  const [routeKey, setRouteKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [picker, setPicker] = useState(null);        // null=chiuso | {path,parent,home,dirs}
  const [pickErr, setPickErr] = useState(null);

  const nameOk = NAME_RE.test(name) && !name.startsWith('-');

  async function openPicker(path) {
    setPickErr(null);
    try {
      const route = routeKey ? routeKey.split('/') : [];
      const j = await listDirs(token, path, route);
      setPicker(j);
      setCwd(j.path);                                 // il path corrente diventa il cwd scelto
    } catch (e) { setPickErr(String((e && e.message) || e)); }
  }

  async function submit(e) {
    e.preventDefault();
    if (!nameOk) return;
    setBusy(true); setErr(null);
    try {
      await onCreate({ name, cwd: cwd === '~' ? '' : cwd, preset }, routeKey ? routeKey.split('/') : []);
      onClose();
    } catch (er) { setErr(String((er && er.message) || er)); setBusy(false); }
  }

  return (
    <div className="nc-sheet-overlay" onClick={onClose}>
      <form className="nc-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="nc-sheet-head"><b>{t('new-session')}</b></div>

        <label className="nc-field">{t('location')}
          <select value={routeKey} onChange={async (e) => {
            const key = e.target.value; setRouteKey(key); setPicker(null);
            try {
              const c = await getRouteConfig(token, key ? key.split('/') : []);
              const ps = Array.isArray(c.presets) && c.presets.length ? c.presets : ['shell'];
              setAvailablePresets(ps); setPreset(ps[0]);
            } catch (_) { setAvailablePresets(['shell']); setPreset('shell'); }
          }}>
            <option value="">{t('local')}</option>
            {targets.map((x) => <option key={x.route.join('/')} value={x.route.join('/')}>{x.label}</option>)}
          </select>
        </label>

        <label className="nc-field">{t('name')}
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            autoFocus placeholder="worker-1"
          />
        </label>
        {name && !nameOk && (
          <div className="nc-err">{t('name-invalid')}</div>
        )}

        <label className="nc-field">{t('cwd')}
          <div className="nc-cwd-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
            {token && (
              <button
                type="button" className="nc-btn ghost nc-cwd-browse"
                onClick={() => (picker ? setPicker(null) : openPicker(cwd === '~' ? '' : cwd))}
              >
                {t('browse')}
              </button>
            )}
          </div>
        </label>

        {picker && (
          <div className="nc-fs" onMouseDown={(e) => e.stopPropagation()}>
            <div className="nc-fs-path" title={picker.path}>{picker.path}</div>
            <div className="nc-fs-list">
              <button type="button" className="nc-fs-item nc-fs-nav" onClick={() => openPicker(picker.home)}>⌂ {t('fs-home')}</button>
              {picker.parent && (
                <button type="button" className="nc-fs-item nc-fs-nav" onClick={() => openPicker(picker.parent)}>↑ {t('fs-parent')}</button>
              )}
              {picker.dirs.map((d) => (
                <button
                  type="button" key={d} className="nc-fs-item"
                  onClick={() => openPicker(`${picker.path.replace(/\/$/, '')}/${d}`)}
                >📁 {d}</button>
              ))}
              {picker.dirs.length === 0 && <div className="nc-fs-empty">—</div>}
            </div>
            {pickErr && <div className="nc-err">{pickErr}</div>}
          </div>
        )}

        <label className="nc-field">{t('preset')}
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {availablePresets.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>

        {err && <div className="nc-err">{err}</div>}

        <div className="nc-sheet-actions">
          <button type="button" className="nc-btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="nc-btn primary" disabled={busy || !nameOk}>{t('create')}</button>
        </div>
      </form>
    </div>
  );
}
