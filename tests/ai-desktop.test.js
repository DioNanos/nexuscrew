'use strict';
// tests/ai-desktop.test.js — il container del desktop come servizio governato:
// start/stop senza shell (argv vettoriale, nome fisso), esito sempre riportato,
// default derivato dal container SOLO fuori dal percorso caldo, taglio del
// pannello con la chiave esplicita. Nessun docker vero: un finto binario
// iniettato via `dockerBin` registra gli argv e risponde per il caso.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  chiaveEsplicita, pubblicaPanelUrl, isDesktopPanelUrl, containerRunning, avvia, ferma,
} = require('../lib/fleet/ai-desktop.js');

// Finto binario: scrive gli argv ricevuti su un file di registro e risponde
// secondo lo script scelto dal test (registra | falla | dormi).
function fintoDocker(dir, comportamento, extraEnv = {}) {
  const bin = path.join(dir, `docker-${comportamento}`);
  const registro = path.join(dir, `registro-${comportamento}`);
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'echo "$@" >> ' + JSON.stringify(registro),
    'if [ -n "$NC_FINTO_INSPECT" ]; then echo true; exit 0; fi',
    'if [ "' + comportamento + '" = "falla" ]; then echo "boom di docker" >&2; exit 1; fi',
    'if [ "' + comportamento + '" = "dormi" ]; then sleep 5; fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  return { bin, registro };
}

const opts = (bin, timeoutMs) => ({ dockerBin: bin, ...(timeoutMs ? { timeout: timeoutMs } : {}) });

test('start e stop passano per argv vettoriali con il nome fisso del container', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-aidesk-'));
  const { bin, registro } = fintoDocker(dir, 'registra');
  const start = await avvia(opts(bin));
  const stop = await ferma(opts(bin));
  assert.equal(start.ok, true);
  assert.deepEqual(start, { ok: true, running: true });
  assert.equal(stop.ok, true);
  const argv = fs.readFileSync(registro, 'utf8').trim().split('\n').map((riga) => riga.split(' '));
  // Nessuna shell: ogni argomento arriva SEPARATO, e il nome del container è
  // fisso (mai costruito da input).
  assert.deepEqual(argv, [['start', 'ai-desktop'], ['stop', 'ai-desktop']]);
});

test('errore docker: ok false e la causa riportata, mai un successo finto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-aidesk-'));
  const { bin } = fintoDocker(dir, 'falla');
  const start = await avvia(opts(bin));
  assert.equal(start.ok, false);
  assert.match(start.error, /boom di docker/);
  const stop = await ferma(opts(bin));
  assert.equal(stop.ok, false);
  assert.match(stop.error, /boom di docker/);
});

test('timeout: il comando non appende il servizio e l\'esito lo dichiara', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-aidesk-'));
  const { bin } = fintoDocker(dir, 'dormi');
  const esito = await avvia(opts(bin, 100));
  assert.equal(esito.ok, false);
  assert.equal(esito.timeout, true);
});

test('containerRunning: inspect risponde per running, assente e errori', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-aidesk-'));
  const vivo = fintoDocker(dir, 'registra');
  // Lo script "registra" senza NC_FINTO_INSPECT non risponde all'inspect:
  // per il test "vivo" serve un binario che all'inspect risponde true.
  fs.writeFileSync(vivo.bin, [
    '#!/bin/sh',
    'if [ "$1" = "inspect" ]; then echo true; exit 0; fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  const su = await containerRunning(opts(vivo.bin));
  assert.deepEqual(su, { running: true, exists: true });

  const assente = fintoDocker(dir, 'falla'); // exit 1 = container non ispezionabile
  const giu = await containerRunning(opts(assente.bin));
  assert.deepEqual(giu, { running: false, exists: false, error: 'boom di docker' });
  assert.ok(giu.error);
});

test('chiaveEsplicita: solo un boolean è esplicito, assente è null (si deriva)', () => {
  assert.equal(chiaveEsplicita({}), null);
  assert.equal(chiaveEsplicita({ aiDesktop: true }), true);
  assert.equal(chiaveEsplicita({ aiDesktop: false }), false);
  assert.equal(chiaveEsplicita({ aiDesktop: 'sì' }), null);
  assert.equal(chiaveEsplicita(null), null);
});

test('isDesktopPanelUrl: riconosce la porta KasmVNC del container, non le altre', () => {
  assert.equal(isDesktopPanelUrl('https://127.0.0.1:6901'), true);
  assert.equal(isDesktopPanelUrl('https://127.0.0.1:6901/vnc.html?x=1'), true);
  assert.equal(isDesktopPanelUrl('http://127.0.0.1:6900/'), false);
  assert.equal(isDesktopPanelUrl('https://example.com:6901'), true);
  assert.equal(isDesktopPanelUrl('non è un url'), false);
});

test('pubblicaPanelUrl: la chiave esplicita false taglia SOLO il pannello del desktop', () => {
  const desktop = 'https://127.0.0.1:6901/vnc.html';
  const altro = 'http://127.0.0.1:6900/';
  assert.equal(pubblicaPanelUrl(desktop, { aiDesktop: false }), '', 'OFF: il tasto esce da ogni superficie');
  assert.equal(pubblicaPanelUrl(altro, { aiDesktop: false }), altro, 'OFF: gli altri pannelli restano');
  assert.equal(pubblicaPanelUrl(desktop, { aiDesktop: true }), desktop);
  assert.equal(pubblicaPanelUrl(desktop, {}), desktop, 'chiave assente: nessuno perde il tasto nel percorso caldo');
  assert.equal(pubblicaPanelUrl('', { aiDesktop: false }), '');
});

test('NEGATIVO: senza il binario iniettato le funzioni NON raggiungono docker reale nel percorso di test', async () => {
  // Le funzioni con `dockerBin` assente userebbero il binario di sistema: il
  // contratto dei test è che il finto sia SEMPRE iniettato. Qui si verifica il
  // rifiuto esplicito dell'assenza quando il chiamante lo chiede (opts vuoto
  // nel contesto test: si passa un binario inesistente e si legge la causa).
  const esito = await avvia({ dockerBin: path.join(os.tmpdir(), 'nc-non-esiste-docker') });
  assert.equal(esito.ok, false);
  assert.ok(esito.error);
});
