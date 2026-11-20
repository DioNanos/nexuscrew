'use strict';

// Contratto redatto della diagnostica del lease lato servizio.
//
// Il sottosistema lease riceve un sink ESPLICITO (cfg.leaseLog), non il cfg.log
// globale: chi scrive sceglie cosa osservare, non riceve per errore l'output
// di tutti i componenti. Il sink riceve righe gia' redatte da questo modulo:
// eventi a enum chiusa e, per ogni evento, solo i campi della whitelist, con
// valori validati a charset chiuso. Nessun proof, firma, chiave, token, env,
// argv o body attraversa questo confine: un campo fuori whitelist e' scartato,
// un valore sporco diventa "redacted", non viene mai propagato.
//
// Righe limitate: le transizioni base (lease-start, reconnected, terminal)
// scrivono una riga ciascuna; gli errori (eof, reconnect-start, denied,
// commit-failed, transport-error, timeout) sono coalesciti per chiave
// evento+cella+motivo dentro una finestra, cosi' un burst non diventa un
// log di heartbeat. Il dettaglio per tentativo (attempt) esiste solo con
// diagnostica esplicita (detail) ed e' comunque bounded.
//
// Un sink che lancia non cambia l'esito del lease: ogni scrittura e' assorbita.

const fs = require('node:fs');

const LEASE_LOG_EVENTS = Object.freeze([
  'lease-start', 'eof', 'reconnect-start', 'attempt', 'transport-error',
  'timeout', 'denied', 'commit-failed', 'reconnected', 'terminal',
]);

// Eventi coalesciti per motivo: ripetizioni dentro la finestra = una riga.
const COALESCED_EVENTS = new Set(['eof', 'reconnect-start', 'denied', 'commit-failed', 'transport-error', 'timeout']);

const COALESCE_MS_DEFAULT = 10_000;
const MAX_DETAIL_LINES_DEFAULT = 64;

// Whitelist dei campi: nome -> validazione. Campi non listati: mai nell'output.
const TOKEN_RE = (max) => new RegExp(`^[A-Za-z0-9._-]{1,${max}}$`);
const CELL_RE = /^[A-Za-z0-9._-]{1,64}$/;

