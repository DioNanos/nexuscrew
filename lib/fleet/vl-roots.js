'use strict';
// Claim della root VL. Il processo NC non legge ne' scrive
// ownership e lease: lo fa il figlio, che eredita il lock da flock -F.
// Pubblicazione: fs.link. Pin: lettura, hash, staging esclusivo, rilettura.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { vlCellBaseDir } = require('./managed.js');
const sezione = require('./vl-claim-section.js');
const { pubblicaEsclusiva } = require('./exclusive-publish.js');

const MANIFEST = require('./vl-claim-pin-manifest.json');
const nodoRuntime = require('./vl-node-runtime.js');
const CAP_STDOUT = 8192;
const CAP_STDERR = 4096;
// La terna di un pacchetto aggiornato: sono gli UNICI rifiuti della flock del
// ramo manifest che aprono il ripiego sul pin locale, e gli unici valori
// ammessi nella causa del manifest conservata.
const TERNA_FLOCK = new Set(['PIN_ABSENT', 'PIN_MISMATCH', 'PIN_VERSION']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function argvFlock({ timeoutSec, conflictCode, lockPath, nodePath, helperPath }) {
  return [
    '-F', '-x', '-w', String(timeoutSec), '-E', String(conflictCode),
    '--', lockPath, nodePath, helperPath,
  ];
}

function radiceServer(home, ownerInstanceId, cellId) {
  const base = vlCellBaseDir(home, ownerInstanceId, cellId);
  const pianificata = path.join(base, 'state', 'vl', 'host-v1');
  const canon = sezione.canonicaRadice(pianificata);
  if (!canon) return null;
  return canon;
}

// Prova di assenza della root host REALE, prima dello spawn. Non crea
// host-v1: una directory vuota non e' un layout che VL apre. Gli antenati
// sopra la cella sono directory reali, non link, attraversabili, di root o
// dell'utente, non scrivibili da altri. La sottocatena della cella e' uid
// corrente e 0700. Mancano `state` o `vl`: si creano solo quelli, 0700.
// Solo ENOENT nella catena gia' qualificata e' assenza. EACCES, EIO,
// ENOTDIR, ELOOP e un permesso inadeguato rifiutano, senza chmod su cio'
// che c'era gia'.
function directoryFidata(st, privato, uid, gid) {
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const mode = st.mode & 0o777;
  if (privato) return st.uid === uid && mode === 0o700;
  if (st.uid !== 0 && st.uid !== uid) return false;
  const sticky = (st.mode & 0o1000) !== 0 && (st.uid === 0 || st.uid === uid);
  if ((mode & 0o022) !== 0 && !sticky) return false;
  if (st.uid === uid) return (mode & 0o100) !== 0;
  if (st.gid === gid) return (mode & 0o010) !== 0;
  return (mode & 0o001) !== 0;
}

// Il walker condiviso della qualifica della root. `crea` distingue le due
// forme: il PRE-LANCIO crea gli antenati `state`/`vl` mancanti dentro la base
// (0700, come sempre), la forma IN LETTURA non crea niente — un antenato
// mancante qualsiasi significa che la foglia sotto di lui non puo' esistere,
// quindi la root e' assente. E' la variante osservativa per gli endpoint di
// diagnosi read-only: stessa struttura di rifiuto (link, ENOTDIR, permessi),
// nessuna scrittura.
function percorsoRadiceQualificato(root, cellBase, deps, crea) {
  const lstat = deps.lstat || fs.lstatSync;
  const mkdir = deps.mkdir || ((d) => { fs.mkdirSync(d, { mode: 0o700 }); });
  const chmod = deps.chmod || fs.chmodSync;
  const uid = typeof deps.uid === 'number' ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : 0);
  const gid = typeof deps.gid === 'number' ? deps.gid : (typeof process.getgid === 'function' ? process.getgid() : 0);
  const rifiuto = (code) => ({ esito: 'rifiutata', code: code || 'percorso', antenati: [] });
  if (typeof root !== 'string' || typeof cellBase !== 'string') return rifiuto('percorso');
  if (!path.isAbsolute(root) || !path.isAbsolute(cellBase)) return rifiuto('percorso');
  if (root.includes('\0') || cellBase.includes('\0') || root.includes('..') || cellBase.includes('..')) {
    return rifiuto('percorso');
  }
  const radice = path.resolve(root);
  const base = path.resolve(cellBase);
  if (radice !== path.join(base, 'state', 'vl', 'host-v1')) return rifiuto('confine');
  const pezzi = radice.split(path.sep).filter((p) => p.length > 0);
  if (pezzi.some((p) => p === '.' || p === '..')) return rifiuto('percorso');
  const antenati = [];
  let acc = path.parse(radice).root;
  for (let i = 0; i < pezzi.length; i += 1) {
    const nome = pezzi[i];
    const next = path.join(acc, nome);
    const nelPrivato = next === base || next.startsWith(`${base}${path.sep}`);
    const foglia = next === radice;
    let st;
    try {
      st = lstat(next);
    } catch (e) {
      const code = e && e.code;
      if (code !== 'ENOENT') return rifiuto(code || 'stat');
      if (foglia) return { esito: 'assente', code: 'ENOENT', antenati, root: radice };
      if (!crea) return { esito: 'assente', code: 'ENOENT-antenato', antenati, root: radice };
      if (!nelPrivato || (nome !== 'state' && nome !== 'vl')) return rifiuto('antenato');
      try {
        mkdir(next);
        chmod(next, 0o700);
        st = lstat(next);
      } catch (err) {
        return rifiuto((err && err.code) || 'mkdir');
      }
    }
    if (!st || st.isSymbolicLink()) return rifiuto('link');
    if (!st.isDirectory()) return rifiuto('ENOTDIR');
    if (!directoryFidata(st, nelPrivato, uid, gid)) return rifiuto('permessi');
    antenati.push({ dev: st.dev, ino: st.ino });
    acc = next;
  }
  return { esito: 'presente', code: 'presente', antenati, root: radice };
}

