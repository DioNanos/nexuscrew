'use strict';
// SNAPSHOT IMMUTABILE del lettore della 0.9.41 — non aggiornarlo.
//
// E' la copia ESATTA del file come e' stato pubblicato nella 0.9.41
// (`git show 55f8a9a:lib/files/activity.js` sulla linea di lavoro). Serve a
// `fleet-activity-genfile-compat.test.js` per provare che il formato nuovo del
// file di generazione (seconda riga `exit:1`) NON viene frainteso dal lettore
// vecchio.
//
// PERCHE' UNA COPIA E NON UNA LETTURA DA GIT: la storia del repository pubblico
// e' schiacciata a un commit per release, quindi `55f8a9a` la' non esiste — e un
// test che fallisce per l'assenza di un oggetto git non sta verificando niente
// (misurato: la CI della 0.9.42 e' diventata rossa esattamente per questo). Il
// valore di questo file e' la sua STALENZA: e' il lettore di allora, congelato.
// Se il lettore nuovo cambia, questo resta com'era.
//
// Nota: qui sotto c'e' il file originale, senza una riga di modifiche.
'use strict';
// Attivita' per-cella: lo stato del turno pubblicato dagli HOOK di Claude Code.
//
// Perche' un file proprio e non telemetry.json: la statusline e gli hook sono
// due scrittori indipendenti. Un read-modify-write non coordinato perde gli
// aggiornamenti dell'altro, e un timestamp unico farebbe sembrare fresco uno
// stato attività vecchio quando arrivano nuove percentuali. Due file, due
// contratti, un solo scrittore ciascuno.
//
// Il file NON contiene il payload dell'hook: quello porta il testo del prompt e
// i percorsi della sessione, che allo stato non servono. Solo l'evento, il
// timestamp, l'identita' della sessione e la generazione.
//
// Quattro regole, le stesse di telemetry.js ma con esito diverso:
//   1. TIMESTAMP OBBLIGATORIO e guardato nei DUE versi — oltre la finestra il
//      dato e' morto, e un ts nel futuro non deve restare fresco per sempre.
//   2. SCADUTO NON E' IDLE: oltre la finestra si torna `null`, che la UI mostra
//      come «non verificato». Mai affermare «ferma» su un dato che non
//      verifica nulla: e' l'unico modo di coprire l'interruzione con Ctrl-C,
//      che (misurato su Claude Code 2.1.280) NON emette alcun evento.
//   3. GENERAZIONE: lo stato di un lancio precedente della stessa cella non
//      vale per quello corrente. La generazione corrente la scrive il launcher
//      (activity.gen); un file che ne porta un'altra viene scartato.
//   4. LETTURA TOLLERANTE: file assente, illeggibile o JSON rotto -> null, mai
//      un'eccezione: la lista delle sessioni non deve fallire per questo.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NOME_FILE = 'activity.json';
const NOME_GENERAZIONE = 'activity.gen';

// Un turno che usa tool rinnova la freschezza a ogni PreToolUse/PostToolUse,
// quindi la finestra copre l'attesa fra un tool e il successivo. Un turno lungo
// SENZA tool puo' invece superarla: in quel caso lo stato diventa «non
// verificato», che e' l'esito voluto — meglio un'incertezza dichiarata di un
// «al lavoro» affermato senza prova.
const MASSIMA_ETA_MS = 5 * 60 * 1000;
const FUTURO_TOLLERATO_MS = 2 * 60 * 1000;

const LAVORA = 'lavora';
const FERMA = 'ferma';
const ATTESA = 'attesa';

