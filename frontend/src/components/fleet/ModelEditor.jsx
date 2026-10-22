import { useState } from 'react';
import { t } from '../../lib/i18n.js';
import { MODEL_BOOLEAN_FIELDS, validModelLimit, parseEffortLevels } from '../../lib/model-fields.js';

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
  // I limiti fuori scala si fermano qui, con la stessa scala del parser: il
  // salvataggio non deve fallire dopo, davanti a un messaggio sul file.
  const limitsOk = ['contextWindow', 'maxTokens'].every((key) => {
    const raw = String(form[key] === undefined ? '' : form[key]).trim();
    return !raw || validModelLimit(raw);
  });
  // I livelli di effort dichiarati: una stringa separata da virgole nel
  // dialogo, un array nel file. La validazione e' quella del parser, e un
  // livello non conforme blocca il salvataggio PRIMA: meglio un campo che si
  // rifiuta di essere salvato che un file che il parser respinge dopo.
  const effortText = Array.isArray(form.effortLevels)
    ? form.effortLevels.join(', ')
    : String(form.effortLevels || '');
  const effortOk = parseEffortLevels(form.effortLevels).ok;
  const pronto = !!(form.id || '').trim() && !!(form.engine || '').trim() && idOk && limitsOk && effortOk;

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
        <input inputMode="numeric" aria-label={t('fleet-models-field-context')} value={form.contextWindow || ''} disabled={busy} aria-invalid={form.contextWindow && !validModelLimit(form.contextWindow) ? 'true' : 'false'}
          onChange={(e) => set({ contextWindow: e.target.value.replace(/[^0-9]/g, '').slice(0, 9) })} />
      </label>
      {form.contextWindow && !validModelLimit(form.contextWindow) && <small className="nc-err">{t('model-editor-limit-invalid')}</small>}
      <label className="nc-field">{t('model-editor-max-tokens')}
        <input inputMode="numeric" aria-label={t('fleet-models-field-output')} value={form.maxTokens || ''} disabled={busy} aria-invalid={form.maxTokens && !validModelLimit(form.maxTokens) ? 'true' : 'false'}
          onChange={(e) => set({ maxTokens: e.target.value.replace(/[^0-9]/g, '').slice(0, 9) })} />
      </label>
      {form.maxTokens && !validModelLimit(form.maxTokens) && <small className="nc-err">{t('model-editor-limit-invalid')}</small>}
      {/* I booleani sono a TRE stati, non una casella: «lascia vuoto» e'
          un'assenza, e non deve diventare un `false` che nessuno ha scelto. */}
      {MODEL_BOOLEAN_FIELDS.map((key) => <label key={key} className="nc-field">
        {t(`model-editor-${key === 'reasoning' ? 'reasoning' : key}`)}
        <select value={form[key] === undefined || form[key] === null ? '' : String(form[key])} disabled={busy}
          onChange={(e) => set({ [key]: e.target.value === '' ? undefined : e.target.value === 'true' })}>
          <option value="">{t('model-editor-absent')}</option>
          <option value="true">{t('model-editor-true')}</option>
          <option value="false">{t('model-editor-false')}</option>
        </select>
      </label>)}
      {/* I livelli di effort: una dichiarazione, non un interruttore. Il
          cliente vl accetta solo i livelli dichiarati, quindi vuoto vuol
          dire "nessun livello richiesto" — non "un livello a caso". */}
      <label className="nc-field">{t('model-editor-effort-levels')}
        <input aria-label={t('fleet-models-field-effort')} value={effortText} disabled={busy}
          placeholder="low, medium" aria-invalid={effortOk ? 'false' : 'true'}
          onChange={(e) => set({ effortLevels: e.target.value })} />
      </label>
      {!effortOk && <small className="nc-err">{t('model-editor-effort-invalid')}</small>}

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
