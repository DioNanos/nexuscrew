'use strict';
// Il cambio di comportamento sulla porta occupata (il nodo non si sposta piu' da solo) deve dire all'utente cosa fare,
// in italiano, inglese e spagnolo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const messages = require('../lib/cli/messages.js');
const { smartUp } = require('../lib/cli/commands.js');
const { start } = require('../lib/server.js');

const KEYS = ['busy-other', 'busy-token', 'busy-own-slow', 'busy-paired'];
const LANGS = ['it', 'en', 'es'];
const PORT_WORD = { it: /porta 41820/i, en: /port 41820/i, es: /puerto 41820/i };
const FREE_WORD = { it: /libera/i, en: /free/i, es: /libera/i };

test('ogni messaggio esiste in it/en/es, nomina la porta ed e\' nella lingua giusta', () => {
  for (const key of KEYS) for (const lang of LANGS) {
    const text = messages.portMessage(key, { port: 41820 }, { lang });
    assert.match(text, PORT_WORD[lang], `${key}/${lang}: nomina la porta nella sua lingua`);
    assert.ok(!/\{port\}/.test(text), `${key}/${lang}: nessun segnaposto rimasto`);
  }
});

test('i messaggi che richiedono un\'azione dicono cosa fare: liberare la porta o scegliere --port', () => {
  for (const lang of LANGS) {
    for (const key of ['busy-other', 'busy-paired']) {
      const text = messages.portMessage(key, { port: 41820 }, { lang });
      assert.match(text, FREE_WORD[lang], `${key}/${lang}: dice di liberare la porta`);
      assert.match(text, /nexuscrew init --port <N>/, `${key}/${lang}: indica il comando esatto per scegliere un'altra porta`);
    }
    assert.match(messages.portMessage('busy-token', { port: 41820 }, { lang }), /~\/\.nexuscrew\/token/);
    assert.match(messages.portMessage('busy-own-slow', { port: 41820 }, { lang }), /nexuscrew (show|logs)/);
  }
});

test('la lingua si sceglie da NEXUSCREW_LANG, LC_ALL, LC_MESSAGES, LANG (in quest\'ordine); sconosciuta = tutte e tre', () => {
  assert.equal(messages.pickLang({ LANG: 'it_IT.UTF-8' }), 'it');
  assert.equal(messages.pickLang({ LANG: 'es_ES.UTF-8' }), 'es');
  assert.equal(messages.pickLang({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(messages.pickLang({ LANG: 'it_IT.UTF-8', LC_ALL: 'es_ES.UTF-8' }), 'es');
  assert.equal(messages.pickLang({ LANG: 'it_IT.UTF-8', NEXUSCREW_LANG: 'en' }), 'en');
  assert.equal(messages.pickLang({ LANG: 'C.UTF-8' }), 'all');
  assert.equal(messages.pickLang({}), 'all');
  assert.equal(messages.pickLang({ LANG: 'fr_FR.UTF-8' }), 'all');
});

test('lingua non determinabile (servizio senza LANG): il messaggio porta tutte e tre le lingue, cosi\' si legge comunque', () => {
  const text = messages.portMessage('busy-other', { port: 41820 }, { lang: 'all' });
  for (const lang of LANGS) assert.match(text, PORT_WORD[lang]);
  assert.equal(text.split('\n').length, 3);
});

// ---- integrazione: i due punti che emettono l'errore usano il catalogo -------------------------------------------

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const occupy = (port) => new Promise((resolve) => { const s = net.createServer((c) => c.on('error', () => {})); s.listen(port, '127.0.0.1', () => resolve(s)); });

test('nexuscrew show con la porta occupata da un altro processo: errore nella lingua scelta, con l\'azione', async (t) => {
  for (const lang of LANGS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nexuscrew', 'config.json'), JSON.stringify({ port: 41820 }));
    fs.writeFileSync(path.join(dir, '.nexuscrew', 'token'), 'tok\n', { mode: 0o600 });
    await assert.rejects(smartUp({
      home: dir, configDir: path.join(dir, '.nexuscrew'), configPath: path.join(dir, '.nexuscrew', 'config.json'), tokenPath: path.join(dir, '.nexuscrew', 'token'),
      platform: 'linux', execImpl: () => '', ensureFleetDefaultsImpl: () => ({ created: false }), runInitImpl: () => {}, noOpen: true, waitAttempts: 1,
      portAvailableImpl: async () => false, probeImpl: async () => false, probeStatusImpl: async () => null, port: 41820, lang,
    }), (e) => PORT_WORD[lang].test(e.message) && FREE_WORD[lang].test(e.message) && /nexuscrew init --port <N>/.test(e.message));
  }
});

test('il nodo (start) con la porta occupata: onListenError riceve il messaggio nella lingua scelta', async (t) => {
  for (const lang of LANGS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const port = await freePort(); const blocker = await occupy(port); t.after(() => blocker.close());
    const error = await new Promise((resolve) => {
      const s = start({ home: dir, configDir: dir, configPath: path.join(dir, 'config.json'), tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
        port, panelPort: 0, fleetEnabled: false, autoUpdate: false, log: () => {}, ownPortWaitMs: 0, lang, onListenError: resolve });
      t.after(() => { try { s.close(); } catch (_) { /* non in ascolto */ } });
    });
    assert.equal(error.code, 'EADDRINUSE');
    assert.match(error.message, new RegExp(`(porta|port|puerto) ${port}`, 'i'));
    assert.match(error.message, FREE_WORD[lang]);
    assert.match(error.message, /nexuscrew init --port <N>/);
  }
});
