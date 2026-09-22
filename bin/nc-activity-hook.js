#!/usr/bin/env node
'use strict';
// Hook OSSERVATIVO di attivita' per le celle Claude lanciate da NexusCrew.
//
// Contratto con il client, misurato nel Gate A su Claude Code 2.1.280:
//  - il payload dell'evento arriva su STDIN come JSON; da li' si leggono SOLO
//    `session_id` e `notification_type`. Il resto — testo del prompt, percorsi
//    della sessione — non viene letto e non finisce da nessuna parte.
//  - l'hook non deve scrivere su stdout/stderr: un hook che stampa puo'
//    alterare il turno. Qualsiasi errore viene inghiottito e si esce 0.
//
// Uso (il launcher lo compone):
//   node nc-activity-hook.js --event <Evento> --dir <dirSessione> [--gen <id>]

const { scriviStato, daRegistrare } = require('../lib/files/activity.js');

function argomento(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function leggiStdin() {
  try {
    return require('node:fs').readFileSync(0, 'utf8');
  } catch (_) { return ''; }
}

function main() {
  const evento = argomento('event');
  const dir = argomento('dir');
  const generazione = argomento('gen');
  if (!evento || !dir) return;

  let payload = null;
  try {
    const raw = leggiStdin();
    if (raw) payload = JSON.parse(raw);
  } catch (_) { payload = null; }
  if (!payload || typeof payload !== 'object') payload = {};

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const tipo = typeof payload.notification_type === 'string' ? payload.notification_type : null;

  // Chi non e' registrabile NON tocca il file: una notifica di tipo diverso da
  // `permission_prompt` sovrascriverebbe uno stato fresco e legittimo con un
  // evento che il lettore non sa mappare, e la cella diventerebbe «non
  // verificata» mentre sta lavorando. `SessionEnd` invece si scrive: e' cosi'
  // che il dato di una sessione morta viene invalidato.
  if (!daRegistrare(evento, tipo)) return;

  scriviStato(dir, { evento, tipo, sessionId, generazione });
}

try { main(); } catch (_) { /* un hook non deve mai disturbare il turno */ }
process.exit(0);
