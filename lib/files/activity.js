'use strict';
// Attivita' per-cella: lo stato del turno pubblicato dagli HOOK di Claude Code.
//
// Perche' un file proprio e non telemetry.json: la statusline e gli hook sono
// due scrittori indipendenti. Un read-modify-write non coordinato perde gli
// aggiornamenti dell'altro, e un timestamp unico farebbe sembrare fresco uno
// stato attività vecchio quando arrivano nuove percentuali. Due file, due
// contratti, un solo scrittore ciascuno (rilievo R5 dell'audit di
// progettazione).
//
// Il file NON contiene il payload dell'hook: quello porta il testo del prompt e
// i percorsi della sessione, che allo stato non servono (R5). Solo l'evento, il
// timestamp, l'identita' della sessione e la generazione.
//
// Quattro regole, le stesse di telemetry.js ma con esito diverso:
//   1. TIMESTAMP OBBLIGATORIO e guardato nei DUE versi — oltre la finestra il
//      dato e' morto, e un ts nel futuro non deve restare fresco per sempre.
//   2. SCADUTO NON E' IDLE: oltre la finestra si torna `null`, che la UI mostra
//      come «non verificato». Mai affermare «ferma» su un dato che non
//      verifica nulla: e' l'unico modo di coprire l'interruzione con Ctrl-C,
//      che (misurato su 2.1.280, D-340 Gate A) NON emette alcun evento.
//   3. GENERAZIONE: lo stato di un lancio precedente della stessa cella non
//      vale per quello corrente. La generazione corrente la scrive il launcher
//      (activity.gen); un file che ne porta un'altra viene scartato.
//   4. LETTURA TOLLERANTE: file assente, illeggibile o JSON rotto -> null, mai
//      un'eccezione: la lista delle sessioni non deve fallire per questo.

const fs = require('node:fs');
const path = require('node:path');

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
  try {
    fs.mkdirSync(dirSessione, { recursive: true });
    const tmp = path.join(dirSessione, `${NOME_GENERAZIONE}.tmp`);
    fs.writeFileSync(tmp, generazione, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, path.join(dirSessione, NOME_GENERAZIONE));
    return true;
  } catch (_) { return false; }
}

/**
 * Scrittura atomica dello stato: file temporaneo + rename nella stessa
 * directory. Piu' hook possono scattare a raffica (PreToolUse/PostToolUse), e
 * un lettore non deve mai vedere un file a meta'.
 */
function scriviStato(dirSessione, { evento, tipo, sessionId, generazione, ora = Date.now() } = {}) {
  if (typeof evento !== 'string' || !evento) return false;
  const dato = { event: evento, ts: ora };
  if (typeof sessionId === 'string' && sessionId) dato.session_id = sessionId;
  if (typeof generazione === 'string' && generazione) dato.generation = generazione;
  if (typeof tipo === 'string' && tipo) dato.notification_type = tipo;
  try {
    fs.mkdirSync(dirSessione, { recursive: true });
    const tmp = path.join(dirSessione, `${NOME_FILE}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(dato)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, path.join(dirSessione, NOME_FILE));
    return true;
  } catch (_) { return false; }
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
  leggiAttivita, scriviStato, scriviGenerazione, statoDaEvento,
  NOME_FILE, NOME_GENERAZIONE, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS,
  LAVORA, FERMA, ATTESA, TIPO_PERMESSO, STATO_PER_EVENTO,
};
