'use strict';

// Detached supervisor for one SSH tunnel. The parent NexusCrew process can exit;
// this process keeps the tunnel alive and retries failures with bounded backoff.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { backoffDelay, classifySshFailure } = require('./tunnel.js');

const sshBin = process.argv[2];
const sshArgs = process.argv.slice(3);
const statePath = process.env.NEXUSCREW_TUNNEL_STATE;
const pidPath = process.env.NEXUSCREW_TUNNEL_PIDFILE;
const runId = process.env.NEXUSCREW_TUNNEL_RUN_ID;
const stableMsRaw = Number(process.env.NEXUSCREW_TUNNEL_STABLE_MS || 3000);
const stableMs = Number.isFinite(stableMsRaw) && stableMsRaw >= 100 ? Math.min(stableMsRaw, 30000) : 3000;
const ownershipGraceRaw = Number(process.env.NEXUSCREW_TUNNEL_OWNERSHIP_GRACE_MS || 2000);
const ownershipGraceMs = Number.isFinite(ownershipGraceRaw) && ownershipGraceRaw >= 100
  ? Math.min(ownershipGraceRaw, 10000) : 2000;
const reverseFailureMaxRaw = Number(process.env.NEXUSCREW_TUNNEL_REVERSE_FAILURE_MAX || 8);
const reverseFailureMax = Number.isInteger(reverseFailureMaxRaw) && reverseFailureMaxRaw >= 1
  ? Math.min(reverseFailureMaxRaw, 32) : 8;
// R19 seguito — contratto per la sonda del canale -L quando non conclude MAI:
// continuare a sondare ogni 250ms e' giusto per la finestra transitoria (il
// servizio remoto non e' ancora su dopo un restart/aggiornamento: la prossima
// sonda e' una connessione FRESCA, si qualifica da sola appena il servizio
// risponde) ma sbagliato oltre — un vero permitopen mancante o un servizio
// remoto permanentemente giu' non si risolvono mai da soli, e la sonda gira
// per sempre senza mai diventare osservabile ne' degradare, la stessa cosa
// che l'assenza di storia delle transizioni peer faceva prima di questo
// registro. 60 tentativi * 250ms = 15s, lo stesso budget di attesa gia' in
// uso altrove in questo prodotto per "il runtime e' tornato sano dopo un
// riavvio" (vedi healthAttempts/healthDelayMs in lib/update/runner.js): oltre
// quella soglia il canale entra in degraded, ESATTAMENTE come il fallimento
// del forward inverso — stesso stato, stessa auto-guarigione a cadenza fissa,
// mai un "pronto" dichiarato senza averlo verificato (sarebbe la stessa bugia
// che R19 ha tolto, solo con una bandiera "non verificato" appesa sopra).
const channelProbeMaxRaw = Number(process.env.NEXUSCREW_TUNNEL_CHANNEL_PROBE_MAX || 60);
const channelProbeMax = Number.isInteger(channelProbeMaxRaw) && channelProbeMaxRaw >= 1
  ? Math.min(channelProbeMaxRaw, 240) : 60;
// Once the initial reverse-forward budget is exhausted the supervisor does NOT
// die: it stays "degraded" and retries at the fixed production cadence of 60s,
// so a transient reverse listener on the hub (e.g. a mobile reconnect) heals on
// its own without an OFF/ON.  A short cadence is a test-only seam, never a
// production runtime override: otherwise a bad environment value could recreate
// the retry storm that this breaker is meant to prevent.
const steadyRetryTestMode = process.env.NEXUSCREW_TUNNEL_TEST_MODE === '1';
const steadyRetryMsRaw = Number(steadyRetryTestMode ? (process.env.NEXUSCREW_TUNNEL_STEADY_RETRY_MS || 60000) : 60000);
const steadyRetryMinMs = steadyRetryTestMode ? 1 : 60000;
const steadyRetryMs = Number.isFinite(steadyRetryMsRaw) && steadyRetryMsRaw >= steadyRetryMinMs
  ? Math.min(steadyRetryMsRaw, 120000) : 60000;
if (require.main === module && (!sshBin || !statePath || !pidPath || !runId)) process.exit(2);

let child = null;
let stopping = false;
let attempt = 0;
let retryTimer = null;
let upTimer = null;
let forwardProbeTimer = null;
let forwardSocket = null;
let ownershipWaitTimer = null;
let ownershipTimer = null;
let reverseFailures = 0;
let channelRefusedLogged = false;
let channelProbeFailures = 0;

