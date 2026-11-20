'use strict';
const net = require('node:net');
// lib/fleet/launch-reconcile.js — il VALUTATORE UNICO delle prove di un lancio
// interrotto: `valutaLancio` giudica in SOLA LETTURA (record, /proc, tmux,
// lease) e non scrive ne' manda segnali.
//
// CONTRATTO. `live` (canale posseduto vivo) e `busy` (lancio in corso) non
// mutano nulla. Serve una PROVA DI MORTE fra: `prepared`/`aborted` qualificati;
// lettura TERNARIA di /proc su PID E nascita del supervisore; boot id valido e
// DIVERSO, stesso nodo e namespace dei processi (mai il PID del placeholder).
// In piu', SEMPRE, sessione assente sul server corretto (tranne `aborted`, che
// chiude il NOSTRO lancio senza toccare l'omonima) e lease `none`/`expired`:
// `grace`, `live`, sconosciuta o illeggibile bloccano. Un solo clock monotono e
// un solo budget: la deadline si rilegge dopo ogni lettura.
//
// IDENTITA' DEL SERVER. «Same» solo con PID e nascita qualificati del server
// INTERROGATO e assenza letta sulla STESSA connessione: identita' illeggibile o
// server vivo non raggiungibile => unknown. Un PID senza nascita non dimostra
// nessun listener (conta solo la sua assenza POSITIVA); con il server
// qualificato e vivo si cercano anche gli id ORIGINALI. Un record
// MATERIALIZZATO che non nomina un server non si chiude con assenze lette sul
// listener corrente (il socket puo' servire un sostituto): omonima presente =
// veto, id originale = blocco conservativo. Barriere host/claim e commit
// stanno in runtime.js (dipendono dalle chiusure del ciclo di vita).

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
const RE_ID_SESSIONE = /^\$[0-9]+$/;
const RE_ID_PANE = /^%[0-9]+$/;

// Declared absence for a PANE id (`list-panes -t %N`): the twin of
// esitoAssenzaSessione. Proof only with exit 1 and tmux's own message, or the
// EXACT stderr "no current target" of a live but empty server.
const ASSENZA_PANE_RE = /can't find pane|no server running/i;
// «Niente serve il socket»: dichiarato da tmux o dal kernel (ENOENT). Non e' un
// errore di lettura ma l'assenza di un listener, e li' non c'e' omonima da
// vetare. Stessa disciplina delle altre assenze (vedi esitoNonServe).
const NON_SERVE_RE = /no server running|error connecting to .*\(No such file or directory\)/i;
function esitoNonServe(r) {
  if (!(r && r.err && r.err.killed !== true && !r.err.signal && r.code === 1)) return false;
  return NON_SERVE_RE.test(String(r.stderr || ''));
}
function esitoAssenzaIdPane(r) {
  if (!(r && r.err && r.err.killed !== true && !r.err.signal && r.code === 1)) return false;
  const stderr = String(r.stderr || '');
  if (ASSENZA_PANE_RE.test(stderr)) return true;
  return stderr.replace(/\r\n?/g, '\n').replace(/\n+$/, '') === 'no current target';
}

/**
 * Cerca gli id ORIGINALI del record (sessione $N, poi pane %N) sul server
 * corrente, in SOLA LETTURA: sono l'identita' DUREVOLE del lancio, che
 * sopravvive a un rename. Esiti: `not-required` (nessun id valido), `present`
 * (duplicato PROVATO, mai archiviare), `absent`, `unknown` (lettura non
 * conclusa, oppure listener NON correlato al record: `identita`). Con
 * `serverPid` ogni query asserisce quel pid sulla STESSA connessione; ogni
 * comando porta il residuo del budget.
 */
