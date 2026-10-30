'use strict';
// D-558 — claim persistente NC per il bootstrap dei client `vl`.
//
// Il bootstrap (primo turno utente con cell.prompt) parte SOLO a generation 0
// E con una claim durabile per l'incarnazione dello stato host/sessione che il
// launcher SA essere appena creata. La prova di creazione si acquisisce nel
// preflight, PRIMA di lanciare la TUI, mentre il launcher detiene la claim
// della root (vl-roots.js `riserva`: i lanci sulla stessa root sono
// serializzati):
//   - 'fresh-host': la root host (<base>/state/vl/host-v1) NON esiste ancora
//     su disco. Sotto la root claim nessun altro lancio NC può starla creando:
//     l'host che esisterà dopo questo spawn è creato da QUESTO lancio. Non è
//     «directory vuota trovata»: è assenza della root al preflight + claim
//     esclusiva + record che la conserva.
//   - 'rotated-session': il marcatore persistente «sessione nuova»
//     (vl-session.js) è stato consumato atomicamente da QUESTO lancio: la
//     sessione verrà ricreata dal TUI di generazione 0.
// Tutto il resto — host esistente senza ricevuta (incluse le celle pre-fix,
// Research compresa), claim già presa, claim non scrivibile — è SKIP ESPPLICITO
// con motivo bounded: mai dedurre la verginità dell'assenza del marker.
//
// Il record vive in `<base>/nc/bootstrap-*.json`: ACCANTO alla root, NON nei
// file di VL (VL possiede <base>/state|data|config; `nc/` è privato NC, stessa
// disciplina di launcher-pins). Creazione atomica O_EXCL ('wx') + fsync: due
// lanci concorrenti non possono vincere entrambi, e un crash lascia la claim
// pendente — nessun retry automatico, stato incerto visibile, recupero
// esplicito dell'operatore. Il record NON contiene testo del prompt né
// segreti: solo id, motivo e timestamp.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { vlCellBaseDir } = require('./managed.js');
const { safePrivateDir } = require('./credentials.js');

const CLAIM_VERSION = 1;

// Motivi bounded restituiti (stessi slug di VL_SKIP_REASONS in
// prompt-delivery.js: un solo vocabolario per launcher, supervisore e report).
const REASONS = Object.freeze(['fresh-host', 'rotated-session', 'host-pre-existing', 'claim-taken', 'claim-unavailable']);

function assertSafeCellId(cellId) {
  const id = typeof cellId === 'string' ? cellId : '';
  if (!id || id === '.' || id === '..' || id.includes('/') || /[\x00-\x1f\x7f]/.test(id)) {
    throw new Error('unsafe vl cell id');
  }
  return id;
}

// Directory privata NC accanto alla root della cella. La catena si qualifica
// in ORDINE (safePrivateDir crea solo la foglia): stessa disciplina di
// ensureVlCellDirs/writeVlCellPrompt.
function claimDir(home, ownerInstanceId, cellId) {
  const id = assertSafeCellId(cellId);
  const nexus = path.join(home, '.nexuscrew');
  const cells = path.join(nexus, 'vl-cells');
  const base = vlCellBaseDir(home, ownerInstanceId, id);
  safePrivateDir(nexus, { create: true });
  safePrivateDir(cells, { create: true });
  safePrivateDir(base, { create: true });
  const dir = path.join(base, 'nc');
  safePrivateDir(dir, { create: true });
  return dir;
}

function claimPathFor(dir, proof, rotationKey) {
  if (proof === 'fresh-host') return path.join(dir, 'bootstrap-host.json');
  const h = crypto.createHash('sha256').update(String(rotationKey || '')).digest('hex').slice(0, 16);
  return path.join(dir, `bootstrap-session-${h}.json`);
}

// decideVlBootstrap({...}) -> { eligible, reason, claimPath }
//   rotation: { applied, key } | null — applied true SOLO se il marcatore
//   persistente è stato consumato da QUESTO lancio; key è l'identità della
//   rotazione (requestedAt/consumedAt del record .consumed).
// Pura decisione + acquisizione atomica: si chiama UNA volta per lancio, nel
// preflight, con la root claim in mano. Fail-closed: ogni dubbio è skip.
function decideVlBootstrap({
  home, ownerInstanceId, cellId, hostRoot, rotation, launchId, now = Date.now(),
} = {}) {
  const id = assertSafeCellId(cellId);
  let proof = null;
  let rotationKey = '';
  if (rotation && rotation.applied === true && rotation.key) {
    proof = 'rotated-session';
    rotationKey = String(rotation.key);
  } else {
    // fresh-host: la root NON deve esistere (lstat, mai stat: un symlink alla
    // root non è «assenza» e non è una prova che creiamo noi l'host).
    let st = null;
    try {
      st = fs.lstatSync(String(hostRoot || ''));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return { eligible: false, reason: 'claim-unavailable' };
      st = null;
    }
    if (st) return { eligible: false, reason: 'host-pre-existing' };
    proof = 'fresh-host';
  }
  const record = {
    version: CLAIM_VERSION,
    cell: id,
    launchId: String(launchId || ''),
    proof,
    claimedAt: now,
    state: 'pending',
  };
  let dir;
  try {
    dir = claimDir(home, ownerInstanceId, id);
  } catch (_) {
    return { eligible: false, reason: 'claim-unavailable' };
  }
  const target = claimPathFor(dir, proof, rotationKey);
  let fd;
  try {
    // O_EXCL: l'unico creatore vince. La claim è atomica E durevole prima del
    // paste (fsync del file + della directory, best-effort sull'ultima).
    fd = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try {
      const dfd = fs.openSync(dir, 'r');
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch (_) { /* best-effort: il file è già durabile */ }
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    if (e && e.code === 'EEXIST') return { eligible: false, reason: 'claim-taken', claimPath: target };
    return { eligible: false, reason: 'claim-unavailable' };
  }
  return { eligible: true, reason: proof, claimPath: target };
}

// Lettura read-only (diagnostica): il record claim, senza creare nulla.
function readVlBootstrapClaim({ home, ownerInstanceId, cellId, proof = 'fresh-host', rotationKey = '' } = {}) {
  const id = assertSafeCellId(cellId);
  let record = null;
  try {
    const dir = path.join(vlCellBaseDir(home, ownerInstanceId, id), 'nc');
    record = JSON.parse(fs.readFileSync(claimPathFor(dir, proof, rotationKey), 'utf8'));
  } catch (_) {
    return null;
  }
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
}

module.exports = { decideVlBootstrap, readVlBootstrapClaim, claimDir, REASONS };
