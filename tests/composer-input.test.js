'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('composer: prompt lungo usa paste esplicita e Enter separato senza troncare', async () => {
  const { CR, createComposerSubmitter } = await import('../frontend/src/lib/composer-input.js');
  const prompt = `${'a'.repeat(1500)}\n${'è'.repeat(1499)}`;
  const calls = [];
  let ready = true;
  const submit = createComposerSubmitter({
    isReady: () => ready,
    paste: (text) => { calls.push(['paste', text]); return true; },
    send: (seq) => { calls.push(['send', seq]); return true; },
  });

  assert.equal(submit(prompt), true);
  assert.deepEqual(calls, [['paste', prompt], ['send', CR]]);
  assert.equal(calls[0][1].length, prompt.length, 'tutti i 3000 caratteri arrivano alla paste');
});

test('composer: prompt Unicode oltre 32 KiB resta byte-per-byte intatto', async () => {
  const { CR, createComposerSubmitter } = await import('../frontend/src/lib/composer-input.js');
  const prompt = `${'🧠'.repeat(12000)}\n${'èòùà'.repeat(6000)}`;
  const calls = [];
  const submit = createComposerSubmitter({
    isReady: () => true,
    paste: (text) => { calls.push(['paste', text]); return true; },
    send: (seq) => { calls.push(['send', seq]); return true; },
  });

  assert.equal(Buffer.byteLength(prompt, 'utf8') > 32 * 1024, true);
  assert.equal(submit(prompt), true);
  assert.equal(calls[0][1], prompt);
  assert.equal(Buffer.from(calls[0][1]).equals(Buffer.from(prompt)), true);
  assert.deepEqual(calls[1], ['send', CR]);
});

test('composer: socket non pronto o perso conserva il draft e non invia Enter', async () => {
  const { createComposerSubmitter } = await import('../frontend/src/lib/composer-input.js');
  const calls = [];
  let ready = false;
  const submit = createComposerSubmitter({
    isReady: () => ready,
    paste: (text) => { calls.push(['paste', text]); ready = false; return true; },
    send: (seq) => { calls.push(['send', seq]); return true; },
  });

  assert.equal(submit('offline'), false);
  assert.deepEqual(calls, [], 'offline: nessuna scrittura silenziosamente persa');
  ready = true;
  assert.equal(submit('cade dopo la paste'), false);
  assert.deepEqual(calls, [['paste', 'cade dopo la paste']], 'mai Enter dopo perdita connessione');
});

test('composer: trailing newline viene rimosso senza alterare multilinea interna', async () => {
  const { stripTrailingNewlines } = await import('../frontend/src/lib/composer-input.js');
  assert.equal(stripTrailingNewlines('uno\ndue\r\n'), 'uno\ndue');
  assert.equal(stripTrailingNewlines(''), '');
});
