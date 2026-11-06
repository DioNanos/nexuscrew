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
// Contratto puro del record del prompt (schema, predicato dell'id, nome del
// file): UNA sola definizione, senza dipendenze da qui — activity.js la
// re-esporta per i propri lettori. Nessun ciclo: prompt-outcome non richiede
// nulla di questo modulo.
const { validLaunchId, validPromptRecord, nomeRecordPrompt, RE_LAUNCH_ID } = require('../fleet/prompt-outcome.js');

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
// UNA sola definizione della forma: la costante vive nel modulo puro e qui e'
// solo un alias, cosi' i registri storici continuano a usare il loro .test()
// con la stessa semantica di sempre (il predicato condiviso, che rifiuta `.`
// e `..`, e' un'altra cosa e serve al solo record del prompt).
const RE_ID_LANCIO = RE_LAUNCH_ID;

// ── Registro dei lanci del runtime (autorita' di lettura) ───────────────────
//
// Il selettore `launch-current` dentro la directory di sessione e' il canale
// pubblicato dal proprietario del ciclo di vita; ma se la pubblicazione
// FALLISCE — directory non scrivibile — sul disco resta la selezione del
// lancio PRECEDENTE, e un lettore che si fida del solo selettore mostrerebbe
// la diagnosi del vecchio lancio come se fosse quella del nuovo. Il registro
// e' la memoria del runtime: per ogni sessione, l'identita' del lancio
// corrente e lo stato del canale con cui e' stato dichiarato. Vive FUORI
// dalla directory di sessione (una directory dedicata sotto la root dei
// file): sopravvive al riavvio del runtime e resta scrivibile anche quando
// la directory di sessione non lo e'. Contiene solo identita' e stati, mai
// contenuti.
const NOME_DIR_REGISTRO_LANCI = 'launch-registry';
const EVENTO_REGISTRO_LANCIO = 'launch-registry';
const VERSIONE_REGISTRO_LANCIO = 1;
// 'selector': il selettore su disco e' quello del lancio corrente (o e' stato
//   onestamente rimosso) — si legge attraverso di lui, come sempre;
// 'none': pubblicazione E invalidazione fallite — il selettore su disco puo'
//   essere quello di un lancio precedente: si legge PER IDENTITA' il record
//   del lancio corrente, mai attraverso il selettore;
// 'off': canale disattivato per questo lancio (opt-out dell'operatore o
//   nessuna directory di sessione): nessuna diagnosi gli e' attribuita.
const STATI_CANALE_LANCIO = Object.freeze(['selector', 'none', 'off']);
// SECONDA LOCAZIONE del registro. La verita' corrente del ciclo di vita non
// puo' dipendere da una sola directory: se quella primaria non e' scrivibile
// e il lancio partisse lo stesso, dopo un riavvio del runtime l'ultimo
// record rimasto li' — quello del lancio PRECEDENTE — tornerebbe autorevole,
// e la diagnosi del vecchio lancio si presenterebbe come quella del nuovo.
// Il registro si scrive quindi in DUE directory separate sotto la root
// (primaria e riserva): la scrittura ha successo se ALMENO UNA delle due la
// accetta, e la lettura segue il record piu' recente fra le due. Chi scrive
// decide cosa fare quando NESSUNA delle due accetta (il runtime rifiuta il
// lancio): un log e una mappa in memoria non sopravvivono al riavvio e non
// sono una traccia durevole.
const NOME_DIR_REGISTRO_RISERVA = 'launch-registry-spare';

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

// ── Record dell'esito della consegna del prompt (per lancio) ────────────────
//
// Stessa directory privata del record terminale, ma disciplina di scrittura
// PIU' FORTE: il record del prompt e' la prova che il pending precede il
// paste, quindi la scrittura e' DUREVOLE — temporaneo esclusivo, fsync del
// file, rename, fsync della directory (e del genitore quando la directory
// nasce da questa chiamata). `scriviAtomico` qui sopra NON si tocca e NON si
// riusa: serve ad altri utenti, non fa fsync, e citarlo non attesterebbe
// durabilita'. Questo helper serve solo al record del prompt.

function fsyncDirectory(fsImpl, dirPath) {
  let fd = null;
  try {
    fd = fsImpl.openSync(dirPath, 'r');
    fsImpl.fsyncSync(fd);
  } finally {
    if (fd !== null && fd !== undefined) { try { fsImpl.closeSync(fd); } catch (_) {} }
  }
}

// Scrive TUTTO il buffer: writeSync puo' scrivere meno del richiesto e il suo
// valore di ritorno e' il numero di byte realmente scritti. Un ritorno non
// intero, <= 0 o oltre il residuo e' un mancato progresso: errore, mai un
// file troncato dato per completo.
function scriviTutto(fsImpl, fd, buf) {
  let scritti = 0;
  while (scritti < buf.length) {
    const n = fsImpl.writeSync(fd, buf, scritti, buf.length - scritti, null);
    if (!Number.isInteger(n) || n <= 0 || n > buf.length - scritti) {
      throw new Error('scrittura senza progresso');
    }
    scritti += n;
  }
}

