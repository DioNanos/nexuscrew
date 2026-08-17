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

// Campi che SOLO writePidfile puo' scrivere: mai dal chiamante via `extra`.
// Misurato (Dev, 2026-08-17): con lo spread di extra per ultimo,
// writePidfile(f, pid, cmd, {processStart:'FINTO', attestation:'unsupported'})
// vinceva sul valore vero calcolato da probeProcessStart — un chiamante
// poteva scrivere un'attestazione INVENTATA. safeExtra la filtra qui, e i
// campi veri sono comunque scritti DOPO nello spread finale: due barriere,
// non una, perche' un bug nel filtro da solo basterebbe a riaprire il buco.
const RESERVED_META_FIELDS = new Set(['pid', 'cmd', 'startTs', 'uid', 'processStart', 'attestation']);

// Il marker di schema vive ACCANTO al pidfile (stessa directory, es.
// ~/.nexuscrew/), MAI dentro di esso: il pidfile e' il file sospetto, non e'
// lui a poter certificare se stesso. La sua presenza e' un evento ONE-WAY per
// installazione: "codice v2 ha scritto qui almeno una volta", non
// "l'attestazione e' riuscita" — writePidfile lo crea al primo successo,
// qualunque sia l'esito della sonda su quello specifico pid (se lo legassi
// al successo dell'attestazione, su una piattaforma davvero unsupported il
// marker non arriverebbe MAI e il bypass resterebbe aperto per sempre —
// proprio dove serve di piu' che si chiuda). Da quel momento in poi
// (killPidfile, sotto) un pidfile senza nessun campo di attestazione smette
// di essere spiegabile come "legittimo, pre-migrazione": diventa sospetto
// (downgrade, restore da backup, corruzione) e si rifiuta.
//
// TRE CONFINI DICHIARATI, non dedotti — chi indaga un incidente fra sei mesi
// deve trovarli qui, non scoprirli:
// 1. Un restore che riporta indietro l'INTERA directory (~/.nexuscrew/)
//    riporta indietro anche il marker: la finestra di bypass si RIAPRE. Non
//    e' un difetto di questa scelta — non esiste un posto migliore: accanto
//    al binario e' read-only, e l'update lo sovrascrive comunque.
// 2. Con NEXUSCREW_PIDFILE puntato a una directory nuova il marker non c'e',
//    quindi il bypass e' concesso li'. Nei test e' voluto (isolamento senza
//    un parametro home in piu' da cablare); in produzione vuol dire che chi
//    controlla quella variabile d'ambiente controlla anche la finestra — non
//    un confine di sicurezza reale (chi setta l'ambiente del processo ha gia'
//    vinto), ma va detto: il marker non e' una garanzia piu' forte di questa.
// 3. R-pidfile-5: claimSchemaMarker (sotto) crea il marker al KILL, non solo
//    al write — quindi un pidfile che sta per essere RIMOSSO puo' lasciare
//    dietro un marker in una directory che magari non ospitera' mai piu' un
//    runtime. E' INNOCUO: il marker non ha altro effetto che rendere PIU'
//    caute le decisioni FUTURE su quella stessa directory (fail-closed per
//    meta senza attestazione, come se la migrazione fosse gia' avvenuta li'
//    — che e' vero: e' avvenuta, anche se il pidfile che l'ha innescata non
//    c'e' piu'). Il verso del residuo e' sempre quello sicuro: mai una
//    concessione in piu', al massimo un rifiuto in un caso limite di riuso
//    di un percorso abbandonato — coerente col confine 1 sopra.
function schemaMarkerPath(pidfilePath) {
  return path.join(path.dirname(pidfilePath), '.pidfile-schema-v2');
}

