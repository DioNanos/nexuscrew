'use strict';
// Canale di attivita' per le celle codex e codex-vl.
//
// Perche' esiste: le celle Claude pubblicano il proprio stato di turno con gli
// hook di Claude Code (bin/nc-activity-hook.js, iniettato via --settings). Gli
// engine codex non hanno quel meccanismo, quindi fino a oggi la UI le mostrava
// «non verificate» — che era la verita', ma anche un'informazione che si poteva
// avere. Codex ha un sistema di hook proprio, con una differenza che conta:
// un hook iniettato da riga di comando NON e' fidato finche' il suo hash non
// compare in `hooks.state`, altrimenti il client apre un dialogo di revisione e
// non lo esegue.
//
// Questo modulo costruisce i due pezzi che servono, e nient'altro:
//  1. gli argomenti `-c hooks.<Evento>=[...]` che DEFINISCONO l'hook;
//  2. gli argomenti `-c hooks.state={...}` che lo FIDANO, con l'hash che il
//     client si aspetta di trovare.
//
// L'hash non e' lo sha256 del testo del comando: e' lo sha256 del JSON CANONICO
// di un'identita' normalizzata (evento + handler normalizzato). Replicato da
// codex-rs/hooks/src/engine/discovery.rs (`hook_hash`) e
// codex-rs/config/src/fingerprint.rs (`version_for_toml`).
//
// La forma `-c hooks.state.<chiave>.trusted_hash=...` NON funziona: il parser
// di `-c` spezza il path sui punti (codex-rs/config/src/overrides.rs) e la
// chiave dell'hook ne contiene. Percio' `hooks.state` si passa come TABELLA
// inline. Verificato in una prova isolata su TUI reale, su entrambe le
// versioni in uso.

const crypto = require('node:crypto');
const { termuxRuntimePaths } = require('../runtime/env.js');

// Etichette usate nelle chiavi di stato — codex-rs/hooks/src/lib.rs,
// `hook_event_key_label`. Solo gli eventi che iniettiamo.
const ETICHETTA_EVENTO = Object.freeze({
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  Interrupt: 'interrupt',
});

// Timeout normalizzato — codex-rs/hooks/src/engine/discovery.rs,
// `normalize_command_hook`: dieci minuti per tutti, UN SECONDO per SessionEnd e
// Interrupt (che hanno anche un tetto di tre). Il valore entra nell'hash,
// quindi sbagliarlo qui farebbe ricomparire il dialogo di revisione.
const TIMEOUT_STANDARD_SEC = 600;
const TIMEOUT_FINE_SEC = 1;

// La fonte sintetica da cui il client crede che l'hook provenga: e' il layer
// `SessionFlags`, cioe' proprio cio' che passiamo con `-c`
// (discovery.rs:402-422).
const KEY_SOURCE_SESSION_FLAGS = '/<session-flags>/config.toml';

function etichetta(evento) {
  const label = ETICHETTA_EVENTO[evento];
  if (!label) throw new Error(`evento hook non gestito: ${evento}`);
  return label;
}

function timeoutPerEvento(evento) {
  return evento === 'SessionEnd' || evento === 'Interrupt'
    ? TIMEOUT_FINE_SEC
    : TIMEOUT_STANDARD_SEC;
}

// Riordina le chiavi in modo ricorsivo: `version_for_toml` serializza il JSON
// CANONICO, e due identita' con le stesse chiavi in ordine diverso devono dare
// lo stesso hash.
function ordinaChiavi(valore) {
  if (Array.isArray(valore)) return valore.map(ordinaChiavi);
  if (valore && typeof valore === 'object') {
    const out = {};
    for (const chiave of Object.keys(valore).sort()) out[chiave] = ordinaChiavi(valore[chiave]);
    return out;
  }
  return valore;
}

function jsonCanonico(valore) {
  return JSON.stringify(ordinaChiavi(valore));
}

/**
 * Hash atteso da codex per questo handler su questo evento.
 * Replica `hook_hash` -> `version_for_toml`.
 */