async function cercaIdOriginali(ctx, record, { serverPid = null } = {}) {
  const idSessione = typeof record.sessionId === 'string' && RE_ID_SESSIONE.test(record.sessionId)
    ? record.sessionId : null;
  const idPane = typeof record.paneId === 'string' && RE_ID_PANE.test(record.paneId)
    ? record.paneId : null;
  if (!idSessione && !idPane) return { esito: 'not-required' };
  const atteso = Number.isSafeInteger(serverPid) && serverPid > 0 ? serverPid : null;
  const fuori = () => ctx.monoNow() >= ctx.scadenza;
  const residuo = () => Math.max(0, ctx.scadenza - ctx.monoNow());
  const query = async (args, assenza) => {
    if (fuori() || residuo() <= 0) return { esito: 'unknown', budget: true };
    const comando = atteso === null ? args : ['display-message', '-p', '#{pid}', ';', ...args];
    let r = null;
    try {
      r = await ctx.tmuxExec(ctx.tmuxBin, comando, { env: ctx.minimalEnv(), timeoutMs: residuo() });
    } catch (_) { r = null; }
    if (fuori()) return { esito: 'unknown', budget: true };
    if (!r) return { esito: 'unknown' };
    if (atteso !== null) {
      const primo = String(r.stdout || '').split('\n')[0].trim();
      const pidOsservato = /^[0-9]+$/.test(primo) ? Number(primo) : null;
      if (pidOsservato !== atteso) return { esito: 'unknown', identita: true };
    }
    if (!r.err) return { esito: 'present' };
    if (assenza(r)) return { esito: 'absent' };
    return { esito: 'unknown' };
  };
  if (idSessione) {
    const q = await query(['has-session', '-t', idSessione], (r) => ctx.esitoAssenzaSessione(r));
    if (q.esito === 'present') return { esito: 'present', oggetto: 'session' };
    if (q.esito === 'unknown') return { esito: 'unknown', ...(q.budget ? { budget: true } : {}), ...(q.identita ? { identita: true } : {}) };
  }
  if (idPane) {
    const q = await query(['list-panes', '-t', idPane, '-F', '#{pane_id}'], esitoAssenzaIdPane);
    if (q.esito === 'present') return { esito: 'present', oggetto: 'pane' };
    if (q.esito === 'unknown') return { esito: 'unknown', ...(q.budget ? { budget: true } : {}), ...(q.identita ? { identita: true } : {}) };
  }
  return { esito: 'absent' };
}

/**
 * SONDA DI VETO per la conferma dell'operatore su un server INCERTO: sola
 * lettura, sul listener CORRENTE, nome esatto e id originali del record. Il suo
 * unico compito e' dire NO: nome o id presente, lettura non conclusa, pid del
 * listener che cambia fra le letture => veto. Un'assenza e' esattamente questo
 * e nient'altro: non prova che il server registrato sia morto. A differenza del
 * valutatore gira anche per un record che NOMINA un server senza dimostrarlo.
 */
async function sondaVetoIdentitaIncerta(ctx, record) {
  const out = { esito: 'ignota', oggetto: null, pid: null };
  const fuori = () => ctx.monoNow() >= ctx.scadenza;
  const residuo = () => Math.max(0, ctx.scadenza - ctx.monoNow());
  if (fuori() || residuo() <= 0) return out;
  let r = null;
  try {
    r = await ctx.tmuxExec(ctx.tmuxBin,
      ['display-message', '-p', '#{pid}', ';', 'has-session', '-t', `=${ctx.nomeSessione}`],
      { env: ctx.minimalEnv(), timeoutMs: residuo() });
  } catch (_) { r = null; }
  if (fuori()) return out;
  if (!r) return out;
  const primo = String(r.stdout || '').split('\n')[0].trim();
  const pid = /^[0-9]+$/.test(primo) ? Number(primo) : null;
  if (!r.err) { out.pid = pid; out.esito = 'presente'; out.oggetto = 'session'; return out; }
  // Declared absence of a LISTENER (no server at all): nothing on this
  // listener can veto, and there is no pid to qualify the later reads with.
  if (esitoNonServe(r)) { out.esito = 'assente'; return out; }
  if (!ctx.esitoAssenzaSessione(r)) return out; // timeout/contaminated: veto
  // The listener answered and declared the exact name absent: it must also
  // carry a readable pid, or the later reads cannot be correlated to it.
  if (pid === null) return out;
  out.pid = pid;
  const perId = await cercaIdOriginali(ctx, record, { serverPid: pid });
  if (perId.esito === 'present') { out.esito = 'presente'; out.oggetto = perId.oggetto; return out; }
  if (perId.esito !== 'absent' && perId.esito !== 'not-required') return out;
  // A4 — ULTIMO veto: il NOME si rilegge DOPO le query per id, con il pid del
  // listener asserto sulla stessa connessione. Un'omonima comparsa nel
  // frattempo ha id nuovi (le query per id non l'hanno vista) e deve fermare
  // l'atto; un listener sostituito o una lettura non conclusa sono `ignota`.
  if (fuori() || residuo() <= 0) return out;
  let ultimo = null;
  try {
    ultimo = await ctx.tmuxExec(ctx.tmuxBin,
      ['display-message', '-p', '#{pid}', ';', 'has-session', '-t', `=${ctx.nomeSessione}`],
      { env: ctx.minimalEnv(), timeoutMs: residuo() });
  } catch (_) { ultimo = null; }
  if (fuori() || !ultimo) return out;
  const primoFinale = String(ultimo.stdout || '').split('\n')[0].trim();
  if (!/^[0-9]+$/.test(primoFinale) || Number(primoFinale) !== pid) return out;
  if (!ultimo.err) { out.esito = 'presente'; out.oggetto = 'session'; return out; }
  if (ctx.esitoAssenzaSessione(ultimo)) { out.esito = 'assente'; return out; }
  return out;
}