// R-pidfile-4 (2026-08-17, audit su develop@437d29f): misurato dall'auditor
// sul frozen — se .pidfile-schema-v2 esiste come DIRECTORY (o symlink, o
// qualunque cosa non sia un file regolare), il vecchio hasSchemaMarker
// tornava `false` per costruzione (isFile() falso), e ensureSchemaMarker
// ingoiava OGNI errore della creazione (EEXIST incluso) senza distinguere.
// Risultato: il marker non nasceva MAI, ogni writePidfile successiva
// ripeteva lo stesso fallimento silenzioso, e "nessun marker" veniva letto
// come "pre-migrazione" — concedendo ambiguous-compat PER SEMPRE, non un
// giro in piu'. L'errore di fondo: la scrittura e' best-effort per buoni
// motivi (non deve mai far fallire writePidfile), ma un fallimento della
// scrittura si traduceva in "stato assente", cioe' nella risposta
// PERMISSIVA. Un meccanismo che non riesce a determinare il proprio stato
// non deve concedere: deve chiudere. L'incertezza va nella direzione
// sicura, sempre — lo stesso principio di isAlive/isAttributable in questo
// file, applicato qui al marker invece che al pid.
//
// La decisione al KILL non LEGGE se il marker esiste: PROVA A CREARLO adesso
// (claimSchemaMarker). Leggerlo soltanto lasciava fuori il caso in cui la
// scrittura era fallita senza lasciare traccia sul percorso — disco pieno,
// sola lettura, permesso transitorio: il percorso resta libero, la lettura
// dice 'assente', e si concedeva per sempre. Una prova fatta ORA ha una
// risposta verificabile; un evento passato che nessuno ha osservato no.
//   'created'        — non c'era e la creazione riesce adesso: pre-migrazione
//                       vera -> ambiguous-compat concesso UNA volta, e da qui
//                       in poi il marker esiste per davvero.
//   'present'        — EEXIST su file regolare (mai symlink: lstat, non stat)
//                       -> post-migrazione, fail-closed.
//   'undeterminable' — EEXIST su un tipo non atteso, oppure la creazione
//                       fallisce ADESSO per qualunque motivo (ostacolo,
//                       ENOSPC, EROFS, permessi, race) -> fail-closed, con il
//                       motivo che nomina la causa. Il fallimento della
//                       scrittura non e' un effetto collaterale da temere: e'
//                       il segnale che produce la risposta sicura.
// `checkSchemaMarker` resta come lettura pura per diagnostica e test, ma non
// guida piu' nessuna decisione di sicurezza.
//
// COSTO DICHIARATO: su un'installazione nuova con un ostacolo gia' presente
// su quel percorso, la PRIMA fermata dopo l'aggiornamento fallisce invece di
// essere concessa (nessun modo di distinguere "ostacolo innocente" da
// "ostacolo messo li' apposta" — e non e' compito di questa funzione
// indovinarlo). E' il verso giusto: un errore che dice cosa succede e' meglio
// di un bypass che non lo dice — ma va scritto qui, non scoperto da chi
// indaga un incidente.
function checkSchemaMarker(pidfilePath) {
  const markerPath = schemaMarkerPath(pidfilePath);
  let st;
  try {
    st = fs.lstatSync(markerPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'undeterminable', reason: `marker path not readable (${(e && e.code) || 'unknown error'})` };
  }
  if (st.isSymbolicLink()) return { state: 'undeterminable', reason: 'marker path is a symlink, not a regular file' };
  if (!st.isFile()) return { state: 'undeterminable', reason: 'marker path occupied by a non-regular-file' };
  return { state: 'present' };
}

// Wrapper booleano SOLO per lettura passiva (test, diagnostica esterna) —
// non guida piu' la decisione di sicurezza: vedi claimSchemaMarker sotto,
// che e' cosa killPidfile usa davvero. SOLO 'present' e' true.
// 'undeterminable' NON e' 'absent' — tornerebbe a leggere l'incertezza come
// permissiva, l'errore del giro precedente.
function hasSchemaMarker(pidfilePath) {
  return checkSchemaMarker(pidfilePath).state === 'present';
}

