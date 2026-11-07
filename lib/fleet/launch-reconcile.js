'use strict';
// lib/fleet/launch-reconcile.js — il VALUTATORE UNICO delle prove di un lancio
// interrotto. Una sola funzione, `valutaLancio`, giudica un record di
// launch-targets e dice se il lancio e' provabilmente chiuso; down la usa oggi,
// l'endpoint esplicito la riusera' domani. Il valutatore non scrive niente e
// non manda segnali: legge soltanto (record, /proc, tmux in sola lettura,
// stato della lease di controllo).
//
// REGOLE (disegno P1, sezione 4):
//  - canale posseduto vivo => `live`, nessuna mutazione; un lancio in corso =>
//    `busy`.
//  - Una PROVA DI MORTE fra:
//      * `prepared` qualificato: QUESTO lancio non ha emesso new-session;
//      * `aborted`: rifiuto provato e reso durevole;
//      * `attested` (o v1 completo) con PID e nascita: lettura TERNARIA di
//        /proc (assente, oppure presente con nascita divergente);
//      * bootId valido DIVERSO da quello attuale, sullo stesso nodo e nello
//        stesso namespace dei processi (la sola incarnazione del demone non
//        basta, mai il PID del placeholder per creating/created).
//  - In piu', SEMPRE: sessione assente sul server corretto (tranne il rifiuto
//    provato, che chiude il NOSTRO lancio senza toccare l'omonima) e lease di
//    controllo `none` o `expired` (`grace`, `live`, sconosciuta, illeggibile
//    bloccano).
//  - Un solo clock monotono e un solo budget: la deadline si rilegge dopo ogni
//    lettura e un positivo arrivato tardi non vale.
//  - Server tmux: «same» solo con PID e nascita qualificati del server
//    INTERROGATO e assenza letta sulla stessa connessione; server registrato
//    morto per prova positiva => anche l'omonima assente sul server attuale;
//    identita' illeggibile o server vivo ma non raggiungibile => unknown.
//
// Le barriere host e claim e il commit del record stanno in runtime.js (down),
// perche' dipendono dalle chiusure del ciclo di vita; qui solo il giudizio.

const BLOCCHI = Object.freeze({
  RECORD_UNREADABLE: 'RECORD_UNREADABLE',
  RECORD_NOT_QUALIFIED: 'RECORD_NOT_QUALIFIED',
  LEGACY_UNPROVABLE: 'LEGACY_UNPROVABLE',
  MATERIALIZATION_UNKNOWN: 'MATERIALIZATION_UNKNOWN',
  SUPERVISOR_ALIVE: 'SUPERVISOR_ALIVE',
  SUPERVISOR_UNREADABLE: 'SUPERVISOR_UNREADABLE',
  SESSION_PRESENT: 'SESSION_PRESENT',
  SESSION_UNKNOWN: 'SESSION_UNKNOWN',
  SERVER_UNKNOWN: 'SERVER_UNKNOWN',
  LEASE_BLOCKS: 'LEASE_BLOCKS',
  LEASE_UNREADABLE: 'LEASE_UNREADABLE',
  BUDGET: 'BUDGET',
  BUSY: 'BUSY',
});

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Osserva la sessione omonima sul server corretto, in SOLA LETTURA.
 *  - Nessuna identita' di server nel record (prepared, creating, aborted, v1
 *    senza server): `has-session -t =nome` sul server attuale.
 *  - Server registrato MORTO per prova positiva (pid assente, o nascita
 *    divergente = pid riusato): l'assenza dell'omonima si legge sul server
 *    ATTUALE, con lo stesso `has-session`.
 *  - Server registrato VIVO e qualificato (PID e nascita): «same» solo se e'
 *    il server che si sta interrogando. Per questo la lettura e' UNA
 *    connessione sola, `display-message -p #{pid} ; has-session -t =nome`:
 *    pid del server e assenza vengono dallo STESSO server, e nessuna
 *    sostituzione puo' infilarsi fra identificazione e query. Pid diverso o
 *    nessun server raggiungibile => unknown (il vecchio puo' avere ancora la
 *    sessione su un socket scollegato).
 *  - Identita' illeggibile o non qualificabile => unknown.
 */
