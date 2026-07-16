'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { analyzeCapture, sanitizePreview } = require('../lib/tmux/preview.js');

test('sanitizePreview: strip ANSI + control, trim, cap 240 (F7)', () => {
  assert.equal(sanitizePreview('\x1b[32mPROMOTE done\x1b[0m  '), 'PROMOTE done');
  assert.equal(sanitizePreview('a\x07b\x00c'), 'abc');
  assert.equal(sanitizePreview('x'.repeat(500)).length, 240);
  assert.equal(sanitizePreview('   '), '');
  assert.equal(sanitizePreview(null), '');
});

test('analyzeCapture detects the anchored Pi status line and ignores transcript lookalikes', () => {
  assert.deepEqual(analyzeCapture('answer mentions Working... in prose\n⠙ Working...\npi footer\n'), {
    preview: 'pi footer', working: true, status: 'Working...',
  });
  assert.deepEqual(analyzeCapture('old text: esc to interrupt\n• Working (2m 03s • esc to interrupt)\nmodel footer\n'), {
    preview: 'model footer', working: false, status: '',
  }, 'Codex-like text is ignored here because Codex uses pane_title');
  assert.deepEqual(analyzeCapture('The phrase Working... is documentation, not a status\nmodel footer\n'), {
    preview: 'model footer', working: false, status: '',
  });
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
  assert.equal((await s.getState('any')).preview, p1, 'getState condivide la stessa cache');
  await new Promise((r) => setTimeout(r, 250));
  assert.notEqual(await s.get('any'), p1, 'dopo TTL: ricampionato');
  assert.equal(await s.get('__fail__'), null, 'errore → null, mai throw');
});
