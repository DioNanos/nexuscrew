'use strict';
// D-558 — claim persistente NC per il bootstrap dei client `vl`.
//
// REQUISITO DAG (30/10 10:5x), che prevale sul disegno precedente: «abbiamo
// CREATO nexuscrew PROPRIO per MANDARE dei prompt iniziali ed avere celle
// DISTINTE auto INIZIALIZZANTI». OGNI AVVIO della cella (`up` del fleet:
// generation 0 di un supervisore nuovo) consegna `cell.prompt` UNA volta sola,
// sia su un host VL nuovo sia su uno GIÀ ESISTENTE. I respawn della TUI dentro
// lo stesso avvio (generation > 0, riattacco) NON riconsegnano mai: la
// conversazione VL è la stessa. Per questo l'idoneità non dipende più da
// fresh-host/rotazione e `host-pre-existing` non è più un motivo di skip.
//
// La claim è PER AVVIO (chiave: `launchId` del supervisore generation 0), non
// per incarnazione dell'host: garantisce al più UN paste per avvio anche con
// due `up` concorrenti (serializzati dalla root claim) o con un respawn che
// ripercorresse il preflight con lo stesso launchId (O_EXCL → claim-taken).
//
// Il record vive in `<base>/nc/bootstrap-<launchId>.json`: ACCANTO alla root,
// NON nei file di VL (VL possiede <base>/state|data|config; `nc/` è privato NC,
// stessa disciplina di launcher-pins). Nessun testo del prompt né segreti:
// solo id e timestamp.
//
// DURABILITÀ (R2, allineata al contratto FSYNC_DIR di vl-claim-section): prima
// di eligible:true vengono sincronizzati il file, la directory che lo contiene
// e OGNI anello della catena con la sua ENTRY nel parent, A OGNI ACQUISIZIONE
// — non solo quando l'anello è appena stato creato (D-558 FIX2a / F3: una
// directory rimasta da un tentativo incompleto non attesta il proprio fsync).
// Ogni errore di open o fsync — anche sulle directory — è
// FAIL-CLOSED: niente paste, motivo bounded, e la claim forse già pubblicata
// NON viene cancellata. I descriptor si chiudono sempre in `finally`.

const fs = require('node:fs');
const path = require('node:path');
const { vlCellBaseDir } = require('./managed.js');
const { safePrivateDir } = require('./credentials.js');

const CLAIM_VERSION = 2;

// Motivi bounded restituiti (stessi slug di VL_SKIP_REASONS in
// prompt-delivery.js: un solo vocabolario per launcher, supervisore e report).
// 'launch' = idoneo PER AVVIO (requisito DAG); gli altri sono skip espliciti.
const REASONS = Object.freeze(['launch', 'claim-taken', 'claim-unavailable']);

function assertSafeCellId(cellId) {
  const id = typeof cellId === 'string' ? cellId : '';
  if (!id || id === '.' || id === '..' || id.includes('/') || /[\x00-\x1f\x7f]/.test(id)) {
    throw new Error('unsafe vl cell id');
  }
  return id;
}

// Il launchId del supervisore generation 0 (crypto.randomBytes(8) in hex):
// è la chiave della claim per avvio, quindi la forma è chiusa.
function assertSafeLaunchId(launchId) {
  const id = typeof launchId === 'string' ? launchId : '';
  if (!/^[0-9a-f]{16}$/.test(id)) {
    throw new Error('unsafe vl launch id');
  }
  return id;
}

