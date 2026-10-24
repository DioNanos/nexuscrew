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
//   2. SCADUTO NON E' IDLE — MA NON PER TUTTI. Oltre la finestra si torna
//      `null`, che la UI mostra come «non verificato»: mai affermare «ferma»
//      su un dato che non verifica nulla. La finestra copre un caso preciso:
//      un turno al LAVORO interrotto con Ctrl-C non emette alcun evento
//      (misurato su Claude Code 2.1.280), quindi senza scadenza resterebbe
//      «al lavoro» per sempre. Su «ferma» non serve, ed e' anzi dannosa: e'
//      uno stato che resta vero, e la fine del processo lo invalida gia' con
//      la generazione (regola 3). Vedi EVENTI_SENZA_SCADENZA.
//   3. GENERAZIONE: lo stato di un lancio precedente della stessa cella non
//      vale per quello corrente. La generazione corrente la scrive il launcher
//      (activity.gen); se il launcher ne dichiara una, un file che ne porta
//      un'altra — o che non ne porta AFFATTO — viene scartato: senza
//      generazione il dato non e' legato ad alcun lancio, e con «ferma» che non
//      scade piu' resterebbe vero per sempre. Se invece il launcher non ne
//      dichiara una (formato storico, celle senza hook), il file vale com'e'.
//      La generazione da sola non basta al RIAVVIO INTERNO del client: quello
//      avviene dentro lo stesso lancio, quindi la generazione non cambia e il
//      supervisore deve dichiarare l'uscita (vedi USCITA).
//   4. LETTURA TOLLERANTE: file assente, illeggibile o JSON rotto -> null, mai
//      un'eccezione: la lista delle sessioni non deve fallire per questo.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NOME_FILE = 'activity.json';
const NOME_GENERAZIONE = 'activity.gen';

// ── Record terminale del supervisore (per lancio) ──────────────────────────
//
// La ragione terminale del supervisore (tetto di restart raggiunto, consegna
// incerta, lease persa, errore di spawn, stop dell'operatore) sopravvive alla
// scomparsa del pane: viene pubblicata in un FILE proprio, identificato dal
// lancio, nella stessa directory di sessione dell'attivita'. Gli hook del
// client continuano a scrivere SOLO activity.json: non possono cancellare la
// diagnosi terminale. Un selettore `launch-current` dice qual e' il lancio
// vivo: la diagnosi di un lancio precedente non venga mai presentata come
// quella del lancio corrente, e un evento tardivo di un supervisore vecchio
// riscrive al piu' il proprio record vecchio.
//
// Niente testo libero nel record: solo versione, evento, ragione dell'enum
// chiuso, lancio e timestamp civile (il lettore usa Date.now).
const NOME_SELETTORE_LANCIO = 'launch-current';
const PREFIX_RECORD_TERMINALE = 'terminal-';
const ESTENSIONE_TERMINALE = '.json';
const EVENTO_TERMINALE = 'terminal-stop';
const VERSIONE_TERMINALE = 1;
const RAGIONI_TERMINALI = Object.freeze([
  'restart-budget-exhausted',
  'uncertain-delivery',
  'lease-lost',
  'spawn-error',
  'operator-stop',
]);
// Retention bounded dei record terminali: al lancio si conservano gli ultimi
// RETENTION_TERMINALI, il resto si pruna. Privato, best-effort, mai throw.
const RETENTION_TERMINALI = 8;
// Il lancio finisce nel NOME di un file: solo caratteri sicuri, mai separatori.
const RE_ID_LANCIO = /^[A-Za-z0-9._-]{1,128}$/;

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
  // `Interrupt` NON e' un evento di Claude Code: e' l'equivalente che codex
  // emette quando il turno viene interrotto, e per le celle codex e' l'unico
  // segnale che dice «ferma» in quel caso. Sta qui e non in una mappa separata
  // perche' il significato e' lo stesso — un turno finito senza esito.
  Interrupt: FERMA,
});

