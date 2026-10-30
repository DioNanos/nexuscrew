'use strict';
// D-558 FIX2a (F3 / residuo R2, audit finale DevAuditor) — la catena dei
// parent della claim è durevole a OGNI acquisizione, non solo quando
// l'anello è appena stato creato. L'esistenza della directory da sola non
// attesta il fsync precedente: un tentativo incompleto (creazione riuscita,
// fsync del parent fallito) lascia la catena sul disco e il tentativo
// successivo deve comunque dimostrare la barriera di durabilità.
// Controprova dell'audit: EIO persistente su ogni fsync del parent HOME;
// primo launch → claim-unavailable; secondo launch → oggi eligible:true (il
// difetto), con la correzione di nuovo claim-unavailable.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideVlBootstrap, readVlBootstrapClaim } = require('../lib/fleet/vl-bootstrap-claim.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558f3-'));
}

// EIO selettivo sui fsync (stesso trucco della suite D-558): i descriptor
// vengono tracciati all'open, `colpa(path)` decide quali path falliscono.
// Conta anche i fsync RIUSCITI per path, così un test può pretendere che la
// barriera sia stata rifatta davvero (non solo dichiarata).
function injectFsyncFailure(t, colpa) {
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const fdPath = new Map();
  const riusciti = new Map();
  fs.openSync = function patched(...argv) {
    const fd = realOpen.apply(fs, argv);
    try { fdPath.set(fd, String(argv[0])); } catch (_) { /* fd non tracciato: passa */ }
    return fd;
  };
  fs.fsyncSync = function patched(fd) {
    const p = fdPath.get(fd) || '';
    if (colpa(p)) {
      const e = new Error('injected EIO');
      e.code = 'EIO';
      throw e;
    }
    const r = realFsync.call(fs, fd);
    riusciti.set(p, (riusciti.get(p) || 0) + 1);
    return r;
  };
  t.after(() => { fs.openSync = realOpen; fs.fsyncSync = realFsync; });
  return { riusciti };
}

test('F3: EIO PERSISTENTE sul fsync del parent HOME — OGNI launch è claim-unavailable', (t) => {
  const home = tmpHome();
  const base = { home, ownerInstanceId: 'local', cellId: 'C' };
  let attivo = true;
  const { riusciti } = injectFsyncFailure(t, (p) => attivo && p === home);
  // Primo tentativo: la catena non esiste, la creazione di .nexuscrew riesce
  // ma il fsync del parent HOME fallisce → fail-closed, nessun paste.
  const d1 = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(d1.eligible, false);
  assert.equal(d1.reason, 'claim-unavailable');
  // La directory è RESTATA sul disco (tentativo incompleto): un secondo
  // avvio la vede già esistente. L'esistenza non è prova di durabilità: con
  // lo stesso errore ancora attivo, anche questo launch è rifiutato.
  assert.ok(fs.statSync(path.join(home, '.nexuscrew')).isDirectory(), 'la catena incompleta resta sul disco');
  const d2 = decideVlBootstrap({ ...base, launchId: '2222222222222222' });
  assert.equal(d2.eligible, false, 'parent mai sincronizzato: l\'idoneità non si eredita');
  assert.equal(d2.reason, 'claim-unavailable');
  assert.equal(riusciti.get(home) || 0, 0, 'nessun fsync del parent è MAI riuscito');
});

test('F3: EIO TRANSITORIO sul parent HOME — il secondo launch è ammesso SOLO dopo un fsync riuscito', (t) => {
  const home = tmpHome();
  const base = { home, ownerInstanceId: 'local', cellId: 'C' };
  let attivo = true;
  const { riusciti } = injectFsyncFailure(t, (p) => attivo && p === home);
  const d1 = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(d1.eligible, false);
  assert.equal(d1.reason, 'claim-unavailable');
  // Recupero: l'errore sparisce. La riqualificazione passa da un fsync del
  // parent RIUSCITO durante il secondo tentativo.
  attivo = false;
  const d2 = decideVlBootstrap({ ...base, launchId: '2222222222222222' });
  assert.equal(d2.eligible, true, 'catena riqualificata dal fsync riuscito');
  assert.equal(d2.reason, 'launch');
  assert.ok((riusciti.get(home) || 0) >= 1, 'il parent HOME è stato sincronizzato davvero');
  const rec = readVlBootstrapClaim({ ...base, launchId: '2222222222222222' });
  assert.equal(rec.state, 'pending', 'la claim del secondo avvio è su disco');
});

test('F3: catena GIÀ SANA (materializzata fuori dalla claim) — nessuna regressione', (t) => {
  const home = tmpHome();
  const base = { home, ownerInstanceId: 'local', cellId: 'C' };
  // La catena esiste prima della decisione (come la lascerebbe il resolver
  // managed o un avvio precedente): senza fault i fsync di ogni anello e del
  // parent riescono e l'acquisizione resta idonea.
  fs.mkdirSync(path.join(vlCellBaseDir(home, 'local', 'C'), 'nc'), { recursive: true, mode: 0o700 });
  const d = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(d.eligible, true);
  assert.equal(d.reason, 'launch');
  // stesso avvio ripassato: la claim vinta con O_EXCL non si riassegna
  const again = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(again.reason, 'claim-taken');
});
