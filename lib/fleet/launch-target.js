'use strict';
// lib/fleet/launch-target.js — il record del lancio POSSIEDUTO da questo
// processo NC: gli id tmux ($sessione, %pane) restituiti dalla creazione e
// l'identità del server su cui quella creazione e' avvenuta.
//
// PERCHE' QUESTO MODULO ESISTE. Un nome di sessione tmux e' un indirizzo
// RIUTILIZZABILE: quando il lancio A termina, chiunque puo' creare una
// sessione B con lo stesso nome. Fermare «per nome» significa fermare chi
// ocupa il nome ORA, non cio' che NC ha lanciato. Gli id $N/%N invece non
// vengono mai riutilizzati dentro lo stesso server tmux: sono l'identita'
// stabile. Questo record e' il possesso dimostrabile: chi lo ha scritto ha
// creato quella sessione su quel server e puo' rivendicarla per il teardown.
//
// Il record vive nella root dei file di NC, chiave = nome della sessione tmux
// della cella (la stessa chiave del registro dei lanci), disciplina 0600 con
// write+rename atomica: un lettore vede o il record vecchio per intero o
// quello nuovo per intero, mai un file a meta'.
//
// Stati di lettura — assenza VERIFICATA e ignoranza NON sono la stessa cosa:
//  - 'assente':      nessun record (mai lanciato da questo NC, o gia' pulito).
//  - 'presente':     record valido con i campi conformi.
//  - 'indeterminato': errore di lettura diverso da ENOENT o record non
//                     interpretabile. NON si cancella e NON si agisce sopra:
//                     l'identita' non e' dimostrabile né in un verso né
//                     nell'altro.

const fs = require('node:fs');
const path = require('node:path');

const DIR = 'launch-targets';
const RE_SESSIONE_TMUX = /^\$[0-9]+$/;
const RE_FINESTRA_TMUX = /^@[0-9]+$/;
const RE_PANE_TMUX = /^%[0-9]+$/;
const RE_ID_LANCIO = /^[0-9a-f]{16}$/;
const RE_PID = /^[0-9]+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RE_OWNER = /^[a-f0-9]{32}$/;

// SCHEMA v2 — il giornale del lancio. Il record nasce PRIMA di ogni effetto e
// avanza per fasi MONOTONE, ognuna una scrittura durevole:
//   prepared  -> creating -> created -> attested
// con la sola uscita laterale `aborted` (stato terminale durevole di un
// rifiuto provato, mai un passo indietro).
//  - prepared: scritto prima di riserva VL, contesto, marcatore, registro,
//    selettore e broker. Per costruzione la new-session di QUESTO lancio non
//    e' stata emessa.
//  - creating: sincronizzato prima della new-session. Se il commit non e'
//    attestato la new-session non si invoca.
//  - created: gli id veri di tmux e l'identita' del PLACEHOLDER (holdPid,
//    holdStarttime), in campi DISTINTI da quelli del supervisore.
//  - attested: pid e nascita del supervisore REALE (panePid, paneStarttime),
//    letti dopo il respawn. Solo questa fase porta una prova di pid. Il PID
//    e' obbligatorio; la nascita puo' mancare se /proc non la misura, e in
//    quel caso il solo PID non prova la morte di nessuno.
// I record v1 (senza fase) restano leggibili e non vengono mai riscritti:
// nessuna fase si inventa dalla forma degli id. Incarnazione del demone e ts
// sono diagnostica, mai prove di morte.
const FASI = Object.freeze(['prepared', 'creating', 'created', 'attested']);
const FASE_ABORTITA = 'aborted';
const MOTIVI_ABORT = Object.freeze(['duplicate-session']);
const TRANSIZIONI = Object.freeze({
  prepared: ['creating', FASE_ABORTITA],
  creating: ['created', FASE_ABORTITA],
  created: ['attested'],
});

function sessioneValida(sessione) {
  return typeof sessione === 'string' && !!sessione
    && !sessione.includes('/') && !sessione.includes('\\') && sessione !== '..';
}

function percorso(root, sessione) {
  return path.join(root, DIR, `${sessione}.json`);
}

// Scrittura atomica 0600 E DUREVOLE: temporaneo univoco nella stessa
// directory, fsync del file PRIMA del rename (il contenuto sopravvive al
// crash anche se il rename resta in pagina), rename, fsync della directory
// (il nuovo nome e' commitato), e — quando la directory e' stata creata da
// questa chiamata — fsync della padre (la directory stessa sopravvive al
// crash). Un errore in QUALSIASI punto rende l'esito false: il chiamante
// rifiuta il lancio invece di credere a una barriera che vive solo nella
// cache del processo che l'ha scritta. La disciplina del record precedente
// resta: un lettore vede o il record vecchio per intero o il nuovo per
// intero, mai un file a meta'; qui in piu' quello che si vede e' anche
// quello che resta dopo un riavvio.
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Piano dei commit ancora dovuti: le directory la cui catena di durabilita'
// NON e' completa. Un livello il cui fsync e' riuscito NON e' per questo
// durevole: il suo NOME vive nella directory padre e viene committato dal
// fsync del padre. Percio' ogni livello della catena entra in questo insieme
// PRIMA del giro di fsync e ne esce SOLO dopo il proprio fsync riuscito: se
// il fsync del livello k fallisce, i livelli k..n restano dovuti e il
// tentativo successivo non puo' dichiarare successo senza di loro, anche se
// tutte le directory esistono gia' sul disco.
//
// RECUPERO DOPO UN RIAVVIO: questo piano e' stato del processo. Dopo un
// riavvio il modulo non puo' sapere quali antenati abbiano saltato il
// proprio fsync prima dell'arresto: una nuova scrittura risale solo fino al
// primo antenato gia' esistente e pulito, e committa soltanto la propria
// catena. Per questo il contratto con il chiamante resta chiuso in ogni
// caso: `false` significa «record non provato durevole, lancio rifiutato»,
// e la root dei record e' attesa gia' preparata in modo durevole — le
// directory sopra di essa create e sincronizzate all'installazione — cosi'
// la camminata minima (dir, padre, primo antenato esistente) basta a
// chiudere la catena.
const nonSincronizzati = new Set();

