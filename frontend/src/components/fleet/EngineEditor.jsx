import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n.js';
import { catalogEntry } from '../../lib/fleet-forms.js';
// Anticipazione lato UI: stesso validatore del round-trip di backup (gia'
// sorvegliato contro il validatore autorevole del backend), v. CellEditor.jsx.
import { validBackupPanelUrl } from '../../lib/fleet-backup.js';
import { MODEL_BOOLEAN_FIELDS, modelFieldErrors } from '../../lib/model-fields.js';

// Sezione «puoi usare questi»: l'elenco dei modelli scoperti per l'engine, con
// la provenienza DISCRETA di ogni campo (utente / API / catalogo / backup) e
// il modello non più nelle API evidenziato in rosso ma comunque selezionabile
// e provabile. `fetchModels(engineId, refresh)` è iniettata dal parent: nei
// test è un fake, mai un provider vero. Stale ed errori di rete sono una
// riga: l'editor non si blocca mai per la scoperta.
const MODEL_FIELDS = [
  ['contextWindow', 'fleet-models-field-context'],
  ['maxTokens', 'fleet-models-field-output'],
  ['tools', 'fleet-models-field-tools'],
  ['vision', 'fleet-models-field-vision'],
  ['reasoning', 'fleet-models-field-reasoning'],
];
// I campi che l'engine DIPENDE da avere (piano, punto 2): gli altri del record
// sono opzionali. Se il modello attivo non li ha da nessun layer, il dialogo
// sotto chiede il dato e il valore confermato diventa un valore dell'utente.
const REQUIRED_MODEL_FIELDS = [
  ['contextWindow', 'fleet-models-field-context'],
  ['maxTokens', 'fleet-models-field-output'],
];
const SOURCE_LABELS = { user: 'fleet-models-source-user', api: 'fleet-models-source-api', public: 'fleet-models-source-public', backup: 'fleet-models-source-backup' };
// Cause dell'autenticazione del listing, dal blocco `auth` curato dal nodo.
// Ogni causa ha la SUA riga a stringa fissa; «missing-key» senza envKey (auth
// none) ha la sua variante: la richiesta era anonima, e nessun nome va inventato.
const AUTH_CAUSES = ['missing-key', 'key-rejected', 'access-denied', 'credential-unavailable', 'endpoint-unreachable', 'provider-error', 'invalid-response', 'anonymous-success'];
function authCauseLabel(cause, envKey) {
  if (cause === 'missing-key' && !envKey) return 'fleet-models-auth-missing-key-anonymous';
  return `fleet-models-auth-${cause}`;
}