function localForwardPort(args) {
  return localForwardPorts(args)[0] || null;
}
function localForwardPorts(args) {
  const ports = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-L') continue;
    const match = String(args[i + 1] || '').match(/^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/);
    const port = match ? Number(match[1]) : 0;
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

const forwardPort = localForwardPort(sshArgs);
const forwardPorts = localForwardPorts(sshArgs);

function reverseForwardPort(args) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-R') continue;
    const match = String(args[i + 1] || '').match(/^127\.0\.0\.1:(\d+):127\.0\.0\.1:\d+$/);
    const port = match ? Number(match[1]) : 0;
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return null;
}

const reversePort = reverseForwardPort(sshArgs);

function logEvent(message) {
  try { process.stderr.write(`[nexuscrew] ${String(message).replace(/[\r\n]+/g, ' ')}\n`); } catch (_) {}
}

function clearForwardProbe() {
  clearTimeout(forwardProbeTimer);
  forwardProbeTimer = null;
  if (forwardSocket) {
    try { forwardSocket.destroy(); } catch (_) {}
    forwardSocket = null;
  }
}

// A live ssh PID is not proof of authentication: the process may still be
// blocked connecting to an unreachable endpoint. Opening the local -L socket
// forces OpenSSH to establish the real forward channel. Only that event may
// advertise transport-ready or reset retry backoff.
//
// R19: connect NON è prova di canale. OpenSSH accetta la TCP sul listener
// locale SUBITO e chiede il canale al server DOPO: se il server lo nega
// (permitopen senza quella destinazione) il socket viene CHIUSO nel giro di
// millisecondi — bind locale riuscito, canale morto. Una finestra di grazia
// dopo connect distingue le due metà: «il canale è aperto» da «il server ha
// rifiutato». Ready senza questa prova misura la metà comoda.
const CHANNEL_GRACE_MS = 350;

// Pura (con net iniettabile): per ogni porta locale -L riporta
// 'channel-ok' | 'channel-refused' | 'bind-failed'.
function probeForwardChannels({ ports, graceMs = CHANNEL_GRACE_MS, connect = net.connect } = {}) {
  return new Promise((resolveOuter) => {
    const esiti = new Map();
    const sockets = [];
    let pending = ports.length;
    if (!pending) return resolveOuter(esiti);
    const settle = (port, esito, sock) => {
      if (!esiti.has(port)) {
        esiti.set(port, esito);
        if (sock) { try { sock.destroy(); } catch (_) {} }
        pending -= 1;
        if (pending <= 0) resolveOuter(esiti);
      }
    };
    for (const port of ports) {
      const sock = connect({ host: '127.0.0.1', port });
      sockets.push(sock);
      let connected = false;
      let graceTimer = null;
      sock.setTimeout(1000);
      sock.once('connect', () => {
        connected = true;
        // La finestra che decide: se entro graceMs il socket muore, il canale
        // è stato negato dall'altro capo (o chiuso da lui): non è nostro.
        graceTimer = setTimeout(() => settle(port, 'channel-ok', sock), graceMs);
      });
      const morte = () => {
        if (graceTimer) clearTimeout(graceTimer);
        settle(port, connected ? 'channel-refused' : 'bind-failed', sock);
      };
      sock.once('close', morte);
      sock.once('error', morte);
      sock.once('timeout', morte);
    }
  });
}

