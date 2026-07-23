'use strict';
// Launch + readiness toolkit del fleet built-in (estratto da builtin.js in
// modo behavior-preserving). Tutto cio' che sta qui e' STATELESS: ogni
// funzione riceve le proprie dipendenze come argomento e non tocca lo stato
// del fleet. createBuiltinRuntime() in runtime.js ne fa uso; builtin.js e'
// ora un facade che re-esporta questi simboli per i test.
//
// Sicurezza (design §9a/§9e/§9h) — invariata rispetto a builtin.js:
//  - command/args/env NON passano per una shell: execFile + argv diretto
//    (tmux fa exec del comando, NON sh -c — verificato: ';','|','$' passano
//    verbatim). Nessun valore passa in argv, `tmux -e`, file temporanei o
//    ambiente globale tmux. PATH lo controlla il service, mai la definizione.
//  - env minimale controllato dal service (allowlist dura); le definizioni non
//    possono toccare PATH/loader-key (parseDefinitions le rifiuta gia' in env).
//  - promptMode 'send-keys' inietta via `tmux load-buffer` + `paste-buffer -p`
//    (bracketed paste), NON send-keys grezzo; se il command e' gia' uscito
//    (sessione morta) NON digita (§9e).
//  - redactSecrets/sanitizeEarlyDiagnostic (§9h): stderr/stdout dei comandi
//    tmux falliti NON devono mai ecoare i segreti delle definizioni.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { minimalRuntimeEnv } = require('../runtime/env.js');
const { codeOf, phaseOf } = require('./causes.js');
const { isTmuxSafeName, tmuxSessionForCell } = require('./definitions.js');

// Env minimale controllato dal service (design §9a). Allowlist DURA: le definizioni
// non possono toccare PATH/loader-key (parseDefinitions le rifiuta gia' in env);
// qui NON passiamo MAI l'env del processo per intero. engine.env viene consegnato
// direttamente al processo figlio dal broker, senza entrare nello stato tmux.
// Nota: se un server tmux e' gia' in esecuzione (avviato fuori dal service), i comandi
// ereditano l'env di quel server; la garanzia dura resta: le definizioni non possono
// iniettare loader-key, e engine.env arriva al pane SOLO tramite chiavi validate.
function minimalEnv() {
  return minimalRuntimeEnv(process.env, { home: os.homedir() });
}

// tmux reports client-side connection failures through localized stderr. The
// migration classifier must see the stable POSIX wording on every platform,
// otherwise a missing first-boot socket could disable Fleet under a non-English
// locale. Restrict only the message locale: LC_ALL=C would also force ASCII
// character handling and tmux would sanitize the tab in our format string.
// Panes, the shared server and the inventory protocol keep a UTF-8 LC_CTYPE.
function tmuxInventoryEnv() {
  const env = minimalEnv();
  delete env.LC_ALL; // LC_ALL would override LC_MESSAGES and LC_CTYPE.
  env.LANGUAGE = 'C';
  env.LC_MESSAGES = 'C';
  return env;
}

// httpError(status, msg, data?, cause?) — structured HTTP error. `data` carries
// arbitrary API detail for the response body; `cause` (T4) is the OPTIONAL
// bounded failure triple {phase, code} of the up() boundary that failed. The
// cause is coerced through the closed enum in causes.js (anything not
// allowlisted degrades to UNKNOWN) and attached as e.fleetCode / e.fleetPhase,
// so the fleet router can surface {status, code, phase} WITHOUT ever embedding
// cwd/path, argv, env, prompt, token or credentials. The two channels are kept
// distinct: `data` is free API detail, `cause` is the bounded failure triple.
function httpError(status, msg, data = null, cause = null) {
  const e = new Error(msg);
  e.status = status;
  if (data) e.data = data;
  if (cause) {
    e.fleetCode = codeOf(cause.code);
    e.fleetPhase = phaseOf(cause.phase);
  }
  return e;
}