// La matrice evento -> stato e' quella MISURATA nel Gate A su Claude Code
// 2.1.280, non quella attesa sulla carta. In particolare:
//  - `SubagentStop` NON chiude il turno: il principale sta ancora lavorando,
//    quindi rinnova la freschezza restando su «lavora». Usarlo come «ferma»
//    sarebbe un falso negativo (il figlio finisce, il padre no).
//  - `SessionEnd` non afferma «ferma»: quella sessione non esiste piu', e
//    quello che resta da dire e' che il dato non e' piu' verificabile.
//  - `Notification` vale solo se il tipo e' la richiesta di permesso: gli altri
//    tipi non sono stati misurati e non autorizzano nessuna transizione.
const STATO_PER_EVENTO = Object.freeze({
  SessionStart: FERMA,
  UserPromptSubmit: LAVORA,
  PreToolUse: LAVORA,
  PostToolUse: LAVORA,
  SubagentStop: LAVORA,
  Stop: FERMA,
  PermissionRequest: ATTESA,
});

const TIPO_PERMESSO = 'permission_prompt';

/**
 * Stato dichiarato da un evento, oppure null se l'evento non autorizza nessuna
 * transizione (o non e' un evento noto). Non lancia mai.
 */
function statoDaEvento(evento, tipoNotifica) {
  if (typeof evento !== 'string' || !evento) return null;
  if (evento === 'Notification') {
    return tipoNotifica === TIPO_PERMESSO ? ATTESA : null;
  }
  if (evento === 'SessionEnd') return null;
  return Object.prototype.hasOwnProperty.call(STATO_PER_EVENTO, evento)
    ? STATO_PER_EVENTO[evento]
    : null;
}

/**
 * Se questo evento debba essere SCRITTO sul file, oppure no.
 *
 * Non e' la stessa domanda di `statoDaEvento`. Due casi la separano:
 *  - `SessionEnd` non dichiara uno stato, ma DEVE essere scritto: e' cosi' che
 *    si invalida il dato di una sessione che non esiste piu' (il lettore,
 *    trovandolo, torna null). Non scriverlo lascerebbe in giro lo stato
 *    precedente — «lavora» o «ferma» — per tutta la finestra.
 *  - una `Notification` di tipo diverso da `permission_prompt` non deve
 *    TOCCARE il file: se scrivesse, sovrascriverebbe uno stato fresco e
 *    legittimo («al lavoro») con un evento che il lettore non sa mappare, e la
 *    cella diventerebbe «non verificata» mentre sta lavorando. Il caso e'
 *    COSTRUITO, non misurato: di `notification_type` e' stato osservato un solo
 *    valore (`permission_prompt`), gli altri non sono enumerati. La prudenza
 *    sta proprio qui — non si mappa cio' che non si e' misurato, e non si
 *    scrive un evento che poi il lettore scarterebbe.
 *
 * Un evento sconosciuto non scrive: non si tocca cio' che non si sa leggere.
 */
function daRegistrare(evento, tipoNotifica) {
  if (typeof evento !== 'string' || !evento) return false;
  if (evento === 'SessionEnd') return true;
  if (evento === 'Notification') return tipoNotifica === TIPO_PERMESSO;
  return Object.prototype.hasOwnProperty.call(STATO_PER_EVENTO, evento);
}

function leggiGenerazioneCorrente(dirSessione) {
  try {
    const raw = fs.readFileSync(path.join(dirSessione, NOME_GENERAZIONE), 'utf8').trim();
    return raw || null;
  } catch (_) { return null; }
}

/**
 * Scrive la generazione corrente della cella. Chiamata dal launcher al momento
 * del lancio: e' l'unico scrittore di questo file.
 */
function scriviGenerazione(dirSessione, generazione) {
  if (typeof generazione !== 'string' || !generazione) return false;
  const destinazione = path.join(dirSessione, NOME_GENERAZIONE);
  let tmp = null;
  try {
    fs.mkdirSync(dirSessione, { recursive: true });
    // Stessa ragione di `scriviStato`: un nome di temporaneo condiviso perde la
    // scrittura di chi arriva secondo. Qui il rischio e' piu' basso (il
    // launcher e' l'unico scrittore), ma il difetto sarebbe identico.
    tmp = tmpUnivoco(dirSessione, NOME_GENERAZIONE);
    fs.writeFileSync(tmp, generazione, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, destinazione);
    return true;
  } catch (_) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    return false;
  }
}