// R19 punto 3: chi ha installato la chiave quando il pannello non esisteva è
// rotto e NON lo sapeva. Il prodotto lo DICE, con la riga da sostituire: le
// destinazioni arrivano dagli `-L`, la pubblica si DERIVA dalla privata
// indicata da `-i`. Quando non si riesce a derivarla, dice comunque COSA
// aggiungere — mai una riga a metà.
// La riga e' un DATO, non una frase: chi la deve mostrare non deve ritagliarla
// da un testo costruito qui. `hint` resta per chi legge un log;
// `authorizedKeys` e' il campo che la UI consuma, e resta vuoto quando la riga
// completa non si puo' comporre.
// I DUE RAMI NON DICONO LA STESSA COSA, e prima la dicevano: senza la chiave
// pubblica si costruiva un FRAMMENTO ("aggiungi a permitopen: ...") e lo si
// infilava nella frase "Riga da usare (SOSTITUISCI quella esistente)". Chi
// avesse obbedito avrebbe sostituito una riga valida con mezza riga, rompendo
// l'accesso invece di ripararlo: una promessa falsa che peggiora il guasto.
// Con la chiave: riga completa, sostituzione, ed e' anche il campo copiabile.
// Senza: si dice che la chiave non e' identificabile e si chiede una modifica
// A MANO della riga esistente, mostrando solo le destinazioni da aggiungere.
function refusalDetails({ remoteDestinations, identityFile } = {}) {
  const dests = (remoteDestinations || []).join('",permitopen="');
  const pub = require('./tunnel.js').readPublicKey(identityFile);
  const premessa = 'canale rifiutato dal NODO remoto: la chiave in ~/.ssh/authorized_keys non autorizza queste destinazioni.';
  if (!pub) {
    // Due situazioni diverse, e il messaggio non deve confonderle — ne'
    // inventare una causa che non conosce. Senza `-i` la chiave non e'
    // dichiarata affatto. Con `-i`, la derivazione dalla privata puo' fallire
    // per piu' motivi (privata assente o illeggibile, protetta da passphrase,
    // `ssh-keygen` non disponibile) e da qui non si distinguono: si elencano,
    // invece di sceglierne uno a caso. Dire «la parte pubblica non e'
    // leggibile» a chi ha una chiave cifrata col suo `.pub` accanto e' falso,
    // e manda a cercare il problema dove non e'.
    const causa = identityFile
      ? `non riesco a derivare la chiave pubblica da ${path.basename(identityFile)}`
        + ' (privata assente o illeggibile, protetta da passphrase, oppure ssh-keygen non disponibile)'
      : 'nessun -i: ssh usa le chiavi di default, un agent o la config, e da qui non si sa quale';
    return {
      hint: `${premessa} NON posso identificare la chiave da correggere — ${causa}`
        + `. Modifica A MANO la riga di quella chiave aggiungendo queste destinazioni: permitopen="${dests}"`,
      authorizedKeys: '',
    };
  }
  const riga = `restrict,port-forwarding,permitopen="${dests}",command="/bin/false" ${pub}`;
  // NON diciamo «quella con cui il supervisor si autentica»: `-i` DICHIARA
  // un'identita', non la impone — senza `IdentitiesOnly=yes` OpenSSH puo'
  // comunque usare l'agent o la config, e il canale essere autenticato da
  // un'altra chiave. Affermarlo sarebbe una promessa che il comando non
  // mantiene, e manderebbe a sostituire la riga sbagliata.
  const quale = identityFile ? ` (chiave DICHIARATA per questo nodo: ${path.basename(identityFile)}, non un'eventuale chiave "jump" dello stesso nodo; se ssh ne sceglie un'altra via agent o config, la riga da correggere e' quella)` : '';
  return {
    hint: `${premessa} Riga da usare (SOSTITUISCI quella esistente, non aggiungerne una seconda)${quale}: ${riga}`,
    authorizedKeys: riga,
  };
}

function refusalHint(opts) { return refusalDetails(opts).hint; }

