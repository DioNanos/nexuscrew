import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { listDirs, fleetEditCell } from '../../lib/api.js';
import { normalizeCwdRel } from '../../lib/fleet-backup.js';

// CwdRepairDialog — flusso owner-authorized per rendere azionabile needsRepair
// (cwd non portabile) nelle Impostazioni Fleet.
//
// INVARIANTI (design T3, backend T1 auditato):
//   - Rappresenta la cwd SOLO come cwdRel home-relative (~) sul DEVICE TARGET.
//     Mai mostra la cwd assoluta del device sorgente (cell.cwd e' foreign/segreto
//     operativo dell'altro device): qui usiamo solo cell.id e l'eventuale
//     cwdSuggestion home-relative gia' validata dal target.
//   - Invia a edit-cell la SOLA cwdRel ({ cwdRel }); il backend ricalcola la cwd
//     assoluta sul target (resolveCellCwd). Nessun cwd nel payload.
//   - NESSUN auto-remap, NESSUN fallback a home/service cwd, NESSUNA migrazione
//     on-read. La mutation avviene solo in apply() dietro window.confirm esplicito.
//   - listDirs (browser) e' GET read-only; confinata alla home del target dal
//     backend; la UI rappresenta ogni livello come ~ e richiede conferma prima
//     della mutation (Apply). La selezione dal browser e' una preview locale.
//   - code 'unportable-cwd' e suggestion vengono surfaceate dall'errore backend,
//     MA la suggestion e' una SCELTA ESPLICITA (pulsante), mai applicata in auto.
//   - route locale/routed preservata: ogni chiamata usa il `route` passato.

// displayPath: rende una cwdRel come ~/... sul target ('' == home -> '~').
function displayPath(rel) {
  const norm = normalizeCwdRel(rel);
  if (norm === null) return `~/${rel}`;
  return norm ? `~/${norm}` : '~';
}

// relFromPicker: dai path assoluti del backend (confinali alla home) estrai il
// relativo home. Mai restituisce un path assoluto; se incontra qualcosa fuori
// home (non dovrebbe: il backend fa 403) torna alla radice home ('').
function relFromPicker(entry) {
  if (!entry || typeof entry.path !== 'string' || typeof entry.home !== 'string') return '';
  const { path, home } = entry;
  if (!home || path === home) return '';
  if (!path.startsWith(home + '/')) return '';
  return path.slice(home.length + 1).replace(/\/+$/, '');
}