// Best-effort per costruzione: EEXIST (un altro processo ha appena scritto
// lo stesso marker, avvii concorrenti allo start) e' il caso NORMALE di un
// evento one-way, non un errore. Qualunque ALTRO fallimento (un ostacolo al
// path, permessi, disco pieno) non deve MAI far fallire writePidfile — il
// pidfile e' gia' stato scritto quando arriviamo qui, ed e' lui
// l'informazione che conta.
//
// R-pidfile-5 (2026-08-17, audit su develop@fa8bd90): questa funzione NON
// garantisce piu' nulla sul futuro — prima il commento qui diceva "il
// prossimo killPidfile lo scoprira' da solo", ed era FALSO: se questa
// scrittura fallisce con ENOSPC/EROFS/quota/permesso transitorio, non resta
// NESSUNA traccia sul filesystem (il path resta ENOENT, esattamente come se
// non si fosse mai tentato) — una garanzia dichiarata che il codice non
// aveva. La chiusura vera non dipende da questa funzione: killPidfile (vedi
// claimSchemaMarker) non si fida di un evento passato non osservabile,
// riprova la creazione ADESSO, nell'istante in cui la decisione conta. Se
// funziona ancora qui (il caso comune: nessun ostacolo, disco con spazio) e'
// solo un'ottimizzazione — anticipa la migrazione al primo write invece di
// aspettare il primo kill su un meta ambiguo — non la fonte della garanzia.
function ensureSchemaMarker(pidfilePath) {
  try {
    fs.writeFileSync(schemaMarkerPath(pidfilePath), `${JSON.stringify({ since: Date.now() })}\n`,
      { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e && e.code === 'EEXIST') return; // normale: gia' scritto da un altro avvio
    // Qualunque altro fallimento: mai propagare. Non promettiamo che qualcun
    // altro se ne accorgera' — vedi claimSchemaMarker per la vera garanzia.
  }
}

// R-pidfile-5: LA decisione di sicurezza. checkSchemaMarker (sopra) guarda
// un EVENTO PASSATO — "il marker e' stato scritto" — che puo' fallire in
// silenzio senza lasciare traccia (vedi ensureSchemaMarker): il percorso
// resta ENOENT, indistinguibile da "mai tentato". claimSchemaMarker sposta
// la domanda da "e' successo in passato?" a "posso ADESSO?" — verificabile
// nell'istante in cui la decisione conta, non dedotta da una scrittura che
// potrebbe essere fallita senza lasciare traccia:
//   'created'        — non c'era, la creazione ORA riesce: il percorso era
//                       davvero libero, non solo "sembrava" (perche' una
//                       scrittura precedente era fallita in silenzio).
//                       Pre-migrazione per davvero — e ORA il marker esiste
//                       per davvero: i prossimi kill lo vedranno 'present'.
//   'present'        — EEXIST su un file regolare: gia' migrato (invariato).
//   'undeterminable' — EEXIST su un simlink/non-file, O la creazione
//                       fallisce ADESSO per qualunque altro motivo (ENOSPC,
//                       EROFS, EACCES/EPERM, EISDIR, una race): non sappiamo
//                       perche' in generale, ma sappiamo che ORA non si puo'
//                       scrivere qui — ed e' esattamente la domanda che
//                       conta, verificata nel momento giusto invece che
//                       dedotta da un momento passato che potrebbe mentire.
//
// killPidfile diventa, in questo solo ramo, una funzione che SCRIVE (crea un
// file nuovo), non solo rimuove: valutato deliberatamente, non per svista.
// Ogni chiamante che puo' leggere un pidfile in questa directory ha gia',
// nella prassi di questo prodotto, permesso di scrittura sulla STESSA
// directory (e' li' che pidfile.js scrive di suo — ~/.nexuscrew/ o
// l'override NEXUSCREW_PIDFILE): non attraversa un confine di permessi che
// non fosse gia' presupposto per arrivare a chiamare killPidfile affatto.
// Se la scrittura genuinamente non e' permessa o e' pericolosa li' (EROFS,
// policy), il ramo 'undeterminable' rifiuta — la scrittura fallita e'
// proprio il segnale che produce la risposta sicura, non un effetto
// collaterale da temere.
function claimSchemaMarker(pidfilePath) {
  const markerPath = schemaMarkerPath(pidfilePath);
  try {
    fs.writeFileSync(markerPath, `${JSON.stringify({ since: Date.now() })}\n`, { flag: 'wx', mode: 0o600 });
    return { state: 'created' };
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      let st;
      try { st = fs.lstatSync(markerPath); }
      catch (e2) { return { state: 'undeterminable', reason: `marker path not readable after EEXIST (${(e2 && e2.code) || 'unknown error'})` }; }
      if (st.isSymbolicLink()) return { state: 'undeterminable', reason: 'marker path is a symlink, not a regular file' };
      if (!st.isFile()) return { state: 'undeterminable', reason: 'marker path occupied by a non-regular-file' };
      return { state: 'present' };
    }
    return { state: 'undeterminable', reason: `marker not creatable now (${(e && e.code) || 'unknown error'})` };
  }
}