function probeForward(expectedChild) {
  if (stopping || child !== expectedChild || !child || child.exitCode != null) return;
  if (!forwardPort) {
    // A reverse-only sidecar has no local -L to probe.  With
    // ExitOnForwardFailure enabled, surviving the stability window proves that
    // ssh accepted its -R request; the hub still performs the stronger MAC
    // ownership probe before it publishes Share.
    attempt = 0;
    reverseFailures = 0;
    logEvent(`reverse forward ready stableMs=${stableMs}`);
    if (!writeState('transport-ready', { sshPid: child.pid, stableMs, probe: 'reverse-forward' })) stop();
    return;
  }
  const ports = forwardPorts.length ? forwardPorts : [forwardPort];
  probeForwardChannels({ ports, graceMs: CHANNEL_GRACE_MS }).then((esiti) => {
    if (stopping || child !== expectedChild || !child || child.exitCode != null) return;
    const rifiutate = ports.filter((p) => esiti.get(p) === 'channel-refused');
    const mancanti = ports.filter((p) => esiti.get(p) === 'bind-failed');
    if (!rifiutate.length && !mancanti.length) {
      attempt = 0;
      reverseFailures = 0;
      channelProbeFailures = 0;
      logEvent(`forward ready stableMs=${stableMs} channel=verified`);
      if (!writeState('transport-ready', { sshPid: child.pid, stableMs, probe: 'tcp-forward-verified' })) stop();
      return;
    }
    if (rifiutate.length && !channelRefusedLogged) {
      // Una volta per generazione: il ciclo di probing continua (la
      // concessione può essere aggiornata), ma chi guarda SA qual è la metà
      // malata e COSA sostituire.
      channelRefusedLogged = true;
      logEvent(refusalHint({ remoteDestinations: remoteDestinationsOf(sshArgs), identityFile: identityFileOf(sshArgs) }));
    }
    channelProbeFailures += 1;
    if (channelProbeFailures > channelProbeMax) {
      // Budget esaurito: la finestra transitoria (servizio remoto non ancora
      // su) aveva 15s per qualificarsi da sola con una sonda fresca ogni
      // volta — non l'ha fatto. Da qui in poi non e' piu' "sta per succedere",
      // e continuare a sondare ogni 250ms sarebbe la stessa sonda che gira
      // per sempre senza mai diventare osservabile. Stesso stato del forward
      // inverso: degraded, vivo, si riprova a cadenza fissa — mai "pronto"
      // dichiarato senza averlo verificato.
      return enterDegraded({
        code: 'forward-channel-blocked',
        detail: rifiutate.length
          ? `canale rifiutato dal nodo remoto dopo ${channelProbeFailures} sonde`
          : `nessun canale locale disponibile dopo ${channelProbeFailures} sonde`,
        ...(rifiutate.length
          ? (() => {
            const d = refusalDetails({ remoteDestinations: remoteDestinationsOf(sshArgs), identityFile: identityFileOf(sshArgs) });
            return { hint: d.hint, ...(d.authorizedKeys ? { authorizedKeys: d.authorizedKeys } : {}) };
          })()
          : {}),
      });
    }
    if (!writeState('transport-probing', {
      sshPid: child.pid, stableMs,
      ...(rifiutate.length ? { probeDetail: 'channel-refused', refusedLocalPorts: rifiutate } : {}),
      ...(mancanti.length ? { probeDetail: 'bind-failed', missingLocalPorts: mancanti } : {}),
    })) return stop();
    forwardProbeTimer = setTimeout(() => probeForward(expectedChild), 250);
  });
}

// Le destinazioni REMOTE degli -L, nella forma che vive in permitopen.
function remoteDestinationsOf(args) {
  const out = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-L') continue;
    const m = String(args[i + 1] || '').match(/^127\.0\.0\.1:\d+:(127\.0\.0\.1:\d+)$/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
function identityFileOf(args) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-i') return args[i + 1];
  }
  return null;
}

function ownsGeneration() {
  try {
    const meta = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    return meta && meta.pid === process.pid && meta.runId === runId;
  } catch (_) { return false; }
}

function writeState(status, extra = {}) {
  if (!ownsGeneration()) return false;
  const tmp = `${statePath}.tmp.${process.pid}.${runId}`;
  const data = { status, runId, transport: path.basename(sshBin), supervisorPid: process.pid, attempt, updatedAt: Date.now(), ...extra };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, statePath);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_e) {}
    return false;
  }
}

function scheduleRetry(detail) {
  if (stopping) return finish();
  const delayMs = backoffDelay(attempt, { baseMs: 1000, capMs: 60000 });
  logEvent(`ssh retry scheduled attempt=${attempt + 2} delayMs=${delayMs}`);
  if (!writeState('retrying', { delayMs, detail })) return stop();
  attempt += 1;
  retryTimer = setTimeout(run, delayMs);
}

