import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n.js';
import { fleetLaunchState, fleetReconcile } from '../../lib/api.js';

// «Verifica pratica di lancio» — azione SECONDARIA e locale: un record GIA'
// MATERIALIZZATO, con il supervisore provato morto, bloccato perche'
// l'identita' del SERVER originario non e' verificabile. L'operatore, dopo il
// controllo sul nodo proprietario, archivia QUELLA pratica: non ferma e non
// avvia niente. Il contesto {cella, launchId, token} e' congelato: al cambio
// vista, cella, lancio o credenziale la risposta tardiva non entra e la
// conferma non parte. Una POST che scade NON si ripete: si rilegge lo stato.
export default function LaunchAttestPanel({ cell, token }) {
  const cella = cell && typeof cell.cell === 'string' ? cell.cell : '';
  const launchIdVista = (cell && cell.launchId) || null;
  const [open, setOpen] = useState(false);
  const [fase, setFase] = useState('idle');
  const [ev, setEv] = useState(null);
  const [errore, setErrore] = useState(null);
  const [esito, setEsito] = useState(null);
  const [nome, setNome] = useState('');
  const [motivo, setMotivo] = useState('');
  const [giro, setGiro] = useState(0);
  const seq = useRef(0);
  const vivo = useRef(true);

  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);

  // Al cambio di contesto niente resta in piedi, risposte in volo comprese.
  useEffect(() => {
    seq.current += 1;
    setEv(null); setErrore(null); setEsito(null); setNome(''); setMotivo('');
    setFase('idle');
  }, [token, cella, launchIdVista]);

  // All'apertura: stato e anteprima; `seq` scarta le risposte gia' chiuse.
  useEffect(() => {
    if (!open || !token || !cella) return undefined;
    const mia = ++seq.current;
    let annullato = false;
    (async () => {
      setFase('loading'); setErrore(null); setEsito(null);
      try {
        const stato = await fleetLaunchState(token, cella);
        if (annullato || !vivo.current || mia !== seq.current) return;
        if (!stato || !stato.launchId) { setEv({ stato, anteprima: null }); setFase('ready'); return; }
        const anteprima = await fleetReconcile(token, {
          cell: cella, launchId: stato.launchId, attest: { azione: 'anteprima' },
        });
        if (annullato || !vivo.current || mia !== seq.current) return;
        setEv({ stato, anteprima });
        setFase('ready');
      } catch (e) {
        if (annullato || !vivo.current || mia !== seq.current) return;
        setErrore(String((e && e.message) || e));
        setFase('error');
      }
    })();
    return () => { annullato = true; };
  }, [open, token, cella, launchIdVista, giro]);

  const elig = ev && ev.anteprima ? ev.anteprima.eligibleAttestation : null;
  const idoneo = !!(elig && elig.variante === 'archivia-identita-incerta');
  const nomeOk = nome.trim() === cella && cella !== '';
  const motivoOk = motivo.trim().length > 0;
  const puoConfermare = idoneo && nomeOk && motivoOk && fase === 'ready';

  async function conferma() {
    if (!puoConfermare) return;
    const mia = seq.current;
    setFase('sending'); setErrore(null);
    let r = null;
    try {
      r = await fleetReconcile(token, {
        cell: cella,
        launchId: ev.stato.launchId,
        attest: {
          azione: 'archivia-identita-incerta',
          conferma: {
            recordSha256: ev.anteprima.recordSha256,
            bootId: ev.anteprima.bootId,
            ownerInstanceId: ev.anteprima.ownerInstanceId,
            hostAssente: elig.atteso.hostAssente,
            motivo: motivo.trim(),
            previewToken: ev.anteprima.previewToken,
          },
        },
      });
    } catch (e) {
      if (!vivo.current || mia !== seq.current) return;
      // C2 — ambigui: nessuna risposta, 408 e 5xx (il server può aver scritto e
      // non risposto) => incerto, e l'unica azione è rileggere. I rifiuti
      // definitivi restano visibili e non fanno tornare `ready` in silenzio.
      const incerta = !e || typeof e.status !== 'number' || e.status === 408 || e.status >= 500;
      setErrore(incerta ? t('launch-attest-timeout') : String((e && e.message) || e));
      setFase(incerta ? 'incerto' : 'ready');
      return;
    }
    if (!vivo.current || mia !== seq.current) return;
    // A6 — anteprima scaduta: si rilegge, non si riprova con lo stesso token.
    if (r && r.code === 'PREVIEW_STALE') {
      setErrore(t('launch-attest-stale'));
      setFase('incerto');
      return;
    }
    setEsito(r || null);
    setFase('done');
  }

  function chiudi() {
    // A5 — chiudere durante `sending` invalida SUBITO la sequenza: la risposta
    // della vista chiusa non entra piu'.
    seq.current += 1;
    setFase('idle');
    setOpen(false);
  }

  function rileggi() {
    // Un giro NUOVO di letture sullo stesso contesto: nessun reinvio.
    setEv(null); setEsito(null); setErrore(null); setNome(''); setMotivo(''); setFase('idle');
    setGiro((n) => n + 1);
  }

  if (!cella) return null;

  if (!open) {
    return (
      <button type="button" className="nc-btn ghost nc-attest-open" onClick={() => setOpen(true)}>
        {t('launch-attest-open')}
      </button>
    );
  }

  const v = elig ? elig.evidenze : null;
  const sonda = v && v.sonda ? v.sonda.esito : (ev && ev.anteprima ? 'ignota' : null);
  const motivi = ev && ev.anteprima && ev.anteprima.motiviRifiuto ? ev.anteprima.motiviRifiuto : [];
  const archiviata = fase === 'done' && esito && esito.outcome === 'reconciled';

  return (
    <div className="nc-attest-panel" role="group" aria-label={t('launch-attest-title')}>
      <div className="nc-attest-head">
        <b>{t('launch-attest-title')}</b>
        <button type="button" className="nc-btn ghost" onClick={chiudi}>{t('cancel')}</button>
      </div>
      <small className="nc-note">{t('launch-attest-hint')}</small>

      <div className="nc-power-config nc-attest-facts">
        <span>{t('launch-attest-owner')}</span>
        <b>{ev && ev.anteprima ? ev.anteprima.ownerInstanceId : '—'}</b>
        <span>{t('launch-attest-cell')}</span>
        <b>{cella}</b>
        <span>{t('launch-attest-session')}</span>
        <b>{(elig && elig.sessione) || '—'}</b>
        <span>{t('launch-attest-launch')}</span>
        <b>{(ev && ev.stato && ev.stato.launchId) || '—'}</b>
        <span>{t('launch-attest-now')}</span>
        <b>{(elig && elig.ora) || '—'}</b>
      </div>

      {fase === 'loading' && <small className="nc-note">{t('launch-attest-loading')}</small>}
      {/* C2 — un rifiuto definitivo resta visibile anche tornando a `ready`. */}
      {(fase === 'error' || (fase === 'ready' && errore)) && (
        <div className="nc-err">{errore || t('launch-attest-unknown')}</div>
      )}

      {fase !== 'loading' && ev && !(ev.stato && ev.stato.launchId) && (
        <small className="nc-note">{t('launch-attest-none')}</small>
      )}

      {/* Un nodo con la via attestata spenta risponde `not-enabled`, una
          pratica chiusa `not-needed`: sono esiti, non silenzi. */}
      {ev && ev.anteprima && ev.anteprima.outcome && ev.anteprima.outcome !== 'anteprima' && (
        <small className="nc-note">{t('launch-attest-result')}: {ev.anteprima.outcome}</small>
      )}

      {ev && ev.anteprima && (
        <div className="nc-power-config nc-attest-evidence">
          <span>{t('launch-attest-evidence')}</span>
          <b>{(ev.anteprima.classification || '—')}</b>
          <small>
            {t('launch-attest-namesake')}: {ev.anteprima.evidenze && ev.anteprima.evidenze.omonima === 'present'
              ? t('launch-attest-present')
              : ev.anteprima.evidenze && ev.anteprima.evidenze.omonima === 'absent'
                ? t('launch-attest-absent-current') : t('launch-attest-unknown')}
          </small>
          <small>
            {t('launch-attest-ids')}: {sonda === 'presente' ? t('launch-attest-present')
              : sonda === 'assente' ? t('launch-attest-absent-current') : t('launch-attest-unknown')}
          </small>
          <small>{t('launch-attest-server')}: {t('launch-attest-unknown')}</small>
          <small>
            {t('launch-attest-supervisor')}: {(v && v.supervisore) || (ev.anteprima.evidenze && ev.anteprima.evidenze.supervisore) || '—'}
            {' · '}{t('launch-attest-lease')}: {(v && v.lease) || (ev.anteprima.evidenze && ev.anteprima.evidenze.lease) || '—'}
            {' · '}{t('launch-attest-host')}: {(v && v.host) || '—'}
          </small>
          {!idoneo && motivi.length > 0 && (
            <small className="nc-err" data-testid="nc-attest-reasons">
              {t('launch-attest-reasons')}: {motivi.join(', ')}
            </small>
          )}
        </div>
      )}

      {idoneo && (fase === 'ready' || fase === 'sending') && (
        <>
          <small className="nc-note">{t('launch-attest-check-owner')}</small>
          <label className="nc-field">{t('launch-attest-name')}
            <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder={cella} />
          </label>
          <label className="nc-field">{t('launch-attest-motivo')}
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </label>
          {!nomeOk || !motivoOk ? <small className="nc-note">{t('launch-attest-mismatch')}</small> : null}
          <button type="button" className="nc-btn" disabled={!puoConfermare} onClick={conferma}>
            {fase === 'sending' ? t('launch-attest-busy') : t('launch-attest-confirm')}
          </button>
        </>
      )}

      {fase === 'incerto' && errore && (
        <>
          <div className="nc-err">{errore}</div>
          <button type="button" className="nc-btn ghost" onClick={rileggi}>{t('launch-attest-refresh')}</button>
        </>
      )}

      {fase === 'done' && (
        <div className={archiviata ? 'nc-note' : 'nc-err'}>
          {archiviata
            ? `${t('launch-attest-done')}${esito && esito.provaOperatore ? ` (${esito.provaOperatore.slice(0, 12)}…)` : ''}`
            : `${t('launch-attest-blocked')}: ${(esito && (esito.code || esito.outcome)) || '—'}`}
        </div>
      )}
    </div>
  );
}
