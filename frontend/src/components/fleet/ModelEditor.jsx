import { useState } from 'react';
import { t } from '../../lib/i18n.js';

// Dichiarazione di un modello, con la prova sull'API accanto al campo.
//
// La prova sta QUI e non solo nell'elenco perche' il momento in cui serve e'
// prima di salvare: «e' uscito X, funziona?». Scoprire un id sbagliato dopo,
// quando la cella non parte, e' il difetto che questa finestra esiste per
// togliere.
//
// L'esito e' un enum chiuso e si rende come tale: nessun testo del fornitore
// arriva fin qui, e «non verificato» non si colora come un successo — una
// prova non ottenuta non autorizza a credere che il modello funzioni.
export default function ModelEditor({
  state, setState, busy, onSave, onTest, profiles = [], canTest = true,
}) {
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const form = state.form;
  const set = (patch) => setState({ ...state, form: { ...form, ...patch } });
  const idOk = /^[^\x00-\x1f\x7f]{1,128}$/.test(form.id || '');
  const pronto = !!(form.id || '').trim() && !!(form.engine || '').trim() && idOk;

  const prova = async () => {
    setTest(null); setTesting(true);
    try { setTest(await onTest(form.engine, form.id)); }
    catch (e) { setTest({ outcome: 'unverified', detail: String((e && e.message) || e) }); }
    setTesting(false);
  };

  return (
    <div className="nc-fleet-form">
      <label className="nc-field">{t('model-editor-engine')}
        <select value={form.engine || ''} disabled={busy || state.mode === 'edit'}
          onChange={(e) => { setTest(null); set({ engine: e.target.value }); }}>
          <option value="">—</option>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.label ? `${p.id} · ${p.label}` : p.id}</option>)}
        </select>
      </label>
      <label className="nc-field">{t('model-editor-id')}
        <input value={form.id || ''} disabled={busy || state.mode === 'edit'} placeholder="qwen3.9-max"
          onChange={(e) => { setTest(null); set({ id: e.target.value }); }} />
      </label>
      <small className="nc-set-hint">{t('model-editor-id-help')}</small>

      <label className="nc-field">{t('model-editor-context')}
        <input inputMode="numeric" value={form.contextWindow || ''} disabled={busy}
          onChange={(e) => set({ contextWindow: e.target.value.replace(/[^0-9]/g, '').slice(0, 9) })} />
      </label>
      <label className="nc-field">{t('model-editor-max-tokens')}
        <input inputMode="numeric" value={form.maxTokens || ''} disabled={busy}
          onChange={(e) => set({ maxTokens: e.target.value.replace(/[^0-9]/g, '').slice(0, 9) })} />
      </label>
      <label className="nc-check">
        <input type="checkbox" checked={form.reasoning === true} disabled={busy}
          onChange={(e) => set({ reasoning: e.target.checked })} /> {t('model-editor-reasoning')}
      </label>

      <div className="nc-set-row">
        {/* Su un nodo che non espone la capability la prova non esiste: si
            toglie il bottone invece di offrirne uno che torna 501. */}
        {canTest && <button type="button" className="nc-btn ghost" disabled={busy || testing || !pronto} onClick={prova}>
          {testing ? t('model-test-running') : t('model-test')}
        </button>}
        {test && (
          <span className={`nc-model-test ${test.outcome}`}>
            {t(`model-test-${test.outcome}`)}
            {test.outcome === 'ok' && Number.isInteger(test.latencyMs) ? ` · ${test.latencyMs}ms` : ''}
          </span>
        )}
      </div>
      {/* Il dettaglio e' NOSTRO, mai del fornitore: un timeout, un catalogo non
          esposto. Si mostra perche' distingue due esiti che si somigliano. */}
      {test && test.detail && <small className="nc-set-hint">{test.detail}</small>}
      {test && test.outcome === 'unverified' && <small className="nc-set-hint">{t('model-test-unverified-help')}</small>}

      {/* Annulla PRIMA di salva, come negli altri due editor. Senza, l'unica
          uscita da questa finestra era salvare: la modale si chiude con Escape
          o cliccando lo sfondo, ma su un telefono non c'e' Escape e lo sfondo
          puo' non essere raggiungibile. Segnalato da chi la usava. */}
      <div className="nc-sheet-actions">
        <button type="button" className="nc-btn ghost" onClick={() => setState(null)}>
          {t('cancel')}
        </button>
        <button type="button" className="nc-btn primary" disabled={busy || !pronto} onClick={() => onSave(form)}>
          {t('save')}
        </button>
      </div>
    </div>
  );
}