// Bounded, attributable degraded state. The supervisor stays alive, advertises
// the reverse failure class plus the negotiated reversePort and the honest
// remote-listener attribution (unknown without hub privilege), then retries on
// a fixed cadence. It never exits on a reverse-forward failure: the tunnel
// self-heals when the channel frees up.
function enterDegraded(diagnosis) {
  if (stopping) return finish();
  const safe = diagnosis || { code: 'reverse-forward-failed', detail: 'canale inverso non disponibile' };
  if (reverseFailures > reverseFailureMax) reverseFailures = reverseFailureMax;
  // `ownsGeneration()` only proves that THIS local supervisor owns its pidfile;
  // it cannot identify the process holding a listener on the hub.  Never turn
  // local pidfile ownership into a false remote-listener attribution.
  const ownership = 'unknown';
  // Il contatore che si logga dipende da QUALE budget si e' esaurito: il
  // canale -L (channelProbeFailures) e il forward inverso (reverseFailures)
  // sono guasti indipendenti sullo stesso processo (vedi CHANNEL_GRACE_MS
  // sopra) — loggare sempre reverseFailures direbbe "0" su un degraded di
  // canale, come se non fosse mai stato provato.
  const failures = safe.code === 'forward-channel-blocked' ? channelProbeFailures : reverseFailures;
  logEvent(`ssh degraded code=${safe.code} reversePort=${reversePort || 'none'} ownership=${ownership} failures=${failures} steadyRetryMs=${steadyRetryMs}`);
  if (!writeState('degraded', {
    code: safe.code, detail: safe.detail,
    ...(safe.hint ? { hint: safe.hint } : {}),
    // Il campo viaggia insieme alla frase, non al posto suo: chi legge un log
    // vuole l'hint, la UI vuole la riga intera. Scriverne solo uno qui e' il
    // modo in cui il campo si perde a meta' strada e tutto il resto della
    // catena, gia' cablato, riceve per sempre il fallback testuale.
    ...(safe.authorizedKeys ? { authorizedKeys: safe.authorizedKeys } : {}),
    reversePort, ownership, steadyRetryMs, terminal: false,
  })) return stop();
  // Keep the backoff counter honest for observers; the degraded retry is fixed.
  if (attempt < reverseFailureMax) attempt = reverseFailureMax;
  retryTimer = setTimeout(run, steadyRetryMs);
}

// R19 seguito, secondo difetto (2026-08-17, audit su develop@437d29f):
// enterDegraded per il canale -L riusava la macchina del forward inverso
// senza la sua precondizione implicita. Nel reverse failure `child` e' GIA'
// null quando enterDegraded gira (handleFailure lo azzera PRIMA, perche' e'
// il crash del processo l'evento che ci porta li'). Nel canale -L rifiutato
// il processo NON e' morto — e' il canale a essere negato — quindi `child`
// e' ancora vivo quando enterDegraded schedula run() per la prossima
// generazione. run() faceva `child = spawn(...)` incondizionatamente: la
// vecchia generazione, ancora viva, restava senza piu' nessuna variabile che
// la referenzi — irraggiungibile da stop(), orfana, titolare dei suoi bind
// per sempre. Misurato dall'auditor: due fake-ssh vivi dopo un degraded,
// SIGTERM al supervisor ne ferma solo l'ultimo.
//
// La correzione non e' locale (un kill dentro enterDegraded): e' che
// run() — l'UNICO punto che assegna `child` a un nuovo spawn — non
// garantiva la precondizione da solo. replaceChild() e' ora quel punto
// unico: ferma SEMPRE il child uscente (se vivo) e ne attende l'uscita
// prima di procedere. Se non c'e' nulla da fermare (gia' null, o gia'
// uscito — il caso reverse, verificato invariato) procede subito: la stessa
// funzione copre correttamente entrambi i versi, nessun percorso bypassa la
// garanzia senza dichiararlo qui.
function replaceChild(spawnNext) {
  const outgoing = child;
  const proceed = () => {
    clearTimeout(upTimer);
    clearForwardProbe();
    spawnNext();
  };
  if (!outgoing || outgoing.exitCode != null) return proceed();
  // La generazione uscente muore per NOSTRA mano qui, non per un crash che
  // handleFailure deve classificare: distacchiamo i suoi listener prima di
  // ucciderla, altrimenti il kill sotto farebbe scattare la gestione
  // fallimento della generazione vecchia in corsa con quella nuova (doppio
  // scheduleRetry/enterDegraded, `child` azzerato da sotto i piedi).
  outgoing.removeAllListeners('error');
  outgoing.removeAllListeners('close');
  outgoing.once('exit', proceed);
  try { outgoing.kill('SIGTERM'); } catch (_) { return proceed(); }
  const killTimer = setTimeout(() => {
    try { if (outgoing.exitCode == null) outgoing.kill('SIGKILL'); } catch (_) {}
  }, 1500);
  if (typeof killTimer.unref === 'function') killTimer.unref();
}

function run() {
  if (stopping) return finish();
  replaceChild(spawnGeneration);
}

