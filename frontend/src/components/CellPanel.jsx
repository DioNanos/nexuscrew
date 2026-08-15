import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { requestPanelTicket, routeBase } from '../lib/api.js';
import './CellPanel.css';

// D8 — pannello per-cella, L'INGRESSO. Il vecchio flusso metteva il `panelUrl`
// grezzo nell'iframe: quell'URL è il loopback della macchina che ospita la
// cella, che il browser di chi guarda risolve sul PROPRIO — frame che non
// arriva, e il certificato self-signed del container come problema di chi
// guarda. Il flusso nuovo passa dalla NOSTRA origine:
//
//   1. la PWA (autenticata) chiede un TICKET per quella cella, sulla via
//      locale o federata a seconda del nodo che possiede la cella;
//   2. l'iframe punta a /panel/<cella><percorso>?ticket=…: la prima risposta
//      consuma il ticket e porta il cookie di visione, e da lì le sotto-risorse
//      passano col cookie. L'origine è la nostra: il certificato del container
//      smette di essere un problema del frame.
//
// Gli STATI sono cause con nome, perché l'azione di chi legge è diversa:
//   none          — nessun pannello configurato per la cella
//   requesting    — ticket in corso
//   ready         — iframe montato col ticket
//   not-granted   — il nodo NON concede il pannello a chi chiede (panelAccess):
//                   l'azione è concedere l'accesso sul nodo, non riprovare qui
//   denied        — ticket rifiutato (scaduto, già usato, non nostro): si
//                   riparte chiedendo un ticket NUOVO
//   no-panel      — la cella non ha più pannello (corsa col fleetStatus)
//   timeout       — il ticket non arriva entro il limite: causa deterministica
//                   (l'AbortController è solo del nostro timer)
//   unreachable   — la richiesta non arriva nemmeno all'origine nostra
//
// Limiti dichiarati (aggiornati al flusso nuovo):
// 1. Il ticket riuscito NON prova che il container serva: se il pannello muore
//    dopo l'ingresso, l'iframe mostra quello che il proxy risponde (502). Non
//    è osservabile da qui senza consumare un secondo biglietto; dichiarato.
// 2. La causa CERTIFICATO non esiste più per il frame: l'origine è la nostra e
//    verso il container parla il proxy. Per questo è sparito anche il bottone
//    «apri in una scheda» e l'auto-riprova al ritorno sulla scheda: curavano
//    un problema che questo flusso non ha.

export default function CellPanel({
  cellId, panelUrl, route = [], panelPort = 0, token, title, requestTimeoutMs = 4000,
}) {
  const [state, setState] = useState(cellId && token ? 'requesting' : 'none');
  const [frameUrl, setFrameUrl] = useState('');
  // Partita corrente: una risposta tardiva di una richiesta vecchia (cambio
  // cella o retry) non sovrascrive uno stato più fresco.
  const seq = useRef(0);

  const apri = useCallback(async () => {
    if (!cellId || !token || !panelUrl) { setState('none'); return; }
    const mio = (seq.current += 1);
    setState('requesting');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), requestTimeoutMs);
    try {
      const esito = await requestPanelTicket(token, route, cellId, { signal: ctl.signal });
      clearTimeout(timer);
      if (mio !== seq.current) return;
      if (esito.ok) {
        // Il percorso della pagina è quello del panelUrl (es. /vnc.html): il
        // proxy lo risolve sulla destinazione della cella.
        let page = '/';
        try { page = new URL(panelUrl).pathname || '/'; } catch (_) { /* panelUrl già validato a monte */ }
        // P0 sicurezza 2026-08-16: locale (route vuota) e porta pannello nota
        // → URL ASSOLUTO verso quell'origin, mai un path sotto la nostra. Una
        // porta diversa è ciò che rende l'origin diversa per il browser: un
        // path relativo, per quanto corretto, resterebbe same-origin col
        // control plane — esattamente il difetto che questo chiude. Remoto
        // (route non vuota) o panelPort assente (0, config non ancora
        // arrivata): via storica invariata — limite dichiarato, nessuna
        // negoziazione porta-pannello per nodo remoto in questo giro.
        const base = (!route.length && panelPort) ? `http://127.0.0.1:${panelPort}` : routeBase(route);
        setFrameUrl(`${base}/panel/${encodeURIComponent(cellId)}${page}?ticket=${encodeURIComponent(esito.ticket)}`);
        setState('ready');
      } else {
        // not-granted | no-panel | unauthorized | denied: cause con nome.
        setState(esito.cause);
      }
    } catch (err) {
      clearTimeout(timer);
      if (mio !== seq.current) return;
      // AbortError = il NOSTRO timer ha chiuso la partita: deterministico.
      setState(err && err.name === 'AbortError' ? 'timeout' : 'unreachable');
    }
  }, [cellId, panelUrl, route, panelPort, token, requestTimeoutMs]);

  useEffect(() => { apri(); }, [apri]);

  const msg = (key, azioni = true) => (
    <div className="nc-cellpanel nc-cellpanel-msg" role="status">
      <span>{t(key)}</span>
      {azioni && (
        <span className="nc-cellpanel-actions">
          <button type="button" title={t('panel-retry')} onClick={() => apri()}>{t('panel-retry')}</button>
        </span>
      )}
    </div>
  );

  if (state === 'none' || state === 'no-panel') return msg('panel-none', false);
  if (state === 'requesting') {
    return (
      <div className="nc-cellpanel nc-cellpanel-msg" role="status">
        <span>{t('panel-checking')}</span>
      </div>
    );
  }
  // Retry SOLO dove riprovare può cambiare l'esito. `not-granted` è l'unico
  // stato in cui non può: la decisione è di un ALTRO nodo, e il messaggio dice
  // esso stesso «non riprovando qui» — offrire il gesto che il testo esclude
  // manda l'utente a premere un bottone che non può funzionare.
  // Gli altri restano con Riprova, e non è una svista: `denied`/`unauthorized`
  // significano biglietto scaduto, e Riprova ne chiede uno NUOVO (è la strada
  // di recupero, coperta da test); `timeout`/`unreachable` dipendono da una
  // condizione che può essere già cambiata.
  if (state === 'not-granted') return msg('panel-not-granted', false);
  if (state === 'denied' || state === 'unauthorized') return msg('panel-denied');
  if (state === 'timeout') return msg('panel-timeout');
  if (state === 'unreachable') return msg('panel-unreachable');
  return (
    <iframe
      className="nc-cellpanel nc-cellpanel-frame"
      src={frameUrl}
      title={title || t('panel')}
      allowFullScreen
    />
  );
}