// Marcatore di redazione (design §9h): stderr/stdout dei comandi tmux falliti
// NON devono mai ecoare i segreti delle definizioni.
const REDACTED = '‹redacted›';

// redactSecrets(text, engine, cell) -> string con ogni occorrenza dei segreti
// delle definizioni sostituita da '‹redacted›'. Segreti coperti (§9h):
//  - valori di engine.env           (le CHIAVI restano, i VALUES vengono redatti)
//  - testo del prompt della cella   (cell.prompt)
//  - testo del prompt dell'engine   (engine.prompt) se presente
//  - comando Shell attivo per cella (cell.commands[cell.engine])
// Applicato a OGNI messaggio d'errore che incorpora stderr/stdout dei comandi
// tmux falliti (up / down / injectPrompt): tmux puo' ecoare argv/env del comando
// lanciato nei suoi log di errore. Pura + senza dipendenze: testabile direttamente.
function redactSecrets(text, engine, cell) {
  if (typeof text !== 'string' || text === '') return text;
  const secrets = [];
  if (engine && typeof engine === 'object' && engine.env) {
    for (const v of Object.values(engine.env)) {
      if (typeof v === 'string' && v) secrets.push(v);
    }
  }
  if (engine && typeof engine.prompt === 'string' && engine.prompt) secrets.push(engine.prompt);
  if (cell && typeof cell.prompt === 'string' && cell.prompt) secrets.push(cell.prompt);
  if (cell && typeof cell.engine === 'string'
      && cell.commands && typeof cell.commands === 'object' && !Array.isArray(cell.commands)) {
    const activeCommand = cell.commands[cell.engine];
    if (typeof activeCommand === 'string' && activeCommand) secrets.push(activeCommand);
  }
  // Ordina per lunghezza DECRESCENTE: i segreti piu' lunghi prima, cosi' un segreto
  // che e' prefisso/sottostringa di un altro non ne maschera il rimpiazzo completo.
  secrets.sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of secrets) out = out.split(s).join(REDACTED); // replace globale, regex-free
  return out;
}

const MAX_EARLY_DIAGNOSTIC = 1200;

function sanitizeEarlyDiagnostic(text, engine, cell, home) {
  let out = redactSecrets(String(text || ''), engine, cell);
  // ANSI CSI/OSC e byte di controllo non devono arrivare nell'errore JSON/UI.
  out = out.replace(/\x1b\][^\x07]*(?:\x07|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
  let clean = '';
  for (let i = 0; i < out.length; i += 1) {
    const code = out.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) clean += out[i];
  }
  out = clean;
  if (typeof home === 'string' && home) out = out.split(home).join('~');
  out = out
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)(\s*[:=]\s*)\S+/g,
      (_m, key, sep) => `${key}${sep}${REDACTED}`)
    .replace(/\b(?:sk|fw|fpk|hf|zai)-[A-Za-z0-9._-]{8,}\b/gi, REDACTED);
  const lines = out.split(/\r?\n/).map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^Pane is dead \(status /i.test(line.trim()));
  out = lines.join('\n').trim();
  if (out.length > MAX_EARLY_DIAGNOSTIC) out = `…${out.slice(-(MAX_EARLY_DIAGNOSTIC - 1))}`;
  return out;
}

// Esecutore tmux: argv diretto (MAI shell). Risolve sempre {err,stdout,stderr,code}
// cosi' il chiamante distingue "sessione assente" (code!==0 atteso) da errori reali.
function tmuxExec(tmuxBin, args, { env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile(tmuxBin, args, { env, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), code });
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tmuxMigrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedTmuxFailure(result) {
  return String(result?.stderr || result?.err?.message || 'errore tmux')
    .replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 240) || 'errore tmux';
}

