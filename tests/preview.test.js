'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizePreview } = require('../lib/tmux/preview.js');

test('sanitizePreview: strip ANSI + control, trim, cap 240 (F7)', () => {
  assert.equal(sanitizePreview('\x1b[32mPROMOTE done\x1b[0m  '), 'PROMOTE done');
  assert.equal(sanitizePreview('a\x07b\x00c'), 'abc');
  assert.equal(sanitizePreview('x'.repeat(500)).length, 240);
  assert.equal(sanitizePreview('   '), '');
  assert.equal(sanitizePreview(null), '');
});

test('sampler: cache TTL e null su errore', async (t) => {
  const path = require('node:path');
  const { createPreviewSampler } = require('../lib/tmux/preview.js');
  // fake-tmux stampa "line-<n>" incrementale a ogni capture-pane (vedi fixture)
  process.env.FAKE_TMUX_LOG = '/dev/null';
  const s = createPreviewSampler(path.join(__dirname, 'fixtures', 'fake-tmux-capture.sh'), { ttlMs: 200 });
  t.after(() => s.close());
  const p1 = await s.get('any');
  assert.equal(await s.get('any'), p1, 'entro TTL: stesso valore dalla cache');
  await new Promise((r) => setTimeout(r, 250));
  assert.notEqual(await s.get('any'), p1, 'dopo TTL: ricampionato');
  assert.equal(await s.get('__fail__'), null, 'errore → null, mai throw');
});