const TIPO_PERMESSO = 'permission_prompt';

// Gli eventi che NON scadono con l'eta'. Sono quelli che dicono «ferma»: un
// turno finito resta finito, e non c'e' nessun Ctrl-C da coprire — se il
// processo muore, `activity.gen` cambia e lo stato viene scartato comunque
// dalla regola 3. Farli scadere significava mostrare «non verificata» una
// cella che aveva appena finito il turno, per il solo passare del tempo.
const EVENTI_SENZA_SCADENZA = Object.freeze(['Stop', 'Interrupt']);

// L'evento con cui il SUPERVISORE dichiara che il client e' uscito. Non e' un
// evento del client — il client che muore non ha modo di scriverlo — e non e'
// una transizione: dice che il processo che pubblicava lo stato non c'e' piu',
// quindi che il dato precedente non e' piu' verificabile. `statoDaEvento` lo
// mappa a null, e non e' registrabile dagli hook (`daRegistrare` lo ignora): lo
// scrive `cell-exec` con `scriviStato`.
//
// Perche' serve, ora che «ferma» non scade: il supervisore riavvia il client
// DENTRO lo stesso lancio (cell-exec.js:781-830), quindi `activity.gen` non
// cambia e la regola 3 non puo' accorgersi che il client precedente e' morto.
// Senza questo evento uno `Stop` dell'ultimo turno resterebbe «ferma» per tutto
// il backoff — e per sempre, se il nuovo client non emette hook.
const USCITA = 'ClientExit';

// L'evento di LANCIO: lo scrive `cell-exec` all'avvio del lancio, PRIMA di
// pubblicare la generazione. Non dichiara uno stato — invalida quello che c'e'
// (il lettore lo mappa a null, come l'uscita): senza, lo stato lasciato dal
// client precedente sopravviverebbe al lancio nuovo.
const AVVIO = 'Launch';

// La seconda riga del file di generazione dichiara che il supervisore di questo
// lancio GARANTISCE l'evento di uscita. Senza quel segno — un lancio di un
// supervisore vecchio (0.9.41, 0.9.42-dev.0) — «ferma» e «interrotta» tornano a
// scadere come prima.
const SEGNO_USCITA = 'exit:1';

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
  // L'uscita del client e il lancio non dichiarano uno stato: invalidano
  // quello che c'e'.
  if (evento === USCITA || evento === AVVIO) return null;
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

// Il file di generazione per intero: la PRIMA riga e' la generazione, e la
// presenza del segno `exit:1` dice se il supervisore di questo lancio garantisce
// l'invalidazione all'uscita.
//
// LA SECONDA RIGA NON VIENE FRAINTESA DA UN LETTORE VECCHIO. La 0.9.41 legge il
// file con un `trim()` del contenuto intero e lo confronta con la generazione
// dell'evento: con due righe il confronto non torna, quindi gli eventi vengono
// scartati e la cella risulta «non verificato». Degrada, non crede a uno stato
// vecchio — ed e' la direzione giusta. Provato in
// tests/fleet-activity-genfile-compat.test.js col lettore della 0.9.41 vero.
function leggiGenerazione(dirSessione) {
  try {
    const righe = fs.readFileSync(path.join(dirSessione, NOME_GENERAZIONE), 'utf8').split('\n');
    const generazione = String(righe[0] || '').trim();
    if (!generazione) return { generazione: null, uscitaGarantita: false };
    return {
      generazione,
      uscitaGarantita: righe.slice(1).some((riga) => riga.trim() === SEGNO_USCITA),
    };
  } catch (_) { return { generazione: null, uscitaGarantita: false }; }
}

function leggiGenerazioneCorrente(dirSessione) {
  return leggiGenerazione(dirSessione).generazione;
}

/**
 * Scrive la generazione corrente della cella. Chiamata dal launcher al momento
 * del lancio: e' l'unico scrittore di questo file.
 */
