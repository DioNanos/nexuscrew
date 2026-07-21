import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { createFleetBackup, parseFleetBackup } from '../../lib/fleet-backup.js';

// Dialog di backup/restore: export selettivo (engine + cell, prompt si, segreti
// mai) e import da file con conferme di sovrascrittura. Estratto invariato da
// FleetTab.jsx; la normalizzazione/portabilità vive in lib/fleet-backup.js.
export default function FleetBackupDialog({ cells = [], engines = [], busy, canRestore = false, onRestore, onClose }) {
  const [tab, setTab] = useState('export');
  const [selectedCellsOut, setSelectedCellsOut] = useState(() => new Set(cells.map((cell) => cell.id)));
  const [selectedEnginesOut, setSelectedEnginesOut] = useState(() => new Set(engines.map((engine) => engine.id)));
  const [cellRows, setCellRows] = useState([]);
  const [engineRows, setEngineRows] = useState([]);
  const [error, setError] = useState('');
  const existingEngineIds = new Set(engines.map((engine) => engine.id));
  const existingCellIds = new Set(cells.map((cell) => cell.id));

  const toggleSet = (setter, id) => setter((before) => {
    const next = new Set(before); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const exportSelected = () => {
    const backup = createFleetBackup(cells, selectedCellsOut, engines, selectedEnginesOut);
    // Fail-closed: una cella selezionata priva di cwdRel portatile (needsRepair)
    // non viene mai omessa silenziosamente -> errore esplicito i18n.
    if (backup.ok === false) { setError(t(`fleet-backup-${backup.error}`)); return; }
    const selectedCellCount = cells.filter((cell) => selectedCellsOut.has(cell.id)).length;
    const selectedEngineCount = engines.filter((engine) => selectedEnginesOut.has(engine.id)).length;
    if (backup.cells.length !== selectedCellCount) { setError(t('fleet-backup-invalid-cell')); return; }
    if (backup.engines.length !== selectedEngineCount) { setError(t('fleet-backup-invalid-engine')); return; }
    if (!backup.cells.length && !backup.engines.length) { setError(t('fleet-backup-select-one')); return; }
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `nexuscrew-fleet-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0); setError('');
  };
  const readFile = async (file) => {
    setError(''); setCellRows([]); setEngineRows([]);
    if (!file) return;
    if (file.size > 1024 * 1024) { setError(t('fleet-backup-too-large')); return; }
    try {
      const parsed = parseFleetBackup(await file.text());
      if (!parsed.ok) { setError(t(`fleet-backup-${parsed.error}`)); return; }
      const importedIds = new Set(parsed.engines.map((engine) => engine.id));
      setEngineRows(parsed.engines.map((engine) => ({
        engine, exists: existingEngineIds.has(engine.id), selected: !existingEngineIds.has(engine.id),
      })));
      setCellRows(parsed.cells.map((cell) => {
        const engineOk = existingEngineIds.has(cell.engine) || importedIds.has(cell.engine);
        const exists = existingCellIds.has(cell.id);
        return { cell, engine: engineOk ? cell.engine : '', selected: engineOk && !exists, exists };
      }));
    } catch (e) { setError(String(e.message || e)); }
  };
  const updateCellRow = (index, patch) => setCellRows((before) => before.map((row, i) => i === index ? { ...row, ...patch } : row));
  const updateEngineRow = (index, patch) => setEngineRows((before) => before.map((row, i) => i === index ? { ...row, ...patch } : row));
  const selectedImportEngineIds = new Set([
    ...existingEngineIds,
    ...engineRows.filter((row) => row.selected).map((row) => row.engine.id),
  ]);
  const selectedCellRows = cellRows.filter((row) => row.selected && row.engine && selectedImportEngineIds.has(row.engine));
  const selectedEngineRows = engineRows.filter((row) => row.selected);
  const importEngineOptions = [...new Map([
    ...engines.map((engine) => [engine.id, engine.label || engine.id]),
    ...engineRows.filter((row) => row.selected).map((row) => [row.engine.id, row.engine.label || row.engine.id]),
  ]).entries()];

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
          <button type="button" className="nc-btn ghost" onClick={() => { setSelectedCellsOut(new Set(cells.map((cell) => cell.id))); setSelectedEnginesOut(new Set(engines.map((engine) => engine.id))); }}>{t('select-all')}</button>
          <button type="button" className="nc-btn ghost" onClick={() => { setSelectedCellsOut(new Set()); setSelectedEnginesOut(new Set()); }}>{t('select-none')}</button>
        </div>
        <div className="nc-backup-list">
          <b>{t('fleet-engines')}</b>
          {engines.map((engine) => <label className="nc-check nc-backup-row" key={engine.id}>
            <input type="checkbox" checked={selectedEnginesOut.has(engine.id)} onChange={() => toggleSet(setSelectedEnginesOut, engine.id)} />
            <span><b>{engine.label || engine.id}</b><small>{engine.id}{engine.envKeys?.length ? ` · ${engine.envKeys.length} ${t('fleet-backup-env-names')}` : ''}</small></span>
          </label>)}
          <b>{t('fleet-cells')}</b>
          {cells.map((cell) => <label className="nc-check nc-backup-row" key={cell.id}>
            <input type="checkbox" checked={selectedCellsOut.has(cell.id)} onChange={() => toggleSet(setSelectedCellsOut, cell.id)} />
            <span><b>{cell.id}</b><small>{cell.engine} · {t('fleet-system-prompt')} {(cell.prompt || '').length} {t('characters')}</small></span>
          </label>)}
          {!cells.length && !engines.length && <div className="nc-empty">{t('fleet-backup-empty')}</div>}
        </div>
        <div className="nc-sheet-actions"><button type="button" className="nc-btn ghost" onClick={onClose}>{t('cancel')}</button><button type="button" className="nc-btn primary" disabled={!selectedCellsOut.size && !selectedEnginesOut.size} onClick={exportSelected}>{t('fleet-backup-download')}</button></div>
      </> : <>
        <input type="file" accept="application/json,.json" disabled={busy} onChange={(e) => readFile(e.target.files && e.target.files[0])} />
        <small>{t('fleet-backup-import-help')}</small>
        {!!(cellRows.length || engineRows.length) && <div className="nc-set-row">
          <button type="button" className="nc-btn ghost" onClick={() => { setEngineRows((all) => all.map((row) => ({ ...row, selected: true }))); setCellRows((all) => all.map((row) => ({ ...row, selected: !!row.engine }))); }}>{t('select-all')}</button>
          <button type="button" className="nc-btn ghost" onClick={() => { setEngineRows((all) => all.map((row) => ({ ...row, selected: false }))); setCellRows((all) => all.map((row) => ({ ...row, selected: false }))); }}>{t('select-none')}</button>
        </div>}
        <div className="nc-backup-list">
          {!!engineRows.length && <b>{t('fleet-engines')}</b>}
          {engineRows.map((row, index) => <div className="nc-backup-import-row" key={row.engine.id}>
            <label className="nc-check">
              <input type="checkbox" checked={row.selected} onChange={(e) => updateEngineRow(index, { selected: e.target.checked })} />
              <span><b>{row.engine.label || row.engine.id}</b><small>{row.engine.id} · {row.exists ? t('fleet-backup-overwrite') : t('fleet-backup-new')}{row.engine.envKeys?.length ? ` · ${t('fleet-backup-env-values-required')}` : ''}</small></span>
            </label>
          </div>)}
          {!!cellRows.length && <b>{t('fleet-cells')}</b>}
          {cellRows.map((row, index) => <div className="nc-backup-import-row" key={row.cell.id}>
            <label className="nc-check">
              <input type="checkbox" checked={row.selected} disabled={!row.engine || !selectedImportEngineIds.has(row.engine)} onChange={(e) => updateCellRow(index, { selected: e.target.checked })} />
              <span><b>{row.cell.id}</b><small>{row.exists ? t('fleet-backup-overwrite') : t('fleet-backup-new')} · {t('fleet-system-prompt')} {row.cell.systemPrompt.length} {t('characters')}</small></span>
            </label>
            <select value={row.engine} onChange={(e) => updateCellRow(index, { engine: e.target.value, selected: !!e.target.value })}>
              <option value="">{t('fleet-backup-engine-missing')}</option>
              {importEngineOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>)}
        </div>
        <div className="nc-sheet-actions"><button type="button" className="nc-btn ghost" onClick={onClose}>{t('cancel')}</button><button type="button" className="nc-btn primary" disabled={busy || (!selectedCellRows.length && !selectedEngineRows.length)} onClick={() => onRestore({ engineRows, cellRows })}>{t('fleet-backup-restore')}</button></div>
      </>}
      {error && <div className="nc-err">{error}</div>}
    </div>
  );
}