function qualificaAssenzaRadice(root, cellBase, deps = {}) {
  return percorsoRadiceQualificato(root, cellBase, deps, true);
}

// Qualifica della root in SOLA LETTura (nessun mkdir, nessun chmod): la forma
// osservativa usata dagli endpoint di diagnosi, che non devono preparare
// proprio niente.
function qualificaRadiceInLettura(root, cellBase, deps = {}) {
  return percorsoRadiceQualificato(root, cellBase, deps, false);
}

// Osservazione READ-ONLY della claim della root, SENZA lock: legge il nome
// `.lease` della sezione (quello che decide held/released/none: `.own` e' il
// marker di ownership persistente, non la lease) e lo giudica. L'inspect vero
// (`ispeziona`) prepara la directory delle claim e il file di lock e spawna un
// figlio: va bene per chi muta, non per un endpoint osservativo. Qui si legge
// soltanto e si distingue una claim ASSENTE da una PRESENTE DI UN ALTRO — la
// distinzione che un referto diagnostico non puo' appiattire. Enum chiuso:
//   none | held | released | held-other | unreadable | unresolvable
// Nessun id, nessun path, nessun contenuto del record esce: solo l'enum.
function osservaClaim(opts) {
  const { home, root, ownerInstanceId, cellId } = opts || {};
  if (typeof home !== 'string' || !home || typeof ownerInstanceId !== 'string'
    || typeof cellId !== 'string' || !cellId) return 'unresolvable';
  const canon = sezione.canonicaRadice(root);
  if (!canon) return 'unresolvable';
  const leggi = (file) => {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return e && e.code === 'ENOENT' ? 'assente' : 'errore'; }
    try {
      const o = JSON.parse(buf.toString('utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : 'corrotto';
    } catch (_) { return 'corrotto'; }
  };
  const claims = dirClaim(home);
  const lease = leggi(path.join(claims, `${sezione.hashRadice(canon)}.lease`));
  if (lease === 'assente') return 'none';
  if (lease === 'errore' || lease === 'corrotto') return 'unreadable';
  if (lease.released === true) return 'released';
  return lease.ownerInstanceId === ownerInstanceId && lease.cellId === cellId ? 'held' : 'held-other';
}

function stessaImprontaRadice(a, b) {
  if (!a || !b || a.esito === 'rifiutata' || b.esito === 'rifiutata') return false;
  if (a.esito !== b.esito || a.root !== b.root) return false;
  if (!Array.isArray(a.antenati) || a.antenati.length !== b.antenati.length) return false;
  for (let i = 0; i < a.antenati.length; i += 1) {
    if (a.antenati[i].dev !== b.antenati[i].dev || a.antenati[i].ino !== b.antenati[i].ino) return false;
  }
  return true;
}

function dirClaim(home) {
  return path.join(home, '.nexuscrew', 'vl-root-claims');
}

function dirPin(home) {
  return path.join(home, '.nexuscrew', 'vl-claim-pin');
}

// I campi bounded del ripiego: si copia solo la terna eleggibile con il suo
// componente. Nessun oggetto o errore grezzo attraversa questo confine.
function causaManifestValida(c) {
  return !!c && typeof c === 'object' && !Array.isArray(c)
    && TERNA_FLOCK.has(c.code) && c.component === 'flock';
}

function assicuraDir(dir, mode) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if ((st.mode & 0o777) !== mode) return false;
    if (st.uid !== process.getuid()) return false;
    return true;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return false;
  }
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
  const st = fs.lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o777) === mode;
}

function preparaLock(file) {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return null;
  }
  let st;
  try { st = fs.lstatSync(file); } catch (_) { return null; }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  if (st.uid !== process.getuid()) return null;
  if ((st.mode & 0o777) !== 0o600) return null;
  return { ino: st.ino, dev: st.dev };
}

const flockVersionCache = new Map();
function versioneFlock(bin, chiave) {
  const key = chiave || bin;
  if (flockVersionCache.has(key)) return flockVersionCache.get(key);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: false, timeout: 2000 });
  const testo = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = testo.match(/util-linux\s+(\d+\.\d+\.\d+)/);
  const v = m ? m[1] : '';
  if (v) flockVersionCache.set(key, v);
  return v;
}

// Private staging of the pinned objects: the bytes are read and hashed once
// at import, materialized as our own copy inside a private directory, then
// re-read and re-hashed. Per-home pins publish that verified content with an
// exclusive link. Nothing aliases an updatable source path and no unqualified
// command runs at import.
const oggettiVerificati = new Map();

