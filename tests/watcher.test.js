'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOutboxWatcher } = require('../lib/files/watcher.js');

function waitFor(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(poll, 50);
    })();
  });
}

test('watcher: rileva nuovo file in outbox e aggiorna summary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncwatch-'));
  fs.mkdirSync(path.join(root, 'sess1', 'outbox'), { recursive: true });
  const w = createOutboxWatcher({ root, pollMs: 100, debounceMs: 50 });
  t.after(() => w.close());
  const events = [];
  w.on('change', (session, files) => events.push({ session, files }));

  fs.writeFileSync(path.join(root, 'sess1', 'outbox', 'report.md'), 'x');
  await waitFor(() => events.some((e) => e.session === 'sess1' && e.files.some((f) => f.name === 'report.md')));
  assert.equal(w.getSummary().sess1.count, 1);
  assert.ok(w.getSummary().sess1.latest > 0);
});

test('watcher: root inesistente non esplode, close idempotente', () => {
  const w = createOutboxWatcher({ root: '/nonexiste/nc', pollMs: 100 });
  assert.deepEqual(w.getSummary(), {});
  w.close(); w.close();
});