function intOrDrop(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function natIntOrDrop(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tokenOrRedacted(re) {
  return (value) => (typeof value === 'string' && re.test(value) ? value : 'redacted');
}

const FIELD_SPECS = Object.freeze({
  ts: intOrDrop,
  mono: intOrDrop,
  cell: tokenOrRedacted(CELL_RE),
  episode: tokenOrRedacted(TOKEN_RE(48)),
  reason: tokenOrRedacted(TOKEN_RE(32)),
  gate: tokenOrRedacted(TOKEN_RE(32)),
  generation: natIntOrDrop,
  expiry: intOrDrop,
  deadline: intOrDrop,
  attemptMs: intOrDrop,
  verifierKeyId: tokenOrRedacted(TOKEN_RE(48)),
  tag: tokenOrRedacted(TOKEN_RE(48)),
});

// Evento -> riga redatta, oppure null se l'evento non e' nel contratto.
// Puro: nessun clock, nessuna scrittura.
function redactLeaseEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (typeof event.event !== 'string' || !LEASE_LOG_EVENTS.includes(event.event)) return null;
  const out = { event: event.event };
  for (const [key, value] of Object.entries(event)) {
    if (key === 'event') continue;
    // Solo proprieta' PROPRIE della whitelist: un campo estraneo che porta il
    // nome di una proprieta' ereditata (constructor, __proto__, toString...)
    // non trova un validatore, non viene valutato e non arriva all'output.
    if (!Object.prototype.hasOwnProperty.call(FIELD_SPECS, key)) continue;
    const validate = FIELD_SPECS[key];
    if (!validate) continue; // fuori whitelist: scartato, mai propagato
    const checked = validate(value);
    if (checked !== undefined) out[key] = checked;
  }
  return out;
}

const PREFIX = 'cell-lease: ';

function lineOf(redacted) {
  return `${PREFIX}${JSON.stringify(redacted)}\n`;
}

// createLeaseLog({ write, detail, now, coalesceMs, maxDetailLines }) ->
// { log(event), close() }.
//
// write riceve la riga gia' formattata; se manca o lancia, tutto e' silenzio.
function createLeaseLog({
  write, detail = false, coalesceMs = COALESCE_MS_DEFAULT, maxDetailLines = MAX_DETAIL_LINES_DEFAULT,
} = {}) {
  const safeWrite = typeof write === 'function'
    ? (line) => { try { write(line); } catch (_) { /* il sink non cambia l'esito */ } }
    : null;
  const recent = new Map();
  let detailLines = 0;

  function log(event) {
    const redacted = redactLeaseEvent(event);
    if (!redacted || !safeWrite) return;
    if (redacted.event === 'attempt') {
      if (!detail || detailLines >= maxDetailLines) return;
      detailLines += 1;
      safeWrite(lineOf(redacted));
      return;
    }
    if (COALESCED_EVENTS.has(redacted.event)) {
      const key = `${redacted.event}|${redacted.cell || ''}|${redacted.reason || redacted.gate || ''}`;
      const t = Number.isSafeInteger(redacted.ts) ? redacted.ts : 0;
      const last = recent.get(key);
      if (last !== undefined && Math.abs(t - last) < coalesceMs) {
        recent.set(key, t);
        return;
      }
      recent.set(key, t);
    }
    safeWrite(lineOf(redacted));
  }

  return { log, close() {} };
}

// Trasporto predefinito del servizio: una riga redatta sul canale standard.
// Il try/catch assorbe il rifiuto sincrono; un canale Writable puo' segnalare
// il guasto anche in modo asincrono (es. pipe interrotta), e quello arriverebbe
// come evento 'error' non gestito, fuori dalla protezione del sink. La guardia
// viene installata UNA volta per canale e al PRIMO errore una sola riga di
// avviso esce sul descrittore secondario CON writeSync: la scrittura e'
// sincrona, il suo eventuale rifiuto e' un throw catturato li', e NON esiste
// un percorso asincrono dell'avviso capace di emettere 'error' non gestito.
// La sospensione scatta PRIMA dell'avviso: anche con il secondario guasto il
// primario resta sospeso e il demone vivo. Mai un avviso sul canale appena
// dichiarato rotto. Nessun handler delle eccezioni del processo.
const LEASE_TRANSPORT_NOTICE = 'cell-lease: default transport failed, diagnostics suspended\n';

function createDefaultWrite(out = process.stdout, seams = {}) {
  const notice = seams.notice || ((line) => {
    try { fs.writeSync(2, line); } catch (_) { /* best-effort: avviso perso, sospensione resta */ }
  });
  const secondary = seams.secondary !== undefined ? seams.secondary : process.stderr;
  let guard = null;
  if (out && typeof out.on === 'function') {
    if (!out.__leaseDiagGuard) {
      out.__leaseDiagGuard = { broken: false };
      out.on('error', () => {
        const st = out.__leaseDiagGuard;
        if (!st || st.broken) return;
        st.broken = true; // prima la sospensione: l'avviso non serve a sopravvivere
        try {
          if (out !== secondary) notice(LEASE_TRANSPORT_NOTICE);
        } catch (_) { /* avviso best-effort: mai fatale */ }
      });
    }
    guard = out.__leaseDiagGuard;
  }
  return (line) => {
    if (guard && guard.broken) return; // canale rotto: sospeso, non morto il demone
    try { out.write(line); } catch (_) { /* assorbito: il lease non cambia esito */ }
  };
}

module.exports = { LEASE_LOG_EVENTS, redactLeaseEvent, createLeaseLog, createDefaultWrite };