/**
 * Osserva la sessione omonima sul server corretto, in SOLA LETTURA.
 *  - Nessuna identita' di server (prepared, creating, aborted, v1 senza
 *    serverPid) o server MORTO per prova positiva: `has-session -t =nome` sul
 *    server attuale.
 *  - Server VIVO e qualificato: una connessione sola, `display-message -p
 *    #{pid} ; has-session`, cosi' pid e assenza vengono dallo stesso server.
 *    Pid diverso o non raggiungibile, identita' illeggibile => unknown.
 *  - Senza PID di server il nome non basta (un rename risponde assente): si
 *    cercano gli id ORIGINALI; un oggetto presente e' un duplicato PROVATO.
 *  - PID senza nascita: non dimostra nessun listener, conta solo la sua
 *    assenza positiva; con il pid vivo nessuna sessione si interroga.
 *  - Record MATERIALIZZATO senza server: le assenze lette qui non chiudono
 *    (il socket puo' servire un sostituto) e bloccano con SERVER_UNKNOWN.
 */
async function osservaSessione(ctx, record, { materialized = false } = {}) {
  const out = { sessione: 'unknown', server: 'n/a', blocchi: [] };
  const fuori = () => ctx.monoNow() >= ctx.scadenza;
  const residuo = () => Math.max(0, ctx.scadenza - ctx.monoNow());
  if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
  const haPidServer = Number.isSafeInteger(record.serverPid) && record.serverPid > 0;
  // A server qualifies with pid AND birth. A record WITHOUT a birth time (v1:
  // the field does not exist in the schema) does not pretend to know the
  // server: with a live or inconclusive pid it blocks with SERVER_UNKNOWN (see
  // the branch below), and only a POSITIVE absence of the pid lets it be read
  // on the current listener like any dead server. A record with no pid at all
  // falls to the "no server identity" branch.
  const haServer = haPidServer && Number.isFinite(record.serverStarttime);
  // DEAD-BOOT: record di un'incarnazione precedente dello stesso nodo, owner e
  // namespace, con un'identita' di server DIVERSA dal socket corrente. Li' il
  // socket e il pid del record appartengono a quel boot: la prova richiesta e'
  // «nessuna omonima PUO' esistere sul socket corrente», con la sonda esatta.
  const deadBoot = proveBoot(ctx, record) && haServer && record.tmuxSocket !== ctx.socketCorrente;
  let stato = 'n/a';
  if (deadBoot) {
    stato = 'dead-boot';
    if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
    const sonda = typeof ctx.sondaSocket === 'function' ? await ctx.sondaSocket(ctx.socketCorrente) : null;
    if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
    if (!sonda || typeof sonda !== 'object') {
      out.blocchi.push(BLOCCHI.SESSION_UNKNOWN);
      return out;
    }
    if (sonda.esito === 'enoent' || sonda.esito === 'econnrefused') {
      out.server = 'dead-boot';
      out.sessione = 'absent';
      return out;
    }
    if (sonda.esito !== 'connect') {
      // timeout, EACCES, errore o esito non qualificato: non e' una prova.
      out.blocchi.push(BLOCCHI.SESSION_UNKNOWN);
      return out;
    }
    // Un server SERVE il socket corrente: si interroga con has-session, col
    // predicato stretto di sempre. La connessione della sonda e' chiusa: la
    // query e' un client nuovo, mai «la stessa connessione».
  } else {
    // A different socket is informative on its own (the record belongs to
    // another incarnation of the socket): it stays replaced-unknown even
    // without the birth time.
    if (haPidServer && record.tmuxSocket !== ctx.socketCorrente) {
      out.server = 'replaced-unknown';
      out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
      return out;
    }
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
    } else if (haPidServer) {
      // PID SENZA nascita (v1, o v2 senza serverStarttime): l'identita' di quel
      // listener non si dimostra, un pid da solo si riusa. Usabile solo la sua
      // ASSENZA positiva (il server registrato e' sparito, con le sue
      // sessioni); vivo o inconcludente => SERVER_UNKNOWN, e nessuna sessione
      // si interroga su un listener non correlato.
      let id = null;
      try { id = await ctx.identitaProc(record.serverPid); } catch (_) { id = null; }
      if (fuori()) { out.blocchi.push(BLOCCHI.BUDGET); return out; }
      const esito = id && typeof id === 'object' ? id.esito : null;
      if (esito !== 'assente') {
        out.server = esito === 'presente' ? 'unqualified-alive' : 'unknown';
        out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
        return out;
      }
      stato = 'dead';
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
  // R1: senza identita' di server il NOME non e' l'identita' della sessione
  // registrata (un rename risponde assente mentre e' viva): servono gli id
  // ORIGINALI. Solo per un record che NON nomina un server: con un serverPid le
  // assenze si leggerebbero su un listener non correlato.
  if (!haPidServer && sessione === 'absent') {
    const perId = await cercaIdOriginali(ctx, record);
    if (perId.esito === 'present') {
      // Un oggetto con un id ORIGINALE esiste sul listener corrente: per un
      // lancio mai materializzato e' il duplicato PROVATO; per uno
      // MATERIALIZZATO la coincidenza non prova l'identita', e resta un blocco
      // conservativo con il server incerto.
      out.server = materialized ? 'unknown' : stato;
      out.sessione = materialized ? 'unknown' : 'present';
      out.idOriginale = perId.oggetto;
      out.blocchi.push(materialized ? BLOCCHI.SERVER_UNKNOWN : BLOCCHI.SESSION_PRESENT);
      return out;
    }
    if (perId.esito === 'unknown') {
      out.server = stato;
      out.sessione = 'unknown';
      out.blocchi.push(perId.budget ? BLOCCHI.BUDGET : BLOCCHI.SESSION_UNKNOWN);
      return out;
    }
    // R1: un record materializzato senza identita' di server nomina una
    // sessione che FU materializzata: nome e id originali sono stati letti sul
    // listener corrente, e la loro assenza non autorizza quarantena ne' rilancio.
    if (materialized) {
      out.server = 'unknown';
      out.sessione = 'absent';
      out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
      return out;
    }
  }
  if (stato === 'alive') {
    const primo = String(r.stdout || '').split('\n')[0].trim();
    const pidOsservato = /^[0-9]+$/.test(primo) ? Number(primo) : null;
    if (pidOsservato !== record.serverPid) {
      out.server = 'unknown';
      out.blocchi.push(BLOCCHI.SERVER_UNKNOWN);
      return out;
    }
    out.server = 'same';
    // Sul server DIMOSTRATO anche il nome attuale non e' l'identita': un rename
    // risponde assente mentre $N e %N sono vivi li'. Gli id si cercano con il
    // pid asserto su ogni connessione, cosi' un sostituto non conclude nulla.
    if (sessione === 'absent') {
      const perId = await cercaIdOriginali(ctx, record, { serverPid: record.serverPid });
      if (perId.esito === 'present') {
        out.sessione = 'present';
        out.idOriginale = perId.oggetto;
        out.blocchi.push(BLOCCHI.SESSION_PRESENT);
        return out;
      }
      if (perId.esito === 'unknown') {
        out.sessione = 'unknown';
        if (perId.identita) {
          out.server = 'unknown';
          out.blocchi.push(perId.budget ? BLOCCHI.BUDGET : BLOCCHI.SERVER_UNKNOWN);
        } else {
          out.blocchi.push(perId.budget ? BLOCCHI.BUDGET : BLOCCHI.SESSION_UNKNOWN);
        }
        return out;
      }
    }
  } else {
    out.server = stato;
  }
  out.sessione = sessione;
  if (sessione === 'present') out.blocchi.push(BLOCCHI.SESSION_PRESENT);
  return out;
}

/**
 * Sonda LOCALE del socket ESATTO corrente: I/O di sola lettura, bounded, che
 * dice se qualcuno SERVE quel pathname. Non esegue comandi: l'esito e' il fatto
 * del kernel su connect(2). `connect` = un listener risponde (chi sia lo dice
 * has-session); `econnrefused` = pathname senza ascoltatore; `enoent` = non
 * esiste; `eacces`/timeout/altro = osservazione NON conclusa. Il socket si
 * chiude e i timer si azzerano in ogni esito, con una sola risoluzione.
 */
function sondaSocketCorrente(socketPath, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    if (typeof socketPath !== 'string' || !socketPath) {
      resolve({ esito: 'unknown', motivo: 'path' });
      return;
    }
    let deciso = false;
    let timer = null;
    const socket = net.connect({ path: socketPath });
    const chiudi = (esito, motivo = null) => {
      if (deciso) return;
      deciso = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        // Una sola risoluzione: i listener veri si tolgono, e resta solo un
        // assorbitore per un errore tardivo del socket gia' distrutto (mai un
        // evento non gestito dopo la risposta).
        socket.removeAllListeners('connect');
        socket.removeAllListeners('error');
        socket.on('error', () => {});
        socket.destroy();
      } catch (_) { /* gia' chiuso */ }
      resolve(motivo ? { esito, motivo } : { esito });
    };
    timer = setTimeout(() => chiudi('timeout'), Math.max(1, timeoutMs));
    if (timer && typeof timer.unref === 'function') timer.unref();
    socket.once('connect', () => chiudi('connect'));
    socket.once('error', (e) => {
      const code = e && typeof e.code === 'string' ? e.code : '';
      if (code === 'ENOENT') return chiudi('enoent');
      if (code === 'ECONNREFUSED') return chiudi('econnrefused');
      if (code === 'EACCES' || code === 'EPERM') return chiudi('eacces');
      chiudi('unknown', code || 'errore');
    });
  });
}