function hashHook(evento, comando) {
  const identita = {
    event_name: etichetta(evento),
    hooks: [{
      async: false,
      command: comando,
      timeout: timeoutPerEvento(evento),
      type: 'command',
    }],
  };
  const digest = crypto.createHash('sha256').update(jsonCanonico(identita), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/** Chiave dello stato per un handler: `hook_key` (hooks/src/lib.rs). */
function chiaveHook(evento, gruppo = 0, handler = 0) {
  return `${KEY_SOURCE_SESSION_FLAGS}:${etichetta(evento)}:${gruppo}:${handler}`;
}

// Stringa TOML. I valori qui sono percorsi e comandi unix, senza backslash:
// JSON.stringify produce una basic string corretta per questi contenuti.
function tomlString(valore) {
  return JSON.stringify(String(valore));
}

/** Definizione di UN hook: `hooks.<Evento>=[{hooks=[{type,command}]}]`. */
function definizioneHook(evento, comando) {
  return `hooks.${evento}=[{hooks=[{type="command",command=${tomlString(comando)}}]}]`;
}

/** `hooks.state` come tabella inline con un trusted_hash per chiave. */
function tabellaStato(voci) {
  const parti = voci.map(({ chiave, hash }) => `${tomlString(chiave)}={trusted_hash=${tomlString(hash)}}`);
  return `hooks.state={${parti.join(',')}}`;
}

/**
 * Argomenti da appendere alla riga di lancio di una cella codex/codex-vl.
 * `comandoPerEvento(evento)` ritorna il comando dell'hook per quell'evento.
 * Ritorna [] se non c'e' niente da iniettare.
 */
function argomentiHookCodex(eventi, comandoPerEvento) {
  if (!Array.isArray(eventi) || eventi.length === 0) return [];
  const args = [];
  const voci = [];
  for (const evento of eventi) {
    const comando = comandoPerEvento(evento);
    if (!comando) continue;
    args.push('-c', definizioneHook(evento, comando));
    voci.push({ chiave: chiaveHook(evento), hash: hashHook(evento, comando) });
  }
  if (voci.length === 0) return [];
  args.push('-c', tabellaStato(voci));
  return args;
}

// ── Guardia di versione ────────────────────────────────────────────────
//
// L'hash dipende dalla normalizzazione, dalla serializzazione e dal source
// path sintetico di UNA versione di codex. Se il binario cambia quelle regole,
// l'hash non combacia piu', il client apre il dialogo «Hooks need review» e la
// cella resta BLOCCATA su una domanda che nessuno vede. Il costo di sbagliare
// non e' «hook che non parte»: e' una cella che non lavora.
//
// Quindi si inietta SOLO su versioni effettivamente provate, e su ogni altra
// non si inietta niente: la cella torna «non verificato» come oggi, che e' il
// comportamento di prima — un degrado dichiarato, non un guasto introdotto.
const VERSIONI_PROVATE = Object.freeze({
  codex: ['0.156.1'],
  'codex-vl': ['0.155.1', '0.156.1'],
});

// Probe della versione, con lo stesso seam del ramo vl (cfg.vlVersionProbe):
// i test non devono dipendere da un binario vero. Ritorna l'output GREZZO.
// `binary` e' il percorso RISOLTO del binario della cella, non il nome del
// client: si esegue quello, senza shell e con un tetto di tempo breve.
function versionOutput(binary, cfg) {
  const probe = cfg && typeof cfg.codexVersionProbe === 'function' ? cfg.codexVersionProbe : null;
  if (probe) {
    const out = probe(binary);
    return out === null || out === undefined ? null : String(out);
  }
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000, shell: false });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || ''}${r.stderr || ''}`;
}

/**
 * Si puo' iniettare su questo binario? Ritorna { ok, versione } oppure
 * { ok: false, reason } — il motivo e' per la riga di log, mai per l'utente.
 * `client` sceglie l'elenco delle versioni provate; `binary` e' cio' che si
 * esegue davvero. Sono due cose diverse: se coincidono e' una coincidenza.
 */
function gateVersione(client, binary, cfg) {
  const ammesse = VERSIONI_PROVATE[client];
  if (!ammesse) return { ok: false, reason: `client ${client} non gestito dal canale hook` };
  if (!binary) {
    return { ok: false, reason: `binario di ${client} non risolto sul nodo: nessun hook iniettato` };
  }
  const out = versionOutput(binary, cfg);
  if (out === null) {
    return { ok: false, reason: `versione di ${client} non determinabile (${binary} --version non risponde): nessun hook iniettato` };
  }
  const m = out.match(/(\d+\.\d+\.\d+)/);
  if (!m) {
    return { ok: false, reason: `versione di ${client} non riconosciuta da "${String(out).trim().slice(0, 60)}": nessun hook iniettato` };
  }
  if (!ammesse.includes(m[1])) {
    return { ok: false, reason: `versione ${client} ${m[1]} non provata con gli hook (provate: ${ammesse.join(', ')}): nessun hook iniettato` };
  }
  return { ok: true, versione: m[1] };
}

// La chiave di fiducia di questi hook e' Unix: `key_source` e'
// `/<session-flags>/config.toml` e il comando e' quotato in stile POSIX. Il
// sorgente di codex sintetizza quella fonte con `C:\` su Windows
// (`hooks/src/engine/discovery.rs:402-435`), quindi la' la chiave che il
// client calcola NON coincide con quella che generiamo: si inietterebbe un
// hook non fidato, cioe' esattamente il dialogo che la guardia esiste per
// evitare. Finche' non c'e' una prova su Windows, li' non si inietta.
//
// Termux e' un caso diverso e piu' stretto: il probe esegue il binario
// direttamente, mentre il launcher lo lancia tramite Node quando lo shim ha
// uno shebang senza `/usr/bin/env` (`managed.js:1006-1028`). Il gate
// fallirebbe chiuso, e una cella «non verificata» senza motivo e' un limite
// che si dichiara qui invece di lasciarlo scoprire.
function gatePiattaforma(cfg) {
  const platform = (cfg && cfg.platform) || process.platform;
  const env = (cfg && cfg.env) || process.env;
  const termux = platform === 'android'
    || termuxRuntimePaths(env, { platform, home: cfg && cfg.home }) !== null;
  if (termux) {
    return { ok: false, reason: 'termux: il probe della versione non segue il percorso di lancio' };
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    return { ok: false, reason: `piattaforma ${platform}: chiave di fiducia e quoting degli hook non provati qui` };
  }
  return { ok: true };
}

// Eventi iniettati per una cella codex, nell'ordine in cui il client li emette.
const EVENTI_CODEX = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd',
]);

module.exports = {
  ETICHETTA_EVENTO,
  TIMEOUT_STANDARD_SEC,
  TIMEOUT_FINE_SEC,
  KEY_SOURCE_SESSION_FLAGS,
  VERSIONI_PROVATE,
  EVENTI_CODEX,
  etichetta,
  timeoutPerEvento,
  jsonCanonico,
  hashHook,
  chiaveHook,
  definizioneHook,
  tabellaStato,
  argomentiHookCodex,
  versionOutput,
  gateVersione,
  gatePiattaforma,
};
