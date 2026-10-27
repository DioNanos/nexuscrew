'use strict';
// Claim della root VL. Il processo NC non legge ne' scrive
// ownership e lease: lo fa il figlio, che eredita il lock da flock -F.
// Pubblicazione: fs.link. Pin: lettura, hash, staging esclusivo, rilettura.

const crypto = require('node:crypto');
const fs = require('node:fs');
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
function versioneFlock(bin) {
  const key = path.basename(bin);
  if (flockVersionCache.has(key)) return flockVersionCache.get(key);
  if (flockVersionCache.has(bin)) return flockVersionCache.get(bin);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: false, timeout: 2000 });
  const testo = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = testo.match(/util-linux\s+(\d+\.\d+\.\d+)/);
  const v = m ? m[1] : '';
  if (v) {
    flockVersionCache.set(bin, v);
    flockVersionCache.set(key, v);
    if (MANIFEST && MANIFEST.flock && MANIFEST.flock.sha256) {
      flockVersionCache.set(MANIFEST.flock.sha256, v);
    }
  }
  return v;
}

let cachedNode = null;
try {
  if (process.execPath) {
    const b = fs.readFileSync(process.execPath);
    cachedNode = { buf: b, hash: sha256(b) };
  }
} catch (_) {}
try {
  versioneFlock('/usr/bin/flock');
} catch (_) {}

function pinna(source, expectedHash, stagingDir) {
  let buf;
  let hash;
  if (source === process.execPath && cachedNode) {
    buf = cachedNode.buf;
    hash = cachedNode.hash;
  } else {
    try { buf = fs.readFileSync(source); } catch (_) { return { ok: false, code: 'PIN_ABSENT' }; }
    hash = sha256(buf);
    if (source === process.execPath) cachedNode = { buf, hash };
  }
  if (hash !== expectedHash) return { ok: false, code: 'PIN_MISMATCH' };
  if (!assicuraDir(stagingDir, 0o700)) return { ok: false, code: 'PIN_DIR' };
  const dest = path.join(stagingDir, expectedHash);
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    let linked = false;
    try {
      fs.linkSync(source, tmp);
      linked = true;
    } catch (_) {}
    if (!linked) {
      const fd = fs.openSync(tmp, 'wx', 0o500);
      try {
        fs.writeFileSync(fd, buf);
        fs.fchmodSync(fd, 0o500);
      } finally { fs.closeSync(fd); }
    }
    try { fs.linkSync(tmp, dest); } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (!e || e.code !== 'EEXIST') return { ok: false, code: 'PIN_STAGE' };
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  let verified = false;
  try {
    const stDest = fs.statSync(dest);
    const stSource = fs.statSync(source);
    if (stDest.ino === stSource.ino && stDest.dev === stSource.dev && stDest.size === stSource.size) {
      verified = true;
    }
  } catch (_) {}
  if (!verified) {
    let diNuovo;
    try { diNuovo = fs.readFileSync(dest); } catch (_) { return { ok: false, code: 'PIN_REREAD' }; }
    if (sha256(diNuovo) !== expectedHash) return { ok: false, code: 'PIN_REREAD' };
  }
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
  if (versioneFlock(flock.path) !== manifest.flock.version) return { ok: false, code: 'PIN_VERSION' };
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
};
