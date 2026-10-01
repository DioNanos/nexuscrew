'use strict';
// tests/persist-fd-leak.test.js — regressione FD leak in openSecured.
// lib/notify/persist.js:openSecured apre l'fd con openSync, poi le guardie
// (fstat, tipo non regolare, owner inatteso, permessi larghi) possono lanciare
// SENZA chiuderlo. I finally dei reader (readJsonSafe/readJsonStrict) non lo
// vedono: openSecured e' lanciata prima dell'assegnazione del loro `fd`, quindi
// l'fd aperto resta appeso. Un file 0644 (p.es. un asks.json ripristinato da
// un backup senz'0600) rifiuta sulla guardia dei permessi a ogni lettura: con
// 20 rifiuti di fila sono 20 fd persi, e la via e' percorsa anche da
// readJsonSafe (usato da push.js e live-host/store.js).
// Contratto del fix: dentro openSecured, try/catch dopo openSync che chiude
// l'fd su ogni errore e rilancia. Qui si misurano gli fd prima/dopo 50 rifiuti
// per mode 0644 su entrambi i reader: differenza 0.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonSafe, readJsonStrict } = require('../lib/notify/persist.js');

// /proc/self/fd e' Linux-only: salta dove non esiste.
function fdCount() {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch (_) {
    return null;
  }
}

function makeRefusingFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpersist-fd-'));
  const file = path.join(dir, 'asks.json');
  // Contenuto valido: la parse andrebbe a buon fine, ma la guardia dei
  // permessi rifiuta PRIMA della read. Cosi' si esercita esattamente la via
  // del leak (open + fstat + isFile + owner OK + mode FAIL).
  fs.writeFileSync(file, '{"asks":[]}\n', { mode: 0o600 });
  fs.chmodSync(file, 0o644); // group/other read => rifiuto sulla guardia mode
  return { dir, file };
}

test('FD leak: readJsonStrict su file 0644 non lascia fd aperti (50 rifiuti, differenza 0)', () => {
  if (fdCount() === null) { /* skip silente: /proc assente */ return; }
  const { dir, file } = makeRefusingFile();
  try {
    // Ogni chiamata rifiuta sulla guardia mode (store-unreadable-side), ma NON
    // deve mai aprire un fd senza richiuderlo.
    const before = fdCount();
    for (let i = 0; i < 50; i++) {
      // readJsonStrict propaga il rifiuto mode come eccezione (non ENOENT/ELOOP):
      // la via del leak e' la STESSA di readJsonSafe, e l'fd aperto deve essere
      // chiuso prima del rilancio.
      assert.throws(() => readJsonStrict(file), /permessi troppo larghi/, `iter ${i}: rifiuto mode`);
    }
    const after = fdCount();
    assert.equal(after, before, `50 rifiuti readJsonStrict: fd ${before} -> ${after} (leak di ${after - before})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FD leak: readJsonSafe su file 0644 non lascia fd aperti (50 rifiuti, differenza 0)', () => {
  if (fdCount() === null) { /* skip silente: /proc assente */ return; }
  const { dir, file } = makeRefusingFile();
  try {
    const before = fdCount();
    for (let i = 0; i < 50; i++) {
      // readJsonSafe propaga il rifiuto mode come eccezione (non ENOENT/ELOOP):
      // la via del leak e' la STESSA di readJsonStrict.
      assert.throws(() => readJsonSafe(file), /permessi troppo larghi/);
    }
    const after = fdCount();
    assert.equal(after, before, `50 rifiuti readJsonSafe: fd ${before} -> ${after} (leak di ${after - before})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Un file 0600 leggibile non deve mai leakare: il percorso felice chiude nel
// finally dei reader, ma lo esercitiamo per regressione.
test('FD leak: readJsonStrict su file 0600 leggibile non lascia fd aperti (50 letture, differenza 0)', () => {
  if (fdCount() === null) { /* skip silente: /proc assente */ return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpersist-fd-ok-'));
  const file = path.join(dir, 'asks.json');
  try {
    fs.writeFileSync(file, '{"asks":[{"id":"a","question":"x"}]}\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const before = fdCount();
    for (let i = 0; i < 50; i++) {
      const r = readJsonStrict(file);
      assert.equal(r.state, 'ok');
    }
    const after = fdCount();
    assert.equal(after, before, `50 letture readJsonStrict ok: fd ${before} -> ${after} (leak di ${after - before})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});