// Finestra dei dati mancanti (piano, punto 3): dice COSA manca, mostra il
// valore di backup proposto dal catalogo interno (precompilato, «se c'è») e
// offre le tre strade: confermare così com'è, cambiarlo, lasciarlo vuoto.
// Confermare chiama il parent, che scrive il valore come dichiarazione utente
// (fleet.json): precedenza più alta, mai riscritta dalla scoperta.
function ModelFieldsDialog({
  model, fields, busy, onConfirm, onCancel, mode, error = '', writing = false,
}) {
  const [values, setValues] = useState(() => Object.fromEntries(
    // Un campo mancante parte dal backup proposto; uno da confermare parte dal
    // suo valore attuale. In entrambi i casi il vuoto resta vuoto.
    fields.map(({ field, value, backup }) => [field, value !== undefined && value !== null
      ? String(value)
      : (backup !== undefined ? String(backup) : '')]),
  ));
  const missing = mode === 'missing';
  // La stessa validazione del parser, PRIMA della conferma: un valore fuori
  // scala si vede accanto al campo e Confirm resta spento.
  const fieldErrors = modelFieldErrors(values);
  const invalid = Object.keys(fieldErrors).length > 0;
  const title = missing
    ? t('fleet-models-missing-title')
    : t('fleet-models-make-mine-title').replace('{model}', model);
  return <div className="nc-fleet-missing" role="dialog" aria-label={title}>
    <b className={missing ? 'nc-err' : undefined}>{title}</b>
    <small>{missing
      ? t('fleet-models-missing-why').replace('{model}', model)
      : t('fleet-models-make-mine-why')}</small>
    {fields.map(({ field, label, backup }) => MODEL_BOOLEAN_FIELDS.includes(field)
      // Tre stati, non una casella: vuoto e' un'assenza e non diventa un
      // `false` che nessuno ha scelto.
      ? <label key={field} className="nc-field">
        {t(label)}
        <select aria-label={t(label)} value={values[field] || ''} disabled={busy}
          onChange={(e) => setValues({ ...values, [field]: e.target.value })}>
          <option value="">{t('fleet-models-value-absent')}</option>
          <option value="true">{t('fleet-models-value-true')}</option>
          <option value="false">{t('fleet-models-value-false')}</option>
        </select>
      </label>
      : <label key={field} className="nc-field">
        {t(label)}
        <input inputMode="numeric" value={values[field] || ''} disabled={busy} aria-label={t(label)}
          placeholder={backup !== undefined ? String(backup) : ''} autoComplete="off"
          onChange={(e) => setValues({ ...values, [field]: e.target.value.replace(/[^0-9]/g, '').slice(0, 9) })} />
        {fieldErrors[field] && <small className="nc-err">{t('model-editor-limit-invalid')}</small>}
        {backup !== undefined && <small className="nc-fleet-models-note">{t('fleet-models-missing-backup').replace('{value}', String(backup))}</small>}
      </label>)}
    <small>{t('fleet-models-missing-user')}</small>
    {error && <small className="nc-err nc-fleet-write-error">{error}</small>}
    <div className="nc-sheet-actions">
      <button type="button" className="nc-btn ghost" disabled={busy || writing} onClick={onCancel}>
        {missing ? t('fleet-models-missing-empty') : t('cancel')}
      </button>
      <button type="button" className="nc-btn primary" disabled={busy || writing || invalid} onClick={() => onConfirm(values)}>
        {missing ? t('fleet-models-missing-confirm') : t('fleet-models-make-mine-confirm')}
      </button>
    </div>
  </div>;
}