function raccogliAntenati(dir) {
  const lista = [];
  const visitati = new Set();
  let cur = path.resolve(dir);
  const dirP = path.dirname(cur);
  // Se un antenato di questo percorso resta non sincronizzato da un
  // tentativo fallito, la camminata NON puo' fermarsi al primo livello gia'
  // esistente: deve risalire fino all'antenato pendente piu' alto, che
  // chiude la catena rimasta in sospeso. Saltarlo dichiarerebbe durevole
  // un nome che il suo genitore non ha mai committato.
  let limite = null;
  for (const pendente of nonSincronizzati) {
    if (cur === pendente || cur.startsWith(pendente + path.sep)) {
      if (limite === null || pendente.length < limite.length) limite = pendente;
    }
  }
  while (cur && cur !== path.dirname(cur)) {
    if (visitati.has(cur)) break;
    visitati.add(cur);
    lista.push(cur);
    if (limite !== null && cur === limite) break;
    const esiste = fs.existsSync(cur);
    const mancatoSync = nonSincronizzati.has(cur);
    if (limite === null && cur !== path.resolve(dir) && cur !== dirP && esiste && !mancatoSync) {
      break;
    }
    cur = path.dirname(cur);
  }
  return lista;
}

function scriviAtomicoEsito(dir, nome, contenuto) {
  const destinazione = path.join(dir, nome);
  let tmp = null;
  // Stadio dell'errore: prima del rename il record precedente e' intatto;
  // dopo il rename la fase nuova puo' essere gia' pubblicata anche se il fsync
  // della directory non e' riuscito, quindi l'esito e' INCERTO (ne' «scritto»
  // ne' «intatto»).
  let rinominato = false;
  const antenati = raccogliAntenati(dir);
  try {
    // TUTTI i livelli della catena entrano nell'insieme dei commit dovuti,
    // anche quelli gia' esistenti: creare una entry dentro una directory
    // esistente richiede comunque il fsync di quella directory per
    // committarne il nome. Solo il fsync riuscito fa uscire un livello
    // dall'insieme; un fallimento lascia dentro i livelli che mancano, cosi'
    // il prossimo tentativo li ritrova anche se nel frattempo esistono.
    for (const a of antenati) {
      nonSincronizzati.add(a);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tmp = path.join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, contenuto, { encoding: 'utf8' });
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, destinazione);
    rinominato = true;
    for (const a of antenati) {
      fsyncDir(a);
      nonSincronizzati.delete(a);
    }
    return { ok: true };
  } catch (_) {
    if (tmp && !rinominato) { try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ } }
    return { ok: false, pubblicato: rinominato ? 'incerto' : 'no' };
  }
}

function scriviAtomico(dir, nome, contenuto) {
  return scriviAtomicoEsito(dir, nome, contenuto).ok;
}

/**
 * Registra il bersaglio del lancio corrente per una sessione tmux di cella.
 * Accetta SOLO id nella forma chiusa di tmux ($N per la sessione, %N per il
 * pane) e un id di lancio esadecimale: un valore fuori forma e' rifiutato
 * PRIMA di toccare il disco, perche' un record «quasi giusto» varrebbe come
 * prova di possesso e non lo e'. `family` e' la famiglia del CLIENT del
 * lancio ('vl' se il lancio ha richiesto la barriera host, 'other' altrimenti)
 * ed e' decisa ALLA CREAZIONE, quando l'engine usato e' un fatto e non una
 * ricostruzione: il teardown la legge da qui e non dall'engine aggiornato
 * della definizione, che puo' essere cambiato nel frattempo. Socket e pid del
 * server sono facoltativi (raccolti best-effort alla creazione): vuoti, il
 * teardown resta per id sul server risolto dall'ambiente; la verifica di
 * continuita' del server e' questione separata. Mai throw.
 */
/**
 * Registra un intent di lancio durevole prima della materializzazione.
 * Viene sovrascritto dal record completo al termine della creazione riuscita.
 */
function registraIntent(root, sessione, { launchId, tmuxSocket = '', family = '', ora = null } = {}) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    if (family !== 'vl' && family !== 'other') return false;
    const socket = typeof tmuxSocket === 'string' && tmuxSocket.startsWith('/') ? tmuxSocket : '';
    const ts = Number(ora);
    const dato = {
      version: 1,
      family,
      launchId,
      stato: 'intent',
      incerto: true,
      sessionId: '$0',
      paneId: '%0',
      tmuxSocket: socket,
      serverPid: null,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    return scriviAtomico(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
  } catch (_) {
    return false;
  }
}

