'use strict';
// tests/snapshot-single-door.test.js — sorveglianza STATICA della porta
// unica: lo snapshot di un owner si chiede SOLO attraverso il feed client
// (ownerSnapshotAsks). Una seconda porta — anche costruita per
// concatenazione o template — sgancia l'invariante della finestra minima:
// il gate del client non vede le richieste che non passano da lui.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOOR = 'lib/notify/event-feed-client.js';
// L'endpoint dell'owner che SERVE lo snapshot e le ACL del proxy nominano la
// rotta senza mai chiamarla: eccenze dichiarate, non Vie.
const SERVING = ['lib/notify/event-feed-routes.js'];
const ACL = ['lib/proxy/federation.js', 'lib/proxy/resource-acl.js'];

// files: { 'lib/<percorso>': contenuto } — restituisce i difetti trovati.
function checkDoors(files) {
  const errors = [];
  for (const [rel, content] of Object.entries(files)) {
    const isDoor = rel === DOOR;
    const hasUrlLiteral = content.includes('event-feed/snapshot');
    // (a) l'URL letterale fuori dalla porta e dalle superfici che lo servono
    if (hasUrlLiteral && !isDoor && !ACL.includes(rel) && !SERVING.includes(rel)) {
      errors.push(`${rel}: URL letterale dello snapshot fuori dalla porta`);
    }
    // (b) costruzione per concatenazione/template: il segmento e la parola
    // come LETTERALI di riga singola nello stesso file, anche se l'URL
    // completo non compare. Le classi escludono il newline: un 'snapshot'
    // dentro un commento multiriga non è una costruzione.
    const quotedEventFeed = /(['"`])[^'"`\n]*event-feed[^'"`\n]*\1/.test(content);
    const quotedSnapshot = /(['"`])[^'"`\n]*snapshot[^'"`\n]*\1/.test(content);
    if (!isDoor && quotedEventFeed && quotedSnapshot
      && !ACL.includes(rel) && !SERVING.includes(rel)) {
      errors.push(`${rel}: costruzione di event-feed + snapshot fuori dalla porta`);
    }
    // (c) fetch dell'URL fuori dalla porta (stessa riga o adiacente).
    if (!isDoor) {
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('event-feed/snapshot')) return;
        const ctx = [lines[i - 1], line, lines[i + 1]].filter(Boolean).join('\n');
        if (/\bfetch\s*\(/.test(ctx)) errors.push(`${rel}:${i + 1}: fetch diretta dello snapshot`);
      });
    }
  }
  return errors;
}

function libFiles() {
  const LIB = path.join(__dirname, '..', 'lib');
  const out = {};
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && e.name.endsWith('.js')) out[`lib/${r}`] = fs.readFileSync(p, 'utf8');
    }
  })(LIB, '');
  return out;
}

test('statico: una sola porta verso lo snapshot in lib/ reale', () => {
  const errors = checkDoors(libFiles());
  assert.deepEqual(errors, [], `porte extra o fetch dirette: ${errors.join('; ')}`);
});

test('statico: server.js passa dalla porta (ownerSnapshotAsks), senza URL propri', () => {
  const files = libFiles();
  assert.ok((files['lib/server.js'] || '').includes('ownerSnapshotAsks'), 'reconcile asks through the single door');
  assert.ok(!(files['lib/server.js'] || '').includes('event-feed/snapshot'), 'no snapshot URL in server.js');
});

test('statico NEGATIVO: una seconda porta per concatenazione diventa rossa', () => {
  const files = libFiles();
  files['lib/notify/seconda-porta.js'] = [
    "'use strict';",
    "// Una seconda porta costruita per concatenazione: il check deve vederla",
    "// anche senza l'URL completo da nessuna parte.",
    'async function rubaSnapshot(fetchImpl, port, headers) {',
    "  const url = '/event-feed' + '/snapshot';",
    '  const r = await fetchImpl(`http://127.0.0.1:${port}/federation/route/_/${url.slice(1)}`, { headers });',
    '  return r.json();',
    '}',
    'module.exports = { rubaSnapshot };',
  ].join('\n');
  const errors = checkDoors(files);
  assert.ok(errors.some((e) => e.startsWith('lib/notify/seconda-porta.js')),
    `the concatenated second door must be flagged: ${errors.join('; ')}`);
});

test('statico NEGATIVO: una fetch diretta adiacente all\'URL diventa rossa', () => {
  const files = libFiles();
  files['lib/notify/porta-bis.js'] = [
    "'use strict';",
    'const URL = "event-feed/snapshot";',
    'async function prendi(fetchImpl, peer) {',
    '  return fetch(URL);',
    '}',
    'module.exports = { prendi };',
  ].join('\n');
  const errors = checkDoors(files);
  assert.ok(errors.some((e) => e.startsWith('lib/notify/porta-bis.js')),
    `the adjacent-fetch second door must be flagged: ${errors.join('; ')}`);
});

test('statico NEGATIVO: la porta vera non è segnalata', () => {
  const errors = checkDoors(libFiles());
  assert.ok(!errors.some((e) => e.includes('event-feed-client.js')),
    `the door itself must stay clean: ${errors.join('; ')}`);
});