// Migrazione identita' tmux (design §3.2). Prima costruisce e valida TUTTO il
// piano: nessun rename parte se una sessione legacy normalizzata e' rivendicata
// da piu celle (es. a.b vs a_b), se legacy+target safe coesistono o se il target
// non e' tmux-safe. Solo dopo il preflight rinomina via `$N`; qualunque errore e'
// propagato con causa bounded e impedisce la persistenza di fleet.json. I rename
// gia riusciti prima di un errore operativo restano comunque idempotenti al boot
// successivo, mentre lo store precedente rimane intatto.
async function migrateLegacyTmuxSessions(tmuxBin, defs, { readonly = false } = {}) {
  const cells = defs && Array.isArray(defs.cells) ? defs.cells : [];
  const legacyMap = defs?.legacyTmuxSessions instanceof Map ? defs.legacyTmuxSessions : new Map();
  const candidates = [];
  for (const cell of cells) {
    if (!cell || typeof cell.id !== 'string') continue;
    const legacyRaw = legacyMap.get(cell.id) || (cell.id.includes('.') ? `cloud-${cell.id}` : '');
    if (!legacyRaw) continue;
    const safe = cell.tmuxSession || tmuxSessionForCell(cell.id);
    if (!isTmuxSafeName(safe)) {
      throw tmuxMigrationError('TMUX_MIGRATION_INVALID_TARGET',
        `migrazione tmux bloccata per ${cell.id}: target safe non valido`);
    }
    candidates.push({ id: cell.id, legacyRaw, legacyNorm: legacyRaw.replace(/\./g, '_'), safe });
  }
  if (!candidates.length || readonly) {
    return {
      migrated: [], reason: readonly ? 'readonly' : 'none',
      needsPersistence: legacyMap.size > 0,
    };
  }
  const listing = await tmuxExec(tmuxBin,
    ['list-sessions', '-F', '#{session_id}\t#{session_name}'], { env: tmuxInventoryEnv() });
  if (listing.err) {
    const detail = boundedTmuxFailure(listing);
    if (/no server running|failed to connect|connection refused|no such file.*tmux|error connecting to .*\(no such file or directory\)/i.test(detail)) {
      return { migrated: [], reason: 'no-tmux-server', needsPersistence: legacyMap.size > 0 };
    }
    throw tmuxMigrationError('TMUX_MIGRATION_LIST_FAILED',
      `migrazione tmux: elenco sessioni non disponibile (${detail})`);
  }
  const realByName = new Map(); // session_name -> session_id ($N)
  for (const line of listing.stdout.split('\n')) {
    const [sid, sname] = line.split('\t');
    if (sid && sname) realByName.set(String(sname).trim(), String(sid).trim());
  }

  const ownersBySafe = new Map(cells.map((cell) => [cell.tmuxSession, cell.id]));
  const claimsByReal = new Map();
  for (const candidate of candidates) {
    for (const name of new Set([candidate.legacyRaw, candidate.legacyNorm])) {
      if (!realByName.has(name)) continue;
      const claims = claimsByReal.get(name) || [];
      claims.push(candidate);
      claimsByReal.set(name, claims);
    }
  }

  const activeNamesByCell = new Map();
  for (const [realName, claims] of claimsByReal) {
    for (const claim of claims) {
      const names = activeNamesByCell.get(claim.id) || [];
      names.push(realName);
      activeNamesByCell.set(claim.id, names);
    }
  }
  for (const [cellId, names] of activeNamesByCell) {
    if (names.length > 1) {
      throw tmuxMigrationError('TMUX_MIGRATION_AMBIGUOUS',
        `migrazione tmux ambigua per ${cellId}: piu sessioni legacy (${names.join(', ')})`);
    }
  }

  const operations = [];
  for (const [realName, claims] of claimsByReal) {
    if (claims.length !== 1) {
      throw tmuxMigrationError('TMUX_MIGRATION_AMBIGUOUS',
        `migrazione tmux ambigua: ${realName} corrisponde a ${claims.map((c) => c.id).join(', ')}`);
    }
    const candidate = claims[0];
    const owner = ownersBySafe.get(realName);
    if (owner && owner !== candidate.id) {
      throw tmuxMigrationError('TMUX_MIGRATION_AMBIGUOUS',
        `migrazione tmux ambigua: ${realName} e gia assegnata a ${owner}`);
    }
    const legacyId = realByName.get(realName);
    if (!/^\$[0-9]+$/.test(legacyId || '')) {
      throw tmuxMigrationError('TMUX_MIGRATION_INVALID_ID',
        `migrazione tmux bloccata per ${candidate.id}: session ID non valido`);
    }
    const safeId = realByName.get(candidate.safe);
    if (safeId && safeId !== legacyId) {
      throw tmuxMigrationError('TMUX_MIGRATION_TARGET_EXISTS',
        `migrazione tmux bloccata per ${candidate.id}: target ${candidate.safe} gia esistente`);
    }
    operations.push({ ...candidate, legacyId, realName });
  }

  const migrated = [];
  for (const operation of operations) {
    const rn = await tmuxExec(tmuxBin,
      ['rename-session', '-t', operation.legacyId, operation.safe], { env: minimalEnv() });
    if (rn.err) {
      throw tmuxMigrationError('TMUX_MIGRATION_RENAME_FAILED',
        `migrazione tmux fallita per ${operation.id} (${boundedTmuxFailure(rn)})`);
    }
    migrated.push({ id: operation.id, from: operation.realName, to: operation.safe });
  }
  return {
    migrated, reason: 'ok',
    needsPersistence: legacyMap.size > 0 || migrated.length > 0,
  };
}