/**
 * Nome di un temporaneo ESCLUSIVO di questo processo.
 *
 * Non basta `file.tmp`: gli hook sono processi distinti che possono scrivere
 * nello stesso istante, e con un nome condiviso si sovrascrivono il temporaneo
 * a vicenda — il secondo `rename` trova il file gia' consumato e fallisce con
 * ENOENT, e quella scrittura e' persa. Uno `Stop` perso lascia la cella su
 * «lavora» fino alla scadenza: e' il sintomo che questo modulo esiste per
 * togliere. Stessa forma gia' usata per il profilo MCP di cella.
 */
function tmpUnivoco(dirSessione, nome) {
  return path.join(dirSessione, `${nome}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

// Sezione critica per cella, con un lock di file.
//
// Perche' non basta il ri-controllo prima del `rename`: due scrittori possono
// leggere lo stesso ts vecchio, scrivere i propri temporanei e pubblicare
// entrambi — l'ultimo `rename` vince, e puo' essere il piu' VECCHIO. Misurato:
// con ts ravvicinati l'evento piu' recente perdeva il confronto nel 12-20% dei
// giri. Il confronto e la pubblicazione devono stare nella stessa sezione
// critica, o l'ordinamento non e' garantito.
//
// Il lock ha un guasto proprio — un processo ucciso dentro la sezione critica
// lo lascia orfano — e per questo NON puo' bloccare nulla per sempre:
//  - un lock piu' vecchio di un secondo si considera orfano e viene scavalcato
//    (la sezione critica sono due syscall: un lock di un secondo non e' lavoro
//    in corso, e' un morto);
//  - se entro il budget non lo si ottiene, si scrive COMUNQUE. Nel caso
//    peggiore si torna al comportamento senza lock, che perde l'ordine in una
//    corsa stretta ma non perde mai una scrittura: marcire in silenzio sarebbe
//    peggio, perche' la cella resterebbe «al lavoro» per sempre.
const BUDGET_LOCK_MS = 2000;
const ETA_ORFANO_MS = 1000;

function conLock(dirSessione, fn) {
  const lock = path.join(dirSessione, `${NOME_FILE}.lock`);
  const scadenza = Date.now() + BUDGET_LOCK_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.closeSync(fd);
      try { return fn(); } finally { try { fs.unlinkSync(lock); } catch (_) {} }
    } catch (e) {
      if (e.code !== 'EEXIST') return fn(); // lock non praticabile: si scrive lo stesso
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > ETA_ORFANO_MS) { fs.unlinkSync(lock); continue; }
      } catch (_) { continue; } // sparito mentre lo si guardava
      if (Date.now() > scadenza) return fn();
      const fine = Date.now() + 2; while (Date.now() < fine); // attesa breve
    }
  }
}

// Il ts gia' pubblicato, o null se non c'e' / non e' leggibile.
function tsPubblicato(dirSessione) {
  try {
    const dato = JSON.parse(fs.readFileSync(path.join(dirSessione, NOME_FILE), 'utf8'));
    const ts = Number(dato && dato.ts);
    return Number.isFinite(ts) ? ts : null;
  } catch (_) { return null; }
}

/**
 * Scrittura atomica dello stato: temporaneo ESCLUSIVO + rename nella stessa
 * directory. Piu' hook possono scattare a raffica (PreToolUse/PostToolUse) e in
 * PROCESSI diversi, e un lettore non deve mai vedere un file a meta'.
 *
 * ORDINAMENTO: due hook possono arrivare invertiti — il processo di un evento
 * piu' vecchio puo' essere schedulato dopo quello di uno piu' recente. Decide
 * il `ts`: un evento piu' vecchio non riporta indietro lo stato, altrimenti una
 * `Stop` gia' registrata verrebbe cancellata da un `PreToolUse` in ritardo.
 *
 * Ritorna `true` quando il deposito riflette ALMENO questo evento — scritto, o
 * superato da uno piu' recente — e `false` solo su un guasto reale. La
 * differenza conta per chi chiama: `false` significa «il tuo evento non e' nel
 * deposito», mai «il tuo evento era vecchio».
 *
 * LIMITE DICHIARATO: se il lock non e' ottenibile entro il budget — caso
 * patologico, non misurato in esercizio — si scrive comunque, e allora resta la
 * corsa stretta fra due scrittori (l'evento piu' recente puo' perdere). Il
 * temporaneo esclusivo fa si' che anche in quel caso non si perda nessuna
 * scrittura e non si veda mai un file a meta': cambia solo CHI vince.
 */
function scriviStato(dirSessione, { evento, tipo, sessionId, generazione, ora = Date.now() } = {}) {
  if (typeof evento !== 'string' || !evento) return false;
  const dato = { event: evento, ts: ora };
  if (typeof sessionId === 'string' && sessionId) dato.session_id = sessionId;
  if (typeof generazione === 'string' && generazione) dato.generation = generazione;
  if (typeof tipo === 'string' && tipo) dato.notification_type = tipo;
  const destinazione = path.join(dirSessione, NOME_FILE);
  try {
    fs.mkdirSync(dirSessione, { recursive: true });
  } catch (_) { return false; }
  // Confronto e pubblicazione nella STESSA sezione critica: e' l'unico modo in
  // cui «l'evento piu' recente vince» e' una garanzia invece di una speranza.
  return conLock(dirSessione, () => {
    let tmp = null;
    try {
      const pubblicato = tsPubblicato(dirSessione);
      if (pubblicato !== null && pubblicato > ora) return true;
      tmp = tmpUnivoco(dirSessione, NOME_FILE);
      fs.writeFileSync(tmp, `${JSON.stringify(dato)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, destinazione);
      return true;
    } catch (_) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
      return false;
    }
  });
}

