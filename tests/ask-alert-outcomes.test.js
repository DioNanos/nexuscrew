'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { notifyRoutes } = require('../lib/notify/routes.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createAskAlertRegistry } = require('../lib/notify/ask-alert-registry.js');
const { createNotifier } = require('../lib/notify/notifier.js');
const { HOP_HEADER } = require('../lib/proxy/hop-proof.js');
const OWNER = 'a'.repeat(32), SELF = 'b'.repeat(32);
const ASK = { question: 'review?', options: ['yes'], session: 'cloud-reviewer', ownerId: OWNER, ownerAskId: 'abcdef01', ownerAskTs: 1700000000000, originNode: OWNER, originCell: 'reviewer' };
async function setup(t, { send, elided = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-outcomes-'));
  const asks = createAsksStore({ dir }); const emitted = []; const pushed = []; const logs = [];
  const registry = createAskAlertRegistry({ filePath: path.join(dir, 'ask-alerts.json') });
  const push = { sendToAll: async payload => { pushed.push(payload); return send ? send(payload, pushed.length) : { sent: 0 }; } };
  const base = createNotifier({ hub: { broadcast: f => { emitted.push(f); return 0; } }, push, alertRegistry: registry });
  const app = express();
  // Only identity and ACL gates are trusted seams in this router test. Store,
  // notifier, ledger, persistence and public HTTP response are real.
  app.use('/api', notifyRoutes({ cfg: {}, asks: elided ? { ...asks, create: () => ({ ok: true, elided: true }) } : asks,
    notifier: { ...base, deliverOnly: base.emit, deliverOnlyRaw: base.emitRaw }, push,
    submit: async () => ({ outcome: 'submitted', submitted: true }), localNodeId: () => SELF, originResolver: { resolve: async () => ({ ok: true, origin: { node: OWNER, cell: 'reviewer' } }) },
    acl: { allows: () => ({ allowed: true }) }, log: line => logs.push(line),
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async over => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/asks`, { method: 'POST', headers: { 'content-type': 'application/json', [HOP_HEADER]: 'verified-fixture' },
      body: JSON.stringify({ target: SELF, question: ASK.question, options: ASK.options, session: ASK.session, askId: ASK.ownerAskId, ownerNode: OWNER, originNode: OWNER, originCell: 'reviewer', ownerAskTs: ASK.ownerAskTs, ...over }) });
    return { status: r.status, body: await r.json() };
  };
  return { asks, request, emitted, pushed, logs, dir };
}
test('failed ASK alert attempts retain acceptance and a later explicit deduped ingress can alert', async t => {
  const s = await setup(t, { send: (_payload, n) => { if (n === 1) throw new Error('fixture provider unavailable'); return { sent: 1 }; } });
  const first = await s.request();
  assert.equal(first.status, 200); assert.equal(first.body.status, 'delivered'); assert.equal(first.body.alertStatus, 'no-delivery');
  assert.equal(first.body.alert.pushReason, 'send-failed');
  assert.equal(first.body.alert.uiAttempted, true); assert.equal(first.body.alert.pushAttempted, true);
  const stored = s.asks.findImported(OWNER, ASK.ownerAskId); assert.ok(stored); assert.equal(stored.id, first.body.id);
  const second = await s.request();
  assert.equal(second.body.deduped, true); assert.equal(second.body.id, first.body.id); assert.equal(second.body.alert.push, 1);
  assert.equal(second.body.alert.pushAttempted, true, 'failed first attempt cannot suppress a successful explicit replay');
  const third = await s.request();
  assert.equal(third.body.status, 'delivered'); assert.equal(third.body.deduped, true); assert.equal(third.body.alert.push, 0);
  assert.equal(third.body.alert.pushAttempted, false, 'successful admission must not attempt another push');
  assert.equal(s.pushed[0].askId, ASK.ownerAskId, 'local alias IDs never identify alerts');
  assert.equal(s.pushed[0].ownerAskTs, ASK.ownerAskTs, 'owner creation generation survives the direct route');
  assert.equal(s.pushed.length, 2); assert.equal(s.emitted.filter(f => f.type === 'ask').length, 3, 'all ASK cards remain distributed');
  assert.ok(s.logs.every(line => !line.includes(ASK.question)), 'ingress logs contain owner/id and outcomes, never question text');
});
test('a suppressed local dismissal remains accepted and touches neither alert channel', async t => {
  const s = await setup(t); const created = s.asks.create(ASK); assert.equal(created.ok, true);
  assert.equal(s.asks.dismissImported({ ownerId: OWNER, ownerAskId: ASK.ownerAskId, ask: created.ask, cellId: 'reviewer' }).ok, true);
  const r = await s.request();
  assert.equal(r.status, 200); assert.equal(r.body.status, 'delivered'); assert.equal(r.body.suppressed, true); assert.equal(r.body.ownerId, OWNER);
  assert.equal(r.body.alertStatus, 'suppressed'); assert.deepEqual(r.body.alert, { ui: 0, push: 0, uiAttempted: false, pushAttempted: false });
  assert.equal(s.emitted.length, 0); assert.equal(s.pushed.length, 0); assert.equal(s.asks.list({ open: true }).length, 0);
});
test('the defensive elided-store outcome adds diagnostics without changing legacy acceptance', async t => {
  const s = await setup(t, { elided: true }); const r = await s.request();
  assert.equal(r.status, 200); assert.equal(r.body.status, 'delivered'); assert.equal(r.body.elided, true); assert.equal(r.body.alertStatus, 'elided');
  assert.deepEqual(r.body.alert, { ui: 0, push: 0, uiAttempted: false, pushAttempted: false });
  assert.equal(s.emitted.length, 0); assert.equal(s.pushed.length, 0);
});
test('the imported ASK cap rejects HTTP ingress with 429 and never drops an open question', async t => {
  const s = await setup(t);
  for (let i = 0; i < 100; i++) assert.equal(s.asks.create({ ...ASK, ownerAskId: i.toString(16).padStart(8, '0') }).ok, true);
  const before = fs.readFileSync(path.join(s.dir, 'asks.json')); const r = await s.request();
  assert.equal(r.status, 429); assert.equal(r.body.status, 'refused'); assert.equal(r.body.reason, 'cap');
  assert.deepEqual(fs.readFileSync(path.join(s.dir, 'asks.json')), before); assert.equal(s.asks.list({ open: true }).length, 100);
  assert.equal(s.emitted.length, 0); assert.equal(s.pushed.length, 0);
});

test('concurrent public ASK ingress persists its pending claim before the first push settles', async t => {
  let release; let started; const start = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const s = await setup(t, { send: async (_payload, n) => { if (n === 1) { started(); await wait; } return { sent: 1 }; } });
  const first = s.request(); await start;
  const pending = JSON.parse(fs.readFileSync(path.join(s.dir, 'ask-alerts.json')));
  assert.ok(Object.values(pending.entries).some(record => record.push === 'pending'), 'durable claim precedes the awaited sender');
  const second = await s.request();
  assert.equal(second.body.deduped, true); assert.equal(second.body.alert.pushAttempted, false);
  assert.equal(second.body.alert.pushReason, 'alert-uncertain'); assert.equal(s.pushed.length, 1);
  release(); assert.equal((await first).body.alert.push, 1);
});
