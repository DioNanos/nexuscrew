import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import { getVlNodeEvents } from '../lib/api.js';

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

export default function VlNodeEvents({ token, nodeId, route = [] }) {
  const [events, setEvents] = useState([]);
  const [failed, setFailed] = useState(false);
  const cursor = useRef(0);

  useEffect(() => {
    let alive = true;
    cursor.current = 0;
    setEvents([]);

    const tick = async () => {
      try {
        const out = await getVlNodeEvents(token, nodeId, cursor.current, route);
        if (!alive) return;
        setFailed(false);
        const incoming = Array.isArray(out?.events) ? out.events : [];
        if (incoming.length) {
          // Append, mai sostituzione: un giro a vuoto non deve cancellare
          // quello che l'operatore sta leggendo.
          setEvents((prev) => prev.concat(incoming).slice(-500));
          cursor.current = incoming[incoming.length - 1].seq;
        }
        if (Number.isSafeInteger(out?.cursor) && out.cursor > cursor.current) cursor.current = out.cursor;
      } catch (_) {
        // Rete giu' o owner irraggiungibile: si segnala, NON si svuota. Un
        // riquadro che si azzera da solo racconta una bugia sullo stato.
        if (alive) setFailed(true);
      }
    };

    // `tick` gestisce gia' i propri errori, ma la promise che restituisce non
    // e' attesa da nessuno: senza questo catch difensivo un rigetto imprevisto
    // diventerebbe una unhandled rejection invece di un riquadro "non
    // aggiornato".
    const safeTick = () => { tick().catch(() => {}); };
    safeTick();
    const timer = setInterval(safeTick, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [token, nodeId, JSON.stringify(route)]);

  return (
    <div className="nc-vl-events">
      {failed && <div className="nc-set-hint nc-vl-events-stale">{t('vl-events-stale')}</div>}
      {events.length === 0 && !failed && (
        <small className="nc-set-hint" data-testid="vl-events-empty">{t('vl-events-empty')}</small>
      )}
      {events.length > 0 && (
        <ol className="nc-vl-events-list">
          {events.map((event) => (
            <li
              key={`${event.seq}-${event.kind}`}
              data-testid={`vl-ev-${event.seq}`}
              className={`nc-vl-ev nc-vl-ev-${event.kind}${event.isError ? ' error' : ''}${event.kind === 'gap' ? ' gap' : ''}`}
            >
              {labelOf(event)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
