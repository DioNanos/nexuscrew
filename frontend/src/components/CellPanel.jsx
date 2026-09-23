import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { requestPanelTicket, routeBase, setAiDesktop } from '../lib/api.js';
import { DESKTOP_PANEL_PORT } from '../lib/panel-port.js';
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
//   ready         — iframe MONTATO col ticket, carico in corso: lo dice un
//                   hint visibile (R20: prima il componente dichiarava pronto
//                   il frame e poi non guardava più nulla)
//   loaded        — il frame ha sparato `load`: qualcosa HA caricato. DICHIARATO:
//                   `load` scatta anche su una pagina d'errore (401/502 serviti
//                   come pagina), quindi prova che il frame è arrivato a una
//                   risposta, NON che il pannello sia vivo
//   frame-error   — il frame ha sparato `error`: carico fallito a livello di
//                   risorsa (destinazione irraggiungibile, biglietto rifiutato
//                   prima di qualunque risposta): azione Riprova con biglietto NUOVO
//   not-granted   — il nodo NON concede il pannello a chi chiede (panelAccess):
//                   l'azione è concedere l'accesso sul nodo, non riprovare qui
//   denied        — ticket rifiutato (scaduto, già usato, non nostro): si
//                   riparte chiedendo un ticket NUOVO
//   no-panel      — la cella non ha più pannello (corsa col fleetStatus)
//   timeout       — il ticket non arriva entro il limite: causa deterministica
//                   (l'AbortController è solo del nostro timer)
//   unreachable   — la richiesta non arriva nemmeno all'origine nostra
//
// Limiti dichiarati (aggiornati al flusso nuovo e a R20):
// 1. Il ticket riuscito NON prova che il container serva: se il pannello muore
//    dopo l'ingresso, l'iframe mostra quello che il proxy risponde (502) — e
//    quel 502 è una PAGINA, quindi spara `load`, non `error`: lo stato sarà
//    `loaded` e il difetto resta visibile solo DENTRO il frame. Distinguere
//    «pagina servita» da «pannello vivo» richiederebbe un secondo biglietto
//    (monouso, 30 s di vita): non si fa; dichiarato. Quel che R20 chiude è il
//    silenzio: prima non c'era NESSUNO stato dopo il ticket, ora il carico del
//    frame è osservato (load/error) e il fallimento a livello di risorsa ha un
//    nome e un'azione.
// 2. La causa CERTIFICATO non esiste più per il frame: l'origine è la nostra e
//    verso il container parla il proxy. Per questo è sparito anche il bottone
//    «apri in una scheda» e l'auto-riprova al ritorno sulla scheda: curavano
//    un problema che questo flusso non ha.