// Le directory che la scrittura crea (dalla piu' profonda alla radice del
// ramo nuovo) e il primo antenato che ESISTEVA: tutte le entry di questa
// catena vanno impegnate, altrimenti la directory nuova potrebbe non esistere
// piu' dopo un crash anche se il file e' stato sincronizzato.
function catenaDaSincronizzare(fsImpl, dirSessione) {
  const create = [];
  let p = dirSessione;
  for (;;) {
    try { fsImpl.statSync(p); break; } catch (_) { /* non esiste: la crea questa chiamata */ }
    create.push(p);
    const su = path.dirname(p);
    if (su === p) break;
    p = su;
  }
  return Array.from(new Set([dirSessione, ...create, p]));
}

/**
 * Scrittura DUREVOLE nella directory di sessione. Ordine: temporaneo ESCLUSIVO
 * (wx, 0600) -> write COMPLETA -> fsync(file) -> close CONTROLLATO -> rename
 * -> fsync(directory) [-> fsync di ogni directory nata da questa chiamata e del
 * primo antenato preesistente]. Ogni passo fallito: unlink del temporaneo e
 * `false`, nessun file a meta'. Se a fallire e' un fsync di directory DOPO il
 * rename, la destinazione puo' essere gia' visibile: l'esito resta `false`
 * (durabilita' NON attestata) e la destinazione non si cancella alla cieca —
 * e' il limite classico del commit con risposta incerta, dichiarato, non
 * nascosto cancellando file.
 * `fsImpl` e' una dipendenza dei soli test, mai raggiungibile da payload,
 * config o ambiente del prodotto.
 */
function scriviDurabile(dirSessione, nome, contenuto, { fsImpl = fs } = {}) {
  const destinazione = path.join(dirSessione, nome);
  let tmp = null;
  try {
    const buf = Buffer.from(contenuto, 'utf8');
    const catena = catenaDaSincronizzare(fsImpl, dirSessione);
    fsImpl.mkdirSync(dirSessione, { recursive: true, mode: 0o700 });
    tmp = tmpUnivoco(dirSessione, nome);
    const fd = fsImpl.openSync(tmp, 'wx', 0o600);
    try {
      scriviTutto(fsImpl, fd, buf);
      fsImpl.fsyncSync(fd);
    } catch (e) {
      try { fsImpl.closeSync(fd); } catch (_) {}
      throw e;
    }
    // Un close che fallisce puo' nascondere un errore di scrittura differito:
    // non e' un dettaglio da ingoiare.
    fsImpl.closeSync(fd);
    fsImpl.renameSync(tmp, destinazione);
    tmp = null;
    for (const d of catena) fsyncDirectory(fsImpl, d);
    return true;
  } catch (_) {
    if (tmp) { try { fsImpl.unlinkSync(tmp); } catch (_) {} }
    return false;
  }
}

// Gli antenati da riattestare sopra la directory della sessione, dal genitore
// in su, SENZA il contesto della prima scrittura (che non c'e' piu'): si sale
// finche' gli antenati sono dell'utente — li puo' aver creati questo codice —
// e ci si ferma AL PRIMO che non lo e': e' il confine qualificato, perche'
// contiene l'entry del piu' alto antenato che possiamo aver creato, ma non
// l'abbiamo creato noi e non ne rispondiamo. Senza getuid (piattaforme che non
// lo hanno) ogni antenato conta come dell'utente fino alla radice.
function catenaAntenatiRiattestabili(fsImpl, dirSessione) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const catena = [];
  let p = path.dirname(dirSessione);
  if (p === dirSessione) return catena;
  for (;;) {
    let suo = true;
    // Uno stat che FALLISCE non e' una prova di non-proprieta': l'errore sale e
    // la riattestazione e' false. Il confine si riconosce solo da un UID
    // osservato e diverso.
    if (uid !== null) suo = fsImpl.statSync(p).uid === uid;
    catena.push({ p, suo });
    if (!suo) break;
    const su = path.dirname(p);
    if (su === p) break;
    p = su;
  }
  return catena;
}