function registra(root, sessione, { launchId, sessionId, paneId, tmuxSocket = '', serverPid = null, panePid = null, paneStarttime = null, family = '', ora = null } = {}) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    if (typeof sessionId !== 'string' || !RE_SESSIONE_TMUX.test(sessionId)) return false;
    if (typeof paneId !== 'string' || !RE_PANE_TMUX.test(paneId)) return false;
    if (family !== 'vl' && family !== 'other') return false;
    const socket = typeof tmuxSocket === 'string' && tmuxSocket.startsWith('/') ? tmuxSocket : '';
    const pid = serverPid != null && RE_PID.test(String(serverPid)) ? Number(serverPid) : null;
    // Il pid del SUPERVISORE del pane (#{pane_pid}), non quello del server
    // tmux: e' l'identita' che la verifica di uscita deve osservare PRIMA
    // dello stop, perche' dopo l'uscita non e' piu' ricavabile dal PID sparito.
    const pidPane = panePid != null && RE_PID.test(String(panePid)) ? Number(panePid) : null;
    // La NASCITA del supervisore del pane (campo 22 di /proc/<pid>/stat),
    // catturata quando il pid e' un fatto appena osservato: distingue QUEL
    // processo da un riuso successivo dello stesso numero. Additiva: i
    // record scritti prima del campo non ce l'hanno, e la lettura riporta
    // null — una nascita assente non prova la morte di nessuno.
    const nascitaPane = Number.isFinite(paneStarttime) ? paneStarttime : null;
    const ts = Number(ora);
    const dato = {
      version: 1,
      family,
      launchId,
      sessionId,
      paneId,
      tmuxSocket: socket,
      serverPid: pid,
      panePid: pidPane,
      paneStarttime: nascitaPane,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    return scriviAtomico(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
  } catch (_) {
    return false;
  }
}

/**
 * Legge il record del lancio per una sessione. Mai throw.
 */
