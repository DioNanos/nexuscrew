'use strict';
// R29 — `nexuscrew <sottocomando> --help` deve stampare un help ed uscire,
// MAI eseguire il sottocomando. Scoperto sul campo: `nexuscrew init --help`
// digitato «per leggere la sintassi» rigenerava i plist, riavviava il
// servizio e stampava in chiaro l'URL autenticato del pannello.
//
// Il controllo è negativo per costruzione: questi test sono nati ROSSI sul
// codice che eseguiva (verificato runInitImpl chiamato), poi diventati verdi
// col fix nel punto unico del parsing. I sottocomandi con effetti sono
// verificati tramite i seam iniettabili (runInitImpl, restartImpl), non
// guardando l'output.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch, HELP, NODES_HELP } = require('../lib/cli/commands.js');

// Marcatori distintivi dei due help esistenti (HELP generale, NODES_HELP).
const HELP_MARK = 'PWA for local and remote AI workers';
const NODES_MARK = 'headless peer management';

test('init --help non esegue init: runInitImpl non chiamato, help, exit 0', async () => {
  const calls = [];
  const lines = [];
  const r = await dispatch(['init', '--help'], {
    log: (m) => lines.push(m),
    runInitImpl: () => { calls.push('init'); return { actions: [] }; },
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 0, 'init --help non deve eseguire runInit');
  assert.ok(lines.join('\n').includes(HELP_MARK), 'deve stampare l\'help generale');
});

test('init -h (forma breve dopo il sottocomando) non esegue init', async () => {
  const calls = [];
  const lines = [];
  const r = await dispatch(['init', '-h'], {
    log: (m) => lines.push(m),
    runInitImpl: () => { calls.push('init'); return { actions: [] }; },
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 0, 'init -h non deve eseguire runInit');
  assert.ok(lines.join('\n').includes(HELP_MARK), 'deve stampare l\'help generale');
});

test('restart --help non riavvia: restartImpl non chiamato', async () => {
  const calls = [];
  const lines = [];
  const r = await dispatch(['restart', '--help'], {
    log: (m) => lines.push(m),
    restartImpl: () => { calls.push('restart'); return { restarted: true, boot: true }; },
  });
  assert.equal(r.code, 0);
  assert.equal(calls.length, 0, 'restart --help non deve riavviare il servizio');
  assert.ok(lines.join('\n').includes(HELP_MARK), 'deve stampare l\'help generale');
});

test('version --help stampa l\'help, non la versione', async () => {
  const lines = [];
  const r = await dispatch(['version', '--help'], { log: (m) => lines.push(m) });
  assert.equal(r.code, 0);
  assert.ok(lines.join('\n').includes(HELP_MARK), 'deve stampare l\'help generale');
  assert.ok(!lines.join('\n').includes(require('../package.json').version),
    'non deve eseguire il sottocomando version');
});

test('nodes --help stampa NODES_HELP, non la lista dei nodi', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-r29-nodes-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const lines = [];
  const r = await dispatch(['nodes', '--help'], { home, log: (m) => lines.push(m) });
  assert.equal(r.code, 0);
  const out = lines.join('\n');
  assert.ok(out.includes(NODES_MARK), 'deve stampare l\'help dedicato di nodes');
  assert.ok(!out.includes('(nessun nodo)'), 'non deve eseguire nodes list');
});
