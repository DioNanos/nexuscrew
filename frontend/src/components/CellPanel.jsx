import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import './CellPanel.css';

// D8 — pannello per-cella: renderizza `panelUrl` (contratto col backend: stringa
// per-cella, opzionale, gia' validata a monte come http/https su loopback).
// Questo componente CONSUMA il campo senza ri-validarlo; un valore assente o
// vuoto e' uno stato da rendere, non un caso da ignorare.
//
// MATRICE MISURATA il 2026-08-14 da dentro la PWA (secure context loopback),
// contro il servizio reale — non dedotta:
//
//   origine                             | fetch no-cors      | iframe `load`
//   ------------------------------------+--------------------+--------------
//   https://127.0.0.1:6901 (401, cert   | reject TypeError   | scatta
//   self-signed NON accettato)          |                    |
//   porta loopback chiusa               | reject TypeError   | scatte
//   http://127.0.0.1:41777 (vivo)       | resolve (5 ms)     | scatta
//
// Limiti dichiarati (misurati, non ipotizzati):
// 1. `load` NON distingue nulla: scatta anche su porta chiusa (il browser
//    carica la propria pagina d'errore nel frame). L'evento `error` non e'
//    mai scattato. L'unico segnale utilizzabile e' la probe fetch.
// 2. La probe che risolve prova raggiungibilita' + certificato accettato
//    (un 401 autonomico del servizio risolve comunque: l'auth resta al
//    contenuto, dentro il frame). La probe che fallisce copre DUE cause
//    distinte — servizio non raggiungibile e certificato non ancora
//    accettato — che dal codice della pagina sono INDISTINGUIBILI (stesso
//    TypeError opaco; la console del browser le distingue, ma la pagina non
//    puo' leggere i network error cross-origin). Il pannello non indovina:
//    rende un unico stato che nomina entrambe le cause e offre l'azione che
//    risolve l'una (accettare il certificato in una scheda) e diagnostica
//    l'altra.
// 3. Una probe verde NON prova che l'origine sia embeddabile (X-Frame-Options
//    / CSP frame-ancestors non sono osservabili da una risposta opaque):
//    l'iframe puo' restare bianco con probe verde. Non e' risolvibile dalla
//    PWA; dichiarato qui.

export default function CellPanel({ url, title, probeTimeoutMs = 4000 }) {
  const [state, setState] = useState(url ? 'checking' : 'none');
  // Contatore di probe: identifica l'ultima partita, cosi' una risposta tardiva
  // di una probe vecchia (dopo cambio url o retry) non sovrascrive uno stato piu' fresco.
  const probeSeq = useRef(0);

  const probe = useCallback(async () => {
    if (!url) { setState('none'); return; }
    const seq = (probeSeq.current += 1);
    setState('checking');
    let timer = null;
    try {
      const ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(), probeTimeoutMs);
      await fetch(url, { mode: 'no-cors', signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (seq === probeSeq.current) setState('ready');
    } catch (_) {
      if (timer) clearTimeout(timer);
      if (seq === probeSeq.current) setState('unreachable');
    }
  }, [url, probeTimeoutMs]);

  useEffect(() => { probe(); }, [probe]);

  // Auto-riproba al ritorno sulla scheda: e' il flusso reale del caso
  // certificato (l'operatore apre l'URL in una scheda, accetta, torna).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') probe();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [probe]);

  if (state === 'none') {
    return (
      <div className="nc-cellpanel nc-cellpanel-msg" role="status">
        <span>{t('panel-none')}</span>
      </div>
    );
  }
  if (state === 'checking') {
    return (
      <div className="nc-cellpanel nc-cellpanel-msg" role="status">
        <span>{t('panel-checking')}</span>
      </div>
    );
  }
  if (state === 'unreachable') {
    return (
      <div className="nc-cellpanel nc-cellpanel-msg" role="status">
        <span>{t('panel-unreachable')}</span>
        <span className="nc-cellpanel-actions">
          <button type="button" title={t('panel-open')} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>{t('panel-open')}</button>
          <button type="button" title={t('panel-retry')} onClick={() => probe()}>{t('panel-retry')}</button>
        </span>
      </div>
    );
  }
  return (
    <iframe
      className="nc-cellpanel nc-cellpanel-frame"
      src={url}
      title={title || t('panel')}
      allowFullScreen
    />
  );
}
