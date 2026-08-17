'use strict';
// Pidfile con verified kill: metadata {pid, cmd, startTs}; kill verifica cmd+pid
// prima di signalare (no broad match by name). Il controllo pid+nascita riduce
// il PID reuse a una finestra residua fra verifica e segnale — non lo elimina;
// dettaglio e motivo nel commento sopra il kill in killPidfile. [R1]
// Primario su Termux (serve --pidfile); opzionale --manual su linux/mac.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function defaultPidfilePath(home = os.homedir()) {
  return process.env.NEXUSCREW_PIDFILE || path.join(home, '.nexuscrew', 'nexuscrew.pid');
}

function readPidfile(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (obj && typeof obj === 'object' && Number.isFinite(obj.pid)) ? obj : null;
  } catch (_) { return null; }
}

function currentUid() {
  try { return typeof process.getuid === 'function' ? process.getuid() : null; }
  catch (_) { return null; }
}

// `/proc/<pid>/stat` field 22 is the kernel start tick.  Unlike a PID or an
// argv it cannot be recreated by a later process.  macOS has no /proc, so a
// conservative `ps lstart` fallback still combines with UID, argv and runId.
//
// probeProcessStart espone anche la CAUSA del fallimento (non solo il suo
// esito): serve a writePidfile per distinguere, alla creazione, «questa
// piattaforma non sa attestare le nascite» (fatto stabile) da «il tentativo
// e' fallito su QUESTO pid per un motivo che non sappiamo escludere
// transitorio» (non un fatto sulla piattaforma). Guardando solo se il
// risultato e' null le due cose sono indistinguibili — ed e' esattamente
// l'errore di categoria che questa funzione evita: unsupported si dichiara
// SOLO quando ENTRAMBI i meccanismi (proc e ps) sono strutturalmente
// impossibili qui — /proc assente o negato con EACCES/EPERM (una policy di
// visibilita' di sistema, non un fatto su un pid), E il binario `ps` stesso
// non si trova (ENOENT sullo spawn, non un suo rifiuto degli argomenti, che
// potrebbe voler dire tante cose diverse e non le distinguiamo in modo
// affidabile). Ogni altro fallimento resta indeterminate: onesto, non
// generoso.
function probeProcessStart(pid) {
  let procStructurallyBlocked = false;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const match = raw.match(/^\d+\s+\([^)]*\)\s+(.+)$/);
    const fields = match && match[1].trim().split(/\s+/);
    const ticks = fields && fields[19]; // field 22, after state=field 3
    if (/^\d+$/.test(String(ticks || ''))) return { value: `linux:${ticks}`, cause: null };
  } catch (e) {
    const denied = e && (e.code === 'EACCES' || e.code === 'EPERM');
    const procMissing = e && e.code === 'ENOENT' && !fs.existsSync('/proc');
    procStructurallyBlocked = Boolean(denied || procMissing);
  }
  let psMissing = false;
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    if (text) return { value: `ps:${text}`, cause: null };
  } catch (e) {
    psMissing = Boolean(e && e.code === 'ENOENT');
  }
  const unsupported = procStructurallyBlocked && psMissing;
  return { value: null, cause: unsupported ? 'unsupported' : 'indeterminate' };
}

function readProcessStart(pid) {
  return probeProcessStart(pid).value;
}

// Exclusive create (wx): fallisce se il pidfile esiste già (no overwrite silenzioso).
// La classificazione (attested/unsupported/indeterminate) si decide QUI, alla
// creazione, non al kill: e' un fatto su questo tentativo di attestazione,
// non qualcosa da ricalcolare piu' tardi con lo stesso rischio di confondere
// "non so attestare" con "non ci sono riuscito adesso" (vedi killPidfile).
function writePidfile(p, pid, cmd, extra = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const safeExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  const { value: processStart, cause } = probeProcessStart(pid);
  const uid = currentUid();
  const meta = JSON.stringify({
    pid, cmd: cmd || '', startTs: Date.now(),
    ...(uid === null ? {} : { uid }),
    ...(processStart ? { processStart } : { attestation: cause }),
    ...safeExtra,
  });
  fs.writeFileSync(p, meta + '\n', { flag: 'wx', mode: 0o600 });
}