// fsync di una directory aperta in lettura. Il descriptor si chiude SEMPRE
// (finally): un fsync che solleva non lascia fd aperti. Ogni errore di open
// o di fsync propaga: il chiamante decide il fail-closed.
function syncDirDurable(dir) {
  let fd;
  fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Un anello della catena privata NC: crea se manca, valida sempre (0700,
// owned, no symlink — stessa guardia di safePrivateDir) e rende durevoli
// l'anello E la sua ENTRY nel parent A OGNI ACQUISIZIONE (D-558 FIX2a / F3:
// creare una directory senza sincronizzare il parent non rende durevole né
// l'una né l'altra, e l'esistenza di una directory rimasta da un tentativo
// incompleto NON attesta il fsync precedente — un `created === false` non
// eredita l'idoneità). Ogni errore di open o fsync propaga: il lancio non è
// idoneo finché la catena non è dimostrata durevole.
function ensurePrivateDirDurable(dir) {
  let created = false;
  try {
    fs.lstatSync(dir);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    created = true;
  }
  safePrivateDir(dir, { create: false });
  syncDirDurable(dir);
  syncDirDurable(path.dirname(dir));
  return created;
}

// Directory privata NC accanto alla root della cella. La catena si qualifica
// in ORDINE e ogni anello è durevole a OGNI acquisizione quando questa
// funzione ritorna (nessun best-effort: un fallimento propaga e il lancio
// non è idoneo).
function claimDir(home, ownerInstanceId, cellId) {
  const id = assertSafeCellId(cellId);
  const nexus = path.join(home, '.nexuscrew');
  const cells = path.join(nexus, 'vl-cells');
  const base = vlCellBaseDir(home, ownerInstanceId, id);
  const nc = path.join(base, 'nc');
  ensurePrivateDirDurable(nexus);
  ensurePrivateDirDurable(cells);
  ensurePrivateDirDurable(base);
  ensurePrivateDirDurable(nc);
  return nc;
}

function claimPathFor(dir, launchId) {
  return path.join(dir, `bootstrap-${assertSafeLaunchId(launchId)}.json`);
}

// decideVlBootstrap({...}) -> { eligible, reason, claimPath }
//   launchId: chiave per avvio (generation 0 del supervisore di QUESTO up).
// Pura decisione + acquisizione atomica: si chiama UNA volta per lancio, nel
// preflight, con la root claim in mano. Fail-closed: ogni dubbio è skip.
function decideVlBootstrap({
  home, ownerInstanceId, cellId, launchId, now = Date.now(),
} = {}) {
  const id = assertSafeCellId(cellId);
  const lid = assertSafeLaunchId(launchId);
  const record = {
    version: CLAIM_VERSION,
    cell: id,
    launchId: lid,
    claimedAt: now,
    state: 'pending',
  };
  let target;
  let fd;
  try {
    const dir = claimDir(home, ownerInstanceId, id);
    target = claimPathFor(dir, lid);
    // O_EXCL: l'unico creatore vince. La claim è atomica E durevole PRIMA del
    // paste: fsync del file, poi fsync della directory che lo contiene (e
    // delle parent nuove, già garantito da claimDir).
    fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      fd = undefined;
    }
    syncDirDurable(dir);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    if (e && e.code === 'EEXIST') return { eligible: false, reason: 'claim-taken', claimPath: target };
    // R2 fail-closed: open o fsync fallito su file, directory o parent. La
    // claim forse già pubblicata NON si cancella: un crash con claim in stato
    // incerto resta visibile sul disco, nessun paste.
    return { eligible: false, reason: 'claim-unavailable' };
  }
  return { eligible: true, reason: 'launch', claimPath: target };
}

// Lettura read-only (diagnostica): il record claim di UN avvio, senza creare
// nulla. D-558 FIX1b (R3): il record porta l'esito PERSISTENTE del trasporto
// per avvio — `pending` finché la consegna non ha un esito, poi uno degli
// stati bounded di CLAIM_STATES. Un crash senza esito resta `pending`, che si
// legge come INCERTO: mai come «consegnato».
function readVlBootstrapClaim({ home, ownerInstanceId, cellId, launchId } = {}) {
  const id = assertSafeCellId(cellId);
  const lid = assertSafeLaunchId(launchId);
  try {
    const dir = path.join(vlCellBaseDir(home, ownerInstanceId, id), 'nc');
    const record = JSON.parse(fs.readFileSync(claimPathFor(dir, lid), 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch (_) {
    return null;
  }
}

// D-558 FIX1b (R3) — esito persistente della claim PER AVVIO. Stati bounded:
//   pending    — scritta dal preflight, consegna ancora senza esito (un crash
//                senza esito resta pending e si legge come INCERTO);
//   submitted  — paste+Enter riusciti: significa SOLO che il trasporto ha
//                consegnato, NON che il modello l'abbia eseguito;
//   failed     — fallimento CERTO prima del paste (niente è stato digitato);
//   uncertain  — paste forse avvenuto (post-paste incerto).
const CLAIM_STATES = Object.freeze(['pending', 'submitted', 'failed', 'uncertain']);

// Mappa chiusa stato-delivery (prompt-delivery.js) -> stato claim. Null = non
// si settle (cancelled/report-timeout/l'esito non è del supervisore): la claim
// resta `pending`, che si legge come incerto.
function vlClaimOutcomeFor(deliveryState) {
  switch (deliveryState) {
    case 'submitted': return 'submitted';
    case 'staged-not-submitted':
    case 'delivery-unknown': return 'uncertain';
    case 'failed-pre-paste':
    case 'prompt-rejected':
    case 'transport-unsupported':
    case 'skipped-not-ready':
    case 'skipped-unknown': return 'failed';
    default: return null;
  }
}

function assertSafeClaimPath(claimPath) {
  if (typeof claimPath !== 'string' || claimPath.length === 0 || claimPath.length > 4096
    || /[\0\r\n]/.test(claimPath)) {
    throw new Error('unsafe vl claim path');
  }
  return claimPath;
}

// Aggiorna l'esito della claim di un avvio in modo ATOMICO E DUREVOLE, con la
// stessa disciplina di R2: file temporaneo O_EXCL 0600 + fsync + rename +
// fsync della directory che contiene. La claim pubblicata NON si cancella
// mai; il replace è atomico, quindi un crash lascia o il vecchio record o il
// nuovo, mai un record a metà. Il settle avviene SOLO da `pending`: l'esito
// già pubblicato di quell'avvio non si riscrive. Ogni errore -> { updated:
// false } e il record resta quello che era (fail-safe, nessuna throw che
// possa uccidere il supervisore dopo la consegna).
function settleVlBootstrapClaim({ claimPath, state, detail, notReady, now = Date.now() } = {}) {
  const target = assertSafeClaimPath(claimPath);
  if (!CLAIM_STATES.includes(state) || state === 'pending') return { updated: false };
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    return { updated: false }; // claim assente/illeggibile: non si inventa un esito
  }
  if (!prev || typeof prev !== 'object' || Array.isArray(prev) || prev.state !== 'pending') {
    return { updated: false, state: prev && typeof prev === 'object' ? prev.state : undefined };
  }
  const record = {
    ...prev,
    state,
    settledAt: now,
    ...(typeof detail === 'string' && detail ? { detail } : {}),
    ...(typeof notReady === 'string' && notReady ? { notReady } : {}),
  };
  const tmp = `${target}.tmp-${process.pid}-${now}-${Math.floor(Math.random() * 1e9)}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      fd = undefined;
    }
    fs.renameSync(tmp, target);
    syncDirDurable(path.dirname(target));
  } catch (_) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {} // il temporaneo non è la claim: si rimuove
    return { updated: false };
  }
  return { updated: true, state };
}

module.exports = {
  decideVlBootstrap, readVlBootstrapClaim, settleVlBootstrapClaim,
  vlClaimOutcomeFor, claimDir, REASONS, CLAIM_STATES,
};