// A published pin object is an executable of ours: regular file, our uid,
// mode exactly 0500. Anything else under that name (partial residue from a
// create-exclusive publication, foreign or altered object) is not a pin.
function oggettoQualificato(st) {
  return !!st && st.isFile() && !st.isSymbolicLink()
    && (typeof process.getuid !== 'function' || st.uid === process.getuid())
    && (st.mode & 0o777) === 0o500;
}

// Reads a published object through a no-follow descriptor, after qualifying
// it on that same descriptor. Returns { buf, st } or null.
function leggiOggettoQualificato(dest) {
  let fd = null;
  try {
    fd = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!oggettoQualificato(st)) return null;
    return { buf: fs.readFileSync(fd), st };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
}

function materializzaPrivato(buf, hash) {
  const dir = path.join(os.tmpdir(), `nc-vl-pin-${process.getuid()}`);
  if (!assicuraDir(dir, 0o700)) return null;
  const dest = path.join(dir, hash);
  let presente = false;
  try {
    const st = fs.lstatSync(dest);
    presente = st.isFile() && !st.isSymbolicLink();
  } catch (_) {}
  if (!presente) {
    const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o500);
    try {
      fs.writeFileSync(fd, buf);
      fs.fchmodSync(fd, 0o500);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const pub = pubblicaEsclusiva({ src: tmp, dest, bytes: buf, executable: true });
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (pub.status !== 'published' && pub.status !== 'exists') return null;
  }
  const letto = leggiOggettoQualificato(dest);
  if (!letto || sha256(letto.buf) !== hash) return null;
  const st = letto.st;
  return { path: dest, hash, ino: st.ino, dev: st.dev, grande: buf.length > 1048576 };
}

function registraVerificato(source, expectedHash) {
  try {
    if (typeof source !== 'string' || typeof expectedHash !== 'string') return;
    const buf = fs.readFileSync(source);
    const hash = sha256(buf);
    if (hash !== expectedHash) return;
    const priv = materializzaPrivato(buf, hash);
    if (priv) oggettiVerificati.set(source, priv);
  } catch (_) {}
}

try {
  if (MANIFEST && MANIFEST.flock && typeof MANIFEST.flock.source === 'string') {
    registraVerificato(MANIFEST.flock.source, MANIFEST.flock.sha256);
  }
} catch (_) {}
try {
  registraVerificato(path.join(__dirname, 'vl-claim-section.js'), MANIFEST && MANIFEST.helper && MANIFEST.helper.sha256);
} catch (_) {}
try {
  // Warm the version cache once against the private copy of verified bytes:
  // the source path is never executed before qualification, and per-home
  // preparation finds the cache bound to the manifest hash.
  const privFlock = oggettiVerificati.get(MANIFEST && MANIFEST.flock && MANIFEST.flock.source);
  if (privFlock && MANIFEST && MANIFEST.flock && typeof MANIFEST.flock.version === 'string') {
    versioneFlock(privFlock.path, MANIFEST.flock.sha256);
  }
} catch (_) {}