function scriviGenerazione(dirSessione, generazione, { uscitaGarantita = false } = {}) {
  if (typeof generazione !== 'string' || !generazione) return false;
  // Il chiamante che non dice niente scrive il formato storico (una riga): e' il
  // caso di un lancio di cui non si garantisce l'invalidazione all'uscita.
  const contenuto = uscitaGarantita ? `${generazione}\n${SEGNO_USCITA}` : generazione;
  const destinazione = path.join(dirSessione, NOME_GENERAZIONE);
  let tmp = null;
  try {
    fs.mkdirSync(dirSessione, { recursive: true });
    // Stessa ragione di `scriviStato`: un nome di temporaneo condiviso perde la
    // scrittura di chi arriva secondo. Qui il rischio e' piu' basso (il
    // launcher e' l'unico scrittore), ma il difetto sarebbe identico.
    tmp = tmpUnivoco(dirSessione, NOME_GENERAZIONE);
    fs.writeFileSync(tmp, contenuto, { encoding: 'utf8', mode: 0o600 });
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
 * USCITA DEL CLIENT: `ClientExit` e' AUTOREVOLE e vince SEMPRE sull'ordine dei
 * timestamp. Quando il client esce, ogni stato gia' pubblicato — anche uno
 * `Stop` con un ts nel futuro tollerato, che descriveva lo stesso client —
 * descrive una cosa che non esiste piu'. Se un ts pubblicato e' piu' avanti di
 * quello dell'uscita, l'uscita si ripubblica con `ts = max(ora, ts
 * pubblicato + 1)`: subito dopo lo stato da invalidare, mai nel futuro che il
 * lettore scarta. Un hook ordinario invece NON vince: viene scartato.
 *
 * Ritorna `true` quando l'evento e' stato SCRITTO, `false` quando e' stato
 * SCARTATO — «il tuo evento non e' nel deposito». Chi chiama puo' quindi
 * distinguere, e l'uscita del client registrata a mano in cell-exec segnala
 * il caso invece di perderlo.
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
      if (pubblicato !== null && pubblicato > ora) {
        if (evento === USCITA || evento === AVVIO) {
          // L'uscita del client vince sull'ordine: subito dopo lo stato
          // pubblicato, mai nel futuro che il lettore scarta.
          dato.ts = pubblicato + 1;
        } else {
          // Un hook piu' vecchio dello stato pubblicato non lo riporta
          // indietro: scartato, e lo scarto e' un esito, non un successo.
          return false;
        }
      }
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
    // Il futuro resta scartato per TUTTI: un ts avanti non deve restare fresco
    // per sempre, e vale anche per gli eventi che non scadono.
    if (ts - ora > FUTURO_TOLLERATO_MS) return null;

    // Generazione: se il launcher ne ha dichiarata una, il file deve portare
    // ESATTAMENTE quella. Non basta il mismatch: un file SENZA generazione non
    // e' legato ad alcun lancio, e finche' ogni stato scadeva il caso era
    // coperto dalla finestra — ora che «ferma» non scade piu', un vecchio `Stop`
    // senza generazione resterebbe vero attraverso i lanci successivi.
    // La generazione la DEVE dichiarare l'evento, e deve essere quella su disco.
    // Un evento senza generazione non e' legato ad alcun lancio (gli hook la
    // dichiarano nel comando dell'hook): nessuno puo' invalidarlo, e con «ferma» che non scade
    // resterebbe vero per sempre. Non c'e' piu' compatibilita' col formato
    // senza generazione: quel formato non esiste piu' sul campo.
    const { generazione: corrente, uscitaGarantita } = leggiGenerazione(dir);
    const dalFile = typeof dato.generation === 'string' && dato.generation ? dato.generation : null;
    if (!dalFile) return null;
    if (!corrente || corrente !== dalFile) return null;

    const stato = statoDaEvento(dato.event, dato.notification_type);
    if (!stato) return null;
    // La scadenza si applica DOPO aver conosciuto l'evento: serve sapere se
    // questo stato e' uno di quelli che restano veri («ferma») o uno che senza
    // rinnovo non verifica piu' niente (lavoro, attesa).
    // «ferma» e «interrotta» non scadono SOLO dove il supervisore del lancio
    // garantisce l'evento di uscita: e' quella garanzia a invalidarle quando il
    // client muore. Senza (supervisore vecchio) scadono come nella 0.9.41, e la
    // cella torna «non verificato» invece di dire «ferma» per ore su un client
    // che nessuno invalidera'.
    if (!(EVENTI_SENZA_SCADENZA.includes(dato.event) && uscitaGarantita)
      && ora - ts > MASSIMA_ETA_MS) return null;
    return {
      stato,
      ts,
      sessionId: typeof dato.session_id === 'string' ? dato.session_id : null,
      generazione: dalFile,
    };
  } catch (_) { return null; }
}