function leggi(root, sessione) {
  try {
    if (!root || typeof root !== 'string') return { stato: 'indeterminato' };
    if (!sessioneValida(sessione)) return { stato: 'indeterminato' };
    let raw;
    try {
      raw = fs.readFileSync(percorso(root, sessione), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { stato: 'assente' };
      return { stato: 'indeterminato' };
    }
    const dato = JSON.parse(raw);
    if (!dato || typeof dato !== 'object') return { stato: 'indeterminato' };
    if (dato.version === 2) return leggiV2(dato, sessione);
    // Una versione che questo modulo non conosce non si interpreta come v1.
    if (dato.version !== undefined && dato.version !== 1) return { stato: 'indeterminato' };
    if (typeof dato.launchId !== 'string' || !RE_ID_LANCIO.test(dato.launchId)) return { stato: 'indeterminato' };
    if (typeof dato.sessionId !== 'string' || !RE_SESSIONE_TMUX.test(dato.sessionId)) return { stato: 'indeterminato' };
    if (typeof dato.paneId !== 'string' || !RE_PANE_TMUX.test(dato.paneId)) return { stato: 'indeterminato' };
    return {
      stato: 'presente',
      record: {
        version: 1,
        phase: null,
        launchId: dato.launchId,
        // family assente (record scritto prima del campo): null, NON 'other'.
        // Chi legge decide; il conservative default e' trattare l'ignoto come
        // lancio che richiede la barriera, mai come esente.
        family: dato.family === 'vl' || dato.family === 'other' ? dato.family : null,
        sessionId: dato.sessionId,
        paneId: dato.paneId,
        tmuxSocket: typeof dato.tmuxSocket === 'string' ? dato.tmuxSocket : '',
        serverPid: Number.isFinite(dato.serverPid) ? dato.serverPid : null,
        panePid: Number.isFinite(dato.panePid) ? dato.panePid : null,
        // Additiva: record senza nascita (pre-campo) => null, e null NON e'
        // una prova — chi verifica la morte del supervisore non conclude
        // niente con un pid nudo.
        paneStarttime: Number.isFinite(dato.paneStarttime) ? dato.paneStarttime : null,
        ts: Number.isFinite(dato.ts) ? dato.ts : null,
        incerto: dato.incerto === true,
      },
    };
  } catch (_) {
    return { stato: 'indeterminato' };
  }
}

const interoPositivo = (v) => Number.isSafeInteger(v) && v > 0;
const interoOnullo = (v) => v === null || v === undefined || (Number.isSafeInteger(v) && v >= 0);
const finitoONullo = (v) => v === null || v === undefined || Number.isFinite(v);
const stringaNonVuota = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;

// Lettura del record v2. Un record non interpretabile (fase fuori dall'enum,
// launchId o famiglia invalidi, chiave diversa dal nome del file) e'
// `indeterminato`. Un record interpretabile ma con dati obbligatori della sua
// fase mancanti o incoerenti resta `presente` con `qualificato: false`:
// non si cancella e non vale come prova di niente.
function leggiV2(dato, sessione) {
  const fase = dato.phase;
  if (!FASI.includes(fase) && fase !== FASE_ABORTITA) return { stato: 'indeterminato' };
  if (typeof dato.launchId !== 'string' || !RE_ID_LANCIO.test(dato.launchId)) return { stato: 'indeterminato' };
  if (dato.family !== 'vl' && dato.family !== 'other') return { stato: 'indeterminato' };
  if (dato.session !== sessione) return { stato: 'indeterminato' };
  let qualificato = true;
  const richiedi = (cond) => { if (!cond) qualificato = false; };
  richiedi(stringaNonVuota(dato.cellId));
  richiedi(typeof dato.tmuxSocket === 'string' && dato.tmuxSocket.startsWith('/'));
  richiedi(stringaNonVuota(dato.daemonInc, 128));
  const bootId = typeof dato.bootId === 'string' && RE_UUID.test(dato.bootId) ? dato.bootId : null;
  richiedi(dato.bootId === null || dato.bootId === undefined || bootId !== null);
  // Namespace dei processi del nodo che ha scritto il record: additivo, nullo se
  // illeggibile (e allora la prova di boot non e' disponibile).
  const pidNs = typeof dato.pidNs === 'string' && /^[0-9]{1,20}$/.test(dato.pidNs) ? dato.pidNs : null;
  richiedi(dato.pidNs === null || dato.pidNs === undefined || pidNs !== null);
  let res = null;
  if (dato.family === 'vl') {
    const r = dato.res;
    const valido = !!(r && typeof r === 'object' && typeof r.vlOwner === 'string' && RE_OWNER.test(r.vlOwner)
      && typeof r.vlRoot === 'string' && path.isAbsolute(r.vlRoot));
    richiedi(valido);
    richiedi(valido && dato.ownerInstanceId === r.vlOwner);
    if (valido) res = { vlOwner: r.vlOwner, vlRoot: r.vlRoot };
  } else {
    richiedi(dato.res === null || dato.res === undefined);
    richiedi(dato.ownerInstanceId === null || dato.ownerInstanceId === undefined
      || (typeof dato.ownerInstanceId === 'string' && RE_OWNER.test(dato.ownerInstanceId)));
  }
  const idPresenti = fase === 'created' || fase === 'attested';
  const sessionId = typeof dato.sessionId === 'string' && RE_SESSIONE_TMUX.test(dato.sessionId) ? dato.sessionId : null;
  const windowId = typeof dato.windowId === 'string' && RE_FINESTRA_TMUX.test(dato.windowId) ? dato.windowId : null;
  const paneId = typeof dato.paneId === 'string' && RE_PANE_TMUX.test(dato.paneId) ? dato.paneId : null;
  if (idPresenti) {
    richiedi(sessionId !== null && windowId !== null && paneId !== null);
  } else {
    // prepared/creating/aborted non conoscono id veri: nessun falso $0/%0.
    richiedi(dato.sessionId == null && dato.paneId == null && dato.windowId == null);
  }
  richiedi(interoOnullo(dato.serverPid));
  richiedi(interoOnullo(dato.holdPid));
  richiedi(finitoONullo(dato.holdStarttime));
  richiedi(finitoONullo(dato.serverStarttime));
  const panePid = Number.isSafeInteger(dato.panePid) && dato.panePid > 0 ? dato.panePid : null;
  const paneStarttime = Number.isFinite(dato.paneStarttime) ? dato.paneStarttime : null;
  if (fase === 'attested') {
    // Identita' del supervisore: il PID letto dopo il respawn e' OBBLIGATORIO
    // (positivo); la nascita puo' mancare quando /proc non la misura, ma il
    // solo PID non vale mai come prova di morte e una nascita senza PID e'
    // incoerente. Chi usa la prova controlla entrambi i campi.
    richiedi(panePid !== null);
    richiedi(finitoONullo(dato.paneStarttime));
    richiedi(paneStarttime === null || panePid !== null);
  } else {
    // Il pid del supervisore appartiene alla sola fase attested.
    richiedi(dato.panePid == null && dato.paneStarttime == null);
  }
  if (fase === FASE_ABORTITA) richiedi(MOTIVI_ABORT.includes(dato.abortReason));
  return {
    stato: 'presente',
    record: {
      version: 2,
      phase: fase,
      qualificato,
      launchId: dato.launchId,
      family: dato.family,
      cellId: stringaNonVuota(dato.cellId) ? dato.cellId : null,
      session: dato.session,
      ownerInstanceId: typeof dato.ownerInstanceId === 'string' ? dato.ownerInstanceId : null,
      tmuxSocket: typeof dato.tmuxSocket === 'string' ? dato.tmuxSocket : '',
      bootId,
      pidNs,
      daemonInc: stringaNonVuota(dato.daemonInc, 128) ? dato.daemonInc : null,
      res,
      sessionId,
      windowId,
      paneId,
      serverPid: Number.isSafeInteger(dato.serverPid) ? dato.serverPid : null,
      serverStarttime: Number.isFinite(dato.serverStarttime) ? dato.serverStarttime : null,
      holdPid: Number.isSafeInteger(dato.holdPid) ? dato.holdPid : null,
      holdStarttime: Number.isFinite(dato.holdStarttime) ? dato.holdStarttime : null,
      panePid,
      paneStarttime,
      abortReason: MOTIVI_ABORT.includes(dato.abortReason) ? dato.abortReason : null,
      ts: Number.isFinite(dato.ts) ? dato.ts : null,
      // Solo `attested` e qualificato puo' non essere incerto; marcaIncerto
      // puo' alzare il flag, mai abbassarlo.
      incerto: dato.incerto === true || fase !== 'attested' || !qualificato,
    },
  };
}

/**
 * Scrive il record `prepared` (schema v2): il PRIMO atto del lancio, prima di
 * qualunque effetto. Tutti i dati si risolvono e si validano in sola lettura
 * prima della chiamata: qui si rifiuta ogni forma fuori dal chiuso, prima di
 * toccare il disco. `res` e' solo della famiglia vl (owner e root canonica
 * derivate dal nodo e dalla cella, mai da input esterno). Restituisce
 * { ok: true } oppure { ok: false, motivo, pubblicato } dove `pubblicato`
 * vale 'no' (record precedente intatto) o 'incerto' (rename fatto, fsync no).
 * Mai throw.
 */
function registraPrepared(root, sessione, {
  launchId, family, cellId, ownerInstanceId = null, tmuxSocket = '', bootId = null,
  pidNs = null, daemonInc, res = null, ora = null,
} = {}) {
  try {
    const rifiuto = (motivo) => ({ ok: false, motivo, pubblicato: 'no' });
    if (!root || typeof root !== 'string') return rifiuto('root');
    if (!sessioneValida(sessione)) return rifiuto('sessione');
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return rifiuto('launchId');
    if (family !== 'vl' && family !== 'other') return rifiuto('family');
    if (!stringaNonVuota(cellId)) return rifiuto('cellId');
    if (!stringaNonVuota(daemonInc, 128)) return rifiuto('daemonInc');
    if (typeof tmuxSocket !== 'string' || !tmuxSocket.startsWith('/')) return rifiuto('socket');
    if (bootId !== null && !(typeof bootId === 'string' && RE_UUID.test(bootId))) return rifiuto('bootId');
    if (pidNs !== null && !(typeof pidNs === 'string' && /^[0-9]{1,20}$/.test(pidNs))) return rifiuto('pidNs');
    if (ownerInstanceId !== null && !(typeof ownerInstanceId === 'string' && RE_OWNER.test(ownerInstanceId))) {
      return rifiuto('owner');
    }
    let risorse = null;
    if (family === 'vl') {
      if (!res || typeof res !== 'object' || typeof res.vlOwner !== 'string' || !RE_OWNER.test(res.vlOwner)
        || typeof res.vlRoot !== 'string' || !path.isAbsolute(res.vlRoot) || ownerInstanceId !== res.vlOwner) {
        return rifiuto('res');
      }
      risorse = { vlOwner: res.vlOwner, vlRoot: res.vlRoot };
    } else if (res !== null) {
      return rifiuto('res');
    }
    const ts = ora == null ? NaN : Number(ora);
    const dato = {
      version: 2,
      phase: 'prepared',
      family,
      launchId,
      cellId,
      session: sessione,
      ownerInstanceId,
      tmuxSocket,
      bootId,
      pidNs,
      daemonInc,
      res: risorse,
      incerto: true,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    const esito = scriviAtomicoEsito(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
    return esito.ok ? { ok: true } : { ok: false, motivo: 'scrittura', pubblicato: esito.pubblicato };
  } catch (_) {
    return { ok: false, motivo: 'scrittura', pubblicato: 'incerto' };
  }
}

// Campi che ogni fase d'arrivo ammette (e quelli obbligatori): l'avanzamento
// non accetta altro, cosi' un chiamante non puo' scrivere dati di una fase in
// un'altra. Ogni valore e' validato nella forma chiusa prima di toccare il disco.
const CAMPI_FASE = Object.freeze({
  creating: { obbligatori: [], opzionali: [] },
  created: {
    obbligatori: ['sessionId', 'windowId', 'paneId'],
    opzionali: ['serverPid', 'serverStarttime', 'holdPid', 'holdStarttime'],
  },
  attested: { obbligatori: ['panePid'], opzionali: ['paneStarttime', 'serverPid'] },
  [FASE_ABORTITA]: { obbligatori: ['abortReason'], opzionali: [] },
});

function campoValido(nome, v) {
  switch (nome) {
    case 'sessionId': return typeof v === 'string' && RE_SESSIONE_TMUX.test(v);
    case 'windowId': return typeof v === 'string' && RE_FINESTRA_TMUX.test(v);
    case 'paneId': return typeof v === 'string' && RE_PANE_TMUX.test(v);
    case 'serverPid':
    case 'holdPid': return v === null || interoPositivo(v);
    case 'panePid': return interoPositivo(v);
    case 'serverStarttime':
    case 'holdStarttime': return v === null || Number.isFinite(v);
    case 'paneStarttime': return Number.isFinite(v);
    case 'abortReason': return MOTIVI_ABORT.includes(v);
    default: return false;
  }
}

/**
 * Fa avanzare il record del lancio di UNA fase, con una scrittura durevole.
 * Condizioni, tutte verificate sul record LETTO sotto la serializzazione del
 * chiamante (stessa esclusione di up/down): record v2 presente e qualificato,
 * stesso launchId, fase corrente uguale a `da`, transizione monotona ammessa,
 * campi della sola fase d'arrivo e nella forma chiusa. Mai un passo indietro.
 * Esito: { ok: true } oppure { ok: false, codice, pubblicato? } — `codice` in
 * argomenti|assente|illeggibile|legacy|non-qualificato|launch-diverso|
 * fase-diversa|transizione|campi|scrittura. Con codice `scrittura`,
 * `pubblicato: 'incerto'` significa che la fase nuova PUO' essere gia'
 * visibile: il chiamante non deve tornare indietro ne' avviare processi.
 * Mai throw.
 */
function avanza(root, sessione, { launchId, da, a, campi = {}, ora = null } = {}) {
  try {
    if (!root || typeof root !== 'string' || !sessioneValida(sessione)) return { ok: false, codice: 'argomenti' };
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return { ok: false, codice: 'argomenti' };
    const consentite = TRANSIZIONI[da];
    if (!consentite || !consentite.includes(a)) return { ok: false, codice: 'transizione' };
    const schema = CAMPI_FASE[a];
    if (!campi || typeof campi !== 'object' || Array.isArray(campi)) return { ok: false, codice: 'campi' };
    for (const k of Object.keys(campi)) {
      if (!schema.obbligatori.includes(k) && !schema.opzionali.includes(k)) return { ok: false, codice: 'campi' };
      if (!campoValido(k, campi[k])) return { ok: false, codice: 'campi' };
    }
    for (const k of schema.obbligatori) {
      if (!(k in campi)) return { ok: false, codice: 'campi' };
    }
    let raw;
    try {
      raw = fs.readFileSync(percorso(root, sessione), 'utf8');
    } catch (e) {
      return { ok: false, codice: e && e.code === 'ENOENT' ? 'assente' : 'illeggibile' };
    }
    let dato;
    try { dato = JSON.parse(raw); } catch (_) { return { ok: false, codice: 'illeggibile' }; }
    if (!dato || typeof dato !== 'object') return { ok: false, codice: 'illeggibile' };
    if (dato.version !== 2) return { ok: false, codice: dato.version === undefined || dato.version === 1 ? 'legacy' : 'illeggibile' };
    const letto = leggiV2(dato, sessione);
    if (letto.stato !== 'presente') return { ok: false, codice: 'illeggibile' };
    if (!letto.record.qualificato) return { ok: false, codice: 'non-qualificato' };
    if (letto.record.launchId !== launchId) return { ok: false, codice: 'launch-diverso' };
    if (letto.record.phase !== da) return { ok: false, codice: 'fase-diversa' };
    const ts = ora == null ? NaN : Number(ora);
    const nuovo = {
      ...dato,
      ...campi,
      phase: a,
      incerto: a !== 'attested',
      ts: Number.isFinite(ts) ? ts : Date.now(),
    };
    // Il record risultante deve essere coerente e QUALIFICATO per la fase
    // d'arrivo PRIMA di toccare il disco (per esempio una nascita senza PID).
    const risultante = leggiV2(nuovo, sessione);
    if (risultante.stato !== 'presente' || !risultante.record.qualificato || risultante.record.phase !== a) {
      return { ok: false, codice: 'campi' };
    }
    const esito = scriviAtomicoEsito(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(nuovo)}\n`);
    return esito.ok ? { ok: true } : { ok: false, codice: 'scrittura', pubblicato: esito.pubblicato };
  } catch (_) {
    return { ok: false, codice: 'scrittura', pubblicato: 'incerto' };
  }
}

/**
 * Rimuove il record SOLO se e' quello di `launchId`: assenza = successo, un
 * record di un altro lancio o non interpretabile NON si tocca (false). Stessa
 * durabilita' di rimuovi(). Mai throw.
 */
function rimuoviDelLancio(root, sessione, launchId) {
  try {
    if (!root || typeof root !== 'string' || !sessioneValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    let raw;
    try {
      raw = fs.readFileSync(percorso(root, sessione), 'utf8');
    } catch (e) {
      return !!(e && e.code === 'ENOENT');
    }
    let dato;
    try { dato = JSON.parse(raw); } catch (_) { return false; }
    if (!dato || typeof dato !== 'object' || dato.launchId !== launchId) return false;
    return rimuovi(root, sessione);
  } catch (_) {
    return false;
  }
}

/**
 * Rimuove il record dopo un teardown COMPLETATO (o quando il lancio fallisce
 * dopo averlo scritto). Assenza = successo: non c'e' niente da ripulire e
 * non e' un errore. Mai throw.
 */
function marcaIncerto(root, sessione) {
  try {
    const letto = leggi(root, sessione);
    if (letto.stato !== 'presente') return false;
    const raw = fs.readFileSync(percorso(root, sessione), 'utf8');
    const dato = JSON.parse(raw);
    dato.incerto = true;
    return scriviAtomico(path.join(root, DIR), `${sessione}.json`, `${JSON.stringify(dato)}\n`);
  } catch (_) {
    return false;
  }
}

// La rimozione e' un COMMIT, non un suggerimento: l'unlink da solo vive
// nella cache della directory. Senza fsync della directory il record puo'
// riapparire dopo un crash e la barriera sparire da un processo vivo che
// credeva il lancio chiuso. Successo (true) solo quando la rimozione e'
// durevole; un errore di sync lascia il chiamante sul conservative «record
// ancora presente».
function rimuovi(root, sessione) {
  try {
    if (!root || typeof root !== 'string') return false;
    if (!sessioneValida(sessione)) return false;
    fs.unlinkSync(percorso(root, sessione));
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    return false;
  }
  try {
    fsyncDir(path.join(root, DIR));
    return true;
  } catch (_) {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Commit della riconciliazione: quarantena del record e journal di commit.
//
// Il record di un lancio riconciliato non si cancella: si SPOSTA in
// launch-targets/reconciled/ (directory privata 0700, file 0600, mai
// sovrascritto, mai potato). Il commit e' una sequenza di passi ognuno
// durevole, con un journal minimo `.commit-<sessione>.json` scritto PRIMA di
// toccare il record: se il processo muore o un fsync fallisce a meta', il
// journal dice cosa completare e finche' esiste nessun lancio puo' partire.
//   1. journal (sha256 + percorso della quarantena)    -- barriera durevole
//   2. copia in quarantena (O_EXCL, fsync file, fsync directory)
//      EEXIST: contenuto IDENTICO = ripresa verificata, DIVERSO = blocco
//   3. rilettura del record: stessi byte, launchId e fase
//   4. unlink del record + fsync della directory dei record
//      unlink riuscito ma fsync fallito = esito INCERTO: il journal resta
//   5. rimozione del journal (+ fsync)
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const DIR_QUARANTENA = 'reconciled';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function percorsoJournal(root, sessione) {
  return path.join(root, DIR, `.commit-${sessione}.json`);
}

function percorsoQuarantena(root, sessione, launchId) {
  return path.join(root, DIR, DIR_QUARANTENA, `${sessione}-${launchId}.json`);
}

/**
 * Byte esatti del record e loro sha256, per il confronto prima e dopo le
 * azioni correlate. { stato: 'presente', bytes, sha256 } | { stato: 'assente' }
 * | { stato: 'indeterminato' }. Mai throw.
 */
function leggiGrezzo(root, sessione) {
  try {
    if (!root || typeof root !== 'string' || !sessioneValida(sessione)) return { stato: 'indeterminato' };
    let bytes;
    try {
      bytes = fs.readFileSync(percorso(root, sessione));
    } catch (e) {
      return { stato: e && e.code === 'ENOENT' ? 'assente' : 'indeterminato' };
    }
    return { stato: 'presente', bytes, sha256: sha256Hex(bytes) };
  } catch (_) {
    return { stato: 'indeterminato' };
  }
}

function dirQuarantenaPronta(root) {
  const dir = path.join(root, DIR, DIR_QUARANTENA);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o777) !== 0o700) return null;
    // Il nome di una directory appena creata vive nella directory padre: va
    // sincronizzato PRIMA che il record attivo possa essere tolto.
    fsyncDir(path.join(root, DIR));
    return dir;
  } catch (_) { return null; }
}

// Legge un backup di quarantena SENZA seguire link e solo se e' un file
// regolare, nostro, 0600 e con un solo nome. Ritorna i byte o null.
function leggiBackupQualificato(dest) {
  let fd = null;
  try {
    fd = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if ((st.mode & 0o777) !== 0o600 || st.nlink !== 1) return null;
    return fs.readFileSync(fd);
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
}

// Scrive la quarantena con O_EXCL. EEXIST con byte identici = ripresa.
function scriviQuarantena(root, sessione, launchId, bytes, sha) {
  const dir = dirQuarantenaPronta(root);
  if (!dir) return { ok: false, codice: 'dir-quarantena' };
  const dest = percorsoQuarantena(root, sessione, launchId);
  let fd = null;
  try {
    fd = fs.openSync(dest, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const esistente = leggiBackupQualificato(dest);
      if (esistente === null) return { ok: false, codice: 'quarantena-non-qualificata' };
      if (sha256Hex(esistente) !== sha) return { ok: false, codice: 'quarantena-diversa' };
      // Ripresa verificata: il backup c'e', e' qualificato ed e' identico. Si
      // ri-sincronizza comunque (file e directory) prima di fidarsene.
      try {
        const f2 = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(f2); } finally { fs.closeSync(f2); }
        fsyncDir(dir);
      } catch (_) { return { ok: false, codice: 'quarantena-sync' }; }
      return { ok: true, ripresa: true, dest };
    }
    return { ok: false, codice: 'quarantena-apertura' };
  }
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(dir);
  } catch (_) {
    return { ok: false, codice: 'quarantena-scrittura' };
  }
  return { ok: true, ripresa: false, dest };
}

/**
 * Completa il commit della riconciliazione di un record. `atteso` porta lo
 * sha256 dei byte letti all'inizio, il launchId e la fase: se il record sul
 * disco non e' piu' quello, non si fa niente. Esito:
 *   { ok: true }
 *   { ok: false, codice, incompleto? } — `incompleto` = il journal e' sul
 *   disco e il commit va completato (completaCommit) prima di ogni lancio.
 * Mai throw.
 */
function riconciliaRecord(root, sessione, atteso) {
  try {
    if (!root || typeof root !== 'string' || !sessioneValida(sessione)) return { ok: false, codice: 'argomenti' };
    if (!atteso || typeof atteso.launchId !== 'string' || !RE_ID_LANCIO.test(atteso.launchId)
      || typeof atteso.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(atteso.sha256)) {
      return { ok: false, codice: 'argomenti' };
    }
    const prima = leggiGrezzo(root, sessione);
    if (prima.stato !== 'presente') return { ok: false, codice: prima.stato === 'assente' ? 'assente' : 'illeggibile' };
    if (prima.sha256 !== atteso.sha256) return { ok: false, codice: 'cambiato' };
    let dato;
    try { dato = JSON.parse(prima.bytes.toString('utf8')); } catch (_) { return { ok: false, codice: 'illeggibile' }; }
    if (!dato || dato.launchId !== atteso.launchId) return { ok: false, codice: 'cambiato' };
    if (atteso.fase !== undefined && (dato.phase || null) !== (atteso.fase || null)) return { ok: false, codice: 'cambiato' };
    const dest = percorsoQuarantena(root, sessione, atteso.launchId);
    // 1. barriera durevole PRIMA di toccare il record.
    const journal = {
      v: 1, sessione, launchId: atteso.launchId, sha256: atteso.sha256,
      quarantena: path.relative(path.join(root, DIR), dest),
    };
    const j = scriviAtomicoEsito(path.join(root, DIR), `.commit-${sessione}.json`, `${JSON.stringify(journal)}\n`);
    if (!j.ok) return { ok: false, codice: 'journal', incompleto: j.pubblicato === 'incerto' };
    return eseguiCommit(root, sessione, journal);
  } catch (_) {
    return { ok: false, codice: 'commit' };
  }
}

// Passi 2-5, idempotenti: valgono sia per il commit appena iniziato sia per la
// ripresa da un journal rimasto sul disco.
function eseguiCommit(root, sessione, journal) {
  const corrente = leggiGrezzo(root, sessione);
  if (corrente.stato === 'indeterminato') return { ok: false, codice: 'illeggibile', incompleto: true };
  const dest = path.join(root, DIR, journal.quarantena);
  if (corrente.stato === 'presente') {
    if (corrente.sha256 !== journal.sha256) return { ok: false, codice: 'cambiato', incompleto: true };
    // 2. quarantena (ripresa se identica)
    const q = scriviQuarantena(root, sessione, journal.launchId, corrente.bytes, journal.sha256);
    if (!q.ok) return { ok: false, codice: q.codice, incompleto: true };
    // 3. rilettura al commit: stessi byte
    const ancora = leggiGrezzo(root, sessione);
    if (ancora.stato !== 'presente' || ancora.sha256 !== journal.sha256) {
      return { ok: false, codice: 'cambiato', incompleto: true };
    }
    // 4. unlink + fsync della directory dei record
    try {
      fs.unlinkSync(percorso(root, sessione));
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) return { ok: false, codice: 'unlink', incompleto: true };
    }
  } else {
    // Record gia' tolto (ripresa dopo unlink): la quarantena deve esserci ed essere identica.
    if (!dirQuarantenaPronta(root)) return { ok: false, codice: 'dir-quarantena', incompleto: true };
    let q;
    try { fs.lstatSync(dest); } catch (_) { return { ok: false, codice: 'quarantena-mancante', incompleto: true }; }
    q = leggiBackupQualificato(dest);
    if (q === null) return { ok: false, codice: 'quarantena-non-qualificata', incompleto: true };
    if (sha256Hex(q) !== journal.sha256) return { ok: false, codice: 'quarantena-diversa', incompleto: true };
  }
  try {
    fsyncDir(path.join(root, DIR));
  } catch (_) {
    return { ok: false, codice: 'fsync-incerto', incompleto: true };
  }
  // 5. journal
  try {
    fs.unlinkSync(percorsoJournal(root, sessione));
    fsyncDir(path.join(root, DIR));
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) return { ok: true, journalResiduo: true };
  }
  return { ok: true };
}

/**
 * Se un commit di riconciliazione e' rimasto a meta' (journal sul disco) lo
 * completa; finche' non e' completato NESSUN lancio puo' partire. Esito:
 *   { stato: 'nessuno' }
 *   { stato: 'completato' }
 *   { stato: 'bloccato', codice }
 * Mai throw.
 */
function completaCommit(root, sessione) {
  try {
    if (!root || typeof root !== 'string' || !sessioneValida(sessione)) return { stato: 'bloccato', codice: 'argomenti' };
    let raw;
    try {
      raw = fs.readFileSync(percorsoJournal(root, sessione), 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { stato: 'nessuno' };
      return { stato: 'bloccato', codice: 'journal-illeggibile' };
    }
    let journal;
    try { journal = JSON.parse(raw); } catch (_) { return { stato: 'bloccato', codice: 'journal-illeggibile' }; }
    if (!journal || journal.v !== 1 || journal.sessione !== sessione
      || typeof journal.launchId !== 'string' || !RE_ID_LANCIO.test(journal.launchId)
      || typeof journal.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(journal.sha256)
      || journal.quarantena !== path.relative(path.join(root, DIR), percorsoQuarantena(root, sessione, journal.launchId))) {
      return { stato: 'bloccato', codice: 'journal-non-valido' };
    }
    const r = eseguiCommit(root, sessione, journal);
    return r.ok ? { stato: 'completato' } : { stato: 'bloccato', codice: r.codice };
  } catch (_) {
    return { stato: 'bloccato', codice: 'commit' };
  }
}

module.exports = {
  registra, registraIntent, registraPrepared, avanza, leggi, rimuovi, rimuoviDelLancio, marcaIncerto,
  leggiGrezzo, riconciliaRecord, completaCommit, percorsoQuarantena, percorsoJournal,
  FASI, FASE_ABORTITA, DIR, DIR_QUARANTENA,
};