function pinna(source, expectedHash, stagingDir) {
  const priv = oggettiVerificati.get(source);
  if (priv && priv.hash === expectedHash) {
    // Verified bytes are already materialized in our private staging: publish
    // the same content per home, never aliasing an updatable source. Small
    // objects re-read and re-hash the source on every use, so a substituted
    // file fails the gate before anything is published.
    if (!priv.grande) {
      let b;
      try { b = fs.readFileSync(source); } catch (_) { return { ok: false, code: 'PIN_ABSENT' }; }
      if (sha256(b) !== expectedHash) return { ok: false, code: 'PIN_MISMATCH' };
    }
    if (!assicuraDir(stagingDir, 0o700)) return { ok: false, code: 'PIN_DIR' };
    const dest = path.join(stagingDir, expectedHash);
    // Hard link when the filesystem allows it; otherwise exclusive creation
    // of a verified copy. Only a real hard link makes the final name the very
    // inode that was verified privately; a copy never inherits that proof.
    const pub = pubblicaEsclusiva({
      src: priv.path,
      dest,
      executable: true,
      bytes: () => {
        const l = leggiOggettoQualificato(priv.path);
        if (!l || sha256(l.buf) !== expectedHash) throw Object.assign(new Error('private object changed'), { code: 'EIO' });
        return l.buf;
      },
    });
    if (pub.status === 'failed-before-create' || pub.status === 'uncertain-after-create') {
      return { ok: false, code: pub.status === 'uncertain-after-create' ? 'PIN_REREAD' : 'PIN_STAGE' };
    }
    const appenaPubblicato = pub.status === 'published' && pub.via === 'link';
    let st;
    try { st = fs.lstatSync(dest); } catch (_) { return { ok: false, code: 'PIN_REREAD' }; }
    if (!oggettoQualificato(st)) return { ok: false, code: 'PIN_REREAD' };
    if (!priv.grande) {
      const diNuovo = leggiOggettoQualificato(dest);
      if (!diNuovo || sha256(diNuovo.buf) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
      return { ok: true, path: dest };
    }
    // Large object: identity with the privately re-verified copy stands in
    // for a per-call re-read; a different object at dest (including a copy
    // made without link) is verified by its bytes and never overwritten.
    if (appenaPubblicato || (st.ino === priv.ino && st.dev === priv.dev)) return { ok: true, path: dest };
    const diNuovo = leggiOggettoQualificato(dest);
    if (!diNuovo || sha256(diNuovo.buf) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
    return { ok: true, path: dest };
  }
  let buf;
  try { buf = fs.readFileSync(source); } catch (_) { return { ok: false, code: 'PIN_ABSENT' }; }
  const hash = sha256(buf);
  if (hash !== expectedHash) return { ok: false, code: 'PIN_MISMATCH' };
  if (!assicuraDir(stagingDir, 0o700)) return { ok: false, code: 'PIN_DIR' };
  const dest = path.join(stagingDir, expectedHash);
  let esiste = false;
  try { fs.lstatSync(dest); esiste = true; } catch (_) { esiste = false; }
  if (!esiste) {
    const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o500);
    try {
      fs.writeFileSync(fd, buf);
      fs.fchmodSync(fd, 0o500);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const pub = pubblicaEsclusiva({ src: tmp, dest, bytes: buf, executable: true });
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (pub.status === 'failed-before-create') return { ok: false, code: 'PIN_STAGE' };
    if (pub.status === 'uncertain-after-create') return { ok: false, code: 'PIN_REREAD' };
  }
  const diNuovo = leggiOggettoQualificato(dest);
  if (!diNuovo || sha256(diNuovo.buf) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
  return { ok: true, path: dest };
}

// Manifest di build v2: schema CHIUSO {v, platform, flock, helper}. Il campo
// node non esiste piu' e un v1 legacy, o un v2 con chiavi extra, si rifiuta
// PRIMA di scegliere il ramo piattaforma/locale o di preparare qualunque
// oggetto: PIN_REREAD con motivo interno bounded, componente null.
function validaManifestBuild(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, motivo: 'manifest-schema' };
  if (m.v !== 2) return { ok: false, motivo: 'manifest-version' };
  const chiavi = Object.keys(m).sort();
  const attese = ['flock', 'helper', 'platform', 'v'].sort();
  if (chiavi.length !== attese.length || chiavi.some((k, i) => k !== attese[i])) {
    return { ok: false, motivo: 'manifest-schema' };
  }
  if (typeof m.platform !== 'string' || m.platform.length === 0 || m.platform.length > 64) {
    return { ok: false, motivo: 'manifest-schema' };
  }
  const sotto = (o, campi) => !o || typeof o !== 'object' || Array.isArray(o)
    || Object.keys(o).length !== campi.length
    || Object.keys(o).some((k) => !campi.includes(k));
  if (sotto(m.flock, ['source', 'sha256', 'version'])) return { ok: false, motivo: 'manifest-schema' };
  if (sotto(m.helper, ['sha256'])) return { ok: false, motivo: 'manifest-schema' };
  return { ok: true };
}

// La chiave di piattaforma e' quella del RUNTIME (`process.platform` +
// `process.arch`), non il nome di un target di build: "android-aarch64" e un
// nome di triple, il valore Node su un telefono e' ("android", "arm64").
function piattaformaRuntime() {
  return `${process.platform}-${process.arch}`;
}

function preparaPin(home, manifest, piattaformaIniettata = null, deps = {}) {
  const staging = dirPin(home);
  const piattaforma = typeof piattaformaIniettata === 'string' && piattaformaIniettata
    ? piattaformaIniettata : piattaformaRuntime();
  // Il manifest si valida CHIUSO prima di ogni altra scelta: un v1 legacy o
  // un v2 con chiavi extra non apre rami, non prepara oggetti, non cade su un
  // fallback locale. Il Node non e' mai un campo del manifest.
  const valido = validaManifestBuild(manifest);
  if (!valido.ok) {
    return { ok: false, code: 'PIN_REREAD', motivo: valido.motivo, component: null, platform: piattaforma };
  }
  // Il node del claim e' il RUNTIME effettivo qualificato (fotografia privata
  // + probe isolata), uguale per riserva/ispezione/rilascio e diagnostica. I
  // seam `deps` sono interni ai test: niente config, env o richiesta puo'
  // scegliere il candidato.
  const qualificaNode = () => nodoRuntime.qualifica({
    ...(deps && deps.execPath ? { execPath: deps.execPath } : {}),
    ...(deps && typeof deps.nodeVersions === 'string' ? { versionsNode: deps.nodeVersions } : {}),
    ...(typeof deps.nodeProbe === 'function' ? { probe: deps.nodeProbe } : {}),
    ...(deps && typeof deps.isDisarmed === 'function' ? { isDisarmed: deps.isDisarmed } : {}),
  });
  const pubblicaNode = (qn) => (
    deps && typeof deps.isDisarmed === 'function'
      ? nodoRuntime.pubblica(qn, staging, { isDisarmed: deps.isDisarmed })
      : nodoRuntime.pubblica(qn, staging)
  );
  // Ripiego ESPLICITO sul pin locale: si apre SOLO dopo il rifiuto della
  // flock del ramo manifest su linux-x64, nella terna di un pacchetto
  // aggiornato. Ordine obbligato: prima il Node runtime e l'helper DELLA
  // RELEASE (se non si qualificano, vale il LORO codice e il pin non si
  // legge), poi il pin. Il pin assente non crea niente: si rifiuta col codice
  // del manifest e con l'identificatore chiuso che l'interfaccia traduce.
  const ripiegaSuPinLocale = (causa) => {
    const manifestCause = { code: causa.code, component: 'flock' };
    const [pf, pa] = piattaforma.split('-');
    // Lo staging e' il primo effetto: se non e' privato si rifiuta con PIN_DIR
    // (come fa pinna per il primo oggetto del ramo locale), senza leggere il pin.
    if (!assicuraDir(staging, 0o700)) {
      return { ok: false, code: 'PIN_DIR', component: 'node', platform: piattaforma, manifestCause };
    }
    const qn = qualificaNode();
    if (!qn.ok) return { ...qn, component: 'node', platform: piattaforma, manifestCause };
    const nodeL = pubblicaNode(qn);
    if (!nodeL.ok) return { ...nodeL, component: 'node', platform: piattaforma, manifestCause };
    const helperL = pinna(path.join(__dirname, 'vl-claim-section.js'), manifest.helper.sha256, staging);
    if (!helperL.ok) return { ...helperL, component: 'helper', platform: piattaforma, manifestCause };
    const locale = require('./vl-claim-pin-local.js');
    const v = locale.verifica({
      home,
      helperHash: manifest.helper.sha256,
      deps: {
        platform: pf, arch: pa,
        ...(deps && deps.execPath ? { execPath: deps.execPath } : {}),
        ...(deps && deps.sourceFs ? { sourceFs: deps.sourceFs } : {}),
      },
    });
    if (!v.ok) {
      if (v.code === 'PIN_UNCOVERED' && v.motivo === 'assente') {
        return {
          ok: false, code: causa.code, component: 'flock', platform: piattaforma, pinRecovery: 'provision-again',
        };
      }
      return { ...v, platform: piattaforma, manifestCause };
    }
    const pin = v.pin;
    const flockL = pinna(pin.components.flock.source, pin.components.flock.sha256, staging);
    if (!flockL.ok) return { ...flockL, component: 'flock', platform: piattaforma, manifestCause };
    if (versioneFlock(flockL.path, pin.components.flock.sha256) !== pin.components.flock.version) {
      return { ok: false, code: 'PIN_VERSION', component: 'flock', platform: piattaforma, manifestCause };
    }
    return { ok: true, flock: flockL.path, node: nodeL.path, helper: helperL.path };
  };
  // Un manifest che non copre QUESTA piattaforma non si prova nemmeno: i suoi
  // path (flock di sistema) su un altro nodo sono un rifiuto distinto da
  // «file assente», e va detto con un motivo suo.
  if (manifest.platform !== piattaforma) {
    const atteso = typeof manifest.platform === 'string' ? manifest.platform : null;
    const locale = require('./vl-claim-pin-local.js');
    if (!locale.piattaformaAutorizzata(piattaforma)) {
      return { ok: false, code: 'PIN_UNCOVERED', component: null, platform: piattaforma, atteso };
    }
    // Piattaforma autorizzata ma non coperta dal build: serve il pin LOCALE
    // registrato da un operatore. Assente o non qualificabile = rifiuto, mai
    // un pin creato qui. Un v1 letto proietta solo flock/helper/piattaforma:
    // il vecchio node del record e' dato legacy, mai un candidato.
    const [pf, pa] = piattaforma.split('-');
    const v = locale.verifica({ home, helperHash: manifest.helper.sha256,
      deps: { platform: pf, arch: pa, ...(deps && deps.execPath ? { execPath: deps.execPath } : {}) } });
    if (!v.ok) return { ...v, platform: piattaforma, atteso };
    const pin = v.pin;
    const flockL = pinna(pin.components.flock.source, pin.components.flock.sha256, staging);
    if (!flockL.ok) return { ...flockL, component: 'flock', platform: piattaforma, atteso };
    if (versioneFlock(flockL.path, pin.components.flock.sha256) !== pin.components.flock.version) {
      return { ok: false, code: 'PIN_VERSION', component: 'flock', platform: piattaforma, atteso };
    }
    const qn = qualificaNode();
    if (!qn.ok) return { ...qn, component: 'node', platform: piattaforma, atteso };
    const nodeL = pubblicaNode(qn);
    if (!nodeL.ok) return { ...nodeL, component: 'node', platform: piattaforma, atteso };
    // L'helper della sezione critica resta SEMPRE quello della release: il pin
    // locale non lo benedice e non se ne calcola l'hash dal disco.
    const helperL = pinna(path.join(__dirname, 'vl-claim-section.js'), manifest.helper.sha256, staging);
    if (!helperL.ok) return { ...helperL, component: 'helper', platform: piattaforma, atteso };
    return { ok: true, flock: flockL.path, node: nodeL.path, helper: helperL.path };
  }
  const flock = pinna(manifest.flock.source, manifest.flock.sha256, staging);
  if (!flock.ok) {
    // Un pacchetto aggiornato cambia la flock rispetto al catalogo: su
    // linux-x64 il rifiuto della flock nella terna apre il ripiego locale.
    if (piattaforma === 'linux-x64' && TERNA_FLOCK.has(flock.code)) return ripiegaSuPinLocale(flock);
    return { ...flock, component: 'flock', platform: piattaforma };
  }
  // The version is read from the qualified pinned object and cached against
  // its verified content hash.
  if (versioneFlock(flock.path, manifest.flock.sha256) !== manifest.flock.version) {
    const rifiuto = { ok: false, code: 'PIN_VERSION', component: 'flock', platform: piattaforma };
    if (piattaforma === 'linux-x64') return ripiegaSuPinLocale(rifiuto);
    return rifiuto;
  }
  const qn = qualificaNode();
  if (!qn.ok) return { ...qn, component: 'node', platform: piattaforma };
  const node = pubblicaNode(qn);
  if (!node.ok) return { ...node, component: 'node', platform: piattaforma };
  const helperSrc = path.join(__dirname, 'vl-claim-section.js');
  const helper = pinna(helperSrc, manifest.helper.sha256, staging);
  if (!helper.ok) return { ...helper, component: 'helper', platform: piattaforma };
  return { ok: true, flock: flock.path, node: node.path, helper: helper.path };
}

function envFiglio(extra) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' };
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'NODE_OPTIONS' || k === 'NODE_PATH') continue;
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

const MAX_CLAIM_DRAIN_MS = 300;

/**
 * Create a per-instance tracker for claim pin and flock-child consumers.
 * Counting starts before pin publication or child spawn and ends only on
 * pre-spawn refusal or proved child 'close' (never on caller promise settle
 * or bare 'error'). Wait budgets are bounded to MAX_CLAIM_DRAIN_MS overall.
 */
function creaTracciatoreClaim(opts = {}) {
  const nowMono = typeof opts.nowMono === 'function' ? opts.nowMono : () => performance.now();
  const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : setTimeout;
  const clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : clearTimeout;
  let disarmed = false;
  let drainExpired = false;
  let seq = 0;
  const active = new Map();
  const waiters = new Set();

  function counts() {
    let attestedActive = 0;
    let unattestedCount = 0;
    for (const entry of active.values()) {
      if (entry.stage === 'unattested') unattestedCount += 1;
      else attestedActive += 1;
    }
    return { activeCount: active.size, attestedActive, unattestedCount };
  }

  function notifyIfAttestedDrained() {
    const c = counts();
    if (c.attestedActive > 0) return;
    for (const wake of [...waiters]) wake(c);
  }

  function disarm() {
    disarmed = true;
  }

  function markDrainExpired() {
    drainExpired = true;
  }

  function isDisarmed() {
    return disarmed;
  }

  function beginAdmitted() {
    if (disarmed) return { ok: false, code: 'CLAIM_DISARMED' };
    const token = { id: ++seq, stage: 'admitted', child: null, endedBy: null, sawError: false };
    active.set(token.id, token);
    return { ok: true, token };
  }

  function endConsumer(token, endedBy = 'close') {
    if (!token || active.get(token.id) !== token) return false;
    if (token.stage === 'unattested') return false;
    token.stage = 'ended';
    token.endedBy = endedBy;
    active.delete(token.id);
    notifyIfAttestedDrained();
    return true;
  }

  function attachChild(token, child) {
    if (!token || active.get(token.id) !== token) return false;
    if (token.stage !== 'admitted') return false;
    token.child = child || null;
    if (!child || typeof child.once !== 'function') {
      token.stage = 'unattested';
      notifyIfAttestedDrained();
      return false;
    }
    token.stage = 'spawned';
    child.once('error', () => {
      if (active.get(token.id) === token) token.sawError = true;
    });
    child.once('close', () => {
      if (active.get(token.id) === token) endConsumer(token, 'close');
    });
    return true;
  }

  function snapshot() {
    const c = counts();
    return {
      disarmed,
      drainExpired,
      activeCount: c.activeCount,
      attestedActive: c.attestedActive,
      unattestedCount: c.unattestedCount,
    };
  }

  function canCleanupOwnedResources() {
    return disarmed === true && !drainExpired && active.size === 0;
  }

  function waitIdle(deadlineMono, maxCapMs = MAX_CLAIM_DRAIN_MS) {
    const capMs = Number.isFinite(maxCapMs) && maxCapMs > 0
      ? Math.min(MAX_CLAIM_DRAIN_MS, maxCapMs)
      : 0;
    const initial = counts();
    if (initial.activeCount === 0) {
      return Promise.resolve({
        idle: true, timedOut: false, activeCount: 0, attestedActive: 0, unattestedCount: 0, code: null,
      });
    }
    if (initial.attestedActive === 0 && initial.unattestedCount > 0) {
      return Promise.resolve({
        idle: false,
        timedOut: false,
        activeCount: initial.activeCount,
        attestedActive: 0,
        unattestedCount: initial.unattestedCount,
        code: 'CONSUMER_UNATTESTED',
      });
    }
    const start = nowMono();
    const budgetRem = deadlineMono === undefined ? capMs : (deadlineMono - start);
    const waitMs = Math.min(capMs, Math.max(0, Number.isFinite(budgetRem) ? budgetRem : 0));
    if (waitMs <= 0) {
      if (initial.attestedActive > 0) drainExpired = true;
      return Promise.resolve({
        idle: false,
        timedOut: false,
        activeCount: initial.activeCount,
        attestedActive: initial.attestedActive,
        unattestedCount: initial.unattestedCount,
        code: initial.attestedActive > 0 ? 'CLAIM_BUDGET_EXHAUSTED' : 'CONSUMER_UNATTESTED',
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const effectiveDeadline = start + waitMs;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        waiters.delete(onWake);
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        const expired = Boolean(timedOut) || nowMono() >= effectiveDeadline;
        if (expired) drainExpired = true;
        const finalCounts = counts();
        let code = null;
        if (finalCounts.activeCount > 0) {
          if (finalCounts.attestedActive === 0 && finalCounts.unattestedCount > 0) code = 'CONSUMER_UNATTESTED';
          else if (expired) code = 'CLAIM_DRAIN_TIMEOUT';
        } else if (expired) {
          code = 'CLAIM_DRAIN_TIMEOUT';
        }
        resolve({
          idle: finalCounts.activeCount === 0,
          timedOut: expired,
          activeCount: finalCounts.activeCount,
          attestedActive: finalCounts.attestedActive,
          unattestedCount: finalCounts.unattestedCount,
          code,
        });
      };
      const onWake = () => finish(false);
      waiters.add(onWake);
      timer = setTimer(() => finish(true), waitMs);
    });
  }

  return {
    disarm,
    markDrainExpired,
    isDisarmed,
    beginAdmitted,
    attachChild,
    endConsumer,
    waitIdle,
    snapshot,
    canCleanupOwnedResources,
  };
}

function eseguiSottoLock(opts) {
  const {
    home, manifest, op, root, launchId, ownerInstanceId, cellId,
    budgetMs, holdDir, holdAt, chunk, spawnImpl, onChild,
    consumerTracker, pinDeps,
  } = opts;
  const tracker = consumerTracker || null;
  let claimToken = null;
  if (tracker) {
    const admitted = tracker.beginAdmitted();
    if (!admitted || !admitted.ok) {
      return Promise.resolve({ ok: false, outcome: 'refused', code: 'CLAIM_DISARMED' });
    }
    claimToken = admitted.token;
  }
  const releasePreSpawn = (reason) => {
    if (tracker && claimToken) tracker.endConsumer(claimToken, reason);
  };
  const startMono = performance.now();
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    releasePreSpawn('pre-spawn-budget');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'BUDGET' });
  }
  const deadlineMono = startMono + budgetMs;
  if (!assicuraDir(path.join(home, '.nexuscrew'), 0o700)) {
    releasePreSpawn('pre-spawn-refused');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE' });
  }
  const claims = dirClaim(home);
  if (!assicuraDir(claims, 0o700)) {
    releasePreSpawn('pre-spawn-refused');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE' });
  }
  const effectivePinDeps = (tracker || pinDeps)
    ? { ...(pinDeps || {}), ...(tracker ? { isDisarmed: () => tracker.isDisarmed() } : {}) }
    : undefined;
  const pin = effectivePinDeps ? preparaPin(home, manifest, null, effectivePinDeps) : preparaPin(home, manifest);
  if (!pin.ok) {
    releasePreSpawn('pre-spawn-refused');
    const pinDisarmed = pin.motivo === 'disarmed' || Boolean(tracker && tracker.isDisarmed());
    return Promise.resolve({
      ok: false, outcome: 'refused', code: pinDisarmed ? 'CLAIM_DISARMED' : (pin.code || 'LOCK_UNAVAILABLE'),
      ...(pinDisarmed ? { motivo: 'disarmed' } : (typeof pin.motivo === 'string' ? { motivo: pin.motivo } : {})),
      ...(!pinDisarmed && typeof pin.component === 'string' ? { component: pin.component } : {}),
      ...(typeof pin.platform === 'string' ? { platform: pin.platform } : {}),
      ...(typeof pin.atteso === 'string' ? { atteso: pin.atteso } : {}),
      ...(pin.pinRecovery === 'provision-again' ? { pinRecovery: 'provision-again' } : {}),
      ...(causaManifestValida(pin.manifestCause)
        ? { manifestCause: { code: pin.manifestCause.code, component: 'flock' } }
        : {}),
    });
  }
  const hash = sezione.hashRadice(root);
  const lockPath = path.join(claims, `${hash}.lock`);
  const prima = preparaLock(lockPath);
  if (!prima) {
    releasePreSpawn('pre-spawn-refused');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE' });
  }
  const residuoMs = deadlineMono - performance.now();
  if (!Number.isFinite(residuoMs) || residuoMs <= 0) {
    releasePreSpawn('pre-spawn-budget');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'BUDGET' });
  }
  const attesa = Math.min(residuoMs, 15000);
  const sezioneMs = Math.max(1, Math.min(Math.floor(attesa), Math.floor(attesa / 2)));
  const timeoutSec = Math.max(0.001, (attesa - sezioneMs) / 1000);
  // The minimum granularity is 1 ms for the section budget and 1 ms for the
  // lock wait: a remainder that cannot host both is refused instead of being
  // rounded up, and the granted budgets plus the timer stay within the
  // effective remainder without renewing it.
  if (sezioneMs + timeoutSec * 1000 > residuoMs + 1e-9) {
    releasePreSpawn('pre-spawn-budget');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'BUDGET' });
  }
  const requestId = crypto.randomBytes(8).toString('hex');
  const richiesta = {
    v: 1, op, requestId, root, launchId, ownerInstanceId, cellId,
    claimsDir: claims, lockPath, sectionBudgetMs: sezioneMs,
  };
  const riga = `${JSON.stringify(richiesta)}\n`;
  const args = argvFlock({
    timeoutSec, conflictCode: sezione.CONFLICT_CODE, lockPath,
    nodePath: pin.node, helperPath: pin.helper,
  });
  if (tracker && tracker.isDisarmed()) {
    releasePreSpawn('pre-spawn-disarmed');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'CLAIM_DISARMED', motivo: 'disarmed' });
  }
  const lancia = spawnImpl || spawn;
  let child;
  try {
    child = lancia(pin.flock, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envFiglio(holdDir ? { VL_CLAIM_HOLD_DIR: holdDir, ...(holdAt ? { VL_CLAIM_HOLD_AT: holdAt } : {}) } : null),
    });
  } catch (e) {
    releasePreSpawn('spawn-failed');
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE', error: e });
  }
  if (tracker) {
    const attested = tracker.attachChild(claimToken, child);
    if (!attested) {
      return Promise.resolve({ ok: false, outcome: 'uncertain', code: 'CONSUMER_UNATTESTED' });
    }
  }
  const corpo = Buffer.from(riga, 'utf8');
  const pezzi = chunk && chunk > 0 ? chunk : corpo.length;
  for (let i = 0; i < corpo.length; i += pezzi) child.stdin.write(corpo.subarray(i, i + pezzi));
  child.stdin.end();
  if (typeof onChild === 'function') onChild(child);
  return new Promise((resolve) => {
    let fatto = false;
    const out = [];
    const err = [];
    let outN = 0;
    let trabocco = false;
    child.stdout.on('data', (b) => {
      outN += b.length;
      if (outN > CAP_STDOUT) trabocco = true;
      else out.push(b);
    });
    child.stderr.on('data', (b) => { if (err.length < 4) err.push(b); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, attesa);
    const chiudi = (valore) => {
      if (fatto) return;
      fatto = true;
      clearTimeout(killer);
      resolve(valore);
    };
    child.once('error', (e) => chiudi({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE', error: e, child }));
    child.once('close', (code) => {
      let dopo;
      try { dopo = fs.lstatSync(lockPath); } catch (_) { dopo = null; }
      if (!dopo || dopo.ino !== prima.ino || dopo.dev !== prima.dev) {
        chiudi({ ok: false, outcome: 'uncertain', code: 'LOCK_INODE', child });
        return;
      }
      const stdout = Buffer.concat(out);
      if (code === sezione.CONFLICT_CODE && stdout.length === 0) {
        chiudi({ ok: false, outcome: 'refused', code: 'LOCK_TIMEOUT', child });
        return;
      }
      if (trabocco) { chiudi({ ok: false, outcome: 'uncertain', code: 'STDOUT', child }); return; }
      const testo = stdout.toString('utf8');
      const righe = testo.split('\n').filter((r) => r.length > 0);
      if (code !== 0 || righe.length !== 1) {
        chiudi({ ok: false, outcome: 'uncertain', code: 'NO_RESPONSE', child });
        return;
      }
      let frame;
      try { frame = JSON.parse(righe[0]); } catch (_) {
        chiudi({ ok: false, outcome: 'uncertain', code: 'NO_RESPONSE', child });
        return;
      }
      if (!frame || frame.v !== 1 || frame.requestId !== requestId) {
        chiudi({ ok: false, outcome: 'uncertain', code: 'MISMATCH', child });
        return;
      }
      const bene = frame.outcome === 'claimed' || frame.outcome === 'released'
        || frame.outcome === 'not-held' || frame.outcome === 'inspected';
      chiudi({
        ok: frame.ok === true && bene, outcome: frame.outcome, code: frame.code || null,
        lockHeld: frame.lockHeld === true, own: frame.own || null, lease: frame.lease || null,
        child, stderr: Buffer.concat(err).slice(0, CAP_STDERR).toString('utf8'),
      });
    });
  });
}

function baseRichiesta(opts) {
  const manifest = opts.manifest || MANIFEST;
  const root = opts.root || radiceServer(opts.home, opts.ownerInstanceId, opts.cellId);
  if (!root) return { errore: { ok: false, outcome: 'refused', code: 'ROOT' } };
  return {
    home: opts.home,
    manifest,
    root,
    launchId: opts.launchId,
    ownerInstanceId: opts.ownerInstanceId || 'local',
    cellId: opts.cellId,
    budgetMs: Number.isFinite(opts.budgetMs) ? opts.budgetMs : 4000,
    holdDir: opts.holdDir,
    holdAt: opts.holdAt,
    chunk: opts.chunk,
    spawnImpl: opts.spawnImpl,
    onChild: opts.onChild,
    ...(opts.consumerTracker ? { consumerTracker: opts.consumerTracker } : {}),
    ...(opts.pinDeps ? { pinDeps: opts.pinDeps } : {}),
  };
}

function riserva(opts) {
  const b = baseRichiesta(opts);
  if (b.errore) return Promise.resolve(b.errore);
  return eseguiSottoLock({ ...b, op: 'claim' });
}

function rilascia(opts) {
  const b = baseRichiesta(opts);
  if (b.errore) return Promise.resolve(b.errore);
  return eseguiSottoLock({ ...b, op: 'release' });
}

function ispeziona(opts) {
  const b = baseRichiesta(opts);
  if (b.errore) return Promise.resolve(b.errore);
  return eseguiSottoLock({ ...b, op: 'inspect', launchId: opts.launchId || '0'.repeat(16) });
}

module.exports = {
  argvFlock, radiceServer, dirClaim, preparaLock, pinna, preparaPin, piattaformaRuntime, versioneFlock,
  riserva, rilascia, ispeziona, MANIFEST, creaTracciatoreClaim, MAX_CLAIM_DRAIN_MS,
  qualificaAssenzaRadice, qualificaRadiceInLettura, osservaClaim, stessaImprontaRadice,
  // Internal seam for tests only.
  __prove: { registraVerificato },
};
