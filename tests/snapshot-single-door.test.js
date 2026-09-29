'use strict';
// tests/snapshot-single-door.test.js — sorveglianza STATICA della porta
// unica: lo snapshot di un owner si chiede SOLO attraverso il feed client
// (ownerSnapshotAsks), che è l'unico punto del processo che chiama
// /event-feed/snapshot. Una seconda porta (fetch diretta) sgancerebbe
// l'invariante della finestra minima: il gate del client non vede le
// richieste che non passano da lui.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('statico: una sola porta verso /event-feed/snapshot in lib/', () => {
  const SNAPSHOT_URL = 'event-feed/snapshot';
  // File ammessi a CONTENERE la stringa: la porta (il client) e le due
  // superfici del proxy che la nominano per le ACL, senza mai chiamarla.
  const allowed = new Set([
    path.join(LIB, 'notify', 'event-feed-client.js'),
    path.join(LIB, 'proxy', 'federation.js'),
    path.join(LIB, 'proxy', 'resource-acl.js'),
  ]);
  const offenders = walk(LIB)
    .filter((f) => fs.readFileSync(f, 'utf8').includes(SNAPSHOT_URL))
    .filter((f) => !allowed.has(f));
  assert.deepEqual(offenders, [], `moduli che nominano lo snapshot fuori dalla porta: ${offenders.join(', ')}`);
});

test('statico: nessuna fetch dello snapshot fuori dalla porta (stessa riga o adiacente)', () => {
  const offenders = [];
  for (const f of walk(LIB)) {
    if (path.basename(path.dirname(f)) === 'proxy') continue; // ACL: nessuna fetch
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('event-feed/snapshot')) return;
      const context = [lines[i - 1], line, lines[i + 1]].filter(Boolean).join('\n');
      if (/\bfetch\s*\(/.test(context) && !f.endsWith(path.join('notify', 'event-feed-client.js'))) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `fetch dirette dello snapshot fuori dalla porta: ${offenders.join(', ')}`);
});

test('statico: server.js passa dalla porta (ownerSnapshotAsks) e non prova URL propri', () => {
  const server = fs.readFileSync(path.join(LIB, 'server.js'), 'utf8');
  assert.ok(server.includes('ownerSnapshotAsks'), 'reconcile asks through the single door');
  assert.ok(!server.includes('event-feed/snapshot'), 'no snapshot URL in server.js');
});
