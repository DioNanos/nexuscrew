'use strict';
// Fixture del catalogo lease per i test HTTP delle route /api/lease.
//
// Non e' una lista inventata: e' un fleet.json REALE scritto con atomicWrite
// (quindi validato dal parser di produzione) e rilettro a ogni chiamata con
// loadDefinitions + la stessa proiezione stretta del provider
// (runtime.leaseCellSnapshot). Chi usa questo helper esercita il contratto
// della lettura stretta — catalogo rimosso, illeggibile o invalido qui sono
// realmente tali, non simulati con un flag.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../../lib/fleet/definitions.js');

// Proiezione del catalogo per il lease: solo id e sessione effettiva, con
// esito esplicito. E' la stessa proiezione che il provider espone con la
// lettura stretta (definitions -> {cells:[{id,tmuxSession}]}).
function leaseSnapshot(defs) {
  if (!defs || !Array.isArray(defs.cells)) {
    return { ok: false, code: 'LEASE_CATALOG_UNAVAILABLE' };
  }
  return {
    ok: true,
    cells: Object.freeze(defs.cells.map((c) => Object.freeze({ id: c.id, tmuxSession: c.tmuxSession }))),
  };
}

const ENGINE = Object.freeze({
  id: 'claude', command: '/usr/bin/true', args: [],
  promptMode: 'flag', promptFlag: '--append',
});

function catalogDoc(cells) {
  return {
    schemaVersion: 1,
    engines: [ENGINE],
    cells: cells.map((c) => ({ cwd: '/tmp', engine: 'claude', ...c })),
  };
}

// Scrive un catalogo VALIDATO (atomicWrite rifiuta documenti invalidi) e
// ritorna la funzione leaseCellCatalog con la stessa semantica del provider:
// lettura+parse ADESSO, esito esplicito, nessuna cache.
function catalogFixture(cells) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lease-catalog-'));
  const defsPath = path.join(dir, 'fleet.json');
  atomicWrite(defsPath, catalogDoc(cells));
  return {
    dir,
    defsPath,
    leaseCellCatalog: () => leaseSnapshot(loadDefinitions(defsPath)),
    // Riscrive il catalogo (sempre validato): rename/rimozione di celle senza
    // restart del server.
    rewrite(nextCells) { atomicWrite(defsPath, catalogDoc(nextCells)); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { ENGINE, catalogDoc, catalogFixture };