export default function CellPanel({
  cellId, panelUrl, route = [], panelPort = 0, token, title, requestTimeoutMs = 4000,
}) {
  const [state, setState] = useState(cellId && token ? 'requesting' : 'none');
  const [frameUrl, setFrameUrl] = useState('');
  // `route` è un ARRAY, quindi una prop nuova a ogni render del padre anche
  // quando il contenuto è identico — e il padre ri-renderizza di continuo, per
  // il polling della flotta. Messo direttamente fra le dipendenze faceva
  // ricreare `apri` a ogni giro, l'effetto chiedeva un biglietto nuovo e
  // l'iframe si RIMONTAVA: il pannello si ricaricava senza sosta e chi guarda
  // non faceva in tempo a interagirci — un login dentro il frame non arrivava
  // mai a compimento. La chiave è sul CONTENUTO: l'identità cambia solo quando
  // la route cambia davvero. `\u0000` come separatore perché non può comparire
  // in un nome di nodo, quindi ['a','b'] e ['a\u0000b'] restano distinti.
  const routeKey = Array.isArray(route) ? route.join('\u0000') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rotta = useMemo(() => (Array.isArray(route) ? route : []), [routeKey]);
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
      const esito = await requestPanelTicket(token, rotta, cellId, { signal: ctl.signal });
      clearTimeout(timer);
      if (mio !== seq.current) return;
      if (esito.ok) {
        // Il percorso della pagina è quello del panelUrl (es. /vnc.html): il
        // proxy lo risolve sulla destinazione della cella.
        let page = '/';
        try { page = new URL(panelUrl).pathname || '/'; } catch (_) { /* panelUrl già validato a monte */ }
        // P0 sicurezza 2026-08-16: porta pannello PER QUESTA CELLA nota (la
        // prop arriva già risolta: porta del nodo locale per le celle locali,
        // porta inoltrata del nodo remoto per le remote — v. lib/panel-port)
        // → URL ASSOLUTO verso quell'origin, mai un path sotto la nostra. Una
        // porta diversa è ciò che rende l'origin diversa per il browser: un
        // path relativo, per quanto corretto, resterebbe same-origin col
        // control plane — esattamente il difetto che questo chiude. panelPort
        // assente (0: config non ancora arrivata, o nodo remoto senza porta
        // negoziata — un peer accoppiato prima): via storica invariata.
        const base = panelPort ? `http://127.0.0.1:${panelPort}` : routeBase(rotta);
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
  }, [cellId, panelUrl, rotta, panelPort, token, requestTimeoutMs]);

  // R20: il biglietto riuscita NON chiude la partita — il suo CONSUMO può
  // ancora fallire dentro l'iframe (scaduto: 30 s di vita; già usato: monouso;
  // destinazione morta). Gli eventi load/error sono il canale che l'iframe
  // offre già: non se ne inventa uno nuovo. I passaggi di stato sono filtrati
  // dallo stato CORRENTE: un evento tardivo di una navigazione vecchia non
  // riscrive uno stato più fresco (stessa disciplina di seq per il ticket).
  const onFrameLoad = useCallback(() => {
    // `load` scatta ANCHE sulle pagine d'errore: qui si registra solo che il
    // frame è arrivato a una risposta — non si promette che il pannello viva.
    setState((s) => (s === 'ready' ? 'loaded' : s));
  }, []);
  const onFrameError = useCallback(() => {
    setState((s) => (s === 'ready' || s === 'loaded' ? 'frame-error' : s));
  }, []);
  // Gli handler si legano DIRETTI sull'elemento, non come prop React: `error`
  // non bubbla e React non lo riceve sull'iframe (in jsdom il test restava
  // verde sul frame bianco — lo stesso silenzio del difetto, nel test). Il
  // ref lega entrambi, per simmetria e perché load resti deterministicamente
  // osservato comunque.
  const frameRef = useRef(null);
  const legaFrame = useCallback((el) => {
    if (!el) return;
    frameRef.current = el;
    el.onload = onFrameLoad;
    el.onerror = onFrameError;
  }, [onFrameLoad, onFrameError]);

  useEffect(() => { apri(); }, [apri]);

  // Il pannello del desktop grafico: la porta KasmVNC del container. Solo per
  // lui «non raggiungibile» ha anche l'azione «Avvia» — gli altri pannelli non
  // hanno un container da riaccendere. E solo per il pannello del nodo
  // LOCALE: una cella remota non riceve comandi che accendono container di un
  // altro nodo.
  const isDesktop = useMemo(() => {
    try { return Number(new URL(panelUrl).port) === DESKTOP_PANEL_PORT; } catch (_) { return false; }
  }, [panelUrl]);
  const isDesktopLocale = isDesktop && rotta.length === 0;
  const [avvioBusy, setAvvioBusy] = useState(false);
  const [avvioErrore, setAvvioErrore] = useState('');
  // Il proxy, quando il pannello non risponde, serve una PAGINA (non un JSON
  // invisibile) che annuncia sé stessa col postMessage: il frame che avrebbe
  // finito in «loaded» su una risposta 502 arriva invece qui, dove la causa ha
  // un nome e l'azione giusta. Il mittente è fidato a TRE condizioni, perché
  // qualunque frame della pagina potrebbe impersonare l'errore: è il frame
  // ATTIVO (source), naviga alla SUA origine dichiarata, e porta il tipo
  // atteso — il testo del messaggio è fisso, il contenuto non è fiducia.
  useEffect(() => {
    const onMessage = (event) => {
      const frameEl = frameRef.current;
      if (!frameEl || !frameEl.contentWindow || event.source !== frameEl.contentWindow) return;
      let origine = null;
      try { origine = new URL(frameUrl, window.location.href).origin; } catch (_) { return; }
      if (!origine || event.origin !== origine) return;
      if (!event.data || event.data.type !== 'nc-panel-unreachable') return;
      setState((s) => (s === 'ready' || s === 'loaded' ? 'unreachable' : s));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameUrl]);
  // «Avvia»: spegnere il desktop è una spunta in Impostazioni, riaccenderlo da
  // qui è la stessa decisione un click prima. L'errore del POST si mostra, non
  // si scarta: riprovare alla cieca ripromette lo stesso fallimento. Poi il
  // frame riparte da un biglietto nuovo.
  const avviaDesktop = useCallback(async () => {
    if (!token || avvioBusy) return;
    setAvvioBusy(true); setAvvioErrore('');
    // Se l'avvio non riesce NON si riparte: riaprire subito mostrerebbe di
    // nuovo «non raggiungibile» cancellando la causa del fallimento, e chi
    // guarda crederebbe che il click non abbia fatto nulla.
    let fallito = false;
    try {
      const j = await setAiDesktop(token, true);
      if (j && j.ok === false) { setAvvioErrore(j.error || 'comando fallito'); fallito = true; }
    } catch (e) { setAvvioErrore(String((e && e.message) || e)); fallito = true; }
    setAvvioBusy(false);
    if (!fallito) apri();
  }, [token, avvioBusy, apri]);

  const msg = (key, azioni = true, extra = null) => (
    <div className="nc-cellpanel nc-cellpanel-msg" role="status">
      <span>{t(key)}</span>
      {azioni && (
        <span className="nc-cellpanel-actions">
          {extra}
          <button type="button" title={t('panel-retry')} onClick={() => apri()}>{t('panel-retry')}</button>
        </span>
      )}
    </div>
  );

  // Per il desktop LOCALE, «non raggiungibile» e «frame fallito» hanno anche
  // l'azione di riaccendere il container (la spunta di Impostazioni, un click
  // prima); per una cella remota resta solo Riprova.
  const bottoneAvvia = isDesktopLocale ? (
    <button type="button" disabled={avvioBusy} onClick={avviaDesktop}>{t('panel-start-desktop')}</button>
  ) : null;

  if (state === 'none' || state === 'no-panel') return msg('panel-none', false);
  if (state === 'requesting') {
    return (
      <div className="nc-cellpanel nc-cellpanel-msg" role="status">
        <span>{t('panel-checking')}</span>
      </div>
    );
  }
  // Retry SOLO dove riprovare può cambiare l'esito. La distinzione non è fra
  // «rifiutato» e «non rifiutato»: è fra una condizione che può essere già
  // cambiata e una che dipende da una decisione altrove.
  //
  // Senza Riprova, perché il gesto non può riuscire: `not-granted` (il permesso
  // si concede sul nodo che possiede la cella), `node-refused` (quel nodo
  // rifiuta ogni mutazione, per esempio in sola lettura) e `unauthorized` (la
  // credenziale locale non è valida — la si ripara altrove, non riprovando).
  //
  // Con Riprova: `denied` è ciò che resta, ed è transitorio — biglietto non più
  // valido, o un errore passeggero del nodo — quindi chiederne uno nuovo è la
  // strada di recupero; `timeout`/`unreachable` dipendono da una condizione che
  // nel frattempo può essere cambiata.
  if (state === 'not-granted') return msg('panel-not-granted', false);
  if (state === 'node-refused') return msg('panel-node-refused', false);
  if (state === 'unauthorized') return msg('panel-unauthorized', false);
  if (state === 'denied') return msg('panel-denied');
  if (state === 'timeout') return msg('panel-timeout');
  if (state === 'unreachable') {
    return (
      <div className="nc-cellpanel nc-cellpanel-msg" role="status">
        <span>{t('panel-unreachable')}{avvioErrore ? ` — ${avvioErrore}` : ''}</span>
        <span className="nc-cellpanel-actions">
          {bottoneAvvia}
          <button type="button" title={t('panel-retry')} onClick={() => apri()}>{t('panel-retry')}</button>
        </span>
      </div>
    );
  }
  // R20: il consumo del biglietto è fallito a livello di risorsa: il frame è
  // bianco e prima NESSUNO stato lo diceva. Ora ha nome e azione (biglietto
  // nuovo), come `denied` — ma la causa è diversa: `denied` è l'EMISSIONE
  // rifiutata, questa è la navigazione del frame fallita DOPO un biglietto ok.
  if (state === 'frame-error') return msg('panel-frame-error', true, bottoneAvvia);
  // ready | loaded: il frame resta montato. L'hint visibile dice «montato,
  // carico in corso» e sparisce al load — la distinzione fra i due stati non
  // resta chiusa nel componente: chi guarda la vede. data-frame-state la
  // espone anche a chi prova il DOM.
  return (
    <>
      {state === 'ready' && (
        <div className="nc-cellpanel-loading" role="status">{t('panel-frame-loading')}</div>
      )}
      <iframe
        ref={legaFrame}
        className="nc-cellpanel nc-cellpanel-frame"
        data-frame-state={state}
        src={frameUrl}
        title={title || t('panel')}
        allowFullScreen
      />
    </>
  );
}