// ── Implementazione del canale terminale ───────────────────────────────────
//
// Stessa disciplina di scriviGenerazione/scriviStato: temporaneo ESCLUSIVO +
// rename nella stessa directory (mai un file a meta' per il lettore), mode
// 0600, directory 0700. Il chiamante CONTROLLA l'esito: `true` e' l'unica
// prova che il record e' su disco — ogni altro valore va dichiarato
// («diagnosi non disponibile»), mai trasformato in un successo implicito.

function scriviAtomico(dirSessione, nome, contenuto) {
  const destinazione = path.join(dirSessione, nome);
  let tmp = null;
  try {
    fs.mkdirSync(dirSessione, { recursive: true, mode: 0o700 });
    tmp = tmpUnivoco(dirSessione, nome);
    fs.writeFileSync(tmp, contenuto, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, destinazione);
    return true;
  } catch (_) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    return false;
  }
}

function ragioneTerminaleValida(reason) {
  return RAGIONI_TERMINALI.includes(reason);
}

/**
 * Pubblica la ragione terminale del supervisore per QUESTO lancio.
 * Il file e' `terminal-<launchId>.json`: il supervisore del lancio X scrive
 * SOLO il proprio record — un supervisore vecchio non puo' toccare quello di
 * un lancio nuovo. Ritorna `true` solo se il record e' su disco.
 */
function scriviRecordTerminale(dirSessione, { launchId, reason, ora = Date.now() } = {}) {
  if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
  if (!ragioneTerminaleValida(reason)) return false;
  const ts = Number(ora);
  if (!Number.isFinite(ts)) return false;
  const dato = {
    version: VERSIONE_TERMINALE,
    event: EVENTO_TERMINALE,
    reason,
    launchId,
    ts,
  };
  return scriviAtomico(dirSessione,
    `${PREFIX_RECORD_TERMINALE}${launchId}${ESTENSIONE_TERMINALE}`, `${JSON.stringify(dato)}\n`);
}

/**
 * Pubblica il selettore del lancio corrente (`launch-current`, contenente il
 * launchId). Lo pubblica SOLO chi avvia il lancio, una volta sola: essere
 * stati il vincitore di un lancio precedente non autorizza a spostare il
 * selettore di un lancio nuovo. Ritorna `true` solo se pubblicato.
 */
function pubblicaSelettoreLancio(dirSessione, launchId) {
  if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
  return scriviAtomico(dirSessione, NOME_SELETTORE_LANCIO, `${launchId}\n`);
}

/**
 * Il lancio selezionato da `launch-current`, oppure null (assente, illeggibile
 * o fuori schema). Mai throw.
 */
function leggiSelettoreLancio(dirSessione) {
  try {
    const raw = fs.readFileSync(path.join(dirSessione, NOME_SELETTORE_LANCIO), 'utf8');
    const id = String(raw).trim();
    return RE_ID_LANCIO.test(id) ? id : null;
  } catch (_) { return null; }
}