async function osservaSessione(ctx, record) {
  const out = { sessione: 'unknown', server: 'n/a', blocchi: [] };
  const fuori = () => ctx.monoNow() >= ctx.scadenza;
  const residuo = () => Math.max(0, ctx.scadenza - ctx.monoNow());
  if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
  const haServer = Number.isSafeInteger(record.serverPid) && record.serverPid > 0;
  if (haServer && record.tmuxSocket !== ctx.socketCorrente) {
    out.server = 'replaced-unknown';
    out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
    return out;
  }
  let stato = 'n/a';
  if (haServer) {
    let id = null;
    try { id = await ctx.identitaProc(record.serverPid); } catch (_) { id = null; }
    if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
    const esito = id && typeof id === 'object' ? id.esito : null;
    const nascitaReg = Number.isFinite(record.serverStarttime) ? record.serverStarttime : null;
    if (esito === 'assente' || (esito === 'presente' && nascitaReg !== null
      && Number.isFinite(id.nascita) && id.nascita !== nascitaReg)) {
      stato = 'dead';
    } else if (esito === 'presente' && nascitaReg !== null && id.nascita === nascitaReg) {
      stato = 'alive';
    } else {
      out.server = 'unknown';
      out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
      return out;
    }
  }
  const args = stato === 'alive'
    ? ['display-message', '-p', '#{pid}', ';', 'has-session', '-t', `=${ctx.nomeSessione}`]
    : ['has-session', '-t', `=${ctx.nomeSessione}`];
  if (residuo() <= 0) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
  let r;
  try {
    r = await ctx.tmuxExec(ctx.tmuxBin, args, { env: ctx.minimalEnv(), timeoutMs: residuo() });
  } catch (_) { r = null; }
  if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
  if (!r) { out.blocchi.push(BLOCCHI.SESSION_UNKNOWN); return out; }
  let sessione;
  if (!r.err) sessione = 'present';
  else if (ctx.esitoAssenzaSessione(r)) sessione = 'absent';
  else { out.blocchi.push(BLOCCHI.SESSION_UNKNOWN); return out; }
  if (stato === 'alive') {
    const primo = String(r.stdout || '').split('\n')[0].trim();
    const pidOsservato = /^[0-9]+$/.test(primo) ? Number(primo) : null;
    if (pidOsservato !== record.serverPid) {
      out.server = 'unknown';
      out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
      return out;
    }
    out.server = 'same';
  } else {
    out.server = stato;
  }
  out.sessione = sessione;
  if (sessione === 'present') out.blocchi.push(BLOCCHI.SESSION_PRESENT);
  return out;
}

/** Supervisore: lettura TERNARIA. Solo con PID E nascita nel record. */
async function proveSupervisore(ctx, record) {
  const out = { supervisore: 'unknown', blocchi: [] };
  const pid = Number.isSafeInteger(record.panePid) && record.panePid > 0 ? record.panePid : null;
  const nascita = Number.isFinite(record.paneStarttime) ? record.paneStarttime : null;
  if (pid === null || nascita === null) return out;
  let id = null;
  try { id = await ctx.identitaProc(pid); } catch (_) { id = null; }
  if (ctx.monoNow() >= ctx.scadenza) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
  const esito = id && typeof id === 'object' ? id.esito : null;
  if (esito === 'assente' || (esito === 'presente' && Number.isFinite(id.nascita) && id.nascita !== nascita)) {
    out.supervisore = 'dead-by-identity';
  } else if (esito === 'presente') {
    out.supervisore = 'alive';
    out.blocchi.push(BLOCCHI.SUPERVISOR_ALIVE);
  } else {
    // «indeterminata» (EACCES, EIO, stat malformato) o lettura mancata: non e' una prova.
    out.blocchi.push(BLOCCHI.SUPERVISOR_UNREADABLE);
  }
  return out;
}

/**
 * Prova di boot. Vale solo se record e nodo hanno un boot id VALIDO e
 * DIVERSO, e il record e' dello stesso nodo (owner) e dello stesso namespace
 * dei processi: altrimenti il processo registrato potrebbe vivere altrove.
 * La sola incarnazione del demone diversa NON basta.
 */
function proveBoot(ctx, record) {
  const attuale = ctx.identitaNodo();
  if (!attuale || !RE_UUID.test(attuale.bootId || '')) return false;
  if (typeof record.bootId !== 'string' || !RE_UUID.test(record.bootId)) return false;
  if (record.bootId === attuale.bootId) return false;
  const owner = ctx.ownerNodo();
  if (!owner || record.ownerInstanceId !== owner) return false;
  if (typeof record.pidNs !== 'string' || record.pidNs !== String(attuale.pidNamespaceInode)) return false;
  return true;
}

/**
 * Valuta un lancio. `letto` e' il risultato di launchTarget.leggi. Mai throw.
 * Restituisce:
 *   { classificazione, prova, proofs, riconciliabile, blocchi }
 * con classificazione in none | unreadable | live | busy | never-materialized |
 * proven-dead | materialization-unknown | legacy-unprovable.
 */