// La rimozione NON e' un unlink nudo. Il pidfile e' la prova che un processo
// e' vivo: togliere quello di un VIVO che non siamo noi significa cancellarla
// — chi governa quel processo (stop, doctor, supervisor) lo crederebbe morto,
// o peggio adotterebbe uno slot libero che e' occupato. La rimozione e'
// legittima in tre casi, verificati QUI:
//   1. il pidfile e' il NOSTRO (meta.pid === process.pid): self-cleanup;
//   2. e' STALE: il pid e' morto o non e' piu' attribuibile al cmd registrato;
//   3. non e' leggibile come pidfile: garbage, non il pidfile di nessuno.
// `allowLive: true` e' la garanzia del CHIAMANTE, non un bypass: killPidfile la
// usa DOPO un kill verificato del pid esatto del file; il supervisor dei tunnel
// dopo il match pid+runId del proprio spawn. Quelle vie verificano il soggetto
// per conto loro prima di dichiararlo. Ritorna false (e non tocca il file) se
// il pidfile appartiene a un vivo che non siamo noi e non c'e' garanzia.
function removePidfile(p, { allowLive = false, impl = {} } = {}) {
  const meta = readPidfile(p);
  if (!allowLive && meta && meta.pid !== process.pid && isAlive(meta, impl)) {
    return false; // pidfile di un processo vivo che non siamo noi: resta
  }
  try { fs.unlinkSync(p); } catch (_) {}
  return true;
}

// A PID can exist without belonging to this UID. Android commonly reuses PIDs
// across app sandboxes; kill(pid, 0) then returns EPERM and /proc is hidden.
// Keep generic existence separate from NexusCrew ownership so a foreign PID
// can never keep one of our pidfiles "alive" forever.
function pidOwnership(pid, killImpl = process.kill) {
  try {
    killImpl(pid, 0);
    return 'owned';
  } catch (e) {
    if (e && e.code === 'EPERM') return 'foreign';
    if (e && e.code === 'ESRCH') return 'missing';
    return 'unknown';
  }
}

function pidExists(pid, killImpl = process.kill) {
  const ownership = pidOwnership(pid, killImpl);
  return ownership === 'owned' || ownership === 'foreign';
}

function readCmdline(pid) {
  // Linux/Termux: /proc/<pid>/cmdline; fallback ps (mac)
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (_) {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
    catch (_) { return ''; }
  }
}

function cmdMatches(savedCmd, liveCmd) {
  if (!savedCmd || !liveCmd) return true; // conservativo: non posso verificare, assumo match (no broad-kill)
  return liveCmd.includes(savedCmd) || savedCmd.includes(liveCmd);
}

// true se il pid appartiene a questo UID, la NASCITA è ancora quella attestata
// dal pidfile e il cmd matcha (o non è verificabile).
// EPERM is deliberately false: NexusCrew must neither adopt nor signal a
// process owned by another Android/Linux user.
// La nascita (processStart, già scritta da writePidfile) decide PRIMA del cmd:
// cmdMatches è per inclusioni, quindi un comando più lungo del salvato matcha
// — due supervisor dello stesso tunnel, due serve, il restart di ieri. Se il
// numero è nato in un istante diverso da quello attestato, il proprietario è
// morto e il numero è di un altro: il pidfile è stale anche se il cmd «quadra».
// Non calcolabile (meta senza processStart: pidfile vecchio o /proc nascosto;
// lettura che ora non riesce: macOS senza ps) → nel dubbio vale il cmd, come
// sempre: mai dichiarare morto un vivo. Stessa identità e stessa asimmetria
// del lock delle definizioni (pid + nascita; il falso-morto non esiste).
function isAlive(meta, impl = {}) {
  if (!meta || !Number.isFinite(meta.pid)) return false;
  if (pidOwnership(meta.pid, impl.killImpl || process.kill) !== 'owned') return false;
  if (meta.processStart) {
    const liveStart = (impl.readProcessStartImpl || readProcessStart)(meta.pid);
    if (liveStart && liveStart !== meta.processStart) return false; // riassegnato
  }
  if (meta.cmd) {
    const live = (impl.readCmdlineImpl || readCmdline)(meta.pid);
    if (live) return cmdMatches(meta.cmd, live);
  }
  return true;
}

// Strong ownership used by per-slot reverse supervisors.  Older generic
// pidfiles remain readable for lifecycle compatibility, but a rotatable slot
// is never stopped or adopted unless all four local facts are present.
function isAttributable(meta, impl = {}) {
  if (!meta || !Number.isFinite(meta.pid) || !Number.isInteger(meta.uid)
    || typeof meta.processStart !== 'string' || !meta.processStart) return false;
  const uid = impl.currentUidImpl ? impl.currentUidImpl() : currentUid();
  if (uid === null || uid !== meta.uid) return false;
  if (!isAlive(meta, impl)) return false;
  const liveStart = (impl.readProcessStartImpl || readProcessStart)(meta.pid);
  return typeof liveStart === 'string' && liveStart === meta.processStart;
}