// Exclusive create (wx): fallisce se il pidfile esiste già (no overwrite silenzioso).
// La classificazione (attested/unsupported/indeterminate) si decide QUI, alla
// creazione, non al kill: e' un fatto su questo tentativo di attestazione,
// non qualcosa da ricalcolare piu' tardi con lo stesso rischio di confondere
// "non so attestare" con "non ci sono riuscito adesso" (vedi killPidfile).
function writePidfile(p, pid, cmd, extra = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const rawExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  const safeExtra = {};
  for (const key of Object.keys(rawExtra)) {
    if (!RESERVED_META_FIELDS.has(key)) safeExtra[key] = rawExtra[key];
  }
  const { value: processStart, cause } = probeProcessStart(pid);
  const uid = currentUid();
  const meta = JSON.stringify({
    ...safeExtra,
    pid, cmd: cmd || '', startTs: Date.now(),
    ...(uid === null ? {} : { uid }),
    ...(processStart ? { processStart } : { attestation: cause }),
  });
  fs.writeFileSync(p, meta + '\n', { flag: 'wx', mode: 0o600 });
  ensureSchemaMarker(p);
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
  let schemaMarker = null; // calcolato pigro: solo se serve davvero (vedi sotto)
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
    unverifiedBirth = 'unsupported';
  } else if (meta.attestation === 'indeterminate') {
    // Il codice NUOVO (questo, o una versione successiva a questo fix) ha
    // PROVATO ad attestare alla creazione e non ci e' riuscito per un motivo
    // che non sa classificare come proprieta' della piattaforma (vedi
    // probeProcessStart sopra) — sa che avrebbe potuto, su questo pid,
    // adesso, e non ce l'ha fatta. Trattarlo come "la piattaforma non sa
    // attestare" sarebbe l'errore di categoria contestato dall'audit:
    // un'assenza non e' una proprieta' stabile solo perche' e' comoda da
    // leggere cosi'. Si rifiuta: il cmd da solo matcha per inclusioni, e non
    // basta a chi non sa nemmeno perche' la nascita manca QUI. Il pidfile
    // NON si tocca, per lo stesso motivo del ramo attestato-ma-illeggibile
    // sopra: non sappiamo se sia stale.
    return { killed: false, reason: 'unattested pidfile (attestation indeterminate: a fresh attempt failed): refusing to signal a pid identified only by cmd' };
  } else {
    // NE' processStart NE' attestation nel meta: non "il codice nuovo ha
    // provato e fallito" (quello e' il ramo indeterminate sopra) — e' un
    // pidfile scritto da un codice che l'attestazione non la conosceva
    // affatto, O un file scritto fuori da writePidfile del tutto (la stessa
    // forma di meta la puo' produrre anche un chiamante non nostro): "nessun
    // campo" da solo non prova la provenienza.
    //
    // R-pidfile-5: la domanda che decide non e' piu' "il marker e' gia'
    // stato scritto?" (un evento passato che puo' fallire in silenzio —
    // vedi ensureSchemaMarker/claimSchemaMarker sopra) ma "posso scriverlo
    // ADESSO?" — claimSchemaMarker prova a crearlo in questo esatto istante:
    //   'created'        — non c'era davvero: QUESTA installazione non ha
    //                       ancora mai completato una scrittura v2. Pre-
    //                       migrazione per davvero, non solo "sembrava" —
    //                       compatibilita' ambigua concessa UNA volta, e ORA
    //                       il marker esiste per davvero: il prossimo kill
    //                       su questa directory lo vedra' 'present'.
    //   'present'        — codice v2 ha gia' scritto qui (o un kill
    //                       precedente l'ha appena creato): non e' piu'
    //                       spiegabile come pre-migrazione — sospetto
    //                       (downgrade, restore parziale del solo pidfile,
    //                       corruzione). Si rifiuta.
    //   'undeterminable' — la creazione fallisce ADESSO (ostacolo strutturale
    //                       — directory, symlink — o ENOSPC/EROFS/permesso
    //                       transitorio/una race): non sappiamo perche' in
    //                       generale, ma sappiamo che ORA non si puo'
    //                       scrivere qui, verificato nell'istante in cui
    //                       conta, non dedotto da uno passato. Si rifiuta.
    //
    // MISURATO (Dev, 2026-08-17): trattare OGNI meta senza attestazione come
    // indeterminate rompe l'aggiornamento automatico per ogni nodo il cui
    // runtime e' ancora precedente a quando processStart e' nato (8fe514f,
    // v0.9.0) — npm install sovrascrive pidfile.js PRIMA che il runner lo
    // richieda, il runner legge il pidfile VECCHIO del runtime in esecuzione,
    // killPidfile rifiuta, stopPortableRuntime torna killed:false,
    // restartRuntime lancia, l'update muore (lib/update/runner.js). Il nodo
    // resta indietro finche' qualcuno non interviene a mano — su un telefono
    // Termux spesso vuol dire mai. Il rischio del ramo pid+cmd (concesso solo
    // su 'created') e' quello che il prodotto ha GIA' in produzione oggi, ne'
    // piu' ne' meno: non lo peggioriamo. Il PID reuse che questo ramo non
    // vede richiede una coincidenza (numero riassegnato E cmd compatibile);
    // il blocco dell'aggiornamento sarebbe invece CERTO per ogni nodo in
    // questo stato, ogni volta. Fra un rischio raro gia' presente e un
    // guasto sicuro introdotto da noi, si sceglie di non introdurre il
    // guasto — decisione di prodotto, non mia.
    //
    // Alternative valutate e scartate: far degradare il runner invece di
    // morire (il difetto gia' visto sul campo che l'ingresso unico di
    // riavvio doveva chiudere); un ramo "legacy" permanente basato sulla sola
    // FORMA del meta (lasciava aperti per sempre restore da backup,
    // corruzione e downgrade — l'auditor l'ha contestato); un marker
    // controllato ma mai riprovato al kill (questo giro — R-pidfile-5:
    // l'auditor ha dimostrato che una scrittura fallita in silenzio riapre
    // lo stesso buco senza lasciare traccia).
    schemaMarker = (impl.claimSchemaMarkerImpl || claimSchemaMarker)(p);
    if (schemaMarker.state === 'created') {
      unverifiedBirth = 'ambiguous-compat';
    } else {
      const causa = schemaMarker.state === 'present' ? 'schema migration' : `marker state undeterminable: ${schemaMarker.reason}`;
      return { killed: false, reason: `unattested pidfile after ${causa}: refusing to signal a pid identified only by cmd` };
    }
  }
  try {
    // Qui si chiude la verifica e si entra nella finestra residua dichiarata
    // sopra: nessuna riverifica fra questo punto e il segnale, per scelta.
    killImpl(meta.pid, signal);
    // allowLive: il segnale e' partito verso il pid VERIFICATO del file (cmd
    // matchato sopra): la rimozione e' giusta anche se il processo non e' ancora
    // sparito da /proc quando unlink gira.
    removePidfile(p, { allowLive: true });
    return { killed: true, pid: meta.pid, ...(unverifiedBirth ? { unverifiedBirth } : {}) };
  } catch (e) {
    return { killed: false, reason: e.message };
  }
}

module.exports = {
  defaultPidfilePath, readPidfile, writePidfile, removePidfile,
  currentUid, readProcessStart, probeProcessStart, pidOwnership, pidExists, readCmdline,
  isAlive, isAttributable, cleanStale, killPidfile,
  schemaMarkerPath, hasSchemaMarker, checkSchemaMarker, claimSchemaMarker,
};