/** Supervisore: lettura TERNARIA. Solo con PID E nascita nel record. */
async function proveSupervisore(ctx, record) {  const out = { supervisore: 'unknown', blocchi: [] };
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
      const oss = await osservaSessione(ctx, record, { materialized: ternario });
      proofs.session = oss.sessione;
      proofs.server = oss.server;
      if (oss.idOriginale) proofs.sessionIdOriginale = oss.idOriginale;
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

// Validazione STRETTA del corpo attestazione del reconcile (nessuna coercizione:
// un truthy non e' un booleano, un testo ripulito non e' lo stesso testo).
// Tre sole forme ammesse, chiavi esatte, enum chiusa; un body a lista e'
// rifiutato prima di qualunque lettura. Esito:
//   { ok: true, attest } — attest e' {azione:'anteprima'} oppure
//     {azione:'archivia-legacy', conferma:{recordSha256,bootId,ownerInstanceId,
//      hostAssente,motivo,attestatoreDichiarato?}} con i tipi gia' esatti;
//   { ok: false, motivo } — forma non ammessa, NESSUNA interpretazione.
const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_OWNER = /^[0-9a-f]{32}$/;
const SOLO_CONTROLLI = /[\x00-\x1f\x7f-\x9f]/;

function validaAttestazione(body) {
  const rifiuta = (motivo) => ({ ok: false, motivo });
  if (body === undefined || body === null) return { ok: true, attest: null };
  if (Array.isArray(body) || typeof body !== 'object') return rifiuta('invalid attest');
  const attest = body.attest;
  if (attest === undefined || attest === null) {
    if (Object.keys(body).includes('attest')) return rifiuta('invalid attest');
    return { ok: true, attest: null };
  }
  if (Array.isArray(attest) || typeof attest !== 'object') return rifiuta('invalid attest');
  const chiavi = Object.keys(attest);
  if (attest.azione === 'anteprima') {
    if (chiavi.length !== 1) return rifiuta('attest keys not allowed');
    return { ok: true, attest: { azione: 'anteprima' } };
  }
  if (attest.azione !== 'archivia-legacy' && attest.azione !== 'archivia-identita-incerta') return rifiuta('invalid attest action');
  const conferma = attest.conferma;
  if (Array.isArray(conferma) || typeof conferma !== 'object' || conferma === null) return rifiuta('invalid confirmation');
  const c = Object.keys(conferma).sort();
  const attese = ['hostAssente', 'bootId', 'motivo', 'ownerInstanceId', 'recordSha256'];
  if (conferma.attestatoreDichiarato !== undefined) attese.push('attestatoreDichiarato');
  // Solo la variante nuova dell'atto porta il token dell'anteprima: il legacy
  // resta com'e' (la sua conferma non ha una fase di anteprima vincolante).
  if (attest.azione === 'archivia-identita-incerta') attese.push('previewToken');
  if (c.join(',') !== attese.sort().join(',')) return rifiuta('confirmation keys not allowed');
  if (attest.azione === 'archivia-identita-incerta'
    && (typeof conferma.previewToken !== 'string' || conferma.previewToken.length < 1
      || conferma.previewToken.length > 1024)) {
    return rifiuta('invalid previewToken');
  }
  if (typeof conferma.recordSha256 !== 'string' || !RE_SHA256.test(conferma.recordSha256)) return rifiuta('invalid recordSha256');
  if (typeof conferma.bootId !== 'string' || !RE_UUID.test(conferma.bootId)) return rifiuta('invalid bootId');
  if (typeof conferma.ownerInstanceId !== 'string' || !RE_OWNER.test(conferma.ownerInstanceId)) return rifiuta('invalid ownerInstanceId');
  if (typeof conferma.hostAssente !== 'boolean') return rifiuta('hostAssente is not boolean');
  if (typeof conferma.motivo !== 'string' || conferma.motivo.length < 1 || conferma.motivo.length > 200
    || SOLO_CONTROLLI.test(conferma.motivo)) {
    return rifiuta('invalid motivo');
  }
  if (conferma.attestatoreDichiarato !== undefined
    && (typeof conferma.attestatoreDichiarato !== 'string' || conferma.attestatoreDichiarato.length > 64
      || SOLO_CONTROLLI.test(conferma.attestatoreDichiarato))) {
    return rifiuta('invalid attestatoreDichiarato');
  }
  return {
    ok: true,
    attest: {
      azione: attest.azione,
      conferma: {
        recordSha256: conferma.recordSha256,
        bootId: conferma.bootId,
        ownerInstanceId: conferma.ownerInstanceId,
        hostAssente: conferma.hostAssente,
        motivo: conferma.motivo,
        ...(attest.azione === 'archivia-identita-incerta' ? { previewToken: conferma.previewToken } : {}),
        ...(conferma.attestatoreDichiarato !== undefined ? { attestatoreDichiarato: conferma.attestatoreDichiarato } : {}),
      },
    },
  };
}

module.exports = {
  valutaLancio, osservaSessione, cercaIdOriginali, proveBoot, sondaSocketCorrente,
  sondaVetoIdentitaIncerta, validaAttestazione, BLOCCHI,
};
