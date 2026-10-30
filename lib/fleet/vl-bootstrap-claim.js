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
// e OGNI parent NUOVA della catena (la directory appena creata E la sua entry
// nel parent). Ogni errore di open o fsync — anche sulle directory — è
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
// owned, no symlink — stessa guardia di safePrivateDir) e, quando la
// directory è NUOVA, la rende durevole insieme alla sua ENTRY nel parent
// (R2: creare una directory senza sincronizzare il parent non rende durevole
// né l'una né l'altra).
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
  if (created) {
    syncDirDurable(dir);
    syncDirDurable(path.dirname(dir));
  }
  return created;
}

// Directory privata NC accanto alla root della cella. La catena si qualifica
// in ORDINE e ogni anello nuovo è durevole quando questa funzione ritorna
// (nessun best-effort: un fallimento propaga e il lancio non è idoneo).
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
// nulla. R3 (esito persistente del trasporto) è il prossimo strato: qui il
// record si legge così com'è stato scritto nel preflight.
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

module.exports = { decideVlBootstrap, readVlBootstrapClaim, claimDir, REASONS };