// Policy caratteri del prompt send-keys (§9e): ammette stampabili + \t \n \r;
// rifiuta ESC(0x1b) e gli altri byte di controllo (niente marker bracketed-paste
// iniettabili). parseDefinitions caps solo la lunghezza: questo e' defense-in-depth.
function promptCharsOk(prompt) {
  if (typeof prompt !== 'string') return false;
  for (let i = 0; i < prompt.length; i += 1) {
    const c = prompt.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;        // \t \n \r ammessi
    if (c < 32 || c === 127) return false;                 // ESC/null/altri control
  }
  return true;
}

// ---------------------------------------------------------------------------
// Build the direct child invocation separately from tmux. This lets the secure
// launch broker carry the complete child argv and environment in memory while
// tmux receives only the broker helper path and a one-time nonce.
// ---------------------------------------------------------------------------
function composeClientInvocation(engine, cell) {
  const args = [...(engine.args || [])];
  // model: flag + (override cella || valore engine), solo se c'e' un valore
  if (engine.model) {
    const val = (cell.model != null && cell.model !== '') ? cell.model : engine.model.value;
    if (val) args.push(engine.model.flag, val);
  }
  // prompt flag-mode: promptFlag + prompt cella, solo se c'e' un prompt effettivo.
  // SICUREZZA (design §9h): promptMode 'flag' mette il prompt in ARGV -> e' visibile
  // nella process list (ps) / argv della sessione, a differenza di 'send-keys' che lo
  // inietta DOPO via bracketed paste. Va quindi vincolato a prompt NON-segreti.
  if (engine.promptMode === 'flag' && cell.prompt) {
    args.push(engine.promptFlag, cell.prompt);
  }
  return { command: engine.command, args };
}

// composeLaunchArgv({tmuxSession, realCwd, engine, cell}) -> argv per new-session
// PURA + testabile. Provider values are deliberately absent: no `tmux -e`, no
// environment value and no broker payload ever appears in the tmux client argv.
function composeLaunchArgv({ tmuxSession, realCwd, engine, cell }) {
  const child = composeClientInvocation(engine, cell);
  return ['new-session', '-d', '-s', tmuxSession, '-c', realCwd, child.command, ...child.args];
}

