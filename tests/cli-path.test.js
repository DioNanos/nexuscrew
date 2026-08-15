'use strict';

// Correzione (audit, stessa forma di tests/helpers/pi-real-consumer.js, qui
// nel codice di PRODOTTO): executable()/commandExists() collassavano ogni
// eccezione a `false`. ENOENT ("il path non c'e' qui", legittimo: continua a
// cercare sul resto del PATH) ed EACCES/ELOOP/ENOTDIR ("non sono riuscito a
// verificare") producevano lo stesso esito — indistinguibile da un chiamante
// che deve dire all'utente "non installato" (falso, se il binario era li' ma
// irraggiungibile) invece di "non ho potuto verificare".
//
// Misura: una directory nel PATH senza il bit x (0o600) contenente un
// binario con i permessi giusti. statSync su un file al suo interno fallisce
// con EACCES (la directory non e' attraversabile), non ENOENT — il binario
// C'E' con i permessi giusti, solo la directory che lo contiene e'
// irraggiungibile.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandExists, resolveCommand } = require('../lib/cli/path.js');

function withBlockedDir(binName, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-path-blocked-'));
  const blockedDir = path.join(root, 'blocked');
  fs.mkdirSync(blockedDir);
  const bin = path.join(blockedDir, binName);
  fs.writeFileSync(bin, '#!/bin/sh\necho fake\n');
  fs.chmodSync(bin, 0o755);
  fs.chmodSync(blockedDir, 0o600); // niente bit x: dir non attraversabile
  try {
    return fn({ root, blockedDir, bin });
  } finally {
    fs.chmodSync(blockedDir, 0o755); // altrimenti rmSync stesso non entra
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('MISURA: statSync su un file dentro una directory non attraversabile fallisce con EACCES, non ENOENT', () => {
  if (process.getuid && process.getuid() === 0) return; // root bypassa i permessi sulla dir
  withBlockedDir('probe-bin', ({ bin }) => {
    let err = null;
    try { fs.statSync(bin); } catch (e) { err = e; }
    assert.ok(err, 'statSync deve fallire: la directory non e\' attraversabile');
    assert.equal(err.code, 'EACCES', 'il binario ESISTE con permessi giusti — l\'errore e\' EACCES, non ENOENT');
  });
});

test('resolveCommand: directory PATH non attraversabile con il binario dentro -> found:false, blocked NOMINA la dir (mai un "non trovato" silenzioso)', () => {
  if (process.getuid && process.getuid() === 0) return;
  withBlockedDir('nc-fake-tool', ({ blockedDir, bin }) => {
    const r = resolveCommand('nc-fake-tool', { PATH: blockedDir });
    assert.equal(r.found, false);
    assert.equal(r.blocked.length, 1, 'la dir bloccata deve comparire in blocked, non sparire in un "non trovato" muto');
    assert.equal(r.blocked[0].code, 'EACCES');
    assert.equal(r.blocked[0].path, bin);
  });
});

test('resolveCommand: ENOENT genuino (nessun file in nessuna dir del PATH) -> found:false, blocked VUOTO', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-path-empty-'));
  try {
    const r = resolveCommand('nc-tool-che-non-esiste-davvero', { PATH: root });
    assert.equal(r.found, false);
    assert.deepEqual(r.blocked, [], 'un\'assenza genuina non deve produrre alcun blocked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolveCommand: il binario e\' raggiungibile in una dir SUCCESSIVA a quella bloccata -> found:true, blocked comunque riportata', () => {
  if (process.getuid && process.getuid() === 0) return;
  withBlockedDir('nc-fake-tool2', ({ blockedDir }) => {
    const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-path-ok-'));
    const okBin = path.join(okDir, 'nc-fake-tool2');
    fs.writeFileSync(okBin, '#!/bin/sh\necho ok\n');
    fs.chmodSync(okBin, 0o755);
    try {
      const PATH = [blockedDir, okDir].join(path.delimiter);
      const r = resolveCommand('nc-fake-tool2', { PATH });
      assert.equal(r.found, true, 'una directory bloccata prima non deve impedire di trovare il binario altrove sul PATH');
      assert.equal(r.path, okBin);
      assert.equal(r.blocked.length, 1, 'ma il tentativo fallito va comunque riportato: un chiamante potrebbe volerlo sapere');
    } finally { fs.rmSync(okDir, { recursive: true, force: true }); }
  });
});

test('commandExists: invariato per il caso comune (found/absent), nessuna rottura di retrocompatibilita\'', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-path-compat-'));
  try {
    const bin = path.join(root, 'real-tool');
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    assert.equal(commandExists('real-tool', { PATH: root }), true);
    assert.equal(commandExists('tool-inesistente', { PATH: root }), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

