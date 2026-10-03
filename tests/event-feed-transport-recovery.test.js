'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

const OWNER = 'b'.repeat(32);
const CLIENT = 'a'.repeat(32);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 9000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

for (const interruption of ['socket error', 'EOF']) {
  test(`a real SSE ${interruption} recovers through a validated snapshot without toggling reception`, async (t) => {
    let snapshots = 0;
    let streams = 0;
    let first;
    const events = [];
    const server = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-peer-token');
      if (req.url === '/federation/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ instanceId: OWNER, eventFeedV1: true }));
      } else if (req.url.includes('/event-feed/snapshot')) {
        snapshots += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ownerId: OWNER, cursor: '5:0', viewEpoch: 5,
          asks: [{ id: 'retained-ask', question: 'Proceed?', session: 'demo' }],
          notifications: [], askReplyAccess: snapshots === 1 }));
      } else if (req.url.includes('/event-feed')) {
        streams += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': connected\n\n');
        if (streams === 1) first = res;
        else {
          const envelope = { v: 1, ownerId: OWNER, eventId: 'recovered-ask', scope: 'node',
            cellId: null, hop: 1, emittedAt: 1,
            frame: { type: 'ask', askId: 'new-ask', question: 'Continue?', session: 'demo' } };
          const frame = `id: 5:1\ndata: ${JSON.stringify(envelope)}\n\n`;
          res.write(frame);
          // A replay has no second local emission, including after recovery.
          res.write(frame.replace('id: 5:1', 'id: 5:2'));
        }
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = createEventFeedClient({
      loadStore: () => ({ nodeId: CLIENT, nodes: [{ nodeId: OWNER, direction: 'outbound',
        eventsReceive: true, localPort: port, token: 'fixture-peer-token' }] }),
      pollMs: 15, minSnapshotIntervalMs: 50,
      eventsHub: { broadcast: (event) => events.push(event) },
    });
    t.after(async () => {
      client.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    client.start();
    await until(() => first && client.state().views[0]?.stale === false, 'initial snapshot and stream');
    assert.equal(client.state().views[0].askReplyAccess, true);
    if (interruption === 'EOF') first.end();
    else first.socket.destroy();
    await until(() => streams >= 2 && events.some((event) => event.eventId === 'recovered-ask'),
      'the existing retry can open a second stream and deliver an ASK');
    const view = client.state().views[0];
    // The discriminant is health and a fresh authoritative grant, not merely reconnect.
    assert.equal(view.stale, false, 'a recovered stream must have a healed view');
    assert.equal(view.lastError, null);
    assert.ok(snapshots >= 2, 'transport recovery requires a fresh snapshot');
    assert.equal(view.askReplyAccess, false, 'the replacement snapshot updates the grant');
    assert.equal(view.asks[0].id, 'retained-ask');
    assert.equal(events.filter((event) => event.eventId === 'recovered-ask').length, 1);
  });
}