// Rimuove pidfile stale (pid morto o non verificabile). Ritorna true se rimosso.
function cleanStale(p, impl = {}) {
  const meta = readPidfile(p);
  if (!meta) return false;
  if (!isAlive(meta, impl)) { removePidfile(p); return true; }
  return false;
}

// Kill verificato: legge pidfile, verifica pid+cmd, signal. MAI broad match by name.
// Ritorna { killed, pid?, reason? }.
function killPidfile(p, signal = 'SIGTERM', impl = {}) {
  const meta = readPidfile(p);
  if (!meta) return { killed: false, reason: 'no pidfile' };
  const killImpl = impl.killImpl || process.kill;
  const ownership = pidOwnership(meta.pid, killImpl);
  if (ownership === 'missing' || ownership === 'unknown') {
    removePidfile(p);
    return { killed: false, reason: 'stale (pid dead)' };
  }
  if (ownership === 'foreign') {
    // Never send a real signal after an EPERM ownership probe. The pidfile is
    // ours; the process is not.
    removePidfile(p);
    return { killed: false, reason: 'stale (pid not owned)' };
  }
  if (meta.cmd) {
    const live = (impl.readCmdlineImpl || readCmdline)(meta.pid);
    if (live && !cmdMatches(meta.cmd, live)) {
      // PID reuse: processo diverso. Non killare. Rimuovi pidfile stale.
      removePidfile(p);
      return { killed: false, reason: 'pid reuse (cmd mismatch)', liveCmd: live };
    }
  }
  // PID reuse che il cmd NON vede: due processi con lo stesso comando (o un
  // comando che lo contiene). La nascita li distingue — ma solo AL MOMENTO DI
  // QUESTO CONTROLLO. Se la nascita letta ORA non corrisponde a quella
  // attestata, il proprietario è già morto e il numero è di un altro: qui la
  // garanzia regge, il pidfile è stale e si toglie senza segnalare.
  //
  // Quello che questa verifica NON copre: fra la lettura di liveStart qui e
  // killImpl() poco sotto non c'è atomicità. Se il proprietario muore in
  // quell'istante e il kernel riassegna il pid prima del kill, il segnale
  // parte verso il sostituto — identità confermata un momento fa, non nel
  // momento in cui conta. Questa finestra è intrinseca al modello pid+segnale
  // di POSIX (kill(2) non lega il segnale all'identità appena controllata) e
  // non si chiude qui: la verifica sopra riduce l'esposizione da "sempre" a
  // "l'istante fra questo controllo e il kill", non la elimina. La cura vera
  // è pidfd_open + pidfd_send_signal (il segnale è legato a un file
  // descriptor, non a un numero riassegnabile); Node non la espone senza un
  // addon nativo, e un addon per un prodotto che gira anche su Termux e
  // macOS costa più di quanto renda. Una rilettura dopo il kill non chiude
  // la finestra — è best-effort, non rilevazione certa: il riusato può
  // essere già uscito, e la rilettura corre a sua volta la stessa corsa. Non
  // aggiungerne una come se fosse una guardia.
  //
  // Prima di questo controllo (nascita, aggiunta dopo cmd) il segnale
  // partiva sul solo cmd, senza verifica di identità, per QUALUNQUE pidfile
  // senza processStart — vecchio o nuovo, piattaforma capace o no: era
  // esattamente il buco piu' largo trovato dall'audit (2026-08-17), perche'
  // "nessuna nascita nel meta" copriva sia "questa macchina non sa attestare"
  // sia "l'attestazione e' fallita alla creazione per un motivo che non
  // conosciamo" con lo STESSO comportamento permissivo. Il ramo sotto separa
  // i due casi guardando cosa writePidfile ha DICHIARATO al momento in cui
  // contava (probeProcessStart, sopra), non ricalcolando una sonda adesso —
  // rifarla qui confonderebbe di nuovo "non so attestare" con "non ci sono
  // riuscito in QUESTO istante", l'errore di categoria che l'audit ha
  // contestato nel primo disegno di questo fix.
  let unverifiedBirth = false;
  if (meta.processStart) {
    const liveStart = (impl.readProcessStartImpl || readProcessStart)(meta.pid);
    if (liveStart && liveStart !== meta.processStart) {
      removePidfile(p, { allowLive: true });
      return { killed: false, reason: 'pid reuse (start mismatch)' };
    }
    // Nascita ATTESTATA ma non rileggibile ora (/proc nascosto, ps assente,
    // permessi): l'identita' non e' verificabile, e questa e' un'operazione
    // DISTRUTTIVA. Il cmd da solo non discrimina — matcha per inclusioni, e
    // due processi con lo stesso comando si somigliano. Si rinuncia: un
    // segnale mancato costa un pidfile stale, un segnale sbagliato uccide il
    // processo di qualcun altro. Il pidfile NON si tocca: non sappiamo se sia
    // stale.
    if (!liveStart) {
      return { killed: false, reason: 'start unverifiable (refusing to signal)' };
    }
  } else if (meta.attestation === 'unsupported') {
    // DICHIARATO alla creazione: ne' /proc ne' `ps` esistevano affatto su
    // questa macchina (probeProcessStart, causa strutturale — non un pid
    // specifico che non rispondeva). Nessun pidfile su questa macchina potra'
    // MAI avere una nascita: qui e' dove un fail-closed spegnerebbe il
    // prodotto proprio dove serve (Termux, primario — vedi testa del file).
    // Si ricade sul criterio storico pid+cmd, ma DICHIARATO nel risultato
    // (unverifiedBirth sotto), non in silenzio.
    //
    // ONESTO NON VUOL DIRE SICURO: su una piattaforma davvero unsupported la
    // proprieta' "mai segnalare un PID solo ereditato" NON E' GARANTITA — un
    // pid morto qui e riassegnato a un processo nostro con cmd compatibile
    // riceve comunque il segnale, perche' senza nascita non c'e' modo di
    // vedere il riassegno. Dichiarare il degrado lo rende TRACCIABILE, non
    // lo chiude. Se un giorno serve la garanzia anche qui, la via non e' un
    // altro probe su PID/cmd (la stessa prova debole con un altro nome): serve
    // una prova ALTERNATIVA del proprietario — per esempio un runId verificato
    // contro un endpoint locale autenticato. Non e' implementata: e' un lavoro
    // a se', con un suo giro di audit (registrato qui, non eseguito).
    unverifiedBirth = true;
  } else {
    // meta.attestation === 'indeterminate', oppure il campo manca del tutto
    // (pidfile scritto prima di questo fix, o da codice ancora piu' vecchio
    // pre-R1: un quarto caso che non sappiamo distinguere da un tentativo
    // fallito per un motivo transitorio). In ENTRAMBI i casi non sappiamo se
    // "nessuna nascita" significa "questa piattaforma non sa attestare" — qui
    // sarebbe lecito ricadere sul cmd — o solo che il tentativo di questa
    // creazione, specifica, non ci e' riuscito per un motivo che potrebbe
    // riguardare solo QUESTO pid, non la piattaforma. Trattarlo come il primo
    // sarebbe l'errore di categoria contestato dall'audit: un'assenza non e'
    // una proprieta' stabile solo perche' e' comoda da leggere cosi'. Si
    // rifiuta: il cmd da solo matcha per inclusioni, e non basta a chi non
    // sa nemmeno perche' la nascita manca. Il pidfile NON si tocca, per lo
    // stesso motivo del ramo attestato-ma-illeggibile sopra: non sappiamo se
    // sia stale. Costo dichiarato: un pidfile scritto da una versione
    // precedente a questo fix richiede UN riavvio/stop manuale la prima
    // volta dopo l'aggiornamento — un fallimento visibile, non un segnale
    // silenzioso al bersaglio sbagliato.
    return { killed: false, reason: 'unattested pidfile (attestation indeterminate or never attempted): refusing to signal a pid identified only by cmd' };
  }
  try {
    // Qui si chiude la verifica e si entra nella finestra residua dichiarata
    // sopra: nessuna riverifica fra questo punto e il segnale, per scelta.
    killImpl(meta.pid, signal);
    // allowLive: il segnale e' partito verso il pid VERIFICATO del file (cmd
    // matchato sopra): la rimozione e' giusta anche se il processo non e' ancora
    // sparito da /proc quando unlink gira.
    removePidfile(p, { allowLive: true });
    return { killed: true, pid: meta.pid, ...(unverifiedBirth ? { unverifiedBirth: true } : {}) };
  } catch (e) {
    return { killed: false, reason: e.message };
  }
}

module.exports = {
  defaultPidfilePath, readPidfile, writePidfile, removePidfile,
  currentUid, readProcessStart, probeProcessStart, pidOwnership, pidExists, readCmdline,
  isAlive, isAttributable, cleanStale, killPidfile,
};
