'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { issueLaunchIdentity } = require('./identity-transport.js');

const MAX_PAYLOAD = 512 * 1024;
const REQUEST_LIMIT = 256;

function runtimeDir(cfg = {}) {
  const home = cfg.home || os.homedir();
  return cfg.launchRuntimeDir || path.join(home, '.nexuscrew', 'run');
}

function ensureRuntimeDir(dir) {
  const parent = path.dirname(dir);
  try {
    const parentSt = fs.lstatSync(parent);
    const owned = typeof process.getuid !== 'function' || parentSt.uid === process.getuid();
    if (!parentSt.isSymbolicLink() && parentSt.isDirectory() && owned && (parentSt.mode & 0o077)) {
      fs.chmodSync(parent, 0o700);
    }
    const checked = fs.lstatSync(parent);
    if (checked.isSymbolicLink() || !checked.isDirectory()
      || (typeof process.getuid === 'function' && checked.uid !== process.getuid()) || (checked.mode & 0o077)) {
      throw new Error('unsafe launch broker parent directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const grand = fs.lstatSync(path.dirname(parent));
    if (grand.isSymbolicLink() || !grand.isDirectory()
      || (typeof process.getuid === 'function' && grand.uid !== process.getuid()) || (grand.mode & 0o022)) {
      throw new Error('unsafe launch broker parent root');
    }
    fs.mkdirSync(parent, { mode: 0o700 });
  }
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()
      || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077)) {
      throw new Error('unsafe launch broker directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
}

// Nome leggibile del tipo di un fs.Stats, per un messaggio d'errore che
// dice COSA ha trovato al posto di un socket (file regolare, directory,
// symlink, ...) invece di limitarsi a "non e' un socket".
function describeStatType(stat) {
  if (stat.isSymbolicLink()) return 'un symlink';
  if (stat.isDirectory()) return 'una directory';
  if (stat.isFile()) return 'un file regolare';
  if (stat.isFIFO()) return 'una FIFO';
  if (stat.isCharacterDevice()) return 'un character device';
  if (stat.isBlockDevice()) return 'un block device';
  return 'un oggetto di tipo sconosciuto';
}

function encodePayload(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (!body.length || body.length > MAX_PAYLOAD) throw new Error('launch payload too large');
  const head = Buffer.allocUnsafe(4); head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createLaunchBroker(cfg = {}) {
  const dir = runtimeDir(cfg);
  let server = null;
  let socketPath = '';
  let starting = null;
  let closed = false;
  const pending = new Map();
  const ttlMs = Math.max(1000, Number(cfg.launchTokenTtlMs) || 15000);
  // Opt-in: if cfg.onLease is registered and the payload carries `lease`, the
  // connection accepted with the one-shot nonce stays OPEN after the payload
  // frame and is handed to onLease(socket, lease) to become the lease channel.
  // Without onLease or without a lease the behavior is unchanged (socket.end,
  // one-shot): non-host cells are untouched.
  const onLease = typeof cfg.onLease === 'function' ? cfg.onLease : null;
  const identityMode = cfg.identityMode || 'legacy';
  const identityAuthority = cfg.identityAuthority || null;
  const identityDaemonCredential = cfg.identityDaemonCredential || null;
  const identityLauncherCredential = cfg.identityLauncherCredential || null;

  function expire(nonce) {
    const entry = pending.get(nonce);
    if (!entry) return;
    pending.delete(nonce);
    clearTimeout(entry.timer);
  }

  async function start() {
    if (closed) throw new Error('launch broker closed');
    if (server) return socketPath;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      try {
        ensureRuntimeDir(dir);
        socketPath = path.join(dir, `launch-${process.pid}-${crypto.randomBytes(5).toString('hex')}.sock`);
      } catch (error) { reject(error); return; }
      server = net.createServer((socket) => {
        let raw = '';
        socket.setEncoding('utf8');
        socket.setTimeout(3000, () => socket.destroy());
        // Correzione (da revisione, stesso buco trovato in cell-lease-server.js):
        // il broker scrive su questo socket (il payload, o dopo la chiamata onLease
        // prima). Un peer che muore mentre quella write e' in volo emette
        // 'error' senza listener -> throw fatale, INTERO processo giu'.
        socket.once('error', () => { try { socket.destroy(); } catch (_) {} });
        socket.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > REQUEST_LIMIT) return socket.destroy();
          const nl = raw.indexOf('\n');
          if (nl === -1) return;
          let nonce = '';
          try { nonce = JSON.parse(raw.slice(0, nl)).nonce; } catch (_) {}
          if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) return socket.destroy();
          const entry = pending.get(nonce);
          if (!entry || entry.expires < Date.now()) { expire(nonce); return socket.destroy(); }
          // Single-use before any bytes leave this process. A second client can
          // never claim the same payload, even while the first socket drains.
          pending.delete(nonce); clearTimeout(entry.timer);
          if (entry.lease && onLease) {
            // The same connection stays OPEN after the payload frame.
            // We disarm the one-shot timeout and remove the nonce data handler:
            // the socket reaches onLease clean, which dedicates it to the lease
            // channel: a later refresh never talks to the spent nonce (the reparse
            // of the nonce line, with an empty pending map, used to destroy the
            // connection) and the 3s idle timeout meant for the one-shot is gone.
            socket.setTimeout(0);
            socket.removeAllListeners('data');
            // da revisione interna: la lease PRIMA del payload. onLease
            // associa la connessione al lease manager (attachInitial); solo se
            // committa il payload viene scritto. Se onLease ritorna false, o ha
            // gia' distrutto la socket, il payload NON parte: il client riceve
            // la chiusura prima del frame, receivePayload rigetta ('launch
            // broker closed early') e il child NON NASCE con una lease che il
            // server non ha mai committato. Prima il payload era scritto prima
            // di onLease: la cella partiva anche con attach fallito (20/20 sonda).
            const denied = onLease(socket, entry.lease) === false || socket.destroyed;
            if (denied) return;
            try { socket.write(entry.encoded); } catch (_) { socket.destroy(); return; }
          } else {
            try { socket.end(entry.encoded); } catch (_) { socket.destroy(); }
          }
        });
      });
      server.once('error', (error) => {
        if (!server?.listening) { server = null; starting = null; reject(error); }
      });
      server.listen(socketPath, () => {
        // Stesso rigore gia' applicato alla directory in ensureRuntimeDir
        // (chmod, poi VERIFICA il risultato reale, fallisci chiuso se non
        // conforme): la dir 0700 basta da sola a impedire l'attraversamento
        // del path a qualunque altro utente, indipendentemente dal mode del
        // socket — verificato (attraversare una directory richiede il bit x
        // su OGNI componente del path, il mode del file terminale non conta
        // per chi non puo' nemmeno raggiungerlo). Ma questo file non tratta
        // quella garanzia come l'unica: se domani ensureRuntimeDir avesse un
        // buco, o il filesystem sottostante non applicasse i permessi POSIX
        // come atteso, il mode del socket e' l'unica barriera indipendente
        // rimasta.
        //
        // Riconsegna: la prima versione di questa guardia verificava SOLO il
        // mode (chmod, poi statSync().mode) — il PERMESSO, non l'IDENTITA'.
        // Misurato: sostituendo il path con un FILE REGOLARE mode 0600
        // subito dopo il chmod (stesso trust boundary: serve comunque
        // accesso alla dir 0700), issue() si risolveva lo stesso — la
        // guardia non si accorgeva che l'oggetto non era piu' un socket.
        // Ora: lstatSync (non statSync, come la dir sopra — un socket non
        // va MAI seguito attraverso un symlink) sia prima sia dopo il
        // chmod, isSocket() verificato in entrambi i momenti, e
        // dev/ino confrontati fra i due lstatSync per rilevare una
        // sostituzione avvenuta DURANTE l'intervallo del chmod stesso.
        //
        // LIMITE DICHIARATO, non nascosto: questo chiude la finestra fra il
        // PRIMO lstatSync (il piu' presto possibile dopo il bind) e il
        // SECONDO (dopo il chmod) — non la finestra fra il bind stesso e il
        // primo lstatSync (Node non espone un modo per fstat l'fd del
        // server UDS appena bindato prima di riosservarlo per path), ne'
        // quella fra questa verifica e il momento in cui un client si
        // connette davvero. Chiuderle richiederebbe verificare l'identita'
        // a OGNI connessione accettata (fstat sul socket accettato via fd,
        // non per path) — fuori scope qui: chi ha accesso alla dir 0700 ha
        // gia' lo stesso UID di questo processo, e a quel punto puo' fare
        // molto altro (killare il processo, ptrace) che nessun chmod
        // fermerebbe — non e' un'escalation di privilegi nuova, e' il
        // limite intrinseco del modello "stesso utente = stesso trust
        // boundary" gia' assunto da questo file per la directory.
        let mode = null;
        try {
          const pre = fs.lstatSync(socketPath);
          if (!pre.isSocket()) {
            throw new Error(`atteso un socket, trovato ${describeStatType(pre)}`);
          }
          fs.chmodSync(socketPath, 0o600);
          const post = fs.lstatSync(socketPath);
          if (!post.isSocket()) {
            throw new Error(`non e' piu' un socket dopo il chmod: ${describeStatType(post)}`);
          }
          if (post.dev !== pre.dev || post.ino !== pre.ino) {
            throw new Error("il file al path del socket e' stato sostituito durante la verifica (dev/ino cambiati fra i due lstatSync)");
          }
          mode = post.mode & 0o777;
        } catch (error) {
          try { server.close(); } catch (_) {}
          try { fs.unlinkSync(socketPath); } catch (_) {}
          server = null; starting = null;
          reject(new Error(`unsafe launch broker socket: ${error.message}`));
          return;
        }
        if (mode !== 0o600) {
          try { server.close(); } catch (_) {}
          try { fs.unlinkSync(socketPath); } catch (_) {}
          server = null; starting = null;
          reject(new Error(`unsafe launch broker socket: mode ${mode.toString(8)} dopo chmod, atteso 0600`));
          return;
        }
        server.unref(); starting = null; resolve(socketPath);
      });
    });
    return starting;
  }

  async function issue(payload) {
    const target = await start();
    const nonce = crypto.randomBytes(32).toString('hex');
    let encodedPayload = payload;
    if (payload && payload.identity) {
      if (identityMode !== 'authority' || !identityAuthority || !identityDaemonCredential) {
        throw new Error('identity authority non disponibile');
      }
      const launched = issueLaunchIdentity({
        identityAuthority,
        daemonCredential: identityDaemonCredential,
        launcherCredential: identityLauncherCredential,
        audience: payload.identity.audience,
        daemonBootId: payload.identity.daemonBootId,
        connectionId: payload.identity.connectionId,
        subject: payload.identity.subject,
      });
      if (!launched || !launched.ok) {
        throw new Error(`identity launch ${launched && launched.reason ? launched.reason : 'malformed'}`);
      }
      const { ok, ...identity } = launched;
      encodedPayload = { ...payload, identity };
    }
    const entry = { encoded: encodePayload(encodedPayload), expires: Date.now() + ttlMs, timer: null, lease: payload && payload.lease ? payload.lease : null };
    entry.timer = setTimeout(() => expire(nonce), ttlMs);
    entry.timer.unref?.();
    pending.set(nonce, entry);
    return { socketPath: target, nonce };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const [nonce] of pending) expire(nonce);
    const active = server; server = null;
    if (active) await new Promise((resolve) => active.close(() => resolve()));
    try { if (socketPath) fs.unlinkSync(socketPath); } catch (_) {}
  }

  // Explicit revocation of a pending nonce: if the respawn-pane fails after
  // issue(), the runtime consumes/revokes the ticket immediately instead of
  // attenderne il TTL. expire() e' gia' no-op su nonce mancante/scaduto.
  return { issue, close, revoke: expire, pendingCount: () => pending.size };
}

module.exports = { createLaunchBroker, runtimeDir, ensureRuntimeDir, encodePayload, MAX_PAYLOAD };
