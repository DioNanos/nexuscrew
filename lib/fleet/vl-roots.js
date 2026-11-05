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

const MANIFEST = require('./vl-claim-pin-manifest.json');
const CAP_STDOUT = 8192;
const CAP_STDERR = 4096;

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
// diagnosi (P1-c): stessa struttura di rifiuto (link, ENOTDIR, permessi),
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
    try { fs.linkSync(tmp, dest); } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!e || e.code !== 'EEXIST') return null;
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  let diNuovo;
  try { diNuovo = fs.readFileSync(dest); } catch (_) { return null; }
  if (sha256(diNuovo) !== hash) return null;
  let st;
  try { st = fs.lstatSync(dest); } catch (_) { return null; }
  if (!st.isFile() || st.isSymbolicLink()) return null;
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
  if (process.execPath) registraVerificato(process.execPath, MANIFEST && MANIFEST.node && MANIFEST.node.sha256);
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
    let appenaPubblicato = false;
    try { fs.linkSync(priv.path, dest); appenaPubblicato = true; } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, code: 'PIN_STAGE' };
    }
    let st;
    try { st = fs.lstatSync(dest); } catch (_) { return { ok: false, code: 'PIN_REREAD' }; }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'PIN_REREAD' };
    if (!priv.grande) {
      let diNuovo;
      try { diNuovo = fs.readFileSync(dest); } catch (_) { return { ok: false, code: 'PIN_REREAD' }; }
      if (sha256(diNuovo) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
      return { ok: true, path: dest };
    }
    // Large object: identity with the privately re-verified copy stands in
    // for a per-call re-read; a different object at dest is verified by its
    // bytes and never overwritten.
    if (appenaPubblicato || (st.ino === priv.ino && st.dev === priv.dev)) return { ok: true, path: dest };
    let diNuovo;
    try { diNuovo = fs.readFileSync(dest); } catch (_) { return { ok: false, code: 'PIN_REREAD' }; }
    if (sha256(diNuovo) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
    return { ok: true, path: dest };
  }
  let buf;
  try { buf = fs.readFileSync(source); } catch (_) { return { ok: false, code: 'PIN_ABSENT' }; }
  const hash = sha256(buf);
  if (hash !== expectedHash) return { ok: false, code: 'PIN_MISMATCH' };
  if (!assicuraDir(stagingDir, 0o700)) return { ok: false, code: 'PIN_DIR' };
  const dest = path.join(stagingDir, expectedHash);
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o500);
    try {
      fs.writeFileSync(fd, buf);
      fs.fchmodSync(fd, 0o500);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.linkSync(tmp, dest); } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!e || e.code !== 'EEXIST') return { ok: false, code: 'PIN_STAGE' };
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  let diNuovo;
  try { diNuovo = fs.readFileSync(dest); } catch (_) { return { ok: false, code: 'PIN_REREAD' }; }
  if (sha256(diNuovo) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
  return { ok: true, path: dest };
}

function sorgenteNode(manifest) {
  const dichiarato = manifest && manifest.node && manifest.node.source;
  if (typeof dichiarato === 'string' && dichiarato.length > 0) return dichiarato;
  return process.execPath;
}

function preparaPin(home, manifest) {
  const staging = dirPin(home);
  const flock = pinna(manifest.flock.source, manifest.flock.sha256, staging);
  if (!flock.ok) return flock;
  // The version is read from the qualified pinned object and cached against
  // its verified content hash.
  if (versioneFlock(flock.path, manifest.flock.sha256) !== manifest.flock.version) {
    return { ok: false, code: 'PIN_VERSION' };
  }
  const node = pinna(sorgenteNode(manifest), manifest.node.sha256, staging);
  if (!node.ok) return node;
  const helperSrc = path.join(__dirname, 'vl-claim-section.js');
  const helper = pinna(helperSrc, manifest.helper.sha256, staging);
  if (!helper.ok) return helper;
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

function eseguiSottoLock(opts) {
  const {
    home, manifest, op, root, launchId, ownerInstanceId, cellId,
    budgetMs, holdDir, holdAt, chunk, spawnImpl, onChild,
  } = opts;
  const startMono = performance.now();
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'BUDGET' });
  }
  const deadlineMono = startMono + budgetMs;
  if (!assicuraDir(path.join(home, '.nexuscrew'), 0o700)) {
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE' });
  }
  const claims = dirClaim(home);
  if (!assicuraDir(claims, 0o700)) {
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE' });
  }
  const pin = preparaPin(home, manifest);
  if (!pin.ok) return Promise.resolve({ ok: false, outcome: 'refused', code: pin.code || 'LOCK_UNAVAILABLE' });
  const hash = sezione.hashRadice(root);
  const lockPath = path.join(claims, `${hash}.lock`);
  const prima = preparaLock(lockPath);
  if (!prima) return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE' });
  const residuoMs = deadlineMono - performance.now();
  if (!Number.isFinite(residuoMs) || residuoMs <= 0) {
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
  const lancia = spawnImpl || spawn;
  let child;
  try {
    child = lancia(pin.flock, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envFiglio(holdDir ? { VL_CLAIM_HOLD_DIR: holdDir, ...(holdAt ? { VL_CLAIM_HOLD_AT: holdAt } : {}) } : null),
    });
  } catch (e) {
    return Promise.resolve({ ok: false, outcome: 'refused', code: 'LOCK_UNAVAILABLE', error: e });
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
  argvFlock, radiceServer, dirClaim, preparaLock, pinna, preparaPin,
  riserva, rilascia, ispeziona, MANIFEST,
  qualificaAssenzaRadice, qualificaRadiceInLettura, osservaClaim, stessaImprontaRadice,
};
