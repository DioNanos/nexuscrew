'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { createAskAlertRegistry } = require('../lib/notify/ask-alert-registry.js');
const { askFingerprint } = require('../lib/notify/asks.js');
const ownerId = 'a'.repeat(32);
const frame = (over = {}) => ({ ownerId, askId: 'abcdef01', ownerAskTs: 1700000000000, ...over });
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-alert-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { filePath: path.join(dir, 'ask-alerts.json'), ...extra };
  return { options, store: createAskAlertRegistry(options), file: options.filePath };
}
test('durable successful and unfinished admissions survive restart independently per channel', t => {
  const f = fixture(t); assert.equal(f.store.claim(frame(), 'push').allowed, true);
  let restarted = createAskAlertRegistry(f.options); assert.equal(restarted.claim(frame(), 'push').allowed, false, 'unfinished is uncertain');
  assert.equal(restarted.claim(frame(), 'ui').allowed, true, 'push claim does not suppress UI');
  f.store.complete(frame(), 'push', 1);
  restarted = createAskAlertRegistry(f.options); assert.equal(restarted.claim(frame(), 'push').reason, 'already-alerted');
});
test('explicit failure can be attempted later but an uncertain send cannot be called successful', t => {
  const f = fixture(t); f.store.claim(frame(), 'push'); f.store.complete(frame(), 'push', 0);
  assert.equal(createAskAlertRegistry(f.options).claim(frame(), 'push').allowed, true);
  const other = frame({ askId: 'abcdef02' }); f.store.claim(other, 'push'); f.store.complete(other, 'push', 'uncertain');
  assert.equal(createAskAlertRegistry(f.options).claim(other, 'push').reason, 'alert-uncertain');
});
test('record cap never evicts in-flight claims and expired claims no longer suppress alerts', t => {
  let now = 1000; const f = fixture(t, { maxEntries: 2, ttlMs: 100, now: () => now });
  for (const askId of ['abcdef01','abcdef02']) assert.equal(f.store.claim(frame({ askId }), 'push').allowed, true);
  assert.equal(f.store.claim(frame({ askId: 'abcdef03' }), 'push').reason, 'alert-registry-cap');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.file)).entries).length, 2);
  now += 101; assert.equal(f.store.claim(frame(), 'push').allowed, true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(f.file)).entries).length, 1);
});
test('byte cap and unreadable registry fail closed without replacing existing contents', t => {
  const f = fixture(t, { maxBytes: 10 }); assert.equal(f.store.claim(frame(), 'push').allowed, false);
  assert.equal(fs.existsSync(f.file), false);
  fs.writeFileSync(f.file, '{broken'); const before = fs.readFileSync(f.file);
  const bad = createAskAlertRegistry({ filePath: f.file }); assert.equal(bad.claim(frame(), 'ui').allowed, false);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test('authoritative generation adoption preserves an already alerted historical ASK and allows a later generation', t => {
  const f = fixture(t); const ask = { id: 'abcdef01', question: 'review?', options: ['yes'], session: 'cloud-reviewer' };
  const unknown = frame({ ownerAskTs: null, ownerAskFingerprint: askFingerprint(ask) });
  f.store.claim(unknown, 'push'); f.store.complete(unknown, 'push', 1);
  // Absence of adoption must fail this behavior, not throw for a missing helper.
  if (typeof f.store.adopt === 'function') f.store.adopt(ownerId, ask, 1700000000000);
  assert.equal(f.store.claim(frame(), 'push').allowed, false, 'matching authoritative generation keeps prior alert admission');
  assert.equal(f.store.claim(frame({ ownerAskTs: 1700000000001 }), 'push').allowed, true, 'a reused ID with a new timestamp can alert');
  const restarted = createAskAlertRegistry(f.options); assert.equal(restarted.claim(frame(), 'push').allowed, false, 'adoption persisted');
});