/**
 * Rimozione ONESTA del selettore. La usa il proprietario del ciclo di vita
 * quando NON riesce a pubblicare il selettore del lancio nuovo: la diagnosi
 * del lancio precedente non deve piu' essere presentata come attuale. `true`
 * se il selettore e' assente o e' stato rimosso, `false` solo su errore.
 * Mai throw.
 */
function rimuoviSelettoreLancio(dirSessione) {
  try {
    fs.unlinkSync(path.join(dirSessione, NOME_SELETTORE_LANCIO));
    return true;
  } catch (err) {
    return !!(err && err.code === 'ENOENT');
  }
}

/**
 * La diagnosi terminale DEL LANCIO SELEZIONATO: legge `launch-current` e da
 * li' il record `terminal-<id>.json`. Un record di un lancio che non e' piu'
 * selezionato non viene mai restituito: un nuovo lancio invalida la ragione
 * vecchia per costruzione. Ritorna `{ reason, ts, launchId }` oppure null per
 * assenza, selettore rotto, record rotto o schema inatteso. Mai throw.
 */
function leggiDiagnosiTerminale(root, sessione) {
  try {
    if (typeof sessione !== 'string' || !sessione) return null;
    if (sessione.includes('/') || sessione.includes('\\') || sessione === '..') return null;
    const dir = path.join(root, sessione);
    const id = leggiSelettoreLancio(dir);
    if (!id) return null;
    const raw = fs.readFileSync(
      path.join(dir, `${PREFIX_RECORD_TERMINALE}${id}${ESTENSIONE_TERMINALE}`), 'utf8');
    const dato = JSON.parse(raw);
    if (!dato || typeof dato !== 'object' || Array.isArray(dato)) return null;
    if (dato.version !== VERSIONE_TERMINALE || dato.event !== EVENTO_TERMINALE) return null;
    if (dato.launchId !== id) return null;
    if (!ragioneTerminaleValida(dato.reason)) return null;
    const ts = Number(dato.ts);
    if (!Number.isFinite(ts)) return null;
    return { reason: dato.reason, ts, launchId: id };
  } catch (_) { return null; }
}

/**
 * Retention bounded dei record terminali: conserva gli ultimi `conserva`
 * (per mtime), rimuove i piu' vecchi. Best-effort: un fallimento di
 * rimozione non e' un errore del lancio. Mai throw.
 */
function potaTerminali(dirSessione, { conserva = RETENTION_TERMINALI } = {}) {
  const rimossi = [];
  try {
    const nomi = fs.readdirSync(dirSessione)
      .filter((n) => n.startsWith(PREFIX_RECORD_TERMINALE) && n.endsWith(ESTENSIONE_TERMINALE));
    const voci = [];
    for (const n of nomi) {
      try { voci.push({ n, mtime: fs.statSync(path.join(dirSessione, n)).mtimeMs }); } catch (_) {}
    }
    voci.sort((a, b) => b.mtime - a.mtime);
    for (const voce of voci.slice(Math.max(0, conserva))) {
      try { fs.unlinkSync(path.join(dirSessione, voce.n)); rimossi.push(voce.n); } catch (_) {}
    }
  } catch (_) { /* directory assente: niente da potare */ }
  return rimossi;
}

module.exports = {
  leggiAttivita, scriviStato, scriviGenerazione, leggiGenerazione, leggiGenerazioneCorrente,
  statoDaEvento, daRegistrare, AVVIO, SEGNO_USCITA,
  scriviRecordTerminale, pubblicaSelettoreLancio, leggiSelettoreLancio,
  rimuoviSelettoreLancio, leggiDiagnosiTerminale, potaTerminali,
  NOME_FILE, NOME_GENERAZIONE, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS,
  LAVORA, FERMA, ATTESA, TIPO_PERMESSO, STATO_PER_EVENTO, USCITA,
  NOME_SELETTORE_LANCIO, EVENTO_TERMINALE, VERSIONE_TERMINALE, RAGIONI_TERMINALI,
  RETENTION_TERMINALI,
};