// Riattesta l'impegno di un record GIA' visibile: fsync del file, della sua
// directory e di TUTTA la catena di antenati fino al confine di proprieta'.
// Non riscrive, non cambia mtime. Un antenato dell'utente che non si impegna
// rende l'esito false; uno che non e' dell'utente e la cui APERTURA e' negata
// (EACCES/EPERM) si salta: non lo abbiamo creato e non c'e' nulla da
// attestare. Ogni altro errore, ovunque — uno stat fallito, un fsync fallito
// dopo un open riuscito, un open con un altro codice — e' false.
function riattestaDurabile(dirSessione, nome, { fsImpl = fs } = {}) {
  try {
    const fd = fsImpl.openSync(path.join(dirSessione, nome), 'r');
    try {
      fsImpl.fsyncSync(fd);
    } catch (e) {
      try { fsImpl.closeSync(fd); } catch (_) {}
      throw e;
    }
    fsImpl.closeSync(fd);
    fsyncDirectory(fsImpl, dirSessione);
    for (const { p, suo } of catenaAntenatiRiattestabili(fsImpl, dirSessione)) {
      // L'eccezione vale SOLO per l'APERTURA negata di un antenato non proprio.
      // Un errore di fsync dopo un open riuscito, di qualunque codice, e' un
      // impegno tentato e fallito: la durabilita' non e' attestata.
      let dfd;
      try {
        dfd = fsImpl.openSync(p, 'r');
      } catch (e) {
        if (!suo && e && (e.code === 'EACCES' || e.code === 'EPERM')) continue;
        throw e;
      }
      try {
        fsImpl.fsyncSync(dfd);
      } finally {
        try { fsImpl.closeSync(dfd); } catch (_) {}
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

// Identita' semantica di due record della STESSA generazione: tutti i campi
// tranne `ts` (il medesimo evento ripubblicato porta un istante diverso).
function recordPromptUguali(a, b) {
  for (const k of ['version', 'event', 'launchId', 'generation', 'state', 'reason', 'notReady', 'deadlineTs']) {
    const ha = Object.hasOwn(a, k); const hb = Object.hasOwn(b, k);
    if (ha !== hb) return false;
    if (ha && a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Pubblica il record dell'esito della consegna del prompt per QUESTO lancio
 * (`prompt-<launchId>.json`). Valida PRIMA di scrivere, sullo schema chiuso
 * condiviso di prompt-outcome: un record fuori schema non tocca il disco.
 * Crea la directory 0700 se manca, senza cambiare il modo di una directory
 * esistente. Ritorna `true` SOLO se il record e' su disco in modo durevole.
 *
 * STATO MACCHINA delle transizioni, per generazione (il file e' per LANCIO,
 * la generazione e' un campo ed e' l'arbitro):
 *   nessun record           -> pending o terminale: ammesso;
 *   stesso gen, pending     -> pending identico: `true` idempotente (file
 *                              invariato); pending diverso: rifiutato; il
 *                              terminale e' ammesso;
 *   stesso gen, terminale   -> terminale identico: `true` idempotente; ogni
 *                              altro terminale, o un pending: rifiutato, il
 *                              terminale e' immutabile;
 *   generazione MINORE      -> rifiutato: una generazione vecchia non scrive
 *                              MAI sopra una nuova (difesa per il riavvio);
 *   generazione MAGGIORE    -> ammesso, la nuova sostituisce la vecchia.
 * Non e' un arbitraggio fra writer concorrenti — il supervisore e' l'unico
 * writer e serializza in memoria — e' la difesa su disco quando la memoria
 * non c'e' piu'. Un record esistente ROTTO non porta autorita': si sostituisce.
 */
function scriviRecordPrompt(dirSessione, record, opts = {}) {
  if (!validPromptRecord(record)) return false;
  const esistente = osservaRecordPrompt(dirSessione, record.launchId);
  if (esistente.stato === 'presente') {
    const corrente = esistente.record;
    if (record.generation < corrente.generation) return false;
    if (record.generation === corrente.generation) {
      // Contenuto uguale NON e' durabilita' attestata: la pubblicazione
      // precedente puo' aver reso visibile il file senza ricevere la conferma
      // dei suoi fsync. Si RIATTESTA l'impegno senza riscrivere nulla (ne'
      // contenuto ne' mtime); se non si riesce l'esito e' false.
      if (recordPromptUguali(record, corrente)) {
        return riattestaDurabile(dirSessione, nomeRecordPrompt(record.launchId), opts);
      }
      if (corrente.state !== 'pending') return false;
      if (record.state === 'pending') return false;
    }
  }
  return scriviDurabile(dirSessione, nomeRecordPrompt(record.launchId), `${JSON.stringify(record)}\n`, opts);
}

// Autorita' sulla generazione AMMESSA, lato lettore. Il proprietario (il
// supervisore) dichiara qui la generazione che ha appena ammesso PRIMA di
// scrivere il suo record: se quella scrittura fallisce, su disco resta il
// terminale della generazione precedente, e il lettore non deve presentarlo
// come esito corrente. E' solo contesto di LETTURA (nessun secondo writer, mai
// scritto su disco, mai consultato per scegliere "il file piu' recente"); vale
// nello stesso processo del proprietario. Un lettore in un altro processo
// riceve la stessa autorita' dal chiamante (`lancio.generation`) — vedi
// leggiEsitoPromptCorrente. Mappa bounded, la voce piu' vecchia esce per prima.
const AMMISSIONI_PROMPT_MAX = 64;
const ammissioniPrompt = new Map();

function chiaveAmmissionePrompt(dirSessione, launchId) {
  return `${path.resolve(dirSessione)}\0${launchId}`;
}

function dichiaraAmmissionePrompt(dirSessione, launchId, generation) {
  if (typeof dirSessione !== 'string' || !dirSessione || !validLaunchId(launchId)) return false;
  if (!Number.isSafeInteger(generation) || generation < 0) return false;
  const chiave = chiaveAmmissionePrompt(dirSessione, launchId);
  ammissioniPrompt.delete(chiave);
  ammissioniPrompt.set(chiave, generation);
  while (ammissioniPrompt.size > AMMISSIONI_PROMPT_MAX) {
    ammissioniPrompt.delete(ammissioniPrompt.keys().next().value);
  }
  return true;
}

// Tolleranza fissa di lettura sul limite di osservabilita' del pending: oltre
// deadlineTs + questo margine la lettura diventa unknown DERIVATO, senza
// riscrivere il record e senza nessun nuovo tentativo.
const TOLLERANZA_LETTURA_PROMPT_MS = 2000;

// Retention bounded dei record del prompt (stessa scala dei terminali): il
// canale e' privato, i nomi sono SOLO quelli validi del record, e i file
// considerati sono i REGOLARI da lstat — un symlink `prompt-*.json` non viene
// seguito e non viene rimosso. Otto record TOTALI, corrente compreso: con un
// `preserva` valido UN posto e' riservato al lancio corrente (anche quando e'
// il piu' vecchio) e gli altri sette si scelgono per mtime decrescente; senza
// corrente presente restano gli ultimi otto. Tie di mtime: ordine
// deterministico sul NOME. Best-effort: un fallimento di potatura non e' un
// errore del lancio e questa funzione non lancia MAI.
const RETENTION_PROMPT = 8;
const RE_NOME_RECORD_PROMPT = /^prompt-[A-Za-z0-9._-]{1,128}\.json$/;

function potaPrompt(dirSessione, { conserva = RETENTION_PROMPT, preserva } = {}) {
  const rimossi = [];
  try {
    const voci = [];
    for (const n of fs.readdirSync(dirSessione)) {
      if (!RE_NOME_RECORD_PROMPT.test(n)) continue;
      try {
        // lstat, NON stat: nessun link seguito; i non-regolari si saltano.
        const st = fs.lstatSync(path.join(dirSessione, n));
        if (!st.isFile()) continue;
        voci.push({ n, mtime: st.mtimeMs });
      } catch (_) { /* sparito intanto: non e' un candidato */ }
    }
    const nomeCorrente = typeof preserva === 'string' && validLaunchId(preserva)
      ? nomeRecordPrompt(preserva) : '';
    const correntePresente = nomeCorrente !== ''
      && voci.some((v) => v.n === nomeCorrente);
    const quota = Math.max(0, conserva - (correntePresente ? 1 : 0));
    const candidati = voci.filter((v) => v.n !== nomeCorrente)
      .sort((a, b) => (b.mtime - a.mtime) || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    for (const voce of candidati.slice(quota)) {
      try { fs.unlinkSync(path.join(dirSessione, voce.n)); rimossi.push(voce.n); } catch (_) {}
    }
  } catch (_) { /* directory assente o illeggibile: niente da potare */ }
  return rimossi;
}

// Osservazione del record del prompt in TRE stati, come il registro dei
// lanci: 'assente' e' la mancanza VERIFICATA (ENOENT), 'presente' un record
// valido, 'rotto' tutto cio' che non si puo' attestare (errore di lettura
// diverso da ENOENT — permessi, I/O — JSON invalido o campi fuori schema).
// Un EACCES NON e' un'assenza: mascherarlo da absent presenterebbe «non
// applicabile» dove c'e' un guasto.
function osservaRecordPrompt(dirSessione, launchId) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dirSessione, nomeRecordPrompt(launchId)), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { stato: 'assente' };
    return { stato: 'rotto' };
  }
  let dato = null;
  try { dato = JSON.parse(raw); } catch (_) { dato = null; }
  if (!validPromptRecord(dato) || dato.launchId !== launchId) return { stato: 'rotto' };
  return { stato: 'presente', record: dato };
}

// La tupla del record, senza i campi di trasporto (version/event): la forma
// che lo stato della cella pubblichera' al posto del terminale.
function tuplaRecordPrompt(dato) {
  const fuori = {
    launchId: dato.launchId, generation: dato.generation, state: dato.state, ts: dato.ts,
  };
  if (Object.hasOwn(dato, 'reason')) fuori.reason = dato.reason;
  if (Object.hasOwn(dato, 'notReady')) fuori.notReady = dato.notReady;
  if (Object.hasOwn(dato, 'deadlineTs')) fuori.deadlineTs = dato.deadlineTs;
  return fuori;
}

/**
 * Il record del prompt di UN lancio, PER IDENTITA'. Stessa validazione stretta
 * della scrittura; null per assenza, illeggibilita', JSON invalido, campi
 * fuori schema o launchId non corrispondente al nome. Mai throw.
 */
function leggiRecordPrompt(dirSessione, launchId) {
  if (!validLaunchId(launchId)) return null;
  const osservato = osservaRecordPrompt(dirSessione, launchId);
  return osservato.stato === 'presente' ? tuplaRecordPrompt(osservato.record) : null;
}

/**
 * L'esito della consegna del prompt LEGATO ALL'AUTORITA' DEL LANCIO CORRENTE.
 * La lettura e' PER IDENTITA' del lancio che il registro dichiara corrente:
 * NON consulta il selettore `launch-current` e NON dipende dallo stato del
 * canale attivita' — con gli hook disattivati il selettore non viene
 * pubblicato mentre il record del prompt e' comunque obbligatorio, e resta
 * leggibile anche dopo un riavvio del demone. Mai throw. Ritorna:
 *  - null per root/sessione/lancio invalidi (input invalido, non una prova di
 *    non-applicabilita': la composizione applicabile->unknown e' dello strato
 *    di stato, non del lettore);
 *  - { state: 'absent', launchId } per assenza VERIFICATA del record (ENOENT):
 *    absent NON e' uno stato di consegna, e' il discriminante;
 *  - { state: 'unknown', reason: 'record-broken', launchId } per file esistente
 *    ma indeterminabile;
 *  - SENZA un'autorita' sulla generazione ammessa (`lancio.generation`, o la
 *    dichiarazione di ammissione nello stesso processo del proprietario) un
 *    record presente e' { state: 'unknown', launchId }: lo stato CORRENTE non e'
 *    attestabile e non c'e' un default ottimista. Con autorita': record
 *    anteriore -> unknown/generation-not-recorded; posteriore -> unknown
 *    (non aggiorna l'autorita'); coincidente -> la tupla del record.
 *    L'acquisizione, la freschezza e l'invalidazione dell'autorita' (restart,
 *    replacement, perdita del proprietario) sono del consumer; la lettura del
 *    record storico e' `leggiRecordPrompt`;
 *  - altrimenti la tupla del record. Un pending oltre il suo limite di
 *    osservabilita' (deadlineTs + 2000 ms), o con orologio civile incoerente,
 *    si legge come { state: 'unknown', reason: 'deadline-exceeded', ... }
 *    DERIVATO IN LETTURA: il record non si riscrive, non si riprova; un
 *    terminale realmente persistito dopo resta leggibile.
 */
function leggiEsitoPromptCorrente(root, sessione, lancio) {
  try {
    if (!root || typeof root !== 'string') return null;
    if (!sessioneRegistroValida(sessione)) return null;
    if (!lancio || typeof lancio !== 'object') return null;
    const id = lancio.launchId;
    if (!validLaunchId(id)) return null;
    // AUTORITA' sulla generazione ammessa: la porta il chiamante
    // (`lancio.generation`, qualificata dal proprietario ammesso) oppure, nello
    // stesso processo del proprietario, la dichiarazione dell'ammissione. Una
    // generazione dichiarata non valida e' un input invalido, non un'assenza.
    // Senza autorita' lo stato CORRENTE non e' attestabile: nessun default
    // ottimista, nessuna autorita' ricavata dal contenuto del record, dalla
    // recenza, dal PID o da un marcatore.
    let autorita = null;
    if (Object.hasOwn(lancio, 'generation')) {
      if (!Number.isSafeInteger(lancio.generation) || lancio.generation < 0) return null;
      autorita = lancio.generation;
    }
    const dirSessione = path.join(root, sessione);
    const dichiarata = ammissioniPrompt.get(chiaveAmmissionePrompt(dirSessione, id));
    if (typeof dichiarata === 'number' && (autorita === null || dichiarata > autorita)) autorita = dichiarata;
    const osservato = osservaRecordPrompt(dirSessione, id);
    if (osservato.stato === 'assente') return { state: 'absent', launchId: id };
    if (osservato.stato === 'rotto') return { state: 'unknown', reason: 'record-broken', launchId: id };
    const dato = osservato.record;
    // Il record e' storia finche' non coincide con l'autorita': mai l'esito
    // corrente per default. La lettura grezza del record storico resta
    // `leggiRecordPrompt`, un'altra funzione con un altro contratto.
    if (autorita === null) return { state: 'unknown', launchId: id };
    // Anteriore all'autorita': la scrittura della generazione corrente non e'
    // stata attestata, il vecchio esito (anche un submitted) non e' quello corrente.
    if (dato.generation < autorita) {
      return { state: 'unknown', reason: 'generation-not-recorded', launchId: id, generation: autorita };
    }
    // Posteriore: un record piu' nuovo non aggiorna l'autorita' del chiamante.
    // La freschezza si acquisisce dal proprietario, non dal contenuto del record.
    if (dato.generation > autorita) return { state: 'unknown', launchId: id };
    if (dato.state === 'pending') {
      const adesso = Date.now();
      // Il limite e' un'indicazione di OSSERVABILITA', non un budget operativo:
      // scaduto (o orologio incoerente, ts nel futuro) il pending non e' piu'
      // attestabile — unknown derivato, mai pending eterno, mai un retry.
      // Un pending senza deadline finito non ha limite di osservabilita':
      // stessa via, per difesa (la scrittura lo vieta gia').
      if (!Number.isFinite(adesso) || !Number.isFinite(dato.deadlineTs) || adesso < dato.ts
        || adesso > dato.deadlineTs + TOLLERANZA_LETTURA_PROMPT_MS) {
        return {
          state: 'unknown', reason: 'deadline-exceeded', launchId: id,
          generation: dato.generation, ts: dato.ts,
        };
      }
    }
    return tuplaRecordPrompt(dato);
  } catch (_) { return null; }
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
 * Il record terminale di UN lancio, PER IDENTITA'. Condiviso dal lettore via
 * selettore e dal lettore legato al lancio corrente: stessa validazione
 * (versione, evento, lancio, enum, timestamp). Ritorna `{ reason, ts,
 * launchId }` oppure null. Mai throw.
 */
function leggiRecordTerminale(dirSessione, launchId) {
  try {
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return null;
    const raw = fs.readFileSync(
      path.join(dirSessione, `${PREFIX_RECORD_TERMINALE}${launchId}${ESTENSIONE_TERMINALE}`), 'utf8');
    const dato = JSON.parse(raw);
    if (!dato || typeof dato !== 'object' || Array.isArray(dato)) return null;
    if (dato.version !== VERSIONE_TERMINALE || dato.event !== EVENTO_TERMINALE) return null;
    if (dato.launchId !== launchId) return null;
    if (!ragioneTerminaleValida(dato.reason)) return null;
    const ts = Number(dato.ts);
    if (!Number.isFinite(ts)) return null;
    return { reason: dato.reason, ts, launchId };
  } catch (_) { return null; }
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
    return leggiRecordTerminale(dir, id);
  } catch (_) { return null; }
}

// ── Registro dei lanci: l'autorita' di lettura della diagnosi ───────────────

function sessioneRegistroValida(sessione) {
  return typeof sessione === 'string' && !!sessione
    && !sessione.includes('/') && !sessione.includes('\\') && sessione !== '..';
}

/**
 * Dichiara il lancio CORRENTE di una sessione e lo stato del suo canale.
 * Lo scrive SOLO il proprietario del ciclo di vita (il runtime, dentro il
 * lock per cella): un file che dice «lancio corrente» e' un'impostazione
 * d'autorita', non un evento. Scrivibile anche quando la directory di
 * sessione non lo e' (vive in directory dedicate della root). Il record va
 * su DUE locazioni indipendenti (primaria e riserva): ritorna `true` se
 * ALMENO UNA delle due lo ha persistito — con il dettaglio per locazione
 * nell'eventuale oggetto `esito` ({ primario, riserva }), cosi' chi chiama
 * puo' dichiarare quale traccia resta. Ogni record porta una REVISIONE
 * (`rev`) calcolata qui: il massimo registrato finora sulle DUE locazioni,
 * piu' uno. L'incremento avviene sotto il lock del proprietario (il chiamante
 * e' serializzato per cella), quindi ogni scrittura ammessa sopravanza le
 * precedenti PER COSTRUZIONE, e l'ordinamento in lettura non dipende
 * dall'orologio civile — che puo' tornare indietro o fermarsi — ne' da
 * quale copia sia rimasta vecchia. Il massimo pero' si puo' calcolare SOLO
 * se ENTRAMBE le locazioni sono osservabili: una copia illeggibile (errore
 * di lettura) o un suo record non valido nascondono una revisione che la
 * scrittura nuova non avrebbe superato, e quando la copia tornasse leggibile
 * il lancio appena ammesso perderebbe l'autorita' a vantaggio di uno
 * superato. Quando l'ordine non e' stabilibile la funzione rifiuta il lancio
 * PRIMA di qualunque scrittura (`false`, nessuna locazione toccata):
 * l'autorita' esistente resta intatta e leggibile. Mai throw.
 */
function registraLancioCorrente(root, sessione, { launchId, canale, ora = Date.now(), esito } = {}) {
  try {
    if (esito && typeof esito === 'object') { esito.primario = false; esito.riserva = false; }
    if (!root || typeof root !== 'string') return false;
    if (!sessioneRegistroValida(sessione)) return false;
    if (typeof launchId !== 'string' || !RE_ID_LANCIO.test(launchId)) return false;
    if (!STATI_CANALE_LANCIO.includes(canale)) return false;
    const ts = Number(ora);
    if (!Number.isFinite(ts)) return false;
    // Revisione logica: il massimo OSSERVABILE fra le due locazioni, piu'
    // uno. I record senza `rev` (scritti da versioni precedenti) contano
    // come 0: il primo record nuovo li sopravanza subito. L'assenza
    // VERIFICATA di una copia (il file non esiste) non concorre al massimo;
    // una copia INDETERMINABILE (illeggibile o record non valido) lo blocca:
    // la revisione che contiene non e' osservabile e il lancio viene
    // rifiutato qui, prima di toccare qualunque locazione.
    const osservatoPrimario = osservaRecordRegistro(path.join(root, NOME_DIR_REGISTRO_LANCI), sessione);
    const osservatoRiserva = osservaRecordRegistro(path.join(root, NOME_DIR_REGISTRO_RISERVA), sessione);
    if (osservatoPrimario.stato === 'indeterminato' || osservatoRiserva.stato === 'indeterminato') {
      return false;
    }
    const revisione = Math.max(
      osservatoPrimario.stato === 'presente' ? osservatoPrimario.record.rev : 0,
      osservatoRiserva.stato === 'presente' ? osservatoRiserva.record.rev : 0,
    ) + 1;
    const dato = {
      version: VERSIONE_REGISTRO_LANCIO,
      event: EVENTO_REGISTRO_LANCIO,
      launchId,
      channel: canale,
      ts,
      rev: revisione,
    };
    const corpo = `${JSON.stringify(dato)}\n`;
    const primario = scriviAtomico(path.join(root, NOME_DIR_REGISTRO_LANCI), `${sessione}.json`, corpo);
    const riserva = scriviAtomico(path.join(root, NOME_DIR_REGISTRO_RISERVA), `${sessione}.json`, corpo);
    if (esito && typeof esito === 'object') { esito.primario = primario; esito.riserva = riserva; }
    return primario || riserva;
  } catch (_) { return false; }
}

// Osservazione di UNA locazione del registro, in TRE stati, perche' assenza
// VERIFICATA e ignoranza NON sono la stessa cosa. 'assente': il file non
// esiste (ENOENT), quella copia non contiene alcuna revisione. 'presente':
// record valido, con la sua revisione (`rev`, intero >= 0; i record scritti
// dalle versioni precedenti non la portano e vale 0). 'indeterminato':
// errore di lettura diverso da ENOENT (permessi, I/O) o record non valido —
// la revisione che quella copia contiene NON e' osservabile, e nessuna
// autorita' puo' essere stabilita sopra una copia che non si puo' leggere.
function osservaRecordRegistro(dirRegistro, sessione) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dirRegistro, `${sessione}.json`), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { stato: 'assente' };
    return { stato: 'indeterminato' };
  }
  let dato = null;
  try { dato = JSON.parse(raw); } catch (_) { dato = null; }
  if (!dato || typeof dato !== 'object' || Array.isArray(dato)) return { stato: 'indeterminato' };
  if (dato.version !== VERSIONE_REGISTRO_LANCIO || dato.event !== EVENTO_REGISTRO_LANCIO) return { stato: 'indeterminato' };
  if (typeof dato.launchId !== 'string' || !RE_ID_LANCIO.test(dato.launchId)) return { stato: 'indeterminato' };
  if (!STATI_CANALE_LANCIO.includes(dato.channel)) return { stato: 'indeterminato' };
  const ts = Number(dato.ts);
  if (!Number.isFinite(ts)) return { stato: 'indeterminato' };
  const rev = (dato.rev === undefined || dato.rev === null) ? 0 : Number(dato.rev);
  if (!Number.isInteger(rev) || rev < 0) return { stato: 'indeterminato' };
  return { stato: 'presente', record: { launchId: dato.launchId, canale: dato.channel, ts, rev } };
}

/**
 * Il lancio corrente registrato per una sessione: `{ launchId, canale, ts }`
 * oppure null per assenza, file rotto o schema inatteso. Legge le DUE
 * locazioni del registro e segue il record con la REVISIONE piu' alta: la
 * revisione e' incrementata dal proprietario del ciclo di vita a ogni
 * scrittura ammessa, quindi un lancio ammesso e' l'autorita' piu' recente
 * INDIPENDENTEMENTE dall'orologio civile (uguale o arretrato), dall'ordine
 * delle locazioni e da quale copia sia rimasta vecchia. Quando una sola
 * locazione e' aggiornata — l'altra non era scrivibile al momento del
 * lancio — la verita' e' quella aggiornata: un record rimasto indietro non
 * puo' far tornare corrente un lancio precedente. Una copia INOSSERVABILE
 * (illeggibile, o con record non valido) puo' invece contenere una revisione
 * SUPERIORE a ogni copia leggibile: presentare quest'ultima come autorita'
 * corrente sarebbe una diagnosi VECCHIA spacciata per attuale, quindi
 * l'ordine non stabilibile diventa assenza esplicita finche' la copia non
 * torna leggibile. A parita' di revisione i
 * due record sono lo STESSO lancio (stessa scrittura riuscita su entrambe:
 * la riserva viene scritta anche quando la primaria riesce, il contenuto e'
 * identico); due identita' DIVERGENTI alla stessa revisione sono un ordine
 * non stabilibile — la risposta e' l'assenza onesta, mai una preferenza
 * fissa fra le due copie. Mai throw.
 */
function leggiLancioCorrente(root, sessione) {
  try {
    if (!root || typeof root !== 'string') return null;
    if (!sessioneRegistroValida(sessione)) return null;
    const osservatoPrimario = osservaRecordRegistro(path.join(root, NOME_DIR_REGISTRO_LANCI), sessione);
    const osservatoRiserva = osservaRecordRegistro(path.join(root, NOME_DIR_REGISTRO_RISERVA), sessione);
    // Una copia non osservabile puo' contenere una revisione superiore a
    // ogni copia leggibile: l'ordine fra i record non e' stabilibile e
    // nessun record leggibile puo' essere presentato come autorita'
    // corrente. Assenza onesta, non l'ultimo leggibile.
    if (osservatoPrimario.stato === 'indeterminato' || osservatoRiserva.stato === 'indeterminato') {
      return null;
    }
    const primario = osservatoPrimario.stato === 'presente' ? osservatoPrimario.record : null;
    const riserva = osservatoRiserva.stato === 'presente' ? osservatoRiserva.record : null;
    let scelto = null;
    if (!primario) scelto = riserva;
    else if (!riserva) scelto = primario;
    else if (riserva.rev > primario.rev) scelto = riserva;
    else if (primario.rev > riserva.rev) scelto = primario;
    else if (riserva.launchId === primario.launchId) scelto = riserva;
    else return null;
    return scelto ? { launchId: scelto.launchId, canale: scelto.canale, ts: scelto.ts } : null;
  } catch (_) { return null; }
}

/**
 * La diagnosi terminale LEGATA ALL'AUTORITA' DEL LANCIO CORRENTE. Il solo
 * selettore su disco non basta: una pubblicazione fallita puo' aver lasciato
 * la selezione del lancio PRECEDENTE, e nessun log ripara la vista. La
 * lettura segue lo stato del canale registrato per QUESTO lancio:
 * - 'selector': il selettore consegna una diagnosi SOLO se indica ESATTAMENTE
 *   il lancio dell'autorita' corrente (identita' confrontata): una selezione
 *   diversa — stantia o comunque non sua — non restituisce MAI il record di
 *   un altro lancio, l'esito onesto e' l'assenza;
 * - 'none': pubblicazione e invalidazione fallite — il selettore e' STANTIO,
 *   si legge PER IDENTITA' solo il record del lancio corrente;
 * - 'off': canale disattivato per questo lancio — nessuna diagnosi attribuita
 *   a esso, e la storia di un lancio precedente non e' lo stato corrente.
 * Senza autorita' nota l'esito e' l'assenza: non si presume valido l'ultimo
 * selettore leggibile. Mai throw.
 */
function leggiDiagnosiTerminaleCorrente(root, sessione, lancio) {
  try {
    if (!root || typeof root !== 'string') return null;
    if (!sessioneRegistroValida(sessione)) return null;
    if (!lancio || typeof lancio !== 'object') return null;
    if (lancio.canale === 'off') return null;
    if (lancio.canale === 'none') {
      return leggiRecordTerminale(path.join(root, sessione), lancio.launchId);
    }
    if (lancio.canale === 'selector') {
      const dir = path.join(root, sessione);
      const selezionato = leggiSelettoreLancio(dir);
      if (!selezionato || selezionato !== lancio.launchId) return null;
      return leggiRecordTerminale(dir, selezionato);
    }
    return null;
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
  registraLancioCorrente, leggiLancioCorrente, leggiDiagnosiTerminaleCorrente,
  leggiRecordTerminale,
  scriviDurabile, scriviRecordPrompt, validLaunchId,
  leggiRecordPrompt, leggiEsitoPromptCorrente, dichiaraAmmissionePrompt, TOLLERANZA_LETTURA_PROMPT_MS,
  potaPrompt, RETENTION_PROMPT,
  NOME_FILE, NOME_GENERAZIONE, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS,
  LAVORA, FERMA, ATTESA, TIPO_PERMESSO, STATO_PER_EVENTO, USCITA,
  NOME_SELETTORE_LANCIO, EVENTO_TERMINALE, VERSIONE_TERMINALE, RAGIONI_TERMINALI,
  RETENTION_TERMINALI, STATI_CANALE_LANCIO, NOME_DIR_REGISTRO_LANCI, NOME_DIR_REGISTRO_RISERVA,
  RE_ID_LANCIO,
};
