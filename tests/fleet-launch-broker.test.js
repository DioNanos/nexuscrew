'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { receivePayload, validPayload } = require('../lib/fleet/cell-exec.js');

test('launch broker delivers a payload once over a private Unix socket and leaves no secret file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-')); fs.chmodSync(home, 0o700);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 2000 });
  try {
    const payload = { command: '/bin/echo', args: ['ok'], env: { API_KEY: 'secret-value', PATH: '/bin' } };
    const ticket = await broker.issue(payload);
    assert.equal(ticket.socketPath.includes('secret-value'), false);
    assert.equal(ticket.nonce.includes('secret-value'), false);
    assert.equal(fs.statSync(path.dirname(ticket.socketPath)).mode & 0o777, 0o700);
    const received = await receivePayload(ticket.socketPath, ticket.nonce);
    assert.deepEqual(received, payload);
    assert.equal(broker.pendingCount(), 0);
    await assert.rejects(() => receivePayload(ticket.socketPath, ticket.nonce, 200), /closed early|timed out/);
    assert.equal(fs.readdirSync(path.dirname(ticket.socketPath)).some((name) => name.endsWith('.json')), false);
  } finally { await broker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('cell-exec payload validation rejects shell-shaped or malformed launch data', () => {
  assert.equal(validPayload({ command: '/bin/x', args: ['; rm -rf /'], env: { SAFE: 'value' } }), true,
    'argv is data and is never shell-evaluated');
  assert.equal(validPayload({ command: '/bin/x', args: 'bad', env: {} }), false);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: { 'BAD-KEY': 'x' } }), false);
});
