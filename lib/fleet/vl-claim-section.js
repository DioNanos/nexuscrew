'use strict';
// Processo di sezione del claim. Parte gia' sotto flock -F:
// l'fd del lock e' ereditato e resta aperto per tutta la lettura, la
// decisione e la pubblicazione. Un solo frame in ingresso, una sola risposta.
// La pubblicazione e' fs.link del temporaneo gia' sincronizzato. Mai rename.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CAP_RIGA = 8192;
const CONFLICT_CODE = 73;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function rispondi(out) {
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function canonicaRadice(root) {
  if (typeof root !== 'string' || root.length < 2 || root.length > 4096) return null;
  if (!path.isAbsolute(root) || root.includes('\0')) return null;
  const pezzi = root.split(path.sep).filter((p) => p.length > 0);
  if (pezzi.length === 0 || pezzi.some((p) => p === '.' || p === '..')) return null;
  let acc = path.parse(root).root;
  for (let i = 0; i < pezzi.length; i += 1) {
    const next = path.join(acc, pezzi[i]);
    let st;
    try { st = fs.lstatSync(next); } catch (e) {
      if (!e || e.code !== 'ENOENT') return null;
      return path.join(acc, ...pezzi.slice(i));
    }
    if (st.isSymbolicLink()) return null;
    if (i < pezzi.length - 1 && !st.isDirectory()) return null;
    acc = next;
  }
  try { return fs.realpathSync(acc); } catch (_) { return null; }
}

function hashRadice(root) {
  return sha256(Buffer.from(root, 'utf8'));
}

function nome(claimsDir, hash, suffix) {
  return path.join(claimsDir, `${hash}.${suffix}`);
}

function leggiJson(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return { stato: 'assente' };
    return { stato: 'errore' };
  }
  let o;
  try { o = JSON.parse(buf.toString('utf8')); } catch (_) { return { stato: 'corrotto' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { stato: 'corrotto' };
  return { stato: 'presente', dato: o };
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function scriviTemp(claimsDir, hash, dato) {
  const tmp = nome(claimsDir, hash, `tmp-${crypto.randomBytes(8).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(dato));
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

function pubblica(claimsDir, hash, suffix, dato) {
  const finale = nome(claimsDir, hash, suffix);
  const tmp = scriviTemp(claimsDir, hash, dato);
  try {
    fs.linkSync(tmp, finale);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* il temporaneo non e' autorevole */ }
    const code = e && e.code;
    if (code === 'EEXIST') return { esito: 'esiste' };
    if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EOPNOTSUPP' || code === 'ENOTSUP') {
      return { esito: 'rifiutato', code };
    }
    return { esito: 'incerto', code: code || 'LINK' };
  }
  puntoProva('dopo-link');
  try { fsyncDir(claimsDir); } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { esito: 'incerto', code: 'FSYNC_DIR' };
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* il nome finale e' gia' il record */ }
  try { fsyncDir(claimsDir); } catch (_) { return { esito: 'incerto', code: 'FSYNC_DIR' }; }
  return { esito: 'pubblicato', file: finale };
}

function puntoProva(nomePunto) {
  const dir = process.env.VL_CLAIM_HOLD_DIR;
  if (!dir) return;
  const solo = process.env.VL_CLAIM_HOLD_AT;
  if (solo && solo !== nomePunto) return;
  const id = `${process.pid}-${nomePunto}`;
  try { fs.writeFileSync(path.join(dir, `entered-${id}`), '1'); } catch (_) { return; }
  const via = path.join(dir, `go-${id}`);
  const limite = Date.now() + 4000;
  while (!fs.existsSync(via)) {
    if (Date.now() > limite) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function riservaIncerta(claimsDir, hash, dato) {
  const file = nome(claimsDir, hash, 'reserve');
  try {
    if (fs.existsSync(file)) return;
    const tmp = scriviTemp(claimsDir, hash, dato);
    try { fs.linkSync(tmp, file); } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    fsyncDir(claimsDir);
  } catch (_) { /* la riserva osservabile, se c'e', basta; non si cancella nulla */ }
}

function validaRichiesta(o) {
  if (!o || o.v !== 1) return 'versione';
  if (o.op !== 'claim' && o.op !== 'release' && o.op !== 'inspect') return 'op';
  if (typeof o.requestId !== 'string' || !/^[a-f0-9]{16}$/.test(o.requestId)) return 'requestId';
  if (typeof o.claimsDir !== 'string' || !path.isAbsolute(o.claimsDir)) return 'claimsDir';
  if (typeof o.root !== 'string') return 'root';
  if (o.op !== 'inspect' && (typeof o.launchId !== 'string' || !/^[a-f0-9]{16}$/.test(o.launchId))) return 'launchId';
  if (typeof o.ownerInstanceId !== 'string' || o.ownerInstanceId.length < 1 || o.ownerInstanceId.length > 128) return 'owner';
  if (typeof o.cellId !== 'string' || o.cellId.length < 1 || o.cellId.length > 64) return 'cell';
  if (!Number.isSafeInteger(o.sectionBudgetMs) || o.sectionBudgetMs < 1 || o.sectionBudgetMs > 60000) return 'budget';
  return null;
}

function lockTenuto(lockPath) {
  if (typeof lockPath !== 'string' || !lockPath) return false;
  let nomi;
  try { nomi = fs.readdirSync('/proc/self/fd'); } catch (_) { return false; }
  for (const n of nomi) {
    try {
      if (fs.readlinkSync(path.join('/proc/self/fd', n)) === lockPath) return true;
    } catch (_) { /* fd chiuso nel frattempo */ }
  }
  return false;
}

function recordStesso(dato, req, conLancio) {
  if (!dato || dato.v !== 1 || dato.root !== req.root) return false;
  if (dato.ownerInstanceId !== req.ownerInstanceId || dato.cellId !== req.cellId) return false;
  if (conLancio && dato.launchId !== req.launchId) return false;
  return true;
}

function eseguiSezione(req) {
  const base = { v: 1, requestId: req.requestId, lockHeld: false };
  const inizio = Number(process.hrtime.bigint() / 1000000n);
  const canon = canonicaRadice(req.root);
  if (!canon || canon !== req.root) return { ...base, ok: false, outcome: 'refused', code: 'ROOT' };
  if (Number(process.hrtime.bigint() / 1000000n) - inizio > req.sectionBudgetMs) {
    return { ...base, ok: false, outcome: 'refused', code: 'BUDGET' };
  }
  const hash = hashRadice(canon);
  const dir = req.claimsDir;
  if (fs.existsSync(nome(dir, hash, 'reserve'))) {
    return { ...base, ok: false, outcome: 'uncertain', code: 'RESERVE' };
  }
  if (req.op === 'inspect') {
    const own = leggiJson(nome(dir, hash, 'own'));
    const lease = leggiJson(nome(dir, hash, 'lease'));
    if (own.stato === 'corrotto' || own.stato === 'errore' || lease.stato === 'corrotto' || lease.stato === 'errore') {
      return { ...base, ok: false, outcome: 'uncertain', code: 'CORRUPT' };
    }
    return {
      ...base, ok: true, outcome: 'inspected',
      own: own.stato === 'presente' ? own.dato : null,
      lease: lease.stato === 'presente' ? lease.dato : null,
    };
  }
  if (req.op === 'claim') {
    const own = leggiJson(nome(dir, hash, 'own'));
    if (own.stato === 'corrotto' || own.stato === 'errore') {
      return { ...base, ok: false, outcome: 'uncertain', code: 'CORRUPT' };
    }
    if (own.stato === 'presente' && !recordStesso(own.dato, req, false)) {
      return { ...base, ok: false, outcome: 'collision', code: 'VL_ROOT_COLLISION' };
    }
    const lease = leggiJson(nome(dir, hash, 'lease'));
    if (lease.stato === 'corrotto' || lease.stato === 'errore') {
      return { ...base, ok: false, outcome: 'uncertain', code: 'CORRUPT' };
    }
    if (lease.stato === 'presente' && !recordStesso(lease.dato, req, true)) {
      return { ...base, ok: false, outcome: 'collision', code: 'VL_ROOT_COLLISION' };
    }
    puntoProva('dopo-lettura');
    if (own.stato === 'assente') {
      const pub = pubblica(dir, hash, 'own', {
        v: 1, kind: 'own', root: canon, ownerInstanceId: req.ownerInstanceId, cellId: req.cellId,
      });
      if (pub.esito === 'esiste') return { ...base, ok: false, outcome: 'collision', code: 'VL_ROOT_COLLISION' };
      if (pub.esito !== 'pubblicato') {
        if (pub.esito === 'incerto') riservaIncerta(dir, hash, { v: 1, kind: 'reserve', op: 'claim', launchId: req.launchId, root: canon });
        return { ...base, ok: false, outcome: pub.esito === 'incerto' ? 'uncertain' : 'refused', code: pub.code || 'PUBLISH' };
      }
    }
    if (lease.stato === 'assente') {
      const pub = pubblica(dir, hash, 'lease', {
        v: 1, kind: 'lease', root: canon, ownerInstanceId: req.ownerInstanceId,
        cellId: req.cellId, launchId: req.launchId,
      });
      if (pub.esito === 'esiste') return { ...base, ok: false, outcome: 'collision', code: 'VL_ROOT_COLLISION' };
      if (pub.esito !== 'pubblicato') {
        if (pub.esito === 'incerto') riservaIncerta(dir, hash, { v: 1, kind: 'reserve', op: 'claim', launchId: req.launchId, root: canon });
        return { ...base, ok: false, outcome: pub.esito === 'incerto' ? 'uncertain' : 'refused', code: pub.code || 'PUBLISH' };
      }
    }
    return { ...base, ok: true, outcome: 'claimed' };
  }
  const lease = leggiJson(nome(dir, hash, 'lease'));
  if (lease.stato === 'corrotto' || lease.stato === 'errore') {
    return { ...base, ok: false, outcome: 'uncertain', code: 'CORRUPT' };
  }
  if (lease.stato === 'assente' || !recordStesso(lease.dato, req, true)) {
    return { ...base, ok: true, outcome: 'not-held' };
  }
  puntoProva('dopo-lettura');
  try { fs.unlinkSync(nome(dir, hash, 'lease')); } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      riservaIncerta(dir, hash, { v: 1, kind: 'reserve', op: 'release', launchId: req.launchId, root: canon });
      return { ...base, ok: false, outcome: 'uncertain', code: 'UNLINK' };
    }
  }
  try { fsyncDir(dir); } catch (_) {
    riservaIncerta(dir, hash, { v: 1, kind: 'reserve', op: 'release', launchId: req.launchId, root: canon });
    return { ...base, ok: false, outcome: 'uncertain', code: 'FSYNC_DIR' };
  }
  return { ...base, ok: true, outcome: 'released' };
}

function leggiRichiesta(budgetMs) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let chiuso = false;
    const finisci = (errore, dato) => {
      if (chiuso) return;
      chiuso = true;
      clearTimeout(limite);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      resolve(errore ? { errore } : { dato });
    };
    const limite = setTimeout(() => finisci('BUDGET'), budgetMs);
    const unaRiga = () => {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return { errore: 'EOF_PARZIALE' };
      const resto = buf.slice(nl + 1);
      if (resto.some((b) => b !== 0x0a)) return { errore: 'EXTRA' };
      try {
        return { dato: JSON.parse(buf.slice(0, nl).toString('utf8')) };
      } catch (_) {
        return { errore: 'JSON' };
      }
    };
    process.stdin.on('data', (chunk) => {
      const pezzo = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = Buffer.concat([buf, pezzo]);
      if (buf.length > CAP_RIGA) finisci('CAP');
    });
    process.stdin.on('end', () => {
      if (buf.length === 0) { finisci('EOF'); return; }
      const letto = unaRiga();
      finisci(letto.errore || null, letto.dato);
    });
    process.stdin.on('error', () => finisci('EOF'));
  });
}

async function main() {
  const letto = await leggiRichiesta(5000);
  if (letto.errore || !letto.dato) {
    rispondi({ v: 1, ok: false, outcome: 'refused', code: letto.errore || 'EOF', requestId: null, lockHeld: false });
    return 0;
  }
  const err = validaRichiesta(letto.dato);
  if (err) {
    rispondi({ v: 1, ok: false, outcome: 'refused', code: err, requestId: letto.dato.requestId || null, lockHeld: false });
    return 0;
  }
  const tenuto = lockTenuto(letto.dato.lockPath);
  if (!tenuto) {
    rispondi({ v: 1, ok: false, outcome: 'refused', code: 'LOCK_FD_ABSENT', requestId: letto.dato.requestId, lockHeld: false });
    return 0;
  }
  const esito = eseguiSezione(letto.dato);
  esito.lockHeld = true;
  rispondi(esito);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}

module.exports = {
  canonicaRadice, hashRadice, eseguiSezione, validaRichiesta, CONFLICT_CODE, pubblicare: pubblica,
};
