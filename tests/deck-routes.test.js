'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdk-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const { server, watcher } = createServer({
    tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    tmuxBin: FAKE_TMUX, fleetEnabled: false,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}` });
  }));
}

// La SPA (index.html) e' servita senza token: il gate e' sul WS/API, non sull'HTML.
test('/deck/<name>: nomi validi servono la SPA (stesso index.html)', async (t) => {
  const { base } = await boot(t);
  const root = await fetch(`${base}/`);
  const rootHtml = await root.text();
  for (const name of ['main', 'a', 'work-1', 'a'.repeat(32), 'left-monitor', 'x0y9z']) {
    const r = await fetch(`${base}/deck/${name}`);
    assert.equal(r.status, 200, `deck ${name} -> 200`);
    assert.match(r.headers.get('content-type') || '', /text\/html/, `deck ${name} html`);
    assert.equal(await r.text(), rootHtml, `deck ${name} = stessa SPA`);
  }
});

test('/deck/<ownerId>/<name>: owner stabile serve la stessa SPA', async (t) => {
  const { base } = await boot(t);
  const owner = 'a'.repeat(32);
  const rootHtml = await fetch(`${base}/`).then((r) => r.text());
  const r = await fetch(`${base}/deck/${owner}/work-1`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), rootHtml);
  for (const bad of [`${'A'.repeat(32)}/work-1`, `${'a'.repeat(15)}/work-1`, `${owner}/Work`, `${owner}/work/extra`]) {
    assert.equal((await fetch(`${base}/deck/${bad}`)).status, 404, bad);
  }
});

test('/deck/<name>: nomi invalidi → 404 secco', async (t) => {
  const { base } = await boot(t);
  const bad = [
    'Main',            // maiuscole
    'a_b',             // underscore
    'a.b',             // punto
    'a'.repeat(33),    // troppo lungo
    'ab%20c',          // spazio (encoded)
    'up%2Fdown',       // slash encoded (traversal-like)
    'a/b',             // segmento extra (deve restare sotto /deck ma 404)
    'sess@1',          // simbolo
    '',                // vuoto (/deck/)
  ];
  for (const name of bad) {
    const r = await fetch(`${base}/deck/${name}`);
    assert.equal(r.status, 404, `deck "${name}" deve 404 (era ${r.status})`);
  }
});

// Il nome NON viene mai usato per costruire un path (si serve sempre lo stesso
// index.html costante): un nome traversal-like che raggiunge il server → 404,
// nessun file diverso dalla SPA può trapelare. Path escape strutturalmente
// impossibile; verifichiamo comunque il 404 sui casi che arrivano al server.
test('/deck/<name>: traversal-like nel nome → 404, nessun path escape', async (t) => {
  const { base } = await boot(t);
  for (const name of ['..%2f..%2fetc%2fpasswd', 'etc%2fpasswd', 'foo%00bar']) {
    const r = await fetch(`${base}/deck/${name}`);
    assert.equal(r.status, 404, `traversal-like "${name}" -> 404`);
  }
});

// Parita' col client: deckFromPath accetta UN trailing slash (/deck/main/ -> 'main'),
// il server deve rispondere 200 sullo stesso caso; slash multipli restano 404.
test('/deck/<name>/: un trailing slash → 200 (parita\' client), doppio → 404', async (t) => {
  const { base } = await boot(t);
  const ok = await fetch(`${base}/deck/main/`);
  assert.equal(ok.status, 200, '/deck/main/ deve servire la SPA');
  assert.match(ok.headers.get('content-type') || '', /text\/html/);
  const no = await fetch(`${base}/deck/main//`);
  assert.equal(no.status, 404, '/deck/main// deve restare 404');
});