/**
 * Legge lo stato di attivita' di una sessione. Ritorna
 * `{ stato, ts, sessionId, generazione }`, oppure null per assenza,
 * dato scaduto, generazione superata, evento che non autorizza transizioni o
 * qualsiasi rottura. Non lancia MAI.
 */
function leggiAttivita(root, sessione, ora = Date.now()) {
  try {
    if (typeof sessione !== 'string' || !sessione) return null;
    // Un nome con separatori non deve poter uscire dalla root.
    if (sessione.includes('/') || sessione.includes('\\') || sessione === '..') return null;
    const dir = path.join(root, sessione);
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, NOME_FILE), 'utf8');
    } catch (_) { return null; }
    const dato = JSON.parse(raw);
    if (!dato || typeof dato !== 'object' || Array.isArray(dato)) return null;
    const ts = Number(dato.ts);
    if (!Number.isFinite(ts)) return null;
    if (ora - ts > MASSIMA_ETA_MS) return null;
    if (ts - ora > FUTURO_TOLLERATO_MS) return null;

    // Generazione: se il launcher ne ha dichiarata una e il file ne porta
    // un'altra, lo stato appartiene a un lancio precedente della stessa cella.
    const corrente = leggiGenerazioneCorrente(dir);
    const dalFile = typeof dato.generation === 'string' && dato.generation ? dato.generation : null;
    if (corrente && dalFile && corrente !== dalFile) return null;

    const stato = statoDaEvento(dato.event, dato.notification_type);
    if (!stato) return null;
    return {
      stato,
      ts,
      sessionId: typeof dato.session_id === 'string' ? dato.session_id : null,
      generazione: dalFile,
    };
  } catch (_) { return null; }
}

module.exports = {
  leggiAttivita, scriviStato, scriviGenerazione, statoDaEvento, daRegistrare,
  NOME_FILE, NOME_GENERAZIONE, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS,
  LAVORA, FERMA, ATTESA, TIPO_PERMESSO, STATO_PER_EVENTO,
};