function ModelDiscoverySection({ engineId, fetchModels, onPick, activeModel, onSetModelValue, busy }) {
  const [view, setView] = useState({ loading: true, refreshing: false, result: null, error: '' });
  // Il parent puo' passare una funzione inline (nuova identita' a ogni suo
  // render): l'effetto dipende SOLO dall'engine, la funzione la legge via ref.
  const fetchRef = useRef(fetchModels);
  fetchRef.current = fetchModels;
  const load = (refresh) => fetchRef.current(engineId, refresh)
    .then((result) => ({ loading: false, refreshing: false, result, error: '' }))
    .catch(() => ({ loading: false, refreshing: false, result: null, error: t('fleet-models-error') }));
  useEffect(() => {
    let alive = true;
    setView({ loading: true, refreshing: false, result: null, error: '' });
    load(false).then((next) => { if (alive) setView(next); });
    return () => { alive = false; };
  }, [engineId]);
  const refresh = () => {
    if (view.loading || view.refreshing) return;
    setView({ ...view, refreshing: true });
    fetchRef.current(engineId, true)
      .then((result) => { setView({ loading: false, refreshing: false, result, error: '' }); })
      .catch(() => { setView({ loading: false, refreshing: false, result: view.result, error: t('fleet-models-error') }); });
  };
  // Dati mancanti del modello ATTIVO: campi richiesti che nessun layer ha
  // riempito (record assente = mancano tutti). La proposta di backup arriva
  // dal catalogo interno via `backupValues`, e resta una PROPOSTA: entra nel
  // form solo se l'operatore conferma.
  const active = String(activeModel || '').trim();
  const result = view.result;
  const models = result && Array.isArray(result.models) ? result.models : [];
  // Diagnosi dell'autenticazione del listing: una riga dedicata, visibile
  // anche su dati stantii/di riserva e con un elenco vuoto — non la sostituisce
  // mai «nessun modello trovato». La envKey si mostra solo se il nodo la manda
  // (è già pubblica nell'editor); nessun valore, mai.
  const auth = result && result.auth && typeof result.auth === 'object' ? result.auth : null;
  const authCause = auth && AUTH_CAUSES.includes(auth.cause) ? auth.cause : '';
  const authEnvKey = auth && typeof auth.envKey === 'string' ? auth.envKey : '';
  const activeRecord = active ? models.find((m) => m.id === active) : null;
  // The known ids carry defaults even when the engine exposes no listing:
  // `supported: false` describes the API layer, not the proposal. The dialog
  // must work on that proposal too.
  const missing = !view.loading && !view.error && result && active
    ? REQUIRED_MODEL_FIELDS
      .filter(([field]) => !activeRecord || activeRecord[field] === undefined)
      .map(([field, label]) => ({
        field, label,
        backup: activeRecord && activeRecord.backupValues ? activeRecord.backupValues[field] : undefined,
      }))
    : [];
  const missingKey = `${active}:${missing.map((x) => x.field).join(',')}`;
  // Si apre DA SOLO una volta per combinazione modello+campi: dopo un
  // «lascia vuoto» non si ripresenta per lo stesso difetto, resta il bottone.
  const askedRef = useRef('');
  const [dialog, setDialog] = useState(false);
  useEffect(() => {
    if (!missing.length || !onSetModelValue) return;
    if (askedRef.current === missingKey) return;
    askedRef.current = missingKey;
    setDialog(true);
  }, [missingKey, onSetModelValue]);
  const closeDialog = () => { setDialog(false); setDialogError(''); };
  // UN solo percorso di scrittura per tutte le azioni: il dato mancante, il
  // singolo campo, la riga intera. La callback restituisce l'esito; la vista si
  // ricarica SOLO dopo una scrittura riuscita, e il dialogo si chiude solo
  // allora. Se la scrittura fallisce restano aperti i valori inseriti e
  // l'errore, che il refresh periodico del parent non tocca.
  const writeValues = async (modelId, values) => {
    let outcome;
    try {
      const result = await Promise.resolve(onSetModelValue(engineId, modelId, values));
      outcome = result && result.ok === false
        ? { ok: false, error: result.error || t('fleet-models-write-failed') }
        : { ok: true };
    } catch (e) {
      outcome = { ok: false, error: String((e && e.message) || e) };
    }
    if (outcome.ok) {
      setView({ loading: true, refreshing: false, result: null, error: '' });
      try { setView(await load(false)); } catch (_) { /* la vista ha gia' il suo errore */ }
    }
    return outcome;
  };
  const [dialogWriting, setDialogWriting] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const confirmMissing = async (values) => {
    setDialogError('');
    setDialogWriting(true);
    const outcome = await writeValues(active, values);
    setDialogWriting(false);
    if (outcome.ok) setDialog(false); else setDialogError(outcome.error);
  };
  const [editor, setEditor] = useState(null);
  const [editorWriting, setEditorWriting] = useState(false);
  const [editorError, setEditorError] = useState('');
  const confirmEditor = async (values) => {
    const modelId = editor && editor.model;
    if (!modelId) return;
    setEditorError('');
    setEditorWriting(true);
    const outcome = await writeValues(modelId, values);
    setEditorWriting(false);
    if (outcome.ok) setEditor(null); else setEditorError(outcome.error);
  };
  const openFieldEditor = (row, field, label) => {
    setEditorError('');
    setEditor({ model: row.id, fields: [{ field, label, value: row[field] }] });
  };
  const openRowEditor = (row) => {
    setEditorError('');
    setEditor({ model: row.id, fields: MODEL_FIELDS.map(([field, label]) => ({ field, label, value: row[field] })) });
  };
  return <section className="nc-fleet-models" aria-label={t('fleet-models-title')}>
    <div className="nc-fleet-models-head">
      <b>{t('fleet-models-usable')}</b>
      <button type="button" className="nc-btn ghost" disabled={view.loading || view.refreshing} onClick={refresh}>{t(view.refreshing ? 'fleet-models-refreshing' : 'fleet-models-refresh')}</button>
    </div>
    {view.loading && <small>{t('fleet-models-loading')}</small>}
    {!view.loading && view.error && <small className="nc-err">{view.error}</small>}
    {!view.loading && !view.error && result && result.stale === true && <small className="nc-fleet-models-note">{t('fleet-models-stale')}</small>}
    {/* Diagnosi dell'autenticazione del listing: una riga dedicata per causa.
        Sta sopra i dati, non al loro posto: resta visibile con stale/backup e
        con elenco vuoto, e «nessun modello trovato» continua a dire il suo.
        La envKey entra solo se il nodo la manda (già pubblica nell'editor):
        mai un valore, mai un nome inventato per auth none. */}
    {!view.loading && !view.error && result && result.supported !== false && authCause
      && <small className="nc-fleet-models-note nc-fleet-models-auth">{t(authCauseLabel(authCause, authEnvKey)).replace('{key}', authEnvKey)}</small>}
    {!view.loading && result && result.supported === false && <small>{t('fleet-models-unsupported')}</small>}
    {!view.loading && result && result.supported !== false && !models.length && <small>{t('fleet-models-none')}</small>}
    {dialog && missing.length > 0 && <ModelFieldsDialog mode="missing" model={active} fields={missing} busy={busy} onConfirm={confirmMissing} onCancel={closeDialog} error={dialogError} writing={dialogWriting} />}
    {editor && <ModelFieldsDialog mode="edit" model={editor.model} fields={editor.fields} busy={busy} onConfirm={confirmEditor} onCancel={() => setEditor(null)} error={editorError} writing={editorWriting} />}
    {!dialog && missing.length > 0 && onSetModelValue && <button type="button" className="nc-btn ghost nc-fleet-missing-open" onClick={() => setDialog(true)}>{t('fleet-models-missing-open').replace('{model}', active)}</button>}
    {models.map((m) => <div key={m.id} className={`nc-fleet-model-row${m.inApi === false ? ' nc-model-not-in-api' : ''}`}>
      <button type="button" className="nc-btn ghost nc-fleet-model-pick" aria-label={t('fleet-models-use').replace('{model}', m.id)} onClick={() => onPick(m.id)}>{m.id}</button>
      {m.inApi === false && <b className="nc-err">{t('fleet-models-not-in-api')}</b>}
      {MODEL_FIELDS.map(([field, label]) => {
        const src = m.fieldSources ? m.fieldSources[field] : undefined;
        return <span key={field} className="nc-fleet-model-field">
          {t(label)}: {m[field] === undefined ? '–' : String(m[field])}
          {/* Un valore che viene dal catalogo e' un DEFAULT, non una verifica
              del runtime: si dice con il nome della fonte, non con «catalogo». */}
          {src === 'public'
            ? <small className="nc-fleet-model-src" title={t('fleet-models-source-of').replace('{source}', t('fleet-models-source-public'))}>{t('fleet-models-default-badge')}</small>
            : src && <small className="nc-fleet-model-src" title={t('fleet-models-source-of').replace('{source}', t(SOURCE_LABELS[src] || src))}>{t(SOURCE_LABELS[src] || src)}</small>}
          {/* Azione su OGNI campo, anche su una riga non attiva: modifica o
              conferma quel solo campo, sullo stesso percorso di persistenza. */}
          {onSetModelValue && <button type="button" className="nc-btn ghost nc-fleet-model-mine"
            aria-label={t('fleet-models-make-mine-field').replace('{field}', t(label)).replace('{model}', m.id)}
            onClick={() => openFieldEditor(m, field, label)}>{t('fleet-models-make-mine')}</button>}
        </span>;
      })}
      {/* Azione di riga: raggruppa gli stessi controlli, non un secondo
          percorso di scrittura. */}
      {onSetModelValue && <button type="button" className="nc-btn ghost nc-fleet-model-mine-row"
        aria-label={t('fleet-models-make-mine-row').replace('{model}', m.id)}
        onClick={() => openRowEditor(m)}>{t('fleet-models-make-mine')}</button>}
    </div>)}
    {result && result.supported !== false && <small className="nc-fleet-models-note">{t('fleet-models-cap').replace('{cap}', String(result.cap || 128))}</small>}
  </section>;
}