export default function CwdRepairDialog({ token, route, cell, busy = false, onSaved, onClose }) {
  const [cwdRel, setCwdRel] = useState('');
  // picker: null | { rel, dirs, loading, err }
  const [picker, setPicker] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const initialSuggestion = typeof cell?.cwdSuggestion === 'string'
    && normalizeCwdRel(cell.cwdSuggestion) !== null ? normalizeCwdRel(cell.cwdSuggestion) : null;
  const [suggestion, setSuggestion] = useState(initialSuggestion); // string|null (cwdRel valida)

  const id = cell?.id;
  const disabled = busy || submitting;

  const browse = async (rel) => {
    const safeRel = normalizeCwdRel(rel);
    if (safeRel === null) { setPicker({ rel: '', dirs: [], loading: false, err: t('fleet-cwd-repair-invalid') }); return; }
    setPicker({ rel: safeRel, dirs: [], loading: true, err: '' });
    try {
      const entry = await listDirs(token, safeRel, route);
      const relCur = relFromPicker(entry);
      setPicker({ rel: relCur, dirs: Array.isArray(entry.dirs) ? entry.dirs : [], loading: false, err: '' });
    } catch (e) {
      setPicker({ rel: safeRel, dirs: [], loading: false, err: String((e && e.message) || e) });
    }
  };

  const enterDir = (name) => {
    if (!picker) return;
    const next = picker.rel ? `${picker.rel}/${name}` : name;
    browse(next);
  };
  const goParent = () => {
    if (!picker?.rel) return;
    browse(picker.rel.split('/').slice(0, -1).join('/'));
  };
  const useCurrent = () => {
    if (!picker) return;
    setCwdRel(picker.rel || '');
    setPicker(null);
    setError('');
    setSuggestion(null);
  };

  // suggestion: scelta esplicita. Riempie il campo, NON sottomette (nessuna
  // mutation automatica): l'utente deve comunque confermare con Apply.
  const useSuggestion = () => {
    if (suggestion === null) return;
    setCwdRel(suggestion);
    setSuggestion(null);
    setError('');
  };

  const apply = async () => {
    if (disabled) return;
    const next = normalizeCwdRel(cwdRel);
    if (next === null) { setError(t('fleet-cwd-repair-invalid')); return; }
    const path = displayPath(next);
    // Conferma esplicita prima della mutation (owner-authorized).
    let confirmed = true;
    try { confirmed = window.confirm(t('fleet-cwd-repair-confirm').replace('{id}', String(id || '')).replace('{path}', path)); }
    catch (_) { confirmed = false; }
    if (!confirmed) return;
    setSubmitting(true); setError(''); setSuggestion(null);
    try {
      // Payload cwdRel-ONLY: il backend ricalcola cwd (resolveCellCwd).
      const result = await fleetEditCell(token, id, { cwdRel: next }, route);
      onSaved?.(result);
    } catch (e) {
      const data = (e && e.data) || {};
      if (data.code === 'unportable-cwd') {
        setError(t('fleet-cwd-repair-unportable'));
        const entry = Array.isArray(data.cells) ? data.cells.find((c) => c && c.id === id) : null;
        const sug = entry && typeof entry.suggestion === 'string' ? entry.suggestion : null;
        if (sug !== null && normalizeCwdRel(sug) !== null) setSuggestion(sug);
      } else {
        setError(String((e && e.message) || e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="nc-set-form nc-fleet-form nc-cwd-repair">
      <b>{t('fleet-cwd-repair-title').replace('{id}', String(id || ''))}</b>
      <small className="nc-set-info">{t('fleet-cwd-repair-help')}</small>
      <small className="nc-cwd-no-source">{t('fleet-cwd-repair-no-source-path')}</small>

      <label className="nc-field">{t('cwd')}
        <div className="nc-cwd-rel-row">
          <span className="nc-cwd-rel-prefix">~/</span>
          <input
            value={cwdRel}
            placeholder={t('fleet-cwd-repair-placeholder')}
            autoComplete="off"
            spellCheck="false"
            autoCapitalize="none"
            onChange={(e) => setCwdRel(e.target.value)}
          />
          <button type="button" className="nc-btn ghost" disabled={disabled} onClick={() => (picker ? setPicker(null) : browse(''))}>
            {picker ? t('close') : t('fleet-cwd-repair-browse')}
          </button>
        </div>
      </label>

      <div className="nc-cwd-preview">{t('fleet-cwd-repair-preview').replace('{path}', displayPath(cwdRel))}</div>

      {picker && (
        <div className="nc-fs">
          <div className="nc-fs-path">{displayPath(picker.rel)}</div>
          <div className="nc-fs-list">
            {picker.rel && (
              <button type="button" className="nc-fs-item nc-fs-nav" onClick={goParent}>↑ {t('fs-parent')}</button>
            )}
            {picker.loading && <div className="nc-fs-empty">…</div>}
            {!picker.loading && (picker.dirs.length === 0) && <div className="nc-fs-empty">{t('fleet-cwd-repair-fs-empty')}</div>}
            {!picker.loading && picker.dirs.map((d) => (
              <button type="button" className="nc-fs-item" key={d} onClick={() => enterDir(d)}>📁 {d}</button>
            ))}
          </div>
          {picker.err && <div className="nc-err">{picker.err}</div>}
          <div className="nc-sheet-actions">
            <button type="button" className="nc-btn primary" disabled={disabled || picker.loading || !!picker.err} onClick={useCurrent}>
              {t('fleet-cwd-repair-use-current')}
            </button>
          </div>
        </div>
      )}

      {error && <div className="nc-err" role="alert">{error}</div>}

      {suggestion !== null && (
        <div className="nc-cwd-suggestion" role="status">
          <span>{t('fleet-cwd-repair-suggestion')}</span>
          <button type="button" className="nc-btn ghost" onClick={useSuggestion}>
            {t('fleet-cwd-repair-use-suggestion').replace('{path}', displayPath(suggestion))}
          </button>
        </div>
      )}

      <div className="nc-sheet-actions">
        <button type="button" className="nc-btn ghost" disabled={submitting} onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="nc-btn primary" disabled={disabled} onClick={apply}>
          {submitting ? '…' : t('save')}
        </button>
      </div>
    </div>
  );
}
