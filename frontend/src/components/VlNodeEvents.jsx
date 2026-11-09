import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { getVlNodeEvents } from '../lib/api.js';
import { raggruppaEventi } from '../lib/vl-event-rows.js';

// La conversazione del nodo VL, in SOLA LETTURA.
//
// Il ring vive nella memoria dell'owner e si perde al restart: qui non c'e'
// storia, c'e' quello che sta succedendo. La copia durevole e' il journal sul
// device (contratto passo 2, punto 5) — quindi un riquadro vuoto NON significa
// "non e' successo niente", e infatti lo diciamo.
//
// Questo canale non manda nulla al device e non deve mai diventare un canale
// comandi: i comandi hanno la loro route, con le loro capabilities.

const POLL_MS = 2_000;

function labelOf(event) {
  if (event.kind === 'gap') return `${t('vl-events-gap')} ${event.count || '?'}`;
  if (event.kind === 'truncate') return t('vl-events-truncated');
  if (event.kind === 'turn_end') return t('vl-events-turn-end');
  if (event.kind === 'done') return t('vl-events-done');
  if (event.kind === 'writer_epoch') return t('vl-events-writer-epoch');
  if (event.kind === 'tool_start') return `${t('vl-events-tool')} ${event.name || ''}`.trim();
  if (event.kind === 'tool_end') {
    const suffix = event.isError ? t('vl-events-tool-failed') : t('vl-events-tool-ok');
    return `${t('vl-events-tool')} ${event.name || ''} — ${suffix}`.trim();
  }
  if (event.kind === 'usage') return event.text || t('vl-events-usage');
  return event.text || '';
}

export default function VlNodeEvents({ token, nodeId, route = [], sessionKey = '', sospeso = false }) {
  const [events, setEvents] = useState([]);
  const [failed, setFailed] = useState(false);
  const cursor = useRef(0);
  // La richiesta in volo, se c'è (un oggetto per richiesta: identifica il giro
  // anche quando l'identità della sessione cambia sotto i piedi).
  const inVolo = useRef(null);

  // Il confine di sessione: identità del nodo e generazione. Cambia QUESTO, e
  // solo questo, la conversazione riparte da zero — un cursore vecchio
  // mostrerebbe eventi di un'altra sessione. La freschezza del peer non è un
  // confine di sessione: passare a «non corrente» la sospende, non la azzera.
  useEffect(() => {
    cursor.current = 0;
    inVolo.current = null;
    setEvents([]);
    setFailed(false);
  }, [token, nodeId, JSON.stringify(route), sessionKey]);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      // Un solo poll in volo: su un collegamento lento il periodo scade prima
      // della risposta, e un secondo poll partirebbe col cursore VECCHIO —
      // due risposte identiche, lista duplicata.
      if (inVolo.current) return;
      const mia = {};
      inVolo.current = mia;
      try {
        const out = await getVlNodeEvents(token, nodeId, cursor.current, route);
        // Richiesta superata (l'identità della sessione è cambiata mentre era
        // in volo, o l'effetto è chiuso): la sua risposta non appartiene più a
        // quello che la vista sta mostrando.
        if (!alive || inVolo.current !== mia) return;
        setFailed(false);
        const incoming = Array.isArray(out?.events) ? out.events : [];
        // Idempotente per seq: il filtro `after` del server e' un'ottimizzazione,
        // non una garanzia — una consegna ripetuta non deve appendersi due volte.
        const fresh = incoming.filter((e) => Number.isSafeInteger(e?.seq) && e.seq > cursor.current);
        if (fresh.length) {
          // Append, mai sostituzione: un giro a vuoto non deve cancellare
          // quello che l'operatore sta leggendo.
          setEvents((prev) => prev.concat(fresh).slice(-500));
          cursor.current = fresh[fresh.length - 1].seq;
        }
        if (Number.isSafeInteger(out?.cursor) && out.cursor > cursor.current) cursor.current = out.cursor;
      } catch (_) {
        // Rete giu' o owner irraggiungibile: si segnala, NON si svuota. Un
        // riquadro che si azzera da solo racconta una bugia sullo stato.
        if (alive && inVolo.current === mia) setFailed(true);
      } finally {
        if (inVolo.current === mia) inVolo.current = null;
      }
    };

    // `tick` gestisce gia' i propri errori, ma la promise che restituisce non
    // e' attesa da nessuno: senza questo catch difensivo un rigetto imprevisto
    // diventerebbe una unhandled rejection invece di un riquadro "non
    // aggiornato".
    const safeTick = () => { tick().catch(() => {}); };
    // Ultimo dato noto: con il peer non corrente si legge UNA volta — per
    // avere qualcosa da mostrare — e non si polla. Il primo giro non e' un
    // poll: e' la lettura che rende possibile «l'ultimo dato noto». Gli eventi
    // gia' letti e il cursore restano: si sospende la lettura, non si cancella
    // il dato.
    if (sospeso) {
      safeTick();
      return () => { alive = false; };
    }
    safeTick();
    const timer = setInterval(safeTick, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [token, nodeId, JSON.stringify(route), sessionKey, sospeso]);

  return (
    <div className="nc-vl-events">
      {failed && <div className="nc-set-hint nc-vl-events-stale">{t('vl-events-stale')}</div>}
      {events.length === 0 && !failed && (
        <small className="nc-set-hint" data-testid="vl-events-empty">{t('vl-events-empty')}</small>
      )}
      {events.length > 0 && (
        <ol className="nc-vl-events-list">
          {raggruppaEventi(events).map((riga) => (
            riga.type === 'event' ? (
              <li
                key={`${riga.event.seq}-${riga.event.kind}`}
                data-testid={`vl-ev-${riga.event.seq}`}
                className={`nc-vl-ev nc-vl-ev-${riga.event.kind}${riga.event.isError ? ' error' : ''}${riga.event.kind === 'gap' ? ' gap' : ''}`}
              >
                {labelOf(riga.event)}
              </li>
            ) : (
              // I frammenti contigui sono UNA riga: il testo che il device ha
              // mandato, non una parola per elemento.
              <li
                key={`${riga.seq}-${riga.seqFine}`}
                data-testid={`vl-ev-${riga.seq}`}
                className={`nc-vl-ev nc-vl-ev-${riga.type}`}
              >
                {riga.testo}
              </li>
            )
          ))}
        </ol>
      )}
    </div>
  );
}
