'use strict';
// tests/event-feed-producers.test.js — the producer registry: EVERY local
// producer has a closed schema, every frame carries allowlisted fields only,
// and a type without a schema is a diagnostic error (D2: no silent exclusion).
const { test } = require('node:test');
const assert = require('node:assert');
const { PRODUCERS, PRODUCER_NAMES, buildEnvelope } = require('../lib/notify/event-feed-producers.js');

const SAMPLES = {
  notify: { title: 'build done', body: 'cell dev finished', urgency: 'normal', lang: 'it' },
  'notify-node': { title: 'service restarted', urgency: 'high' },
  ask: { askId: 'a1b2c3d4', revision: 1, question: 'proceed?', options: ['yes', 'no'], session: 'cell-session' },
  'ask-closed': { askId: 'a1b2c3d4', revision: 1, outcome: 'answered' },
  'file-notice': { name: 'report.pdf', caption: 'ready', session: 'cell-session' },
  'fleet-state': { cells: [{ cell: 'dev', active: true }, { cell: 'secret', active: false }] },
  'node-state': { service: 'bridge', state: 'up' },
};

test('every registered producer builds a valid v1 envelope (coverage of the registry)', () => {
  for (const name of PRODUCER_NAMES) {
    const cellScope = PRODUCERS[name].scope === 'cell';
    const env = buildEnvelope({
      type: name, payload: SAMPLES[name], ownerId: 'a'.repeat(32),
      cellId: cellScope ? 'dev' : null,
    });
    assert.equal(env.v, 1, name);
    assert.equal(env.ownerId, 'a'.repeat(32), name);
    assert.match(env.eventId, /^[0-9a-f-]{36}$/, `${name}: uuid eventId`);
    assert.equal(env.scope, PRODUCERS[name].scope, name);
    assert.equal(env.hop, 1, name);
    assert.equal(env.cellId, cellScope ? 'dev' : null, `${name}: cellId null on node scope`);
    assert.ok(env.frame.type, name);
  }
});

test('a cell producer without a resolved cell is refused, never re-scoped to node', () => {
  assert.throws(() => buildEnvelope({ type: 'notify', payload: SAMPLES.notify, ownerId: 'o' }),
    /needs a resolved cell/);
});

test('an unregistered producer type is a diagnostic error, not a pass-through', () => {
  assert.throws(() => buildEnvelope({ type: 'terminal-stream', payload: {}, ownerId: 'o' }),
    /unregistered event producer/);
});

test('frames carry ONLY allowlisted fields: secrets, paths and terminal bytes cannot ride along', () => {
  const env = buildEnvelope({
    type: 'notify', ownerId: 'o', cellId: 'dev',
    payload: {
      title: 't',
      body: 'b',
      // Everything below is FORBIDDEN and must be dropped by the schema:
      token: 'SECRET', password: 'SECRET', subscription: { endpoint: 'https://x' },
      path: '/home/user/secret', terminal: 'raw pane bytes', cwd: '/srv', env: { KEY: 'v' },
    },
  });
  const allowed = new Set(['type', 'title', 'body', 'urgency', 'ts']);
  for (const key of Object.keys(env.frame)) {
    assert.ok(allowed.has(key), `unexpected frame field: ${key}`);
  }
  assert.ok(!JSON.stringify(env).includes('SECRET'));
  assert.ok(!JSON.stringify(env).includes('/home/user'));
});

test('each eventId is unique per emission (assigned once at the origin)', () => {
  const a = buildEnvelope({ type: 'notify', payload: SAMPLES.notify, ownerId: 'o', cellId: 'dev' });
  const b = buildEnvelope({ type: 'notify', payload: SAMPLES.notify, ownerId: 'o', cellId: 'dev' });
  assert.notEqual(a.eventId, b.eventId);
});