async function valutaLancio(ctx, letto) {
  const risultato = (classificazione, extra = {}) => ({
    classificazione, prova: null, proofs: {}, riconciliabile: false, blocchi: [], ...extra,
  });
  try {
    if (!letto || letto.stato === 'assente') return risultato('none');
    if (letto.stato !== 'presente' || !letto.record) {
      return risultato('unreadable', { blocchi: [BLOCCHI.RECORD_UNREADABLE] });
    }
    const record = letto.record;
    if (ctx.canaleVivo()) return risultato('live');
    if (ctx.lancioInCorso()) return risultato('busy', { blocchi: [BLOCCHI.BUSY] });
    const v2 = record.version === 2;
    if (v2 && !record.qualificato) {
      return risultato('unreadable', { blocchi: [BLOCCHI.RECORD_NOT_QUALIFIED] });
    }
    // --- 1. quale prova di morte e' applicabile (nessuna lettura ancora) ---
    let prova = null;
    let classificazione = 'proven-dead';
    const proofs = {};
    const blocchi = [];
    let ternario = false;
    const completoV1 = !v2 && Number.isSafeInteger(record.panePid) && record.panePid > 0
      && Number.isFinite(record.paneStarttime);
    if (v2 && record.phase === 'prepared') {
      prova = 'prepared';
      classificazione = 'never-materialized';
      proofs.supervisor = 'not-created';
    } else if (v2 && record.phase === 'aborted') {
      prova = 'aborted';
      classificazione = 'never-materialized';
      proofs.supervisor = 'not-created';
    } else if ((v2 && record.phase === 'attested' && Number.isFinite(record.paneStarttime)) || completoV1) {
      ternario = true;
    } else if (v2) {
      // creating/created, o attested senza nascita: il PID del placeholder non
      // dice niente sul supervisore; solo la prova di boot puo' valere.
      if (proveBoot(ctx, record)) { prova = 'boot'; proofs.supervisor = 'dead-by-boot'; } else {
        return risultato('materialization-unknown', {
          proofs: { supervisor: 'unknown' }, blocchi: [BLOCCHI.MATERIALIZATION_UNKNOWN],
        });
      }
    } else {
      // v1 incompleto (intent, created legacy): nessuna prova, solo diagnosi.
      return risultato('legacy-unprovable', { blocchi: [BLOCCHI.LEGACY_UNPROVABLE], proofs: { supervisor: 'unknown' } });
    }
    // --- 2. letture: sessione, supervisore, lease (nell'ordine di sempre) ----
    // Sessione omonima sul server corretto. Il rifiuto provato (aborted) chiude
    // il NOSTRO lancio e non passa da questa regola: l'omonima e' estranea.
    if (prova !== 'aborted') {
      const oss = await osservaSessione(ctx, record);
      proofs.session = oss.sessione;
      proofs.server = oss.server;
      blocchi.push(...oss.blocchi);
    } else {
      proofs.session = 'not-required';
      proofs.server = 'n/a';
    }
    if (ternario) {
      const sup = await proveSupervisore(ctx, record);
      proofs.supervisor = sup.supervisore;
      if (sup.supervisore === 'dead-by-identity') prova = 'ternary';
      else if (v2 && proveBoot(ctx, record)) { prova = 'boot'; proofs.supervisor = 'dead-by-boot'; } else blocchi.push(...sup.blocchi);
      if (prova === null) {
        classificazione = 'materialization-unknown';
        if (!blocchi.length) blocchi.push(BLOCCHI.MATERIALIZATION_UNKNOWN);
      }
    }
    // Lease di controllo: none o expired. grace, live, sconosciuta, errore: blocco.
    let lease = 'unreadable';
    try {
      const st = ctx.leaseStatus();
      const stato = st && typeof st === 'object' ? st.state : null;
      if (stato === 'none' || stato === 'expired' || stato === 'grace' || stato === 'live') lease = stato;
    } catch (_) { lease = 'unreadable'; }
    proofs.lease = lease;
    if (lease === 'grace' || lease === 'live') blocchi.push(BLOCCHI.LEASE_BLOCKS);
    else if (lease === 'unreadable') blocchi.push(BLOCCHI.LEASE_UNREADABLE);
    if (ctx.monoNow() >= ctx.scadenza && !blocchi.includes(BLOCCHI.BUDGET)) blocchi.push(BLOCCHI.BUDGET);
    return {
      classificazione, prova, proofs, blocchi: [...new Set(blocchi)],
      riconciliabile: blocchi.length === 0,
    };
  } catch (_) {
    return risultato('unreadable', { blocchi: [BLOCCHI.RECORD_UNREADABLE] });
  }
}

module.exports = { valutaLancio, osservaSessione, proveBoot, BLOCCHI };