// Poll has-session entro readyMs (no delay fisso cieco). Ritorna true se la sessione
// e' viva entro la deadline, false altrimenti (command uscito / mai partita).
async function waitAlive(tmuxBin, session, { env, readyMs }) {
  const deadline = Date.now() + Math.max(0, readyMs | 0);
  for (;;) {
    const r = await tmuxExec(tmuxBin, ['has-session', '-t', `=${session}`], { env, timeoutMs: 2000 });
    if (!r.err) return true;
    if (Date.now() >= deadline) return false;
    await sleep(60);
  }
}

async function waitStablePane(tmuxBin, target, { env, readyMs }) {
  const deadline = Date.now() + Math.max(0, readyMs | 0);
  for (;;) {
    const state = await tmuxExec(tmuxBin,
      ['display-message', '-p', '-t', target, '#{pane_dead}\t#{pane_dead_status}\t#{pane_id}'],
      { env, timeoutMs: 2000 });
    if (state.err) return { alive: false, status: null, target: null };
    const [dead, rawStatus, paneId] = state.stdout.trim().split('\t');
    if (!/^%[0-9]+$/.test(paneId || '')) return { alive: false, status: null, target: null };
    if (dead === '1') {
      const status = /^-?[0-9]+$/.test(rawStatus || '') ? Number(rawStatus) : null;
      return { alive: false, status, target: paneId };
    }
    if (dead !== '0') return { alive: false, status: null, target: null };
    if (Date.now() >= deadline) return { alive: true, status: null, target: paneId };
    await sleep(60);
  }
}

// Iniezione prompt send-keys via bracketed paste (come skills/.../nc-send):
// load-buffer del prompt in un buffer nominato + paste-buffer -p (bracketed),
// poi cleanup. Readiness best-effort: se la sessione non e' viva quando paste-iamo
// (command gia' uscito) NON digita (design §9e). Ritorna {injected, reason}.
async function injectPrompt(tmuxBin, session, prompt, { env, readyMs = 400, target, engine, cell } = {}) {
  if (!promptCharsOk(prompt)) {
    return { injected: false, reason: 'prompt contiene byte di controllo (rifiutato)' };
  }
  let tmp = null;
  try {
    tmp = path.join(os.tmpdir(), `.ncsend.${session}.${process.pid}.txt`);
    fs.writeFileSync(tmp, prompt, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);

    const alive = await waitAlive(tmuxBin, session, { env, readyMs });
    if (!alive) return { injected: false, reason: 'sessione non viva (command uscito?): nessuna digitazione' };

    // Target esatto: pane id (%N) se disponibile, altrimenti '=sessione' (match
    // esatto, mai prefix-match) — audit impl #5.
    const to = target || `=${session}`;
    await tmuxExec(tmuxBin, ['load-buffer', '-b', 'ncsend', tmp], { env });
    const paste = await tmuxExec(tmuxBin, ['paste-buffer', '-p', '-t', to, '-b', 'ncsend'], { env });
    if (paste.err) return { injected: false, reason: redactSecrets(`paste-buffer failed: ${paste.stderr.trim()}`, engine, cell) };
    return { injected: true, reason: 'bracketed paste (load-buffer + paste-buffer -p)' };
  } finally {
    try { if (tmp) fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    try { await tmuxExec(tmuxBin, ['delete-buffer', '-b', 'ncsend'], { env }); } catch (_) { /* best-effort */ }
  }
}

module.exports = {
  REDACTED,
  MAX_EARLY_DIAGNOSTIC,
  httpError,
  minimalEnv,
  tmuxExec,
  sleep,
  promptCharsOk,
  composeClientInvocation,
  composeLaunchArgv,
  migrateLegacyTmuxSessions,
  waitAlive,
  waitStablePane,
  injectPrompt,
  redactSecrets,
  sanitizeEarlyDiagnostic,
};
