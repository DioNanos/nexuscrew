import { useEffect, useMemo, useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { fleetStatus, fleetDefinitions } from '../lib/api.js';
import './PowerSheet.css';

// Launch editor CONDIVISO da Home (SessionList), Sidebar (App) e Impostazioni
// (FleetTab). Un solo posto per accendere/spegnere una cella, così non si
// duplicano UI né logica (z-index del launch sheet sopra Settings: vedi CSS).
//
//   cell:   oggetto cella flotta ({cell, engine, model, models, permissionPolicy,
//           permissionPolicies, active, boot, tmuxSession, route?})
//   route:  route Hydra ([] = locale)
//   onConfirm(payload): il genitore esegue fleetUp/fleetDown. payload:
//     OFF  -> {action:'up', engine, model, permissionPolicy, boot}   ("Salva e avvia")
//     ON   -> {action:'down', boot}                                  ("Spegni" + rimuovi boot)
//
// Engine/modello/policy sono modificabili qui per la cella; la definizione profonda
// (provider, credenziali, engine custom) resta in Impostazioni → Flotta. La policy è
// PER-CELL PER-ENGINE (mappa permissionPolicies[engineId]): mai si tocca il default
// globale dell'engine. Ricorda ultimo modello E ultima policy per engine.
export default function PowerSheet({ cell, token, route = [], onConfirm, onClose }) {
  useLang();
  const isOn = !!(cell && cell.active);
  const routeKey = Array.isArray(route) ? route.join('/') : '';

  // Definizioni + status sulla route corretta. Se il nodo non espone ancora le
  // definizioni, il foglio degrada a lifecycle+boot senza controlli fittizi.
  const [engines, setEngines] = useState([]);
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!token) return;
      try {
        const st = await fleetStatus(token, routeKey ? routeKey.split('/') : []);
        if (!alive) return;
        setCanEdit(st.provider === 'builtin' && (st.capabilities || []).includes('edit'));
        if (st.provider === 'builtin' && (st.capabilities || []).includes('definitions')) {
          const def = await fleetDefinitions(token, routeKey ? routeKey.split('/') : []);
          if (!alive) return;
          const runtime = new Map((st.engines || []).map((e) => [e.id, e]));
          setEngines((def.engines || []).map((e) => ({
            id: e.id,
            label: e.label || e.id,
            client: e.managed?.client || '',
            models: [...new Set([...(runtime.get(e.id)?.models || []), ...(e.managedInfo?.models || [])])].filter(Boolean),
            defaultModel: e.managed?.model || e.managedInfo?.defaultModel || '',
            policyDefault: e.managed?.permissionPolicy || (e.managed?.client ? (e.managed.client === 'claude' ? 'unsafe' : 'standard') : 'standard'),
          })));
        }
      } catch (_) { /* best-effort: degrada a lifecycle-only */ }
    })();
    return () => { alive = false; };
  }, [token, routeKey]);

  // Stato del form, inizializzato dalla cella corrente.
  const firstEngine = (cell?.engine) || engines[0]?.id || '';
  const rememberedModel = (eng) => (cell?.models && cell.models[eng]) || '';
  const rememberedPolicy = (eng) => {
    const r = cell?.permissionPolicies && cell.permissionPolicies[eng];
    if (r === 'standard' || r === 'unsafe') return r;
    const def = engines.find((e) => e.id === eng);
    return def ? def.policyDefault : 'standard';
  };
  const [engine, setEngine] = useState(firstEngine);
  const [model, setStateModel] = useState(cell?.model || '');
  const initialPolicy = cell?.permissionPolicy === 'standard' || cell?.permissionPolicy === 'unsafe'
    ? cell.permissionPolicy
    : (cell?.permissionPolicies?.[cell?.engine] || '');
  const [policy, setPolicy] = useState(initialPolicy);
  const [boot, setBoot] = useState(cell?.boot ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Quando arriva la lista engine (effetto asincrono), allinea engine/model/policy
  // se la cella non li aveva espliciti. Idempotente sui valori già scelti dall'utente.
  useEffect(() => {
    if (!engines.length) return;
    setEngine((cur) => cur || firstEngine);
    setStateModel((cur) => cur || rememberedModel(cell?.engine || firstEngine) || '');
    setPolicy((cur) => (cur === 'standard' || cur === 'unsafe') ? cur : rememberedPolicy(cell?.engine || firstEngine));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engines.length]);

  const selected = useMemo(() => engines.find((e) => e.id === engine) || null, [engines, engine]);
  const supportsUnsafe = !!(selected && ['claude', 'codex', 'codex-vl'].includes(selected.client));
  const isShell = selected?.client === 'shell';

  // Cambio engine: ricorda modello e policy dell'engine precedente (lo fa il
  // backend via permissionPolicies/models) e ripristina quelli ricordati per il nuovo.
  function chooseEngine(id) {
    setEngine(id);
    const def = engines.find((e) => e.id === id);
    setStateModel(rememberedModel(id) || def?.defaultModel || '');
    setPolicy(rememberedPolicy(id));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (isOn) {
        await onConfirm({ action: 'down', boot });
      } else {
        const effectivePolicy = policy === 'standard' || policy === 'unsafe'
          ? policy
          : (selected?.policyDefault || 'standard');
        await onConfirm({
          action: 'up',
          ...(canEdit ? {
            engine,
            model: model || '',
            ...(supportsUnsafe
              ? { permissionPolicy: effectivePolicy }
              : (selected?.client === 'pi' ? { permissionPolicy: 'standard' } : {})),
          } : {}),
          boot,
        });
      }
      onClose();
    } catch (er) { setErr(String((er && er.message) || er)); setBusy(false); }
  }

  return (
    <div className="nc-sheet-overlay nc-launch-overlay" onClick={onClose}>
      <form className="nc-sheet nc-power-sheet nc-launch-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="nc-sheet-head">
          <b>{cell?.cell}</b>
          <span className="nc-sheet-state">{isOn ? t('state-on') : t('state-off')}</span>
        </div>

        {isOn ? (
          <>
            <div className="nc-power-config">
              <span>{t('engine')}</span><b>{cell?.engine || '—'}</b>
              {cell?.model && <small>{t('model')}: {cell.model}</small>}
              <small>{t('power-on-hint')}</small>
            </div>
            <label className="nc-check">
              <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
              {t('remove-boot')}
            </label>
          </>
        ) : (
          <>
            {canEdit && engines.length > 0 ? (
              <div className="nc-launch-fields">
                <label className="nc-field">{t('engine')}
                  <select value={engine} onChange={(e) => chooseEngine(e.target.value)}>
                    {engines.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                  </select>
                </label>
                {!isShell && <label className="nc-field">{t('model')}
                  <input value={model} list="nc-launch-models" placeholder={t('model-default')} onChange={(e) => setStateModel(e.target.value)} />
                  <datalist id="nc-launch-models">{(selected?.models || []).map((m) => <option key={m} value={m} />)}</datalist>
                </label>}
                {supportsUnsafe ? (
                  <label className="nc-field">{t('permissions')}
                    <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
                      <option value="standard">{t('fleet-standard-permissions')}</option>
                      <option value="unsafe">{t('fleet-unsafe-permissions')}</option>
                    </select>
                  </label>
                ) : (
                  <small className="nc-note">{t('fleet-standard-permissions')}</small>
                )}
                {supportsUnsafe && policy === 'unsafe' && <small className="nc-err">{t('fleet-unsafe-warning')}</small>}
                <small className="nc-note">{isShell ? t('fleet-shell-launch-help') : t('launch-engine-help')}</small>
              </div>
            ) : (
              <div className="nc-power-config">
                <span>{t('engine')}</span><b>{cell?.engine || '—'}</b>
                {cell?.model && <small>{t('model')}: {cell.model}</small>}
                <small>{t('launch-unavailable-hint')}</small>
              </div>
            )}
            <label className="nc-check">
              <input type="checkbox" checked={boot} onChange={(e) => setBoot(e.target.checked)} />
              {t('boot-persist')}
            </label>
          </>
        )}

        {err && <div className="nc-err">{err}</div>}

        <div className="nc-sheet-actions">
          <button type="button" className="nc-btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="nc-btn primary" disabled={busy}>
            {isOn ? t('power-off') : t('save-and-start')}
          </button>
        </div>
      </form>
    </div>
  );
}