function spawnGeneration() {
  if (stopping) return finish();
  if (!writeState('starting')) return stop();
  logEvent(`ssh attempt=${attempt + 1} starting`);
  let stderrTail = '';
  let localChild;
  try {
    localChild = spawn(sshBin, sshArgs, { stdio: ['ignore', 'inherit', 'pipe'] });
  } catch (e) {
    child = null;
    return scheduleRetry(String(e && e.message || e));
  }
  child = localChild;

  localChild.stderr?.on('data', (chunk) => {
    const text = String(chunk || '');
    stderrTail = `${stderrTail}${text}`.slice(-8192);
    try { process.stderr.write(chunk); } catch (_) {}
  });

  let failureHandled = false;
  const handleFailure = (detail) => {
    if (failureHandled) return;
    failureHandled = true;
    // Difesa in profondita', come probeForward: se replaceChild ha gia'
    // sostituito questa generazione (i suoi listener sono stati distaccati,
    // quindi in pratica questo ramo non dovrebbe piu' potersi attivare per
    // una generazione rimpiazzata) non tocchiamo lo stato di una generazione
    // che non e' piu' quella corrente.
    if (child !== localChild) return;
    clearTimeout(upTimer);
    clearForwardProbe();
    child = null;
    const diagnosis = reversePort ? classifySshFailure(stderrTail, reversePort) : null;
    const reverseFailure = diagnosis && ['reverse-forward-bind', 'reverse-forward-failed'].includes(diagnosis.code);
    if (reverseFailure) {
      reverseFailures += 1;
      if (reverseFailures >= reverseFailureMax) return enterDegraded(diagnosis);
    } else {
      reverseFailures = 0;
    }
    scheduleRetry((diagnosis && diagnosis.detail) || detail);
  };
  localChild.once('spawn', () => {
    logEvent(`ssh attempt=${attempt + 1} spawned`);
    // ExitOnForwardFailure only proves that the local bind was accepted. It
    // does not prove authentication or remote reachability, so after the
    // stability window require a real TCP open through the -L channel.
    upTimer = setTimeout(() => {
      if (!stopping && child === localChild && localChild.exitCode == null) {
        probeForward(localChild);
      }
    }, stableMs);
  });
  localChild.once('error', (e) => {
    logEvent(`ssh child error code=${(e && e.code) || 'unknown'}`);
    handleFailure(String(e && e.message || e));
  });
  // `close` fires after stderr has drained, so classification sees the complete
  // OpenSSH diagnostic instead of racing the child `exit` event.
  localChild.once('close', (code, signal) => {
    if (stopping) return finish();
    if (child !== localChild) return; // sostituita da replaceChild: gestita li', non qui
    logEvent(`ssh exited code=${code === null ? 'null' : code} signal=${signal || 'none'}`);
    handleFailure(`ssh exited code=${code} signal=${signal || ''}`);
  });
}

function finish() {
  clearTimeout(retryTimer);
  clearTimeout(upTimer);
  clearForwardProbe();
  clearTimeout(ownershipWaitTimer);
  clearInterval(ownershipTimer);
  if (ownsGeneration()) {
    writeState('down');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.runId === runId && state.supervisorPid === process.pid) fs.unlinkSync(statePath);
    } catch (_) {}
  }
  process.exit(0);
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(retryTimer);
  clearTimeout(upTimer);
  clearForwardProbe();
  if (child && child.exitCode == null) {
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { if (child && child.exitCode == null) child.kill('SIGKILL'); } catch (_) {} finish(); }, 1500).unref();
  } else {
    finish();
  }
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// The parent can only write our PID after spawn returns. Give that narrow race
// a bounded grace window, then enforce generation ownership continuously. A
// replaced/removed pidfile must stop both supervisor and ssh instead of leaving
// an invisible retrying orphan behind.
const ownershipDeadline = Date.now() + ownershipGraceMs;
function acquireGeneration() {
  if (stopping) return finish();
  if (ownsGeneration()) {
    ownershipTimer = setInterval(() => { if (!ownsGeneration()) stop(); }, 500);
    return run();
  }
  if (Date.now() >= ownershipDeadline) return finish();
  ownershipWaitTimer = setTimeout(acquireGeneration, 20);
}
if (require.main === module) acquireGeneration();

// Esportate per prova diretta (R19): il main resta argv/env-driven e NON parte
// al require.
module.exports = { probeForwardChannels, refusalHint, refusalDetails, CHANNEL_GRACE_MS };