// Editor di un engine (managed o custom). State-less rispetto alle API: riceve
// lo stato del form e lo risolleva al parent (FleetTab), che è l'unico a
// eseguire le mutazioni. Estratto invariato da FleetTab.jsx.
export default function EngineEditor({ state, setState, busy, onSave, catalog, fetchModels, onSetModelValue }) {
  const f = state.form; const set = (patch) => setState({ ...state, form: { ...f, ...patch } });
  const rows = f.envRows || [];
  const clients = [...new Map(catalog.map((p) => [p.client, p.clientLabel || p.client])).entries()];
  const profiles = catalog.filter((p) => p.client === f.client);
  const selectedProfile = catalogEntry(catalog, f);
  const fixedCredentialEnv = typeof selectedProfile?.credentialEnv === 'string' ? selectedProfile.credentialEnv : '';
  const credentialUsedBy = Array.isArray(selectedProfile?.credentialUsedBy) ? selectedProfile.credentialUsedBy : [];
  const credentialSource = selectedProfile?.credentialSource || 'missing';
  // Policy applies to any profile that owns a credential env key: dynamic Z.AI
  // (credentialEnv === true), fixed-env providers (string), and legacy Z.AI A/P
  // profiles edited in place (credentialProfile a/p) even though they are absent
  // from the public catalog and never offered as NEW-engine choices.
  const policyApplicable = !!selectedProfile?.credentialEnv || f.credentialProfile === 'a' || f.credentialProfile === 'p';
  const missingCredentialNeedsConfirmation = !!fixedCredentialEnv && state.mode === 'new'
    && selectedProfile?.authConfigured !== true && !f.credentialValue && !f.allowMissingCredential;
  const setManagedProfile = (entry) => {
    if (!entry) return;
    set({ client: entry.client, provider: entry.provider, credentialProfile: entry.credentialProfile || '', managedModel: entry.model || '', protocol: entry.protocol || '', permissionPolicy: entry.permissionPolicyDefault || 'standard', credentialSourcePolicy: 'auto', rc: !!entry.rc, displayName: entry.custom ? t('fleet-custom-provider-default') : '', baseUrl: entry.custom ? '' : entry.endpoint || '', envKey: entry.defaultEnvKey || '', providerId: 'nexuscrew-custom', credentialValue: '', credentialReveal: false, allowMissingCredential: false, ...(state.mode === 'new' ? { id: entry.id, label: '' } : {}) });
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
      {f.client !== 'shell' && <>
        <input value={f.managedModel} list="nc-managed-models" placeholder={t(selectedProfile?.requiresModel ? 'fleet-model-required' : 'fleet-model-default')} onChange={(e) => set({ managedModel: e.target.value })} />
        <datalist id="nc-managed-models">{[...(selectedProfile?.models || []), ...(f.modelOptions || [])].filter((value, index, all) => value && all.indexOf(value) === index).map((model) => <option key={model} value={model} />)}</datalist>
        {fetchModels && (state.mode === 'edit' ? f.id : selectedProfile?.id) && <ModelDiscoverySection
          engineId={state.mode === 'edit' ? f.id : selectedProfile?.id}
          fetchModels={fetchModels}
          onPick={(id) => set({ managedModel: id })}
          activeModel={f.managedModel}
          onSetModelValue={onSetModelValue}
          busy={busy}
        />}
      </>}
      {selectedProfile?.supportsUnsafe ? <select value={f.permissionPolicy} onChange={(e) => set({ permissionPolicy: e.target.value })}><option value="standard">{t('fleet-standard-permissions')}</option><option value="unsafe">{t('fleet-unsafe-permissions')}</option></select> : <small>{t('fleet-standard-permissions')}</small>}
      {selectedProfile?.supportsUnsafe && f.permissionPolicy === 'unsafe' && <small className="nc-err">{t('fleet-unsafe-warning')}</small>}
      {policyApplicable && <select aria-label={t('fleet-credential-source-policy')} value={f.credentialSourcePolicy || 'auto'} onChange={(e) => set({ credentialSourcePolicy: e.target.value })}><option value="auto">{t('fleet-credential-source-policy-auto')}</option><option value="nexuscrew-store">{t('fleet-credential-source-policy-nexuscrew-store')}</option><option value="environment">{t('fleet-credential-source-policy-environment')}</option></select>}
      {selectedProfile?.credentialEnv === true && <>
        <input value={f.envKey} placeholder={t('fleet-api-key-env')} onChange={(e) => set({ envKey: e.target.value })} />
        <small>{t('fleet-custom-secret-help')}</small>
      </>}
      {fixedCredentialEnv && <section className="nc-fleet-key" aria-label={t('fleet-key-section')}>
        <div className="nc-fleet-key-head"><b>{t('fleet-key-section')}</b><span>{t(`fleet-credential-source-${credentialSource}`)}</span></div>
        <label className="nc-field">{t('fleet-key-variable')}
          <input value={fixedCredentialEnv} readOnly aria-label={t('fleet-key-variable')} />
        </label>
        <small>{credentialUsedBy.length
          ? t('fleet-key-used-by').replace('{engines}', credentialUsedBy.join(', '))
          : t('fleet-key-used-by-none')}</small>
        {credentialUsedBy.length > 0 && <small>{t('fleet-key-shared-impact').replace('{key}', fixedCredentialEnv).replace('{engines}', credentialUsedBy.join(', '))}</small>}
        <div className="nc-fleet-key-input">
          <input type={f.credentialReveal ? 'text' : 'password'} value={f.credentialValue || ''}
            aria-label={t('fleet-key-value').replace('{key}', fixedCredentialEnv)} autoComplete="new-password"
            spellCheck={false} autoCapitalize="none" autoCorrect="off"
            placeholder={selectedProfile?.authConfigured || state.mode === 'edit' ? t('fleet-key-blank-keeps') : t('fleet-key-enter')}
            onChange={(e) => set({ credentialValue: e.target.value, allowMissingCredential: e.target.value ? false : f.allowMissingCredential })} />
          <button type="button" className="nc-btn ghost" aria-label={t(f.credentialReveal ? 'fleet-key-hide' : 'fleet-key-reveal')}
            onClick={() => set({ credentialReveal: !f.credentialReveal })}>{t(f.credentialReveal ? 'fleet-key-hide' : 'fleet-key-reveal')}</button>
        </div>
        <small>{t('fleet-key-local-help')}</small>
        {state.mode === 'new' && selectedProfile?.authConfigured !== true && !f.credentialValue && <label className="nc-check nc-fleet-key-missing">
          <input type="checkbox" checked={!!f.allowMissingCredential} onChange={(e) => set({ allowMissingCredential: e.target.checked })} />
          {t('fleet-key-create-missing')}
        </label>}
        {selectedProfile?.notice && <small className="nc-fleet-provider-notice">{t(`fleet-provider-notice-${selectedProfile.notice}`)}</small>}
      </section>}
      {selectedProfile?.notice && !fixedCredentialEnv && <small className="nc-fleet-provider-notice">{t(`fleet-provider-notice-${selectedProfile.notice}`)}</small>}
      {f.provider === 'custom' && <>
        <input value={f.displayName} placeholder={t('fleet-provider-display')} onChange={(e) => set({ displayName: e.target.value })} />
        <input value={f.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} />
        {(selectedProfile?.protocols || []).length > 1 && <select value={f.protocol} onChange={(e) => set({ protocol: e.target.value })}>{selectedProfile.protocols.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select>}
        <div className="nc-fleet-pair"><input value={f.envKey} placeholder={t('fleet-api-key-env')} onChange={(e) => set({ envKey: e.target.value })} /><input value={f.providerId} placeholder={t('fleet-provider-id')} onChange={(e) => set({ providerId: e.target.value })} /></div>
        <small>{f.protocol} · {t('fleet-custom-secret-help')}</small>
      </>}
      {f.client === 'vl' && <>
        {/* Campi vl: identità per cella e catalogo profili sono del contratto
            engine vl; vuoto = assente (il campo si cancella svuotandolo, v.
            buildEngine in fleet-forms.js). Nessun segreto: percorsi e nomi. */}
        <input value={f.vlBinary || ''} placeholder={t('fleet-vl-binary')} onChange={(e) => set({ vlBinary: e.target.value })} />
        <input value={f.vlConfigFile || ''} placeholder={t('fleet-vl-config-file')} onChange={(e) => set({ vlConfigFile: e.target.value })} />
        <div className="nc-fleet-pair"><input value={f.vlProfile || ''} placeholder={t('fleet-vl-profile')} onChange={(e) => set({ vlProfile: e.target.value })} /><input value={f.effort || ''} placeholder={t('fleet-vl-effort')} onChange={(e) => set({ effort: e.target.value })} /></div>
        <small>{t('fleet-vl-fields-help')}</small>
      </>}
      <small>{t(f.client === 'shell' ? 'fleet-shell-engine-help' : 'fleet-managed-help')}</small>
    </> : <>
      <input value={f.command} placeholder={t('command-path')} onChange={(e) => set({ command: e.target.value })} />
      <textarea value={f.argsText} placeholder={t('args-lines')} onChange={(e) => set({ argsText: e.target.value })} />
      <label className="nc-check"><input type="checkbox" checked={f.rc} onChange={(e) => set({ rc: e.target.checked })} /> {t('fleet-remote-control')}</label>
      <select value={f.promptMode} onChange={(e) => set({ promptMode: e.target.value })}><option value="send-keys">send-keys</option><option value="flag">flag</option></select>
      {f.promptMode === 'flag' && <input value={f.promptFlag} placeholder="prompt flag" onChange={(e) => set({ promptFlag: e.target.value })} />}
      <div className="nc-fleet-pair"><input value={f.modelFlag} placeholder="model flag" onChange={(e) => set({ modelFlag: e.target.value })} /><input value={f.modelValue} placeholder="model default" onChange={(e) => set({ modelValue: e.target.value })} /></div>
      <small>{t('env-write-only')}</small>
      {rows.map((r, i) => <div className="nc-fleet-env" key={`${r.key}-${i}`}><input value={r.key} disabled={r.configured} placeholder="ENV_KEY" onChange={(e) => { const n = rows.slice(); n[i] = { ...r, key: e.target.value }; set({ envRows: n }); }} /><input type="password" value={r.value} placeholder={r.configured ? '•••••• (unchanged)' : 'value'} onChange={(e) => { const n = rows.slice(); n[i] = { ...r, value: e.target.value }; set({ envRows: n }); }} /><button className="nc-btn danger" onClick={() => set({ envRows: rows.filter((_, x) => x !== i) })}>×</button></div>)}
      <button className="nc-btn ghost" onClick={() => set({ envRows: [...rows, { key: '', value: '', configured: false }] })}>+ env</button>
    </>}
    {/* panelUrl: comune a managed e custom, fa da default per le celle che lo
        usano (v. lib/fleet/definitions.js — fallback engine->cella). */}
    <input value={f.panelUrl || ''} maxLength={512} placeholder={t('fleet-panel-url')} onChange={(e) => set({ panelUrl: e.target.value })} />
    <small>{t('fleet-panel-url-help')}</small>
    {f.panelUrl && !validBackupPanelUrl(f.panelUrl) && <small className="nc-err">{t('fleet-panel-url-invalid')}</small>}
    <div className="nc-sheet-actions"><button className="nc-btn ghost" onClick={() => setState(null)}>{t('cancel')}</button><button className="nc-btn primary" disabled={busy || !f.id || missingCredentialNeedsConfirmation || (f.kind === 'custom' && !f.command) || (f.kind === 'managed' && selectedProfile?.requiresModel && !f.managedModel) || (f.kind === 'managed' && selectedProfile?.credentialEnv === true && !f.envKey) || (f.kind === 'managed' && f.provider === 'custom' && (!f.displayName || !f.baseUrl || !f.envKey || !f.providerId))} onClick={onSave}>{t('save')}</button></div>
  </div>;
}
